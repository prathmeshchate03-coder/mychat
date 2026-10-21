'use strict';
// Image sharing. Only logged-in (email verified) accounts may upload.
// The browser shrinks every picture to a JPEG; the server then checks it again and strips all camera/location data
// (EXIF and every other metadata block), so even a hand-made upload cannot carry GPS data. Pictures are kept in the
// Upstash database for a week. The sender can delete a picture at any time. A picture that somebody reports is copied
// to a separate "evidence" key for 14 days, so a sender cannot delete it to escape a moderator.
const crypto = require('crypto');

// Keeps only what is needed to draw the picture. Drops EXIF/GPS (APP1), ICC, comments and every other APPn block
// except APP0 (JFIF) and APP14 (Adobe), and throws away anything after the end-of-image marker.
// Returns null when the file is not a well-formed JPEG.
function stripJpeg(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out = [b.subarray(0, 2)]; let i = 2, scan = false;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }                                   // fill byte
    if (m === 0x00 || m === 0xd8) return null;
    if (m === 0xd9) { out.push(b.subarray(i, i + 2)); return scan ? Buffer.concat(out) : null; }   // EOI: nothing after it is kept
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }   // markers without a length
    if (i + 4 > b.length) return null;
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = m === 0xfe || (m >= 0xe1 && m <= 0xef && m !== 0xee);
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
    if (m === 0xda) {                                                    // entropy-coded data runs up to the next real marker
      scan = true; let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !(b[j + 1] >= 0xd0 && b[j + 1] <= 0xd7))) j++;
      if (j + 1 >= b.length) return null;
      out.push(b.subarray(i, j)); i = j;
    }
  }
  return null;
}

