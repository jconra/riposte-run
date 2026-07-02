// Walls.js — grid wall kit. Three pieces, one per build cell: N/S wall, E/W
// wall, and Corner (uniform tapered piece that mounts a turret — guns live only
// on corners). Each piece is a stack of tapered layers; as it takes damage it
// crumbles in STAGES, shedding top layers that tumble off as debris. The body
// and the corner gun are separately destructible.

import * as THREE from 'three';
import { Destructible } from './Destructible.js?v=5';
import { applyStaging } from './AssetStaging.js?v=1';
import { makeFlagHQ, makeBarracks, makeDepot, makeElevator, makeAdmin, makeQuonset, makeTent } from './Buildings.js?v=3';
import { concreteTexture, accentPlateTexture } from './Textures.js?v=2';
import { buildAssetGroup, recolorCamo } from './AssetBuilder.js?v=1';
import CORNER_TOWER_CFG from './corner_tower.config.js?v=1';

const STONE = new THREE.MeshStandardMaterial({ color: '#ffffff', map: concreteTexture('#9a948a'), roughness: 0.95 });
// Shared neutral plate map for every team-colour piece — built once, tinted per material
// by the team accent (setAccent only touches .color, so the map rides along).
const ACCENT_TEX = accentPlateTexture();
const RUBBLE = new THREE.MeshStandardMaterial({ color: '#5b554c', roughness: 1.0, flatShading: true });

// A low debris pile left where a building is destroyed.
function rubblePile(cell) {
  return () => {
    const g = new THREE.Group();
    const n = 5 + (Math.random() * 5 | 0);
    for (let i = 0; i < n; i++) {
      const s = cell * (0.2 + Math.random() * 0.3);
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s), RUBBLE);
      m.position.set((Math.random() - 0.5) * cell * 1.4, s * 0.3, (Math.random() - 0.5) * cell * 1.4);
      m.rotation.y = Math.random() * Math.PI;
      g.add(m);
    }
    return g;
  };
}
const METAL = new THREE.MeshStandardMaterial({ color: '#3b3f44', roughness: 0.5, metalness: 0.6, flatShading: true });

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}

export class Wall {
  // type: 'NS' | 'EW' | 'CORNER'. world: ground point. cell: build-cell size.
  constructor({ type, world, cell, team, accent, manager, span = 1 }) {
    this.type = type;
    this.cell = cell;
    this.accent = accent;
    this.span = span;            // gate width in cells (1 for normal pieces)
    this.group = new THREE.Group();
    this.group.position.copy(world);
    this.layers = [];
    this.turret = null;

    this._build();

    this.maxHp = type === 'CORNER' ? 340 : type.startsWith('GATE') ? 300 : 200;
    this.body = new Destructible(this.bodyGroup, {
      type: 'wall', hp: this.maxHp,
      onDamage: () => this._restage(),
      onDestroyed: () => this._collapseAll(),
    });
    manager.add(this.body);

    if (this.turret) {
      this.turretDest = new Destructible(this.turret.head, {
        type: 'gun', hp: 180,
        onDestroyed: () => this._killTurret(),
      });
      manager.add(this.turretDest);
    }
  }

  _accentMat() {
    const m = new THREE.MeshStandardMaterial({ color: this.accent, map: ACCENT_TEX, roughness: 0.6, metalness: 0.2, flatShading: true });
    m.userData.accent = true;   // so Camp.setAccent can recolour the team band (map rides along)
    return m;
  }

  _layerEntry(mesh, fallAt = null) {
    return { mesh, fallAt, falling: false, settled: false, vel: new THREE.Vector3(), ang: new THREE.Vector3() };
  }

