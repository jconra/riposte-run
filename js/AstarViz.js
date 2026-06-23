// AstarViz.js — a stepped A* search visualizer rendered IN-WORLD. The real
// pathfinder runs in microseconds, so a "live" view would just flash the answer;
// instead we RECORD the whole search (via astarGrid's onStep hook) and replay it
// at a pace you control. The search is drawn to a transparent canvas that's mapped
// onto a flat PlaneGeometry hovering over the island, so the frontier crawls over
// the REAL bases/water and the path lands on the REAL roads. A slim DOM bar holds
// the transport (play/pause, single-step fwd+back, speed, scrub, grid select);
// you set start/goal by TAPPING the terrain.
//
// open(ctx) where ctx = { buildGrid, gridNames, defaultGrid, three, scene, camera,
//   domElement, cell, hoverY }.  buildGrid(name) -> { cost, inBounds,
//   bounds:{iMin,iMax,jMin,jMax}, allowDiagonal, turnPenalty } gives the REAL cost
// field for the chosen grid.

import { astarGrid } from './astar.js?v=4';

const C = {
  wall: 'rgba(10,16,24,0.60)', frontier: 'rgba(60,165,255,0.85)',
  visited: 'rgba(80,130,180,0.40)', current: 'rgba(255,210,60,0.95)',
  path: 'rgba(60,255,140,0.95)', start: 'rgba(60,255,140,1)', goal: 'rgba(255,80,80,1)',
  grid: 'rgba(255,255,255,0.05)',
};

export class AstarViz {
  constructor() {
    this.canvas = document.createElement('canvas');   // offscreen texture source
    this.ctx2d = this.canvas.getContext('2d');
    this._buildBar();
    this._open = false;
    this.gridName = null; this.grid = null;
    this.start = null; this.goal = null;
    this.trace = []; this.finalPath = null;
    this.idx = 0; this.playing = false;
    this.stepMs = msFromSlider(60); this._acc = 0; this._last = 0; this._raf = null;
    this._static = null; this._cell = 10; this._ox = 0; this._oy = 0;
    this.plane = null; this.tex = null;
    this._onPointer = (e) => this._pointer(e);
  }

  // ---- DOM control bar (transport only; the picture lives on the plane) -----
  _buildBar() {
    const bar = document.createElement('div');
    bar.id = 'astar-bar';
    bar.style.cssText = `position:fixed; left:50%; bottom:14px; transform:translateX(-50%);
      z-index:210; display:none; gap:9px; align-items:center; flex-wrap:wrap; justify-content:center;
      max-width:96vw; padding:8px 12px; border-radius:10px; background:rgba(8,12,18,0.86);
      border:1px solid rgba(255,255,255,0.16); box-shadow:0 4px 18px rgba(0,0,0,0.5);
      font-family:'Courier New',monospace; color:#cfe2f2; font-size:13px; letter-spacing:1px;
      touch-action:manipulation;`;
    bar.innerHTML = `
      <select id="av-grid" style="background:#10202e;color:#cfe2f2;border:1px solid #2b4257;padding:4px 6px;font-family:inherit;"></select>
      <button id="av-back" style="${btn()}">&lt;&lt; Step</button>
      <button id="av-play" style="${btn()}">Play</button>
      <button id="av-fwd"  style="${btn()}">Step &gt;&gt;</button>
      <span style="opacity:.7">Speed</span>
      <input id="av-speed" type="range" min="0" max="100" value="60" style="width:110px;">
      <input id="av-scrub" type="range" min="0" max="0" value="0" style="width:200px;">
      <span id="av-read" style="min-width:210px;opacity:.85;">tap terrain: START</span>
      <button id="av-reset" style="${btn()}">Reset pts</button>
      <button id="av-close" style="${btn()}">Close</button>`;
    document.body.appendChild(bar);
    this.bar = bar;
    const q = (id) => bar.querySelector('#' + id);
    this.read = q('av-read'); this.scrub = q('av-scrub'); this.gridSel = q('av-grid'); this.playBtn = q('av-play');
    q('av-play').onclick = () => this.togglePlay();
    q('av-fwd').onclick = () => { this.pause(); this.seek(this.idx + 1); };
    q('av-back').onclick = () => { this.pause(); this.seek(this.idx - 1); };
    q('av-reset').onclick = () => this._clearPoints();
    q('av-close').onclick = () => this.close();
    this.scrub.oninput = () => { this.pause(); this.seek(+this.scrub.value); };
    q('av-speed').oninput = (e) => { this.stepMs = msFromSlider(+e.target.value); };
    this.gridSel.onchange = () => this._selectGrid(this.gridSel.value);
  }

