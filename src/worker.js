// dangent.uk: serves the static site from ./public and a small leaderboard API backed by D1.
//   POST /api/submit_score  {p_name, p_streak, p_mode, p_secs}       -> new row id
//   POST /api/board         {p_mode, p_id?, p_streak?}               -> top 5 plus two either side of you
//   POST /api/all           {p_mode}                                 -> the whole board (top 500)
//   POST /api/event         {g, e, d, s}                             -> 204; private play counter, never read back by the site
//   POST /api/season        {cid, name, w, d, l, gf, ga, pos, scorer, goals} -> {id}; a finished Five-a-Sold campaign
//                           optional log {order, results, table, boot, squads} is kept in campaign_log
//   POST /api/seasons       {p_id?}                                  -> global table: top 50 plus two either side of you
//   POST /api/records       {}                                       -> Five-a-Sold record holders, users only (cached 2 minutes)
//   POST /api/wcf_submit    {cid, name, nat, stage, opp, gf, ga, scorer, sg} -> {id}; a finished World Cup Fiver run (stage 0 group, 1 R16 ... 4 lost final, 5 champions)
//   POST /api/wcf_nations   {}                                       -> per-nation summary for the leaderboard tiles
//   POST /api/wcf_board     {nat | 'all', p_id?}                     -> top 25 plus two either side of you, with that board's records
//   POST /api/fas_*        Five-a-Sold Challenge Mode: accounts, challenges, results, league (see src/challenge.js)
// Scores can only be added or read here. Edit or delete rows in the Cloudflare dashboard (D1 > dangent-scores > Console).

import { fas, FAS_SCHEMA } from './challenge.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS scores (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     streak INTEGER NOT NULL,
     mode TEXT NOT NULL,
     secs INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS scores_board ON scores (mode, streak DESC, created_at, id)`,
  // Private usage counter: no names, no IP addresses, no cookies. s is a random id made fresh on each page load.
  `CREATE TABLE IF NOT EXISTS events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     game TEXT NOT NULL,
     event TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '',
     sid TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS events_game ON events (game, event, created_at)`,
  // Five-a-Sold global table: one row per completed campaign. cid is a random id made when the campaign starts,
  // so a resent submission can't log the same season twice.
  `CREATE TABLE IF NOT EXISTS seasons (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     cid TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     w INTEGER NOT NULL, d INTEGER NOT NULL, l INTEGER NOT NULL,
     gd INTEGER NOT NULL, gf INTEGER, ga INTEGER, pts INTEGER NOT NULL,
     pos INTEGER NOT NULL,
     scorer TEXT NOT NULL DEFAULT '',
     goals INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  // Full record of each finished campaign (fixtures, tables, squads, prices) as JSON, for analysis. Never read back by the site.
  `CREATE TABLE IF NOT EXISTS campaign_log (
     cid TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     data TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS seasons_board ON seasons (pts DESC, gd DESC, gf DESC)`,
  // World Cup Fiver: one row per finished run. cid is a random id made when the run starts, so a resend can't log it twice.
  // stage: 0 out in the group, 1 round of 16, 2 quarter-final, 3 semi-final, 4 lost the final, 5 world champions.
  `CREATE TABLE IF NOT EXISTS wcf_runs (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     cid TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     nat TEXT NOT NULL,
     stage INTEGER NOT NULL,
     opp TEXT NOT NULL DEFAULT '',
     gf INTEGER NOT NULL, ga INTEGER NOT NULL,
     scorer TEXT NOT NULL DEFAULT '',
     sg INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`,
  `CREATE INDEX IF NOT EXISTS wcf_board ON wcf_runs (nat, stage DESC, gf DESC, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS wcf_world ON wcf_runs (stage DESC, gf DESC, created_at, id)`,
];
let ready = null;
const init = (db) => (ready ||= db.batch([...SCHEMA, ...FAS_SCHEMA].map((s) => db.prepare(s))).catch((e) => { ready = null; throw e; }));

