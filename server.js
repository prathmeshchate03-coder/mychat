// JenChat - zero-dependency guest chat server (Node 18+). Run: node server.js
// Admin panel: set env ADMIN_TOKEN (long random string), then open /admin
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Features that are built but switched off until you set the variable to 1 on the server (Render > Environment).
const FEAT = { social: process.env.FEATURE_SOCIAL === '1', voice: process.env.FEATURE_VOICE === '1' };
const rooms = new Map(), hits = new Map(), conns = new Map();
const bans = new Map();       // ip -> { reason, t, until }  (until = 0 means permanent)
const closed = new Map();     // room name -> { reason, t }
const acctBans = new Map();   // account id -> { name, reason, t }  (banned accounts cannot log in or send)
const sent = new Map();       // msg id -> { ip, room, nick, text, t, acct?, img? }  last 3000 messages, server-side only
const reports = [];           // newest first, max 200
const adminFails = new Map(); // ip -> { n, t }
const BAD = [];   // add words to filter, e.g. ['word1', 'word2']
const seo = require('./seo');   // topic pages, blog, sitemap.xml, robots.txt (text is in content.js)
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/admin': 'admin.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/og.png': 'og.png' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const okRoom = s => /^[a-z0-9-]{1,30}$/.test(s);
const okIp = s => /^[0-9a-fA-F:.]{3,45}$/.test(s);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const okTok = s => /^[a-zA-Z0-9]{16,64}$/.test(s);
const typingAt = new Map();   // ip -> last typing event time

// ---------- direct messages (text only, 1 to 1) ----------
// Identity: the browser keeps a secret "dk". The server only ever uses iid = first 16 hex of sha256(dk), which is public
// (shown in the online list). Nobody can act as an iid without knowing its dk. DMs are never stored, except a short
// in-memory copy so a reported message can be checked by moderators.
const okDk = s => /^[a-f0-9]{32}$/.test(s);
const okIid = s => /^[a-f0-9]{16}$/.test(s);
const iidOf = dk => (okDk(String(dk || '')) ? sha(dk).slice(0, 16) : '');
const dmPairs = new Map();    // "a:b" (sorted) -> { from, to, accepted, t }. A first message is only a request until the other side replies or accepts.
const dmBlocks = new Map();   // iid -> Set of iids it blocked (memory only, the browser re-sends its list on every join)
const dmNew = new Map();      // iid -> times it started a new conversation
const dmLog = new Map();      // msg id -> { ip, from, to, fromNick, toNick, text, t }, max 1000, 12h
const DM_LOG_TTL = 12 * 3600000, DM_PAIR_TTL = 24 * 3600000;
function liveByIid(iid) {
  const out = [];
  for (const r of rooms.values()) for (const c of r.clients) if (c.iid === iid) out.push(c);
  return out;
}

function room(name) {
  // ownerTok: sha256 of the creator's secret (private rooms only). kicked: ip -> expiry time.
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [], ownerTok: '', ownerAcct: '', kicked: new Map(), banned: new Map(), about: { topic: '', desc: '', rules: '' }, pin: null, bg: null, staff: new Map(), logs: [], rx: new Map(), pub: !name.startsWith('p-') });
  return rooms.get(name);
}
// Join/leave notice that also carries the current member list (no IPs, only public info).
function sys(name, text) {
  const r = room(name);
  broadcast(name, { system: true, text, count: r.clients.size,
    users: [...r.clients].map(c => ({ id: c.cid, uid: c.uid, iid: c.iid, nick: c.nick, owner: !!c.owner, role: roleName(c.role), v: !!c.acct })) });
}
// ---- private room settings: saved in the database for 30 days so an owner can come back to the same room ----
const ownsRoom = (r, user, otok) => !!r && ((!!r.ownerTok && okTok(String(otok || '')) && sha(String(otok)) === r.ownerTok) || (!!user && !!r.ownerAcct && user.id === r.ownerAcct));
// roles: 3 owner, 2 admin, 1 mod, 0 nobody. Staff are verified accounts, saved with the room.
// The site owner (SITE_OWNER = account name(s), comma separated) is the owner of every public room; private rooms stay private.
const SITE_OWNERS = new Set(String(process.env.SITE_OWNER || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean));
const isSiteOwner = u => !!u && SITE_OWNERS.has(String(u.name || '').toLowerCase());
const roleLv = (r, user, otok) => (ownsRoom(r, user, otok) || (r.pub && isSiteOwner(user))) ? 3 : (user && r.staff.has(user.id) ? (r.staff.get(user.id).role === 'admin' ? 2 : 1) : 0);
const roleName = l => l >= 3 ? 'owner' : l === 2 ? 'admin' : l === 1 ? 'mod' : '';
function addLog(name, r, ev, content, staff, target) {   // newest first, last 100 kept
  r.logs.unshift({ id: (r.logs[0] ? r.logs[0].id : 0) + 1, t: Date.now(), ev, content: clean(content, 100), staff: clean(staff, 20), target: clean(target, 20) });
  if (r.logs.length > 100) r.logs.length = 100;
  saveRoom(name);
}
function refreshRoles(name, r) {   // after a staff change: tell each affected person their new role and refresh the member list
  r.clients.forEach(c => { if (c.owner) return; const st = c.acct && r.staff.get(c.acct); const lv = st ? (st.role === 'admin' ? 2 : 1) : 0;
    if (lv !== c.role) { c.role = lv; c.write(`data: ${JSON.stringify({ role: roleName(lv) })}\n\n`); } });
  sys(name, '');
}
const roomBanned = (r, ip, user) => r.banned.has('ip:' + ip) || (!!user && r.banned.has('a:' + user.id));
const roomDirty = new Set(); let roomTimer = null;
function saveRoom(name) {
  if (!DB_URL) return;
  roomDirty.add(name); if (!roomTimer) roomTimer = setTimeout(flushRooms, 3000);
}
async function flushRooms() {
  clearTimeout(roomTimer); roomTimer = null;
  if (!dbOn()) return;
  for (const name of [...roomDirty]) {
    roomDirty.delete(name);
    const r = rooms.get(name); if (!r || !(r.ownerTok || r.ownerAcct || r.pub)) continue;
    try { await dbCmd(['SET', 'jc:room:' + name, JSON.stringify({ o: r.ownerTok, a: r.ownerAcct, about: r.about, bg: r.bg, pin: r.pin, banned: [...r.banned], s: [...r.staff], l: r.logs }), 'EX', (r.pub ? 180 : 30) * 86400]); }
    catch (e) { console.error('ROOM SAVE', e.message); roomDirty.add(name); roomTimer = roomTimer || setTimeout(flushRooms, 30000); }
  }
}
async function ensureRoom(name) {
  if (rooms.has(name) || !dbOn()) return;
  let d = null;
  try { const raw = await dbCmd(['GET', 'jc:room:' + name]); d = raw ? JSON.parse(raw) : null; } catch {}
  if (rooms.has(name)) return;
  const r = room(name);
  if (d) {
    r.ownerTok = /^[a-f0-9]{64}$/.test(d.o || '') ? d.o : ''; r.ownerAcct = /^[a-f0-9]{16}$/.test(d.a || '') ? d.a : '';
    for (const k of ['topic', 'desc', 'rules']) r.about[k] = clean(d.about && d.about[k], k === 'topic' ? 80 : k === 'desc' ? 300 : 500);
    r.bg = d.bg && (d.bg.k || d.bg.img) ? d.bg : null; r.pin = d.pin && d.pin.id ? d.pin : null;
    (Array.isArray(d.s) ? d.s : []).slice(0, 20).forEach(e => { if (Array.isArray(e) && /^[a-f0-9]{16}$/.test(String(e[0])) && e[1]) r.staff.set(e[0], { role: e[1].role === 'admin' ? 'admin' : 'mod', nick: clean(e[1].nick, 20), t: Number(e[1].t) || 0 }); });
    (Array.isArray(d.l) ? d.l : []).slice(0, 100).forEach(x => { if (x && x.ev) r.logs.push({ id: Number(x.id) || 0, t: Number(x.t) || 0, ev: clean(x.ev, 16), content: clean(x.content, 100), staff: clean(x.staff, 20), target: clean(x.target, 20) }); });
    (Array.isArray(d.banned) ? d.banned : []).slice(0, 100).forEach(e => { if (Array.isArray(e) && /^(ip:[0-9a-fA-F:.]{3,45}|a:[a-f0-9]{16})$/.test(String(e[0]))) r.banned.set(e[0], { nick: clean(e[1] && e[1].nick, 20), t: Number(e[1] && e[1].t) || 0 }); });
  }
}
function isKicked(r, ip) {
  const t = r.kicked.get(ip);
  if (!t) return false;
  if (t < Date.now()) { r.kicked.delete(ip); return false; }
  return true;
}
function broadcast(name, msg) {
  const r = room(name);
  if (!msg.system) { r.history.push(msg); if (r.history.length > 50) r.rx.delete(r.history.shift().id); }
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  r.clients.forEach(c => c.write(data));
}
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 10000);
  a.push(now); hits.set(ip, a); return a.length > 8;
}
const toolHits = new Map();
const staffName = (r, user, lv) => lv >= 3 ? 'Owner' : ((user && r.staff.get(user.id)) || {}).nick || 'staff';
function toolLimited(ip) {   // room-owner actions (delete, pin, ban...) get their own, roomier limit than chat messages
  const now = Date.now(), a = (toolHits.get(ip) || []).filter(t => now - t < 10000);
  a.push(now); toolHits.set(ip, a); return a.length > 30;
}
function readBody(req, max, cb) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > max) { req.destroy(); } });
  req.on('end', () => cb(body));
}
// Binary request body (images). Answers 413 itself when the body is too big.
function readBuf(req, res, max, cb) {
  const chunks = []; let n = 0, over = false;
  req.on('data', d => {
    if (over) return;
    n += d.length;
    if (n > max) { over = true; res.setHeader('Connection', 'close'); json(res, 413, { error: 'too_big' }); return; }
    chunks.push(d);
  });
  req.on('end', () => { if (!over) cb(Buffer.concat(chunks)); });
  req.on('error', () => {});
}

