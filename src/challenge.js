// Five-a-Sold Challenge Mode: accounts without passwords, two-player sealed-bid challenges, head to head and an all time league.
// Called from worker.js. A challenge is a seeded deck; both players bid on it separately, and when the second entry lands the
// bids are resolved against each other and the match is simulated here, on the server, so neither client can change it.
//   POST /api/fas_signup   {name, kit}            -> {me, code, dev}   creates the account, sets the device cookie. Show the recovery code once.
//   POST /api/fas_recover  {name, code}           -> {me, dev}         signs a new device in
//   POST /api/fas_logout   {}                     -> {ok}
//   POST /api/fas_me       {}                     -> {me, open, todo, recent}  (me is null when not signed in)
//   POST /api/fas_kit      {kit}                  -> {me}
//   POST /api/fas_newcode  {}                     -> {code}            replaces the recovery code
//   POST /api/fas_new      {rematch?}             -> {id, expires_at}
//   POST /api/fas_get      {id}                   -> challenge view (deck only for the two players)
//   POST /api/fas_join     {id}                   -> {ok}
//   POST /api/fas_entry    {id, gk, out, year}    -> {status}
//   POST /api/fas_result   {id}                   -> the finished match
//   POST /api/fas_h2h      {opp}                  -> record against one manager
//   POST /api/fas_league   {}                     -> everyone with at least one match
import AD from '../tools/five-a-sold/engine.js';
import DATA from '../tools/five-a-sold/data.json';

let inited = false;
const ensure = () => { if (!inited) { AD.init(DATA); inited = true; } };