// Stickers are PNG or WebP (they can be see-through). Same idea as above: keep only what is needed to draw the picture.
function stripPng(b) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!b || b.length < 60 || !b.subarray(0, 8).equals(SIG)) return null;
  const out = [SIG]; let i = 8, first = true, idat = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8), end = i + 12 + len;
    if (len > 0x7fffffff || end > b.length) return null;
    if (first) { if (type !== 'IHDR' || len !== 13) return null; const w = b.readUInt32BE(i + 8), h = b.readUInt32BE(i + 12); if (w < 16 || h < 16 || w > 512 || h > 512) return null; first = false; }
    if (type === 'IHDR' || type === 'PLTE' || type === 'tRNS' || type === 'IDAT' || type === 'IEND') out.push(b.subarray(i, end));
    if (type === 'IDAT') idat = true;
    if (type === 'IEND') return idat ? Buffer.concat(out) : null;
    i = end;
  }
  return null;
}
function stripWebp(b) {
  if (!b || b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const total = b.readUInt32LE(4) + 8; if (total > b.length) return null;
  const chunks = []; let i = 12, image = false;
  while (i + 8 <= total) {
    const type = b.toString('latin1', i, i + 4), len = b.readUInt32LE(i + 4), end = i + 8 + len + (len & 1);
    if (end > total + 1 || i + 8 + len > total) return null;
    if (type === 'ANIM' || type === 'ANMF') return null;               // no animations
    if (type === 'VP8 ' || type === 'VP8L' || type === 'ALPH') { chunks.push(b.subarray(i, end)); if (type !== 'ALPH') image = true; }
    else if (type === 'VP8X' && len === 10) { const c = Buffer.from(b.subarray(i, i + 18)); c[8] &= ~(0x20 | 0x08 | 0x04 | 0x02); chunks.push(c); }   // flags: no ICC, EXIF, XMP, animation
    i = end;
  }
  if (!image) return null;
  const body = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
const kindOf = b => b[0] === 0x89 ? 'image/png' : b[0] === 0x52 ? 'image/webp' : 'image/jpeg';

module.exports = function createImages({ db, dbReady, session, isBanned, budgetMB, ttlDays }) {
  const MAX = 300 * 1024, STK_MAX = 150 * 1024, TTL = (ttlDays || 7) * 86400, BUDGET = (budgetMB || 200) * 1048576, EVIDENCE_TTL = 14 * 86400;
  const cache = new Map(); let cacheBytes = 0; const CACHE_MAX = 24 * 1024 * 1024;   // recently viewed pictures stay in memory
  const owner = new Map();    // image id -> { u: account id, t }  so /send can check that the sender uploaded the picture
  const gone = new Set();     // removed (by the sender or a moderator)
  const rate = new Map();
  let lastErr = '', used = 0, usedAt = 0, added = 0;
  const okId = s => /^[a-f0-9]{32}$/.test(String(s));

  const dayKey = ms => 'jc:ib:' + new Date(ms).toISOString().slice(0, 10);
  async function usedBytes() {   // bytes stored in the last 7 days, counted per day so old pictures drop out by themselves
    if (Date.now() - usedAt < 60000) return used + added;
    const keys = [];
    for (let i = 0; i < 7; i++) keys.push(dayKey(Date.now() - i * 86400000));
    const vals = await db(['MGET', ...keys]);
    used = (vals || []).reduce((a, v) => a + (Number(v) || 0), 0); added = 0; usedAt = Date.now();
    return used;
  }
  function limited(key, max, ms) {
    const now = Date.now(), a = (rate.get(key) || []).filter(t => now - t < ms);
    if (a.length >= max) { rate.set(key, a); return true; }
    a.push(now); rate.set(key, a); return false;
  }
  function remember(id, buf) {
    if (cache.has(id)) return;
    cache.set(id, buf); cacheBytes += buf.length;
    while (cacheBytes > CACHE_MAX && cache.size) { const k = cache.keys().next().value; cacheBytes -= cache.get(k).length; cache.delete(k); }
  }
  const shape = (b, min) => b.length > min && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
  const owns = (id, uid) => { const o = owner.get(String(id)); return !!o && o.u === uid && Date.now() - o.t < 86400000; };

  function status() {
    return { usedMB: Math.round((used + added) / 104857.6) / 10, budgetMB: Math.round(BUDGET / 1048576), error: lastErr.slice(0, 200) };
  }

  // POST /img with the JPEG as the request body
  function upload(req, res, ip, json, readBuf, sticker) {   // sticker: true for POST /st (PNG or WebP), false for POST /img (JPEG)
    const user = session(req);
    if (!user) return json(res, 401, { error: 'login' });
    if (isBanned(ip)) return json(res, 403, { error: 'banned' });
    if (!dbReady()) return json(res, 503, { error: 'unavailable' });
    const LIM = sticker ? STK_MAX : MAX;
    if (Number(req.headers['content-length'] || 0) > LIM) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'too_big' }); }
    if (limited('m:' + user.id, 6, 60000) || limited('d:' + user.id, 40, 86400000)) return json(res, 429, { error: 'rate' });
    readBuf(req, res, LIM, async raw => {
      try {
        let buf;
        if (sticker) {
          if (!raw || raw.length < 100) return json(res, 400, { error: 'bad_image' });
          buf = raw[0] === 0x89 ? stripPng(raw) : raw[0] === 0x52 ? stripWebp(raw) : null;
          if (!buf) return json(res, 400, { error: 'bad_image' });
        } else {
          if (!raw || raw.length < 1000 || raw[0] !== 0xff || raw[1] !== 0xd8 || raw[2] !== 0xff) return json(res, 400, { error: 'bad_image' });
          buf = stripJpeg(raw);                                          // metadata and trailing data are removed here
          if (!buf || !shape(buf, 200)) return json(res, 400, { error: 'bad_image' });
        }
        if ((await usedBytes()) + buf.length > BUDGET) { lastErr = 'image storage budget is full'; return json(res, 503, { error: 'full' }); }
        const id = crypto.randomBytes(16).toString('hex');
        await db(['SET', 'jc:img:' + id, JSON.stringify({ u: user.id, n: user.name, ip, t: Date.now(), d: buf.toString('base64') }), 'EX', TTL], 25000);
        await db(['SET', 'jc:imm:' + id, user.id, 'EX', TTL]);           // small ownership note, so the sender can delete it even after a restart
        owner.set(id, { u: user.id, t: Date.now(), s: !!sticker }); remember(id, buf); added += buf.length; lastErr = '';
        db(['INCRBY', dayKey(Date.now()), buf.length]).then(() => db(['EXPIRE', dayKey(Date.now()), 8 * 86400])).catch(() => {});
        db(['SADD', 'jc:iu:' + user.id, id]).then(() => db(['EXPIRE', 'jc:iu:' + user.id, 8 * 86400])).catch(() => {});   // list per account, for bans
        json(res, 200, { id });
      } catch (e) { lastErr = e.message; console.error('IMG upload', e.message); json(res, 503, { error: 'unavailable' }); }
    });
  }

  // GET /img/<32 hex>. The address is long and random, so only people who saw the message can know it.
  async function serve(req, res, id) {
    const notFound = () => { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); };
    if (gone.has(id)) return notFound();
    let buf = cache.get(id);
    if (!buf) {
      if (!dbReady()) { res.writeHead(503); return res.end(); }
      const raw = await db(['GET', 'jc:img:' + id], 25000);
      if (!raw) return notFound();
      buf = Buffer.from(JSON.parse(raw).d, 'base64'); remember(id, buf);
    }
    res.writeHead(200, { 'Content-Type': kindOf(buf), 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin', 'X-Robots-Tag': 'noindex' });
    res.end(buf);
  }

  // Who uploaded this picture? Memory first, then the small ownership note in the database. '' when unknown or expired.
  async function ownerOf(id) {
    if (!okId(id)) return '';
    const o = owner.get(id); if (o) return o.u;
    if (!dbReady()) return '';
    return String((await db(['GET', 'jc:imm:' + id])) || '');
  }
  const isSticker = id => { const o = owner.get(String(id)); return !!o && !!o.s; };
  const deleteLimited = uid => limited('x:' + uid, 30, 60000);

  // A picture was reported: keep a copy for moderators for 14 days, even if the sender deletes it afterwards.
  async function keep(id) {
    if (!okId(id) || !dbReady()) return;
    const raw = await db(['GET', 'jc:img:' + id], 25000);
    if (raw) await db(['SET', 'jc:ev:' + id, raw, 'EX', EVIDENCE_TTL], 25000);
  }
  async function read(id) {   // for the admin page: the picture (or its evidence copy) and who sent it
    let raw = await db(['GET', 'jc:img:' + id], 25000);
    if (!raw) raw = await db(['GET', 'jc:ev:' + id], 25000);
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return { buf: Buffer.from(rec.d, 'base64'), meta: { u: rec.u, n: rec.n, ip: rec.ip, t: rec.t } };
  }
  // keepEvidence: true when the sender deleted it (a moderator's copy of a reported picture stays), false when a moderator did.
  async function remove(id, keepEvidence) {
    gone.add(id); if (gone.size > 5000) gone.delete(gone.keys().next().value);
    if (cache.has(id)) { cacheBytes -= cache.get(id).length; cache.delete(id); }
    owner.delete(id);
    const jobs = [db(['DEL', 'jc:img:' + id]), db(['DEL', 'jc:imm:' + id])];
    if (!keepEvidence) jobs.push(db(['DEL', 'jc:ev:' + id]));
    await Promise.all(jobs);
  }
  async function idsByUser(uid) {   // every picture this account uploaded in the last week
    const ids = new Set([...owner].filter(([, o]) => o.u === uid).map(([id]) => id));
    try { for (const id of (await db(['SMEMBERS', 'jc:iu:' + uid])) || []) if (okId(id)) ids.add(id); } catch {}
    return [...ids];
  }

  setInterval(() => {
    const n = Date.now();
    for (const [k, o] of owner) if (n - o.t > 7 * 86400000) owner.delete(k);
    for (const [k, a] of rate) if (!a.some(t => n - t < 86400000)) rate.delete(k);
  }, 600000).unref();

  return { upload, serve, read, remove, keep, ownerOf, idsByUser, deleteLimited, owns, isSticker, kindOf, status, stripJpeg };
};
