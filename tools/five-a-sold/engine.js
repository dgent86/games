/* Auction Draft engine: auction, AI managers, line-ups, match simulation, commentary. */
const AD = (() => {
  // ---------------- RNG and helpers
  let seedState = Date.now() >>> 0;
  function seed(s) { seedState = s >>> 0; }
  function rand() {
    seedState = (seedState + 0x6D2B79F5) >>> 0;
    let t = seedState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  function gauss() { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  function weighted(items, wts) { const t = wts.reduce((s, x) => s + x, 0); let r = rand() * t; for (let i = 0; i < items.length; i++) { r -= wts[i]; if (r <= 0) return items[i]; } return items[items.length - 1]; }

  // ---------------- Tunable constants (set by simulation)
  const T = {
    possK: 2, chanceBase: 0.40, chanceExp: 1,
    oneOnOneBase: 0.22, crossRate: 0.30,
    gStd: 0.30, g1v1: 0.45, gLong: 0.10, gLowCross: 0.32, gHeader: 0.26, gRebound: 0.38, gError: 0.45,
    goalExp: 1.4, quietShow: 0.12, minutes: 90, actionRate: 0.45
  };

  const TEMPO = { Hodgson: 0.78, Moyes: 0.85, Mourinho: 0.85, Dyche: 0.85, 'Benítez': 0.9, Allardyce: 0.92, Ancelotti: 0.95, Klopp: 1.08, Guardiola: 1.0 };
  const LULL = ['Not much happening out there', 'A scrappy spell in midfield', 'Both sides cancelling each other out', 'Very little goalmouth action', 'It has gone a bit quiet', 'Neither keeper has been troubled for a while', 'Plenty of huff and puff, not much end product'];
  // ---------------- Data
  const OUT = ['Fin', 'Pas', 'Dri', 'Pac', 'Def', 'Phy', 'Wrk', 'Com'], GKK = ['Sho', 'Pos', 'Dis', 'Com'];
  const W = { DEF: [0, .10, .05, .15, .35, .20, .10, .05], MID: [.10, .30, .15, .05, .10, .05, .15, .10], FWD: [.35, .10, .20, .15, 0, .10, 0, .10] };
  const GKW = [.5, .3, .1, .1];
  let PLAYERS = [], MANAGERS = [], COM = {};
  function init(data) {
    PLAYERS = data.players.map((r, i) => {
      const [n, pos, sec, club, season, born, ovr, a] = r;
      const attrs = {}; (pos === 'GK' ? GKK : OUT).forEach((k, j) => attrs[k] = a[j]);
      const age = parseInt(season.slice(0, 4)) - born;
      return { id: i, n, pos, sec, club, season, born, ovr, a: attrs, age };
    });
    MANAGERS = data.managers; COM = data.commentary;
  }
  function tags(p) {
    const t = [];
    if (p.pos !== 'GK') {
      if (p.a.Pac >= 16) t.push('Pace');
      if ((p.a.Pas + p.a.Dri) / 2 >= 16) t.push('Technique');
      if (p.a.Phy >= 16) t.push('Physical');
      if (p.a.Wrk >= 16) t.push('Work rate');
    }
    if (p.age <= 23) t.push('Youth');
    if (p.age >= 29) t.push('Experience');
    return t;
  }
  function freeAgent(pos) {
    const a = {}; (pos === 'GK' ? GKK : OUT).forEach(k => a[k] = 13);
    return { id: -1, n: 'Free agent', pos, sec: '', club: '', season: '', born: 0, ovr: 65, a, age: 27, fa: true };
  }

  // ---------------- Deck
  function buildDeck() {
    const by = { GK: [], DEF: [], MID: [], FWD: [] };
    PLAYERS.forEach(p => by[p.pos].push(p));
    const need = { GK: 3, DEF: 5, MID: 5, FWD: 5 };
    const topN = 3 + Math.floor(rand() * 3); // 3 to 5 top cards, hidden
    const deck = [], used = new Set();
    const slots = shuffle(['GK', 'GK', 'GK', 'DEF', 'DEF', 'DEF', 'DEF', 'DEF', 'MID', 'MID', 'MID', 'MID', 'MID', 'FWD', 'FWD', 'FWD', 'FWD', 'FWD']);
    slots.forEach((pos, i) => {
      const top = i < topN;
      const pool = by[pos].filter(p => !used.has(p.id) && (top ? p.ovr >= 86 : p.ovr < 86));
      // below the top cards, quality players are dealt more often: 84-85 x3, 82-83 x2, the rest x1
      const p = top ? pick(pool) : weighted(pool, pool.map(q => q.ovr >= 84 ? 3 : q.ovr >= 82 ? 2 : 1)); used.add(p.id); deck.push(p);
    });
    return shuffle(deck);
  }

  // ---------------- Ratings
  function slotRating(p, line, mods) {
    const m = mods || {};
    if (p.pos === 'GK') return p.ovr;
    const w = W[line];
    let s = 0;
    OUT.forEach((k, i) => {
      let v = p.a[k];
      if (m.pas && k === 'Pas') v = Math.min(20, v + m.pas);
      if (m.wrk && k === 'Wrk') v = Math.min(20, v + m.wrk);
      s += w[i] * v;
    });
    const fam = p.pos === line ? 1 : (p.sec === line ? 0.95 : 0.90);
    return 5 * s * fam;
  }
  function lineup(squad) {
    const gk = squad.find(p => p.pos === 'GK');
    const outs = squad.filter(p => p !== gk);
    const shapes = [[2, 1, 1], [1, 2, 1], [1, 1, 2]];
    let best = null;
    const perms = a => a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(r => [x, ...r]));
    perms(outs).forEach(order => shapes.forEach(sh => {
      const lines = [...Array(sh[0]).fill('DEF'), ...Array(sh[1]).fill('MID'), ...Array(sh[2]).fill('FWD')];
      let score = 0; const slots = order.map((p, i) => { score += slotRating(p, lines[i]); return { p, line: lines[i] }; });
      if (!best || score > best.score + 1e-9) best = { score, slots, shape: sh.join('-') };
    }));
    return { gk, slots: best.slots, shape: best.shape };
  }

  // ---------------- Auction
  const BUDGET = 20, TIMER = 10;
  function newGame(opts) {
    if (opts && opts.seed != null) seed(opts.seed);
    const mgr = JSON.parse(JSON.stringify(opts && opts.manager != null ? MANAGERS[opts.manager] : pick(MANAGERS)));
    const g = {
      deck: buildDeck(), idx: 0, lotNo: 0, contested: 0, log: [],
      H: { name: (opts && opts.humanName) || 'Mariners', isAI: false, budget: BUDGET, squad: [], refusals: 1 },
      A: { name: mgr.name + "'s XI", isAI: true, budget: BUDGET, squad: [], refusals: 1, mgr },
      ai: { perceived: {}, momentum: 0, tilt: false, starUsed: false, rerollAt: 6 + Math.floor(rand() * 7), rerolled: false },
      lot: null, done: false
    };
    if (mgr.name === 'Ranieri') reroll(g);
    return g;
  }
  function reroll(g) {
    const m = g.A.mgr;
    m.bias = [0, 0, 0].map(() => +(0.85 + rand() * 0.4).toFixed(2));
    const all = ['Pace', 'Technique', 'Physical', 'Work rate', 'Youth', 'Experience'];
    m.likes = [pick(all)]; m.dislikes = [pick(all.filter(x => x !== m.likes[0]))];
  }
  const hasGK = m => m.squad.some(p => p.pos === 'GK');
  const outCount = m => m.squad.filter(p => p.pos !== 'GK').length;
  const full = m => m.squad.length >= 5;
  function canSign(m, c) { if (full(m)) return false; return c.pos === 'GK' ? !hasGK(m) : outCount(m) < 4; }
  function maxBid(m) { return m.budget - (5 - m.squad.length - 1); }
  function gkLeft(g) { let n = 0; for (let i = g.idx; i < g.deck.length; i++) if (g.deck[i].pos === 'GK') n++; return n; }
  function isLastGK(g, c) { return c.pos === 'GK' && gkLeft(g) === 1; }
  const other = (g, m) => m === g.H ? g.A : g.H;
  function deckCounts(g) { const c = { GK: 0, DEF: 0, MID: 0, FWD: 0 }; for (let i = g.idx; i < g.deck.length; i++) c[g.deck[i].pos]++; return c; }

  function perceive(g, p, m) {
    // AI perception of a player, rolled once per card
    if (g.ai.perceived[p.id] != null) return g.ai.perceived[p.id];
    let bk = m.bk;
    if (m.name === 'Pochettino' && p.age <= 23) bk += 3;
    if (m.name === 'Redknapp' && m.clubs.includes(p.club)) bk += 2;
    const sd = Math.max(0, (11 - Math.min(bk, 10)) * 1.5);
    const v = p.ovr + gauss() * sd;
    g.ai.perceived[p.id] = v;
    return v;
  }
  function aiValue(g, c) {
    const A = g.A, m = A.mgr;
    const per = perceive(g, c, m);
    const slotsLeft = 5 - A.squad.length;
    const target = A.budget / slotsLeft;
    const q = Math.pow(2, (per - 80) / 7);
    let L = c.pos === 'GK' ? 1 : m.bias[['DEF', 'MID', 'FWD'].indexOf(c.pos)];
    const tg = tags(c);
    let S = 1;
    if (tg.some(t => m.likes.includes(t))) S *= 1.15;
    if (tg.some(t => m.dislikes.includes(t))) S *= 0.85;
    let C = m.clubs.includes(c.club) ? (m.name === 'Redknapp' ? 1.5 : 1.25) : 1;
    let aggr = m.aggr + (m.name === 'Klopp' ? g.ai.momentum : 0);
    if (m.name === 'Allardyce') {
      const avg = s => s.length ? s.reduce((t, p) => t + perceive(g, p, m), 0) / s.length : 80;
      if (A.squad.length && g.H.squad.length && avg(g.H.squad) - avg(A.squad) >= 5) aggr = 10;
    }
    const Af = 0.7 + 0.06 * Math.min(aggr, 12);
    // patience
    let elig = 0; for (let i = g.idx + 1; i < g.deck.length; i++) if (canSign(A, g.deck[i])) elig++;
    const P = elig >= 2 * slotsLeft ? 1 + (5 - m.pat) * 0.05 : 1.2;
    let v = target * q * L * S * C * Af * P;
    // line balance
    const lineCount = A.squad.filter(p => p.pos === c.pos).length;
    if (c.pos !== 'GK' && lineCount >= 2 && !(m.name === 'Guardiola' && c.pos === 'MID')) v *= 0.6;
    // quirks
    if (m.name === 'Wenger' && g.idx >= g.deck.length * 2 / 3) v *= 1.2;
    if (m.name === 'Mourinho' && ((c.pos === 'GK' && !hasGK(A)) || (c.pos === 'DEF' && !A.squad.some(p => p.pos === 'DEF')))) v *= 1.3;
    if (m.name === 'Ancelotti' && !g.ai.starUsed && per >= 90) v *= 1.3;
    if (m.name === 'Hodgson' && c.pos === 'DEF' && A.squad.filter(p => p.pos === 'DEF').length < 2) v *= 1.2;
    if (m.name === 'Keegan' && g.ai.tilt) v *= 1.3;
    if (m.name === 'Dyche' && per < 82) v *= 1.3;
    if (m.name === 'Redknapp' && g.idx + 1 < g.deck.length) {
      const nx = g.deck[g.idx + 1];
      if (nx.pos === c.pos && canSign(A, nx)) {
        const pn = perceive(g, nx, m);
        if (pn > per + 3) v *= 0.75; else if (pn < per - 3) v *= 1.15;
      }
    }
    let max = Math.floor(v);
    if (m.name === 'Benítez') max = Math.min(max, 7);
    if (m.name === 'Dyche') max = Math.min(max, 5);
    if (m.name === 'Ferguson' && per >= 88) max = Math.max(max, Math.floor(maxBid(g.H) / 2));
    if (aggr >= 8 && m.name !== 'Wenger' && rand() < 0.10) max += 1;
    max = Math.min(max, maxBid(A));
    return { raw: v, max, per, target, aggr };
  }

  function startLot(g) {
    if (g.done) return g.lot;
    if ((full(g.H) && full(g.A)) || g.idx >= g.deck.length) return finish(g);
    const c = g.deck[g.idx];
    const eH = canSign(g.H, c), eA = canSign(g.A, c);
    const lot = { card: c, no: ++g.lotNo, lastGK: isLastGK(g, c), high: 0, highBy: null, toAct: null, passes: 0, mode: null, result: null };
    g.lot = lot;
    if (g.A.mgr.name === 'Ranieri' && !g.ai.rerolled && g.lotNo >= g.ai.rerollAt) { reroll(g); g.ai.rerolled = true; }
    if (!eH && !eA) { lot.mode = 'skip'; lot.result = { type: 'skip', text: 'Neither side can sign him' }; return lot; }
    if (full(g.H) || full(g.A)) {
      const m = full(g.H) ? g.A : g.H;
      if (!canSign(m, c)) { lot.mode = 'skip'; lot.result = { type: 'skip', text: m.name + " can't sign him" }; return lot; }
      lot.mode = 'endgame'; lot.toAct = m; return lot;
    }
    if (eH !== eA) { lot.mode = 'offer'; lot.toAct = eH ? g.H : g.A; return lot; }
    lot.mode = 'auction';
    lot.toAct = (g.contested++ % 2 === 0) ? g.H : g.A;
    lot.opener = lot.toAct;
    return lot;
  }
  function sign(g, m, price, how) {
    const lot = g.lot, c = lot.card;
    m.squad.push(c); m.budget -= price;
    if (m.isAI && g.A.mgr.name === 'Ancelotti' && perceive(g, c, g.A.mgr) >= 90) g.ai.starUsed = true;
    lot.result = { type: 'sign', who: m, price, how };
    g.log.push({ card: c, who: m.isAI ? 'A' : 'H', price });
    return lot;
  }
  function discard(g, text) { g.lot.result = { type: 'discard', text }; g.log.push({ card: g.lot.card, who: null, price: 0 }); return g.lot; }
  function nextLot(g) { g.idx++; return startLot(g); }
  function canPass(g, m) {
    const lot = g.lot;
    if (lot.mode === 'auction') return !(lot.lastGK && !hasGK(m) && lot.highBy !== other(g, m) && lot.high + 1 <= maxBid(m));
    if (lot.mode === 'offer') return !(lot.lastGK && !hasGK(m));
    if (lot.mode === 'endgame') return m.refusals > 0 && !(lot.lastGK && !hasGK(m));
    return true;
  }
  function act(g, m, action) {
    // action: {type:'bid', amount} | {type:'pass'} | {type:'take'}
    const lot = g.lot;
    if (!lot || lot.result || lot.toAct !== m) return lot;
    if (lot.mode === 'offer' || lot.mode === 'endgame') {
      if (action.type === 'take' || !canPass(g, m)) return sign(g, m, 1, lot.mode);
      if (lot.mode === 'endgame') m.refusals--;
      return discard(g, m.name + (lot.mode === 'endgame' ? ' refuses him' : ' passes'));
    }
    // auction
    const o = other(g, m);
    if (action.type === 'bid') {
      const amt = Math.floor(action.amount);
      if (amt > lot.high && amt <= maxBid(m)) {
        lot.high = amt; lot.highBy = m; lot.toAct = o; lot.lastBid = { m, amt };
        if (lot.high >= maxBid(o) && !(lot.lastGK && !hasGK(o) && false)) { /* other cannot raise: still gets turn to pass */ }
        return lot;
      }
      action = { type: 'pass' };
    }
    if (!canPass(g, m)) { return act(g, m, { type: 'bid', amount: Math.max(1, lot.high + 1) }); }
    if (lot.highBy) {
      const w = lot.highBy;
      if (g.A.mgr.name === 'Klopp') g.ai.momentum = w.isAI ? g.ai.momentum + 1 : 0;
      if (g.A.mgr.name === 'Keegan') g.ai.tilt = !w.isAI && lot.aiBid ? true : false;
      return sign(g, w, lot.high, 'auction');
    }
    lot.passes++;
    if (lot.passes >= 2) return discard(g, 'Both sides pass');
    lot.toAct = o; return lot;
  }
  function aiAct(g) {
    const lot = g.lot, A = g.A;
    if (!lot || lot.result || lot.toAct !== A) return lot;
    const v = aiValue(g, lot.card);
    const forced = !canPass(g, A);
    if (lot.mode === 'offer') return act(g, A, { type: (forced || v.raw >= 0.6 * v.target) ? 'take' : 'pass' });
    if (lot.mode === 'endgame') {
      let el = 0; for (let i = g.idx + 1; i < g.deck.length; i++) if (canSign(A, g.deck[i])) el++;
      const refuse = !forced && A.refusals > 0 && v.raw < 0.5 * v.target && el > (5 - A.squad.length);
      return act(g, A, { type: refuse ? 'pass' : 'take' });
    }
    let cap = forced ? Math.max(v.max, Math.min(maxBid(A), lot.high + 1)) : v.max;
    if (lot.highBy == null) {
      if (!forced && A.mgr.name === 'Moyes' && v.per >= 88) return act(g, A, { type: 'pass' });
      if (cap >= 1) {
        lot.aiBid = true;
        const open = Math.max(1, Math.min(cap, Math.round((0.2 + 0.05 * v.aggr) * cap)));
        return act(g, A, { type: 'bid', amount: open });
      }
      return act(g, A, { type: 'pass' });
    }
    const need = lot.high + 1;
    if (need <= cap) {
      lot.aiBid = true;
      let amt = need;
      if (v.aggr >= 8 && cap - need >= 3 && rand() < 0.3) amt = need + 1;
      return act(g, A, { type: 'bid', amount: amt });
    }
    return act(g, A, { type: 'pass' });
  }
  function finish(g) {
    [g.H, g.A].forEach(m => {
      if (!hasGK(m) && m.squad.length < 5) m.squad.push(freeAgent('GK'));
      while (m.squad.length < 5) m.squad.push(freeAgent(['DEF', 'MID', 'FWD'][outCount(m) % 3]));
    });
    g.done = true; g.lot = null;
    return null;
  }

  // ---------------- Commentary
  const recent = {};
  function line(cat, ctx) {
    const pool = COM[cat]; if (!pool) return '';
    const r = recent[cat] || (recent[cat] = []);
    let opts = pool.filter(x => !r.includes(x)); if (!opts.length) opts = pool;
    // only lines whose placeholders we can fill
    const ok = opts.filter(x => (x.match(/\{\w+\}/g) || []).every(ph => ctx[ph.slice(1, -1)] != null));
    const s = pick(ok.length ? ok : opts);
    r.push(s); if (r.length > 3) r.shift();
    return s.replace(/\{(\w+)\}/g, (_, k) => ctx[k] != null ? ctx[k] : '');
  }

  // ---------------- Match
  function makeTeam(m, isHome, mgr) {
    const lu = lineup(m.squad);
    return { name: m.name, isHome, gk: lu.gk, slots: lu.slots, shape: lu.shape, mgr: mgr || null, sp: mgr ? mgr.special : null, goals: 0, scorers: {} };
  }
  function match(gm, opts) {
    const H = makeTeam(gm.H, true, null), A = makeTeam(gm.A, false, gm.A.mgr);
    return simulate(H, A, opts);
  }
  function simulate(H, A, opts) {
    const ev = []; const teams = [H, A];
    let score = [0, 0], minute = 0, htSwitch = null;
    const sp = (t, name) => t.sp === name;
    const scoreline = () => `${H.name} ${score[0]}, ${A.name} ${score[1]}`;
    const avgOvr = t => (t.gk.ovr + t.slots.reduce((s, x) => s + x.p.ovr, 0)) / 5;
    const ranieriBonus = t => sp(t, 'Underdog spirit') ? (avgOvr(t) < avgOvr(t === H ? A : H) ? 5 : 3) : 0;
    function pr(t, p, line) { // player rating in slot incl. specials and fatigue
      const mods = { pas: sp(t, 'Flowing football') ? 2 : 0, wrk: sp(t, 'Intensity') ? 2 : 0 };
      let r = slotRating(p, line, mods);
      if (sp(t, 'Calm authority') && p.ovr >= 86) r += 2;
      r += ranieriBonus(t);
      const fs = Math.round(T.minutes * (sp(t, 'Heavy-metal pressing') ? 0.62 : 0.75));
      if (minute >= fs) r *= 0.90 + 0.005 * Math.min(20, p.a.Wrk + mods.wrk);
      return r;
    }
    function lineStr(t, line) {
      const ps = t.slots.filter(s => s.line === line);
      let v = ps.reduce((s, x) => s + pr(t, x.p, line), 0) / ps.length;
      const o = t === H ? A : H, ti = t === H ? 0 : 1, my = score[ti], their = score[1 - ti];
      if (line === 'MID' && sp(t, 'Positional play')) v *= 1.06;
      if (line === 'MID' && sp(t, 'Heavy-metal pressing')) v *= 1.08;
      if (line === 'DEF' && sp(t, 'Organisation')) v *= 1.06;
      if (sp(t, 'Park the bus') && minute >= T.minutes * 0.75 && my > their) { if (line === 'DEF') v *= 1.12; if (line === 'FWD') v *= 0.90; }
      if (sp(t, 'Fergie time') && minute >= T.minutes * 0.875 && my <= their && line === 'FWD') v *= 1.10;
      if (htSwitch && htSwitch.t === t && htSwitch.line === line) v *= 1.08;
      return v;
    }
    const gkR = t => t.gk.ovr + ranieriBonus(t) + (sp(t, 'Calm authority') && t.gk.ovr >= 86 ? 2 : 0);
    const outfield = t => t.slots.map(s => s.p);
    const inLine = (t, l) => t.slots.filter(s => s.line === l).map(s => s.p);
    function pickShooter(t) {
      return weighted(t.slots.map(s => s.p), t.slots.map(s => ({ FWD: 3, MID: 2, DEF: 1 }[s.line]) * s.p.a.Fin));
    }
    function pickOther(t, not) { const c = outfield(t).filter(p => p !== not); return c.length ? pick(c) : outfield(t)[0]; }
    function pickDefender(t) { const d = inLine(t, 'DEF'); return d.length ? pick(d) : pick(outfield(t)); }
    const N = p => p.n;
    const ST = new Map();
    const st = p => { if (!ST.has(p)) ST.set(p, { g: 0, a: 0, sot: 0, miss: 0, def: 0, saves: 0, conc: 0, err: 0, og: 0, kp: 0, drb: 0, claim: 0 }); return ST.get(p); };
    const D = x => x ? '#D' + x : x;
    let pendingGoal = null;
    function push(lines, team, extra) { const e = Object.assign({ min: minute, team, lines: lines.filter(Boolean), score: score.slice() }, extra || {}); if (pendingGoal) { e.goal = pendingGoal; pendingGoal = null; } ev.push(e); }
    const ratio = (atk, def) => atk / Math.max(1, def);

    function goal(ti, scorer, assister, kind, lines) {
      const t = teams[ti], o = teams[1 - ti];
      const before = score.slice(); score[ti]++; t.goals++;
      t.scorers[scorer.n] = (t.scorers[scorer.n] || 0) + 1;
      if (kind === 'own') st(scorer).og++; else { st(scorer).g++; st(scorer).sot++; if (assister) st(assister).a++; }
      st(o.gk).conc++; inLine(o, 'DEF').forEach(p => st(p).conc++);
      const ctx = { shooter: N(scorer), team: t.name, opp: o.name, keeper: N(o.gk), assister: assister ? N(assister) : null, scoreline: scoreline() };
      if (minute >= T.minutes - 6) lines.push(line('late_drama', ctx));
      pendingGoal = { ti, n: scorer.n, min: minute, own: kind === 'own' };
      lines.push('@GOAL');
      if (kind === 'own') lines.push(line('own_goal', Object.assign({}, ctx, { defender: N(scorer) })));
      else {
        lines.push(line('goal_scorer', ctx));
        const cat = { long: 'goal_long', header: 'goal_header', rebound: 'goal_rebound', oneonone: 'goal_one_on_one' }[kind] || (rand() < 0.15 ? 'goal_close' : rand() < 0.5 ? 'goal_finish' : 'goal_keeper_beaten');
        lines.push(line(cat, ctx));
        const c = t.scorers[scorer.n];
        if (c === 2) lines.push(line('brace', ctx)); else if (c === 3) lines.push(line('hat_trick', ctx));
        if (assister && rand() < 0.7) lines.push(line('goal_assist', ctx));
      }
      const my = score[ti], th = score[1 - ti];
      const sl = my === th ? 'equaliser' : (before[ti] === before[1 - ti] ? 'go_ahead' : (my > th ? 'extend_lead' : 'pull_back'));
      lines.push(line(sl, ctx));
      return true;
    }

    function shot(ti, shooter, kind, lines, assister, round) {
      const t = teams[ti], o = teams[1 - ti], k = o.gk;
      const ctx = { shooter: N(shooter), keeper: N(k), team: t.name, opp: o.name };
      const leadCat = { std: 'shot', long: 'shot_long', oneonone: 'shot_one_on_one', lowcross: 'shot_low_cross', header: 'shot_header', rebound: 'shot_rebound', error: 'shot' }[kind];
      lines.push(line(leadCat, ctx));
      const gkRate = gkR(o) / 5; // keeper on a 1 to 20 scale
      const fin = (shooter.a.Fin + shooter.a.Com) / 2;
      let pg;
      if (kind === 'oneonone') pg = T.g1v1 * Math.pow(shooter.a.Com / Math.max(1, (k.a.Pos + gkRate) / 2), T.goalExp);
      else if (kind === 'long') pg = T.gLong * Math.pow(fin / Math.max(1, (k.a.Sho + gkRate) / 2), T.goalExp);
      else if (kind === 'header') pg = T.gHeader * Math.pow(((shooter.a.Fin + shooter.a.Phy) / 2) / ((k.a.Sho + k.a.Pos) / 2), T.goalExp) * (sp(t, 'Direct football') ? 1.2 : 1);
      else {
        const base = { std: T.gStd, lowcross: T.gLowCross, rebound: T.gRebound, error: T.gError }[kind];
        pg = base * Math.pow(fin / Math.max(1, (k.a.Sho + k.a.Pos) / 2), T.goalExp);
      }
      pg = clamp(pg, 0.02, 0.85);
      if (rand() < pg) return goal(ti, shooter, assister, kind === 'error' ? 'std' : kind, lines);
      // not a goal
      if (kind === 'lowcross' && rand() < 0.03) {
        const d = pickDefender(o);
        lines.push(line('own_goal_chance', { defender: N(d), keeper: N(k) }));
        return goal(ti, d, null, 'own', lines);
      }
      let out;
      if (kind === 'oneonone') out = weighted(['save1', 'missclose', 'wood'], [65, 25, 10]);
      else if (kind === 'long') out = weighted(['save', 'miss', 'wood', 'block'], [45, 45, 5, 5]);
      else out = weighted(['save', 'miss', 'block', 'wood'], [45, 30, 17 * (sp(o, 'Bodies on the line') ? 1.25 : 1), 8]);
      let loose = null;
      const d = pickDefender(o);
      const c2 = Object.assign({}, ctx, { defender: N(d) });
      if (out === 'save1') { lines.push(D(line('save_one_on_one', c2))); st(k).saves++; st(shooter).sot++; loose = rand() < 0.4 ? 'parry' : null; }
      else if (out === 'save') {
        const s = weighted(['save_comfortable', 'save_good', 'save_parry'], [40, 35, 25]);
        lines.push(D(line(s, c2))); st(k).saves++; st(shooter).sot++;
        if (s === 'save_parry') loose = 'parry'; else if (s === 'save_good' && rand() < 0.5) loose = 'parry';
      } else if (out === 'miss' || out === 'missclose') {
        let cat;
        if (kind === 'header') cat = 'header_miss';
        else {
          const grade = out === 'missclose' ? 'close' : weighted(['bad', 'normal', 'close'], [30, 40, 30]);
          const hl = kind === 'long' ? (rand() < 0.7 ? 'high' : 'low') : (rand() < 0.5 ? 'high' : 'low');
          cat = `miss_${grade}_${hl}`;
          if (grade === 'bad') st(shooter).miss++;
        }
        lines.push(line(cat, c2));
        if (rand() < 0.6) loose = 'miss';
      } else if (out === 'wood') { lines.push(line(rand() < 0.5 ? 'woodwork_post' : 'woodwork_bar', c2)); loose = 'wood'; }
      else if (out === 'block') { lines.push(D(line('blocked', c2))); st(d).def++; loose = 'block'; }
      if (loose) return looseBall(ti, loose, lines, round || 0);
      return false;
    }
    function looseBall(ti, kind, lines, round) {
      const t = teams[ti], o = teams[1 - ti];
      if (rand() < 0.5) lines.push(line('loose_ball', {}));
      const base = { parry: [35, 30, 25, 10], wood: [10, 40, 35, 15], block: [10, 50, 25, 15], miss: [50, 25, 10, 15] }[kind];
      const bestDef = Math.max(...outfield(o).map(p => p.a.Def));
      const att = pickShooter(t);
      const w = [
        base[0] * Math.pow(o.gk.a.Pos / 15, 2),
        base[1] * Math.pow(bestDef / 15, 2) * (sp(o, 'Bodies on the line') ? 1.1 : 1),
        base[2] * Math.pow(((att.a.Pac + att.a.Com) / 2) / 15, 2),
        base[3] * Math.pow(att.a.Wrk / 15, 2)
      ];
      let res = round >= 3 ? 'clear' : weighted(['keeper', 'clear', 'shoot', 'keep'], w);
      const d = pickDefender(o);
      const ctx = { keeper: N(o.gk), defender: N(d), player: N(att), team: t.name, shooter: N(att) };
      if (res === 'keeper') { lines.push(D(line('loose_keeper_smothers', ctx))); st(o.gk).claim++; return false; }
      if (res === 'clear') { lines.push(D(line('loose_defence_clears', ctx))); st(d).def++; return false; }
      if (res === 'keep') { lines.push(line('loose_attacker_recycles', ctx)); return false; }
      return shot(ti, att, 'rebound', lines, null, round + 1);
    }
    function attack(ti) {
      const t = teams[ti], o = teams[1 - ti];
      const lines = [];
      const carrier = weighted(outfield(t), t.slots.map(s => ({ DEF: 1, MID: 3, FWD: 2 }[s.line])));
      const ctx0 = { player: N(carrier), team: t.name };
      let att = lineStr(t, 'FWD'), def = lineStr(o, 'DEF');
      let c = T.chanceBase * Math.pow(ratio(att, def), T.chanceExp);
      if (sp(t, 'Entertainers') || sp(o, 'Entertainers')) c *= 1.15;
      if (sp(o, 'Hard to beat')) c *= 0.92;
      [t, o].forEach(x => { if (x.mgr && TEMPO[x.mgr.name]) c *= TEMPO[x.mgr.name]; });
      c = clamp(c, 0.05, 0.9);
      const chance = rand() < c;
      if (!chance) {
        if (rand() > T.quietShow) { push([], ti, { quiet: true }); return; }
        lines.push(line('receive', ctx0));
        if (rand() < 0.4) {
          const tg = pickOther(t, carrier);
          const isD = rand() >= 0.6; if (isD) st(carrier).drb++;
          lines.push(line(isD ? 'dribble' : 'pass', { player: N(carrier), target: N(tg), defender: N(pickDefender(o)) }));
        }
        const d = pickDefender(o);
        const to = weighted(['tackle', 'interception', 'clearance', 'keeper_claim', 'comes_to_nothing', 'error'], [35, 30, 15, 10, 10, 2]);
        if (to === 'error') {
          lines.push(line('defensive_error', { defender: N(d) })); st(d).err++;
          const s = pickShooter(t);
          shot(ti, s, 'error', lines, null, 0);
        } else {
          const tl = line(to, { defender: N(d), player: N(carrier), keeper: N(o.gk) });
          lines.push(to === 'comes_to_nothing' ? tl : D(tl));
          if (['tackle', 'interception', 'clearance'].includes(to)) st(d).def++;
          if (to === 'keeper_claim') { st(o.gk).claim++; if (rand() < 0.5) lines.push(D(line('keeper_distribution', { keeper: N(o.gk), target: N(pick(outfield(o))) }))); }
        }
        push(lines, ti); return;
      }
      lines.push(line('receive', ctx0));
      let builder = carrier;
      const nb = Math.floor(rand() * 3);
      for (let i = 0; i < nb; i++) {
        const tg = pickOther(t, builder);
        if (rand() < 0.65) { lines.push(line('pass', { player: N(builder), target: N(tg) })); builder = tg; }
        else { lines.push(line('dribble', { player: N(builder), defender: N(pickDefender(o)) })); st(builder).drb++; }
      }
      const shooter = pickShooter(t);
      const assister = shooter !== builder ? builder : null;
      const fastest = outfield(t).filter(p => p !== builder).sort((a, b) => b.a.Pac - a.a.Pac)[0] || shooter;
      const defP = pickDefender(o);
      const p1 = clamp(T.oneOnOneBase * Math.pow(fastest.a.Pac / Math.max(1, defP.a.Pac), 2), 0.05, 0.5);
      const crossRate = sp(t, 'Direct football') ? 0.45 : T.crossRate;
      if (rand() < p1) {
        const runner = fastest === builder ? shooter : fastest;
        lines.push(line(rand() < 0.75 ? 'through_ball' : 'long_ball', { player: N(builder), target: N(runner) })); st(builder).kp++;
        shot(ti, runner, 'oneonone', lines, builder !== runner ? builder : null, 0);
      } else if (rand() < crossRate) {
        const high = rand() < (sp(t, 'Direct football') ? 0.7 : 0.5);
        const crosser = builder === shooter ? pickOther(t, shooter) : builder;
        lines.push(line(high ? 'cross_high' : 'cross_low', { player: N(crosser) })); st(crosser).kp++;
        shot(ti, shooter, high ? 'header' : 'lowcross', lines, crosser, 0);
      } else {
        const mid = t.slots.find(s => s.p === shooter).line === 'MID';
        shot(ti, shooter, mid && rand() < 0.4 ? 'long' : 'std', lines, assister, 0);
      }
      push(lines, ti, { chance: true });
    }

    // ---- run
    const ctxK = { team: H.name, player: N(pick(outfield(H))) };
    push([line('kickoff', ctxK)], 0);
    let end = T.minutes, quietRun = 0;
    for (minute = 1; minute <= end; minute++) {
      if (minute === T.minutes) {
        teams.forEach((t, ti) => { if (sp(t, 'Fergie time') && score[ti] <= score[1 - ti]) end = T.minutes + 2 + Math.floor(rand() * 3); });
        if (end > T.minutes) push(['Added time on the board...|The pressure is on !'], null);
      }
      const g0 = score[0] + score[1];
      const mH = lineStr(H, 'MID'), mA = lineStr(A, 'MID');
      const pH = Math.pow(mH, T.possK) / (Math.pow(mH, T.possK) + Math.pow(mA, T.possK));
      const n0 = ev.length;
      if (rand() < T.actionRate) attack(rand() < pH ? 0 : 1);
      const seen = ev.length > n0 && !ev[ev.length - 1].quiet;
      if (!seen) { quietRun++; if (quietRun === 14) push([pick(LULL)], null, { lull: true }); } else quietRun = 0;
      if (score[0] + score[1] > g0) {
        const conceding = ev[ev.length - 1].team === 0 ? A : H;
        push([line('restart_after_goal', { team: conceding.name, player: N(pick(outfield(conceding))) })], null);
      }
      if (minute === Math.round(T.minutes * 0.75)) teams.forEach(t => outfield(t).forEach(p => { if (p.a.Wrk < 12 && rand() < 0.3) push([line('fatigue', { player: N(p) })], null); }));
      if (minute === T.minutes / 2) {
        const sl = scoreline();
        if (score[0] === score[1]) push(['@HT', line('half_time_draw', { scoreline: sl })], null, { ht: true });
        else push(['@HT', line('half_time_lead', { scoreline: sl, team: score[0] > score[1] ? H.name : A.name })], null, { ht: true });
        teams.forEach((t, ti) => {
          if (sp(t, 'Half-time switch') && score[ti] < score[1 - ti]) {
            const ls = ['DEF', 'MID', 'FWD'].filter(l => inLine(t, l).length).map(l => [l, lineStr(t, l)]).sort((a, b) => a[1] - b[1]);
            htSwitch = { t, line: ls[0][0] };
            push(['A change of approach from ' + t.name + ' at the break'], null);
          }
        });
        push([line('second_half', { team: A.name, player: N(pick(outfield(A))) })], null);
      }
    }
    minute = end;
    let winner = null, pens = null;
    if (score[0] !== score[1]) {
      winner = score[0] > score[1] ? 0 : 1;
      push(['@FT', line('full_time_win', { team: teams[winner].name, scoreline: scoreline() })], null, { ft: true });
    } else {
      push(['@FT', line('full_time_draw', { scoreline: scoreline() })], null, { ft: true });
      pens = shootout();
      winner = pens.winner;
    }
    function shootout() {
      const order = t => [...outfield(t)].sort((a, b) => b.a.Com - a.a.Com).concat([t.gk]);
      const ord = [order(H), order(A)], ps = [0, 0], taken = [0, 0], kicks = [];
      push([line('shootout_start', {})], null, { pens: true });
      let round = 0, sudden = false;
      while (true) {
        for (let ti = 0; ti < 2; ti++) {
          const t = teams[ti], o = teams[1 - ti];
          const tk = ord[ti][taken[ti] % 5]; taken[ti]++;
          const comp = tk.a.Com + (sp(t, 'Calm authority') ? 2 : 0);
          const kAvg = (o.gk.a.Sho + o.gk.a.Com + (sp(o, 'Calm authority') ? 2 : 0)) / 2;
          const p = clamp(0.75 + 0.02 * ((tk.pos === 'GK' ? 10 : (tk.a.Fin + comp) / 2) - kAvg), 0.55, 0.92);
          const ctx = { taker: N(tk), keeper: N(o.gk), team: t.name };
          const lines = [line('penalty_build', ctx)];
          const sc = rand() < p;
          if (sc) { ps[ti]++; lines.push(line('penalty_scored', ctx)); }
          else { const sv = rand() < 0.6; lines.push(sv ? D(line('penalty_saved', ctx)) : line('penalty_missed', ctx)); if (sv) st(o.gk).saves++; }
          kicks.push({ ti, sc, n: tk.n });
          push(lines, ti, { pen: true, pscore: ps.slice() });
          // early finish inside first 5
          if (!sudden) {
            const rem = [5 - taken[0], 5 - taken[1]];
            if (ps[0] > ps[1] + rem[1] || ps[1] > ps[0] + rem[0]) return fin();
          }
        }
        round++;
        if (sudden && ps[0] !== ps[1]) return fin();
        if (round === 5 && !sudden) { if (ps[0] !== ps[1]) return fin(); sudden = true; push([line('sudden_death', {})], null, { pens: true }); }
        if (round > 30) { ps[0]++; return fin(); }
      }
      function fin() {
        const w = ps[0] > ps[1] ? 0 : 1;
        push([line('shootout_win', { team: teams[w].name, opp: teams[1 - w].name })], null, { pens: true, pscore: ps.slice() });
        return { winner: w, score: ps, kicks };
      }
    }
    const goalPts = g => { let t = 0; for (let i = 0; i < g; i++) t += Math.max(0.4, 1 - 0.2 * i); return t; };
    const rate = (t, ti) => [{ p: t.gk, line: 'GK' }, ...t.slots].map(x => {
      const s = st(x.p);
      const res = winner === ti ? (pens ? 0.1 : 0.3) : (pens ? -0.1 : -0.3);
      const concW = x.line === 'GK' ? 0.35 : x.line === 'DEF' ? 0.15 : 0;
      let r = 6.0 + goalPts(s.g) + 0.5 * s.a + 0.12 * s.sot - 0.15 * s.miss + 0.15 * s.def + 0.12 * s.kp + 0.05 * s.drb
        + 0.3 * s.saves + 0.1 * s.claim - concW * s.conc - 0.8 * s.err - 1.0 * s.og + res + gauss() * 0.2;
      if (score[1 - ti] === 0 && (x.line === 'GK' || x.line === 'DEF')) r += 0.5;
      return { p: x.p, line: x.line, rating: Math.round(clamp(r, 3, 10) * 10) / 10, stats: s };
    });
    const ratings = [rate(H, 0), rate(A, 1)];
    return { events: ev, score, winner, pens, teams: [H, A], ratings };
  }

  return { init, seed, rand, newGame, startLot, nextLot, act, aiAct, aiValue, canPass, canSign, maxBid, hasGK, deckCounts, gkLeft,
    match, simulate, lineup, makeTeam, slotRating, tags, freeAgent, T, BUDGET, TIMER, get players() { return PLAYERS; }, get managers() { return MANAGERS; } };
})();
if (typeof module !== 'undefined') module.exports = AD;
