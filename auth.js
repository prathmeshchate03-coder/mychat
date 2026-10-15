'use strict';
// Accounts: register with email verification, login, password reset, signed session cookie.
// Everything is stored in the same Upstash Redis as the rest of the site. Verification mails go through a tiny
// Google Apps Script web app (see mail-relay.gs), because Render's free plan blocks normal SMTP.
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;
const EMAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const RESERVED = new Set(['admin', 'administrator', 'moderator', 'mod', 'jenchat', 'support', 'staff', 'system', 'owner', 'official', 'root', 'help', 'bot', 'security']);
const DAY = 86400000, SESSION_DAYS = 30;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const okId = s => /^[a-f0-9]{16}$/.test(String(s));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = function createAuth({ db, dbReady, mailUrl, mailSecret, mailDaily, isAcctBanned }) {
  let secret = '', initErr = '', mailToday = 0, mailErr = '';
  const MAIL_LIMIT = Math.max(1, Math.min(Number(mailDaily) || 90, 100));
  const enabled = () => !!(secret && dbReady() && mailUrl && mailSecret);

  function status() {
    const missing = [];
    if (!dbReady()) missing.push('database');
    if (!mailUrl) missing.push('MAIL_RELAY_URL');
    if (!mailSecret) missing.push('MAIL_RELAY_SECRET');
    return { enabled: enabled(), missing, mailToday, mailLimit: MAIL_LIMIT, mailError: mailErr.slice(0, 250), initError: initErr.slice(0, 200) };
  }

  // The signing secret for session cookies lives in the database, so sessions survive restarts and deploys.
  async function init() {
    try {
      await db(['SET', 'jc:secret', crypto.randomBytes(32).toString('hex'), 'NX']);
      secret = (await db(['GET', 'jc:secret'])) || '';
      initErr = secret ? '' : 'could not read the session secret';
    } catch (e) { initErr = e.message; }
    if (!secret) setTimeout(init, 30000);
  }

  // ---------- small helpers ----------
  const rl = new Map();   // rate limit buckets: key -> [timestamps]
  function limited(key, max, ms) {
    const now = Date.now(), a = (rl.get(key) || []).filter(t => now - t < ms);
    if (a.length >= max) { rl.set(key, a); return true; }
    a.push(now); rl.set(key, a); return false;
  }
  const fails = new Map();  // login key -> { n, t }
  const failed = key => { const f = fails.get(key), now = Date.now(); fails.set(key, { n: (f && now - f.t < 900000 ? f.n : 0) + 1, t: now }); };
  const locked = key => { const f = fails.get(key); return !!f && f.n >= 8 && Date.now() - f.t < 900000; };
  setInterval(() => {
    const n = Date.now();
    for (const [k, a] of rl) if (!a.some(t => n - t < DAY)) rl.delete(k);
    for (const [k, f] of fails) if (n - f.t > 900000) fails.delete(k);
  }, 60000).unref();

  function send(res, code, obj, headers) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(headers || {}) });
    res.end(JSON.stringify(obj));
  }
  function html(res, code, title, body) {
    res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)} - JenChat</title><link rel="icon" href="/logo.svg"><link rel="stylesheet" href="/style.css"></head><body>
