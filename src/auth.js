// Passkey（WebAuthn）登入：只支援 ES256，要求生物辨識（user verification）。
const PEOPLE = ['羿勳', '宇茹'];
const SESSION_MS = 30 * 24 * 3600e3;
const enc = new TextEncoder();

const b64u = (buf) => {
  let s = '';
  for (const c of new Uint8Array(buf)) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64u = (s) => {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
const sha256hex = async (s) => [...(await sha256(s))].map((x) => x.toString(16).padStart(2, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const json = (o, status = 200, headers = {}) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

function derToRaw(der) {
  let o = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const rl = der[o + 1]; const r = der.slice(o + 2, o + 2 + rl); o += 2 + rl;
  const sl = der[o + 1]; const s = der.slice(o + 2, o + 2 + sl);
  const fix = (x) => { while (x.length > 32 && x[0] === 0) x = x.slice(1); const out = new Uint8Array(32); out.set(x, 32 - x.length); return out; };
  const raw = new Uint8Array(64); raw.set(fix(r), 0); raw.set(fix(s), 32);
  return raw;
}

function cookieValue(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}

async function startSession(db, user, url) {
  const token = rand(32);
  const now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
    db.prepare('INSERT INTO sessions (token, user, expires) VALUES (?, ?, ?)').bind(await sha256hex(token), user, now + SESSION_MS),
  ]);
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`;
}

export async function getUser(request, db) {
  const sid = cookieValue(request, 'sid');
  if (!sid) return null;
  const row = await db.prepare('SELECT user FROM sessions WHERE token = ? AND expires > ?').bind(await sha256hex(sid), Date.now()).first();
  return row ? row.user : null;
}

async function newChallenge(db, purpose, ref) {
  const id = rand(16), value = rand(32), now = Date.now();
  await db.batch([
    db.prepare('DELETE FROM challenges WHERE expires < ?').bind(now),
    db.prepare('INSERT INTO challenges (id, value, purpose, ref, expires) VALUES (?, ?, ?, ?, ?)').bind(id, value, purpose, ref || null, now + 5 * 60e3),
  ]);
  return { id, value };
}
async function takeChallenge(db, id, purpose) {
  const row = await db.prepare('SELECT value, ref, expires FROM challenges WHERE id = ? AND purpose = ?').bind(String(id), purpose).first();
  if (!row) return null;
  const del = await db.prepare('DELETE FROM challenges WHERE id = ?').bind(String(id)).run(); // 單次使用
  if (del.meta.changes !== 1 || row.expires < Date.now()) return null;
  return row;
}
function checkClientData(raw, type, challenge, origin) {
  let c;
  try { c = JSON.parse(new TextDecoder().decode(raw)); } catch { return false; }
  return c.type === type && c.challenge === challenge && c.origin === origin;
}
async function validInvite(db, token) {
  if (typeof token !== 'string' || token.length < 16) return null;
  const h = await sha256hex(token);
  const row = await db.prepare('SELECT user FROM invites WHERE token = ? AND used = 0 AND expires > ?').bind(h, Date.now()).first();
  return row ? { hash: h, user: row.user } : null;
}

export async function handleAuth(request, env, url, user) {
  const db = env.DB, p = url.pathname, host = url.hostname;
  const body = async () => { try { return await request.json(); } catch { return null; } };
  const post = request.method === 'POST';

  if (p === '/api/me' && request.method === 'GET') return user ? json({ user }) : json({ error: 'login required' }, 401);

  if (p === '/api/auth/login/options' && post) {
    const ch = await newChallenge(db, 'login');
    return json({ challengeId: ch.id, challenge: ch.value, rpId: host });
  }

  if (p === '/api/auth/login/verify' && post) {
    const b = await body();
    if (!b) return json({ error: 'bad input' }, 400);
    try {
      const ch = await takeChallenge(db, b.challengeId, 'login');
      const cred = ch && await db.prepare('SELECT id, user, pubkey, counter FROM credentials WHERE id = ?').bind(String(b.id)).first();
      if (!cred) return json({ error: '登入失敗' }, 401);
      const cdj = unb64u(b.clientDataJSON), ad = unb64u(b.authenticatorData), sig = unb64u(b.signature);
      if (!checkClientData(cdj, 'webauthn.get', ch.value, url.origin)) return json({ error: '登入失敗' }, 401);
      if (!same(ad.slice(0, 32), await sha256(host)) || (ad[32] & 0x05) !== 0x05) return json({ error: '需要生物辨識驗證' }, 401);
      const key = await crypto.subtle.importKey('spki', unb64u(cred.pubkey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const signed = new Uint8Array([...ad, ...(await sha256(cdj))]);
      if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signed))) return json({ error: '登入失敗' }, 401);
      const counter = (ad[33] << 24) | (ad[34] << 16) | (ad[35] << 8) | ad[36];
      if (counter > cred.counter) await db.prepare('UPDATE credentials SET counter = ? WHERE id = ?').bind(counter >>> 0, cred.id).run();
      return json({ user: cred.user }, 200, { 'set-cookie': await startSession(db, cred.user, url) });
    } catch { return json({ error: '登入失敗' }, 401); }
  }

  if (p === '/api/auth/register/options' && post) {
    const b = await body();
    const inv = b && await validInvite(db, b.token);
    if (!inv) return json({ error: '邀請連結無效或已過期' }, 400);
    const ch = await newChallenge(db, 'reg', inv.hash);
    return json({ challengeId: ch.id, challenge: ch.value, rpId: host, user: inv.user, userId: b64u(enc.encode(inv.user)) });
  }

  if (p === '/api/auth/register/verify' && post) {
    const b = await body();
    const inv = b && await validInvite(db, b.token);
    if (!inv) return json({ error: '邀請連結無效或已過期' }, 400);
    try {
      const ch = await takeChallenge(db, b.challengeId, 'reg');
      if (!ch || ch.ref !== inv.hash) return json({ error: '註冊逾時，請重新操作' }, 400);
      if (!checkClientData(unb64u(b.clientDataJSON), 'webauthn.create', ch.value, url.origin)) return json({ error: '註冊驗證失敗' }, 400);
      if (b.alg !== -7) return json({ error: '這支裝置不支援需要的驗證方式' }, 400);
      const spki = unb64u(b.publicKey);
      await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const used = await db.prepare('UPDATE invites SET used = 1 WHERE token = ? AND used = 0').bind(inv.hash).run();
      if (used.meta.changes !== 1) return json({ error: '邀請連結已被使用' }, 400);
      await db.prepare('INSERT INTO credentials (id, user, pubkey, counter, created) VALUES (?, ?, ?, 0, ?)').bind(String(b.id), inv.user, b64u(spki), Date.now()).run();
      return json({ user: inv.user }, 200, { 'set-cookie': await startSession(db, inv.user, url) });
    } catch { return json({ error: '註冊失敗' }, 400); }
  }

  if (!user) return json({ error: 'login required' }, 401);

  // 已登入的人可以產生 24 小時、單次使用的邀請連結，給新裝置或另一個人
  if (p === '/api/auth/invite' && post) {
    const b = await body();
    if (!b || !PEOPLE.includes(b.user)) return json({ error: 'bad input' }, 400);
    const token = rand(24);
    await db.prepare('INSERT INTO invites (token, user, expires) VALUES (?, ?, ?)').bind(await sha256hex(token), b.user, Date.now() + 24 * 3600e3).run();
    return json({ url: url.origin + '/?invite=' + token });
  }

  if (p === '/api/auth/logout' && post) {
    const sid = cookieValue(request, 'sid');
    if (sid) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(await sha256hex(sid)).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
  }
  return json({ error: 'not found' }, 404);
}