const BLOCK = /\b(fuck\w*|f\*ck|cunts?|nigg\w*|nigga|faggots?|fags?|rape|raped|rapist|wank\w*|paki|spastic|spaz|retard\w*|nonce|kike|shit\w*|twat|bellend|knobhead|dickhead)\b/i;
const MODES = new Set(['all', 'pl']);
const SECS = new Set([15, 30, 45, 60]);
const GAMES = new Set(['home', 'streaker', 'five-a-sold', 'world-cup-fiver']);
const WCF_NATS = new Set(['Argentina', 'Australia', 'Belgium', 'Brazil', 'Cameroon', 'Colombia', 'Croatia', 'Denmark', 'England', 'France', 'Germany', 'Iran', 'Ireland', 'Italy', 'Japan', 'Mexico', 'Morocco', 'Netherlands', 'Nigeria', 'Norway', 'Portugal', 'Saudi Arabia', 'Scotland', 'Serbia', 'South Korea', 'Spain', 'Sweden', 'Switzerland', 'Tunisia', 'USA', 'Uruguay', 'Wales']);
const EVENTS = new Set(['view', 'start', 'auction_done', 'kickoff', 'finish', 'draft_done', 'champion']);

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

// Same rules as the campaign table: points, then goal difference, then goals scored; earlier seasons first after that.
// Each team name (exact match) shows at most its best 3 seasons. Every season stays in the table; total counts them all.
const SEASONS = `
  WITH b AS (
    SELECT *, row_number() OVER (PARTITION BY name ORDER BY pts DESC, gd DESC, gf DESC NULLS LAST, created_at, id) AS nth
    FROM seasons),
  r AS (
    SELECT row_number() OVER (ORDER BY pts DESC, gd DESC, gf DESC NULLS LAST, created_at, id) AS rank,
           id, name, w, d, l, gd, pts, pos, scorer, goals, count(*) OVER () AS shown, (SELECT count(*) FROM seasons) AS total
    FROM b WHERE nth <= 3),
  me AS (SELECT (SELECT rank FROM r WHERE id = ?1) AS rk)
  SELECT r.* FROM r, me
  WHERE r.rank <= 50 OR (me.rk IS NOT NULL AND r.rank BETWEEN me.rk - 2 AND me.rk + 2)
  ORDER BY r.rank`;

// Every finished campaign: seasons on the table (with their log if there is one), plus logged seasons deleted from the table.
const ALL_SEASONS = `
  SELECT s.name, s.gf, s.ga, s.scorer, s.goals, s.pos, s.created_at AS t, l.data
  FROM seasons s LEFT JOIN campaign_log l ON l.cid = s.cid
  UNION ALL
  SELECT l.name, NULL, NULL, NULL, NULL, NULL, l.created_at AS t, l.data
  FROM campaign_log l WHERE l.cid NOT IN (SELECT cid FROM seasons)
  ORDER BY t`;