<div class="wrap doc"><header class="top"><a class="brand" href="/"><img src="/logo.svg" alt="">Jen<span>Chat</span></a></header>
<h1>${esc(title)}</h1>${body}</div></body></html>`);
  }
  function originOk(req) {   // browsers send Origin on cross-site POSTs; refuse anything that is not our own site
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim(); } catch { return false; }
  }

  // ---------- password hashing (scrypt, no extra packages) ----------
  const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))));
  let inflight = 0;
  async function limitedHash(fn) {   // scrypt is slow on purpose, so only a few may run at once
    if (inflight >= 4) { const e = new Error('busy'); e.busy = true; throw e; }
    inflight++;
    try { return await fn(); } finally { inflight--; }
  }
  const hashPw = pw => limitedHash(async () => { const salt = crypto.randomBytes(16); return 's1$' + salt.toString('hex') + '$' + (await scrypt(pw, salt)).toString('hex'); });
  const checkPw = (pw, stored) => limitedHash(async () => {
    const [v, s, h] = String(stored).split('$');
    if (v !== 's1' || !s || !h) return false;
    const k = await scrypt(pw, Buffer.from(s, 'hex')), want = Buffer.from(h, 'hex');
    return k.length === want.length && crypto.timingSafeEqual(k, want);
  });
  let dummy = '';
  const dummyCheck = async pw => { if (!dummy) dummy = await hashPw('not-a-real-password'); await checkPw(pw, dummy); };   // same cost for unknown users

  // ---------- sessions: signed cookie, no server storage ----------
  const b64 = s => Buffer.from(s).toString('base64url');
  function signSession(u) {
    const p = b64(JSON.stringify({ i: u.id, n: u.name, e: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400 }));
    return p + '.' + crypto.createHmac('sha256', secret).update(p).digest('base64url');
  }
  function cookie(req, name) {
    for (const part of String(req.headers.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return '';
  }
  function session(req) {
    if (!secret) return null;
    const [p, sig] = cookie(req, 'jc_s').split('.');
    if (!p || !sig) return null;
    const want = crypto.createHmac('sha256', secret).update(p).digest('base64url');
    if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
    try {
      const d = JSON.parse(Buffer.from(p, 'base64url').toString());
      if (!d || !okId(d.i) || !d.n || d.e < Date.now() / 1000 || isAcctBanned(d.i)) return null;
      return { id: d.i, name: String(d.n) };
    } catch { return null; }
  }
  const cookieHeader = (req, value, maxAge) => 'jc_s=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge +
    (/https/i.test(String(req.headers['x-forwarded-proto'] || '')) || req.socket.encrypted ? '; Secure' : '');

  // ---------- users in the database ----------
  async function getUser(id) {
    if (!okId(id)) return null;
    const raw = await db(['GET', 'jc:u:' + id]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  const putUser = u => db(['SET', 'jc:u:' + u.id, JSON.stringify(u)]);
  async function purge(u) {
    await db(['DEL', 'jc:u:' + u.id]);
    await db(['DEL', 'jc:e:' + sha(u.email)]);
    await db(['DEL', 'jc:n:' + u.name.toLowerCase()]);
  }
  // Take ownership of a unique key (email or username). A half-finished signup older than a day is cleaned out of the way.
  async function claim(key, id) {
    if (await db(['SET', key, id, 'NX'])) return true;
    const other = await db(['GET', key]);
    if (other) {
      const u = await getUser(other);
      if (u && (u.ver || Date.now() - u.at <= DAY)) return false;
      if (u) await purge(u);
    }
    await db(['DEL', key]);
    return !!(await db(['SET', key, id, 'NX']));
  }

  // Guests may not use a registered username (or an official-looking one), so nobody can pose as an account holder.
  const nameCache = new Map();
  async function nameReserved(nick) {
    const l = String(nick || '').toLowerCase();
    if (RESERVED.has(l)) return true;
    if (!NAME_RE.test(String(nick)) || !enabled()) return false;
    const c = nameCache.get(l);
    if (c && Date.now() - c.t < (c.v ? 600000 : 60000)) return c.v;
    let v = false;
    try { v = !!(await db(['GET', 'jc:n:' + l])); } catch {}   // if the database hiccups, do not lock guests out
    nameCache.set(l, { v, t: Date.now() });
    if (nameCache.size > 5000) nameCache.delete(nameCache.keys().next().value);
    return v;
  }

  // ---------- mail ----------
  async function sendMail(kind, to, name, link) {
    const day = new Date().toISOString().slice(0, 10), key = 'jc:mail:' + day;
    let n;
    try { n = await db(['INCR', key]); if (n === 1) await db(['EXPIRE', key, 172800]); } catch { return { ok: false }; }
    mailToday = n;
    if (n > MAIL_LIMIT) { try { await db(['DECR', key]); } catch {} mailToday = MAIL_LIMIT; return { ok: false, budget: true }; }
    try {
      const r = await fetch(mailUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        body: JSON.stringify({ secret: mailSecret, kind, to, name, link }), signal: AbortSignal.timeout(25000) });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch {}
      if (j && j.ok) { mailErr = ''; return { ok: true }; }
      mailErr = j && j.error ? 'the mail relay said: ' + j.error : 'the mail relay gave an unexpected reply (HTTP ' + r.status + '). Check that the web app is deployed with access set to Anyone.';
    } catch (e) { mailErr = 'cannot reach the mail relay: ' + e.message; }
    try { await db(['DECR', key]); mailToday = Math.max(0, mailToday - 1); } catch {}
    return { ok: false };
  }
  async function newToken(userId, kind, seconds) {
    const t = crypto.randomBytes(24).toString('hex');
    await db(['SET', 'jc:v:' + sha(t), JSON.stringify({ i: userId, k: kind }), 'EX', seconds]);
    return t;
  }

  // ---------- endpoints (each returns [status, body, headers]) ----------
  const unavailable = () => [503, { error: 'unavailable' }];

  async function register(b, ip, base) {
    if (!enabled()) return unavailable();
    if (limited('reg:' + ip, 3, 3600000) || limited('regd:' + ip, 8, DAY)) return [429, { error: 'rate' }];
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!EMAIL_RE.test(email) || email.length > 254) return [400, { error: 'bad_email' }];
    if (!NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) return [400, { error: 'bad_name' }];
    if (pw.length < 8 || pw.length > 72) return [400, { error: 'bad_password' }];
    if (b.age !== true) return [400, { error: 'no_age' }];
    const user = { id: crypto.randomBytes(8).toString('hex'), email, name, ph: await hashPw(pw), ver: false, at: Date.now() };
    const ek = 'jc:e:' + sha(email), nk = 'jc:n:' + name.toLowerCase();
    if (!(await claim(ek, user.id))) return [409, { error: 'email_taken' }];
    if (!(await claim(nk, user.id))) { await db(['DEL', ek]); return [409, { error: 'name_taken' }]; }
    let token = '';
    try {
      await putUser(user);
      token = await newToken(user.id, 'verify', 86400);
      const m = await sendMail('verify', email, name, base + '/verify?t=' + token);
      if (!m.ok) throw Object.assign(new Error('mail'), { budget: !!m.budget });
    } catch (e) {
      await purge(user).catch(() => {});
      if (token) await db(['DEL', 'jc:v:' + sha(token)]).catch(() => {});
      return e.message === 'mail' ? [e.budget ? 503 : 502, { error: e.budget ? 'mail_budget' : 'mail_failed' }] : [500, { error: 'server' }];
    }
    nameCache.set(name.toLowerCase(), { v: true, t: Date.now() });
    return [200, { ok: true }];
  }

  async function checkLogin(b, ip, scope) {   // shared by login and resend. Returns { user } or { fail: [status, body] }
    if (limited(scope + ':' + ip, 15, 900000)) return { fail: [429, { error: 'rate' }] };
    const idf = String(b.login || '').trim(), pw = String(b.password || '');
    if (!idf || !pw || pw.length > 72 || idf.length > 254) return { fail: [401, { error: 'bad_login' }] };
    const key = idf.includes('@') ? 'jc:e:' + sha(idf.toLowerCase()) : 'jc:n:' + idf.toLowerCase();
    if (locked(key)) return { fail: [429, { error: 'locked' }] };
    const id = await db(['GET', key]), u = id ? await getUser(id) : null;
    if (!u) { await dummyCheck(pw); failed(key); return { fail: [401, { error: 'bad_login' }] }; }
    if (!(await checkPw(pw, u.ph))) { failed(key); return { fail: [401, { error: 'bad_login' }] }; }
    fails.delete(key);
    return { user: u };
  }

  async function login(b, ip, base, req) {
    if (!enabled()) return unavailable();
    const r = await checkLogin(b, ip, 'login');
    if (r.fail) return r.fail;
    if (!r.user.ver) return [403, { error: 'unverified' }];
    if (isAcctBanned(r.user.id)) return [403, { error: 'banned' }];
    return [200, { ok: true, name: r.user.name }, { 'Set-Cookie': cookieHeader(req, signSession(r.user), SESSION_DAYS * 86400) }];
  }

  async function resend(b, ip, base) {
    if (!enabled()) return unavailable();
    const r = await checkLogin(b, ip, 'resend');
    if (r.fail) return r.fail;
    if (r.user.ver) return [200, { ok: true, already: true }];
    if (limited('rs:' + r.user.id, 1, 600000)) return [429, { error: 'rate' }];
    const t = await newToken(r.user.id, 'verify', 86400);
    const m = await sendMail('verify', r.user.email, r.user.name, base + '/verify?t=' + t);
    if (!m.ok) { await db(['DEL', 'jc:v:' + sha(t)]).catch(() => {}); return [m.budget ? 503 : 502, { error: m.budget ? 'mail_budget' : 'mail_failed' }]; }
    return [200, { ok: true }];
  }

  async function forgot(b, ip, base) {
    if (!enabled()) return unavailable();
    if (limited('fg:' + ip, 5, 3600000)) return [429, { error: 'rate' }];
    const email = String(b.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return [200, { ok: true }];   // always the same answer: nobody can probe which emails exist
    if (limited('fge:' + sha(email), 3, DAY)) return [200, { ok: true }];
    (async () => {   // the mail is sent after we have already replied, so the reply time reveals nothing
      try {
        const id = await db(['GET', 'jc:e:' + sha(email)]), u = id ? await getUser(id) : null;
        if (u && u.ver) { const t = await newToken(u.id, 'reset', 3600); await sendMail('reset', u.email, u.name, base + '/reset?t=' + t); }
      } catch {}
    })();
    return [200, { ok: true }];
  }

  async function reset(b, ip) {
    if (!enabled()) return unavailable();
    if (limited('rst:' + ip, 10, 3600000)) return [429, { error: 'rate' }];
    const t = String(b.t || ''), pw = String(b.password || '');
    if (pw.length < 8 || pw.length > 72) return [400, { error: 'bad_password' }];
    if (!/^[a-f0-9]{48}$/.test(t)) return [400, { error: 'bad_token' }];
    const raw = await db(['GET', 'jc:v:' + sha(t)]);
    let rec = null; try { rec = raw && JSON.parse(raw); } catch {}
    const u = rec && rec.k === 'reset' ? await getUser(rec.i) : null;
    if (!u) return [400, { error: 'bad_token' }];
    u.ph = await hashPw(pw);
    await putUser(u);
    await db(['DEL', 'jc:v:' + sha(t)]);
    fails.delete('jc:e:' + sha(u.email)); fails.delete('jc:n:' + u.name.toLowerCase());
    return [200, { ok: true }];
  }

  async function logout(b, ip, base, req) { return [200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) }]; }

  // ---------- pages opened from the mails ----------
  async function verifyPage(req, res, url, ip) {
    const bad = () => html(res, 400, 'Link not valid', '<p class="lead">This link has expired or was already used.</p><p>Open the <a href="/chat">chat page</a>, log in with your password and we can send a new link.</p>');
    if (limited('ver:' + ip, 30, 3600000)) return html(res, 429, 'Too many tries', '<p>Please wait a while and try again.</p>');
    if (!enabled()) return html(res, 503, 'Not available', '<p>Accounts are not available right now. Please try again later.</p>');
    const t = String(url.searchParams.get('t') || '');
    if (!/^[a-f0-9]{48}$/.test(t)) return bad();
    const raw = await db(['GET', 'jc:v:' + sha(t)]);
    let rec = null; try { rec = raw && JSON.parse(raw); } catch {}
    const u = rec && rec.k === 'verify' ? await getUser(rec.i) : null;
    if (!u) return bad();
    if (!u.ver) { u.ver = true; await putUser(u); }
    await db(['DEL', 'jc:v:' + sha(t)]);
    nameCache.set(u.name.toLowerCase(), { v: true, t: Date.now() });
    html(res, 200, 'Email verified', `<p class="lead">Your account <b>${esc(u.name)}</b> is now permanent.</p><p><a class="btn" href="/chat">Open the chat and log in</a></p>`);
  }
  function resetPage(res) {
    html(res, 200, 'Choose a new password', `<form id="f" style="max-width:360px"><p><input type="password" id="p" autocomplete="new-password" minlength="8" maxlength="72" placeholder="New password (8 or more characters)" aria-label="New password" required></p>
