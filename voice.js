'use strict';
// Voice notes. Like pictures: only logged-in (email verified) accounts may send them, they are stored in the Upstash
// database for 3 days, the sender can delete them any time, and a reported one is copied to a 14 day evidence key.
// Clips are at most 30 seconds (about 100 KB), recorded by the browser as webm/opus, ogg/opus or mp4/aac.
const crypto = require('crypto');

function kind(b) {   // what is this file really? (the first bytes decide, never the name or the content-type header)
  if (!b || b.length < 12) return '';
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  return '';
}

module.exports = function createVoice({ db, dbReady, session, isBanned, budgetMB, ttlDays }) {
  const MAX = 160 * 1024, TTL = (ttlDays || 3) * 86400, BUDGET = (budgetMB || 50) * 1048576, EVIDENCE_TTL = 14 * 86400;
  const cache = new Map(); let cacheBytes = 0; const CACHE_MAX = 8 * 1024 * 1024;
  const owner = new Map(), gone = new Set(), rate = new Map();
  let lastErr = '', used = 0, usedAt = 0, added = 0;
  const okId = s => /^[a-f0-9]{32}$/.test(String(s));
  const dayKey = ms => 'jc:vb:' + new Date(ms).toISOString().slice(0, 10);
  async function usedBytes() {
    if (Date.now() - usedAt < 60000) return used + added;
    const keys = []; for (let i = 0; i < 4; i++) keys.push(dayKey(Date.now() - i * 86400000));
    const vals = await db(['MGET', ...keys]);
    used = (vals || []).reduce((a, v) => a + (Number(v) || 0), 0); added = 0; usedAt = Date.now();
    return used;
  }
  function limited(key, max, ms) {
    const now = Date.now(), a = (rate.get(key) || []).filter(t => now - t < ms);
    if (a.length >= max) { rate.set(key, a); return true; }
    a.push(now); rate.set(key, a); return false;
  }
  function remember(id, rec) {
    if (cache.has(id)) return;
    cache.set(id, rec); cacheBytes += rec.buf.length;
    while (cacheBytes > CACHE_MAX && cache.size) { const k = cache.keys().next().value; cacheBytes -= cache.get(k).buf.length; cache.delete(k); }
  }
  const owns = (id, uid) => { const o = owner.get(String(id)); return !!o && o.u === uid && Date.now() - o.t < 86400000; };
  const status = () => ({ usedMB: Math.round((used + added) / 104857.6) / 10, budgetMB: Math.round(BUDGET / 1048576), error: lastErr.slice(0, 200) });

  // POST /vn with the audio as the request body and the length in seconds in the x-dur header
  function upload(req, res, ip, json, readBuf) {
    const user = session(req);
    if (!user) return json(res, 401, { error: 'login' });
    if (isBanned(ip)) return json(res, 403, { error: 'banned' });
    if (!dbReady()) return json(res, 503, { error: 'unavailable' });
    if (Number(req.headers['content-length'] || 0) > MAX) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'too_big' }); }
    if (limited('m:' + user.id, 6, 60000) || limited('d:' + user.id, 60, 86400000)) return json(res, 429, { error: 'rate' });
    const dur = Math.max(1, Math.min(30, Math.round(Number(req.headers['x-dur']) || 0)));
    readBuf(req, res, MAX, async buf => {
      try {
        const mime = kind(buf);
        if (!mime || buf.length < 600) return json(res, 400, { error: 'bad_audio' });
        if ((await usedBytes()) + buf.length > BUDGET) { lastErr = 'voice storage budget is full'; return json(res, 503, { error: 'full' }); }
        const id = crypto.randomBytes(16).toString('hex');
        await db(['SET', 'jc:vn:' + id, JSON.stringify({ u: user.id, n: user.name, ip, t: Date.now(), m: mime, s: dur, d: buf.toString('base64') }), 'EX', TTL], 25000);
        await db(['SET', 'jc:vnm:' + id, user.id, 'EX', TTL]);
        owner.set(id, { u: user.id, t: Date.now() }); remember(id, { buf, mime }); added += buf.length; lastErr = '';
        db(['INCRBY', dayKey(Date.now()), buf.length]).then(() => db(['EXPIRE', dayKey(Date.now()), 5 * 86400])).catch(() => {});
        db(['SADD', 'jc:vu:' + user.id, id]).then(() => db(['EXPIRE', 'jc:vu:' + user.id, 5 * 86400])).catch(() => {});
        json(res, 200, { id, dur });
      } catch (e) { lastErr = e.message; console.error('VN upload', e.message); json(res, 503, { error: 'unavailable' }); }
    });
  }

  // GET /vn/<32 hex>. Supports Range requests, which Safari needs to play audio.
  async function serve(req, res, id) {
    const notFound = () => { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); };
    if (gone.has(id)) return notFound();
    let rec = cache.get(id);
    if (!rec) {
      if (!dbReady()) { res.writeHead(503); return res.end(); }
      const raw = await db(['GET', 'jc:vn:' + id], 25000);
      if (!raw) return notFound();
      const j = JSON.parse(raw); rec = { buf: Buffer.from(j.d, 'base64'), mime: j.m }; remember(id, rec);
    }
    const { buf, mime } = rec, size = buf.length;
    const h = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Robots-Tag': 'noindex' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
    if (m && (m[1] || m[2])) {
      let a = m[1] ? Number(m[1]) : size - Number(m[2]), b = m[1] && m[2] ? Number(m[2]) : size - 1;
      if (a < 0) a = 0; if (b >= size) b = size - 1;
      if (a > b || a >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
      res.writeHead(206, { ...h, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      return res.end(buf.subarray(a, b + 1));
    }
    res.writeHead(200, { ...h, 'Content-Length': size });
    res.end(buf);
  }

  async function ownerOf(id) {
    if (!okId(id)) return '';
    const o = owner.get(id); if (o) return o.u;
    if (!dbReady()) return '';
    return String((await db(['GET', 'jc:vnm:' + id])) || '');
  }
  const deleteLimited = uid => limited('x:' + uid, 30, 60000);
  async function keep(id) {
    if (!okId(id) || !dbReady()) return;
    const raw = await db(['GET', 'jc:vn:' + id], 25000);
    if (raw) await db(['SET', 'jc:vev:' + id, raw, 'EX', EVIDENCE_TTL], 25000);
  }
  async function read(id) {   // for the admin page
    let raw = await db(['GET', 'jc:vn:' + id], 25000);
    if (!raw) raw = await db(['GET', 'jc:vev:' + id], 25000);
    if (!raw) return null;
    const j = JSON.parse(raw);
    return { buf: Buffer.from(j.d, 'base64'), mime: j.m, meta: { u: j.u, n: j.n, ip: j.ip, t: j.t } };
  }
  async function remove(id, keepEvidence) {
    gone.add(id); if (gone.size > 5000) gone.delete(gone.keys().next().value);
    if (cache.has(id)) { cacheBytes -= cache.get(id).buf.length; cache.delete(id); }
    owner.delete(id);
    const jobs = [db(['DEL', 'jc:vn:' + id]), db(['DEL', 'jc:vnm:' + id])];
    if (!keepEvidence) jobs.push(db(['DEL', 'jc:vev:' + id]));
    await Promise.all(jobs);
  }
  async function idsByUser(uid) {
    const ids = new Set([...owner].filter(([, o]) => o.u === uid).map(([id]) => id));
    try { for (const id of (await db(['SMEMBERS', 'jc:vu:' + uid])) || []) if (okId(id)) ids.add(id); } catch {}
    return [...ids];
  }
  setInterval(() => {
    const n = Date.now();
    for (const [k, o] of owner) if (n - o.t > 3 * 86400000) owner.delete(k);
    for (const [k, a] of rate) if (!a.some(t => n - t < 86400000)) rate.delete(k);
  }, 600000).unref();
  return { upload, serve, read, remove, keep, ownerOf, idsByUser, deleteLimited, owns, status, kind };
};