// Users only. First to set a record keeps it on a tie.
async function records(env) {
  const { results } = await env.DB.prepare(ALL_SEASONS).all();
  const rec = {};
  const beat = (k, v, row) => { if (v > 0 && (!rec[k] || v > rec[k].v)) rec[k] = Object.assign({ v }, row); };
  let games = 0;
  const signs = [];
  for (const s of results) {
    const team = s.name;
    let L = null;
    try { L = s.data ? JSON.parse(s.data) : null; } catch { L = null; }
    // the user's own name inside the log: squads start with the user
    const me = L && L.squads && L.squads[0] ? L.squads[0][0] : null;
    const row = me && Array.isArray(L.table) ? L.table.find(x => x[1] === me) : null;
    const gf = s.gf ?? (row ? row[6] : null), ga = s.ga ?? (row ? row[7] : null), pos = s.pos ?? (row ? row[0] : null);
    if (gf != null) beat('gf', gf, { team, n: gf });
    if (ga != null) beat('ga', ga, { team, n: ga });
    if (s.scorer) beat('scorer', s.goals, { team, player: s.scorer, n: s.goals });
    else if (L && Array.isArray(L.boot)) { const b = L.boot.find(x => x[1] === me); if (b) beat('scorer', b[2], { team, player: b[0], n: b[2] }); }
    if (!me) continue;
    // match records, from the user's side, in round order
    const mine = (L.results || []).filter(x => x[1] === me || x[2] === me).sort((x, y) => x[0] - y[0]);
    let w = 0, l = 0, cs = 0;
    for (const x of mine) {
      games++;
      const home = x[1] === me, f = home ? x[3] : x[4], a = home ? x[4] : x[3], opp = home ? x[2] : x[1], m = f - a, score = `${f}-${a}`;
      if (m > 0) beat('win', m * 1000 + f, { team, score, opp });
      if (m < 0) beat('loss', -m * 1000 + a, { team, score, opp });
      w = m > 0 ? w + 1 : 0; l = m < 0 ? l + 1 : 0; if (a === 0) cs++;
      beat('wins', w, { team, n: w }); beat('losses', l, { team, n: l });
    }
    // keeper(s): if a window brought in a new keeper, both are named
    const gkOf = list => { const g = (((list || []).find(x => x[0] === me) || [null, []])[1]).find(x => x[1] === 'GK'); return g ? g[0] : ''; };
    const gk = [...new Set([L.window ? gkOf(L.window.squads0) : '', gkOf(L.squads)].filter(Boolean))].join(' then ');
    beat('cs', cs, { team, n: cs, gk });
    for (const [p, n] of (L.ast || [])) beat('assists', n, { team, player: p, n });
    if (L.fast) beat('fastest', 1000 - L.fast[1], { team, player: L.fast[0], min: L.fast[1], opp: L.fast[3] || '' });
    // signings: the auction squad (before any window), the final squad, and window buys
    const sq = list => ((list || []).find(x => x[0] === me) || [null, []])[1];
    const auction = L.window ? sq(L.window.squads0) : sq(L.squads);
    const buys = L.window ? (L.window.res || []).filter(x => x[2] === me) : [];
    for (const [p, , , price] of auction.concat(sq(L.squads))) if (p !== 'Free agent') beat('signing', price, { team, player: p, n: price });
    for (const [, p, , price] of buys) beat('signing', price, { team, player: p, n: price });
    // window signing impact: the user's points per game after the window (games 8-15) minus before it (games 1-7)
    if (buys.length && buys[0][3] > 0) {
      let pre = 0, post = 0, np = 0, nq = 0;
      for (const x of mine) {
        const home = x[1] === me, f = home ? x[3] : x[4], a = home ? x[4] : x[3], pts = f > a ? 3 : f === a ? 1 : 0;
        if (x[0] <= 7) { pre += pts; np++; } else { post += pts; nq++; }
      }
      if (np && nq) signs.push({ team, player: buys[0][1], n: buys[0][3], pre: +(pre / np).toFixed(2), post: +(post / nq).toFixed(2), d: post / nq - pre / np });
    }
    if (pos === 1) {
      const spend = auction.reduce((t, x) => t + (x[3] || 0), 0) + buys.reduce((t, x) => t + (x[3] || 0), 0);
      beat('cheapest', 1000 - spend, { team, n: spend });
    }
  }
  // best: biggest rise, ties to the cheapest signing; worst: biggest fall, ties to the dearest. Earlier season keeps a full tie.
  let best = null, worst = null;
  for (const x of signs) {
    if (x.d > 1e-9 && (!best || x.d > best.d + 1e-9 || (Math.abs(x.d - best.d) < 1e-9 && x.n < best.n))) best = x;
    if (x.d < -1e-9 && (!worst || x.d < worst.d - 1e-9 || (Math.abs(x.d - worst.d) < 1e-9 && x.n > worst.n))) worst = x;
  }
  if (best) rec.bestSign = best;
  if (worst) rec.worstSign = worst;
  return { rec, seasons: results.length, games };
}

// World Cup Fiver boards. Furthest stage first, then goals scored, then the earlier run. A manager name shows at most its best 3 runs on a board.
const WCF_BOARD = `
  WITH b AS (
    SELECT *, row_number() OVER (PARTITION BY name ORDER BY stage DESC, gf DESC, created_at, id) AS nth
    FROM wcf_runs WHERE (?1 = 'all' OR nat = ?1)),
  r AS (
    SELECT row_number() OVER (ORDER BY stage DESC, gf DESC, created_at, id) AS rank,
           id, name, nat, stage, opp, gf, ga, scorer, sg, count(*) OVER () AS shown
    FROM b WHERE nth <= 3),
  me AS (SELECT (SELECT rank FROM r WHERE id = ?2) AS rk)
  SELECT r.* FROM r, me
  WHERE r.rank <= 25 OR (me.rk IS NOT NULL AND r.rank BETWEEN me.rk - 2 AND me.rk + 2)
  ORDER BY r.rank`;