  _build() {
    this.bodyGroup = new THREE.Group();
    this.group.add(this.bodyGroup);
    if (this.type === 'GATE_EW' || this.type === 'GATE_NS') return this._buildGate();
    if (this.type === 'CORNER') return this._buildCornerTower();

    const cell = this.cell;
    const isCorner = this.type === 'CORNER';
    const nLayers = isCorner ? 5 : 4;
    const height = cell * (isCorner ? 1.0 : 0.78);
    const layerH = height / nLayers;
    const baseThick = cell * 0.30;   // thinner walls (deliberate choice)
    const taper = 0.30;   // thickness taper only (broad base); length stays full

    for (let i = 0; i < nLayers; i++) {
      const t = nLayers > 1 ? i / (nLayers - 1) : 0;   // 0 bottom .. 1 top
      const shrink = 1 - t * taper;
      let w, d;
      if (isCorner) {
        // Fill the whole grid cell (solid bastion, no gaps to peek through);
        // only a slight narrowing near the top.
        const side = cell * (1 - t * 0.15);
        w = d = side;
      } else if (this.type === 'NS') {     // runs along Z
        w = baseThick * shrink;            // taper thickness (across) only
        d = cell;                          // FULL length — abuts neighbors, solid
      } else {                              // EW, runs along X
        w = cell;                          // FULL length
        d = baseThick * shrink;
      }
      const mat = (!isCorner && i === nLayers - 1) ? this._accentMat() : STONE;
      const m = box(w, layerH, d, mat);
      m.position.y = 0.1 + i * layerH + layerH / 2;
      this.bodyGroup.add(m);
      this.layers.push(this._layerEntry(m));
      if (i === nLayers - 1) { this._capW = w; this._capD = d; }   // match the top (coloured) layer
    }

    // Clean capstone, flush with the coloured top layer so the colour shows.
    const batt = this._buildParapet(layerH, this._capW, this._capD);
    batt.position.y = 0.1 + height;
    this.bodyGroup.add(batt);
    this.layers.push(this._layerEntry(batt));

    if (isCorner) {
      this.turret = this._makeTurret(0.1 + height + layerH * 0.5);
      this.group.add(this.turret.group);
    }
  }

  // The corner bastion is Jacob's asset-designer tower (corner_tower.config.js). The
  // structure crumbles by its authored per-part fallAt; parts flagged turret form the gun
  // head that spins + fires. It keeps the SAME turret interface (group/head/aimYaw) the
  // procedural corners used, so main.js's tickWallTurret + the AI/siege code need no change.
  _buildCornerTower() {
    const tower = buildAssetGroup(CORNER_TOWER_CFG, this.accent, { cell: this.cell });
    // AssetBuilder folds the "gun" role group into a pre-pivoted sub-group (barrels authored
    // to point +Z, the engine's aim convention); everything else is loose structure meshes.
    let head = null;
    for (const child of tower.children.slice()) {
      if (child.isGroup && child.userData.role === 'gun') { head = child; continue; }
      this.bodyGroup.add(child);                                    // structure → crumble layer
      this.layers.push(this._layerEntry(child, child.userData.fallAt ?? 0));
    }
    this._authoredCrumble = true;

    if (head) {
      // The sub-group already pivots at the gun's base centre, so head.rotation.y swings the
      // barrels. Wrap it so `group` (the toppling unit that _animate moves) and `head` (what
      // aims + can detach on destroy) stay distinct objects. Gun sheds at its own threshold.
      const group = new THREE.Group();
      // Carry the gun's HEIGHT on the wrapper (head sits high in the tower). _animate topples
      // `group`, so if it stayed at y=0 the settle check (y<=0.25) tripped instantly and the
      // gun hovered at head's height instead of falling. Put the group AT the gun and zero the
      // head's local offset — same render + same aim pivot, but now gravity drops it to ground.
      group.position.copy(head.position);
      head.position.set(0, 0, 0);
      group.add(head);
      this.group.add(group);
      const thr = head.children.map(m => m.userData.fallAt ?? 0).filter(v => v > 0);
      this._turretFallAt = thr.length ? Math.min(...thr) : 0.5;
      this.turret = { group, head, dead: false, falling: false, vel: new THREE.Vector3(), ang: new THREE.Vector3(), sweep: Math.random() * 6.28 };
    }
  }