  // ---- open / close --------------------------------------------------------
  open(ctx) {
    this.buildGrid = ctx.buildGrid; this.THREE = ctx.three; this.scene = ctx.scene;
    this.camera = ctx.camera; this.domElement = ctx.domElement; this.cell = ctx.cell;
    this.hoverY = ctx.hoverY != null ? ctx.hoverY : 12;
    this.ray = new this.THREE.Raycaster();
    if (!this.plane) this._buildPlane();
    if (!this.plane.parent) this.scene.add(this.plane);
    this.plane.visible = true;
    this.gridSel.innerHTML = ctx.gridNames.map(n => `<option value="${n}">${n}</option>`).join('');
    this.bar.style.display = 'flex';
    window.addEventListener('pointerdown', this._onPointer, true);   // capture: grab taps before the game
    this._open = true;
    this._selectGrid(ctx.defaultGrid || ctx.gridNames[0]);
    return this;
  }
  close() {
    this.pause();
    this.bar.style.display = 'none';
    if (this.plane) this.plane.visible = false;
    window.removeEventListener('pointerdown', this._onPointer, true);
    this._open = false;
  }
  get isOpen() { return this._open; }

  _buildPlane() {
    const T = this.THREE;
    this.tex = new T.CanvasTexture(this.canvas);
    this.tex.minFilter = T.LinearFilter; this.tex.magFilter = T.NearestFilter; this.tex.generateMipmaps = false;
    const mat = new T.MeshBasicMaterial({ map: this.tex, transparent: true, depthWrite: false, side: T.DoubleSide });
    this.plane = new T.Mesh(new T.PlaneGeometry(1, 1), mat);
    this.plane.rotation.x = -Math.PI / 2;   // lie flat in XZ; +localX->+worldX, +localY->-worldZ
    this.plane.renderOrder = 999;
  }

  _selectGrid(name) {
    this.gridName = name; this.gridSel.value = name;
    this.grid = this.buildGrid(name);
    this._layout(); this._renderStatic(); this._clearPoints();
  }

  // Size the texture canvas (resolution) and place/scale the world plane to span
  // the grid: cell (i,j) sits above world (i*cell, j*cell).
  _layout() {
    const b = this.grid.bounds;
    const cols = b.iMax - b.iMin + 1, rows = b.jMax - b.jMin + 1;
    this._cell = Math.max(4, Math.min(16, Math.floor(1600 / Math.max(cols, rows))));   // px per cell in the texture
    this.canvas.width = cols * this._cell; this.canvas.height = rows * this._cell;
    this._ox = b.iMin; this._oy = b.jMin;
    const worldW = cols * this.cell, worldD = rows * this.cell;
    this.plane.scale.set(worldW, worldD, 1);
    this.plane.position.set(((b.iMin + b.iMax) / 2) * this.cell, this.hoverY, ((b.jMin + b.jMax) / 2) * this.cell);
  }

