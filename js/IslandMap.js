// IslandMap.js — procedural archipelago on a square grid, Return Fire palette.
// Terrain is split into CHUNKS (separate meshes) so large maps stay cheap: each
// chunk frustum-culls independently. Normals are computed by finite difference
// from a shared global height field, so chunk seams stay invisible.
// Exposes sampling helpers so vehicles can ask "land or water?" at a world point.

import * as THREE from 'three';
import { Noise2D } from './noise.js';
import { makeTerrainMaterial } from './TerrainMaterial.js';

const CHUNK = 48;   // cells per chunk edge

// Default generation params. Every one of these is exposed to the controls panel.
export const DEFAULTS = {
  seed: 1337,
  cols: 480,         // grid cells across X (bigger island → bases/FOBs spread out)
  rows: 480,         // grid cells across Z
  tile: 1.0,         // world units per cell
  noiseScale: 3.6,   // higher = more, smaller islands
  octaves: 8,
  seaLevel: 0.4,     // height threshold for land; higher = less land
  edgeFalloff: 0.5,  // pull map borders down into ocean (archipelago framing)
  heightScale: 6.0,  // vertical exaggeration of terrain (Return Fire reads fairly flat)
  beachHeight: 1.0,  // world-height band (above water) that stays sand
  grassAmount: 0.6,  // 0 = no grass blobs, 1 = grass everywhere on land
};

// Return Fire-ish bright beach palette.
const C = {
  deep:    new THREE.Color('#15709c'),
  shallow: new THREE.Color('#3fb4d8'),
  wetsand: new THREE.Color('#c9b884'),
  sand:    new THREE.Color('#dcc88c'),
  grass:   new THREE.Color('#6f8f3a'),
  grassHi: new THREE.Color('#86a64a'),
  rock:    new THREE.Color('#8d8678'),
};

