// Roads.js — 1-cell-wide roads on the SHARED build grid (same grid as walls).
// Rendered as one tile per cell (no overlapping strips -> no z-fighting), with
// real corners. A 1-wide road threads the centre cell of a 3-wide gate. The
// network is generated with A* (turn penalty rewards straights; terrain cost
// keeps it on land and bridges only when forced).

import * as THREE from 'three';
import { astarGrid } from './astar.js?v=4';
import { TILE } from './IslandMap.js';

const ROAD_T = 0.5;   // road slab thickness — buried in the flat land, its side covers the drop at rough shore cells
const ROAD_REUSE = 0.1;   // A* cost of a cell that already has road — near-free so new roads merge onto it instead of running parallel
const ASPHALT = new THREE.MeshStandardMaterial({ color: '#5b5e63', roughness: 0.92, flatShading: true });
const DECK = new THREE.MeshStandardMaterial({ color: '#5f5640', roughness: 0.95, flatShading: true });   // dark structural slab under the planks
const RAIL = new THREE.MeshStandardMaterial({ color: '#544c3b', roughness: 0.9, flatShading: true });

// Plank decking texture — cross-planks (seam lines run along the canvas X axis, so
// after the top plane's rotateX(-90) they read as boards running EAST-WEST, i.e.
// across a north-south span). Per-plank shade + a faint lengthwise grain so the deck
// isn't a flat colour. Built once, shared by every bridge tile.
let _deckTex = null, _deckTopMat = null;
function deckTopMaterial() {
  if (_deckTopMat) return _deckTopMat;
  const S = 64, planks = 5, pw = S / planks;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#7a6e57'; ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < planks; i++) {
    const k = 0.86 + Math.random() * 0.22;                       // per-board tone
    ctx.fillStyle = `rgb(${Math.min(255, 122 * k) | 0},${Math.min(255, 110 * k) | 0},${Math.min(255, 87 * k) | 0})`;
    ctx.fillRect(0, i * pw, S, pw - 1);
    ctx.fillStyle = 'rgba(38,32,22,0.55)';                       // dark seam between boards
    ctx.fillRect(0, i * pw, S, 1.5);
  }
  ctx.globalAlpha = 0.07; ctx.fillStyle = '#332d20';             // faint lengthwise grain
  for (let x = 0; x < S; x += 3) ctx.fillRect(x, 0, 1, S);
  ctx.globalAlpha = 1;
  _deckTex = new THREE.CanvasTexture(cv);
  _deckTex.colorSpace = THREE.SRGBColorSpace;
  _deckTex.anisotropy = 4;
  _deckTopMat = new THREE.MeshStandardMaterial({ map: _deckTex, roughness: 0.92, flatShading: false });
  return _deckTopMat;
}

