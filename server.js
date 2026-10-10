// JenChat - zero-dependency guest chat server (Node 18+). Run: node server.js
// Admin panel: set env ADMIN_TOKEN (long random string), then open /admin
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const rooms = new Map(), hits = new Map(), conns = new Map();
const bans = new Map();       // ip -> { reason, t, until }  (until = 0 means permanent)
const closed = new Map();     // room name -> { reason, t }
const sent = new Map();       // msg id -> { ip, room, nick, text, t }  last 3000 messages, server-side only
const reports = [];           // newest first, max 200
const adminFails = new Map(); // ip -> { n, t }
const BAD = [];   // add words to filter, e.g. ['word1', 'word2']
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/admin': 'admin.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/sitemap.xml': 'sitemap.xml', '/robots.txt': 'robots.txt' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };
const okRoom = s => /^[a-z0-9-]{1,30}$/.test(s);
const okIp = s => /^[0-9a-fA-F:.]{3,45}$/.test(s);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const okTok = s => /^[a-zA-Z0-9]{16,64}$/.test(s);
const typingAt = new Map();   // ip -> last typing event time

function room(name) {
  // ownerTok: sha256 of the creator's secret (private rooms only). kicked: ip -> expiry time.
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [], ownerTok: '', kicked: new Map() });
  return rooms.get(name);
}
// Join/leave notice that also carries the current member list (no IPs, only public info).
function sys(name, text) {
  const r = room(name);
  broadcast(name, { system: true, text, count: r.clients.size,
    users: [...r.clients].map(c => ({ id: c.cid, uid: c.uid, nick: c.nick, owner: !!c.owner })) });
}
function isKicked(r, ip) {
  const t = r.kicked.get(ip);
  if (!t) return false;
  if (t < Date.now()) { r.kicked.delete(ip); return false; }
  return true;
}
function broadcast(name, msg) {
  const r = room(name);
  if (!msg.system) { r.history.push(msg); if (r.history.length > 50) r.history.shift(); }
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  r.clients.forEach(c => c.write(data));
}
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 10000);
  a.push(now); hits.set(ip, a); return a.length > 8;
}
function readBody(req, max, cb) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > max) { req.destroy(); } });
  req.on('end', () => cb(body));
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
async function dbCmd(cmd) {
  if (/^rediss?:/i.test(DB_URL)) throw new Error('wrong URL type: use the REST URL that starts with https://, not the redis:// one');
  if (!DB_TOKEN) throw new Error('UPSTASH_REDIS_REST_TOKEN is empty or missing');
  let r;
  try {
    r = await fetch(DB_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd), signal: AbortSignal.timeout(5000) });
  } catch (e) { throw new Error('cannot connect to the database URL (' + ((e.cause && (e.cause.code || e.cause.message)) || e.name + ': ' + e.message) + ')'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
  return j.result;
}
const dump = { bans: () => [...bans], closed: () => [...closed], reports: () => reports.filter(r => r.at > Date.now() - REPORT_KEEP) };
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
    console.log(`DB loaded: ${bans.size} bans, ${closed.size} closed rooms, ${reports.length} reports`);
    if (dirty.size) flush();
  } catch (e) { dbError = e.message; console.error('DB LOAD FAILED, retrying in 30s:', e.message); setTimeout(dbLoad, 30000); }
}
if (DB_URL) dbLoad();
async function shutdown() {   // Render sends SIGTERM on every deploy: save pending changes first
  try { await Promise.race([flush(), new Promise(r => setTimeout(r, 4000))]); } finally { process.exit(0); }
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
  const url = new URL(req.url, 'http://x');
  // On Render the last X-Forwarded-For entry is the one added by Render's proxy = the real client.
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // ----- Dynamic Blog Posts Handler -----
  if (url.pathname.startsWith('/blog/')) {
    const seoManager = require('./seo');
    const slug = url.pathname.split('/').pop();
    const post = seoManager.BLOG_POSTS[slug];
    
    if (post) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      const htmlContent = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          ${seoManager.getMetaTags(post)}
          <link rel="stylesheet" href="/style.css">
        </head>
        <body>
          <header style="padding:20px; background:#f4f4f9; text-align:center;">
            <a href="/">← Back to Home</a>
          </header>
          <main style="max-width:800px; margin:40px auto; padding:0 20px; font-family:sans-serif; line-height:1.6;">
            ${post.content}
          </main>
        </body>
        </html>
      `;
      return res.end(htmlContent);
    }
  }

  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    const headers = { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'public, max-age=300' };
    if (url.pathname === '/admin') { headers['Cache-Control'] = 'no-store'; headers['X-Robots-Tag'] = 'noindex, nofollow'; }
    res.writeHead(200, headers);
    return res.end(fs.readFileSync(path.join(PUB, file)));
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
    });
  }
  if (url.pathname === '/admin/api/action' && req.method === 'POST') {
    return readBody(req, 2000, body => {
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
          const name = rep ? rep.room : String(m.room || '').toLowerCase();
          if (!okRoom(name)) return json(res, 400, { error: 'bad room' });
          closeRoom(name, m.reason || 'moderator');
        } else if (m.a === 'open') {
          if (closed.delete(String(m.room || ''))) touch('closed');
        } else if (m.a === 'dismiss') {
          if (rep) { rep.status = 'dismissed'; touch('reports'); }
        } else return json(res, 400, { error: 'unknown action' });
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
  }

  if (url.pathname === '/rooms') {
    const q = clean(url.searchParams.get('q'), 30).toLowerCase();
    const list = [...rooms].filter(([n, r]) => !n.startsWith('p-') && r.clients.size && n.includes(q) && !closed.has(n))
      .map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count).slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    if (!okRoom(name) || !nick || (conns.get(ip) || 0) >= 5) { res.writeHead(400); return res.end(); }
    if (isBanned(ip)) { res.writeHead(403); return res.end('banned'); }
    if (closed.has(name)) { res.writeHead(403); return res.end('closed'); }
    const r = room(name), otok = String(url.searchParams.get('otok') || '');
    // The first person to open a private room with a valid secret becomes its owner.
    if (name.startsWith('p-') && okTok(otok) && !r.ownerTok) r.ownerTok = sha(otok);
    const owner = !!r.ownerTok && okTok(otok) && sha(otok) === r.ownerTok;
    if (!owner && isKicked(r, ip)) { res.writeHead(403); return res.end('kicked'); }
    conns.set(ip, (conns.get(ip) || 0) + 1);
    res.ip = ip; res.cid = crypto.randomUUID().slice(0, 8); res.nick = nick; res.owner = owner;
    res.uid = clean(url.searchParams.get('uid'), 24).replace(/[^a-zA-Z0-9]/g, '');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ history: r.history, you: { id: res.cid, owner } })}\n\n`);
    r.clients.add(res);
    sys(name, `${nick} joined`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); r.clients.delete(res);
      conns.set(ip, Math.max(0, (conns.get(ip) || 1) - 1));
      sys(name, `${nick} left`);
      if (!r.clients.size) setTimeout(() => { if (!r.clients.size) rooms.delete(name); }, 600000);
    });
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    return readBody(req, 5000, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase();
        let text = clean(m.text, 500); const nick = clean(m.nick, 20);
        if (!okRoom(name) || !text || !nick) { res.writeHead(400); return res.end(); }
        if (isBanned(ip) || closed.has(name)) { res.writeHead(403); return res.end(); }
        const r = rooms.get(name);
        if (r && isKicked(r, ip) && !(r.ownerTok && okTok(String(m.otok || '')) && sha(String(m.otok)) === r.ownerTok)) { res.writeHead(403); return res.end(); }
        if (limited(ip)) { res.writeHead(429); return res.end('slow down'); }
        BAD.forEach(w => { text = text.replace(new RegExp(esc(w), 'gi'), '***'); });
        const msg = { id: crypto.randomUUID().slice(0, 8), nick, uid: clean(m.uid, 24).replace(/[^a-zA-Z0-9]/g, ''), text, t: Date.now() };
        sent.set(msg.id, { ip, room: name, nick, text, t: msg.t });   // ip stays server-side, never broadcast
        if (sent.size > 3000) sent.delete(sent.keys().next().value);
        broadcast(name, msg);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/typing' && req.method === 'POST') {
    return readBody(req, 500, body => {
      res.writeHead(204); res.end();
      const now = Date.now();
      if (isBanned(ip) || now - (typingAt.get(ip) || 0) < 1500) return;
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), nick = clean(m.nick, 20);
        const r = rooms.get(name);
        if (!r || !nick || closed.has(name) || ![...r.clients].some(c => c.ip === ip)) return;   // must be in the room
        typingAt.set(ip, now);
        const data = `data: ${JSON.stringify({ typing: true, nick, uid: clean(m.uid, 24).replace(/[^a-zA-Z0-9]/g, '') })}\n\n`;
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
        if (!r || !r.ownerTok || !okTok(String(m.otok || '')) || sha(String(m.otok)) !== r.ownerTok) { res.writeHead(403); return res.end(); }
        const target = [...r.clients].find(c => c.cid === String(m.cid || ''));
        if (!target || target.owner) { res.writeHead(404); return res.end(); }
        r.kicked.set(target.ip, Date.now() + 3600000);
        kick((c, n) => n === name && c.ip === target.ip && !c.owner, 'You were removed from this room by the owner.');
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/report' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      res.writeHead(204); res.end();
      if (isBanned(ip) || limited(ip)) return;
      try {
        const id = String(JSON.parse(body).id || '').slice(0, 8), src = sent.get(id);
        if (!src) return;   // we only trust our own copy of the message, not what the client sends
        const open = reports.find(r => r.msgId === id && r.status === 'open');
        if (open) { if (!open.reporters.includes(ip)) { open.reporters.push(ip); open.count++; touch('reports'); } return; }
        reports.unshift({ rid: crypto.randomUUID().slice(0, 8), msgId: id, ...src, count: 1, reporters: [ip], status: 'open', at: Date.now() });
        if (reports.length > 200) reports.pop();
        touch('reports');
        console.log('REPORT', src.room, src.nick, src.text.slice(0, 100));
      } catch {}
    });
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('JenChat running on port ' + PORT + (ADMIN_TOKEN ? '' : ' (admin disabled: set ADMIN_TOKEN)')));

setInterval(() => {
  const n = Date.now();
  for (const [k, a] of hits) if (!a.some(t => n - t < 10000)) hits.delete(k);
  for (const [k, f] of adminFails) if (n - f.t > 900000) adminFails.delete(k);
  for (const [k, t] of typingAt) if (n - t > 10000) typingAt.delete(k);
  let pruned = false;   // reports are newest first, so the oldest are at the end
  while (reports.length && reports[reports.length - 1].at < n - REPORT_KEEP) { reports.pop(); pruned = true; }
  if (pruned) touch('reports');
}, 60000);
process.on('uncaughtException', e => console.error('ERR', e));
