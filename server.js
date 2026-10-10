// JenChat - DB-supported guest/member chat server (Node 18+). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { initDB, hashPassword } = require('./db');

const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const rooms = new Map(), hits = new Map(), conns = new Map(), bans = new Map(), closed = new Map(), sent = new Map(), reports = [], adminFails = new Map();
const BAD = []; 
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/admin': 'admin.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/sitemap.xml': 'sitemap.xml', '/robots.txt': 'robots.txt' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' };

let database = null;
initDB().then(db => { database = db; }).catch(err => { console.error("DB failed to load:", err); });

function room(name) {
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [], ownerIp: null });
  return rooms.get(name);
}
async function getUserList(name) {
  const r = room(name), list = [];
  for (const c of r.clients) {
    if (c.nick) {
      let avatar = '🐱';
      if (database) {
        const u = await database.collection('users').findOne({ username: c.nick });
        if (u && u.avatar) avatar = u.avatar;
      }
      list.push({ nick: c.nick, avatar, isOwner: c.ip === r.ownerIp, id: c.clientId });
    }
  }
  return list;
}
async function broadcast(name, msg) {
  const r = room(name);
  if (!msg.system && msg.text) { r.history.push(msg); if (r.history.length > 50) r.history.shift(); }
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  r.clients.forEach(c => c.write(data));
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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // ----- Member Registration Endpoint -----
  if (url.pathname === '/api/register' && req.method === 'POST') {
    return readBody(req, 2000, async body => {
      try {
        const m = JSON.parse(body);
        const username = String(m.username || '').trim().toLowerCase();
        if (!username || username.length < 2 || username.length > 20) return res.end(JSON.stringify({ error: 'Username must be between 2 and 20 characters long' }));
        if (!m.password || m.password.length < 6) return res.end(JSON.stringify({ error: 'Password min 6 chars long' }));

        if (!database) return res.end(JSON.stringify({ error: 'Database loading, try again' }));
        const existing = await database.collection('users').findOne({ username });
        if (existing) return res.end(JSON.stringify({ error: 'Username already taken' }));

        const credentials = hashPassword(m.password);
        const newUser = { username, salt: credentials.salt, hash: credentials.hash, avatar: m.avatar || '🐱', friends: [] };
        await database.collection('users').insertOne(newUser);
        
        const token = crypto.randomUUID();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, token, username, avatar: newUser.avatar }));
      } catch { res.writeHead(400); res.end(); }
    });
  }

  // ----- Member Login Endpoint -----
  if (url.pathname === '/api/login' && req.method === 'POST') {
    return readBody(req, 2000, async body => {
      try {
        const m = JSON.parse(body);
        const username = String(m.username || '').trim().toLowerCase();
        if (!database) return res.end(JSON.stringify({ error: 'DB error' }));

        const user = await database.collection('users').findOne({ username });
        if (!user) return res.end(JSON.stringify({ error: 'Invalid user or password' }));

        const verify = hashPassword(m.password, user.salt);
        if (verify.hash !== user.hash) return res.end(JSON.stringify({ error: 'Invalid user or password' }));

        const token = crypto.randomUUID();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, token, username, avatar: user.avatar || '🐱' }));
      } catch { res.writeHead(400); res.end(); }
    });
  }

  // ----- Friends List Management APIs -----
  if (url.pathname === '/api/friends' && req.method === 'GET') {
    const user = url.searchParams.get('user');
    if (!database || !user) return res.end(JSON.stringify([]));
    const u = await database.collection('users').findOne({ username: user.toLowerCase() });
    return res.end(JSON.stringify(u ? (u.friends || []) : []));
  }

  if (url.pathname === '/api/add-friend' && req.method === 'POST') {
    return readBody(req, 1000, async body => {
      try {
        const m = JSON.parse(body);
        const myName = String(m.me || '').toLowerCase();
        const friendName = String(m.friend || '').toLowerCase();
        if (!database || myName === friendName) return res.end(JSON.stringify({ error: 'Invalid operation' }));

        const target = await database.collection('users').findOne({ username: friendName });
        if (!target) return res.end(JSON.stringify({ error: 'User does not exist' }));

        await database.collection('users').updateOne({ username: myName }, { $addToSet: { friends: friendName } });
        return res.end(JSON.stringify({ ok: true }));
      } catch { res.writeHead(400); res.end(); }
    });
  }

  // Static files server block
  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
    return res.end(fs.readFileSync(path.join(PUB, file)));
  }

  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    if (!okRoom(name) || !nick) { res.writeHead(400); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const r = room(name); if (name.startsWith('p-') && !r.ownerIp) r.ownerIp = ip;
    res.clientId = crypto.randomUUID().slice(0, 8); res.nick = nick; res.ip = ip;
    r.clients.add(res);
    res.write(`data: ${JSON.stringify({ history: r.history, yourId: res.clientId, isOwner: (ip === r.ownerIp) })}\n\n`);
    const uList = await getUserList(name);
    broadcast(name, { system: true, type: 'join', text: `${nick} joined`, count: r.clients.size, users: uList });
    
    req.on('close', async () => {
      r.clients.delete(res); if (r.clients.size === 0 && name.startsWith('p-')) r.ownerIp = null;
      const updatedList = await getUserList(name);
      broadcast(name, { system: true, type: 'leave', text: `${nick} left`, count: r.clients.size, users: updatedList });
    });
    return;
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    return readBody(req, 5000, body => {
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase();
        let msg = { id: crypto.randomUUID().slice(0,8), nick: m.nick, text: clean(m.text, 500), avatar: m.avatar || '🐱', t: Date.now() };
        broadcast(name, msg); res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('JenChat active on ' + PORT));
