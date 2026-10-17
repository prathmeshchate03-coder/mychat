'use strict';
// Accounts only: "My rooms" (subscriptions) and friends. Saved in the database, so they follow the account to any device.
//   jc:subs:<account>  JSON list of room names (max 50)
//   jc:fr:<account>    JSON { f: friends, i: requests received, o: requests sent }, each { accountId: name } (max 100 / 50 / 50)
module.exports = function createSocial({ db, dbReady, session, originOk, liveByAcct, blockedBy, acctIid, rooms, closed, okRoom, json, readBody, limited }) {
  const okId = s => /^[a-f0-9]{16}$/.test(String(s || ''));
  const locks = new Map();
  function withLock(key, fn) {   // one change at a time per key, so two quick taps cannot overwrite each other
    const run = (locks.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }
  const names = o => { const out = {}; if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (okId(k) && typeof v === 'string') out[k] = v.slice(0, 20); return out; };
  async function getSubs(id) { try { const r = await db(['GET', 'jc:subs:' + id]); const a = r ? JSON.parse(r) : []; return Array.isArray(a) ? a.filter(x => typeof x === 'string' && okRoom(x)).slice(0, 50) : []; } catch { return []; } }
  async function getFr(id) {
    const r = await db(['GET', 'jc:fr:' + id]); let d = {}; try { d = r ? JSON.parse(r) : {}; } catch {}
    return { f: names(d.f), i: names(d.i), o: names(d.o) };
  }
  const setFr = (id, d) => db(['SET', 'jc:fr:' + id, JSON.stringify(d)]);
  const push = (id, ev) => { const s = `data: ${JSON.stringify({ friend: ev })}\n\n`; for (const c of liveByAcct(id)) c.write(s); };
  const count = o => Object.keys(o).length;

  function handle(req, res, url, ip) {
    const user = session(req), p = url.pathname;
    if (!user) return json(res, 401, { error: 'login' });
    if (!dbReady()) return json(res, 503, { error: 'unavailable' });
    if (req.method === 'GET' && p === '/subs') {
      return getSubs(user.id).then(list => json(res, 200, { rooms: list.map(name => {
        const r = rooms.get(name);
        return { name, online: r ? r.clients.size : 0, topic: r && r.about ? r.about.topic : '', closed: closed.has(name) };
      }) })).catch(() => json(res, 503, { error: 'unavailable' }));
    }
    if (req.method === 'GET' && p === '/friends') {
      return getFr(user.id).then(d => {
        const online = id => liveByAcct(id).length > 0;
        json(res, 200, {
          friends: Object.entries(d.f).map(([id, name]) => ({ id, name, online: online(id), iid: acctIid(id), uid: 'a' + id })),
          incoming: Object.entries(d.i).map(([id, name]) => ({ id, name })),
          outgoing: Object.entries(d.o).map(([id, name]) => ({ id, name })),
        });
      }).catch(() => json(res, 503, { error: 'unavailable' }));
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method' });
    if (!originOk(req)) return json(res, 403, { error: 'origin' });
    if (limited(ip)) return json(res, 429, { error: 'slow down' });
    return readBody(req, 600, body => {
      let m; try { m = JSON.parse(body); } catch { return json(res, 400, { error: 'bad request' }); }
      if (p === '/subs') {
        const name = String(m.room || '').toLowerCase();
        if (!okRoom(name)) return json(res, 400, { error: 'bad request' });
        return withLock('s' + user.id, async () => {
          const list = await getSubs(user.id), has = list.includes(name);
          if (m.on && !has) { if (list.length >= 50) return json(res, 400, { error: 'full' }); list.push(name); }
          else if (!m.on && has) list.splice(list.indexOf(name), 1);
          await db(['SET', 'jc:subs:' + user.id, JSON.stringify(list)]);
          json(res, 200, { ok: true, on: list.includes(name) });
        }).catch(() => json(res, 503, { error: 'unavailable' }));
      }
      // p === '/friends'
      const action = String(m.action || ''), id = String(m.id || '');
      if (!okId(id) || id === user.id || !['request', 'accept', 'decline', 'cancel', 'remove'].includes(action)) return json(res, 400, { error: 'bad request' });
      const lockKey = 'f' + [user.id, id].sort().join(':');
      return withLock(lockKey, async () => {
        const me = await getFr(user.id), them = await getFr(id);
        if (action === 'request') {
          if (me.f[id]) return json(res, 200, { ok: true, state: 'friends' });
          const theirNow = liveByAcct(id)[0];
          if (me.i[id]) return accept();                                   // they had already asked us: that is a yes
          const name = me.o[id] || (theirNow && theirNow.nick);
          if (!name) return json(res, 404, { error: 'offline' });             // we only learn a name while the person is in a room
          if (blockedBy(acctIid(id), acctIid(user.id))) return json(res, 200, { ok: true, state: 'sent' });   // blocked: looks like it was sent
          if (!me.o[id] && count(me.o) >= 50) return json(res, 400, { error: 'full' });
          if (count(them.i) >= 50 && !them.i[user.id]) return json(res, 200, { ok: true, state: 'sent' });
          me.o[id] = name; them.i[user.id] = user.name;
          await Promise.all([setFr(user.id, me), setFr(id, them)]);
          push(id, { t: 'request', id: user.id, name: user.name });
          return json(res, 200, { ok: true, state: 'sent' });
        }
        async function accept() {
          const name = me.i[id] || them.o[user.id];
          if (!name) return json(res, 404, { error: 'none' });
          if (count(me.f) >= 100 || count(them.f) >= 100) return json(res, 400, { error: 'full' });
          me.f[id] = name; them.f[user.id] = user.name; delete me.i[id]; delete me.o[id]; delete them.o[user.id]; delete them.i[user.id];
          await Promise.all([setFr(user.id, me), setFr(id, them)]);
          push(id, { t: 'accepted', id: user.id, name: user.name });
          return json(res, 200, { ok: true, state: 'friends' });
        }
        if (action === 'accept') return accept();
        if (action === 'decline') { delete me.i[id]; delete them.o[user.id]; }
        else if (action === 'cancel') { delete me.o[id]; delete them.i[user.id]; }
        else if (action === 'remove') { delete me.f[id]; delete them.f[user.id]; }
        await Promise.all([setFr(user.id, me), setFr(id, them)]);
        if (action === 'remove') push(id, { t: 'removed', id: user.id });
        json(res, 200, { ok: true });
      }).catch(() => json(res, 503, { error: 'unavailable' }));
    });
  }
  return { handle };
};
