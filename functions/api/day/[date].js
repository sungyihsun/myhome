// GET  /api/day/2026-10-05            -> { done: { itemId: {on, by, at} } }
// POST /api/day/2026-10-05 {id,on,by} -> 寫入單一項目，回傳該天最新狀態
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^i\d{2}$/;
const PEOPLE = ['羿勳', '宇茹'];
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function dayState(db, day) {
  const { results } = await db.prepare('SELECT id, on_, by_, at_ FROM done WHERE day = ?').bind(day).all();
  const done = {};
  for (const r of results) done[r.id] = { on: !!r.on_, by: r.by_, at: r.at_ };
  return done;
}

export async function onRequest({ request, env, params }) {
  const day = params.date;
  if (!DATE.test(day)) return json({ error: 'bad date' }, 400);
  if (request.method === 'GET') return json({ done: await dayState(env.DB, day) });
  if (request.method === 'POST') {
    let b;
    try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
    if (!ID.test(b.id) || typeof b.on !== 'boolean' || !PEOPLE.includes(b.by)) return json({ error: 'bad input' }, 400);
    await env.DB.prepare(
      'INSERT INTO done (day, id, on_, by_, at_) VALUES (?1, ?2, ?3, ?4, ?5) ' +
      'ON CONFLICT(day, id) DO UPDATE SET on_ = ?3, by_ = ?4, at_ = ?5'
    ).bind(day, b.id, b.on ? 1 : 0, b.by, Date.now()).run();
    return json({ done: await dayState(env.DB, day) });
  }
  return json({ error: 'method not allowed' }, 405);
}
