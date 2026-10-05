import html from '../public/index.html';
import { getUser, handleAuth } from './auth.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PEOPLE = ['羿勳', '宇茹'];
const OWNERS = ['羿勳', '宇茹', '共同'];
const CATS = ['食', '衣', '住', '行', '育', '樂', '寵'];

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const bad = (m) => json({ error: m }, 400);

async function readItems(db) {
  const { results } = await db.prepare(
    'SELECT id, cat, title, owner, freq, every, wd, meal, sort FROM items WHERE active = 1 ORDER BY sort, id').all();
  return results;
}

// 某天的勾選，以及每個項目在該天之前最後一次完成的日期
async function readState(db, day, lastOp) {
  const [items, doneRows, lastRows, meta, assignRows] = await Promise.all([
    readItems(db),
    db.prepare('SELECT id, on_, by_, at_, note FROM done WHERE day = ?').bind(day).all(),
    db.prepare(`SELECT id, MAX(day) AS d FROM done WHERE on_ = 1 AND day ${lastOp} ? GROUP BY id`).bind(day).all(),
    db.prepare('SELECT meals FROM day_meta WHERE day = ?').bind(day).first(),
    db.prepare('SELECT id, to_, by_ FROM assign WHERE day = ?').bind(day).all(),
  ]);
  const done = {};
  for (const r of doneRows.results) done[r.id] = { on: !!r.on_, by: r.by_, at: r.at_, note: r.note || '' };
  const last = {};
  for (const r of lastRows.results) last[r.id] = r.d;
  const assign = {};
  for (const r of assignRows.results) assign[r.id] = { to: r.to_, by: r.by_ };
  return { items, done, last, assign, meals: meta ? !!meta.meals : true };
}

function checkItem(b) {
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  const freq = typeof b.freq === 'string' ? b.freq.trim() : '';
  const every = Number.isInteger(b.every) ? b.every : -1;
  if (!title || title.length > 40) return '項目名稱需 1-40 字';
  if (!CATS.includes(b.cat)) return '分類不正確';
  if (!OWNERS.includes(b.owner)) return '負責人不正確';
  if (freq.length > 20) return '頻率說明太長';
  if (every < 0 || every > 365) return '週期不正確';
  return { title, freq: freq || '依需求', every, wd: b.wd ? 1 : 0, meal: b.meal ? 1 : 0, cat: b.cat, owner: b.owner };
}

