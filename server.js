// JenChat - zero-dependency guest chat server with Registration, Email Verification & Image Deletion (Node 18+)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const rooms = new Map(), hits = new Map(), conns = new Map();
const bans = new Map();       // ip -> { reason, t, until }
const closed = new Map();     // room name -> { reason, t }
const registeredUsers = new Map(); // email -> { id, name, passHash, verified, code, t }
const activeSessions = new Map();  // sessionId -> email
const sent = new Map();       // msg id -> { ip, room, nick, text, t, userId?, isImage?, imageId? }
const reports = [];           // newest first, max 200
const adminFails = new Map();
const BAD = [];
const seo = require('./seo');
const PAGES = { '/': 'index.html', '/chat': 'chat.html', '/legal': 'legal.html', '/admin': 'admin.html', '/style.css': 'style.css', '/logo.svg': 'logo.svg', '/og.png': 'og.png' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const okRoom = s => /^[a-z0-9-]{1,30}$/.test(s);
const okIp = s => /^[0-9a-fA-F:.]{3,45}$/.test(s);
const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const okDk = s => /^[a-f0-9]{32}$/.test(s);
const okIid = s => /^[a-f0-9]{16}$/.test(s);
const iidOf = dk => (okDk(String(dk || '')) ? sha(dk).slice(0, 16) : '');
const dmPairs = new Map();
const dmBlocks = new Map();
const dmNew = new Map();
const dmLog = new Map();
const DM_LOG_TTL = 12 * 3600000, DM_PAIR_TTL = 24 * 3600000;

function liveByIid(iid) {
  const out = [];
  for (const r of rooms.values()) for (const c of r.clients) if (c.iid === iid) out.push(c);
  return out;
}

function room(name) {
  if (!rooms.has(name)) rooms.set(name, { clients: new Set(), history: [], ownerTok: '', kicked: new Map() });
  return rooms.get(name);
}

function sys(name, text) {
  const r = room(name);
  broadcast(name, { system: true, text, count: r.clients.size,
    users: [...r.clients].map(c => ({ id: c.cid, uid: c.uid, iid: c.iid, nick: c.nick, owner: !!c.owner, reg: !!c.reg })) });
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

function getSessionUser(req) {
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/session=([a-zA-Z0-9]+)/);
  if (!match) return null;
  const email = activeSessions.get(match[1]);
  return email ? registeredUsers.get(email) : null;
}

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress;
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const file = PAGES[url.pathname];
  if (file && req.method === 'GET') {
    const headers = { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'public, max-age=300' };
    if (url.pathname === '/admin') { headers['Cache-Control'] = 'no-store'; headers['X-Robots-Tag'] = 'noindex, nofollow'; }
    if (file.endsWith('.png')) headers['Cache-Control'] = 'public, max-age=86400';
    let content = fs.readFileSync(path.join(PUB, file));
    if (file.endsWith('.html')) content = seo.injectHead(file, content.toString('utf8'), seo.siteBase(req));
    res.writeHead(200, headers);
    return res.end(content);
  }

  // ----- AUTHENTICATION & REGISTRATION ENDPOINTS -----
  if (url.pathname === '/auth/register' && req.method === 'POST') {
    return readBody(req, 2000, body => {
      try {
        const { email, password, name } = JSON.parse(body);
        const cleanEmail = clean(email, 50).toLowerCase();
        const cleanName = clean(name, 20);
        const cleanPass = String(password || '');
        if (!cleanEmail || !cleanPass || !cleanName || cleanPass.length < 6) {
          return json(res, 400, { error: 'Invalid details or password too short (min 6 chars)' });
        }
        if (registeredUsers.has(cleanEmail)) {
          return json(res, 400, { error: 'Email already registered' });
        }
        const verifyCode = Math.floor(100000 + Math.random() * 900000).toString();
        const userId = crypto.randomUUID().slice(0, 12);
        registeredUsers.set(cleanEmail, {
          id: userId,
          name: cleanName,
          email: cleanEmail,
          passHash: sha(cleanPass),
          verified: false,
          code: verifyCode,
          t: Date.now()
        });
        // For testing/development convenience, code can be checked or sent. In production, connect SMTP/Mail relay.
        console.log(`Verification code for ${cleanEmail}: ${verifyCode}`);
        json(res, 200, { ok: true, message: 'Registration successful. Please verify your email.', debugCode: verifyCode });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
  }

  if (url.pathname === '/auth/verify' && req.method === 'POST') {
    return readBody(req, 1000, body => {
      try {
        const { email, code } = JSON.parse(body);
        const user = registeredUsers.get(clean(email, 50).toLowerCase());
        if (!user || user.code !== String(code).trim()) {
          return json(res, 400, { error: 'Invalid verification code' });
        }
        user.verified = true;
        user.code = '';
        json(res, 200, { ok: true, message: 'Email verified successfully!' });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
  }

  if (url.pathname === '/auth/login' && req.method === 'POST') {
    return readBody(req, 1000, body => {
      try {
        const { email, password } = JSON.parse(body);
        const user = registeredUsers.get(clean(email, 50).toLowerCase());
        if (!user || user.passHash !== sha(String(password || ''))) {
          return json(res, 400, { error: 'Invalid email or password' });
        }
        if (!user.verified) {
          return json(res, 403, { error: 'Email not verified. Please verify first.' });
        }
        const sessionId = crypto.randomUUID();
        activeSessions.set(sessionId, user.email);
        res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
        json(res, 200, { ok: true, name: user.name, id: user.id });
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
  }

  if (url.pathname === '/auth/me' && req.method === 'GET') {
    const user = getSessionUser(req);
    if (!user || !user.verified) return json(res, 401, { loggedIn: false });
    json(res, 200, { loggedIn: true, name: user.name, id: user.id, email: user.email });
  }

  if (url.pathname === '/auth/logout' && req.method === 'POST') {
    const cookie = req.headers['cookie'] || '';
    const match = cookie.match(/session=([a-zA-Z0-9]+)/);
    if (match) activeSessions.delete(match[1]);
    res.setHeader('Set-Cookie', 'session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    res.writeHead(204); res.end();
  }

  // ----- IMAGE DELETION ENDPOINT -----
  if (url.pathname === '/img/delete' && req.method === 'POST') {
    return readBody(req, 1000, body => {
      try {
        const user = getSessionUser(req);
        if (!user) return json(res, 401, { error: 'Login required' });
        const { msgId } = JSON.parse(body);
        const msg = sent.get(msgId);
        if (!msg || msg.userId !== user.id) {
          return json(res, 403, { error: 'Unauthorized or message not found' });
        }
        // Remove image content from sent cache & broadcast deletion
        msg.text = '[Image deleted by user]';
        msg.isImage = false;
        msg.deleted = true;

        const r = rooms.get(msg.room);
        if (r) {
          r.history.forEach(h => {
            if (h.id === msgId) { h.text = '[Image deleted by user]'; h.isImage = false; h.deleted = true; }
          });
          const delEvent = `data: ${JSON.stringify({ imgdel: msgId })}\n\n`;
          r.clients.forEach(c => c.write(delEvent));
        }
        res.writeHead(204); res.end();
      } catch { json(res, 400, { error: 'Bad request' }); }
    });
  }

  if (url.pathname === '/events') {
    const name = String(url.searchParams.get('room') || '').toLowerCase(), nick = clean(url.searchParams.get('nick'), 20);
    const user = getSessionUser(req);
    const finalNick = user ? user.name : nick;
    if (!okRoom(name) || !finalNick) { res.writeHead(400); return res.end(); }
    
    res.ip = ip; res.cid = crypto.randomUUID().slice(0, 8); res.nick = finalNick; res.reg = !!user;
    res.uid = user ? user.id : clean(url.searchParams.get('uid'), 24).replace(/[^a-zA-Z0-9]/g, '');
    res.iid = iidOf(url.searchParams.get('dk'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ history: room(name).history, you: { id: res.cid, iid: res.iid, reg: res.reg, uid: res.uid } })}\n\n`);
    room(name).clients.add(res);
    sys(name, `${finalNick} joined`);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping); room(name).clients.delete(res);
      sys(name, `${finalNick} left`);
      if (!room(name).clients.size) setTimeout(() => { if (!room(name).clients.size) rooms.delete(name); }, 600000);
    });
    return;
  }

  // ----- SEND MESSAGE (Supports both Text & Base64 Images) -----
  if (url.pathname === '/send' && req.method === 'POST') {
    return readBody(req, 2000000, body => { // Max 2MB payload
      try {
        const m = JSON.parse(body), name = String(m.room || '').toLowerCase();
        const user = getSessionUser(req);
        
        // Agar Image hai aur User Registered/LoggedIn nahi hai toh block karein
        if (m.isImage && !user) {
          return json(res, 403, { error: 'Only registered & verified users can share images.' });
        }

        let text = m.isImage ? String(m.text || '') : clean(m.text, 500);
        const nick = user ? user.name : clean(m.nick, 20);

        if (!okRoom(name) || !text || !nick) { res.writeHead(400); return res.end(); }

        const msg = { 
          id: crypto.randomUUID().slice(0, 8), 
          nick, 
          userId: user ? user.id : '',
          uid: user ? user.id : clean(m.uid, 24).replace(/[^a-zA-Z0-9]/g, ''), 
          text, 
          isImage: !!m.isImage, 
          t: Date.now() 
        };

        sent.set(msg.id, { ip, room: name, nick, text, userId: user ? user.id : '', isImage: !!m.isImage, t: msg.t });
        if (sent.size > 3000) sent.delete(sent.keys().next().value);
        
        broadcast(name, msg);
        res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  }

  res.writeHead(404); res.end('Not found');
}).listen(PORT, () => console.log('JenChat running on port ' + PORT));