// Road-tile texture for ANY junction, keyed by which sides connect (n/s/e/w). One
// generator so every piece shares the orientation convention: canvas +x = world east,
// canvas +y = world south, so the markings line up tile-to-tile. The solid white
// lines trace the road's OUTLINE: they border open ground and break open wherever an
// arm connects — so a side road's edges stop at the junction instead of running into
// the through road. A dashed centre line runs out along each connected arm.
function makeRoadTexture(n, s, e, w) {
  // dash period (0.5*S) divides the tile, so the centre dashes carry across seams;
  // 2 dashes per tile reads as a proper centre line instead of a row of dots.
  const S = 128, c = S / 2, edge = S * 0.09, lw = Math.max(2, S * 0.05), dash = [S * 0.16, S * 0.34];
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#5b5e63'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 520; i++) { const v = 70 + (Math.random() * 36 | 0); g.fillStyle = `rgb(${v},${v},${v + 4})`; g.fillRect(Math.random() * S, Math.random() * S, 1, 1); }
  g.strokeStyle = '#e8e8e8'; g.lineWidth = lw; g.lineCap = 'butt';

  // a/b = the road's inner edges (offset `edge` from the tile border). The central
  // square is [a,b]x[a,b]; each connected arm is a strip from that square to the edge.
  const a = edge, b = S - edge;
  const seg = (x1, y1, x2, y2) => { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  g.setLineDash([]);
  // For each side: if an arm connects, draw the arm's two SIDE edges out to the tile
  // border; if not, cap that side of the central square (closing the outline).
  if (n) { seg(a, 0, a, a); seg(b, 0, b, a); } else { seg(a, a, b, a); }
  if (s) { seg(a, b, a, S); seg(b, b, b, S); } else { seg(a, b, b, b); }
  if (e) { seg(b, a, S, a); seg(b, b, S, b); } else { seg(b, a, b, b); }
  if (w) { seg(0, a, a, a); seg(0, b, a, b); } else { seg(a, a, a, b); }
  // Dashed centre line. Every arm is drawn from the tile EDGE inward (phased from the
  // edge, and the period divides S, so the dashes carry across seams). At a corner or
  // junction each arm stops a little short of the centre, leaving a clear box so no two
  // arms' dashes touch; a straight through-road (or a lone stub) runs to the centre.
  g.setLineDash(dash);
  const count = (n ? 1 : 0) + (s ? 1 : 0) + (e ? 1 : 0) + (w ? 1 : 0);
  const straight = count <= 1 || (n && s && !e && !w) || (e && w && !n && !s);
  const gap = straight ? 0 : edge * 1.4;   // clear radius around the centre at junctions
  if (n) seg(c, 0, c, c - gap);
  if (s) seg(c, S, c, c + gap);
  if (e) seg(S, c, c + gap, c);
  if (w) seg(0, c, c - gap, c);
  g.setLineDash([]);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Exported so the map designer can render hand-painted roads with the EXACT same
// tiles/textures/grade as the game (one source of truth) instead of a look-alike.
export class RoadTiles {
  constructor(cell, heightFn) {
    this.group = new THREE.Group();
    this.width = cell;
    this.heightFn = heightFn;   // (x,z) -> terrain height, for draping
    this._mats = new Map();     // junction-pattern (4-bit n/s/e/w) -> material, built on demand
  }

  clear() {
    this.group.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    this.group.clear();
  }

  // Material for a tile by which sides connect — cached so each of the ~14 junction
  // patterns bakes its texture once. A cell with no neighbours falls back to plain asphalt.
  matFor(n, s, e, w) {
    const key = (n ? 1 : 0) | (s ? 2 : 0) | (e ? 4 : 0) | (w ? 8 : 0);
    let m = this._mats.get(key);
    if (!m) {
      m = key === 0 ? ASPHALT
        : new THREE.MeshStandardMaterial({ map: makeRoadTexture(n, s, e, w), roughness: 0.92 });
      this._mats.set(key, m);
    }
    return m;
  }

  // One road tile: a flat asphalt BOX at a constant grade (not draped onto the terrain),
  // with a textured marking plane laid on top. All tiles share one height — a thin slab
  // just above the (flat) ground. The slab's THICKNESS is the point: where the terrain
  // dips below the grade (rough shore cells), its side face covers the gap so the road
  // reads as a solid edge instead of a thin ribbon floating / showing dirt through it.
  // The top plane carries the lane markings chosen from the connected sides (corners and
  // junctions get the right lines, not bare asphalt); a draped plane's rotateX(-90) UVs
  // map canvas-top→north / canvas-right→east, matching makeRoadTexture's convention.
  tile(x, z, gradeY, n, s, e, w) {
    const topY = gradeY + 0.06;
    const box = new THREE.Mesh(new THREE.BoxGeometry(this.width, ROAD_T, this.width), ASPHALT);
    box.position.set(x, topY - ROAD_T / 2, z);
    box.receiveShadow = true;
    this.group.add(box);
    const surfGeo = new THREE.PlaneGeometry(this.width, this.width);
    surfGeo.rotateX(-Math.PI / 2);
    const surf = new THREE.Mesh(surfGeo, this.matFor(n, s, e, w));
    surf.position.set(x, topY + 0.012, z);   // hair above the slab top, no z-fight
    surf.receiveShadow = true;
    this.group.add(surf);
  }

  // Raised plank bridge deck tile (over water). A rail runs along every side that is
  // NOT connected to more road — so a STRAIGHT gets rails on its two flanks and a
  // CORNER gets the L of rails on its two outer edges (the open-water sides), instead
  // of reusing the straight piece's fixed across-rails. n/s/e/w = a road continues
  // that way (land tile or another deck).
  deck(x, z, y, n, s, e, w) {
    const grp = new THREE.Group();
    const W = this.width;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, 0.16, W), DECK);
    slab.receiveShadow = true;
    grp.add(slab);
    // Textured plank top, just above the slab. Boards run across the N-S axis by
    // default; on an E-W run turn them a quarter so they still cross the lane.
    const topGeo = new THREE.PlaneGeometry(W, W);
    topGeo.rotateX(-Math.PI / 2);
    const top = new THREE.Mesh(topGeo, deckTopMaterial());
    top.position.y = 0.082;            // a hair above the 0.16-thick slab's top (0.08)
    if ((e || w) && !(n || s)) top.rotation.y = Math.PI / 2;   // E-W lane → turn the boards
    top.receiveShadow = true;
    grp.add(top);
    // Rail on each open-water (unconnected) side.
    const railX = () => new THREE.Mesh(new THREE.BoxGeometry(W, 0.45, 0.14), RAIL);   // runs east-west (caps a N/S edge)
    const railZ = () => new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.45, W), RAIL);   // runs north-south (caps an E/W edge)
    const addRail = (m, px, pz) => { m.position.set(px, 0.3, pz); grp.add(m); };
    if (!n) addRail(railX(), 0, -W / 2);
    if (!s) addRail(railX(), 0,  W / 2);
    if (!e) addRail(railZ(),  W / 2, 0);
    if (!w) addRail(railZ(), -W / 2, 0);
    // Plank is 0.16 thick (top sits ~0.08 above the centre); seat it AT the road grade
    // so the deck surface is flush with the draped road tiles (which lift ~0.07), instead
    // of floating a third of a unit over them.
    grp.position.set(x, y, z);
    this.group.add(grp);
  }
}