<p><button>Save password</button></p></form><p id="m" role="alert"></p>
<script>document.getElementById('f').onsubmit=function(e){e.preventDefault();var m=document.getElementById('m');m.textContent='';
fetch('/auth/reset',{method:'POST',body:JSON.stringify({t:new URLSearchParams(location.search).get('t'),password:document.getElementById('p').value})}).then(function(r){return r.json()}).then(function(j){
if(j.ok){document.getElementById('f').hidden=true;m.innerHTML='Password changed. <a href="/chat">Open the chat and log in</a>.'}
else m.textContent=j.error==='bad_password'?'Use 8 to 72 characters.':j.error==='bad_token'?'This link has expired or was already used.':'Something went wrong. Try again later.'}).catch(function(){m.textContent='Network problem. Try again.'})}</script>`);
  }

  // ---------- routing ----------
  const posts = { '/auth/register': register, '/auth/login': login, '/auth/logout': logout, '/auth/resend': resend, '/auth/forgot': forgot, '/auth/reset': reset };
  function handle(req, res, url, ip, base, readBody) {
    const p = url.pathname;
    if (req.method === 'GET') {
      if (p === '/auth/me') { const s = session(req); send(res, 200, { enabled: enabled(), user: s ? { name: s.name, uid: 'a' + s.id } : null }); return true; }
      if (p === '/auth/name') {
        if (limited('nm:' + ip, 30, 60000)) { send(res, 429, { error: 'rate' }); return true; }
        nameReserved(url.searchParams.get('n')).then(taken => send(res, 200, { taken }), () => send(res, 200, { taken: false }));
        return true;
      }
      if (p === '/verify') { verifyPage(req, res, url, ip).catch(e => { console.error('AUTH verify', e.message); html(res, 500, 'Error', '<p>Something went wrong. Please try again.</p>'); }); return true; }
      if (p === '/reset') { resetPage(res); return true; }
      return false;
    }
    if (req.method === 'POST' && posts[p]) {
      if (!originOk(req)) { send(res, 403, { error: 'origin' }); return true; }
      readBody(req, 2000, async body => {
        try {
          const [code, obj, headers] = await posts[p](JSON.parse(body), ip, base, req);
          send(res, code, obj, headers);
        } catch (e) {
          if (e && e.busy) send(res, 503, { error: 'busy' });
          else if (e instanceof SyntaxError) send(res, 400, { error: 'bad_request' });
          else { console.error('AUTH', p, e && e.message); send(res, 500, { error: 'server' }); }
        }
      });
      return true;
    }
    return false;
  }

  return { init, enabled, status, handle, session, nameReserved, originOk };
};
