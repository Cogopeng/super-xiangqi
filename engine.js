/*
 * 超級象棋 · 大盤暗棋 — 規則引擎（純邏輯、無 DOM，瀏覽器與 Node 皆可用）
 *
 * 棋盤：8 欄 × 9 列 = 72 格，棋子放在格子裡，沒有河界。
 * 開局：32 顆蓋著，隨機放在棋盤格的「同色格」上（中間第 5 列留空），共 36 個同色格中的 32 個。
 *
 * 走法（每回合做一件事：翻棋 / 走 / 吃 / 射箭）：
 *   帥 K：直線 1～2 格（走 2 格時中間要空）
 *   仕 A：斜線衝，不限格數
 *   相 E：田（斜 2 格），塞象眼
 *   俥 R：直線不限格數
 *   傌 H：日，拐馬腳
 *   炮 C：一次走 1 格（直線）；吃子要隔一顆炮架，距離不限
 *   兵 P：直線 1 格
 * 所有棋子都能互吃，沒有大小。可暗吃：攻擊蓋著的棋，翻開是敵方就吃掉；是自己的就翻開、原地不動、回合結束。
 * 騎乘：己方兵與已翻開的傌/相/俥走到同一格即合體（不能下馬），移動同坐騎，另可射箭：
 *   騎傌、騎俥射周圍 1 格（8 格），騎相射周圍 2 格（5×5），箭不會被擋，可射暗棋；騎相射完要停一回合。
 *   合體被吃，兩顆一起死。
 * 勝負：吃光對方所有棋子獲勝；連續 100 步（50 回合）沒有翻棋或吃子判和；無棋可動時只能 pass。
 */
