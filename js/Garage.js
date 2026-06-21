// Garage.js — the underground hangar you start in (Return Fire style). A 3D
// bunker viewed from above: a central elevator with four bays of vehicles
// fanning out N/S/E/W (more of the small/weak ones, fewer of the big ones). A
// steerable spotlight selects a vehicle; the chosen one drives onto the lift and
// rises to the surface (Phase C). Counts are the attrition pool — lose them all,
// lose the match.
//
// Phase A: the room + bays + lighting + selection light. Build into its own
// scene with its own top-down camera so the field renderer is untouched.

import * as THREE from 'three';
import { Vehicle, VEHICLE_TYPES } from './Vehicles.js';
import { concreteTexture } from './BuildingTextures.js';

export const GARAGE_COUNTS = { firebrat: 6, lurcher: 3, valkyrie: 2, jotun: 2 };

// Selection is by TYPE, not by individual. Each type has ONE 'deploy' vehicle at a
// fixed front slot — the only one that's selectable to roll onto the lift — so the
// roll-out + elevator animation is identical every match. The deploy vehicle is
// always present until the whole type is wiped out; losses are taken from the
// back / most-hidden RESERVES first. Indices below are 0-based into the
// _buildBays() _park() order (so deploy 'firebrat: 5' == the 6th _park = #6).
export const DEPLOY_SLOT = { jotun: 0, firebrat: 5, valkyrie: 9, lurcher: 10 };

// Order reserves are removed as a type takes losses (FIRST lost → LAST). Most
// hidden goes first; the deploy slot is never here (it always stays). Firebrats
// start at #8 by design. PROVISIONAL ordering past the anchors — confirm later.
export const ATTRITION_ORDER = {
  jotun:    [1],                  // #2
  valkyrie: [8],                  // #9
  firebrat: [7, 2, 3, 6, 4],      // #8 → #3 → #4 → #7 → #5  (deploy #6 stays)
  lurcher:  [11, 12],             // #12 → #13              (deploy #11 stays)
};

const ELEV_HALF = 16;     // elevator pad half-size (grew with the bigger vehicles)
const FLOOR_HALF = 66;    // room half-extent
const WALL_H = 9;

const ROLL_TIME = 2.2;    // seconds to drive onto the lift
const RISE_TIME = 2.6;    // seconds to lift out
const LIFT_RISE = 20;     // how far the lift travels up (fade covers the rest)

const easeInOut = (k) => k * k * (3 - 2 * k);
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {        // shortest-arc interpolation
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Diagonal yellow/black caution stripes, tileable, for the elevator border.
function makeHazardTexture() {
  const N = 64, c = document.createElement('canvas');
  c.width = c.height = N;
  const x = c.getContext('2d');
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      x.fillStyle = ((i + j) % 32) < 16 ? '#e8c84a' : '#16181c';
      x.fillRect(i, j, 1, 1);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FLOOR_MAT = new THREE.MeshStandardMaterial({ color: '#8c8f93', map: concreteTexture('#7c8084'), roughness: 0.96 });
const WALL_MAT  = new THREE.MeshStandardMaterial({ color: '#aeb2b6', map: concreteTexture('#9aa0a4'), roughness: 0.95 });
const ELEV_MAT  = new THREE.MeshStandardMaterial({ color: '#34383d', roughness: 0.7, metalness: 0.35 });
const LINE_Y    = new THREE.MeshStandardMaterial({ color: '#e8c84a', roughness: 0.6 });   // painted yellow (light-responsive)
const LINE_W    = new THREE.MeshStandardMaterial({ color: '#d8dde0', roughness: 0.6 });   // painted white (light-responsive)
const DRUM_MAT  = new THREE.MeshStandardMaterial({ color: '#b6452f', roughness: 0.6, metalness: 0.3 });
const CRATE_MAT = new THREE.MeshStandardMaterial({ color: '#6f5a39', roughness: 0.95 });
const LAMP_MAT  = new THREE.MeshStandardMaterial({ color: '#fff4d6', emissive: '#fff0c0', emissiveIntensity: 1.4 });

function paintStripe(w, d, mat, x, z, y = 0.06) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), mat);
  m.position.set(x, y, z);
  return m;
}