  // A clean capstone lip the same footprint as the top layer (no overhang),
  // so the team-colour band underneath stays visible.
  _buildParapet(layerH, capW, capD) {
    const g = new THREE.Group();
    const lipH = layerH * 0.35;
    const lip = box(capW, lipH, capD, STONE);
    lip.position.y = lipH / 2;
    g.add(lip);
    return g;
  }

  // Gate spanning `span` cells: two flanking posts with a wide drivable opening
  // (so a wide Jotun fits) + an accent lintel beam. isEW => opening lets you
  // drive through in Z; otherwise through X.
  _buildGate() {
    const cell = this.cell;
    const isEW = this.type === 'GATE_EW';
    const thick = cell * 0.30;
    const postW = cell * 0.30;
    const postH = cell * 1.15;
    const runLen = this.span * cell;        // gate width along its edge
    const off = runLen / 2 - postW / 2;     // posts at the span's outer ends

    for (const s of [-1, 1]) {
      const w = isEW ? postW : thick;
      const d = isEW ? thick : postW;
      const post = box(w, postH, d, STONE);
      post.position.set(isEW ? s * off : 0, 0.1 + postH / 2, isEW ? 0 : s * off);
      this.bodyGroup.add(post);
      this.layers.push(this._layerEntry(post));
    }
    // Lintel spanning the whole opening (team colour) — reads as a gateway.
    const lintelH = cell * 0.2;
    const lintel = box(isEW ? runLen : thick * 1.05, lintelH, isEW ? thick * 1.05 : runLen, this._accentMat());
    lintel.position.y = 0.1 + postH + lintelH / 2;
    this.bodyGroup.add(lintel);
    this.layers.push(this._layerEntry(lintel));

    // Two door leaves that fill the opening when CLOSED (block enemies) and slide apart
    // toward the posts when a friendly is near (main.js drives setGateTarget). They crumble
    // with the gate, so breaching it destroys the doors too.
    const inner = runLen - postW * 2;         // clear span between the posts
    const half = inner / 2, doorH = postH * 0.9, doorTh = thick * 0.7;
    this._doors = [];
    for (const s of [-1, 1]) {                // meet at centre when closed
      const leaf = box(isEW ? half : doorTh, doorH, isEW ? doorTh : half, this._accentMat());
      const closed = s * half / 2, open = s * (half + postW * 0.5);   // slide out behind the post
      leaf.position.set(isEW ? closed : 0, 0.1 + doorH / 2, isEW ? 0 : closed);
      this.bodyGroup.add(leaf);
      this.layers.push(this._layerEntry(leaf));
      this._doors.push({ mesh: leaf, axis: isEW ? 'x' : 'z', closed, open });
    }
    this._gateTarget = 0;   // 0 = closed, 1 = open (set by main.js proximity check)
    this._doorT = 0;        // animated position, lerps toward _gateTarget
  }
  // Logical open state used for blocking: a gate counts as OPEN the instant a friendly is
  // in range (target = open), so units never path into a door that's about to lift.
  get gateOpen() { return this._gateTarget === 1; }
  setGateTarget(open) { this._gateTarget = open ? 1 : 0; }