export const FAS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fas_accounts (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL COLLATE NOCASE UNIQUE,
     kit TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     fails INTEGER NOT NULL DEFAULT 0,
     fail_at INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fas_devices (
     hash TEXT PRIMARY KEY,
     account_id INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     seen_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS fas_dev_acct ON fas_devices (account_id)`,
  `CREATE TABLE IF NOT EXISTS fas_challenges (
     id TEXT PRIMARY KEY,
     seed INTEGER NOT NULL,
     creator INTEGER NOT NULL,
     opponent INTEGER,
     for_account INTEGER,
     home INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'open',
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS fas_ch_creator ON fas_challenges (creator, status)`,
  `CREATE INDEX IF NOT EXISTS fas_ch_opp ON fas_challenges (opponent, status)`,
  `CREATE TABLE IF NOT EXISTS fas_entries (
     challenge_id TEXT NOT NULL,
     side INTEGER NOT NULL,
     account_id INTEGER NOT NULL,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (challenge_id, side))`,
  `CREATE TABLE IF NOT EXISTS fas_matches (
     challenge_id TEXT PRIMARY KEY,
     data TEXT NOT NULL,
     created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fas_results (
     challenge_id TEXT NOT NULL,
     account_id INTEGER NOT NULL,
     opp_id INTEGER NOT NULL,
     gf INTEGER NOT NULL,
     ga INTEGER NOT NULL,
     pts INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (challenge_id, account_id))`,
  `CREATE INDEX IF NOT EXISTS fas_res_acct ON fas_results (account_id, created_at)`,
];

const HOUR = 3600 * 1000, EXPIRY = 48 * HOUR, MAX_OPEN = 5;
const BLOCK = /\b(fuck\w*|f\*ck|cunts?|nigg\w*|nigga|faggots?|fags?|rape|raped|rapist|wank\w*|paki|spastic|spaz|retard\w*|nonce|kike|shit\w*|twat|bellend|knobhead|dickhead)\b/i;
// Recovery codes are three footballers' surnames from the player database: easy to remember and to say out loud.
const SURNAMES = (() => {
  const set = new Set();
  for (const p of DATA.players) {
    const parts = String(p[0]).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').split(' ').filter(Boolean);
    let w = parts[parts.length - 1] || '';
    if (['jr', 'junior', 'filho', 'neto'].includes(w) && parts.length > 1) w = parts[parts.length - 2];
    if (w.length >= 4 && w.length <= 9 && !BLOCK.test(w)) set.add(w);
  }
  return [...set].sort();
})();

const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rnd = (n) => crypto.getRandomValues(new Uint32Array(n));
const token = (len = 32) => [...crypto.getRandomValues(new Uint8Array(len))].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
function newCode() {
  const out = [];
  while (out.length < 3) { const w = SURNAMES[rnd(1)[0] % SURNAMES.length]; if (!out.includes(w)) out.push(w); }
  return out.join('-');
}
const normCode = (c) => String(c ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

function reply(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
}
const fail = (message, status = 400) => reply({ message }, status);
const cookie = (dev, request) => `fas_dev=${dev}; Max-Age=${365 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
const clearCookie = (request) => `fas_dev=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;

const HEX = /^#[0-9a-fA-F]{6}$/;
function cleanKit(k, nested) {
  if (!k || typeof k !== 'object') return null;
  const o = {};
  for (const f of ['p', 's', 't']) { if (!HEX.test(String(k[f] ?? ''))) return null; o[f] = String(k[f]).toLowerCase(); }
  o.style = AD.KIT_STYLES.includes(k.style) ? k.style : 'plain';
  if (!nested && k.away) { const a = cleanKit(k.away, true); if (a) o.away = a; }
  return o;
}
function cleanName(v) {
  const n = String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim();
  if (n.length < 3 || n.length > 16) return null;
  if (!/^[\p{L}\p{N} '._-]+$/u.test(n)) return null;
  return n;
}

async function who(request, env) {
  const dev = (request.headers.get('x-fas-dev') || '') || ((request.headers.get('cookie') || '').match(/(?:^|;\s*)fas_dev=([a-z0-9]{20,64})/) || [])[1] || '';
  if (!/^[a-z0-9]{20,64}$/.test(dev)) return null;
  const h = await sha(dev);
  const row = await env.DB.prepare('SELECT a.id, a.name, a.kit, d.seen_at FROM fas_devices d JOIN fas_accounts a ON a.id = d.account_id WHERE d.hash = ?1').bind(h).first();
  if (!row) return null;
  if (Date.now() - row.seen_at > 24 * HOUR) await env.DB.prepare('UPDATE fas_devices SET seen_at = ?2 WHERE hash = ?1').bind(h, Date.now()).run();
  return { id: row.id, name: row.name, kit: JSON.parse(row.kit), hash: h };
}
const pub = (a) => ({ id: a.id, name: a.name, kit: a.kit });
async function accountsByIds(env, ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return {};
  const { results } = await env.DB.prepare(`SELECT id, name, kit FROM fas_accounts WHERE id IN (${ids.map((_, i) => '?' + (i + 1)).join(',')})`).bind(...ids).all();
  return Object.fromEntries(results.map((r) => [r.id, { id: r.id, name: r.name, kit: JSON.parse(r.kit) }]));
}

async function loadChallenge(env, id) {
  if (!/^[a-z0-9]{6,16}$/.test(String(id))) return null;
  return env.DB.prepare('SELECT * FROM fas_challenges WHERE id = ?1').bind(id).first();
}
const expired = (c) => c.status !== 'done' && c.expires_at <= Date.now();
const roleOf = (c, me) => (!me ? 'viewer' : c.creator === me.id ? 'creator' : c.opponent === me.id ? 'invitee' : 'viewer');

async function h2h(env, a, b) {
  const { results } = await env.DB.prepare(`SELECT challenge_id, gf, ga, pts, created_at FROM fas_results WHERE account_id = ?1 AND opp_id = ?2 ORDER BY created_at DESC`).bind(a, b).all();
  const t = { p: results.length, w: 0, d: 0, l: 0, gf: 0, ga: 0 };
  for (const r of results) { t.gf += r.gf; t.ga += r.ga; if (r.gf > r.ga) t.w++; else if (r.gf === r.ga) t.d++; else t.l++; }
  return { ...t, last: results.slice(0, 8).map((r) => ({ id: r.challenge_id, gf: r.gf, ga: r.ga, at: r.created_at })) };
}

// bids are resolved, the squads are lined up, the kits are checked for a clash and the match is played
async function finalize(env, c) {
  const { results } = await env.DB.prepare('SELECT side, account_id, data FROM fas_entries WHERE challenge_id = ?1').bind(c.id).all();
  if (results.length < 2) return null;
  results.sort((x, y) => x.side - y.side);
  const E = results.map((r) => JSON.parse(r.data));
  const acc = await accountsByIds(env, [c.creator, c.opponent]);
  const sides = [acc[c.creator], acc[c.opponent]];
  const deck = AD.challengeDeck(c.seed);
  const R = AD.resolveChallenge(deck, E, c.seed);
  const homeSide = c.home ? 1 : 0, awaySide = 1 - homeSide;
  const mk = AD.matchKits(sides[0].kit, sides[1].kit, homeSide);
  const simSeed = (c.seed ^ 0x51ED270B) >>> 0;
  const squads = R.squad.map((ids) => ids.map((i) => AD.players[i]));
  AD.seed(simSeed);
  const H = AD.makeTeam({ name: sides[homeSide].name, squad: squads[homeSide] }, true, null);
  const A = AD.makeTeam({ name: sides[awaySide].name, squad: squads[awaySide] }, false, null);
  const res = AD.simulate(H, A, { league: true });
  const score = res.score; // [home, away]
  const goals = [0, 0];
  goals[homeSide] = score[0]; goals[awaySide] = score[1];
  const now = Date.now();
  const data = {
    home: homeSide, names: sides.map((s) => s.name), ids: [c.creator, c.opponent], kits: mk.kits, homeKits: sides.map((s) => s.kit), changed: mk.changed,
    squads: R.squad, log: R.log, trivia: R.trivia, rem: R.rem, entries: E.map((e) => ({ gk: e.gk, out: e.out, year: e.year })),
    simSeed, score, goals, winner: res.winner == null ? null : res.winner === 0 ? homeSide : awaySide,
  };
  const pts = (f, a) => (f > a ? 3 : f === a ? 1 : 0);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO fas_matches (challenge_id, data, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(challenge_id) DO NOTHING').bind(c.id, JSON.stringify(data), now),
    env.DB.prepare('INSERT INTO fas_results (challenge_id, account_id, opp_id, gf, ga, pts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING').bind(c.id, c.creator, c.opponent, goals[0], goals[1], pts(goals[0], goals[1]), now),
    env.DB.prepare('INSERT INTO fas_results (challenge_id, account_id, opp_id, gf, ga, pts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING').bind(c.id, c.opponent, c.creator, goals[1], goals[0], pts(goals[1], goals[0]), now),
    env.DB.prepare("UPDATE fas_challenges SET status = 'done' WHERE id = ?1").bind(c.id),
  ]);
  return data;
}

export async function fas(fn, request, env, b) {
  ensure();
  const now = Date.now();
  if (fn === 'signup') {
    const name = cleanName(b.name), kit = cleanKit(b.kit);
    if (!name) return fail('Pick a name of 3 to 16 letters, numbers or spaces.');
    if (BLOCK.test(name)) return fail('Pick another name.');
    if (!kit) return fail('Pick a kit.');
    const code = newCode(), dev = token(32);
    try {
      const row = await env.DB.prepare('INSERT INTO fas_accounts (name, kit, code_hash, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING id').bind(name, JSON.stringify(kit), await sha(normCode(code)), now).first();
      await env.DB.prepare('INSERT INTO fas_devices (hash, account_id, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)').bind(await sha(dev), row.id, now).run();
      return reply({ me: { id: row.id, name, kit }, code, dev }, 200, { 'set-cookie': cookie(dev, request) });
    } catch (e) {
      if (String(e).includes('UNIQUE')) return fail('That name is taken. Pick another.', 409);
      throw e;
    }
  }
  if (fn === 'recover') {
    const name = cleanName(b.name);
    if (!name) return fail('Enter your manager name and recovery code.');
    const row = await env.DB.prepare('SELECT id, name, kit, code_hash, fails, fail_at FROM fas_accounts WHERE name = ?1').bind(name).first();
    if (!row) return fail('Name or recovery code not recognised.', 403);
    if (row.fails >= 8 && now - row.fail_at < 15 * 60 * 1000) return fail('Too many tries. Wait 15 minutes and try again.', 429);
    if ((await sha(normCode(b.code))) !== row.code_hash) {
      await env.DB.prepare('UPDATE fas_accounts SET fails = CASE WHEN ?2 - fail_at > 900000 THEN 1 ELSE fails + 1 END, fail_at = ?2 WHERE id = ?1').bind(row.id, now).run();
      return fail('Name or recovery code not recognised.', 403);
    }
    const dev = token(32);
    await env.DB.batch([
      env.DB.prepare('UPDATE fas_accounts SET fails = 0 WHERE id = ?1').bind(row.id),
      env.DB.prepare('INSERT INTO fas_devices (hash, account_id, created_at, seen_at) VALUES (?1, ?2, ?3, ?3)').bind(await sha(dev), row.id, now),
    ]);
    return reply({ me: { id: row.id, name: row.name, kit: JSON.parse(row.kit) }, dev }, 200, { 'set-cookie': cookie(dev, request) });
  }
  const me = await who(request, env);
  if (fn === 'logout') {
    if (me) await env.DB.prepare('DELETE FROM fas_devices WHERE hash = ?1').bind(me.hash).run();
    return reply({ ok: true }, 200, { 'set-cookie': clearCookie(request) });
  }
  if (fn === 'me') {
    if (!me) return reply({ me: null });
    const [open, todo, recent, rec] = await env.DB.batch([
      env.DB.prepare(`SELECT id, status, opponent, for_account, created_at, expires_at, (SELECT count(*) FROM fas_entries e WHERE e.challenge_id = fas_challenges.id AND e.account_id = ?1) AS mine FROM fas_challenges WHERE creator = ?1 AND status != 'done' AND expires_at > ?2 ORDER BY created_at DESC`).bind(me.id, now),
      env.DB.prepare(`SELECT id, creator, status, expires_at, (SELECT count(*) FROM fas_entries e WHERE e.challenge_id = fas_challenges.id AND e.account_id = ?1) AS mine FROM fas_challenges WHERE ((opponent = ?1) OR (status = 'open' AND for_account = ?1)) AND status != 'done' AND expires_at > ?2 ORDER BY created_at DESC`).bind(me.id, now),
      env.DB.prepare('SELECT challenge_id, opp_id, gf, ga, created_at FROM fas_results WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 12').bind(me.id),
      env.DB.prepare('SELECT count(*) AS p, coalesce(sum(pts = 3), 0) AS w, coalesce(sum(pts = 1), 0) AS d, coalesce(sum(pts = 0), 0) AS l, coalesce(sum(gf), 0) AS gf, coalesce(sum(ga), 0) AS ga, coalesce(sum(pts), 0) AS pts FROM fas_results WHERE account_id = ?1').bind(me.id),
    ]);
    const acc = await accountsByIds(env, [...open.results.flatMap((r) => [r.opponent, r.for_account]), ...todo.results.map((r) => r.creator), ...recent.results.map((r) => r.opp_id)]);
    return reply({
      me: pub(me),
      rec: rec.results[0],
      open: open.results.map((r) => ({ id: r.id, status: r.status, opp: acc[r.opponent]?.name || null, for: acc[r.for_account]?.name || null, created_at: r.created_at, expires_at: r.expires_at, entered: r.mine > 0 })),
      todo: todo.results.map((r) => ({ id: r.id, from: acc[r.creator]?.name || '?', status: r.status, expires_at: r.expires_at, entered: r.mine > 0 })),
      recent: recent.results.map((r) => ({ id: r.challenge_id, opp: acc[r.opp_id]?.name || '?', gf: r.gf, ga: r.ga, at: r.created_at })),
    });
  }
  if (fn === 'get') {
    const c = await loadChallenge(env, b.id);
    if (!c || expired(c)) return reply({ status: 'expired' });
    const role = roleOf(c, me);
    const acc = await accountsByIds(env, [c.creator, c.opponent, c.for_account]);
    let status = c.status;
    if (c.status === 'done' && role === 'viewer') status = 'closed';
    else if (c.status === 'open' && role !== 'creator' && c.for_account && (!me || me.id !== c.for_account)) status = 'private';
    else if (c.status === 'accepted' && role === 'viewer') status = 'taken';
    const base = { id: c.id, status, role, home: c.home, expires_at: c.expires_at, creator: acc[c.creator] ? { id: c.creator, name: acc[c.creator].name, kit: acc[c.creator].kit } : null, for: acc[c.for_account]?.name || null };
    if (status === 'closed' || status === 'taken') return reply({ ...base, creator: { name: base.creator?.name } });
    if (status === 'private') return reply({ ...base, creator: { name: base.creator?.name, kit: base.creator?.kit }, forName: base.for });
    const out = { ...base, opponent: acc[c.opponent] ? { id: c.opponent, name: acc[c.opponent].name, kit: acc[c.opponent].kit } : null };
    if (role !== 'viewer') {
      out.deck = AD.challengeDeck(c.seed);
      out.entered = !!(await env.DB.prepare('SELECT 1 AS x FROM fas_entries WHERE challenge_id = ?1 AND account_id = ?2').bind(c.id, me.id).first());
    }
    if (me && role !== 'creator') out.h2h = await h2h(env, me.id, c.creator);
    return reply(out);
  }
  // everything below needs an account
  if (!me) return fail('Sign in first.', 401);
  if (fn === 'kit') {
    const kit = cleanKit(b.kit);
    if (!kit) return fail('Pick a kit.');
    await env.DB.prepare('UPDATE fas_accounts SET kit = ?2 WHERE id = ?1').bind(me.id, JSON.stringify(kit)).run();
    return reply({ me: { ...pub(me), kit } });
  }
  if (fn === 'newcode') {
    const code = newCode();
    await env.DB.prepare('UPDATE fas_accounts SET code_hash = ?2, fails = 0 WHERE id = ?1').bind(me.id, await sha(normCode(code))).run();
    return reply({ code });
  }
  if (fn === 'new') {
    await env.DB.prepare("DELETE FROM fas_entries WHERE challenge_id IN (SELECT id FROM fas_challenges WHERE status != 'done' AND expires_at < ?1)").bind(now - 3 * 24 * HOUR).run();
    await env.DB.prepare("DELETE FROM fas_challenges WHERE status != 'done' AND expires_at < ?1").bind(now - 3 * 24 * HOUR).run();
    const open = await env.DB.prepare("SELECT count(*) AS n FROM fas_challenges WHERE creator = ?1 AND status != 'done' AND expires_at > ?2").bind(me.id, now).first();
    if (open.n >= MAX_OPEN) return fail(`You already have ${MAX_OPEN} open challenges. Wait for one to be played or to run out.`, 429);
    let forAcc = null, home = 0;
    if (b.rematch) {
      const old = await loadChallenge(env, b.rematch);
      if (!old || old.status !== 'done' || ![old.creator, old.opponent].includes(me.id)) return fail('No such match to replay.', 404);
      forAcc = old.creator === me.id ? old.opponent : old.creator;
      const homeAcc = old.home ? old.opponent : old.creator;
      home = homeAcc === me.id ? 1 : 0; // the home side swaps: 1 means the invited player is home this time
    }
    const id = token(10), seed = rnd(1)[0];
    await env.DB.prepare('INSERT INTO fas_challenges (id, seed, creator, for_account, home, status, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)').bind(id, seed, me.id, forAcc, home, 'open', now, now + EXPIRY).run();
    return reply({ id, expires_at: now + EXPIRY });
  }
  if (fn === 'join') {
    const c = await loadChallenge(env, b.id);
    if (!c || expired(c)) return fail('This challenge has run out.', 410);
    if (c.creator === me.id) return fail('That is your own challenge. Send the link to a friend.', 400);
    if (c.opponent === me.id) return reply({ ok: true });
    if (c.status !== 'open') return fail('Someone else has already taken this challenge.', 409);
    if (c.for_account && c.for_account !== me.id) return fail('This challenge is for another manager.', 403);
    const r = await env.DB.prepare("UPDATE fas_challenges SET opponent = ?2, status = 'accepted' WHERE id = ?1 AND status = 'open'").bind(c.id, me.id).run();
    if (!r.meta.changes) return fail('Someone else has already taken this challenge.', 409);
    return reply({ ok: true });
  }
  if (fn === 'entry') {
    const c = await loadChallenge(env, b.id);
    if (!c || expired(c)) return fail('This challenge has run out.', 410);
    const side = c.creator === me.id ? 0 : c.opponent === me.id ? 1 : -1;
    if (side < 0) return fail('You are not in this challenge.', 403);
    if (c.status === 'done') return fail('Already played.', 409);
    const entry = { gk: b.gk, out: b.out, year: b.year };
    const err = AD.checkEntry(entry);
    if (err) return fail(err);
    const ins = await env.DB.prepare('INSERT INTO fas_entries (challenge_id, side, account_id, data, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING').bind(c.id, side, me.id, JSON.stringify(entry), now).run();
    if (!ins.meta.changes) return fail('You have already locked in.', 409);
    const c2 = await loadChallenge(env, c.id);
    if (c2.opponent) {
      const n = await env.DB.prepare('SELECT count(*) AS n FROM fas_entries WHERE challenge_id = ?1').bind(c.id).first();
      if (n.n === 2) { await finalize(env, c2); return reply({ status: 'done' }); }
    }
    return reply({ status: 'waiting' });
  }
  if (fn === 'result') {
    const c = await loadChallenge(env, b.id);
    if (!c || c.status !== 'done' || ![c.creator, c.opponent].includes(me.id)) return fail('No result here.', 404);
    const m = await env.DB.prepare('SELECT data FROM fas_matches WHERE challenge_id = ?1').bind(c.id).first();
    if (!m) return fail('No result here.', 404);
    const data = JSON.parse(m.data);
    const oppId = c.creator === me.id ? c.opponent : c.creator;
    return reply({ id: c.id, side: c.creator === me.id ? 0 : 1, deck: AD.challengeDeck(c.seed), match: data, h2h: await h2h(env, me.id, oppId) });
  }
  if (fn === 'h2h') {
    const opp = Number.isInteger(b.opp) ? b.opp : 0;
    const acc = await accountsByIds(env, [opp]);
    if (!acc[opp]) return fail('No such manager.', 404);
    return reply({ opp: acc[opp], h2h: await h2h(env, me.id, opp) });
  }
  if (fn === 'league') {
    const { results } = await env.DB.prepare(`
      SELECT a.id, a.name, a.kit, count(*) AS p, sum(r.pts = 3) AS w, sum(r.pts = 1) AS d, sum(r.pts = 0) AS l, sum(r.gf) AS gf, sum(r.ga) AS ga, sum(r.pts) AS pts
      FROM fas_results r JOIN fas_accounts a ON a.id = r.account_id GROUP BY a.id
      ORDER BY (1.0 * sum(r.pts) / count(*)) DESC, (sum(r.gf) - sum(r.ga)) DESC, sum(r.gf) DESC, a.name LIMIT 300`).all();
    return reply({ me: me.id, min: 4, rows: results.map((r) => ({ ...r, kit: JSON.parse(r.kit), ppg: r.pts / r.p })) });
  }
  return fail('Not found', 404);
}
