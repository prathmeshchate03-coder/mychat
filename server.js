// JenChat - zero-dependency guest chat server (Node 18+). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const rooms = new Map(), hits = new Map(), conns = new Map(), bans = new Map(), closed = new Map(), sent = new Map(), reports = [], adminFails = new Map();
const BAD = []; 
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/admin': 'admin.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
const okRoom = s => /^[a-z0-9-]{1,30}$/.test(s), okIp = s => /^[0-9a-fA-F:.]{3,45}$/.test(s);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n), esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function room(name) {
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [], ownerIp: null });
  return rooms.get(name);
}
function getUserList(name) {
  const r = room(name), list = [];
  r.clients.forEach(c => { if (c.nick) list.push({ nick: c.nick, isOwner: c.ip === r.ownerIp, id: c.clientId }); });
  return list;
}
function broadcast(name, msg) {
  const r = room(name);
  if (!msg.system && msg.text) { r.history.push(msg); if (r.history.length > 50) r.history.shift(); }
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  r.clients.forEach(c => c.write(data));
}
function limited(ip) {
  const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 10000);
  a.push(now); hits.set(ip, a); return a.length > 8;
}
function readBody(req, max, cb) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > max) req.destroy(); });
  req.on('end', () => cb(body));
}
function isBanned(ip) {
  const b = bans.get(ip); if (!b) return false;
  if (b.until && b.until < Date.now()) { bans.delete(ip); return false; }
  return true;
}
function kick(pred, text) {
  const data = `data: ${JSON.stringify({ system: true, type: 'kick', text })}\n\n`;
  for (const [name, r] of rooms) for (const c of [...r.clients]) { if (pred(c, name)) c.write(data, () => c.destroy()); }
}
function banIp(ip, hours, reason) {
  bans.set(ip, { reason: clean(reason, 100), t: Date.now(), until: hours > 0 ? Date.now() + hours * 3600000 : 0 });
  kick(c => c.ip === ip, 'You have been banned.');
  reports.forEach(r => { if (r.ip === ip && r.status === 'open') r.status = 'banned'; });
}
function closeRoom(name, reason) {
  closed.set(name, { reason: clean(reason, 100), t: Date.now() });
  kick((c, n) => n === name, 'This room was closed by a moderator.');
  reports.forEach(r => { if (r.room === name && r.status === 'open') r.status = 'closed'; });
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
  const url = new URL(req.url, 'http://x'), ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    const headers = { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'public, max-age=300' };
    if (url.pathname === '/admin') { headers['Cache-Control'] = 'no-store'; headers['X-Robots-Tag'] = 'noindex, nofollow'; }
    res.writeHead(200, headers); return res.end(fs.readFileSync(path.join(PUB, file)));
  }
  if (url.pathname === '/admin/api/state' && req.method === 'GET') {
    if (!adminAuth(req, res, ip)) return;
    for (const k of [...bans.keys()]) isBanned(k);
    return json(res, 200, {
      reports: reports.map(({ reporters, ...r }) => r), bans: [...bans].map(([bip, b]) => ({ ip: bip, ...b })),
      closed: [...closed].map(([name, c]) => ({ name, ...c })),
      live: [...rooms].filter(([, r]) => r.clients.size).map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count),
    });
  }
  if (url.pathname === '/admin/api/action' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      if (!adminAuth(req, res, ip)) return;
      try {
        const m = JSON.parse(body), rep = m.rid ? reports.find(r => r.rid === m.rid) : null, hours = Math.max(0, Math.min(Number(m.hours) || 0, 24 * 365));
        if (m.a === 'ban') { const target = rep ? rep.ip : String(m.ip || ''); if (!okIp(target)) return json(res, 400, { error: 'bad ip' }); banIp(target, hours, m.reason || (rep ? 'reported: ' + rep.text : 'manual')); }
        else if (m.a === 'unban') bans.delete(String(m.ip || ''));
        else if (m.a === 'close') { const name = rep ? rep.room : String(m.room || '').toLowerCase(); if (!okRoom(name)) return json(res, 400, { error: 'bad room' }); closeRoom(name, m.reason || 'moderator'); }
        else if (m.a === 'open') closed.delete(String(m.room || ''));
        else if (m.a === 'dismiss') { if (rep) rep.status = 'dismissed'; }
        else return json(res, 400, { error: 'unknown action' });
        json(res, 200, { ok: true });
      } catch (err) { json(res, 400, { error: 'bad request' }); }
    });
  }
  if (url.pathname === '/rooms') {
    const q = clean(url.searchParams.get('q'), 30).toLowerCase();
    const list = [...rooms].filter(([n, r]) => !n.startsWith('p-') && r.clients.size && n.includes(q) && !closed.has(n)).map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count).slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    if (!okRoom(name) || !nick || (conns.get(ip) || 0) >= 5) { res.writeHead(400); return res.end(); }
    if (isBanned(ip) || closed.has(name)) { res.writeHead(403); return res.end('blocked'); }
    conns.set(ip, (conns.get(ip) || 0) + 1); res.ip = ip; res.nick = nick; res.clientId = crypto.randomUUID().slice(0, 8);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const r = room(name); if (name.startsWith('p-') && !r.ownerIp) r.ownerIp = ip;
    res.write(`data: ${JSON.stringify({ history: r.history, yourId: res.clientId, isOwner: (ip === r.ownerIp) })}\n\n`);
    r.clients.add(res); broadcast(name, { system: true, type: 'join', text: `${nick} joined`, count: r.clients.size, users: getUserList(name) });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); r.clients.delete(res); conns.set(ip, Math.max(0, (conns.get(ip) || 1) - 1));
      if (r.clients.size === 0 && name.startsWith('p-')) r.ownerIp = null;
      broadcast(name, { system: true, type: 'leave', text: `${nick} left`, count: r.clients.size, users: getUserList(name) });
      if (!r.clients.size) setTimeout(() => { if (!r.clients.size) rooms.delete(name); }, 600000);
    });
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    return readBody(req, 5000, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(); let text = clean(m.text, 500); const nick = clean(m.nick, 20);
        if (!okRoom(name) || !text || !nick || isBanned(ip) || closed.has(name)) { res.writeHead(403); return res.end(); }
        if (limited(ip)) { res.writeHead(429); return res.end('slow'); }
        BAD.forEach(w => { text = text.replace(new RegExp(esc(w), 'gi'), '***'); });
        const msg = { id: crypto.randomUUID().slice(0, 8), nick, text, t: Date.now() };
        sent.set(msg.id, { ip, room: name, nick, text, t: msg.t }); if (sent.size > 3000) sent.delete(sent.keys().next().value);
        broadcast(name, msg); res.writeHead(204); res.end();
      } catch (err) { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/typing' && req.method === 'POST') {
    return readBody(req, 1000, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), nick = clean(m.nick, 20);
        if (!okRoom(name) || !nick) { res.writeHead(400); return res.end(); }
        broadcast(name, { system: true, type: 'typing', nick: nick, isTyping: !!m.isTyping }); res.writeHead(204); res.end();
      } catch (err) { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/kick' && req.method === 'POST') {
    return readBody(req, 1000, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase(), targetId = String(m.targetId || ''), r = room(name);
        if (!name.startsWith('p-') || r.ownerIp !== ip) { res.writeHead(403); return res.end(); }
        for (const c of r.clients) { if (c.clientId === targetId) { c.write(`data: ${JSON.stringify({ system: true, type: 'kick', text: 'Kicked by owner.' })}\n\n`, () => c.destroy()); break; } }
        res.writeHead(200); res.end(JSON.stringify({ ok: true }));
      } catch (err) { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/report' && req.method === 'POST') {