  _makeTurret(y) {
    const cell = this.cell;
    const group = new THREE.Group();
    group.position.y = y;
    const head = new THREE.Group();
    const body = box(cell * 0.42, cell * 0.24, cell * 0.5, METAL);
    body.position.y = cell * 0.12;
    head.add(body);
    const stripe = box(cell * 0.44, cell * 0.08, cell * 0.4, this._accentMat());
    stripe.position.y = cell * 0.26;
    head.add(stripe);
    for (const sx of [-0.16, 0.16]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(cell * 0.04, cell * 0.04, cell * 0.55, 6), METAL);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(sx * cell, cell * 0.12, cell * 0.35);
      head.add(barrel);
    }
    group.add(head);
    return { group, head, dead: false, falling: false, vel: new THREE.Vector3(), ang: new THREE.Vector3(), sweep: Math.random() * 6.28 };
  }

  // Damage crossed a stage threshold -> the stone LAYERS peel off top-to-bottom as the
  // tower crumbles. The corner gun has its OWN hp (turretDest) and only topples when that's
  // spent (_killTurret) or the tower fully collapses (_collapseAll) — so a splash that just
  // chips the tower can't knock it off for free (one Valkyrie missile ≠ a dead gun; see
  // Destructible.damageAt's splash cap). And while the gun is STILL UP we shed NOTHING: it
  // sits on the top course, so dropping any layer would leave it defying gravity. The tower
  // still shows damage via scorch/cracks; it physically crumbles only once the gun is gone,
  // at which point _killTurret re-runs this to catch the stack up to the body's real HP.
  _restage() {
    const frac = Math.max(0, this.body.hp / this.maxHp);
    if (this.turret && !this.turret.dead) {
      // The gun sits on top and holds the structure up: nothing sheds while it stands. It
      // falls at its OWN threshold (authored corner: body past _turretFallAt; procedural
      // corner: only when its 180hp is spent / the body is destroyed → _collapseAll).
      if (this._turretFallAt == null || frac > this._turretFallAt) return;
      this._killTurret();   // catches the stack up to the body's damage below
    }
    if (this._authoredCrumble) {                       // designer tower: shed by authored fallAt
      for (const p of this.layers) if (!p.falling && (p.fallAt ?? 0) >= frac) this._fall(p);
    } else {                                           // procedural wall/tower: peel top-down
      const lost = Math.floor((1 - frac) * this.layers.length);
      for (let i = this.layers.length - 1, k = 0; i >= 0; i--, k++) {
        if (k < lost && !this.layers[i].falling) this._fall(this.layers[i]);
      }
    }
  }

  // Topple the corner gun off the tower (whether knocked loose by body damage or shot
  // out directly). Re-attach the head if the Destructible detached it, so the whole gun
  // tumbles instead of just vanishing. With the gun gone, let the tower crumble to match
  // whatever damage its body has already taken (no longer held intact for the gun's sake).
  _killTurret() {
    if (!this.turret || this.turret.dead) return;
    this.turret.dead = true;
    if (this.turretDest && !this.turretDest.dead) this.turretDest.damage(1e9);
    if (this.turret.head && this.turret.head.parent !== this.turret.group) this.turret.group.add(this.turret.head);
    if (!this.turret.falling) this._fall(this.turret);
    this._restage();   // gun's down → catch the stack up to the body's accumulated damage
  }

  _collapseAll() {
    for (const L of this.layers) if (!L.falling) this._fall(L);
    this._killTurret();
  }

  // Kick a layer/turret loose: outward + up, with tumble.
  _fall(obj) {
    obj.falling = true;
    const a = Math.random() * Math.PI * 2;
    obj.vel.set(Math.cos(a) * 2.2, 2.6, Math.sin(a) * 2.2);
    obj.ang.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6);
  }

  _animate(o, dt) {
    if (!o.falling || o.settled) return;
    const m = o.mesh || o.group;
    o.vel.y -= 14 * dt;
    m.position.x += o.vel.x * dt;
    m.position.y += o.vel.y * dt;
    m.position.z += o.vel.z * dt;
    m.rotation.x += o.ang.x * dt;
    m.rotation.y += o.ang.y * dt;
    m.rotation.z += o.ang.z * dt;
    if (m.position.y <= 0.25) { m.position.y = 0.25; o.settled = true; }   // rest as rubble
  }

  update(dt) {
    for (const L of this.layers) this._animate(L, dt);
    if (this._doors) {   // ease the door leaves toward the open/closed target (skip fallen ones)
      const goal = this._gateTarget;
      this._doorT += (goal - this._doorT) * Math.min(1, dt * 5);
      if (Math.abs(goal - this._doorT) < 0.001) this._doorT = goal;
      for (const dr of this._doors) {
        const L = this.layers.find(l => l.mesh === dr.mesh);
        if (L && L.falling) continue;   // once crumbled, let it lie
        dr.mesh.position[dr.axis] = dr.closed + (dr.open - dr.closed) * this._doorT;
      }
    }
    if (this.turret) {
      this._animate(this.turret, dt);
      if (!this.turret.dead && !this.turret.falling) {
        const h = this.turret.head;
        if (this.turret.aimYaw != null) {       // engaging a target (set by main.js): swing onto it
          let d = this.turret.aimYaw - h.rotation.y;
          while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          h.rotation.y += d * Math.min(1, dt * 7);
        } else {                                 // idle: slow scanning sweep
          this.turret.sweep += dt * 0.6;
          h.rotation.y = Math.sin(this.turret.sweep) * 0.8;
        }
      }
    }
  }
}