export class Garage {
  constructor(team = 'red') {
    this.team = team;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0c0f13');
    this.scene.fog = new THREE.Fog('#0c0f13', 70, 240);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.slots = [];          // { vehicle, type, baseX, baseZ, heading }
    this.selIndex = 0;
    this.types = ['firebrat', 'valkyrie', 'lurcher', 'jotun'];   // type cycle order
    this.selType = 'firebrat';
    this.lampTime = 0;
    // Deploy state machine: 'select' (browsing, nothing animates) → 'rolling'
    // (confirmed: deploy vehicle powers up + drives onto the lift) → 'rising'
    // (elevator lifts it out) → 'done'.
    this.phase = 'select';
    this.losses = {};         // { type: number lost } — drives attrition
    this.deploy = null;       // active deploy sequence data
    this.liftY = 0;           // current elevator height
    this.riseProgress = 0;    // 0..1, drives the main fade-to-field
    this._deployCbs = [];
    this.vehScale = 1;        // global multiplier on every vehicle's base scale
    this._ray = new THREE.Raycaster();
    this._selectCbs = [];     // listeners fired on every select(), with the new index

    this._buildLights();
    this._buildRoom();
    this._buildCeiling();
    this._buildBays();
    this.setVehicleScale(2.6);   // settled fleet size (slider seeds from this)
    this._buildSelectionLight();
    this._buildVictoryFX();
    this._buildCamera();
    this.selectType(this.types[0]);
  }

  _buildLights() {
    // Heavy mood: almost no ambient, NO directional. A few dim ceiling lamp pools
    // carve the room out of the dark; the selection spotlight is the bright star.
    this.scene.add(new THREE.AmbientLight('#33414f', 0.34));   // low — pools do the work
    // Bright lamp pools OVER the bays (long Firebrat bay gets two) so the parked
    // rows are clearly lit; corners stay dark for the security-cam mood. decay 1
    // (not inverse-square) so the light actually reaches the floor below.
    for (const [x, z] of [[0, 24], [0, 52], [0, -30], [26, 0], [-26, 0], [0, 0]]) {
      const p = new THREE.PointLight('#ffd49a', 16, 135, 1);
      p.position.set(x, WALL_H - 1.5, z);
      this.scene.add(p);
      // Lamp fixtures hidden for now (light sources intentionally hidden) —
      // the PointLights stay, just no visible box mesh marking them.
      // const lamp = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 2.2), LAMP_MAT);
      // lamp.position.set(x, WALL_H - 0.6, z);
      // this.group.add(lamp);
    }
  }

