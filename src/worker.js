// dangent.uk: serves the static site from ./public and a small leaderboard API backed by D1.
//   POST /api/submit_score  {p_name, p_streak, p_mode, p_secs}       -> new row id
//   POST /api/board         {p_mode, p_id?, p_streak?}               -> top 5 plus two either side of you
// Scores can only be added or read here. Edit or delete rows in the Cloudflare dashboard (D1 > dangent-scores > Console).

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     streak INTEGER NOT NULL,
     mode TEXT NOT NULL,
     secs INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS scores_board ON scores (mode, streak DESC, created_at, id)`,
];
let ready = null;
const init = (db) => (ready ||= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; }));

const BLOCK = /\b(fuck\w*|f\*ck|cunts?|nigg\w*|nigga|faggots?|fags?|rape|raped|rapist|wank\w*|paki|spastic|spaz|retard\w*|nonce|kike|shit\w*|twat|bellend|knobhead|dickhead)\b/i;
const MODES = new Set(['all', 'pl']);
const SECS = new Set([15, 30, 45, 60]);

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const BOARD = `
  WITH r AS (
    SELECT row_number() OVER (ORDER BY streak DESC, created_at, id) AS rank,
           id, name, streak, secs, created_at, count(*) OVER () AS total
    FROM scores WHERE mode = ?1),
  me AS (
    SELECT COALESCE((SELECT rank FROM r WHERE id = ?2),
                    CASE WHEN ?3 IS NOT NULL THEN (SELECT count(*) + 1 FROM r WHERE streak >= ?3) END) AS rk)
  SELECT r.* FROM r, me
  WHERE r.rank <= 5 OR (me.rk IS NOT NULL AND r.rank BETWEEN me.rk - 2 AND me.rk + 2)
  ORDER BY r.rank`;

async function api(fn, request, env) {
  if (request.method !== 'POST') return json({ message: 'POST only' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ message: 'Bad JSON' }, 400); }
  await init(env.DB);
  if (fn === 'board') {
    const mode = String(b.p_mode);
    if (!MODES.has(mode)) return json({ message: 'Bad mode' }, 400);
    const id = Number.isInteger(b.p_id) ? b.p_id : null;
    const st = Number.isInteger(b.p_streak) ? b.p_streak : null;
    const { results } = await env.DB.prepare(BOARD).bind(mode, id, st).all();
    return json(results);
  }
  if (fn === 'submit_score') {
    const name = String(b.p_name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
    const streak = b.p_streak, mode = String(b.p_mode), secs = b.p_secs;
    if (!name) return json({ message: 'Name needed' }, 400);
    if (BLOCK.test(name)) return json({ message: 'Pick another name' }, 400);
    if (!Number.isInteger(streak) || streak < 1 || streak > 300) return json({ message: 'Bad streak' }, 400);
    if (!MODES.has(mode) || !SECS.has(secs)) return json({ message: 'Bad game settings' }, 400);
    const row = await env.DB.prepare('INSERT INTO scores (name, streak, mode, secs) VALUES (?1, ?2, ?3, ?4) RETURNING id')
      .bind(name, streak, mode, secs).first();
    return json(row.id);
  }
  return json({ message: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/(board|submit_score)\/?$/);
    if (m) {
      try { return await api(m[1], request, env); }
      catch (e) { return json({ message: 'Server error' }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return json({ message: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
