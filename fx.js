/*
 * 超級象棋 · 視覺特效（game feel）
 * 只用 Web Animations API + CSS，無外部函式庫。
 *
 * 原則：
 *  - 「演員」（殘影、蓋著的背面、合體時跳上去的兵）放在格子裡：下一次 render 清空格子時自動消失，不會殘留重影。
 *  - 「粒子」（碎片、衝擊環、箭矢、字）放在 .board-frame 內的 .fx-layer 覆蓋層：不受重繪影響。
 *  - 一般動作 < 400ms，大事件 ≤ 900ms；prefers-reduced-motion 時只保留淡入淡出。
 */
(function () {
  'use strict';
  const E = window.Engine;

  const OUT = 'cubic-bezier(.2,.8,.2,1)';
  const IN = 'cubic-bezier(.55,0,.85,.45)';
  const SNAP = 'cubic-bezier(.3,1.45,.55,1)';
  const SOFT = 'cubic-bezier(.15,.7,.3,1)';
  const IMPACT = { r: '#e0503a', b: '#fbf3e1' };      // 衝擊環：紅方紅、黑方白
  const FACE_TINT = { r: 'rgba(184,38,28,.55)', b: 'rgba(30,26,22,.5)' };
  const GOLD = '#f3c96e';
  const ASH = 'rgba(232,226,214,.7)';
  const MOUNT = { H: 1, E: 1, R: 1 };

  let C = null;        // ctx
  let L = null;        // 覆蓋層
  let prev = null;     // 上一次 play 後的局面快照（用來判斷合體時是誰走過去）
  let shakeAnim = null;
  let banner = null;

  const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const later = (ms, fn) => setTimeout(() => { try { fn(); } catch (e) { console.error(e); } }, ms);
  const rand = (a, b) => a + Math.random() * (b - a);
  const done = (anim, fn) => { anim.finished.then(fn, () => {}); return anim; };

  // ---------- 基礎工具 ----------
  function layer() {
    const frame = C.board().parentElement;
    if (!L || L.parentElement !== frame) {
      L = document.createElement('div');
      L.className = 'fx-layer';
      frame.appendChild(L);
    }
    return L;
  }

  // 第 i 格在覆蓋層座標系的位置（震動時兩者一起位移，差值不變）
  function box(i) {
    const c = C.cell(i).getBoundingClientRect(), f = L.getBoundingClientRect();
    const x = c.left - f.left, y = c.top - f.top;
    return { x, y, w: c.width, h: c.height, cx: x + c.width / 2, cy: y + c.height / 2 };
  }

  const realPiece = i => C.cell(i).querySelector(':scope > .piece');

  function el(cls, parent, css) {
    const d = document.createElement('div');
    d.className = cls;
    if (css) Object.assign(d.style, css);
    (parent || L).appendChild(d);
    return d;
  }

  // 以引擎快照畫一顆棋（p 為 null 或 hidden=true 時畫背面）
  function makePiece(p, hidden) {
    const d = document.createElement('div');
    if (hidden || !p) { d.className = 'piece hidden'; return d; }
    d.className = 'piece face ' + p.color;
    d.textContent = E.NAMES[p.color][p.type];
    if (p.riding) {
      const bd = document.createElement('span');
      bd.className = 'badge rider';
      bd.textContent = E.NAMES[p.color].P;
      d.appendChild(bd);
    }
    return d;
  }

  // 放進格子裡的演員；under=true 放在真棋子下面
  function actor(i, pieceEl, under, z) {
    const cell = C.cell(i);
    const w = document.createElement('div');
    w.className = 'fx-ghost';
    w.appendChild(pieceEl);
    if (under) {
      w.style.zIndex = 0;
      cell.insertBefore(w, realPiece(i));
    } else {
      w.style.zIndex = z || 7;
      cell.appendChild(w);
    }
    return w;
  }

  // 覆蓋層上、與格子同大小的方盒
  function cellBox(b, child) {
    const d = el('fx-box', L, { left: b.x + 'px', top: b.y + 'px', width: b.w + 'px', height: b.h + 'px' });
    if (child) d.appendChild(child);
    return d;
  }

  function fadeKill(node, anim) { done(anim, () => node.remove()); return anim; }

  // ---------- 粒子 ----------
  function ring(cx, cy, size, color, o) {
    o = o || {};
    const r = el('fx-ring', L, {
      left: cx - size / 2 + 'px', top: cy - size / 2 + 'px', width: size + 'px', height: size + 'px',
      color, borderWidth: (o.width || 2) + 'px', opacity: 0,
    });
    return fadeKill(r, r.animate([
      { transform: `scale(${o.from == null ? .5 : o.from})`, opacity: o.alpha == null ? .95 : o.alpha },
      { transform: `scale(${o.to || 1.8})`, opacity: 0 },
    ], { duration: o.dur || 420, delay: o.delay || 0, easing: o.easing || SOFT, fill: 'forwards' }));
  }

  function flash(cx, cy, size, delay) {
    const f = el('fx-flash', L, { left: cx - size / 2 + 'px', top: cy - size / 2 + 'px', width: size + 'px', height: size + 'px', opacity: 0 });
    return fadeKill(f, f.animate([
      { opacity: 0, transform: 'scale(.6)' },
      { opacity: 1, transform: 'scale(1)', offset: .25 },
      { opacity: 0, transform: 'scale(1.25)' },
    ], { duration: 220, delay: delay || 0, easing: 'ease-out', fill: 'both' }));
  }

  function sparks(cx, cy, size, color, n, bias) {
    const base = rand(0, Math.PI * 2);
    for (let k = 0; k < n; k++) {
      let a = base + (k / n) * Math.PI * 2 + rand(-.2, .2);
      const len = size * rand(.14, .24);
      const r0 = size * .32, r1 = size * rand(.7, .95);
      const s = el('fx-spark', L, { width: len + 'px', background: color, opacity: 0 });
      const at = r => `translate(${cx + Math.cos(a) * r + (bias ? bias.ux * size * .15 : 0)}px,${cy + Math.sin(a) * r + (bias ? bias.uy * size * .15 : 0)}px) rotate(${a}rad)`;
      fadeKill(s, s.animate([
        { transform: at(r0) + ' scaleX(1)', opacity: 1 },
        { transform: at(r1) + ' scaleX(.15)', opacity: 0 },
      ], { duration: rand(260, 340), easing: SOFT, fill: 'both' }));
    }
  }

  // 棋子碎裂：把整顆棋（含字）用 clip-path 切成扇形碎片四散
  function shatter(b, snap, bias) {
    const n = 6, size = b.w;
    const base = rand(0, Math.PI * 2), step = Math.PI * 2 / n;
    const cut = [];
    for (let k = 0; k <= n; k++) cut.push(k === n ? cut[0] + Math.PI * 2 : base + k * step + rand(-.22, .22) * step);
    const ox = 50 + rand(-8, 8), oy = 50 + rand(-8, 8);
    const P = t => `${(ox + Math.cos(t) * 80).toFixed(1)}% ${(oy + Math.sin(t) * 80).toFixed(1)}%`;
    for (let k = 0; k < n; k++) {
      const a1 = cut[k], a2 = cut[k + 1], am = (a1 + a2) / 2;
      const d = cellBox(b, makePiece(snap));
      d.style.clipPath = d.style.webkitClipPath = `polygon(${ox}% ${oy}%, ${P(a1)}, ${P(am)}, ${P(a2)})`;
      const dist = size * rand(.38, .66);
      const tx = Math.cos(am) * dist + bias.ux * size * .3;
      const ty = Math.sin(am) * dist + bias.uy * size * .3 + size * .14;
      const rot = rand(-55, 55);
      fadeKill(d, d.animate([
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${tx * .5}px,${ty * .4}px) rotate(${rot * .45}deg)`, opacity: 1, offset: .22 },
        { transform: `translate(${tx}px,${ty}px) rotate(${rot}deg) scale(.82)`, opacity: 0 },
      ], { duration: rand(440, 540), easing: SOFT, fill: 'both' }));
    }
  }

  function shake(ux, uy, mag) {
    const frame = C.board().parentElement;
    if (shakeAnim) shakeAnim.cancel();
    const px = -uy, py = ux; // 垂直方向的小抖動
    const T = (a, b) => `translate(${(ux * a + px * b).toFixed(2)}px,${(uy * a + py * b).toFixed(2)}px)`;
    shakeAnim = frame.animate([
      { transform: 'translate(0,0)' },
      { transform: T(mag, .4), offset: .14 },
      { transform: T(-mag * .6, -.8), offset: .38 },
      { transform: T(mag * .3, .5), offset: .62 },
      { transform: T(-mag * .1, 0), offset: .84 },
      { transform: 'translate(0,0)' },
    ], { duration: 220, easing: 'linear' });
  }

  function word(text, cx, cy, size, cls, o) {
    o = o || {};
    const w = el('fx-word ' + cls, L, { fontSize: size + 'px', left: cx + 'px', top: cy + 'px', opacity: 0 });
    for (const ch of text) { const s = document.createElement('span'); s.textContent = ch; w.appendChild(s); }
    const rise = size * .35;
    return fadeKill(w, w.animate([
      { opacity: 0, transform: `translate(-50%,-50%) translateY(${rise}px)`, letterSpacing: o.spread || '.5em' },
      { opacity: 1, transform: 'translate(-50%,-50%) translateY(0)', letterSpacing: o.tight || '.12em', offset: .3 },
      { opacity: 1, transform: 'translate(-50%,-50%) translateY(0)', letterSpacing: o.tight || '.12em', offset: .7 },
      { opacity: 0, transform: `translate(-50%,-50%) translateY(${-rise * .6}px)`, letterSpacing: o.tight || '.12em' },
    ], { duration: o.dur || 700, delay: o.delay || 0, easing: OUT, fill: 'both' }));
  }

  // 翻牌：背面（演員，蓋在真棋子上）轉到側面消失，真棋子從側面轉回正面
  function cardFlip(i, delay, half, faceEl) {
    const face = faceEl || realPiece(i);
    const back = actor(i, makePiece(null, true), false, 7);
    const bp = back.firstChild;
    done(bp.animate([
      { transform: 'perspective(420px) rotateY(0deg) scale(1)' },
      { transform: 'perspective(420px) rotateY(90deg) scale(1.06)' },
    ], { duration: half, delay, easing: 'cubic-bezier(.5,0,.9,.6)', fill: 'both' }), () => back.remove());
    if (face) {
      face.animate([
        { transform: 'perspective(420px) rotateY(-90deg) scale(1.06)' },
        { transform: 'perspective(420px) rotateY(0deg) scale(1)' },
      ], { duration: half * 1.3, delay: delay + half, easing: OUT, fill: 'backwards' });
    }
    return delay + half;
  }

  function vec(from, to) {
    const f = box(from), t = box(to);
    const dx = f.x - t.x, dy = f.y - t.y, d = Math.hypot(dx, dy) || 1;
    return { f, t, dx, dy, d, ux: -dx / d, uy: -dy / d, cells: d / t.w };
  }

  // 落點衝擊：碎裂＋衝擊環＋火花＋閃光＋震動
  function impact(t, snap, color, bias, power) {
    flash(t.cx, t.cy, t.w * 1.5);
    shatter(t, snap, bias);
    ring(t.cx, t.cy, t.w * .8, IMPACT[color] || '#fff', { from: .55, to: 1.9, dur: 440, width: 2 });
    ring(t.cx, t.cy, t.w * .8, IMPACT[color] || '#fff', { from: .4, to: 1.25, dur: 300, width: 1, alpha: .6, delay: 40 });
    sparks(t.cx, t.cy, t.w, color === 'r' ? '#f6b08a' : '#fff6e0', 8, bias);
    shake(bias.ux, bias.uy, 3.5 * power);
  }

  function settle(p, from) {
    if (!p) return;
    p.animate([
      { transform: `scale(${from || 1.1})` },
      { transform: 'scale(.95)', offset: .45 },
      { transform: 'scale(1)' },
    ], { duration: 220, easing: 'ease-out' });
  }

  function lift(p, on) { if (p) p.style.zIndex = on ? 6 : ''; }

  // ---------- 各事件 ----------
  function fxFlip(a, res) {
    const p = realPiece(a.at), t = box(a.at);
    const tEnd = cardFlip(a.at, 0, 120);
    if (p) p.animate([{ translate: '0 0' }, { translate: '0 -3px', offset: .5 }, { translate: '0 0' }],
      { duration: 320, easing: 'ease-out' });
    ring(t.cx, t.cy, t.w * .84, FACE_TINT[res.piece.color], { from: .95, to: 1.4, dur: 380, width: 1.5, delay: tEnd + 40, alpha: .9 });
  }

  function fxMove(a) {
    const p = realPiece(a.to);
    const v = vec(a.from, a.to);
    const dur = Math.min(260, 150 + v.cells * 22);
    if (p) {
      lift(p, true);
      done(p.animate([
        { transform: `translate(${v.dx}px,${v.dy}px) scale(1)` },
        { transform: `translate(${v.dx * .45}px,${v.dy * .45}px) scale(1.07)`, offset: .45 },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: dur, easing: OUT }), () => lift(p, false));
    }
    later(dur * .8, () => ring(v.t.cx, v.t.cy, v.t.w * .84, 'rgba(255,246,224,.6)', { from: .9, to: 1.3, dur: 300, width: 1.5 }));
  }

  function fxCapture(a, res) {
    const p = realPiece(a.to);
    const v = vec(a.from, a.to);
    const ghost = actor(a.to, makePiece(res.target), true);
    const dur = Math.min(220, 120 + v.cells * 22);
    if (p) {
      lift(p, true);
      p.animate([
        { transform: `translate(${v.dx}px,${v.dy}px) scale(1.04)` },
        { transform: 'translate(0,0) scale(1.1)' },
      ], { duration: dur, easing: IN });
    }
    later(dur, () => {
      ghost.remove();
      impact(v.t, res.target, res.piece.color, v, 1);
      settle(p, 1.1);
      later(240, () => lift(p, false));
    });
  }

  function fxDarkCapture(a, res) {
    const p = realPiece(a.to);
    const v = vec(a.from, a.to);
    const ghost = actor(a.to, makePiece(null, true), true);
    // 逼近 → 停在目標前 → 目標翻開 → 拉弓蓄力 → 一擊
    const T = 420, tA = 130, tR = 330;
    const sx = -v.ux * v.t.w * .44, sy = -v.uy * v.t.w * .44;
    if (p) {
      lift(p, true);
      p.animate([
        { transform: `translate(${v.dx}px,${v.dy}px) scale(1.04)`, easing: OUT },
        { transform: `translate(${sx}px,${sy}px) scale(1.06)`, offset: tA / T },
        { transform: `translate(${sx * 1.25}px,${sy * 1.25}px) scale(1.06)`, offset: tR / T, easing: IN },
        { transform: 'translate(0,0) scale(1.12)' },
      ], { duration: T });
    }
    const gp = ghost.firstChild;
    gp.animate([
      { transform: 'perspective(420px) rotateY(0deg)' },
      { transform: 'perspective(420px) rotateY(90deg) scale(1.05)' },
    ], { duration: 90, delay: tA, easing: 'ease-in', fill: 'both' });
    later(tA + 90, () => {
      const face = makePiece(res.target);
      ghost.replaceChildren(face);
      face.animate([
        { transform: 'perspective(420px) rotateY(-90deg) scale(1.05)' },
        { transform: 'perspective(420px) rotateY(0deg) scale(1)' },
      ], { duration: 110, easing: OUT, fill: 'both' });
      ring(v.t.cx, v.t.cy, v.t.w * .84, FACE_TINT[res.target.color], { from: .95, to: 1.25, dur: 260, width: 1.5 });
    });
    later(T, () => {
      ghost.remove();
      impact(v.t, res.target, res.piece.color, v, 1.15);
      settle(p, 1.12);
      later(240, () => lift(p, false));
    });
  }

  function fxDarkOwn(a, res) {
    const p = realPiece(a.from);
    const v = vec(a.from, a.to);
    const bx = v.ux * v.t.w * .3, by = v.uy * v.t.w * .3;
    if (p) {
      lift(p, true);
      done(p.animate([
        { transform: 'translate(0,0)', filter: 'none', easing: OUT },
        { transform: `translate(${bx}px,${by}px) scale(1.04)`, filter: 'none', offset: .25 },
        { transform: `translate(${bx * .85}px,${by * .85}px) scale(.97)`, filter: 'grayscale(1) brightness(.85)', offset: .55, easing: 'ease-in-out' },
        { transform: 'translate(0,0) scale(1)', filter: 'none' },
      ], { duration: 460 }), () => lift(p, false));
    }
    cardFlip(a.to, 110, 90);
    // 灰色波紋：落空
    ring(v.t.cx, v.t.cy, v.t.w * .84, ASH, { from: .95, to: 1.7, dur: 560, width: 1.5, delay: 220, alpha: .8, easing: 'ease-out' });
    ring(v.t.cx, v.t.cy, v.t.w * .84, ASH, { from: .95, to: 1.35, dur: 480, width: 1, delay: 330, alpha: .5, easing: 'ease-out' });
  }

  function fxMerge(a, res) {
    const p = realPiece(a.to);
    const v = vec(a.from, a.to);
    const col = res.piece.color, mt = res.piece.type;
    // 判斷是兵跳上坐騎，還是坐騎走向兵
    let moverType = 'P';
    if (prev) {
      const pf = prev[a.from], pt = prev[a.to];
      if (pf && pt && pf.color === col && pt.color === col &&
          ((pf.type === 'P' && pt.type === mt) || (pf.type === mt && pt.type === 'P'))) moverType = pf.type;
    }
    const stayType = moverType === 'P' ? mt : 'P';
    const under = actor(a.to, makePiece({ color: col, type: stayType }), true);
    const mover = actor(a.to, makePiece({ color: col, type: moverType }), false, 8);
    const land = Math.min(300, 200 + v.cells * 25);
    const hop = v.t.w * .14;
    mover.firstChild.animate([
      { transform: `translate(${v.dx}px,${v.dy}px) scale(1)` },
      { transform: `translate(${v.dx * .5}px,${v.dy * .5 - hop}px) scale(1.24)`, offset: .5 },
      { transform: `translate(0,${-v.t.w * .06}px) scale(.96)` },
    ], { duration: land, easing: 'cubic-bezier(.35,.1,.45,1)', fill: 'both' });
    if (p) {
      lift(p, true);
      p.animate([
        { opacity: 0, transform: 'scale(1.18)' },
        { opacity: 1, transform: 'scale(1.18)', offset: .02 },
        { opacity: 1, transform: 'scale(.94)', offset: .45 },
        { opacity: 1, transform: 'scale(1)' },
      ], { duration: 300, delay: land, easing: 'ease-out', fill: 'backwards' });
      later(land + 320, () => lift(p, false));
    }
    later(land, () => {
      under.remove(); mover.remove();
      const t = v.t;
      const g = el('fx-glow', L, { left: t.cx - t.w + 'px', top: t.cy - t.w + 'px', width: t.w * 2 + 'px', height: t.w * 2 + 'px', opacity: 0 });
      fadeKill(g, g.animate([
        { opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(.9)', offset: .25 }, { opacity: 0, transform: 'scale(1.1)' },
      ], { duration: 520, easing: 'ease-out', fill: 'both' }));
      ring(t.cx, t.cy, t.w * .84, GOLD, { from: .9, to: 1.75, dur: 520, width: 2 });
      ring(t.cx, t.cy, t.w * .84, '#a8701c', { from: .9, to: 1.4, dur: 440, width: 1.5, delay: 90, alpha: .8 });
      const row = E.rowOf(a.to);
      const wy = row === 0 ? t.cy + t.w * .78 : t.cy - t.w * .8;
      word('合體', t.cx, wy, t.w * .36, 'gold', { dur: 640, spread: '.9em', tight: '.18em' });
    });
  }

  // 箭：細線＋箭頭＋尾羽（SVG），尾跡是一條淡金細線
  function makeArrow(len) {
    const NS = 'http://www.w3.org/2000/svg';
    const wrap = el('fx-arrow', L, { opacity: 0 });
    const svg = document.createElementNS(NS, 'svg');
    const h = 12;
    svg.setAttribute('width', len); svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `0 0 ${len} ${h}`);
    svg.style.left = -len + 'px'; svg.style.top = -h / 2 + 'px';
    const m = h / 2;
    svg.innerHTML =
      `<line x1="4" y1="${m}" x2="${len - 8}" y2="${m}" stroke="#3a2614" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M${len} ${m} L${len - 11} ${m - 4} L${len - 8} ${m} L${len - 11} ${m + 4} Z" fill="#24170b"/>` +
      `<path d="M0 ${m - 4} L7 ${m} M0 ${m + 4} L7 ${m} M4 ${m - 4} L11 ${m} M4 ${m + 4} L11 ${m}" stroke="#b8261c" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;
    wrap.appendChild(svg);
    return wrap;
  }

  function fxShoot(a, res) {
    const v = vec(a.from, a.to);
    const f = v.f, t = v.t;
    const shooter = realPiece(a.from);
    const ang = Math.atan2(v.uy, v.ux);
    const sx = f.cx + v.ux * f.w * .3, sy = f.cy + v.uy * f.w * .3;
    const ex = t.cx - v.ux * t.w * .12, ey = t.cy - v.uy * t.w * .12;
    const flight = Math.min(210, 110 + v.cells * 40);
    const pre = 70, hit = pre + flight;
    const kill = res.kind === 'shoot-kill';

    // 射手：蓄力縮一下 → 放箭後座力
    if (shooter) {
      lift(shooter, true);
      done(shooter.animate([
        { transform: 'translate(0,0) scale(1)' },
        { transform: `translate(${-v.ux * 2}px,${-v.uy * 2}px) scale(.93)`, offset: pre / 300 },
        { transform: `translate(${-v.ux * f.w * .09}px,${-v.uy * f.w * .09}px) scale(1.03)`, offset: (pre + 40) / 300 },
        { transform: 'translate(0,0) scale(1)' },
      ], { duration: 300, easing: 'ease-out' }), () => lift(shooter, false));
    }

    // 目標：蓋著的先畫背面；已翻開的畫殘影（shoot-kill 時目標格已清空）
    let ghost = null;
    if (kill) ghost = actor(a.to, makePiece(res.target, res.hidden), true);

    const arrow = makeArrow(Math.max(24, f.w * .78));
    const pos = (x, y) => `translate(${x}px,${y}px) rotate(${ang}rad)`;
    arrow.animate([
      { transform: pos(sx, sy), opacity: 0 },
      { transform: pos(sx + (ex - sx) * .15, sy + (ey - sy) * .15), opacity: 1, offset: .15 },
      { transform: pos(ex, ey), opacity: 1 },
    ], { duration: flight, delay: pre, easing: 'cubic-bezier(.3,0,.75,1)', fill: 'both' });
    const len = Math.hypot(ex - sx, ey - sy);
    const streak = el('fx-streak', L, { width: len + 'px', opacity: 0, transform: `translate(${sx}px,${sy}px) rotate(${ang}rad) scaleX(0)` });
    streak.animate([
      { transform: `translate(${sx}px,${sy}px) rotate(${ang}rad) scaleX(0)`, opacity: .9 },
      { transform: `translate(${sx}px,${sy}px) rotate(${ang}rad) scaleX(1)`, opacity: .9 },
    ], { duration: flight, delay: pre, easing: 'cubic-bezier(.3,0,.75,1)', fill: 'both' });
    later(hit, () => {
      fadeKill(streak, streak.animate([{ opacity: .9 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'both' }));
      if (kill) {
        // 命中：箭插住一瞬後消失
        fadeKill(arrow, arrow.animate([
          { transform: pos(ex, ey), opacity: 1 },
          { transform: pos(ex + v.ux * 3, ey + v.uy * 3), opacity: 0 },
        ], { duration: 160, delay: 50, easing: 'ease-in', fill: 'both' }));
      } else {
        // 落空：箭被彈開、下墜消失
        const dx = -v.ux * t.w * .25, dy = -v.uy * t.w * .25 + t.w * .25;
        fadeKill(arrow, arrow.animate([
          { transform: pos(ex, ey), opacity: 1 },
          { transform: `translate(${ex + dx}px,${ey + dy}px) rotate(${ang + (Math.random() < .5 ? -1.2 : 1.2)}rad)`, opacity: 0 },
        ], { duration: 260, easing: 'ease-out', fill: 'both' }));
      }
    });

    if (kill) {
      let strike = hit;
      if (res.hidden) {
        // 先翻開揭曉，再碎裂
        const gp = ghost.firstChild;
        gp.animate([
          { transform: 'perspective(420px) rotateY(0deg)' },
          { transform: 'perspective(420px) rotateY(90deg) scale(1.05)' },
        ], { duration: 70, delay: hit, easing: 'ease-in', fill: 'both' });
        later(hit + 70, () => {
          const face = makePiece(res.target);
          ghost.replaceChildren(face);
          face.animate([
            { transform: 'perspective(420px) rotateY(-90deg) scale(1.05)' },
            { transform: 'perspective(420px) rotateY(0deg) scale(1)' },
          ], { duration: 90, easing: OUT, fill: 'both' });
        });
        strike = hit + 210;
      }
      later(strike, () => {
        ghost.remove();
        impact(t, res.target, res.piece.color, v, .7);
      });
    } else {
      cardFlip(a.to, hit, 80);
      ring(t.cx, t.cy, t.w * .84, ASH, { from: .95, to: 1.6, dur: 520, width: 1.5, delay: hit + 80, alpha: .8, easing: 'ease-out' });
    }

    if (res.piece.type === 'E') {
      const row = E.rowOf(a.from);
      const wy = row === 0 ? f.cy + f.w * .72 : f.cy - f.w * .74;
      word('休', f.cx, wy, f.w * .32, 'mute', { delay: hit + 60, dur: 560, spread: '0', tight: '0' });
    }
  }

  function fxPass() {
    const bb = C.board().getBoundingClientRect(), fb = L.getBoundingClientRect();
    const cw = C.cell(0).getBoundingClientRect().width;
    word('過', bb.left - fb.left + bb.width / 2, bb.top - fb.top + bb.height / 2, cw * .9, 'mute', { dur: 600, spread: '0', tight: '0' });
  }

  // 減少動態：只用淡入淡出標出落點
  function fxReduced(a, res) {
    const i = a.to != null ? a.to : a.at;
    if (i == null) return;
    const t = box(i);
    const color = /capture|kill/.test(res.kind) ? (IMPACT[res.piece.color] || '#fff')
      : res.kind === 'merge' ? GOLD : /own/.test(res.kind) ? ASH : 'rgba(255,246,224,.6)';
    ring(t.cx, t.cy, t.w * .9, color, { from: 1, to: 1, dur: 360, width: 2, easing: 'ease-out' });
    if (res.kind === 'merge') word('合體', t.cx, E.rowOf(i) === 0 ? t.cy + t.w * .78 : t.cy - t.w * .8, t.w * .36, 'gold', { dur: 600, spread: '.18em', tight: '.18em' });
  }

  // ---------- 勝負字幕 ----------
  function dismissBanner(fast) {
    const b = banner;
    if (!b) return;
    banner = null;
    document.removeEventListener('pointerdown', b._onDown, true);
    clearTimeout(b._timer);
    fadeKill(b, b.animate([{ opacity: getComputedStyle(b).opacity }, { opacity: 0 }], { duration: fast ? 180 : 380, easing: 'ease-out', fill: 'both' }));
  }

  function showBanner(end) {
    if (!C) return;
    layer();
    dismissBanner(true);
    const s = C.state();
    const CN = { r: '紅', b: '黑' };
    const winColor = s && typeof s.winner === 'number' ? s.playerColor[s.winner] : null;
    const big = end === 'win' ? '勝' : end === 'lose' ? '敗' : '和';
    const sub = end === 'draw' ? '五十回合　無翻無吃' : winColor ? CN[winColor] + '方勝出' : '';
    const b = el('fx-banner ' + end, L);
    b.innerHTML = `<div class="row"><span class="rule l"></span><span class="big">${big}</span><span class="rule r"></span></div>` +
      (sub ? `<div class="sub">${sub}</div>` : '') + `<div class="fx-tip">點擊關閉</div>`;
    banner = b;
    const rm = reduced();
    b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out', fill: 'both' });
    const bigEl = b.querySelector('.big'), rules = b.querySelectorAll('.rule'), subEl = b.querySelector('.sub');
    if (!rm) {
      bigEl.animate([
        { opacity: 0, transform: 'scale(1.35)', filter: 'blur(10px)' },
        { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' },
      ], { duration: 560, delay: 60, easing: OUT, fill: 'both' });
      rules.forEach(r => r.animate([{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }],
        { duration: 560, delay: 220, easing: OUT, fill: 'both' }));
      if (subEl) subEl.animate([{ opacity: 0, transform: 'translateY(6px)', letterSpacing: '.9em' }, { opacity: 1, transform: 'translateY(0)', letterSpacing: '.5em' }],
        { duration: 520, delay: 340, easing: OUT, fill: 'both' });
      if (end === 'win') {
        const fb = L.getBoundingClientRect(), cb = bigEl.getBoundingClientRect();
        const cx = cb.left - fb.left + cb.width / 2, cy = cb.top - fb.top + cb.height / 2;
        ring(cx, cy, cb.height * 1.1, GOLD, { from: .6, to: 2.6, dur: 900, width: 1.5, delay: 120, alpha: .9 });
      }
    }
    b._onDown = () => dismissBanner(true);
    // 稍候再開始監聽，避免造成結束的那次點擊直接把字幕關掉
    later(250, () => { if (banner === b) document.addEventListener('pointerdown', b._onDown, true); });
    b._timer = setTimeout(() => { if (banner === b) dismissBanner(false); }, 2800);
  }

  // ---------- 對外介面 ----------
  function snapshot(s) { return s ? s.board.map(p => p && p.revealed ? { color: p.color, type: p.type } : null) : null; }
  // 玩家點擊會在同一個事件裡直接執行動作，先在捕獲階段記下動作前的局面
  document.addEventListener('click', () => { try { if (C) prev = snapshot(C.state()); } catch (e) {} }, true);

  window.FX = {
    play(res, action, ctx) {
      C = ctx;
      const state = ctx.state();
      try {
        if (!res || !action) return;
        layer();
        dismissBanner(true);
        if (reduced()) { if (res.kind !== 'pass') fxReduced(action, res); return; }
        switch (res.kind) {
          case 'flip': fxFlip(action, res); break;
          case 'move': fxMove(action, res); break;
          case 'capture': fxCapture(action, res); break;
          case 'dark-capture': fxDarkCapture(action, res); break;
          case 'dark-own': fxDarkOwn(action, res); break;
          case 'merge': fxMerge(action, res); break;
          case 'shoot-kill':
          case 'shoot-own': fxShoot(action, res); break;
          case 'pass': fxPass(); break;
        }
      } finally {
        prev = snapshot(state);
      }
    },
    gameOver(end, ctx) {
      C = ctx;
      // 讓最後一擊先打完，再浮出字幕
      later(reduced() ? 150 : 420, () => showBanner(end));
    },
  };
})();