// Generates the road network with A* on the shared grid.
export class RoadNetwork {
  constructor(map, grid) {
    this.map = map;
    this.grid = grid;
    this.cell = grid.cell;
    this.tiles = new RoadTiles(grid.cell, (x, z) => this.map.heightAt(x, z));
    this.group = this.tiles.group;
    this._blocked = new Set();
    this._open = new Set();
    this._buffer = new Set();
  }

  setObstacles(camps) {
    this._blocked = new Set();
    this._open = new Set();
    this._buffer = new Set();
    const corridor = new Set();
    for (const c of camps) {
      for (const k of c.blockedCells) this._blocked.add(k);
      for (const k of c.openCells) this._open.add(k);
      // Keep the forced gate-exit corridor traversable (the one gap in the moat).
      for (const g of c.gates) {
        const gc = this._rc(g.pos.x, g.pos.z);
        const di = Math.round(g.outward.x), dj = Math.round(g.outward.z);
        for (let k = 0; k <= 3; k++) corridor.add((gc.i + k * di) + ',' + (gc.j + k * dj));
      }
    }
    // Moat: the ring of cells just outside any footprint (8-neighbourhood), minus
    // footprint and corridor. Roads can't hug a wall or dive back toward a gate.
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (const key of this._blocked) {
      const p = key.split(','), i = +p[0], j = +p[1];
      for (const [di, dj] of NB) {
        const nk = (i + di) + ',' + (j + dj);
        if (!this._blocked.has(nk) && !corridor.has(nk)) this._buffer.add(nk);
      }
    }
  }

  _rc(x, z) { const c = this.grid.worldToCell(x, z); return { i: c.cx, j: c.cz }; }   // map grid {cx,cz} -> A*/line {i,j}
  _inBounds(i, j) {
    const w = this.grid.cellToWorld(i, j);
    return Math.abs(w.x) <= this.map.worldW / 2 && Math.abs(w.z) <= this.map.worldH / 2;
  }
  _tileAt(i, j) { const w = this.grid.cellToWorld(i, j); return this.map.tileAt(w.x, w.z); }
  _isWater(i, j) { const t = this._tileAt(i, j); return t === TILE.SHALLOW || t === TILE.DEEP; }
  _cost(i, j) {
    const k = i + ',' + j;
    // Already-laid road → nearly free, so a later connection reuses it instead of running
    // a parallel road alongside. (Roads are only painted on passable cells, so this is
    // always safe to take — it can even share a bridge another road already built.)
    if (this._roadCells && this._roadCells.has(k)) return ROAD_REUSE;
    if (!this._open.has(k)) {
      if (this._blocked.has(k)) return Infinity;   // wall / interior — impassable
      if (this._buffer.has(k)) return 5000;        // moat ring — avoid unless truly forced
    }
    const t = this._tileAt(i, j);
    if (t === TILE.SAND || t === TILE.GRASS || t === TILE.ROCK) return 1;
    if (t === TILE.SHALLOW) return 8;
    return 22;   // deep water — only bridged when forced
  }