// ---------- persistence (optional) ----------
// Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to keep bans, closed rooms and reports across restarts.
// Without them everything stays in memory exactly as before. Chat messages are never stored.
// Forgive common copy-paste mistakes: spaces, quotes, "Bearer " prefix, missing https://
const envClean = s => String(s || '').trim().replace(/^["']+|["']+$/g, '').trim();
let DB_URL = envClean(process.env.UPSTASH_REDIS_REST_URL), DB_TOKEN = envClean(process.env.UPSTASH_REDIS_REST_TOKEN).replace(/^Bearer\s+/i, '');
if (DB_URL && !/^[a-z]+:\/\//i.test(DB_URL)) DB_URL = 'https://' + DB_URL;
const REPORT_KEEP = 14 * 86400000, SAVE_DELAY = 10000;
let dbReady = !DB_URL, saveTimer = null, dbError = '';
const dirty = new Set();
async function dbCmd(cmd, timeoutMs) {
  if (/^rediss?:/i.test(DB_URL)) throw new Error('wrong URL type: use the REST URL that starts with https://, not the redis:// one');
  if (!DB_TOKEN) throw new Error('UPSTASH_REDIS_REST_TOKEN is empty or missing');
  let r;
  try {
    r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd), signal: AbortSignal.timeout(timeoutMs || 5000) });
  } catch (e) { throw new Error('cannot connect to the database URL (' + ((e.cause && (e.cause.code || e.cause.message)) || e.name + ': ' + e.message) + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
const dump = { bans: () => [...bans], closed: () => [...closed], acctbans: () => [...acctBans], reports: () => reports.filter(r => r.at > Date.now() - REPORT_KEEP) };
function touch(k) { if (!DB_URL) return; dirty.add(k); if (dbReady && !saveTimer) saveTimer = setTimeout(flush, SAVE_DELAY); }
async function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!dbReady) return;   // never write before the old data was read, or we would overwrite it with an empty list
  for (const k of [...dirty]) {
    dirty.delete(k);      // removed before the await, so a change made during the save marks it dirty again
    try { await dbCmd(['SET', 'jc:' + k, JSON.stringify(dump[k]())]); dbError = ''; }
    catch (e) { dbError = 'save failed: ' + e.message; console.error('DB SAVE FAILED', k, e.message); dirty.add(k); if (!saveTimer) saveTimer = setTimeout(flush, 30000); }
  }
}
// Merge what the database has into memory. Anything already in memory wins.
function mergeLoaded(k, data) {
  const now = Date.now();
  if (k === 'bans') data.forEach(e => { if (Array.isArray(e) && okIp(String(e[0])) && e[1] && !bans.has(e[0]) && (!e[1].until || e[1].until > now)) bans.set(e[0], e[1]); });
  else if (k === 'closed') data.forEach(e => { if (Array.isArray(e) && okRoom(String(e[0])) && e[1] && !closed.has(e[0])) closed.set(e[0], e[1]); });
  else if (k === 'acctbans') data.forEach(e => { if (Array.isArray(e) && /^[a-f0-9]{16}$/.test(String(e[0])) && e[1] && !acctBans.has(e[0])) acctBans.set(e[0], e[1]); });
  else {
    const have = new Set(reports.map(r => r.rid));
    data.forEach(r => { if (r && r.rid && r.at > now - REPORT_KEEP && !have.has(r.rid)) reports.push(r); });
    reports.sort((a, b) => b.at - a.at); reports.length = Math.min(reports.length, 200);
  }
}
async function dbLoad() {
  try {
    for (const k of Object.keys(dump)) {
      const raw = await dbCmd(['GET', 'jc:' + k]);
      if (raw) { const d = JSON.parse(raw); if (Array.isArray(d)) mergeLoaded(k, d); }
    }
    dbReady = true; dbError = '';
    console.log(`DB loaded: ${bans.size} bans, ${closed.size} closed rooms, ${acctBans.size} banned accounts, ${reports.length} reports`);
    if (dirty.size) flush();
    auth.init();
  } catch (e) { dbError = e.message; console.error('DB LOAD FAILED, retrying in 30s:', e.message); setTimeout(dbLoad, 30000); }
}

// ---------- accounts and images (need the database) ----------
// Accounts also need MAIL_RELAY_URL + MAIL_RELAY_SECRET (the Google Apps Script mail relay, see mail-relay.gs).
const dbOn = () => !!DB_URL && dbReady;
const acctBanned = id => acctBans.has(id);
const auth = require('./auth')({ db: dbCmd, dbReady: dbOn, isAcctBanned: acctBanned,
  mailUrl: envClean(process.env.MAIL_RELAY_URL), mailSecret: envClean(process.env.MAIL_RELAY_SECRET), mailDaily: process.env.MAIL_DAILY_LIMIT });
function liveByAcct(id) {
  const out = [];
  for (const r of rooms.values()) for (const c of r.clients) if (c.acct === id) out.push(c);
  return out;
}
const social = require('./social')({ db: dbCmd, dbReady: dbOn, session: req => auth.session(req), originOk: req => auth.originOk(req), liveByAcct,
  blockedBy: (owner, other) => !!(dmBlocks.get(owner) && dmBlocks.get(owner).has(other)), acctIid: id => acctIid(id), rooms, closed, okRoom, json, readBody, limited: ip => toolLimited(ip) });
const images = require('./images')({ db: dbCmd, dbReady: dbOn, session: req => auth.session(req), isBanned: ip => isBanned(ip),
  budgetMB: Number(process.env.IMAGE_BUDGET_MB) || 200, ttlDays: 7 });
const voice = require('./voice')({ db: dbCmd, dbReady: dbOn, session: req => auth.session(req), isBanned: ip => isBanned(ip),
  budgetMB: Number(process.env.VOICE_BUDGET_MB) || 50, ttlDays: 3 });
const acctIid = id => sha('acct:' + id).slice(0, 16);   // DM identity of an account, the same on every device
const RX = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'];
const rxCount = votes => { const c = {}; votes.forEach(e => { c[e] = (c[e] || 0) + 1; }); return c; };
const dmRx = new Map();   // DM message id -> Map(person -> emoji)
function who(req, body) {   // who is making a DM request: an account (cookie) or a guest (secret code dk)
  const user = auth.session(req);
  return { user, iid: user ? acctIid(user.id) : iidOf(body && body.dk) };
}
if (DB_URL) dbLoad();
async function shutdown() {   // Render sends SIGTERM on every deploy: save pending changes first
  try { await Promise.race([Promise.all([flush(), flushRooms()]), new Promise(r => setTimeout(r, 4000))]); } finally { process.exit(0); }
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

// ---------- moderation ----------
function isBanned(ip) {
  const b = bans.get(ip);
  if (!b) return false;
  if (b.until && b.until < Date.now()) { bans.delete(ip); touch('bans'); return false; }
  return true;
}
// Disconnect live SSE clients that match pred(res, roomName), with a last notice.
function kick(pred, text) {
  const data = `data: ${JSON.stringify({ system: true, text })}\n\n`;
  for (const [name, r] of rooms) for (const c of [...r.clients]) {
    if (pred(c, name)) c.write(data, () => c.destroy());
  }
}
function banIp(ip, hours, reason) {
  bans.set(ip, { reason: clean(reason, 100), t: Date.now(), until: hours > 0 ? Date.now() + hours * 3600000 : 0 });
  kick(c => c.ip === ip, 'You have been banned.');
  reports.forEach(r => { if (r.ip === ip && r.status === 'open') r.status = 'banned'; });
  touch('bans'); touch('reports');
}
function closeRoom(name, reason) {
  closed.set(name, { reason: clean(reason, 100), t: Date.now() });
  kick((c, n) => n === name, 'This room was closed by a moderator.');
  reports.forEach(r => { if (r.room === name && r.status === 'open') r.status = 'closed'; });
  touch('closed'); touch('reports');
}
function banAcct(id, name, reason) {
  acctBans.set(id, { name: clean(name, 20), reason: clean(reason, 100), t: Date.now() });
  kick(c => c.acct === id, 'Your account has been banned.');
  reports.forEach(r => { if (r.acct === id && r.status === 'open') r.status = 'banned'; });
  images.idsByUser(id).then(ids => Promise.all(ids.map(i => dropImage(i, false)))).catch(() => {});   // pictures this account uploaded recently go with it
  voice.idsByUser(id).then(ids => Promise.all(ids.map(i => dropVoice(i, false)))).catch(() => {});   // and its voice notes
  touch('acctbans'); touch('reports');
}
// Remove a picture everywhere: the stored copy, the room history that new joiners would see, and the screens of
// everybody who is online right now (they swap the picture for "Picture deleted").
async function dropVoice(id, keepEvidence) {   // same as dropImage, for voice notes
  await voice.remove(id, keepEvidence);
  const hit = new Set();
  for (const s of sent.values()) if (s.aud === id) { delete s.aud; s.audGone = true; hit.add(s.room); }
  for (const [name, r] of rooms) for (const m of r.history) if (m.aud === id) { delete m.aud; m.audGone = true; hit.add(name); }
  const ev = `data: ${JSON.stringify({ auddel: id })}\n\n`;
  for (const name of hit) { const r = rooms.get(name); if (r) r.clients.forEach(c => c.write(ev)); }
  const dev = `data: ${JSON.stringify({ dmdel: { aud: id } })}\n\n`, seen = new Set();
  for (const d of dmLog.values()) if (d.aud === id) {
    delete d.aud; d.audGone = true;
    for (const iid of [d.from, d.to]) for (const c of liveByIid(iid)) if (!seen.has(c)) { seen.add(c); c.write(dev); }
  }
}
async function dropImage(id, keepEvidence) {
  await images.remove(id, keepEvidence);
  const hit = new Set();
  for (const s of sent.values()) if (s.img === id) { delete s.img; s.imgGone = true; hit.add(s.room); }
  for (const [name, r] of rooms) for (const m of r.history) if (m.img === id) { delete m.img; m.imgGone = true; hit.add(name); }
  for (const [name, r] of rooms) if (r.bg && r.bg.img === id) { r.bg = null; hit.add(name); r.clients.forEach(c => c.write(`data: ${JSON.stringify({ roombg: null })}\n\n`)); }
  for (const p of dmPairs.values()) if (p.bg && p.bg.img === id) {
    p.bg = null;
    for (const [me, other] of [[p.from, p.to], [p.to, p.from]]) for (const c of liveByIid(me)) c.write(`data: ${JSON.stringify({ dmbg: { with: other, bg: null } })}\n\n`);
  }
  const ev = `data: ${JSON.stringify({ imgdel: id })}\n\n`;
  for (const name of hit) { const r = rooms.get(name); if (r) r.clients.forEach(c => c.write(ev)); }
  const dev = `data: ${JSON.stringify({ dmdel: { img: id } })}\n\n`, seen = new Set();
  for (const d of dmLog.values()) if (d.img === id) {
    delete d.img; d.imgGone = true;
    for (const iid of [d.from, d.to]) for (const c of liveByIid(iid)) if (!seen.has(c)) { seen.add(c); c.write(dev); }
  }
}
function adminAuth(req, res, ip) {
  if (!ADMIN_TOKEN) { res.writeHead(503); res.end('admin disabled'); return false; }
  const now = Date.now(), f = adminFails.get(ip);
  if (f && f.n >= 5 && now - f.t < 900000) { res.writeHead(429); res.end(); return false; }
  const h = s => crypto.createHash('sha256').update(String(s)).digest();
  if (crypto.timingSafeEqual(h(req.headers['x-admin-token'] || ''), h(ADMIN_TOKEN))) { adminFails.delete(ip); return true; }
  adminFails.set(ip, { n: (f && now - f.t < 900000 ? f.n : 0) + 1, t: now });
  res.writeHead(401); res.end(); return false;
}
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  handle(req, res).catch(e => { console.error('ERR', e); try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {} });
}).listen(PORT, () => console.log('JenChat running on port ' + PORT + (ADMIN_TOKEN ? '' : ' (admin disabled: set ADMIN_TOKEN)')));

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  // On Render the last X-Forwarded-For entry is the one added by Render's proxy = the real client.
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    const headers = { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'public, max-age=300' };
    if (url.pathname === '/admin') { headers['Cache-Control'] = 'no-store'; headers['X-Robots-Tag'] = 'noindex, nofollow'; }
    if (file.endsWith('.png')) headers['Cache-Control'] = 'public, max-age=86400';
    let content = fs.readFileSync(path.join(PUB, file));
    if (file.endsWith('.html')) content = seo.injectHead(file, content.toString('utf8'), seo.siteBase(req));   // canonical + share tags
    res.writeHead(200, headers);
    return res.end(content);
  }
  if (auth.handle(req, res, url, ip, seo.siteBase(req), readBody)) return;   // /auth/*, /verify, /reset
  if (url.pathname === '/features') return json(res, 200, FEAT);
  if ((!FEAT.voice && /^\/(vn|vn\/delete|vn\/[a-f0-9]{32}|admin\/api\/voice)$/.test(url.pathname)) || (!FEAT.social && /^\/(subs|friends)$/.test(url.pathname))) { res.writeHead(404); return res.end(); }
  if (url.pathname === '/img' && req.method === 'POST') {
    if (!auth.originOk(req)) return json(res, 403, { error: 'origin' });
    return images.upload(req, res, ip, json, readBuf);
  }
  // The sender deletes their own picture (in a room or in a private chat). It disappears for everybody at once.
  if (url.pathname === '/img/delete' && req.method === 'POST') {
    if (!auth.originOk(req)) return json(res, 403, { error: 'origin' });
    return readBody(req, 300, async body => {
      try {
        const user = auth.session(req), id = String(JSON.parse(body).id || '');
        if (!user) return json(res, 401, { error: 'login' });
        if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'bad_id' });
        if (images.deleteLimited(user.id)) return json(res, 429, { error: 'rate' });
        if ((await images.ownerOf(id)) !== user.id) return json(res, 404, { error: 'not_found' });   // not yours, or already gone
        await dropImage(id, true);
        res.writeHead(204); res.end();
      } catch (e) { json(res, e instanceof SyntaxError ? 400 : 503, { error: 'unavailable' }); }
    });
  }
  const imgMatch = req.method === 'GET' && url.pathname.match(/^\/img\/([a-f0-9]{32})$/);
  if (imgMatch) return images.serve(req, res, imgMatch[1]);
  if (url.pathname === '/vn' && req.method === 'POST') {
    if (!auth.originOk(req)) return json(res, 403, { error: 'origin' });
    return voice.upload(req, res, ip, json, readBuf);
  }
  if (url.pathname === '/vn/delete' && req.method === 'POST') {
    if (!auth.originOk(req)) return json(res, 403, { error: 'origin' });
    return readBody(req, 300, async body => {
      try {
        const user = auth.session(req), id = String(JSON.parse(body).id || '');
        if (!user) return json(res, 401, { error: 'login' });
        if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'bad_id' });
        if (voice.deleteLimited(user.id)) return json(res, 429, { error: 'rate' });
        if ((await voice.ownerOf(id)) !== user.id) return json(res, 404, { error: 'not_found' });
        await dropVoice(id, true);
        res.writeHead(204); res.end();
      } catch (e) { json(res, e instanceof SyntaxError ? 400 : 503, { error: 'unavailable' }); }
    });
  }
  const vnMatch = req.method === 'GET' && url.pathname.match(/^\/vn\/([a-f0-9]{32})$/);
  if (vnMatch) return voice.serve(req, res, vnMatch[1]).catch(() => { if (!res.headersSent) { res.writeHead(503); } res.end(); });
  if (url.pathname === '/admin/api/voice' && req.method === 'GET') {
    if (!adminAuth(req, res, ip)) return;
    const id = String(url.searchParams.get('id') || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'bad id' });
    const v = await voice.read(id).catch(() => null);
    if (!v) return json(res, 404, { error: 'gone' });
    res.writeHead(200, { 'Content-Type': v.mime, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return res.end(v.buf);
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    const page = seo.route(url.pathname, seo.siteBase(req));
    if (page) {
      if (page.location) { res.writeHead(301, { Location: page.location }); return res.end(); }
      res.writeHead(page.status, { 'Content-Type': page.type, 'Cache-Control': page.status === 200 ? 'public, max-age=3600' : 'no-store' });
      return res.end(req.method === 'HEAD' ? undefined : page.body);
    }
  }

  // ----- admin API (needs x-admin-token header) -----
  if (url.pathname === '/admin/api/state' && req.method === 'GET') {
    if (!adminAuth(req, res, ip)) return;
    for (const k of [...bans.keys()]) isBanned(k);   // drop expired bans
    return json(res, 200, {
      reports: reports.map(({ reporters, ...r }) => r),
      bans: [...bans].map(([bip, b]) => ({ ip: bip, ...b })),
      closed: [...closed].map(([name, c]) => ({ name, ...c })),
      live: [...rooms].filter(([, r]) => r.clients.size).map(([name, r]) => ({ name, count: r.clients.size }))
        .sort((a, b) => b.count - a.count),
      storage: !DB_URL ? 'memory' : dbReady ? 'database' : 'connecting',
      dbError: dbError.slice(0, 200),   // reason text only, never the URL or token
      acctBans: [...acctBans].map(([id, b]) => ({ id, ...b })),
      accounts: auth.status(),
      images: images.status(),
      voice: voice.status(),
    });
  }
  // A reported picture, for the admin page (the token travels in a header, so the page fetches it as a blob)
  if (url.pathname === '/admin/api/img' && req.method === 'GET') {
    if (!adminAuth(req, res, ip)) return;
    const id = String(url.searchParams.get('id') || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: 'bad id' });
    const img = await images.read(id).catch(() => null);
    if (!img) return json(res, 404, { error: 'gone' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    return res.end(img.buf);
  }
  if (url.pathname === '/admin/api/action' && req.method === 'POST') {
    return readBody(req, 2000, async body => {
      if (!adminAuth(req, res, ip)) return;
      try {
        const m = JSON.parse(body), rep = m.rid ? reports.find(r => r.rid === m.rid) : null;
        const hours = Math.max(0, Math.min(Number(m.hours) || 0, 24 * 365));
        if (m.a === 'ban') {
          const target = rep ? rep.ip : String(m.ip || '');
          if (!okIp(target)) return json(res, 400, { error: 'bad ip' });
          banIp(target, hours, m.reason || (rep ? 'reported: ' + rep.text : 'manual'));
        } else if (m.a === 'unban') {
          if (bans.delete(String(m.ip || ''))) touch('bans');
        } else if (m.a === 'close') {
          if (rep && rep.dm) return json(res, 400, { error: 'a private message has no room' });
          const name = rep ? rep.room : String(m.room || '').toLowerCase();
          if (!okRoom(name)) return json(res, 400, { error: 'bad room' });
          closeRoom(name, m.reason || 'moderator');
        } else if (m.a === 'open') {
          if (closed.delete(String(m.room || ''))) touch('closed');
        } else if (m.a === 'dismiss') {
          if (rep) { rep.status = 'dismissed'; touch('reports'); }
        } else if (m.a === 'banacct') {
          const id = rep ? rep.acct : String(m.id || '');
          if (!/^[a-f0-9]{16}$/.test(id || '')) return json(res, 400, { error: 'this message was not sent from an account' });
          banAcct(id, rep ? rep.nick : m.name, m.reason || (rep ? 'reported: ' + (rep.text || 'image') : 'manual'));
        } else if (m.a === 'unbanacct') {
          if (acctBans.delete(String(m.id || ''))) touch('acctbans');
        } else if (m.a === 'delimg') {
          const id = rep ? rep.img : String(m.id || '');
          if (!/^[a-f0-9]{32}$/.test(id || '')) return json(res, 400, { error: 'no image' });
          await dropImage(id, false);
          if (rep) { rep.status = 'image removed'; touch('reports'); }
        } else if (m.a === 'delvn') {
          const id = rep ? rep.aud : String(m.id || '');
          if (!/^[a-f0-9]{32}$/.test(id || '')) return json(res, 400, { error: 'no voice note' });
          await dropVoice(id, false);
          if (rep) { rep.status = 'voice note removed'; touch('reports'); }
        } else return json(res, 400, { error: 'unknown action' });
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }

  if (url.pathname === '/subs' || url.pathname === '/friends') return social.handle(req, res, url, ip);
  if (url.pathname === '/rooms') {
    const q = clean(url.searchParams.get('q'), 30).toLowerCase();
    const list = [...rooms].filter(([n, r]) => !n.startsWith('p-') && r.clients.size && n.includes(q) && !closed.has(n))
      .map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count).slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), user = auth.session(req);
    const nick = user ? user.name : clean(url.searchParams.get('nick'), 20);   // an account always chats under its own name
    if (!okRoom(name) || !nick || (conns.get(ip) || 0) >= 5) { res.writeHead(400); return res.end(); }
    if (isBanned(ip)) { res.writeHead(403); return res.end('banned'); }
    if (closed.has(name)) { res.writeHead(403); return res.end('closed'); }
    if (!user && await auth.nameReserved(nick)) { res.writeHead(403); return res.end('reserved'); }   // that name belongs to an account
    await ensureRoom(name);
    const r = room(name), otok = String(url.searchParams.get('otok') || '');
    // The first person to open a private room with a valid secret becomes its owner.
    if (name.startsWith('p-') && okTok(otok) && !r.ownerTok) { r.ownerTok = sha(otok); saveRoom(name); }
    const lv = roleLv(r, user, otok), owner = lv === 3;
    if (owner && user && !r.ownerAcct && !r.pub) { r.ownerAcct = user.id; saveRoom(name); }   // an account that owns a room keeps it on every device
    if (lv === 0 && (isKicked(r, ip) || roomBanned(r, ip, user))) { res.writeHead(403); return res.end('kicked'); }
    conns.set(ip, (conns.get(ip) || 0) + 1);
    res.ip = ip; res.cid = crypto.randomUUID().slice(0, 8); res.nick = nick; res.owner = owner; res.role = lv;
    res.acct = user ? user.id : '';
    res.uid = user ? 'a' + user.id : clean(url.searchParams.get('uid'), 24).replace(/[^a-zA-Z0-9]/g, '');
    res.iid = user ? acctIid(user.id) : iidOf(url.searchParams.get('dk'));   // '' for old pages without dk: they simply have no DM
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ history: r.history, you: { id: res.cid, owner, role: roleName(lv), iid: res.iid, uid: res.uid }, bg: r.bg || null, about: r.about, pin: r.pin })}\n\n`);
    r.clients.add(res);
    sys(name, '');   // no chat notice, only the member list is refreshed
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); r.clients.delete(res);
      conns.set(ip, Math.max(0, (conns.get(ip) || 1) - 1));
      sys(name, '');
      if (!r.clients.size) setTimeout(() => { if (!r.clients.size && rooms.get(name) === r) rooms.delete(name); }, 600000);
    });
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    return readBody(req, 5000, async body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), user = auth.session(req);
        let text = clean(m.text, 500), nick = clean(m.nick, 20);
        const imgId = m.img ? String(m.img) : '', audId = m.aud ? String(m.aud) : '', dur = Math.max(1, Math.min(30, Math.round(Number(m.dur) || 1)));
        if (user) nick = user.name;
        if (!okRoom(name) || (!text && !imgId && !audId) || (imgId && audId) || !nick) { res.writeHead(400); return res.end(); }
        if ((imgId || audId) && !user) return json(res, 403, { error: 'login' });                       // only accounts may send pictures and voice notes
        if (imgId && !images.owns(imgId, user.id)) return json(res, 400, { error: 'bad_image' });   // and only ones they uploaded themselves
        if (audId && !voice.owns(audId, user.id)) return json(res, 400, { error: 'bad_audio' });
        if (!user && await auth.nameReserved(nick)) return json(res, 403, { error: 'reserved' });
        if (isBanned(ip) || closed.has(name)) { res.writeHead(403); return res.end(); }
        const r = rooms.get(name);
        if (r && (isKicked(r, ip) || roomBanned(r, ip, user)) && roleLv(r, user, m.otok) === 0) { res.writeHead(403); return res.end(); }
        if (limited(ip)) { res.writeHead(429); return res.end('slow down'); }
        BAD.forEach(w => { text = text.replace(new RegExp(esc(w), 'gi'), '***'); });
        let reply = null;   // quoted message: copied from the room's own history, so it cannot be forged
        if (m.reply && r) { const o = r.history.find(x => x.id === String(m.reply)); if (o) reply = { id: o.id, nick: o.nick, text: clean(o.text, 80) || (o.img ? '[picture]' : o.aud ? '[voice note]' : '') }; }
        const msg = { id: crypto.randomUUID().slice(0, 8), nick, uid: user ? 'a' + user.id : clean(m.uid, 24).replace(/[^a-zA-Z0-9]/g, ''), text, t: Date.now() };
        if (reply) msg.reply = reply;
        if (user) msg.v = true;      // verified account badge
        if (imgId) msg.img = imgId;
        if (audId) { msg.aud = audId; msg.dur = dur; }
        sent.set(msg.id, { ip, room: name, nick, text, t: msg.t, ...(user ? { acct: user.id } : {}), ...(imgId ? { img: imgId } : {}), ...(audId ? { aud: audId } : {}) });   // ip stays server-side, never broadcast
        if (sent.size > 3000) sent.delete(sent.keys().next().value);
        broadcast(name, msg);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/typing' && req.method === 'POST') {
    return readBody(req, 500, async body => {
      res.writeHead(204); res.end();
      const now = Date.now();
      if (isBanned(ip) || now - (typingAt.get(ip) || 0) < 1500) return;
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), user = auth.session(req);
        const nick = user ? user.name : clean(m.nick, 20);
        const r = rooms.get(name);
        if (!r || !nick || closed.has(name) || ![...r.clients].some(c => c.ip === ip)) return;   // must be in the room
        if (!user && await auth.nameReserved(nick)) return;
        typingAt.set(ip, now);
        const data = `data: ${JSON.stringify({ typing: true, nick, uid: user ? 'a' + user.id : clean(m.uid, 24).replace(/[^a-zA-Z0-9]/g, '') })}\n\n`;
        r.clients.forEach(c => c.write(data));
      } catch {}
    });
  }
  // Private room owner removes someone: they are disconnected and blocked from this room for 1 hour.
  if (url.pathname === '/kick' && req.method === 'POST') {
    return readBody(req, 500, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), r = rooms.get(name);
        if (limited(ip)) { res.writeHead(429); return res.end(); }
        const lv = r ? roleLv(r, auth.session(req), m.otok) : 0;
        if (!r || lv < 1) { res.writeHead(403); return res.end(); }
        const target = [...r.clients].find(c => c.cid === String(m.cid || ''));
        if (!target || target.role > 0) { res.writeHead(404); return res.end(); }
        r.kicked.set(target.ip, Date.now() + 3600000);
        kick((c, n) => n === name && c.ip === target.ip && c.role === 0, 'You were removed from this room by the room staff.');
        addLog(name, r, 'kick', '', staffName(r, auth.session(req), lv), target.nick);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  // Send a direct message. Statuses: 204 ok, 404 recipient offline, 409 waiting for them to accept, 429 too fast.
  if (url.pathname === '/dm' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      try {
        const m = JSON.parse(body), { user, iid: from } = who(req, m), to = String(m.to || '');
        let text = clean(m.text, 500);
        const imgId = m.img ? String(m.img) : '', audId = m.aud ? String(m.aud) : '', dur = Math.max(1, Math.min(30, Math.round(Number(m.dur) || 1)));
        if (!from || !okIid(to) || to === from || (!text && !imgId && !audId) || (imgId && audId)) return json(res, 400, { error: 'bad request' });
        if ((imgId || audId) && !user) return json(res, 403, { error: 'login' });
        if (imgId && !images.owns(imgId, user.id)) return json(res, 400, { error: 'bad_image' });
        if (audId && !voice.owns(audId, user.id)) return json(res, 400, { error: 'bad_audio' });
        if (isBanned(ip)) return json(res, 403, { error: 'banned' });
        const mine = liveByIid(from);
        if (!mine.length) return json(res, 403, { error: 'not online' });   // you must be connected to a room
        if (limited(ip)) return json(res, 429, { error: 'slow down' });
        const targets = liveByIid(to);
        if (!targets.length) return json(res, 404, { error: 'offline' });
        if (dmBlocks.get(to) && dmBlocks.get(to).has(from)) { res.writeHead(204); return res.end(); }   // blocked: dropped without telling the sender
        const key = [from, to].sort().join(':'), now = Date.now();
        let pair = dmPairs.get(key), request = false;
        if (!pair) {
          const recent = (dmNew.get(from) || []).filter(t => now - t < 3600000);
          if (recent.length >= 6) return json(res, 429, { error: 'too many new conversations' });
          let pending = 0;
          for (const p of dmPairs.values()) if (p.to === to && !p.accepted) pending++;
          if (pending >= 15) { res.writeHead(204); return res.end(); }   // their request inbox is full
          recent.push(now); dmNew.set(from, recent);
          pair = { from, to, accepted: false, t: now }; dmPairs.set(key, pair); request = true;
          if (dmPairs.size > 5000) dmPairs.delete(dmPairs.keys().next().value);
        } else if (!pair.accepted) {
          if (pair.from === from) return json(res, 409, { error: 'pending' });
          pair.accepted = true;   // replying counts as accepting
        }
        pair.t = now;
        BAD.forEach(w => { text = text.replace(new RegExp(esc(w), 'gi'), '***'); });
        let reply = null;   // quoted message, copied from the server's own log of this conversation
        if (m.reply) { const o = dmLog.get(String(m.reply)); if (o && ((o.from === from && o.to === to) || (o.from === to && o.to === from))) reply = { id: String(m.reply), from: o.from, text: clean(o.text, 80) || (o.img ? '[picture]' : o.aud ? '[voice note]' : '') }; }
        const id = crypto.randomUUID().slice(0, 8);
        dmLog.set(id, { ip, from, to, fromNick: mine[0].nick, toNick: targets[0].nick, text, t: now, ...(user ? { acct: user.id } : {}), ...(imgId ? { img: imgId } : {}), ...(audId ? { aud: audId, dur } : {}) });
        if (dmLog.size > 1000) dmLog.delete(dmLog.keys().next().value);
        const data = `data: ${JSON.stringify({ dm: { id, from, nick: mine[0].nick, text, t: now, request, ...(reply ? { reply } : {}), ...(user ? { v: true } : {}), ...(imgId ? { img: imgId } : {}), ...(audId ? { aud: audId, dur } : {}), ...(pair.bg ? { bg: pair.bg } : {}) } })}\n\n`;
        targets.forEach(c => c.write(data));
        json(res, 200, { id, t: now, ...(reply ? { reply } : {}) });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }


  // ---- room tools for the owner of a private room: about text, ban, delete messages, pin, clear ----
  if (/^\/(room\/(about|manage|ban|unban|clear|staff)|msgdel|pin)$/.test(url.pathname) && req.method === 'POST') {
    return readBody(req, 2500, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), r = rooms.get(name), user = auth.session(req), p = url.pathname;
        if (!r || isBanned(ip) || closed.has(name)) return json(res, 403, { error: 'not allowed' });
        if (toolLimited(ip)) return json(res, 429, { error: 'slow down' });
        const lv = roleLv(r, user, m.otok), owner = lv === 3, sn = staffName(r, user, lv), all = data => r.clients.forEach(c => c.write(`data: ${JSON.stringify(data)}\n\n`));
        if (p === '/msgdel') {   // the owner can delete any message, everybody else only their own
          const id = String(m.id || ''), s = sent.get(id), i = r.history.findIndex(x => x.id === id);
          const mine = !!s && s.room === name && s.ip === ip && (!s.acct || (!!user && user.id === s.acct));
          if (i < 0 || !(lv >= 1 || mine)) return json(res, 403, { error: 'not allowed' });
          const msg = r.history[i]; r.history.splice(i, 1); r.rx.delete(id);
          if (!mine) addLog(name, r, 'msgdel', msg.text || (msg.img ? '[picture]' : msg.aud ? '[voice note]' : ''), sn, msg.nick);
          if (r.pin && r.pin.id === id) { r.pin = null; all({ pin: null }); saveRoom(name); }
          all({ del: id });
          if (msg.img) dropImage(msg.img, true).catch(() => {});
          return json(res, 200, { ok: true });
        }
        if (lv < 1) return json(res, 403, { error: 'staff only' });
        if (p === '/pin') {
          if (!m.id) { addLog(name, r, 'unpin', r.pin ? r.pin.text : '', sn, r.pin ? r.pin.nick : ''); r.pin = null; } else {
            const msg = r.history.find(x => x.id === String(m.id));
            if (!msg) return json(res, 404, { error: 'gone' });
            r.pin = { id: msg.id, nick: msg.nick, text: clean(msg.text, 200), ...(msg.img ? { img: msg.img } : {}) };
            addLog(name, r, 'pin', msg.text || (msg.img ? '[picture]' : msg.aud ? '[voice note]' : ''), sn, msg.nick);
          }
          all({ pin: r.pin }); saveRoom(name); return json(res, 200, { ok: true });
        }
        if (p === '/room/manage') return json(res, 200, { role: roleName(lv), about: r.about, banned: [...r.banned].map(([key, b]) => ({ key, nick: b.nick, t: b.t })), logs: r.logs, staff: [...r.staff].map(([acct, x]) => ({ acct, role: x.role, nick: x.nick })) });
        if (p === '/room/staff') {
          const role = m.role === 'admin' ? 'admin' : m.role === 'mod' ? 'mod' : '';
          if (role) {   // add: pick someone who is online with a verified account
            if (lv < (role === 'admin' ? 3 : 2)) return json(res, 403, { error: 'not allowed' });
            const t = [...r.clients].find(c => c.cid === String(m.cid || ''));
            if (!t || !t.acct || t.owner) return json(res, 404, { error: 'not found' });
            if (!r.staff.has(t.acct) && r.staff.size >= 20) return json(res, 400, { error: 'staff list full' });
            if (r.staff.has(t.acct) && r.staff.get(t.acct).role === 'admin' && lv < 3) return json(res, 403, { error: 'not allowed' });
            r.banned.delete('a:' + t.acct);
            r.staff.set(t.acct, { role, nick: t.nick, t: Date.now() });
            addLog(name, r, 'staff_add', role, sn, t.nick);
          } else {   // remove: owner removes anybody, admin removes mods, staff can leave
            const key = String(m.acct || ''), st = r.staff.get(key);
            if (!st) return json(res, 404, { error: 'not found' });
            const self = !!user && user.id === key;
            if (!self && lv < (st.role === 'admin' ? 3 : 2)) return json(res, 403, { error: 'not allowed' });
            r.staff.delete(key); addLog(name, r, 'staff_remove', st.role, sn, st.nick);
          }
          refreshRoles(name, r); return json(res, 200, { ok: true });
        }
        if (p === '/room/about') {
          if (lv < 2) return json(res, 403, { error: 'admin only' });
          addLog(name, r, 'about', '', sn, '');
          r.about = { topic: clean(m.topic, 80), desc: clean(m.desc, 300), rules: clean(m.rules, 500) };
          all({ about: r.about }); saveRoom(name); return json(res, 200, { ok: true });
        }
        if (p === '/room/clear') { r.rx.clear(); addLog(name, r, 'clear', '', sn, ''); r.history.length = 0; r.pin = null; all({ clear: true }); all({ pin: null }); saveRoom(name); return json(res, 200, { ok: true }); }
        if (p === '/room/unban') { addLog(name, r, 'unban', '', sn, ''); (Array.isArray(m.keys) ? m.keys : [m.key]).slice(0, 4).forEach(k => r.banned.delete(String(k || ''))); saveRoom(name); return json(res, 200, { ok: true }); }
        if (p === '/room/ban') {
          const target = [...r.clients].find(c => c.cid === String(m.cid || ''));
          if (!target || target.role > 0) return json(res, 404, { error: 'not found' });
          if (r.banned.size >= 100) return json(res, 400, { error: 'ban list full' });
          const b = { nick: target.nick, t: Date.now() };
          r.banned.set('ip:' + target.ip, b); if (target.acct) r.banned.set('a:' + target.acct, b);
          kick((c, n) => n === name && c.role === 0 && (c.ip === target.ip || (target.acct && c.acct === target.acct)), 'You were banned from this room by the room staff.');
          addLog(name, r, 'ban', '', sn, target.nick);
          saveRoom(name); return json(res, 200, { ok: true });
        }
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }
  // Custom chat background. bg = null (remove), { k: 'c1'..'c8' } (colour preset) or { img: <picture id> } (verified accounts only).
  function cleanBg(m, user) {
    const b = m && m.bg;
    if (!b) return { ok: true, bg: null };
    if (typeof b.k === 'string' && /^c[1-8]$/.test(b.k)) return { ok: true, bg: { k: b.k } };
    if (typeof b.img === 'string' && /^[a-f0-9]{32}$/.test(b.img)) {
      if (!user) return { ok: false, code: 403, error: 'login' };
      if (!images.owns(b.img, user.id)) return { ok: false, code: 400, error: 'bad_image' };
      return { ok: true, bg: { img: b.img } };
    }
    return { ok: false, code: 400, error: 'bad request' };
  }
  // The owner of a private room changes the room background, everyone in the room sees it.
  if (url.pathname === '/bg' && req.method === 'POST') {
    return readBody(req, 600, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), r = rooms.get(name), user = auth.session(req);
        if (!r || isBanned(ip) || closed.has(name)) return json(res, 403, { error: 'not allowed' });
        const lv = roleLv(r, user, m.otok);
        if (lv < 2) return json(res, 403, { error: 'admin only' });
        if (limited(ip)) return json(res, 429, { error: 'slow down' });
        const c = cleanBg(m, user);
        if (!c.ok) return json(res, c.code, { error: c.error });
        r.bg = c.bg; addLog(name, r, 'bg', '', staffName(r, user, lv), ''); saveRoom(name);
        const data = `data: ${JSON.stringify({ roombg: r.bg })}\n\n`;
        r.clients.forEach(cl => cl.write(data));
        res.writeHead(204); res.end();
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }
  // Either person of an accepted private conversation changes its background, both sides see it.
  if (url.pathname === '/dm/bg' && req.method === 'POST') {
    return readBody(req, 600, body => {
      try {
        const m = JSON.parse(body), { user, iid: me } = who(req, m), other = String(m.to || '');
        if (!me || !okIid(other) || isBanned(ip)) return json(res, 400, { error: 'bad request' });
        const pair = dmPairs.get([me, other].sort().join(':'));
        if (!pair || !pair.accepted) return json(res, 409, { error: 'not accepted' });
        if (limited(ip)) return json(res, 429, { error: 'slow down' });
        const c = cleanBg(m, user);
        if (!c.ok) return json(res, c.code, { error: c.error });
        pair.bg = c.bg; pair.t = Date.now();
        for (const [a, b] of [[me, other], [other, me]]) for (const cl of liveByIid(a)) cl.write(`data: ${JSON.stringify({ dmbg: { with: b, bg: pair.bg } })}\n\n`);
        res.writeHead(204); res.end();
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }
  // The receiver accepts a request, so the sender may keep writing.
  // ---- reactions: one emoji per person per message, tap the same one again to remove it ----
  if (url.pathname === '/react' && req.method === 'POST') {
    return readBody(req, 400, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), r = rooms.get(name), user = auth.session(req), e = String(m.e || '');
        if (!r || !RX.includes(e) || isBanned(ip) || closed.has(name)) return json(res, 403, { error: 'not allowed' });
        if (roleLv(r, user, m.otok) === 0 && (isKicked(r, ip) || roomBanned(r, ip, user))) return json(res, 403, { error: 'not allowed' });
        if (![...r.clients].some(c => c.ip === ip)) return json(res, 403, { error: 'join the room first' });
        if (toolLimited(ip)) return json(res, 429, { error: 'slow down' });
        const id = String(m.id || ''), msg = r.history.find(x => x.id === id);
        if (!msg) return json(res, 404, { error: 'gone' });
        const key = user ? 'a' + user.id : 'g' + sha(ip + clean(m.uid, 24)).slice(0, 12), votes = r.rx.get(id) || new Map();
        if (votes.get(key) === e) votes.delete(key); else votes.set(key, e);
        r.rx.set(id, votes);
        const c = rxCount(votes); if (Object.keys(c).length) msg.rx = c; else delete msg.rx;
        const data = `data: ${JSON.stringify({ rx: { id, c } })}\n\n`;
        r.clients.forEach(cl => cl.write(data));
        json(res, 200, { mine: votes.get(key) || '' });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }
  if (url.pathname === '/dm/react' && req.method === 'POST') {
    return readBody(req, 500, body => {
      try {
        const m = JSON.parse(body), { iid: from } = who(req, m), to = String(m.to || ''), e = String(m.e || ''), id = String(m.id || '');
        if (!from || !okIid(to) || !RX.includes(e) || isBanned(ip)) return json(res, 400, { error: 'bad request' });
        if (toolLimited(ip)) return json(res, 429, { error: 'slow down' });
        const o = dmLog.get(id), pair = dmPairs.get([from, to].sort().join(':'));
        if (!o || !pair || !pair.accepted || !((o.from === from && o.to === to) || (o.from === to && o.to === from))) return json(res, 404, { error: 'gone' });
        if (dmBlocks.get(to) && dmBlocks.get(to).has(from)) return json(res, 200, { mine: '' });
        const votes = dmRx.get(id) || new Map();
        if (votes.get(from) === e) votes.delete(from); else votes.set(from, e);
        dmRx.set(id, votes); if (dmRx.size > 2000) dmRx.delete(dmRx.keys().next().value);
        const c = rxCount(votes), send = (iid, w) => liveByIid(iid).forEach(cl => cl.write(`data: ${JSON.stringify({ dmrx: { id, with: w, c } })}\n\n`));
        send(from, to); send(to, from);
        json(res, 200, { mine: votes.get(from) || '' });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }
  if (url.pathname === '/dm/accept' && req.method === 'POST') {
    return readBody(req, 500, body => {
      try {
        const m = JSON.parse(body), me = who(req, m).iid, other = String(m.from || '');
        const pair = okIid(other) && me ? dmPairs.get([me, other].sort().join(':')) : null;
        if (pair && pair.to === me) pair.accepted = true;
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  // Keep the server's block list in step with the browser's: add and remove lists of iids.
  if (url.pathname === '/dm/block' && req.method === 'POST') {
    return readBody(req, 4000, body => {
      try {
        const m = JSON.parse(body), me = who(req, m).iid;
        if (!me) { res.writeHead(400); return res.end(); }
        const set = dmBlocks.get(me) || new Set();
        (Array.isArray(m.add) ? m.add : []).slice(0, 200).forEach(i => { if (okIid(String(i)) && set.size < 300) set.add(String(i)); });
        (Array.isArray(m.remove) ? m.remove : []).slice(0, 200).forEach(i => set.delete(String(i)));
        if (set.size) { dmBlocks.set(me, set); if (dmBlocks.size > 5000) dmBlocks.delete(dmBlocks.keys().next().value); } else dmBlocks.delete(me);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/report' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      res.writeHead(204); res.end();
      if (isBanned(ip) || limited(ip)) return;
      try {
        const b = JSON.parse(body), id = String(b.id || '').slice(0, 8);
        let src = sent.get(id);
        if (!src) {   // a private message can only be reported by the person it was sent to
          const d = dmLog.get(id);
          if (d && who(req, b).iid === d.to) src = { ip: d.ip, room: 'dm', nick: d.fromNick, text: d.text, t: d.t, dm: true, ...(d.acct ? { acct: d.acct } : {}), ...(d.img ? { img: d.img } : {}), ...(d.aud ? { aud: d.aud } : {}) };
        }
        if (!src) return;   // we only trust our own copy of the message, not what the client sends
        const open = reports.find(r => r.msgId === id && r.status === 'open');
        if (open) { if (!open.reporters.includes(ip)) { open.reporters.push(ip); open.count++; touch('reports'); } return; }
        reports.unshift({ rid: crypto.randomUUID().slice(0, 8), msgId: id, ...src, count: 1, reporters: [ip], status: 'open', at: Date.now() });
        if (reports.length > 200) reports.pop();
        touch('reports');
        if (src.aud) voice.keep(src.aud).catch(e => console.error('VN keep', e.message));
        if (src.img) images.keep(src.img).catch(e => console.error('IMG keep', e.message));   // evidence copy, kept 14 days even if the sender deletes the picture
        console.log('REPORT', src.room, src.nick, src.img ? '[image]' : src.aud ? '[voice note]' : src.text.slice(0, 100));
      } catch {}
    });
  }
  res.writeHead(404); res.end('Not found');
}

setInterval(() => {
  const n = Date.now();
  for (const [k, a] of hits) if (!a.some(t => n - t < 10000)) hits.delete(k);
  for (const [k, f] of adminFails) if (n - f.t > 900000) adminFails.delete(k);
  for (const [k, t] of typingAt) if (n - t > 10000) typingAt.delete(k);
  for (const [k, p] of dmPairs) if (n - p.t > DM_PAIR_TTL) dmPairs.delete(k);
  for (const [k, d] of dmLog) if (n - d.t > DM_LOG_TTL) dmLog.delete(k);
  for (const [k, a] of dmNew) if (!a.some(t => n - t < 3600000)) dmNew.delete(k);
  let pruned = false;   // reports are newest first, so the oldest are at the end
  while (reports.length && reports[reports.length - 1].at < n - REPORT_KEEP) { reports.pop(); pruned = true; }
  if (pruned) touch('reports');
}, 60000);
process.on('uncaughtException', e => console.error('ERR', e));