(function (root) {
  'use strict';

  const COLS = 8, ROWS = 9, N = COLS * ROWS;
  const TYPES = ['K', 'A', 'E', 'R', 'H', 'C', 'P'];
  const COUNTS = { K: 1, A: 2, E: 2, R: 2, H: 2, C: 2, P: 5 };
  const NAMES = {
    r: { K: '帥', A: '仕', E: '相', R: '俥', H: '傌', C: '炮', P: '兵' },
    b: { K: '將', A: '士', E: '象', R: '車', H: '馬', C: '砲', P: '卒' },
  };
  const SHOOT_RANGE = { H: 1, E: 2, R: 1 };
  const MOUNTS = { H: true, E: true, R: true };
  const DRAW_PLIES = 100;
  const ELEPHANT_REST_PLIES = 4; // 射完後，自己的下一回合不能動，再下一回合恢復

  const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  const idx = (c, r) => r * COLS + c;
  const colOf = i => i % COLS;
  const rowOf = i => (i / COLS) | 0;
  const inside = (c, r) => c >= 0 && c < COLS && r >= 0 && r < ROWS;
  const opp = color => (color === 'r' ? 'b' : 'r');

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function startSquares() {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      if (r === 4) continue;
      for (let c = 0; c < COLS; c++) if ((c + r) % 2 === 0) out.push(idx(c, r));
    }
    return out;
  }

  function newGame(rng) {
    rng = rng || Math.random;
    const pieces = [];
    let id = 0;
    for (const color of ['r', 'b'])
      for (const type of TYPES)
        for (let k = 0; k < COUNTS[type]; k++)
          pieces.push({ id: id++, color, type, revealed: false, riding: false, restUntil: 0 });
    shuffle(pieces, rng);
    const board = new Array(N).fill(null);
    startSquares().forEach((sq, i) => { board[sq] = pieces[i]; });
    return {
      board,
      turn: 0,                  // 輪到哪位玩家（0 / 1）
      playerColor: [null, null], // 第一次翻棋後決定
      ply: 0,
      quiet: 0,                 // 連續沒有翻棋 / 吃子的步數
      winner: null,             // null | 0 | 1 | 'draw'
      captured: { r: [], b: [] }, // 各色被吃掉的棋種
      lastAction: null,
      lastResult: null,
    };
  }

  function clone(s) {
    return {
      board: s.board.map(p => p && { ...p }),
      turn: s.turn,
      playerColor: s.playerColor.slice(),
      ply: s.ply,
      quiet: s.quiet,
      winner: s.winner,
      captured: { r: s.captured.r.slice(), b: s.captured.b.slice() },
      lastAction: s.lastAction,
      lastResult: s.lastResult,
    };
  }

  function canMerge(p, q) {
    if (p.riding || q.riding || !q.revealed || p.color !== q.color) return false;
    return (p.type === 'P' && MOUNTS[q.type]) || (MOUNTS[p.type] && q.type === 'P');
  }

  // p 能否走進 q 所在的格子（空格 / 暗吃 / 吃 / 合體）
  function canEnter(p, q) {
    if (!q) return true;
    if (!q.revealed) return true;
    if (q.color !== p.color) return true;
    return canMerge(p, q);
  }

  function moveTargets(s, from) {
    const b = s.board, p = b[from], out = [];
    const c0 = colOf(from), r0 = rowOf(from);
    const at = (c, r) => b[idx(c, r)];
    const tryAdd = (c, r) => { if (inside(c, r) && canEnter(p, at(c, r))) out.push(idx(c, r)); };
    const slide = dirs => {
      for (const [dc, dr] of dirs) {
        let c = c0 + dc, r = r0 + dr;
        while (inside(c, r)) {
          const q = at(c, r);
          if (!q) out.push(idx(c, r));
          else { if (canEnter(p, q)) out.push(idx(c, r)); break; }
          c += dc; r += dr;
        }
      }
    };
    const emptyAt = (c, r) => inside(c, r) && !at(c, r);

    switch (p.type) {
      case 'K':
        for (const [dc, dr] of ORTHO) {
          tryAdd(c0 + dc, r0 + dr);
          if (emptyAt(c0 + dc, r0 + dr)) tryAdd(c0 + 2 * dc, r0 + 2 * dr);
        }
        break;
      case 'P':
        for (const [dc, dr] of ORTHO) tryAdd(c0 + dc, r0 + dr);
        break;
      case 'A':
        slide(DIAG);
        break;
      case 'R':
        slide(ORTHO);
        break;
      case 'E':
        for (const [dc, dr] of DIAG) if (emptyAt(c0 + dc, r0 + dr)) tryAdd(c0 + 2 * dc, r0 + 2 * dr);
        break;
      case 'H':
        for (const [dc, dr] of ORTHO) {
          if (!emptyAt(c0 + dc, r0 + dr)) continue; // 拐馬腳
          if (dc) { tryAdd(c0 + 2 * dc, r0 + 1); tryAdd(c0 + 2 * dc, r0 - 1); }
          else { tryAdd(c0 + 1, r0 + 2 * dr); tryAdd(c0 - 1, r0 + 2 * dr); }
        }
        break;
      case 'C':
        for (const [dc, dr] of ORTHO) {
          if (emptyAt(c0 + dc, r0 + dr)) out.push(idx(c0 + dc, r0 + dr));
          let c = c0 + dc, r = r0 + dr, screen = false;
          while (inside(c, r)) {
            const q = at(c, r);
            if (q) {
              if (!screen) screen = true;
              else { if (!q.revealed || q.color !== p.color) out.push(idx(c, r)); break; }
            }
            c += dc; r += dr;
          }
        }
        break;
    }
    return out;
  }

  function shootTargets(s, from) {
    const p = s.board[from], out = [];
    if (!p || !p.riding) return out;
    const rg = SHOOT_RANGE[p.type], c0 = colOf(from), r0 = rowOf(from);
    for (let dr = -rg; dr <= rg; dr++)
      for (let dc = -rg; dc <= rg; dc++) {
        if (!dc && !dr) continue;
        const c = c0 + dc, r = r0 + dr;
        if (!inside(c, r)) continue;
        const q = s.board[idx(c, r)];
        if (q && (!q.revealed || q.color !== p.color)) out.push(idx(c, r));
      }
    return out;
  }

  function isResting(s, p) { return p.restUntil > s.ply; }

  function legalActions(s) {
    if (s.winner !== null) return [];
    const acts = [];
    const me = s.playerColor[s.turn];
    for (let i = 0; i < N; i++) {
      const p = s.board[i];
      if (!p) continue;
      if (!p.revealed) { acts.push({ type: 'flip', at: i }); continue; }
      if (!me || p.color !== me || isResting(s, p)) continue;
      for (const to of moveTargets(s, i)) acts.push({ type: 'move', from: i, to });
      for (const to of shootTargets(s, i)) acts.push({ type: 'shoot', from: i, to });
    }
    if (!acts.length) acts.push({ type: 'pass' });
    return acts;
  }

  const snap = p => p && { color: p.color, type: p.type, riding: p.riding };

  function kill(s, q) {
    s.captured[q.color].push(q.type);
    if (q.riding) s.captured[q.color].push('P');
  }

  // 回傳新狀態，不改動原狀態。s.lastResult 描述剛剛發生的事（給 UI / 紀錄用）。
  function apply(s0, a) {
    const s = clone(s0), b = s.board;
    let res;
    switch (a.type) {
      case 'flip': {
        const p = b[a.at];
        p.revealed = true;
        if (!s.playerColor[s.turn]) {
          s.playerColor[s.turn] = p.color;
          s.playerColor[1 - s.turn] = opp(p.color);
        }
        s.quiet = 0;
        res = { kind: 'flip', piece: snap(p) };
        break;
      }
      case 'move': {
        const p = b[a.from], q = b[a.to];
        if (!q) {
          b[a.to] = p; b[a.from] = null; s.quiet++;
          res = { kind: 'move', piece: snap(p) };
        } else if (!q.revealed) {
          q.revealed = true; s.quiet = 0;
          if (q.color !== p.color) {
            kill(s, q); b[a.to] = p; b[a.from] = null;
            res = { kind: 'dark-capture', piece: snap(p), target: snap(q) };
          } else {
            res = { kind: 'dark-own', piece: snap(p), target: snap(q) };
          }
        } else if (q.color !== p.color) {
          kill(s, q); b[a.to] = p; b[a.from] = null; s.quiet = 0;
          res = { kind: 'capture', piece: snap(p), target: snap(q) };
        } else {
          const mount = p.type === 'P' ? q : p;
          mount.riding = true;
          b[a.to] = mount; b[a.from] = null; s.quiet++;
          res = { kind: 'merge', piece: snap(mount) };
        }
        break;
      }
      case 'shoot': {
        const p = b[a.from], q = b[a.to];
        const hidden = !q.revealed;
        q.revealed = true; s.quiet = 0;
        if (q.color !== p.color) {
          kill(s, q); b[a.to] = null;
          res = { kind: 'shoot-kill', piece: snap(p), target: snap(q), hidden };
        } else {
          res = { kind: 'shoot-own', piece: snap(p), target: snap(q) };
        }
        if (p.type === 'E') p.restUntil = s.ply + ELEPHANT_REST_PLIES;
        break;
      }
      case 'pass':
        s.quiet++;
        res = { kind: 'pass' };
        break;
      default:
        throw new Error('unknown action ' + a.type);
    }
    res.player = s.turn;
    s.ply++;
    s.lastAction = a;
    s.lastResult = res;

    if (s.playerColor[0]) {
      const left = countPieces(s);
      if (!left.r || !left.b) {
        const survivor = left.r ? 'r' : 'b';
        s.winner = s.playerColor[0] === survivor ? 0 : 1;
      }
    }
    if (s.winner === null && s.quiet >= DRAW_PLIES) s.winner = 'draw';
    s.turn = 1 - s.turn;
    return s;
  }

  // 各色剩餘棋子數（含蓋著的；合體算 2 顆）
  function countPieces(s) {
    const left = { r: 0, b: 0 };
    for (const p of s.board) if (p && p.color) left[p.color] += p.riding ? 2 : 1;
    return left;
  }

  // ---- 給 AI 用的「不偷看」工具 ----

  // 從公開資訊推算目前蓋著的棋子組成：{ r: {K:1,...}, b: {...} }
  function hiddenPool(s) {
    const pool = { r: { ...COUNTS }, b: { ...COUNTS } };
    for (const p of s.board) {
      if (!p || !p.revealed) continue;
      pool[p.color][p.type]--;
      if (p.riding) pool[p.color].P--;
    }
    for (const color of ['r', 'b']) for (const t of s.captured[color]) pool[color][t]--;
    return pool;
  }

  // 把蓋著的棋子身分抹掉（color/type = null），只留公開資訊
  function publicView(s) {
    const v = clone(s);
    v.board = v.board.map(p => (p && !p.revealed ? { id: p.id, color: null, type: null, revealed: false, riding: false, restUntil: 0 } : p));
    return v;
  }

  // 依 hiddenPool 隨機指定每顆蓋著的棋子身分，得到一個「可能的」完整局面（可直接 apply 模擬）
  function determinize(view, rng) {
    rng = rng || Math.random;
    const s = clone(view);
    const pool = hiddenPool(s), bag = [];
    for (const color of ['r', 'b'])
      for (const t of TYPES)
        for (let k = 0; k < pool[color][t]; k++) bag.push([color, t]);
    shuffle(bag, rng);
    let k = 0;
    for (const p of s.board) {
      if (p && !p.revealed) { [p.color, p.type] = bag[k++]; }
    }
    return s;
  }

  const Engine = {
    COLS, ROWS, N, TYPES, COUNTS, NAMES, SHOOT_RANGE, DRAW_PLIES,
    idx, colOf, rowOf, opp,
    newGame, clone, legalActions, moveTargets, shootTargets, apply,
    countPieces, isResting, hiddenPool, publicView, determinize,
    nameOf: p => NAMES[p.color][p.type],
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  else root.Engine = Engine;
})(this);