async function body(request) {
  try { return await request.json(); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const db = env.DB;

    if (p === '/' || p === '/index.html')
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });

    if (p === '/manifest.webmanifest')
      return new Response(JSON.stringify({ name: '家庭分工日誌', short_name: '分工日誌', start_url: '/', display: 'standalone', background_color: '#f4f6f7', theme_color: '#1f6f78', lang: 'zh-Hant', icons: [] }),
        { headers: { 'content-type': 'application/manifest+json' } });

    // 其餘 /api 都要先登入；寫入類請求必須來自同一個網站
    let user = null;
    if (p.startsWith('/api/')) {
      if (request.method !== 'GET' && request.headers.get('origin') !== url.origin) return json({ error: 'bad origin' }, 403);
      user = await getUser(request, db);
      if (p === '/api/me' || p.startsWith('/api/auth/')) return handleAuth(request, env, url, user);
      if (!user) return json({ error: 'login required' }, 401);
    }

    let m;
    // GET /api/state/2026-10-05
    if ((m = p.match(/^\/api\/state\/([^/]+)$/)) && request.method === 'GET') {
      if (!DAY.test(m[1])) return bad('bad date');
      return json(await readState(db, m[1], '<'));
    }

    // POST /api/day/2026-10-05  {id, on?, by, note?}
    if ((m = p.match(/^\/api\/day\/([^/]+)$/)) && request.method === 'POST') {
      const day = m[1];
      const b = await body(request);
      if (!DAY.test(day) || !b) return bad('bad input');
      if (typeof b.id !== 'string' || b.id.length > 40) return bad('bad input');
      b.by = user; // 由登入身份決定是誰勾的
      const hasOn = typeof b.on === 'boolean';
      const hasNote = typeof b.note === 'string';
      if (!hasOn && !hasNote) return bad('nothing to write');
      const now = Date.now();
      const stmts = [db.prepare('INSERT OR IGNORE INTO done (day, id, on_, by_, at_) VALUES (?1, ?2, 0, ?3, ?4)').bind(day, b.id, b.by, now)];
      if (hasOn) stmts.push(db.prepare('UPDATE done SET on_ = ?3, by_ = ?4, at_ = ?5 WHERE day = ?1 AND id = ?2').bind(day, b.id, b.on ? 1 : 0, b.by, now));
      if (hasNote) stmts.push(db.prepare('UPDATE done SET note = ?3 WHERE day = ?1 AND id = ?2').bind(day, b.id, b.note.trim().slice(0, 80)));
      await db.batch(stmts);
      return json(await readState(db, day, '<'));
    }

    // POST /api/meta/2026-10-05 {meals: false}  當天沒有在家吃飯
    if ((m = p.match(/^\/api\/meta\/([^/]+)$/)) && request.method === 'POST') {
      const b = await body(request);
      if (!DAY.test(m[1]) || !b || typeof b.meals !== 'boolean') return bad('bad input');
      await db.prepare('INSERT INTO day_meta (day, meals) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET meals = ?2').bind(m[1], b.meals ? 1 : 0).run();
      return json(await readState(db, m[1], '<'));
    }

    // POST /api/assign/2026-10-05 {id, to: '宇茹' | null}  當天請對方做；null = 換回去
    if ((m = p.match(/^\/api\/assign\/([^/]+)$/)) && request.method === 'POST') {
      const b = await body(request);
      if (!DAY.test(m[1]) || !b || typeof b.id !== 'string' || b.id.length > 40) return bad('bad input');
      if (b.to === null) {
        await db.prepare('DELETE FROM assign WHERE day = ? AND id = ?').bind(m[1], b.id).run();
      } else {
        if (!PEOPLE.includes(b.to) || b.to === user) return bad('只能請對方做');
        await db.prepare('INSERT INTO assign (day, id, to_, by_, at_) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(day, id) DO UPDATE SET to_ = ?3, by_ = ?4, at_ = ?5')
          .bind(m[1], b.id, b.to, user, Date.now()).run();
      }
      return json(await readState(db, m[1], '<'));
    }

    // POST /api/items
    if (p === '/api/items' && request.method === 'POST') {
      const b = await body(request);
      const v = b && checkItem(b);
      if (!v || typeof v === 'string') return bad(v || 'bad input');
      const id = 'n' + Date.now().toString(36);
      const { results } = await db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM items').all();
      await db.prepare('INSERT INTO items (id, cat, title, owner, freq, every, wd, meal, sort, active) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1)')
        .bind(id, v.cat, v.title, v.owner, v.freq, v.every, v.wd, v.meal, results[0].s).run();
      return json({ items: await readItems(db) });
    }

    // PUT / DELETE /api/items/:id
    if ((m = p.match(/^\/api\/items\/([^/]+)$/))) {
      const id = m[1];
      if (request.method === 'PUT') {
        const b = await body(request);
        const v = b && checkItem(b);
        if (!v || typeof v === 'string') return bad(v || 'bad input');
        await db.prepare('UPDATE items SET cat=?2, title=?3, owner=?4, freq=?5, every=?6, wd=?7, meal=?8 WHERE id=?1')
          .bind(id, v.cat, v.title, v.owner, v.freq, v.every, v.wd, v.meal).run();
        return json({ items: await readItems(db) });
      }
      if (request.method === 'DELETE') {
        await db.prepare('UPDATE items SET active = 0 WHERE id = ?').bind(id).run(); // 保留歷史紀錄
        return json({ items: await readItems(db) });
      }
    }

    // GET /api/stats?from=2026-09-22&to=2026-10-05
    if (p === '/api/stats' && request.method === 'GET') {
      const from = url.searchParams.get('from'), to = url.searchParams.get('to');
      if (!DAY.test(from || '') || !DAY.test(to || '')) return bad('bad range');
      const [rows, items, lastRows] = await Promise.all([
        db.prepare('SELECT day, by_, COUNT(*) AS c FROM done WHERE on_ = 1 AND day >= ?1 AND day <= ?2 GROUP BY day, by_').bind(from, to).all(),
        readItems(db),
        db.prepare('SELECT id, MAX(day) AS d FROM done WHERE on_ = 1 AND day <= ? GROUP BY id').bind(to).all(),
      ]);
      const last = {};
      for (const r of lastRows.results) last[r.id] = r.d;
      return json({ rows: rows.results.map((r) => ({ day: r.day, by: r.by_, c: r.c })), items, last });
    }

    return json({ error: 'not found' }, 404);
  },
};
