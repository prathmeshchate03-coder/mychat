// MyChat - zero-dependency guest chat server (Node 18+). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const rooms = new Map();            // name -> { clients:Set, history:[] }
const hits = new Map();             // ip -> [timestamps] (rate limit)
const BAD = ['badword1', 'badword2']; // add words you want filtered

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
  a.push(now); hits.set(ip, a); return a.length > 8;   // max 8 msgs / 10s
}
const okRoom = s => /^[a-z0-9-]{1,30}$/i.test(s || '');
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (url.pathname === '/rooms') {      // public rooms only (private ones start with "p-")
    const list = [...rooms].filter(([n, r]) => !n.startsWith('p-') && r.clients.size)
      .map(([name, r]) => ({ name, count: r.clients.size })).sort((a, b) => b.count - a.count).slice(0, 30);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(list));
  }
  if (url.pathname === '/events') {
    const name = url.searchParams.get('room').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    if (!okRoom(name) || !nick) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const r = room(name);
    res.write(`data: ${JSON.stringify({ history: r.history })}\n\n`);
    r.clients.add(res);
    broadcast(name, { system: true, text: `${nick} joined`, count: r.clients.size });
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); r.clients.delete(res);
      broadcast(name, { system: true, text: `${nick} left`, count: r.clients.size });
      if (!r.clients.size) setTimeout(() => { if (!r.clients.size) rooms.delete(name); }, 600000);
    });
    return;
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    let body = ''; req.on('data', d => { body += d; if (body.length > 5000) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body), name = String(m.room).toLowerCase();
        let text = clean(m.text, 500); const nick = clean(m.nick, 20);
        if (!okRoom(name) || !text || !nick) { res.writeHead(400); return res.end(); }
        if (limited(ip)) { res.writeHead(429); return res.end('slow down'); }
        BAD.forEach(w => { text = text.replace(new RegExp(w, 'gi'), '***'); });
        broadcast(name, { id: crypto.randomUUID().slice(0, 8), nick, text, t: Date.now() });
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }
  if (url.pathname === '/report' && req.method === 'POST') {   // reports are logged; review them!
    let body = ''; req.on('data', d => body += d);
    req.on('end', () => { console.log('REPORT', body.slice(0, 500)); res.writeHead(204); res.end(); });
    return;
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('Chat running on http://localhost:' + PORT));