  _buildRoom() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_HALF * 2, FLOOR_HALF * 2), FLOOR_MAT);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    // Perimeter walls.
    for (const [sx, sz] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const horiz = sz !== 0;
      const w = horiz ? FLOOR_HALF * 2 : 1.2;
      const d = horiz ? 1.2 : FLOOR_HALF * 2;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), WALL_MAT);
      wall.position.set(sx * FLOOR_HALF, WALL_H / 2, sz * FLOOR_HALF);
      wall.receiveShadow = true;
      this.group.add(wall);
    }

    // Elevator pad: a dark plate sitting FLUSH with the floor (0.3 tall, top at
    // y=0) so vehicles driven across don't sink into a raised lip. polygonOffset
    // pulls it in front of the coplanar floor so it doesn't z-fight.
    const pad = new THREE.Mesh(new THREE.BoxGeometry(ELEV_HALF * 2, 0.3, ELEV_HALF * 2), ELEV_MAT);
    pad.position.y = -0.15;
    pad.material.polygonOffset = true;
    pad.material.polygonOffsetFactor = -1;
    pad.material.polygonOffsetUnits = -1;
    pad.receiveShadow = true;
    this.group.add(pad);
    this.elevatorPad = pad;
    // Angled hazard-stripe border framing the lift.
    this.group.add(this._hazardFrame(ELEV_HALF, 2.4));

    // Big hydraulic ram beneath the pad — telescopes up to explain the lift. A
    // unit cylinder we scale/position each frame; hidden until the pad climbs.
    const ramMat = new THREE.MeshStandardMaterial({ color: '#6b7077', roughness: 0.32, metalness: 0.85 });
    this.ram = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 1, 28), ramMat);
    this.ram.visible = false;
    this.group.add(this.ram);
  }

  // Telescope the ram so it spans from just under the floor up to the pad's
  // underside as the lift rises (hidden while the pad is flush).
  _updateRam() {
    const padBottom = this.elevatorPad.position.y - 0.15;
    if (padBottom <= 0.3) { this.ram.visible = false; return; }
    this.ram.visible = true;
    const base = -1;
    this.ram.scale.y = padBottom - base;
    this.ram.position.y = (base + padBottom) / 2;
  }

  // A flat square ring of diagonal caution stripes around the elevator. One mesh
  // (square shape with a square hole), planar-UV'd in world units so the stripes
  // run continuously and at a constant scale all the way around.
  _hazardFrame(half, bw) {
    const outer = half + bw;
    const shape = new THREE.Shape();
    shape.moveTo(-outer, -outer); shape.lineTo(outer, -outer);
    shape.lineTo(outer, outer); shape.lineTo(-outer, outer); shape.closePath();
    const hole = new THREE.Path();
    hole.moveTo(-half, -half); hole.lineTo(-half, half);
    hole.lineTo(half, half); hole.lineTo(half, -half); hole.closePath();
    shape.holes.push(hole);
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const period = 2.2;   // world units per stripe tile
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = pos.getX(i) / period;
      uv[i * 2 + 1] = pos.getY(i) / period;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mat = new THREE.MeshStandardMaterial({ map: makeHazardTexture(), roughness: 0.7 });
    const frame = new THREE.Mesh(geo, mat);
    frame.rotation.x = -Math.PI / 2;
    frame.position.y = 0.03;
    frame.receiveShadow = true;
    return frame;
  }

  // A shallow barrel-vault roof (half-cylinder squashed in Y) springing from the
  // wall tops, with transverse ribs to break up the smooth shell and semicircular
  // gable caps closing the ±Z ends. Closes the room off above the low walls.
  _buildCeiling() {
    const R = FLOOR_HALF, f = 0.42, L = FLOOR_HALF * 2;
    const ceilMat = new THREE.MeshStandardMaterial({
      color: '#5c636b', map: concreteTexture('#565c64'), roughness: 0.97, side: THREE.DoubleSide });
    const vault = new THREE.Mesh(
      new THREE.CylinderGeometry(R, R, L, 48, 1, true, Math.PI / 2, Math.PI), ceilMat);
    vault.rotation.x = Math.PI / 2;   // axis runs along Z
    vault.scale.y = f;                // squash the semicircle into a shallow ellipse
    vault.position.y = WALL_H;
    vault.receiveShadow = true;
    this.group.add(vault);

    // Transverse steel ribs hugging the inner surface.
    const ribMat = new THREE.MeshStandardMaterial({ color: '#33373d', roughness: 0.55, metalness: 0.45 });
    const N = 7;
    for (let i = 0; i < N; i++) {
      const z = -L / 2 + (i + 0.5) * (L / N);
      const rib = new THREE.Mesh(new THREE.TorusGeometry(R - 0.5, 0.7, 8, 40, Math.PI), ribMat);
      rib.scale.y = f;
      rib.position.set(0, WALL_H, z);
      this.group.add(rib);
    }

    // Gable end caps (semicircle tympanum) so you can't see out the barrel ends.
    const gableMat = new THREE.MeshStandardMaterial({
      color: '#9aa0a4', map: concreteTexture('#9aa0a4'), roughness: 0.95, side: THREE.DoubleSide });
    for (const s of [-1, 1]) {
      const cap = new THREE.Mesh(new THREE.CircleGeometry(R, 40, 0, Math.PI), gableMat);
      cap.scale.y = f;
      cap.position.set(0, WALL_H, s * FLOOR_HALF);
      this.group.add(cap);
    }
  }

  _park(type, x, z, heading) {
    const v = new Vehicle(type);
    v.setPose(x, 0, z, heading);
    v.idle(0);   // settle into a rest pose once, then stay powered-down until picked
    v.seat();    // seat on the floor in that exact rest pose (after the bob is applied)
    v.group.userData.slotIndex = this.slots.length;   // so a raycast hit maps back to its slot
    v.group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.group.add(v.group);
    this.slots.push({ vehicle: v, type, x, z, heading });
  }

  // Real-hangar parking: vehicles fit where they fit, not neat spokes. Each
  // group gets its own arrangement; the corner camera keeps part of each in view.
  // Camera sits in the (-X,-Z) corner: screen-RIGHT ≈ world (-X,+Z), the far
  // "back wall" is +Z, and "under the camera" is the near (-X,-Z) corner.
  _buildBays() {
    // Hand-placed in the in-game sandbox (in-game sandbox layout dump). Jotuns against the
    // far +Z wall, the Firebrat flight line angled across the near corner, the two
    // Valkyries on the east side, and the Lurchers along the west.
    this._park('jotun', -3.9, 38.4, 0.000);
    this._park('jotun', 19.6, 38.0, 0.000);
    this._park('firebrat', -6.8, -43.1, -2.479);
    this._park('firebrat', -45.5, -19.0, -2.434);
    this._park('firebrat', -36.0, -24.7, -2.453);
    this._park('firebrat', -26.6, -31.1, -2.470);
    this._park('firebrat', -16.8, -37.1, -2.474);
    this._park('firebrat', 7.6, -43.5, -2.869);
    this._park('valkyrie', 27.3, -28.3, 2.447);
    this._park('valkyrie', 28.1, 1.5, 1.606);
    this._park('lurcher', -34.1, -0.1, -1.771);
    this._park('lurcher', -28.6, 38.7, -1.866);
    this._park('lurcher', -37.1, 17.6, 4.851);

    // A couple of maintenance clusters tucked against the walls.
    this._props(-FLOOR_HALF + 16, FLOOR_HALF - 16);
    this._props(FLOOR_HALF - 16, -FLOOR_HALF + 16);
  }

  _props(x, z) {
    for (let i = 0; i < 3; i++) {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 1.8, 10), DRUM_MAT);
      drum.position.set(x + (Math.random() - 0.5) * 3, 0.9, z + (Math.random() - 0.5) * 3);
      this.group.add(drum);
    }
    const crate = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.2, 2.2), CRATE_MAT);
    crate.position.set(x + 2, 1.1, z - 2);
    this.group.add(crate);
  }

  _buildSelectionLight() {
    // Broad spotlight from above + two side fill lights so the picked vehicle is
    // wrapped in light from several angles (not one tight pool), + a glowing ring.
    this.spot = new THREE.SpotLight('#fff7e2', 75, 130, Math.PI / 4, 0.55, 1);
    this.spot.position.set(0, WALL_H + 8, 0);
    this.spot.castShadow = true;                  // the one shadow-caster — drama under the pick
    this.spot.shadow.mapSize.set(1024, 1024);
    this.spot.shadow.camera.near = 2;
    this.spot.shadow.camera.far = WALL_H + 18;
    this.spot.shadow.bias = -0.0004;
    this.spotTarget = new THREE.Object3D();
    this.scene.add(this.spotTarget);
    this.spot.target = this.spotTarget;
    this.scene.add(this.spot);

    // Side/front fill lights that reposition around the selected vehicle.
    this.fills = [];
    for (const [ox, oz] of [[13, -9], [-13, 9], [9, 13]]) {
      const fl = new THREE.PointLight('#ffe4b8', 13, 46, 1);
      this.scene.add(fl);
      this.fills.push({ light: fl, ox, oz });
    }

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(5.4, 6.6, 40),
      new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.12;
    this.group.add(ring);
    this.selRing = ring;
  }

  _buildCamera() {
    // Security camera mounted high in a corner, looking diagonally at the origin
    // (not square to the axes) — a lower, more cinematic angle than top-down.
    // Settled sandbox camera (corner security-cam, low and tight).
    this.baseFov = 60;
    this.camera = new THREE.PerspectiveCamera(this.baseFov, window.innerWidth / window.innerHeight, 0.5, 600);
    this.camera.position.set(-45, 22, -45);
    this.camera.lookAt(0, -8.5, 3);
    this.camTarget = { tx: 0, ty: -8.5, tz: 3 };
    this.onResize();
  }

  // Perspective fov is VERTICAL; on a tall portrait phone that collapses the
  // horizontal view. Widen the vertical fov in portrait so horizontal coverage
  // holds (matching the field camera's behaviour); landscape keeps baseFov.
  onResize() {
    const a = window.innerWidth / window.innerHeight;
    if (a >= 1) {
      this.camera.fov = this.baseFov;
    } else {
      const baseTan = Math.tan(THREE.MathUtils.degToRad(this.baseFov) / 2);
      this.camera.fov = Math.min(85, THREE.MathUtils.radToDeg(2 * Math.atan(baseTan / a)));
    }
    this.camera.aspect = a;
    this.camera.updateProjectionMatrix();
  }

  // Selection -----------------------------------------------------------
  _placeSelLight(s) {
    this.selRing.position.set(s.x, 0.12, s.z);
    this.spot.position.set(s.x, WALL_H + 8, s.z);
    this.spotTarget.position.set(s.x, 0, s.z);
    if (this.fills) for (const f of this.fills) f.light.position.set(s.x + f.ox, 7, s.z + f.oz);
  }
  onSelect(cb) { this._selectCbs.push(cb); }
  select(i) {
    if (!this.slots.length) return;
    this.selIndex = (i + this.slots.length) % this.slots.length;
    this._placeSelLight(this.slots[this.selIndex]);
    for (const cb of this._selectCbs) cb(this.selIndex);
  }
  selected() { return this.slots[this.selIndex]; }

  // Phase B: selection is by TYPE. Each type highlights its fixed deploy vehicle
  // (DEPLOY_SLOT) — the one that rolls onto the lift. `this.types` is the cycle
  // order; selType is the current pick.
  // Attrition (Phase D) --------------------------------------------------
  // How many of a type are left (deploy + surviving reserves).
  remaining(type) { return Math.max(0, (GARAGE_COUNTS[type] || 0) - (this.losses[type] || 0)); }
  typeAlive(type) { return this.remaining(type) > 0; }

  // Apply a per-type loss count. Reserves disappear most-hidden-first
  // (ATTRITION_ORDER); the deploy vehicle only goes once the whole type is wiped.
  // losses = { firebrat: 2, jotun: 1, ... }.
  applyRoster(losses = {}) {
    this.losses = { ...losses };
    for (const s of this.slots) { s.dead = false; s.vehicle.group.visible = true; }
    for (const type of Object.keys(this.losses)) {
      const L = Math.max(0, this.losses[type] | 0);
      const order = ATTRITION_ORDER[type] || [];
      const dead = order.slice(0, Math.min(L, order.length));
      if (L > order.length) dead.push(DEPLOY_SLOT[type]);   // type wiped → deploy gone too
      for (const idx of dead) { this.slots[idx].dead = true; this.slots[idx].vehicle.group.visible = false; }
    }
    this._ensureValidSelection();
  }
  _ensureValidSelection() {
    const t = this.typeAlive(this.selType) ? this.selType : this.types.find(x => this.typeAlive(x));
    if (t) { this.selType = t; this.select(DEPLOY_SLOT[t]); }
  }

  selectType(type) {
    if (this.phase !== 'select' || DEPLOY_SLOT[type] === undefined || !this.typeAlive(type)) return;
    this.selType = type;
    this.select(DEPLOY_SLOT[type]);
  }
  cycleType(dir = 1) {
    if (this.phase !== 'select') return;
    const n = this.types.length;
    let i = this.types.indexOf(this.selType);
    for (let step = 0; step < n; step++) {
      i = (i + dir + n) % n;
      if (this.typeAlive(this.types[i])) { this.selectType(this.types[i]); return; }
    }
  }
  // Click a vehicle to select its TYPE (snaps the light to that type's deploy
  // vehicle). ndc = {x,y} normalized device coords. Returns the type, or null.
  pickType(ndc) {
    if (this.phase !== 'select') return null;
    this.scene.updateMatrixWorld(true);
    this._ray.setFromCamera(ndc, this.camera);
    const hits = this._ray.intersectObjects(this.slots.map(s => s.vehicle.group), true);
    if (!hits.length) return null;
    let o = hits[0].object;
    while (o && o.userData.slotIndex === undefined) o = o.parent;
    if (!o) return null;
    const type = this.slots[o.userData.slotIndex].type;
    this.selectType(type);
    return type;
  }

  // Phase C: confirm the current selection → deploy. The deploy vehicle powers up
  // (engine + gait), drives onto the lift, and rises out. Fires onDeploy(type)
  // listeners (engine sound, team-colour lock). No-op unless we're still selecting.
  onDeploy(cb) { this._deployCbs.push(cb); }

  // Reset to the selection state (used when a vehicle drives back to base & returns
  // to the garage). No inside-garage animation — just restore the deploy vehicle to
  // its parked slot and drop the lift back flush.
  reset() {
    if (this.deploy) this.deploy.veh.setPose(this.deploy.fromX, 0, this.deploy.fromZ, this.deploy.fromH);
    this.deploy = null;
    // Tear down any victory staging (winner back in its slot, flag + confetti off).
    if (this._winSlot) { const s = this._winSlot; s.vehicle.setPose(s.x, 0, s.z, s.heading); this._winSlot = null; }
    if (this.victoryFlag) this.victoryFlag.visible = false;
    if (this.victoryLight) this.victoryLight.intensity = 0;
    if (this.confetti) { this.confetti.visible = false; for (const p of this._conf) p.mesh.visible = false; }
    this.selRing.visible = true;
    this.phase = 'select';
    this.liftY = 0;
    this.riseProgress = 0;
    this.elevatorPad.position.y = -0.15;
    if (this.ram) this.ram.visible = false;
    this.selectType(this.selType);   // restore the selection highlight/light
  }

  confirm() {
    if (this.phase !== 'select') return false;
    const s = this.selected();
    this.phase = 'rolling';
    // Drive straight onto the lift nose-first instead of pirouetting to a fixed
    // facing: aim the heading down the travel vector (slot → lift centre). Forward
    // is local -Z, so the heading that points at the origin is atan2(x, z). Parked
    // craft already sit roughly facing the centre, so this is a small steer, not a
    // spin — skids shouldn't twirl on their way out.
    const travelH = Math.atan2(s.x, s.z);
    this.deploy = { veh: s.vehicle, fromX: s.x, fromZ: s.z, fromH: s.heading, targetH: travelH, t: 0 };
    for (const cb of this._deployCbs) cb(this.selType);
    return true;
  }

  _updateDeploy(dt) {
    const d = this.deploy;
    d.t += dt;
    if (this.phase === 'rolling') {
      const k = easeInOut(Math.min(1, d.t / ROLL_TIME));
      const x = lerp(d.fromX, 0, k), z = lerp(d.fromZ, 0, k);
      const h = lerpAngle(d.fromH, d.targetH, k);
      d.veh.setPose(x, this.liftY, z, h);
      d.veh.model.update(dt, 1, 0);        // driving gait while it rolls
      this._placeSelLight({ x, z });
      if (d.t >= ROLL_TIME) { this.phase = 'rising'; d.t = 0; }
    } else if (this.phase === 'rising') {
      const k = Math.min(1, d.t / RISE_TIME);
      this.liftY = easeInOut(k) * LIFT_RISE;
      this.elevatorPad.position.y = -0.15 + this.liftY;
      d.veh.holder.position.y = this.liftY;
      this._updateRam();
      this.riseProgress = k;               // main fades to black over this
      d.veh.model.update(dt, 0.4, 0);
      if (k >= 1) this.phase = 'done';
    }
  }

  // Rescale every parked vehicle from its per-type base scale (used once at build
  // to set settled fleet size).
  setVehicleScale(mult) {
    this.vehScale = mult;
    for (const s of this.slots) s.vehicle.setScale(mult);
  }

  // --- Victory cinematic (3D, in-hangar) --------------------------------
  // A pool of confetti flakes that rain down over the lift, plus a flag standard
  // raised beside the winning vehicle. Staged later by playWin(); leftover scaffolding
  // (a ring of celebrants — beer-toasting crew) can hang off _buildVictoryFX too.
  _buildVictoryFX() {
    const N = 260;
    this.confetti = new THREE.Group();
    this.confetti.visible = false;
    this.scene.add(this.confetti);
    this._conf = [];
    const geo = new THREE.PlaneGeometry(0.7, 1.05);
    for (let i = 0; i < N; i++) {
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        side: THREE.DoubleSide, roughness: 0.5, metalness: 0.0, emissive: '#000000',
      }));
      mesh.visible = false;
      this.confetti.add(mesh);
      this._conf.push({ mesh, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0, rz: 0 });
    }
    // A flag standard presented on the lift next to the winner. The cloth is
    // emissive so it reads as a bright victory banner under the confetti.
    const flag = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 15, 8),
      new THREE.MeshStandardMaterial({ color: '#e7eaec', roughness: 0.35, metalness: 0.6, emissive: '#333', emissiveIntensity: 0.4 }));
    pole.position.y = 7.5;
    flag.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(7, 4),
      new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.55, emissive: '#000', emissiveIntensity: 0.55 }));
    cloth.position.set(3.5, 12.5, 0);
    flag.add(cloth);
    flag.visible = false;
    this.group.add(flag);
    this.victoryFlag = flag;
    this.victoryCloth = cloth;

    // A bright dedicated key light on the lift during the cinematic (off otherwise),
    // so the dark-hulled winner pops out of the confetti instead of staying murky.
    this.victoryLight = new THREE.PointLight('#fff2d0', 0, 70, 1.3);
    this.victoryLight.position.set(0, 15, 7);
    this.scene.add(this.victoryLight);
  }

  _respawnConfetti(p, spreadFull = false) {
    const m = p.mesh;
    m.visible = true;
    m.position.set((Math.random() - 0.5) * ELEV_HALF * 3.4,
      spreadFull ? Math.random() * 30 : 24 + Math.random() * 10,
      (Math.random() - 0.5) * ELEV_HALF * 3.4);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    p.vx = (Math.random() - 0.5) * 2.4;
    p.vz = (Math.random() - 0.5) * 2.4;
    p.vy = -2 - Math.random() * 3;
    p.rx = (Math.random() - 0.5) * 9; p.ry = (Math.random() - 0.5) * 9; p.rz = (Math.random() - 0.5) * 9;
    const pal = this._confPalette;
    m.material.color.set(pal[(Math.random() * pal.length) | 0]);
  }

  _updateConfetti(dt) {
    for (const p of this._conf) {
      const m = p.mesh;
      m.position.x += p.vx * dt; m.position.y += p.vy * dt; m.position.z += p.vz * dt;
      p.vy = Math.max(-13, p.vy - 9 * dt);     // gravity, terminal velocity
      m.rotation.x += p.rx * dt; m.rotation.y += p.ry * dt; m.rotation.z += p.rz * dt;
      if (m.position.y < 0.3) this._respawnConfetti(p);   // recycle near the floor → endless rain
    }
  }

  // Stage the win: present the winning type's deploy vehicle up on the raised lift,
  // facing the camera, with a flag + raining confetti in the team colour.
  playWin(type, teamHex = '#ffd24a') {
    if (DEPLOY_SLOT[type] === undefined) type = 'firebrat';
    this.selType = type;
    const s = this.slots[DEPLOY_SLOT[type]];
    this._winSlot = s;
    s.vehicle.group.visible = true;
    const presentH = 5;
    this.liftY = presentH;
    this.elevatorPad.position.y = -0.15 + presentH;
    if (this.ram) { this.ram.visible = true; this._updateRam(); }
    const faceH = Math.atan2(this.camera.position.x, this.camera.position.z) + Math.PI;   // front (-Z) toward the cam
    s.vehicle.setPose(0, presentH, 0, faceH);
    this._placeSelLight({ x: 0, z: 0 });
    this.selRing.visible = false;
    this.victoryFlag.visible = true;
    this.victoryFlag.position.set(-7, presentH, 5);
    this.victoryCloth.material.color.set(teamHex);
    this.victoryCloth.material.emissive.set(teamHex);
    this.victoryLight.intensity = 70;
    this._confPalette = [teamHex, teamHex, teamHex, '#ffffff', '#ffd24a'];
    this.confetti.visible = true;
    for (const p of this._conf) this._respawnConfetti(p, true);   // pre-fill the column so it rains from frame 1
    this.phase = 'victory';
  }

  update(dt) {
    // Nothing animates while just browsing — the whole garage holds its powered-
    // down rest pose. Engines/gait only spin up once a deploy is CONFIRMED.
    if (this.phase === 'victory') {
      this._updateConfetti(dt);
      if (this._winSlot) this._winSlot.vehicle.model.update(dt, 0, 0);   // gentle idle on the winner
      if (this.victoryCloth) this.victoryCloth.rotation.y = Math.sin(this.lampTime * 2.5) * 0.22;   // flag flutter
    } else if (this.phase !== 'select') {
      this._updateDeploy(dt);
    }
    this.lampTime += dt;
    // gentle pulse on the selection ring
    const k = 0.7 + Math.sin(this.lampTime * 3) * 0.15;
    this.selRing.material.opacity = k;
  }
}