// A camp = a rectangular ring of wall pieces with corner turrets, on the grid.
export class Camp {
  // grid: BuildGrid. centerCell: {cx,cz}. size: EVEN number of cells per side
  // (so the 2-cell gate centres perfectly). groundY: common foundation height.
  // role: 'main' (flag HQ + buildings) or 'fob' (elevator).
  constructor(grid, centerCell, size, team, manager, groundY = 0, role = 'main', opts = {}) {
    // bare = a DESIGNED/custom map base: skip the procgen wall ring, gates, corner
    // towers and extra interior buildings, so the real HQ isn't given away by a fort
    // around it (decoys are bare buildings) — the map's own placed assets take over.
    const bare = !!opts.bare;
    this.group = new THREE.Group();
    this.walls = [];
    this.buildings = [];
    this.gates = [];          // { pos } gate centres, for road routing
    this.blockedCells = new Set();   // build cells roads must avoid (whole footprint)
    this.openCells = new Set();      // gate cells roads MAY pass through
    this.team = team;
    this.role = role;
    const accent = team === 'red' ? new THREE.Color('#c0392b') : new THREE.Color('#2e6fc0');
    this.accent = accent;   // shared Color: every wall/building references it
    this.center = grid.cellToWorld(centerCell.cx, centerCell.cz);
    this.center.y = groundY;

    // Odd, symmetric span: cells run -h..h with a REAL centre cell 0. A 3-cell
    // gate centres on cell 0, so a 1-wide road threads its middle exactly.
    const h = (size - 1) / 2;
    const lo = -h, hi = h;
    const gateCells = [-1, 0, 1];

    // Gate on the edge facing the map centre. A FOB gets a SECOND gate on the
    // opposite edge so you can drive straight through it.
    const useX = Math.abs(this.center.x) >= Math.abs(this.center.z);
    const gateAxis = useX ? 'x' : 'z';
    const frontSide = useX ? (this.center.x > 0 ? lo : hi) : (this.center.z > 0 ? lo : hi);
    const gateSides = role === 'fob' ? [frontSide, frontSide === lo ? hi : lo] : [frontSide];
    const onGate = (dx, dz) => gateSides.some(gs =>
      gateAxis === 'x' ? (dx === gs && gateCells.includes(dz))
                       : (dz === gs && gateCells.includes(dx)));

    if (!bare) {
    for (let dx = lo; dx <= hi; dx++) {
      for (let dz = lo; dz <= hi; dz++) {
        const edgeX = dx === lo || dx === hi, edgeZ = dz === lo || dz === hi;
        if (!edgeX && !edgeZ) continue;            // ring only
        if (onGate(dx, dz)) continue;              // leave the gate cells open
        let type;
        if (edgeX && edgeZ) type = 'CORNER';
        else if (edgeX) type = 'NS';               // left/right runs north-south
        else type = 'EW';                          // top/bottom runs east-west
        const world = grid.cellToWorld(centerCell.cx + dx, centerCell.cz + dz);
        world.y = groundY;
        const w = new Wall({ type, world, cell: grid.cell, team, accent, manager });
        this.group.add(w.group);
        this.walls.push(w);
      }
    }

    // One gate piece per open side, centred on the edge's middle cell.
    const gateType = gateAxis === 'x' ? 'GATE_NS' : 'GATE_EW';
    for (const gs of gateSides) {
      const gWorld = gateAxis === 'x'
        ? grid.cellToWorld(centerCell.cx + gs, centerCell.cz)
        : grid.cellToWorld(centerCell.cx, centerCell.cz + gs);
      gWorld.y = groundY;
      const gate = new Wall({ type: gateType, world: gWorld, cell: grid.cell, team, accent, manager, span: 3 });
      this.group.add(gate.group);
      this.walls.push(gate);
      const outward = gateAxis === 'x'
        ? new THREE.Vector3(gs === lo ? -1 : 1, 0, 0)
        : new THREE.Vector3(0, 0, gs === lo ? -1 : 1);
      this.gates.push({ pos: gWorld.clone(), outward });
    }

    // Occupancy for road routing: block the whole footprint, open the gate cells.
    for (let dx = lo; dx <= hi; dx++)
      for (let dz = lo; dz <= hi; dz++)
        this.blockedCells.add((centerCell.cx + dx) + ',' + (centerCell.cz + dz));
    for (const gs of gateSides)
      for (const gc of gateCells) {
        const cx = gateAxis === 'x' ? centerCell.cx + gs : centerCell.cx + gc;
        const cz = gateAxis === 'x' ? centerCell.cz + gc : centerCell.cz + gs;
        this.openCells.add(cx + ',' + cz);
      }
    }

    this._placeInterior(grid, centerCell, size, groundY, manager, accent, bare);
  }

