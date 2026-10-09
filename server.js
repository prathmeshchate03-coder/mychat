// JenChat - zero-dependency guest chat server (Node 18+). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const rooms = new Map(), hits = new Map(), conns = new Map();
const BAD = ['Madharchod', 'Behenchod', 'bkl', 'Mc'];   // add words to filter, e.g. ['word1', 'word2']
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml' };
const okRoom = s => /^[a-z0-9-]{1,30}$/.test(s);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function room(name) {
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [] });
  return rooms.get(name);
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

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'public, max-age=300' });
    return res.end(fs.readFileSync(path.join(PUB, file)));
  }
  if (url.pathname === '/rooms') {
    const q = clean(url.searchParams.get('q'), 30).toLowerCase();
    const list = [...rooms].filter(([n, r]) => !n.startsWith('p-') && r.clients.size && n.includes(q))
      .map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count).slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    if (!okRoom(name) || !nick || (conns.get(ip) || 0) >= 5) { res.writeHead(400); return res.end(); }
    conns.set(ip, (conns.get(ip) || 0) + 1);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const r = room(name);
    res.write(`data: ${JSON.stringify({ history: r.history })}\n\n`);
    r.clients.add(res);
    broadcast(name, { system: true, text: `${nick} joined`, count: r.clients.size });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); r.clients.delete(res);
      conns.set(ip, Math.max(0, (conns.get(ip) || 1) - 1));
      broadcast(name, { system: true, text: `${nick} left`, count: r.clients.size });
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
        if (limited(ip)) { res.writeHead(429); return res.end('slow down'); }
        BAD.forEach(w => { text = text.replace(new RegExp(esc(w), 'gi'), '***'); });
        broadcast(name, { id: crypto.randomUUID().slice(0, 8), nick, text, t: Date.now() });
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }
  if (url.pathname === '/report' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      if (!limited(ip)) console.log('REPORT', ip, body.slice(0, 500));
      res.writeHead(204); res.end();
    });
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('JenChat running on port ' + PORT));

setInterval(() => {
  const n = Date.now();
  for (const [k, a] of hits) if (!a.some(t => n - t < 10000)) hits.delete(k);
}, 60000);
process.on('uncaughtException', e => console.error('ERR', e));