// Tile type codes used by gameplay sampling.
export const TILE = { DEEP: 0, SHALLOW: 1, SAND: 2, GRASS: 3, ROCK: 4 };
// Water-floor depth at/above which a land vehicle can WADE (ford) rather than
// drown. Floors run roughly -2.4 (sea bed) to 0 (shoreline); -0.8 leaves the
// shallow coastal fringe + puddles passable while the open sea (~85%) stays deep.
// Lower (more negative) = less wadeable water; raise toward 0 to ford less.
const FORD_DEPTH = -0.8;

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export class IslandMap {
  constructor() {
    this.group = new THREE.Group();
    this.params = { ...DEFAULTS };

    this.chunks = [];       // terrain chunk meshes
    this.water = null;

    // Shared global vertex fields (size = (cols+1)*(rows+1)).
    this._H = null;         // Float32Array world Y per vertex
    this._col = null;       // Float32Array rgb per vertex (water palette + land tint)
    this._grass = null;     // Float32Array macro grassiness 0..1 per vertex
    this._land = null;      // Float32Array 1 = land, 0 = water, per vertex
    this._grassNoise = null;
    this._terrainMat = null;

    // Per-cell classification grid (cols x rows).
    this.tileType = null;   // Uint8Array
    this.tileH = null;      // Float32Array, world Y of land surface (<=0 = underwater)

    // Flatten pads applied to terrain (filled by levelPads()).
    this.pads = [];
  }

  get worldW() { return this.params.cols * this.params.tile; }
  get worldH() { return this.params.rows * this.params.tile; }

  _clear() {
    for (const m of this.chunks) {
      this.group.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    }
    this.chunks = [];
    if (this.water) {
      this.group.remove(this.water);
      this.water.geometry.dispose();
      this.water.material.dispose();
      this.water = null;
    }
    if (this.seaFloor) {
      this.group.remove(this.seaFloor);
      this.seaFloor.geometry.dispose();
      this.seaFloor.material.dispose();
      this.seaFloor = null;
    }
    if (this._terrainMat) {
      for (const t of (this._terrainMat.userData.maps || [])) t.dispose();
      this._terrainMat.dispose();
      this._terrainMat = null;
    }
  }

  // Derive a vertex's colour, land flag, and grass field from its current
  // height (this._H[vi]). Used by pass 1 and by the flatten pass.
  _setAttribs(vi, u, v) {
    const p = this.params;
    const y = this._H[vi];
    const col = this._colorFor(y, u, v);
    this._col[vi * 3] = col.r;
    this._col[vi * 3 + 1] = col.g;
    this._col[vi * 3 + 2] = col.b;
    this._land[vi] = y > 0 ? 1 : 0;
    const gMacro = this._grassNoise.fbm(u * p.noiseScale * 1.5, v * p.noiseScale * 1.5, 3);
    this._grass[vi] = gMacro * smoothstep(0.05, 0.7, y);
  }

  // Colour for a vertex given its world height + grass-noise sample.
  _colorFor(y, u, v) {
    if (y <= 0) return y < -2.5 ? C.deep : (y < -0.6 ? C.shallow : C.wetsand);
    if (y < this.params.beachHeight) return C.sand;
    const g = this._grassNoise.fbm(u * this.params.noiseScale * 2.0, v * this.params.noiseScale * 2.0, 4);
    if (g < 1 - this.params.grassAmount) return C.sand;
    if (y > this.params.beachHeight + 4.0) return C.rock;
    return g > 0.78 ? C.grassHi : C.grass;
  }

  // (Re)build everything from the current params (optionally patched).
  generate(patch = {}) {
    Object.assign(this.params, patch);
    const p = this.params;
    this.pads = [];
    this._clear();

    const noise = new Noise2D(p.seed);
    this._grassNoise = new Noise2D(p.seed ^ 0x9e3779b9);

    const VX = p.cols + 1, VZ = p.rows + 1;
    this._H = new Float32Array(VX * VZ);
    this._col = new Float32Array(VX * VZ * 3);
    this._grass = new Float32Array(VX * VZ);
    this._land = new Float32Array(VX * VZ);
    this._terrainMat = makeTerrainMaterial(p.seed, p.grassAmount);

    // Pass 1: per-vertex world height, water/land colour, and a SMOOTH macro
    // grassiness field. The crisp grass/sand edge is carved later in the shader
    // from a noise mask — keeping this field smooth is what makes that work.
    let vi = 0;
    for (let gz = 0; gz < VZ; gz++) {
      for (let gx = 0; gx < VX; gx++, vi++) {
        const u = gx / p.cols, v = gz / p.rows;
        let nh = noise.fbm(u * p.noiseScale, v * p.noiseScale, p.octaves);
        const dx = (u - 0.5) * 2, dz = (v - 0.5) * 2;
        const edge = smoothstep(0.35, 1.0, Math.min(1, Math.sqrt(dx * dx + dz * dz)));
        nh = Math.max(0, nh - p.edgeFalloff * edge);
        this._H[vi] = (nh - p.seaLevel) * p.heightScale;
        this._setAttribs(vi, u, v);
      }
    }

    this._buildChunks(VX, VZ);
    this._buildWater();
    this._classify(VX, VZ);
    return this;
  }

  // Build one mesh per CHUNK×CHUNK block of cells.
  _buildChunks(VX, VZ) {
    const p = this.params;
    for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
      for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
        const mesh = this._makeChunk(cx0, cz0, VX, VZ);
        this.group.add(mesh);
        this.chunks.push(mesh);
      }
    }
  }

  // Build one chunk mesh from the current global fields, tagged with its origin.
  _makeChunk(cx0, cz0, VX, VZ) {
    const p = this.params;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const H = this._H, COL = this._col, GRA = this._grass, LND = this._land;
    const invTile2 = 1 / (2 * p.tile);
    const cw = Math.min(CHUNK, p.cols - cx0);
    const ch = Math.min(CHUNK, p.rows - cz0);
    const cvx = cw + 1, cvz = ch + 1;
    const pos = new Float32Array(cvx * cvz * 3);
    const col = new Float32Array(cvx * cvz * 3);
    const nor = new Float32Array(cvx * cvz * 3);
    const gra = new Float32Array(cvx * cvz);
    const lnd = new Float32Array(cvx * cvz);

    for (let lz = 0; lz < cvz; lz++) {
      for (let lx = 0; lx < cvx; lx++) {
        const gx = cx0 + lx, gz = cz0 + lz;
        const gi = gz * VX + gx;
        const li = lz * cvx + lx;
        pos[li * 3] = gx * p.tile - halfW;
        pos[li * 3 + 1] = H[gi];
        pos[li * 3 + 2] = gz * p.tile - halfH;
        col[li * 3] = COL[gi * 3];
        col[li * 3 + 1] = COL[gi * 3 + 1];
        col[li * 3 + 2] = COL[gi * 3 + 2];
        gra[li] = GRA[gi];
        lnd[li] = LND[gi];
        const xl = gx > 0 ? H[gi - 1] : H[gi];
        const xr = gx < VX - 1 ? H[gi + 1] : H[gi];
        const zl = gz > 0 ? H[gi - VX] : H[gi];
        const zr = gz < VZ - 1 ? H[gi + VX] : H[gi];
        const nx = -(xr - xl) * invTile2, nz = -(zr - zl) * invTile2;
        const inv = 1 / Math.hypot(nx, 1, nz);
        nor[li * 3] = nx * inv; nor[li * 3 + 1] = inv; nor[li * 3 + 2] = nz * inv;
      }
    }

    const idx = [];
    for (let lz = 0; lz < ch; lz++) {
      for (let lx = 0; lx < cw; lx++) {
        const a = lz * cvx + lx, b = a + 1, c = a + cvx, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('aGrass', new THREE.BufferAttribute(gra, 1));
    geo.setAttribute('aLand', new THREE.BufferAttribute(lnd, 1));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, this._terrainMat);
    mesh.receiveShadow = true;
    mesh.userData.cx0 = cx0;
    mesh.userData.cz0 = cz0;
    return mesh;
  }

  _buildWater() {
    // Two huge planes so the ocean reaches the horizon at any map size with no
    // visible edge. (1) An OPAQUE sea floor just below the deepest terrain — this
    // is what kills the visible square: beyond the terrain mesh the floor reads as
    // open ocean exactly like the deepest in-island water, instead of showing the
    // sky background through the transparent surface. (2) The transparent, shiny
    // surface at y=0 that islands poke through.
    const size = Math.max(this.worldW, this.worldH) * 12 + 6000;
    const deepY = -this.params.seaLevel * this.params.heightScale - 0.2;   // just under the deepest floor
    const floorGeo = new THREE.PlaneGeometry(size, size);
    // Match the colour the terrain actually shows at its submerged edge (C.shallow
    // #3fb4d8 — the deepest terrain only reaches y=-2.4, so it never hits C.deep).
    // Matching it means beyond the mesh reads identically to the in-island water,
    // so the square mesh boundary disappears under the 82%-opaque surface.
    const floorMat = new THREE.MeshStandardMaterial({ color: '#3fb4d8', roughness: 0.9, metalness: 0.0 });
    this.seaFloor = new THREE.Mesh(floorGeo, floorMat);
    this.seaFloor.rotation.x = -Math.PI / 2;
    this.seaFloor.position.y = deepY;
    this.group.add(this.seaFloor);

    const geo = new THREE.PlaneGeometry(size, size);
    const mat = new THREE.MeshStandardMaterial({
      color: '#2ea6cf', transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0.1,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.rotation.x = -Math.PI / 2;
    this.group.add(this.water);
  }

  // FINISHING PASS: level a flat, dry pad under each camp so walls share one
  // foundation height and no base sits in the ocean. pads: [{x,z,rInner,rOuter,height}].
  // LOCAL only: touches the pad's vertex region + rebuilds just the chunks it
  // overlaps (keeps init cheap even on big maps / phones).
  flattenPads(pads) {
    const p = this.params, VX = p.cols + 1, VZ = p.rows + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const dirty = new Set();   // chunk keys "cx0,cz0" that changed

    for (const pad of pads) {
      const wobAmp = pad.rOuter * 0.22;   // how irregular the pad edge is
      const reach = pad.rOuter + wobAmp;
      const gx0 = Math.max(0, Math.floor((pad.x - reach + halfW) / p.tile));
      const gx1 = Math.min(VX - 1, Math.ceil((pad.x + reach + halfW) / p.tile));
      const gz0 = Math.max(0, Math.floor((pad.z - reach + halfH) / p.tile));
      const gz1 = Math.min(VZ - 1, Math.ceil((pad.z + reach + halfH) / p.tile));
      for (let gz = gz0; gz <= gz1; gz++) {
        const wz = gz * p.tile - halfH;
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = gx * p.tile - halfW;
          const dist = Math.hypot(wx - pad.x, wz - pad.z);
          if (dist > pad.rOuter + wobAmp) continue;
          const vi = gz * VX + gx;
          // Perturb the ramp distance with noise so the edge isn't a perfect
          // circle — but the inner disc (walls) stays exactly flat.
          const wob = (this._grassNoise.fbm(wx * 0.06, wz * 0.06, 2) - 0.5) * 2 * wobAmp;
          const distP = dist + wob;
          const tBlend = dist <= pad.rInner ? 1 : smoothstep(pad.rOuter, pad.rInner, distP);
          if (tBlend <= 0) continue;
          this._H[vi] = this._H[vi] * (1 - tBlend) + pad.height * tBlend;
          this._setAttribs(vi, gx / p.cols, gz / p.rows);
        }
      }
      // Mark overlapping chunks dirty (pad edges can touch neighbours, so pad ±1).
      for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
        for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
          if (cx0 + CHUNK < gx0 - 1 || cx0 > gx1 + 1 || cz0 + CHUNK < gz0 - 1 || cz0 > gz1 + 1) continue;
          dirty.add(cx0 + ',' + cz0);
        }
      }
    }

    // Rebuild only the dirty chunks.
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const m = this.chunks[i];
      if (!dirty.has(m.userData.cx0 + ',' + m.userData.cz0)) continue;
      this.group.remove(m); m.geometry.dispose();
      const fresh = this._makeChunk(m.userData.cx0, m.userData.cz0, VX, VZ);
      this.group.add(fresh);
      this.chunks[i] = fresh;
    }

    this._classifyRegion(pads);
    this.pads = pads;
  }

  // Carve a square elevator SHAFT: drop the vertices inside a square straight
  // down to `bottomY` so the one-tile-wide boundary quads become near-vertical
  // walls (a clean square pit). Returns {groundY, bottomY} for the elevator rig.
  // Vertices are tinted dark and flagged non-land; a liner mesh covers them.
  carveShaft(x, z, half, depth) {
    const p = this.params, VX = p.cols + 1, VZ = p.rows + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    const cgx = Math.round((x + halfW) / p.tile), cgz = Math.round((z + halfH) / p.tile);
    const groundY = this._H[cgz * VX + cgx];
    const bottomY = groundY - depth;
    const gx0 = Math.max(0, Math.floor((x - half + halfW) / p.tile));
    const gx1 = Math.min(VX - 1, Math.ceil((x + half + halfW) / p.tile));
    const gz0 = Math.max(0, Math.floor((z - half + halfH) / p.tile));
    const gz1 = Math.min(VZ - 1, Math.ceil((z + half + halfH) / p.tile));
    for (let gz = gz0; gz <= gz1; gz++) {
      const wz = gz * p.tile - halfH;
      for (let gx = gx0; gx <= gx1; gx++) {
        const wx = gx * p.tile - halfW;
        if (Math.abs(wx - x) > half || Math.abs(wz - z) > half) continue;
        const vi = gz * VX + gx;
        this._H[vi] = bottomY;
        this._setAttribs(vi, gx / p.cols, gz / p.rows);
        this._col[vi * 3] = 0.14; this._col[vi * 3 + 1] = 0.15; this._col[vi * 3 + 2] = 0.17;
        this._land[vi] = 0;
      }
    }
    const dirty = new Set();
    for (let cz0 = 0; cz0 < p.rows; cz0 += CHUNK) {
      for (let cx0 = 0; cx0 < p.cols; cx0 += CHUNK) {
        if (cx0 + CHUNK < gx0 - 1 || cx0 > gx1 + 1 || cz0 + CHUNK < gz0 - 1 || cz0 > gz1 + 1) continue;
        dirty.add(cx0 + ',' + cz0);
      }
    }
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const m = this.chunks[i];
      if (!dirty.has(m.userData.cx0 + ',' + m.userData.cz0)) continue;
      this.group.remove(m); m.geometry.dispose();
      const fresh = this._makeChunk(m.userData.cx0, m.userData.cz0, VX, VZ);
      this.group.add(fresh); this.chunks[i] = fresh;
    }
    return { x, z, half, groundY, bottomY };
  }

  // Reclassify only the cells under the pads (cheap, after a local flatten).
  _classifyRegion(pads) {
    const p = this.params, VX = p.cols + 1;
    const halfW = this.worldW / 2, halfH = this.worldH / 2;
    for (const pad of pads) {
      const reach = pad.rOuter * 1.25;
      const cx0 = Math.max(0, Math.floor((pad.x - reach + halfW) / p.tile));
      const cx1 = Math.min(p.cols - 1, Math.ceil((pad.x + reach + halfW) / p.tile));
      const cz0 = Math.max(0, Math.floor((pad.z - reach + halfH) / p.tile));
      const cz1 = Math.min(p.rows - 1, Math.ceil((pad.z + reach + halfH) / p.tile));
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const i0 = cz * VX + cx;
          const y = (this._H[i0] + this._H[i0 + 1] + this._H[i0 + VX] + this._H[i0 + VX + 1]) / 4;
          let t;
          if (y <= 0) t = y < -2.5 ? TILE.DEEP : TILE.SHALLOW;
          else if (y < p.beachHeight) t = TILE.SAND;
          else if (y > p.beachHeight + 4.0) t = TILE.ROCK;
          else t = TILE.GRASS;
          const ci = cz * p.cols + cx;
          this.tileType[ci] = t;
          this.tileH[ci] = y;
        }
      }
    }
  }

  // Two camp sites ~2/3 of the way out from centre (not extreme opposites),
  // each nudged onto the best nearby land (the flatten pass dries it out anyway).
  findCampSites(count = 2) {
    const p = this.params;
    const cc = p.cols / 2, cr = p.rows / 2;
    const Rcells = Math.min(p.cols, p.rows) * 0.33;   // ~2/3 from centre to edge
    const base = ((p.seed * 9301 + 49297) % 233280) / 233280 * Math.PI * 2;
    const sites = [];
    for (let i = 0; i < count; i++) {
      const ang = base + i * (Math.PI * 2 / count);
      const tcx = Math.max(10, Math.min(p.cols - 10, Math.round(cc + Math.cos(ang) * Rcells)));
      const tcz = Math.max(10, Math.min(p.rows - 10, Math.round(cr + Math.sin(ang) * Rcells)));
      const best = this._bestLandCell(tcx, tcz, 12);
      sites.push(this.cellCenter(best.cx, best.cz));
    }
    return sites;
  }

  // Search a window around (tcx,tcz) for the cell whose surrounding footprint is
  // the most land (sand/grass).
  _bestLandCell(tcx, tcz, win) {
    const p = this.params;
    const frT = Math.min(24, Math.max(4, Math.round(14 / p.tile)));
    let best = { cx: tcx, cz: tcz }, bestScore = -1;
    for (let dz = -win; dz <= win; dz += 2) {
      for (let dx = -win; dx <= win; dx += 2) {
        const cx = tcx + dx, cz = tcz + dz;
        if (cx < frT || cz < frT || cx >= p.cols - frT || cz >= p.rows - frT) continue;
        let land = 0, total = 0;
        for (let zz = -frT; zz <= frT; zz += 3) {
          for (let xx = -frT; xx <= frT; xx += 3) {
            const t = this.tileType[(cz + zz) * p.cols + (cx + xx)];
            total++;
            if (t === TILE.SAND || t === TILE.GRASS) land++;
          }
        }
        const score = land / total;
        if (score > bestScore) { bestScore = score; best = { cx, cz }; }
      }
    }
    return best;
  }

  _classify(VX) {
    const p = this.params;
    this.tileType = new Uint8Array(p.cols * p.rows);
    this.tileH = new Float32Array(p.cols * p.rows);
    for (let cz = 0; cz < p.rows; cz++) {
      for (let cx = 0; cx < p.cols; cx++) {
        const i0 = cz * VX + cx;
        const y = (this._H[i0] + this._H[i0 + 1] + this._H[i0 + VX] + this._H[i0 + VX + 1]) / 4;
        let t;
        if (y <= 0) t = y < -2.5 ? TILE.DEEP : TILE.SHALLOW;
        else if (y < p.beachHeight) t = TILE.SAND;
        else if (y > p.beachHeight + 4.0) t = TILE.ROCK;
        else t = TILE.GRASS;
        const ci = cz * p.cols + cx;
        this.tileType[ci] = t;
        this.tileH[ci] = y;
      }
    }
  }

  // --- Gameplay sampling -------------------------------------------------

  _cellAt(x, z) {
    const p = this.params;
    const cx = Math.floor((x + this.worldW / 2) / p.tile);
    const cz = Math.floor((z + this.worldH / 2) / p.tile);
    if (cx < 0 || cz < 0 || cx >= p.cols || cz >= p.rows) return null;
    return cz * p.cols + cx;
  }

  tileAt(x, z) {
    const ci = this._cellAt(x, z);
    return ci == null ? TILE.DEEP : this.tileType[ci];
  }

  isLand(x, z) {
    const t = this.tileAt(x, z);
    return t === TILE.SAND || t === TILE.GRASS || t === TILE.ROCK;
  }

  // Raw terrain height, NOT clamped to the waterline like heightAt — so it reads
  // negative under water (used to sit a wading vehicle at the actual floor depth).
  floorAt(x, z) {
    const ci = this._cellAt(x, z);
    return ci == null ? FORD_DEPTH - 1 : this.tileH[ci];
  }

  // DEEP water = floor deeper than the ford limit; ground vehicles can't cross it
  // (and sink in it). The shallow fringe above FORD_DEPTH — shorelines, puddles,
  // narrow inlets — is fordable: land vehicles WADE through instead of treating
  // every splash of water as a wall. Off-map reads as deep (the world's ocean
  // wall). Tuned against the map's depth spread (floors run ~-2.4..0).
  isDeepWater(x, z) {
    const ci = this._cellAt(x, z);
    if (ci == null) return true;
    return this.tileH[ci] < FORD_DEPTH;
  }

  heightAt(x, z) {
    const ci = this._cellAt(x, z);
    if (ci == null) return 0;
    return Math.max(0, this.tileH[ci]);
  }

  // World point for a cell centre.
  cellCenter(cx, cz) {
    return new THREE.Vector3(
      (cx + 0.5) * this.params.tile - this.worldW / 2,
      this.tileH[cz * this.params.cols + cx],
      (cz + 0.5) * this.params.tile - this.worldH / 2,
    );
  }

  // Find up to `count` flat-ish land sites with clearance, spread far apart.
  findBaseSites(count = 2, clearTiles = 6) {
    const p = this.params;
    const cands = [];
    for (let cz = clearTiles; cz < p.rows - clearTiles; cz++) {
      for (let cx = clearTiles; cx < p.cols - clearTiles; cx++) {
        const t = this.tileType[cz * p.cols + cx];
        if (t !== TILE.SAND && t !== TILE.GRASS) continue;
        let land = 0, total = 0;
        const r = clearTiles;
        for (let dz = -r; dz <= r; dz += 2) {
          for (let dx = -r; dx <= r; dx += 2) {
            const tt = this.tileType[(cz + dz) * p.cols + (cx + dx)];
            total++;
            if (tt === TILE.SAND || tt === TILE.GRASS) land++;
          }
        }
        if (land / total > 0.82) cands.push(this.cellCenter(cx, cz));
      }
    }
    if (cands.length === 0) return [this.findLandSpawn()];

    const sites = [cands[0]];
    while (sites.length < count && sites.length < cands.length) {
      let best = null, bestD = -1;
      for (const c of cands) {
        let nearest = Infinity;
        for (const s of sites) nearest = Math.min(nearest, c.distanceToSquared(s));
        if (nearest > bestD) { bestD = nearest; best = c; }
      }
      sites.push(best);
    }
    return sites;
  }

  findLandSpawn() {
    const p = this.params;
    const c = Math.floor(p.cols / 2), r = Math.floor(p.rows / 2);
    for (let radius = 0; radius < Math.max(p.cols, p.rows); radius++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const cx = c + dx, cz = r + dz;
          if (cx < 0 || cz < 0 || cx >= p.cols || cz >= p.rows) continue;
          const t = this.tileType[cz * p.cols + cx];
          if (t === TILE.SAND || t === TILE.GRASS) return this.cellCenter(cx, cz);
        }
      }
    }
    return new THREE.Vector3(0, 0, 0);
  }
}