const WCF_STATS = `
  SELECT count(*) AS runs, COALESCE(sum(stage = 5), 0) AS titles, COALESCE(sum(stage >= 4), 0) AS finals, COALESCE(max(stage), -1) AS best,
         (SELECT name || '|' || nat || '|' || gf FROM wcf_runs WHERE (?1 = 'all' OR nat = ?1) ORDER BY gf DESC, created_at, id LIMIT 1) AS most,
         (SELECT scorer || '|' || nat || '|' || sg || '|' || name FROM wcf_runs WHERE (?1 = 'all' OR nat = ?1) AND scorer <> '' ORDER BY sg DESC, created_at, id LIMIT 1) AS boot,
         (SELECT name || '|' || nat || '|' || ga FROM wcf_runs WHERE (?1 = 'all' OR nat = ?1) AND stage = 5 ORDER BY ga, created_at, id LIMIT 1) AS tight
  FROM wcf_runs WHERE (?1 = 'all' OR nat = ?1)`;
const WCF_NATIONS = `
  SELECT nat, count(*) AS runs, COALESCE(sum(stage = 5), 0) AS titles, max(stage) AS best, max(gf) AS most FROM wcf_runs GROUP BY nat`;

const ALL = `
  SELECT row_number() OVER (ORDER BY streak DESC, created_at, id) AS rank,
         id, name, streak, secs, created_at, count(*) OVER () AS total
  FROM scores WHERE mode = ?1 ORDER BY rank LIMIT 500`;

