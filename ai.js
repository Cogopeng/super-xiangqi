/*
 * 超級象棋 · 大盤暗棋 — 電腦 AI
 *
 * 演算法：
 *   - 一進來先 Engine.publicView 抹掉隱藏資訊，之後完全不再碰原 state。
 *   - 只用公開資訊做「迭代加深 alpha-beta（negamax）+ 靜態搜尋（只看吃子 / 射殺）」。
 *   - 蓋著的棋在搜尋樹內視為「不動的牆」（不翻、不暗吃、不被射）。
 *     因為蓋著棋的身分只與「根節點動作」有關（翻棋 / 暗吃 / 射暗棋 / 走進暗格），
 *     所以這些根動作用「機會節點」處理：依 hiddenPool 的剩餘棋種機率，
 *     列舉（或分層取樣）它可能翻出什麼，各自往下搜，再加權平均（exact expectimax at root）。
 *   - 蓋著棋對估值的貢獻 = hiddenPool 的敵我價值總和（常數 K），翻開時隨結果扣除，
 *     所以「翻棋」本身材料中性，好壞來自翻出來後的戰術局面。
 *   - 時間預算控制：每過 128 個節點檢查一次時鐘，超時就丟掉未完成的那一層，用上一層結果。
 *
 * 估值：棋子價值（俥/仕/炮/傌/相/帥/兵）+ 騎乘加成（騎兵比兵+坐騎更值錢）+ 騎相休息中的懲罰
 *       + 領先時逼近對手、落後時遠離（避免無意義遊走）。
 * 難度：easy 淺搜 + 取樣少 + 雜訊 + 偶爾亂走；normal 中搜；hard 深搜 + 完整機率列舉。
 *
 * 選項（除了 level 之外，僅供測試）：options.depth（固定深度、不計時）、options.rng。
 */