  _renderStatic() {
    const b = this.grid.bounds, s = this._cell, { cost } = this.grid;
    const off = document.createElement('canvas');
    off.width = this.canvas.width; off.height = this.canvas.height;
    const g = off.getContext('2d');   // transparent base — terrain shows through empty cells
    for (let i = b.iMin; i <= b.iMax; i++) for (let j = b.jMin; j <= b.jMax; j++) {
      if (!isFinite(cost(i, j))) { g.fillStyle = C.wall; g.fillRect((i - this._ox) * s, (j - this._oy) * s, s, s); }
    }
    if (s >= 6) {
      g.strokeStyle = C.grid; g.lineWidth = 1;
      for (let x = 0; x <= off.width; x += s) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, off.height); g.stroke(); }
      for (let y = 0; y <= off.height; y += s) { g.beginPath(); g.moveTo(0, y); g.lineTo(off.width, y); g.stroke(); }
    }
    this._static = off;
  }

  // ---- point picking (raycast the plane) -----------------------------------
  _pointer(e) {
    if (!this._open) return;
    if (e.target.closest && e.target.closest('#astar-bar')) return;   // let the control bar work
    e.stopPropagation();   // while open, taps drive the visualizer, not the game
    const rect = this.domElement.getBoundingClientRect();
    const ndc = new this.THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hit = this.ray.intersectObject(this.plane, false)[0];
    if (!hit) return;
    const c = { i: Math.round(hit.point.x / this.cell), j: Math.round(hit.point.z / this.cell) };
    if (!this.grid.inBounds(c.i, c.j) || !isFinite(this.grid.cost(c.i, c.j))) return;   // ignore walls/out
    if (!this.start || (this.start && this.goal)) { this.start = c; this.goal = null; this.read.textContent = 'tap terrain: GOAL'; this.trace = []; this.finalPath = null; this.draw(); }
    else { this.goal = c; this._run(); }
  }
  _clearPoints() {
    this.start = null; this.goal = null; this.trace = []; this.finalPath = null;
    this.idx = 0; this.scrub.max = 0; this.scrub.value = 0;
    if (this.read) this.read.textContent = 'tap terrain: START';
    this.draw();
  }

  // ---- run the search & build the trace ------------------------------------
  runFor(start, goal) { this.start = start; this.goal = goal; this._run(); return this._debug(); }
  _run() {
    const { cost, inBounds, allowDiagonal, turnPenalty } = this.grid;
    this.trace = [];
    this.finalPath = astarGrid({
      start: this.start, goal: this.goal, cost, inBounds,
      allowDiagonal: !!allowDiagonal, turnPenalty: turnPenalty ?? 4,
      onStep: (f) => this.trace.push(f),
    });
    this.idx = 0; this.scrub.max = Math.max(0, this.trace.length - 1); this.scrub.value = 0;
    this.seek(0);
    if (this.trace.length) this.play();
  }

  // ---- replay transport ----------------------------------------------------
  togglePlay() { this.playing ? this.pause() : this.play(); }
  play() {
    if (!this.trace.length) return;
    if (this.idx >= this.trace.length - 1) this.idx = 0;
    this.playing = true; this.playBtn.textContent = 'Pause';
    this._last = performance.now(); this._acc = 0;
    if (!this._raf) this._raf = requestAnimationFrame((t) => this._tick(t));
  }
  pause() {
    this.playing = false; if (this.playBtn) this.playBtn.textContent = 'Play';
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
  }
  _tick(t) {
    this._raf = null;
    if (!this.playing) return;
    this._acc += t - this._last; this._last = t;
    let advanced = false;
    while (this._acc >= this.stepMs && this.idx < this.trace.length - 1) { this._acc -= this.stepMs; this.idx++; advanced = true; }
    if (advanced) { this.scrub.value = this.idx; this.draw(); }
    if (this.idx >= this.trace.length - 1) { this.pause(); return; }
    this._raf = requestAnimationFrame((tt) => this._tick(tt));
  }
  seek(i) {
    if (!this.trace.length) { this.draw(); return; }
    this.idx = Math.max(0, Math.min(this.trace.length - 1, i));
    this.scrub.value = this.idx; this.draw();
  }

  // ---- drawing (-> texture) ------------------------------------------------
  draw() {
    if (!this.ctx2d) return;
    const ctx = this.ctx2d, s = this._cell;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this._static) ctx.drawImage(this._static, 0, 0);
    const px = (i) => (i - this._ox) * s, py = (j) => (j - this._oy) * s;
    if (this.trace.length) {
      const f = this.trace[this.idx];
      ctx.fillStyle = C.visited;
      for (let k = 0; k <= this.idx; k++) { const c = this.trace[k].cur; ctx.fillRect(px(c.i), py(c.j), s, s); }
      ctx.fillStyle = C.frontier;
      for (const o of f.open) ctx.fillRect(px(o.i) + 1, py(o.j) + 1, s - 2, s - 2);
      this._strokePath(f.path, C.path, Math.max(2, s * 0.3));
      ctx.fillStyle = C.current; ctx.fillRect(px(f.cur.i), py(f.cur.j), s, s);
      if (this.read) this.read.textContent = `step ${this.idx + 1}/${this.trace.length} · open ${f.open.length} · ${this.finalPath ? 'PATH ' + this.finalPath.length : (this.idx === this.trace.length - 1 ? 'NO PATH' : '…')}`;
    }
    if (this.goal && this.finalPath && this.idx >= this.trace.length - 1) this._strokePath(this.finalPath, C.path, Math.max(3, s * 0.4));
    if (this.start) this._marker(px(this.start.i), py(this.start.j), C.start);
    if (this.goal) this._marker(px(this.goal.i), py(this.goal.j), C.goal);
    if (this.tex) this.tex.needsUpdate = true;
  }
  _strokePath(path, color, w) {
    if (!path || path.length < 2) return;
    const ctx = this.ctx2d, s = this._cell, half = s / 2;
    ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    path.forEach((n, k) => { const x = (n.i - this._ox) * s + half, y = (n.j - this._oy) * s + half; k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  _marker(x, y, color) {
    const ctx = this.ctx2d, s = this._cell;
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, s * 0.28);
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
  }

  // ---- headless test hooks -------------------------------------------------
  _debug() {
    return {
      grid: this.gridName, steps: this.trace.length, idx: this.idx,
      playing: this.playing, pathLen: this.finalPath ? this.finalPath.length : 0,
      openNow: this.trace.length ? this.trace[this.idx].open.length : 0,
      planeInScene: !!(this.plane && this.plane.parent), planePos: this.plane ? [this.plane.position.x, this.plane.position.y, this.plane.position.z] : null,
    };
  }
}

function btn() {
  return `background:#13283a;color:#cfe2f2;border:1px solid #2b4257;padding:5px 10px;
    font-family:'Courier New',monospace;font-size:13px;cursor:pointer;border-radius:3px;`;
}
// Slider 0..100 -> step interval. 0 = fast (16ms), 100 = slow (700ms), eased so the
// low end (where stepping matters most) has fine control.
function msFromSlider(v) { const t = v / 100; return Math.round(16 + t * t * 684); }