  // Interior buildings, all snapped to grid cells. The flag HQ sits at the camp
  // centre with the surrounding ring left CLEAR for a road; other buildings go
  // on the interior corner cells. A FOB holds only the elevator (more room only
  // if it's enlarged).
  _placeInterior(grid, centerCell, size, groundY, manager, accent, bare = false) {
    const cell = grid.cell;
    const h = (size - 1) / 2;
    const inLo = -h + 1, inHi = h - 1;     // interior (non-edge) cell range
    const centreX = this.center.x, centreZ = this.center.z;   // odd camp: centred on a cell

    const addAt = (obj, wx, wz, hp, id, yaw = 0) => {
      obj.position.set(wx, groundY, wz);
      obj.rotation.y = yaw;
      this.group.add(obj);
      applyStaging(obj, id);   // authored crumble (if any) before the Destructible reads it
      const d = new Destructible(obj, { type: 'building', hp, staged: true });   // pieces crumble (was: vanish→rubblePile)
      manager.add(d);
      this.buildings.push(obj);
      return d;
    };
    const addCell = (obj, ix, iz, hp, id, yaw = 0) => {
      const w = grid.cellToWorld(centerCell.cx + ix, centerCell.cz + iz);
      addAt(obj, w.x, w.z, hp, id, yaw);
    };

    if (this.role === 'fob') {
      // FOB centre is left clear: main.js drops the animated Elevator rig here
      // (carved shaft + rising lift). The old flat makeElevator pad is retired.
      void makeElevator; void centreX; void centreZ;
    } else {
      // The HQ wears the team flag on its roof. The capturable flag (main.js) is
      // hidden inside until this building falls — so we keep a handle to its
      // Destructible for the reveal check.
      this.flagHQ = addAt(makeFlagHQ(cell, accent), centreX, centreZ, 600, 'flagHQ');   // centre; ring around = road
      if (!bare) {   // custom maps: just the HQ (identical to the decoys) — no extra base buildings
        addCell(makeAdmin(cell, accent), inLo, inHi, 160, 'admin');
        addCell(makeQuonset(cell, accent), inHi, inHi, 140, 'quonset', Math.PI / 2);
        addCell(makeBarracks(cell, accent), inLo, inLo, 120, 'barracks');
        addCell(makeTent(cell, accent), inHi, inLo, 50, 'tent');
      }
    }
  }

  // Recolour the team accent (wall bands, gate lintels, corner stripes, turret +
  // building accents) live — used when the player locks a team colour on deploy.
  // Mutating the shared accent Color also covers any later wall rebuild on damage.
  setAccent(hex) {
    this.accent.set(hex);
    this.group.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.userData && m.userData.accent) m.color.set(hex);
        if (m.userData && m.userData.camo) recolorCamo(m, this.accent);   // rebuild baked camo for the new team colour
      }
    });
  }

  update(dt) { for (const w of this.walls) w.update(dt); }
}