(function (root) {
  'use strict';

  const Engine = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.Engine;
  const N = Engine.N, COLS = Engine.COLS;

  const VAL = { K: 42, A: 88, E: 52, R: 100, H: 62, C: 72, P: 26 };
  const RIDE_BONUS = { H: 38, E: 34, R: 55 };
  const REST_PENALTY = 18;
  const WIN = 100000;
  const INF = 1e9;
  const TIMEOUT = { timeout: true };

  const LEVELS = {
    easy:   { time: 100, maxDepth: 2, outcomes: 3,  noise: 45, blunder: 0.12 },
    normal: { time: 400, maxDepth: 4, outcomes: 8,  noise: 5,  blunder: 0 },
    hard:   { time: 900, maxDepth: 8, outcomes: 14, noise: 0,  blunder: 0 },
  };

  const pieceVal = p => VAL[p.type] + (p.riding ? VAL.P + RIDE_BONUS[p.type] : 0);
  const other = c => (c === 'r' ? 'b' : 'r');

  // ---------------- 搜尋狀態（原地 make / unmake） ----------------

  function make(S, m) {
    const b = S.board;
    const u = { m, kind: 0, p: null, q: null, mount: null, rest: 0 };
    if (m.k === 2) { // flip（目標格放在 m.to）
      const p = b[m.to]; p.revealed = true; u.p = p; u.kind = 9;
    } else if (m.k === 0) { // move
      const p = b[m.from], q = b[m.to];
      u.p = p; u.q = q;
      if (!q) { b[m.to] = p; b[m.from] = null; u.kind = 0; }
      else if (!q.revealed) {
        q.revealed = true;
        if (q.color !== p.color) { S.cnt[q.color]--; b[m.to] = p; b[m.from] = null; u.kind = 1; }
        else u.kind = 2;
      } else if (q.color !== p.color) {
        S.cnt[q.color] -= q.riding ? 2 : 1; b[m.to] = p; b[m.from] = null; u.kind = 3;
      } else {
        const mount = p.type === 'P' ? q : p;
        mount.riding = true; u.mount = mount; b[m.to] = mount; b[m.from] = null; u.kind = 4;
      }
    } else { // shoot
      const p = b[m.from], q = b[m.to];
      u.p = p; u.q = q; u.rest = p.restUntil;
      if (!q.revealed) {
        q.revealed = true;
        if (q.color !== p.color) { S.cnt[q.color]--; b[m.to] = null; u.kind = 5; } else u.kind = 6;
      } else { S.cnt[q.color] -= q.riding ? 2 : 1; b[m.to] = null; u.kind = 7; }
      if (p.type === 'E') p.restUntil = S.ply + 4;
    }
    S.ply++;
    S.stack.push(u);
    return u;
  }

  function unmake(S, u) {
    S.stack.pop();
    S.ply--;
    const b = S.board, m = u.m, p = u.p, q = u.q;
    switch (u.kind) {
      case 0: b[m.from] = p; b[m.to] = null; break;
      case 1: S.cnt[q.color]++; b[m.from] = p; b[m.to] = q; q.revealed = false; break;
      case 2: q.revealed = false; break;
      case 3: S.cnt[q.color] += q.riding ? 2 : 1; b[m.from] = p; b[m.to] = q; break;
      case 4: u.mount.riding = false; b[m.from] = p; b[m.to] = q; break;
      case 5: S.cnt[q.color]++; b[m.to] = q; q.revealed = false; p.restUntil = u.rest; break;
      case 6: q.revealed = false; p.restUntil = u.rest; break;
      case 7: S.cnt[q.color] += q.riding ? 2 : 1; b[m.to] = q; p.restUntil = u.rest; break;
      case 9: p.revealed = false; break;
    }
  }

  // ---------------- 估值（從 S.me 的角度） ----------------

  const myPos = new Int16Array(40), enPos = new Int16Array(40);

  function evalMe(S) {
    const b = S.board, me = S.me;
    let m = 0, nm = 0, ne = 0;
    for (let i = 0; i < N; i++) {
      const p = b[i];
      if (!p || !p.revealed) continue;
      let v = VAL[p.type];
      if (p.riding) {
        v += VAL.P + RIDE_BONUS[p.type];
        if (p.type === 'E' && p.restUntil > S.ply) v -= REST_PENALTY;
      }
      if (p.color === me) { m += v; if (p.type !== 'P' && p.type !== 'K') myPos[nm++] = i; }
      else { m -= v; enPos[ne++] = i; }
    }
    const lead = m + S.K;
    // 領先時逼近、落後時遠離
    if (nm && ne) {
      let a = lead / 150; if (a > 1) a = 1; else if (a < -1) a = -1;
      if (a > 0.05 || a < -0.05) {
        let d = 0;
        for (let x = 0; x < nm; x++) {
          const ci = myPos[x] % COLS, ri = (myPos[x] / COLS) | 0;
          let best = 9;
          for (let y = 0; y < ne; y++) {
            const dc = Math.abs(ci - enPos[y] % COLS), dr = Math.abs(ri - ((enPos[y] / COLS) | 0));
            const dd = dc > dr ? dc : dr;
            if (dd < best) best = dd;
          }
          d += best;
        }
        m -= a * 1.5 * (d / nm);
      }
    }
    return m + S.K;
  }

  function evalFor(S, color) {
    const v = evalMe(S);
    return color === S.me ? v : -v;
  }

  // ---------------- 走法產生 ----------------

  // 回傳 {k:0 move | 1 shoot, from, to, s: 排序分數}。蓋著的目標一律排除。
  function genMoves(S, color, capOnly) {
    const b = S.board, res = [];
    for (let i = 0; i < N; i++) {
      const p = b[i];
      if (!p || !p.revealed || p.color !== color || p.restUntil > S.ply) continue;
      const pv = pieceVal(p);
      const mt = Engine.moveTargets(S, i);
      for (let j = 0; j < mt.length; j++) {
        const to = mt[j], q = b[to];
        if (q) {
          if (!q.revealed) continue;
          if (q.color !== color) res.push({ k: 0, from: i, to, s: 1000 + pieceVal(q) * 10 - pv / 10 });
          else if (!capOnly) res.push({ k: 0, from: i, to, s: 600 });
        } else if (!capOnly) res.push({ k: 0, from: i, to, s: 0 });
      }
      if (p.riding) {
        const st = Engine.shootTargets(S, i);
        for (let j = 0; j < st.length; j++) {
          const to = st[j], q = b[to];
          if (!q.revealed) continue;
          res.push({ k: 1, from: i, to, s: 1005 + pieceVal(q) * 10 });
        }
      }
    }
    res.sort((x, y) => y.s - x.s);
    return res;
  }

  // ---------------- 搜尋 ----------------

  function tick(S) {
    if ((++S.nodes & 127) === 0 && Date.now() > S.deadline) throw TIMEOUT;
  }

  function qsearch(S, color, alpha, beta, qd) {
    tick(S);
    const stand = evalFor(S, color);
    if (qd <= 0 || stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const ms = genMoves(S, color, true);
    const opp = other(color);
    for (let i = 0; i < ms.length; i++) {
      const u = make(S, ms[i]);
      const v = S.cnt[opp] === 0 ? WIN : -qsearch(S, opp, -beta, -alpha, qd - 1);
      unmake(S, u);
      if (v >= beta) return v;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }

  function negamax(S, color, depth, alpha, beta, dist) {
    if (depth <= 0) return qsearch(S, color, alpha, beta, 6);
    tick(S);
    const ms = genMoves(S, color, false);
    if (!ms.length) return evalFor(S, color);
    const opp = other(color);
    let best = -INF;
    for (let i = 0; i < ms.length; i++) {
      const u = make(S, ms[i]);
      const v = S.cnt[opp] === 0 ? WIN - dist : -negamax(S, opp, depth - 1, -beta, -alpha, dist + 1);
      unmake(S, u);
      if (v > best) { best = v; if (v > alpha) alpha = v; }
      if (alpha >= beta) break;
    }
    return best;
  }

  // 根動作是否牽涉蓋著的棋
  function hiddenTarget(S, a) {
    if (a.type === 'flip') return a.at;
    if (a.type === 'move' || a.type === 'shoot') {
      const q = S.board[a.to];
      if (q && !q.revealed) return a.to;
    }
    return -1;
  }

  function toM(a) {
    return a.type === 'flip' ? { k: 2, from: a.at, to: a.at }
      : { k: a.type === 'move' ? 0 : 1, from: a.from, to: a.to };
  }

  // 機會節點：outcomes = [{c,t,w}]，權重總和 1
  function buildOutcomes(S, pool, maxOutcomes, rng) {
    const list = [];
    let total = 0;
    for (const c of ['r', 'b'])
      for (const t of Engine.TYPES) {
        const n = pool[c][t];
        if (n > 0) { list.push({ c, t, n }); total += n; }
      }
    if (!total) return [];
    if (list.length <= maxOutcomes) return list.map(o => ({ c: o.c, t: o.t, w: o.n / total }));
    // 系統取樣（等權重）
    const out = [], step = total / maxOutcomes;
    let pos = rng() * step, acc = 0, li = 0;
    for (let k = 0; k < maxOutcomes; k++, pos += step) {
      while (li < list.length - 1 && acc + list[li].n <= pos) { acc += list[li].n; li++; }
      out.push({ c: list[li].c, t: list[li].t, w: 1 / maxOutcomes });
    }
    return out;
  }

  function searchRoot(S, acts, hid, depth, outcomes, sgn, Kbase, deltaWin) {
    const vals = new Array(acts.length);
    let bestNH = -INF;
    const opp = S.opp;
    for (let i = 0; i < acts.length; i++) {
      const m = acts[i]._m;
      if (hid[i] < 0) {
        const u = make(S, m);
        let v;
        if (S.cnt[opp] === 0) v = WIN;
        else v = -negamax(S, opp, depth - 1, -INF, -(bestNH - deltaWin), 1);
        unmake(S, u);
        vals[i] = v;
        if (v > bestNH) bestNH = v;
      } else {
        const q = S.board[hid[i]];
        let sum = 0;
        for (let k = 0; k < outcomes.length; k++) {
          const o = outcomes[k];
          q.color = o.c; q.type = o.t; S.tmpQ = q;
          S.K = Kbase - (o.c === S.me ? 1 : -1) * VAL[o.t];
          const u = make(S, m);
          let v;
          if (S.cnt[opp] === 0) v = WIN;
          else v = -negamax(S, opp, depth - 1, -INF, INF, 1);
          unmake(S, u);
          q.color = null; q.type = null; S.tmpQ = null;
          sum += o.w * v;
        }
        S.K = Kbase;
        vals[i] = sum;
      }
    }
    return vals;
  }

  // ---------------- 重複局面記憶 ----------------

  let lastPly = -1;
  const seen = new Map();

  function posHash(board) {
    let s = '';
    for (let i = 0; i < N; i++) {
      const p = board[i];
      s += !p ? '.' : !p.revealed ? '?' : p.color + p.type + (p.riding ? 1 : 0);
    }
    return s;
  }

  // ---------------- 主入口 ----------------

  function gauss(rng) {
    return (rng() + rng() + rng() + rng() - 2) * 1.7;
  }

  function chooseAction(state, options) {
    options = options || {};
    const rng = options.rng || Math.random;
    const cfg = LEVELS[options.level] || LEVELS.normal;
    const t0 = Date.now();

    const view = Engine.publicView(state); // 之後絕不再碰 state
    const acts = Engine.legalActions(view);
    if (acts.length <= 1) return acts[0];

    if (view.ply < lastPly || view.ply === 0) seen.clear();
    lastPly = view.ply;

    const me = view.playerColor[view.turn];
    if (!me) return acts[Math.floor(rng() * acts.length)]; // 開局：隨便翻

    // 隨機失誤（easy）
    if (cfg.blunder && rng() < cfg.blunder) {
      const nonPass = acts.filter(a => a.type !== 'pass');
      return nonPass[Math.floor(rng() * nonPass.length)];
    }

    // ---- 建立搜尋狀態 ----
    const pool = Engine.hiddenPool(view);
    const S = {
      board: view.board, ply: view.ply, me, opp: other(me),
      cnt: { r: 0, b: 0 }, K: 0, nodes: 0, deadline: Infinity, stack: [], tmpQ: null,
    };
    let Kbase = 0;
    for (const p of S.board) if (p && p.revealed) S.cnt[p.color] += p.riding ? 2 : 1;
    for (const c of ['r', 'b'])
      for (const t of Engine.TYPES) {
        const n = pool[c][t];
        if (n > 0) { S.cnt[c] += n; Kbase += n * (c === me ? 1 : -1) * VAL[t]; }
      }
    S.K = Kbase;

    const outcomes = buildOutcomes(S, pool, cfg.outcomes, rng);

    // 根動作：隨機打亂（同分時不偏向），再依啟發式排序
    for (let i = acts.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = acts[i]; acts[i] = acts[j]; acts[j] = t;
    }
    const ordKey = a => {
      if (a.type === 'move' || a.type === 'shoot') {
        const q = S.board[a.to];
        if (q && q.revealed && q.color !== me) return 1000 + pieceVal(q);
        if (q && q.revealed) return 500;
        if (q) return 300;
        return 0;
      }
      return 100;
    };
    acts.sort((x, y) => ordKey(y) - ordKey(x));
    for (const a of acts) a._m = a.type === 'pass' ? null : toM(a);
    // pass 只會在唯一合法動作時出現（上面已回傳）
    const hid = acts.map(a => hiddenTarget(S, a));

    // ---- 迭代加深 ----
    const fixedDepth = options.depth;
    const budget = cfg.time;
    let result = null, resultActs = acts, resultHid = hid;
    let order = acts.map((_, i) => i);
    let lastElapsed = 0;
    const maxD = fixedDepth || cfg.maxDepth;
    for (let d = 1; d <= maxD; d++) {
      const ts = Date.now();
      S.nodes = 0;
      S.deadline = fixedDepth ? Infinity : t0 + (d === 1 ? budget * 1.2 : budget * 0.8);
      const curActs = order.map(i => acts[i]), curHid = order.map(i => hid[i]);
      let vals;
      try {
        vals = searchRoot(S, curActs, curHid, d, outcomes, 1, Kbase, 25);
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        while (S.stack.length) unmake(S, S.stack[S.stack.length - 1]);
        if (S.tmpQ) { S.tmpQ.color = null; S.tmpQ.type = null; S.tmpQ = null; }
        S.K = Kbase;
        break;
      }
      result = vals; resultActs = curActs; resultHid = curHid;
      // 依本層結果重排（下一層搜尋順序）
      const idxs = vals.map((_, i) => i).sort((x, y) => vals[y] - vals[x]);
      order = idxs.map(i => order[i]);
      let mx = -INF;
      for (const v of vals) if (v > mx) mx = v;
      if (mx >= WIN - 1000) break; // 找到必勝
      lastElapsed = Date.now() - ts;
      if (!fixedDepth && Date.now() - t0 + lastElapsed * 3 > budget * 0.8) break;
    }

    let chosen;
    if (!result) {
      chosen = acts[0];
    } else {
      // 重複局面懲罰 + 雜訊 + 翻棋小加成
      let mx = -INF;
      for (const v of result) if (v > mx) mx = v;
      let bestScore = -INF;
      for (let i = 0; i < resultActs.length; i++) {
        const a = resultActs[i];
        let sc = result[i];
        if (sc < mx - 60 && !cfg.noise) continue;
        if (resultHid[i] < 0 && sc >= mx - 60 && (a.type === 'move')) {
          const u = make(S, a._m);
          const h = posHash(S.board);
          unmake(S, u);
          a._h = h;
          const q = seen.get(h) || 0;
          sc -= 12 * q;
        }
        if (a.type === 'flip') sc += 2;
        if (cfg.noise) sc += gauss(rng) * cfg.noise;
        if (sc > bestScore) { bestScore = sc; chosen = a; }
      }
      if (!chosen) chosen = resultActs[0];
      if (chosen._h) seen.set(chosen._h, (seen.get(chosen._h) || 0) + 1);
    }
    if (chosen.type === 'flip') return { type: 'flip', at: chosen.at };
    if (chosen.type === 'pass') return { type: 'pass' };
    return { type: chosen.type, from: chosen.from, to: chosen.to };
  }

  const AI = { chooseAction, _VAL: VAL, _LEVELS: LEVELS, _make: make, _unmake: unmake, _reset() { seen.clear(); lastPly = -1; } };

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  else root.AI = AI;
})(this);