  // connections: [{ a:gate, b:gate, y }], gate = { pos:Vector3, outward:Vector3 }.
  build(connections) {
    this.tiles.clear();
    const cells = new Map();   // key -> { i, j, y }
    // Cells already carrying road. _cost charges almost nothing for these, so each new
    // connection's A* would rather detour onto an existing road and follow it than lay a
    // fresh path running parallel — the roads MERGE into a shared network.
    this._roadCells = new Set();
    const add = (i, j, y) => { const k = i + ',' + j; if (!cells.has(k)) cells.set(k, { i, j, y }); this._roadCells.add(k); };

    // Each gate gets a forced STRAIGHT exit: the road runs out from the gate's
    // centre cell along its outward normal for 2 cells before A* takes over. This
    // guarantees a clean perpendicular exit (A* can't immediately turn sideways
    // into the gate post), then pathfinding connects the two approach points
    // while steering around every wall (cost 500).
    const APPROACH = 2;
    const exit = (gate, y) => {
      const gc = this._rc(gate.pos.x, gate.pos.z);
      const di = Math.round(gate.outward.x), dj = Math.round(gate.outward.z);
      for (let k = 0; k <= APPROACH; k++) {
        const ci = gc.i + k * di, cj = gc.j + k * dj, key = ci + ',' + cj;
        if (this._open.has(key) || !this._blocked.has(key)) add(ci, cj, y);   // don't paint onto a foreign wall
      }
      return { i: gc.i + APPROACH * di, j: gc.j + APPROACH * dj };
    };
    for (const c of connections) {
      const sA = exit(c.a, c.y);
      const sB = exit(c.b, c.y);
      const path = astarGrid({
        start: sA, goal: sB,
        cost: (i, j) => this._cost(i, j),
        inBounds: (i, j) => this._inBounds(i, j),
        turnPenalty: 6,
      });
      // Safety net: never paint a tile onto a wall cell (guards the rare case
      // where an approach endpoint lands in a tightly-packed neighbour's footprint).
      if (path) for (const p of path) {
        const key = p.i + ',' + p.j;
        if (this._open.has(key) || !this._blocked.has(key)) add(p.i, p.j, c.y);
      }
    }
    this.cells = cells;   // exposed for verification (road-through-wall checks)

    // Render: classify each cell by its road neighbours -> straight/corner/etc.
    // Land tiles follow the terrain; bridge decks ride a level grade over water.
    const has = (i, j) => cells.has(i + ',' + j);
    // Bridge decks ride at the land/road grade so they meet the road flush, not hovering
    // above it. With flat land that's the plateau height (beachHeight + 0.8 — see padFor);
    // otherwise the old raised grade over the uneven terrain.
    const bridgeY = this.map.params.flatLand
      ? this.map.params.beachHeight + 0.8
      : this.map.params.beachHeight + 0.5;
    // Land roads are flat slabs at ONE grade (the flat land height); on the legacy hilly
    // map there's no single grade, so fall back to each cell's own terrain height.
    const roadGrade = this.map.params.flatLand ? this.map.params.beachHeight + 0.8 : null;
    for (const { i, j, y } of cells.values()) {
      const wx = i * this.cell, wz = j * this.cell;
      const n = has(i, j - 1), s = has(i, j + 1), e = has(i + 1, j), w = has(i - 1, j);
      if (this._isWater(i, j)) this.tiles.deck(wx, wz, Math.max(y, bridgeY), n, s, e, w);
      else this.tiles.tile(wx, wz, roadGrade != null ? roadGrade : y, n, s, e, w);
    }
  }
}
