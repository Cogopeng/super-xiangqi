/* 超級象棋 · 大盤暗棋 — 音效模組
 * window.SFX.play(name) / setEnabled(bool) / enabled
 * 採用 HTMLAudioElement 小型 pool（file:// 直接雙擊也能播放，不用 fetch）。
 * 自動播放限制：使用者第一次互動前 play() 會被拒絕，這裡一律安靜吞掉。
 */
(function () {
  'use strict';
  var STORE_KEY = 'superxq.sfx.enabled';
  var MASTER = 0.9;

  // 事件 → 檔案（變體隨機）、音量、playbackRate 隨機幅度、每檔 pool 數
  var BANK = {
    'select':       { files: ['select-1'],                         vol: 0.55, jitter: 0.06, pool: 3 },
    'invalid':      { files: ['invalid-1'],                        vol: 0.55, jitter: 0.03, pool: 2 },
    'flip':         { files: ['flip-1', 'flip-2'],                 vol: 0.75, jitter: 0.06, pool: 3 },
    'move':         { files: ['move-1', 'move-2', 'move-3'],       vol: 0.75, jitter: 0.06, pool: 3 },
    'capture':      { files: ['capture-1', 'capture-2'],           vol: 0.85, jitter: 0.05, pool: 2 },
    'dark-capture': { files: ['dark-capture-1', 'dark-capture-2'], vol: 0.9,  jitter: 0.04, pool: 2 },
    'dark-own':     { files: ['dark-own-1'],                       vol: 0.75, jitter: 0.03, pool: 2 },
    'merge':        { files: ['merge-1'],                          vol: 1.0,  jitter: 0.03, pool: 2 },
    'shoot-kill':   { files: ['shoot-kill-1'],                     vol: 1.0,  jitter: 0.04, pool: 2 },
    'shoot-own':    { files: ['shoot-own-1'],                      vol: 0.8,  jitter: 0.04, pool: 2 },
    'pass':         { files: ['pass-1'],                           vol: 0.6,  jitter: 0.05, pool: 2 },
    'new-game':     { files: ['new-game-1'],                       vol: 0.75, jitter: 0.03, pool: 1 },
    'undo':         { files: ['undo-1'],                           vol: 0.65, jitter: 0.04, pool: 2 },
    'win':          { files: ['win-1'],                            vol: 0.85, jitter: 0,    pool: 1 },
    'lose':         { files: ['lose-1'],                           vol: 0.85, jitter: 0,    pool: 1 },
    'draw':         { files: ['draw-1'],                           vol: 0.85, jitter: 0,    pool: 1 }
  };

  // 以 sound.js 所在位置為基準找 sounds/，file:// 與 http:// 都適用
  var base = 'sounds/';
  try {
    var cs = document.currentScript;
    if (cs && cs.src) base = cs.src.replace(/[^\/]*(\?.*)?$/, '') + 'sounds/';
  } catch (e) { /* 用預設相對路徑 */ }

  var enabled = true;
  try {
    var saved = window.localStorage.getItem(STORE_KEY);
    if (saved === '0') enabled = false;
  } catch (e) { /* localStorage 不可用就預設開啟 */ }

  var hasAudio = typeof window.Audio === 'function';
  var pools = {};     // file → [HTMLAudioElement]
  var lastPick = {};  // name → 上次變體 index
  var lastTime = {};  // name → 上次播放時間（防止同一瞬間疊太多）

  function makeEl(file) {
    var el = new window.Audio(base + file + '.mp3');
    el.preload = 'auto';
    try { el.preservesPitch = false; el.mozPreservesPitch = false; el.webkitPreservesPitch = false; } catch (e) {}
    return el;
  }

  function getPool(file, size) {
    var p = pools[file];
    if (!p) {
      p = pools[file] = [];
      for (var i = 0; i < size; i++) p.push(makeEl(file));
    }
    return p;
  }

  function freeEl(p) {
    for (var i = 0; i < p.length; i++) if (p[i].paused || p[i].ended) return p[i];
    // 全部在播：拿最早開始的那個重頭播（或 cloneNode 再加一個，上限 6）
    if (p.length < 6) {
      var c = p[0].cloneNode(true);
      try { c.preservesPitch = false; c.mozPreservesPitch = false; c.webkitPreservesPitch = false; } catch (e) {}
      p.push(c);
      return c;
    }
    var best = p[0];
    for (var j = 1; j < p.length; j++) if (p[j].currentTime > best.currentTime) best = p[j];
    return best;
  }

  function now() {
    try { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); } catch (e) { return Date.now(); }
  }

  function play(name) {
    try {
      if (!enabled || !hasAudio) return;
      var cfg = BANK[name];
      if (!cfg) return;
      var t = now();
      if (lastTime[name] && t - lastTime[name] < 35) return;
      lastTime[name] = t;

      var n = cfg.files.length, k = 0;
      if (n > 1) {
        k = Math.floor(Math.random() * n);
        if (k === lastPick[name]) k = (k + 1 + Math.floor(Math.random() * (n - 1))) % n;
      }
      lastPick[name] = k;

      var el = freeEl(getPool(cfg.files[k], cfg.pool));
      try { el.pause(); el.currentTime = 0; } catch (e) {}
      el.volume = Math.max(0, Math.min(1, cfg.vol * MASTER));
      el.playbackRate = cfg.jitter ? 1 + (Math.random() * 2 - 1) * cfg.jitter : 1;
      var pr = el.play();
      if (pr && typeof pr.catch === 'function') pr.catch(function () { /* 自動播放限制或載入失敗：安靜略過 */ });
    } catch (e) { /* 任何錯誤都不往外丟 */ }
  }

  function stopAll() {
    for (var f in pools) {
      var p = pools[f];
      for (var i = 0; i < p.length; i++) { try { p[i].pause(); } catch (e) {} }
    }
  }

  function setEnabled(v) {
    enabled = !!v;
    try { window.localStorage.setItem(STORE_KEY, enabled ? '1' : '0'); } catch (e) {}
    if (!enabled) stopAll();
  }

  // 預先建立常用音效的 pool，讓第一次播放不延遲
  function warm() {
    if (!hasAudio) return;
    try {
      for (var name in BANK) {
        var cfg = BANK[name];
        for (var i = 0; i < cfg.files.length; i++) getPool(cfg.files[i], cfg.pool);
      }
    } catch (e) {}
  }
  warm();

  window.SFX = {
    play: play,
    setEnabled: setEnabled,
    get enabled() { return enabled; },
    names: Object.keys(BANK)
  };
})();