// ── Standalone mesh makers (for the manifest / asset designer / map-designer) ──
// Just the VISUAL meshes of a wall segment, corner tower, and gate, as a plain Group —
// no Destructible/combat wiring (that stays in the Wall class above). The mesh layout
// mirrors the live pieces so the designer's per-piece damage staging lines up.
function accentMat(accent) {
  return new THREE.MeshStandardMaterial({ color: accent, map: ACCENT_TEX, roughness: 0.6, metalness: 0.2, flatShading: true });
}
function parapetMesh(layerH, capW, capD) {
  const lipH = layerH * 0.35;
  const lip = box(capW, lipH, capD, STONE);
  lip.position.y = lipH / 2;
  const g = new THREE.Group(); g.add(lip); return g;
}
function turretMesh(cell, accent, y) {
  const group = new THREE.Group(); group.position.y = y;
  const body = box(cell * 0.42, cell * 0.24, cell * 0.5, METAL); body.position.y = cell * 0.12; group.add(body);
  const stripe = box(cell * 0.44, cell * 0.08, cell * 0.4, accentMat(accent)); stripe.position.y = cell * 0.26; group.add(stripe);
  for (const sx of [-0.16, 0.16]) {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(cell * 0.04, cell * 0.04, cell * 0.55, 6), METAL);
    barrel.rotation.x = Math.PI / 2; barrel.position.set(sx * cell, cell * 0.12, cell * 0.35); group.add(barrel);
  }
  return group;
}
// A tapered stone layer stack + parapet; the top course is the team-colour band.
function wallStack(cell, accent, isCorner) {
  const g = new THREE.Group();
  const nLayers = isCorner ? 5 : 4;
  const height = cell * (isCorner ? 1.0 : 0.78);
  const layerH = height / nLayers;
  const baseThick = cell * 0.30, taper = 0.30;
  let capW = cell, capD = cell;
  for (let i = 0; i < nLayers; i++) {
    const t = i / (nLayers - 1), shrink = 1 - t * taper;
    let w, d;
    if (isCorner) { const side = cell * (1 - t * 0.15); w = d = side; }
    else { w = cell; d = baseThick * shrink; }       // EW run (length along X)
    const mat = (!isCorner && i === nLayers - 1) ? accentMat(accent) : STONE;
    const m = box(w, layerH, d, mat);
    m.position.y = 0.1 + i * layerH + layerH / 2;
    g.add(m);
    if (i === nLayers - 1) { capW = w; capD = d; }
  }
  const batt = parapetMesh(layerH, capW, capD); batt.position.y = 0.1 + height; g.add(batt);
  return { group: g, height, layerH };
}
export function makeWall(cell = 5, accent = new THREE.Color('#c0392b')) {
  return wallStack(cell, accent, false).group;
}
export function makeTower(cell = 5, accent = new THREE.Color('#c0392b')) {
  const { group, height, layerH } = wallStack(cell, accent, true);
  const t = turretMesh(cell, accent, 0.1 + height + layerH * 0.5);
  t.userData.turret = true;   // keystone: holds the bastion up + idle-sweeps under the generic crumble
  t.userData.fallAt = 0.3;    // bastion stays intact until the gun is knocked out (~30% HP)
  group.add(t);
  return group;
}
export function makeGate(cell = 5, accent = new THREE.Color('#c0392b'), span = 3) {
  const g = new THREE.Group();
  const thick = cell * 0.30, postW = cell * 0.30, postH = cell * 1.15;
  const runLen = span * cell, off = runLen / 2 - postW / 2;
  for (const s of [-1, 1]) {                          // posts flank the drive-through opening
    const post = box(postW, postH, thick, STONE);
    post.position.set(s * off, 0.1 + postH / 2, 0);
    g.add(post);
  }
  const lintelH = cell * 0.2;
  const lintel = box(runLen, lintelH, thick * 1.05, accentMat(accent));
  lintel.position.y = 0.1 + postH + lintelH / 2;
  g.add(lintel);
  return g;
}