async function api(fn, request, env) {
  if (request.method !== 'POST') return json({ message: 'POST only' }, 405);
  let b;
  try { b = await request.json(); } catch { return json({ message: 'Bad JSON' }, 400); }
  await init(env.DB);
  if (fn.startsWith('fas_')) return fas(fn.slice(4), request, env, b);
  if (fn === 'event') {
    const g = String(b.g ?? ''), e = String(b.e ?? '');
    if (!GAMES.has(g) || !EVENTS.has(e)) return new Response(null, { status: 204 });
    const d = String(b.d ?? '').replace(/[^\p{L}\p{N} '.:+\/-]/gu, '').slice(0, 40);
    const s = String(b.s ?? '').replace(/[^a-z0-9]/g, '').slice(0, 12);
    await env.DB.prepare('INSERT INTO events (game, event, detail, sid) VALUES (?1, ?2, ?3, ?4)').bind(g, e, d, s).run();
    return new Response(null, { status: 204 });
  }
  if (fn === 'season') {
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    const cid = String(b.cid ?? '');
    let name = String(b.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name || BLOCK.test(name)) name = 'Mystery XI';
    const scorer = String(b.scorer ?? '').replace(/[^\p{L}\p{M}\p{N} '.-]/gu, '').trim().slice(0, 40);
    const { w, d, l, gf, ga, pos, goals } = b;
    if (!/^[a-z0-9]{8,16}$/.test(cid)) return json({ message: 'Bad id' }, 400);
    if (![w, d, l].every((v) => int(v, 0, 15)) || w + d + l !== 15) return json({ message: 'Bad record' }, 400);
    if (!int(gf, 0, 400) || !int(ga, 0, 400) || !int(pos, 1, 16) || !int(goals, 0, gf)) return json({ message: 'Bad record' }, 400);
    await env.DB.prepare(`INSERT INTO seasons (cid, name, w, d, l, gd, gf, ga, pts, pos, scorer, goals)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(cid) DO NOTHING`)
      .bind(cid, name, w, d, l, gf - ga, gf, ga, 3 * w + d, pos, scorer, scorer ? goals : 0).run();
    if (b.log && typeof b.log === 'object') {
      const data = JSON.stringify(b.log);
      if (data.length <= 40000) await env.DB.prepare('INSERT INTO campaign_log (cid, name, data) VALUES (?1, ?2, ?3) ON CONFLICT(cid) DO NOTHING').bind(cid, name, data).run();
    }
    const row = await env.DB.prepare('SELECT id FROM seasons WHERE cid = ?1').bind(cid).first();
    return json({ id: row.id });
  }
  if (fn === 'seasons') {
    const id = Number.isInteger(b.p_id) ? b.p_id : null;
    const { results } = await env.DB.prepare(SEASONS).bind(id).all();
    return json(results);
  }
  if (fn === 'records') {
    const cache = caches.default, key = new Request('https://dangent.uk/__cache/five-a-sold-records');
    const hit = await cache.match(key);
    if (hit) return hit;
    const res = new Response(JSON.stringify(await records(env)), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=120' } });
    await cache.put(key, res.clone());
    return res;
  }
  if (fn === 'wcf_submit') {
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    const cid = String(b.cid ?? '');
    let name = String(b.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
    if (!name || BLOCK.test(name)) name = 'Mystery manager';
    const nat = String(b.nat ?? ''), opp = String(b.opp ?? ''), scorer = String(b.scorer ?? '').replace(/[^\p{L}\p{M}\p{N} '.-]/gu, '').trim().slice(0, 40);
    const { stage, gf, ga, sg } = b;
    if (!/^[a-z0-9]{8,16}$/.test(cid)) return json({ message: 'Bad id' }, 400);
    if (!WCF_NATS.has(nat) || (opp && !WCF_NATS.has(opp))) return json({ message: 'Bad nation' }, 400);
    if (!int(stage, 0, 5) || !int(gf, 0, 120) || !int(ga, 0, 120) || !int(sg ?? 0, 0, gf)) return json({ message: 'Bad record' }, 400);
    if ((stage === 5) !== (opp === '') && stage !== 0) return json({ message: 'Bad record' }, 400);
    await env.DB.prepare(`INSERT INTO wcf_runs (cid, name, nat, stage, opp, gf, ga, scorer, sg) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(cid) DO NOTHING`)
      .bind(cid, name, nat, stage, stage === 5 || stage === 0 ? '' : opp, gf, ga, scorer, scorer ? (sg ?? 0) : 0).run();
    const row = await env.DB.prepare('SELECT id FROM wcf_runs WHERE cid = ?1').bind(cid).first();
    return json({ id: row.id });
  }
  if (fn === 'wcf_nations') {
    const { results } = await env.DB.prepare(WCF_NATIONS).all();
    const total = results.reduce((t, r) => t + r.runs, 0);
    return json({ total, nations: results });
  }
  if (fn === 'wcf_board') {
    const nat = String(b.nat ?? 'all');
    if (nat !== 'all' && !WCF_NATS.has(nat)) return json({ message: 'Bad nation' }, 400);
    const id = Number.isInteger(b.p_id) ? b.p_id : null;
    const [rows, stats] = await env.DB.batch([env.DB.prepare(WCF_BOARD).bind(nat, id), env.DB.prepare(WCF_STATS).bind(nat)]);
    return json({ rows: rows.results, stats: stats.results[0] });
  }
  if (fn === 'board') {
    const mode = String(b.p_mode);
    if (!MODES.has(mode)) return json({ message: 'Bad mode' }, 400);
    const id = Number.isInteger(b.p_id) ? b.p_id : null;
    const st = Number.isInteger(b.p_streak) ? b.p_streak : null;
    const { results } = await env.DB.prepare(BOARD).bind(mode, id, st).all();
    return json(results);
  }
  if (fn === 'all') {
    const mode = String(b.p_mode);
    if (!MODES.has(mode)) return json({ message: 'Bad mode' }, 400);
    const { results } = await env.DB.prepare(ALL).bind(mode).all();
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
    const m = url.pathname.match(/^\/api\/(board|all|submit_score|event|season|seasons|records|wcf_submit|wcf_nations|wcf_board|fas_(?:signup|recover|logout|me|kit|newcode|new|get|join|entry|result|h2h|league|post|board|remove|seen))\/?$/);
    if (m) {
      try { return await api(m[1], request, env); }
      catch (e) { return json({ message: 'Server error' }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return json({ message: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
