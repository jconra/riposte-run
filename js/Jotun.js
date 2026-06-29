import * as THREE from 'three';
import { getTeamColor, makeCamoMaterial, applyFacetedCamoUVs } from './CamoTexture.js';
import { makeMuzzleFlash, flashMuzzle, updateMuzzle, decayRecoil } from './GunFX.js';

// World units of surface per camo tile. Bigger = the camo pattern is stretched over more
// of the tank, so it repeats far fewer times (and the cells read coarser). Was 0.5 (the
// pattern recurred ~8× along the hull → looked repetitive); 2.0 → only ~2 repeats.
const CAMO_TILE = 2.0;

// STEP 1 (treads only) — modelled on the M92A3 "Gargantua" reference:
//   • FLAT bottom (long ground contact) along a row of evenly-spaced road wheels.
//   • Raised front IDLER → the track sweeps up into a wedge prow at the front (-Z).
//   • Smaller rear idler → the stretched top slopes down toward the back (+Z).
// The belt outline is the convex hull of all the wheel circles, so it hugs them
// exactly no matter how they're laid out.
export class Jotun {
  constructor() {
    this.group       = new THREE.Group();
    this.hoverTime   = 0;
    this.treadOffsetL = 0;   // left belt scroll
    this.treadOffsetR = 0;   // right belt scroll (differs from left while turning)
    this._dummy      = new THREE.Object3D();
    this._muzzles    = [];
    this._recoil     = 0;
    this._build();
  }

  _build() {
    // front: raised front idler (z=-a). rear: low idler (z=+a). road wheels along the
    // flat bottom. All ground wheels have centerY = their radius so their bottoms line
    // up on y=0 (the flat). `lift` raises the front idler off the ground into a wedge.
    const CFG = { a: 1.7, centerY: -0.34, sideX: 0.58, nRoad: 6,
      front: { r: 0.28, lift: 0.62 }, rear: { r: 0.22 }, rRoad: 0.20, roadZ: [-1.05, 1.15],
      linkW: 0.34, linkH: 0.07, linkL: 0.12, metalColor: 0x1a0e06, wheelColor: 0x0e0805 };
    this._treads(CFG);
  }

  _wheelLayout(cfg) {
    const wheels = [];
    wheels.push({ z:  cfg.a, y: cfg.front.lift, r: cfg.front.r, kind: 'idler' });   // raised idler — REAR (+Z), high
    wheels.push({ z: -cfg.a, y: cfg.rear.r,     r: cfg.rear.r,  kind: 'idler' });   // small idler — FRONT (-Z), low
    const [z0, z1] = cfg.roadZ;
    for (let i = 0; i < cfg.nRoad; i++) {
      const z = z0 + (z1 - z0) * (cfg.nRoad === 1 ? 0.5 : i / (cfg.nRoad - 1));
      wheels.push({ z, y: cfg.rRoad, r: cfg.rRoad, kind: 'road' });                  // road wheel on the flat
    }
    return wheels;
  }

  // ── Belt outline = convex hull of every wheel circle ────────────────────────────
  _buildBeltPath(wheels) {
    const K = 26;
    const pts = [];
    for (const w of wheels)
      for (let i = 0; i < K; i++) {
        const a = (i / K) * Math.PI * 2;
        pts.push({ z: w.z + w.r * Math.cos(a), y: w.y + w.r * Math.sin(a) });
      }

    // Andrew's monotone chain → CCW convex hull.
    pts.sort((p, q) => (p.z - q.z) || (p.y - q.y));
    const cross = (o, a, b) => (a.z - o.z) * (b.y - o.y) - (a.y - o.y) * (b.z - o.z);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    lower.pop(); upper.pop();
    const hull = lower.concat(upper);

    const cum = [0];
    let total = 0;
    for (let i = 1; i <= hull.length; i++) {
      const a = hull[i - 1], b = hull[i % hull.length];
      total += Math.hypot(b.z - a.z, b.y - a.y);
      cum.push(total);
    }
    this._belt = { pts: hull, cum, total };
  }

  _pathAt(s) {
    const { pts, cum, total } = this._belt;
    const target = (((s % 1) + 1) % 1) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    const i1 = lo === 0 ? 1 : lo, i0 = i1 - 1;
    const span = cum[i1] - cum[i0] || 1;
    const f = (target - cum[i0]) / span;
    const A = pts[i0 % pts.length], B = pts[i1 % pts.length];
    return { z: A.z + (B.z - A.z) * f, y: A.y + (B.y - A.y) * f, tanZ: B.z - A.z, tanY: B.y - A.y };
  }

  _updateTreads() {
    if (!this.treadMesh) return;
    const { centerY, sideX } = this._beltParams;
    const N = this._nLinks, d = this._dummy;
    for (let i = 0; i < N * 2; i++) {
      const left = i < N;
      const side = left ? -1 : 1;
      const pt   = this._pathAt((i % N) / N + (left ? this.treadOffsetL : this.treadOffsetR));
      d.position.set(side * sideX, pt.y + centerY, pt.z);
      d.rotation.set(Math.atan2(pt.tanY, pt.tanZ), 0, 0);
      d.updateMatrix();
      this.treadMesh.setMatrixAt(i, d.matrix);
    }
    this.treadMesh.instanceMatrix.needsUpdate = true;
  }

  // ── Tread assembly: wheels + animated link belt ─────────────────────────────────
  _treads(cfg) {
    const { centerY, sideX, linkW, linkH, linkL, metalColor, wheelColor } = cfg;
    const wheels = this._wheelLayout(cfg);
    this._buildBeltPath(wheels);
    this._beltParams = { centerY, sideX };
    this._nLinks = Math.max(8, Math.floor(this._belt.total / linkL));

    const accentColor = getTeamColor();
    const wheelMat  = new THREE.MeshStandardMaterial({ color: wheelColor, roughness: 0.5, metalness: 0.85 });
    const linkMat   = new THREE.MeshStandardMaterial({ color: metalColor, roughness: 0.55, metalness: 0.8 });
    const accentMat = new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.3, metalness: 0.8,
                                                       emissive: new THREE.Color(accentColor), emissiveIntensity: 0.6 });

    // Wheels: a disc on each belt side, with a glowing hub.
    const innerX = sideX - (linkW + 0.04) / 2;           // x of each wheel's inner face
    const drivePoint = new THREE.Vector3(0, centerY + 0.55, cfg.a * 0.45);  // single hub inside the hull
    const axleUp = new THREE.Vector3(0, 1, 0);
    for (const w of wheels) {
      const geo = new THREE.CylinderGeometry(w.r, w.r, linkW + 0.04, 20);
      const hubGeo = new THREE.CylinderGeometry(w.r * 0.32, w.r * 0.32, linkW + 0.06, 12);
      for (const sx of [-sideX, sideX]) {
        const disc = new THREE.Mesh(geo, wheelMat);
        disc.rotation.z = Math.PI / 2;
        disc.position.set(sx, centerY + w.y, w.z);
        this.group.add(disc);
        const hub = new THREE.Mesh(hubGeo, accentMat);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(sx, centerY + w.y, w.z);
        this.group.add(hub);
      }
      // Every wheel's axle (both sides) runs to ONE shared drive point inside the hull.
      for (const sgn of [-1, 1]) {
        const A = new THREE.Vector3(sgn * innerX, centerY + w.y, w.z);   // wheel inner hub
        const dir = new THREE.Vector3().subVectors(drivePoint, A);
        const len = dir.length();
        const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, len, 10), wheelMat);
        axle.position.copy(A).addScaledVector(dir, 0.5);                 // midpoint
        axle.quaternion.setFromUnitVectors(axleUp, dir.normalize());
        this.group.add(axle);
      }
    }

    // Animated link belt (both sides packed into one instanced mesh).
    const linkGeo = new THREE.BoxGeometry(linkW, linkH, linkL);
    this.treadMesh = new THREE.InstancedMesh(linkGeo, linkMat, this._nLinks * 2);
    this.treadMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.treadMesh);
    this._updateTreads();

    // Interlocking diamond "scale" armor over the higher front part of each track.
    this._trackArmor(cfg, { sideX, linkW, centerY });

    // Thick center wedge filling the rear gap between the two tracks, under the high run.
    this._centerFiller(cfg, { sideX, linkW, centerY });

    // Turret head — one very large diamond, centered up front above the tracks.
    this._turretHead(cfg);

    const glow = new THREE.PointLight(accentColor, 0.5, 3.6);
    glow.position.set(0, centerY + cfg.front.lift + 0.2, -cfg.a * 0.4);
    this.group.add(glow);
  }

  // ── Track-top armor plates ───────────────────────────────────────────────────────
  // One long ISOSCELES-TRAPEZOID plate per side, laid over the top run of the track
  // like a tapered fender — narrow over the low front idler (-Z), widening toward the
  // tall rear idler (+Z). Beveled edges + a routed inner panel (the detailing we like).
  // Deliberately leaves the hull sides, wheels and treads exposed — no full blanket.
  _trackArmor(cfg, { sideX, centerY }) {
    const a = cfg.a;
    const highTop = cfg.front.lift + cfg.front.r;  // tall rear idler — REAR (+Z), high
    const lowTop  = cfg.rear.r * 2;                 // low front idler — FRONT (-Z), low
    const topY = (z) => lowTop + (highTop - lowTop) * THREE.MathUtils.clamp((z + a) / (2 * a), 0, 1);
    const plateY = (z) => centerY + topY(z) + 0.06;  // ride just above the belt top

    const mat = makeCamoMaterial({ roughness: 0.6, metalness: 0.5 });
    mat.side = THREE.DoubleSide;
    // Thin plates (~60% of the old slab) so they read as hull panels, not a blanket.
    const opts = { thickness: 0.036, bevel: 0.0145, route: 0.06, routeDepth: 0.013, mat };
    // Lower (main) plate is half as thick — scale the depth-direction features by 0.5.
    const optsLower = { ...opts, thickness: opts.thickness * 0.5,
                        bevel: opts.bevel * 0.5, routeDepth: opts.routeDepth * 0.5 };

    // Two overlapping plates per side over the REAR of the track (z fractions of a):
    // the front low idler (-Z) stays bare; a rear plate shingles over the main plate.
    const F = { halfW: 0.20, main: [-0.18, 0.48], rear: [0.33, 0.92] };
    const FRONT_RAKE   = 0.34 * a;  // how far the main plate's front-OUTER corner sweeps forward (-Z)
    const NECK_INSET   = 0.08;       // how far the upper plate's inboard edge reaches toward the neck
    const FRONT_SHIFT  = 0.15 * a;  // move the main plate's two FRONT corners further forward
    const BACK_SHIFT   = 0.20 * a;  // move the rear plate's two BACK corners further aft (+Z)
    const INNER_CLOSER = 0.30;       // pull every inboard edge 30% closer to the centreline
    const INNER_BACK   = 0.30 * (F.rear[1] - F.rear[0]) * a;  // upper plate's inner-rear corner: 30% of its length, aft
    const INNER_FRONT  = 0.05 * a;  // lower plate's inner-front corner: extra forward (-Z)
    const FRONT_INNER_FWD = 0.10 * a;  // both plates' inner-front corner: a further 10% forward
    const OUTER_OUT    = 0.05;       // upper plate's outboard edge: 5% farther from centreline
    const OUTER_BACK   = 0.10 * a;  // upper plate's outer-rear corner: forward (-Z)

    for (const sgn of [-1, 1]) {
      this._fenderPlate(sgn, sideX, plateY, optsLower,
        { z0: F.main[0] * a, z1: F.main[1] * a, halfW: F.halfW,
          frontRake: FRONT_RAKE, frontShift: FRONT_SHIFT, innerCloser: INNER_CLOSER,
          innerFrontShift: INNER_FRONT + FRONT_INNER_FWD });
      this._fenderPlate(sgn, sideX, plateY, opts,
        { z0: F.rear[0] * a, z1: F.rear[1] * a, halfW: F.halfW + 0.01, lift: 0.03,
          innerInset: NECK_INSET, backShift: BACK_SHIFT, innerCloser: INNER_CLOSER, innerBackShift: INNER_BACK,
          outerOut: OUTER_OUT, outerBackShift: OUTER_BACK, innerFrontShift: 2 * FRONT_INNER_FWD });

      // Whip antenna standing off the back of the upper plate (one per side).
      const antZ = (F.rear[1] + 0.15) * a;                       // right out near the plate's rear edge
      const antX = sgn * sideX * 0.6;                            // pulled in toward the centre
      this._whipAntenna(new THREE.Vector3(antX, plateY(antZ) + 0.04, antZ), sgn);
    }
  }

  // A thin tapered whip antenna, raked well back (+Z) and a touch outboard. `base` is the
  // foot; the rod rises `height` along the rake.
  _whipAntenna(base, sgn, { height = 0.45 } = {}) {
    const dir = new THREE.Vector3(sgn * 0.12, 1, 0.60).normalize();   // up, leaning hard back & a bit out
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.4, metalness: 0.9 });

    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.018, height, 7), rodMat);
    rod.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    rod.position.copy(base).addScaledVector(dir, height / 2);        // foot pinned at `base`
    this.group.add(rod);
  }

  // One isosceles-trapezoid fender plate over a track. The OUTBOARD edge (z0..z1) is the
  // long parallel side; the INBOARD edge is centred and `innerFrac` (66%) of that length,
  // so the front and rear caps rake inward — a tapered sci-fi plate, not a rectangle.
  //   • `frontRake` sweeps just the front-OUTER corner further forward (longer raked nose).
  //   • `innerInset` pulls the whole inboard edge toward the centreline (toward the neck).
  //   • `innerCloser` scales the inboard edge a further fraction toward the centreline.
  //   • `frontShift` / `backShift` move BOTH front / BOTH rear corners fore / aft.
  //   • `innerBackShift` / `innerFrontShift` move ONLY the inner-rear / inner-front corner aft / forward.
  //   • `outerOut` pushes the whole outboard edge a fraction farther from the centreline.
  //   • `outerBackShift` moves ONLY the outer-rear corner forward (-Z).
  //   • `lift` raises it for a shingled overlap; it otherwise rides at plateY (close to belt).
  _fenderPlate(sgn, sideX, plateY, opts,
               { z0, z1, halfW, innerFrac = 0.66, lift = 0, frontRake = 0,
                 innerInset = 0, innerCloser = 0, frontShift = 0, backShift = 0,
                 innerBackShift = 0, innerFrontShift = 0, outerOut = 0, outerBackShift = 0 }) {
    const innerX = sgn * (sideX - halfW - innerInset) * (1 - innerCloser);  // inboard edge
    const outerX = sgn * (sideX + halfW) * (1 + outerOut);                  // outboard edge
    const mid = (z0 + z1) / 2, half = (z1 - z0) / 2;
    const zi0 = mid - half * innerFrac - frontShift - innerFrontShift; // inner-front (shifted forward)
    const zi1 = mid + half * innerFrac + backShift + innerBackShift;   // inner-rear  (shifted aft)
    const zOF = z0 - frontRake - frontShift;            // outer-front (raked + shifted forward)
    const zOR = z1 + backShift - outerBackShift;         // outer-rear  (aft, then pulled forward)
    const y = (z) => plateY(z) + lift;
    this._quadPlate([
      new THREE.Vector3(innerX, y(zi0), zi0),         // inner-front
      new THREE.Vector3(innerX, y(zi1), zi1),         // inner-rear
      new THREE.Vector3(outerX, y(zOR), zOR),         // outer-rear
      new THREE.Vector3(outerX, y(zOF), zOF),         // outer-front
    ], new THREE.Vector3(0, 1, 0), opts);
  }

  // Fit a beveled+routed plate to 4 (or 3) world-space corners. Derives an orthonormal
  // in-plane frame (u,v) + outward normal from the corners, projects them to 2D, builds
  // the plate flat via _armorPlate, then orients it back onto the corners. `outwardDir`
  // only disambiguates which way the normal should face (for lighting/winding).
  _quadPlate(corners, outwardDir, opts) {
    const A = corners[0];
    const u = new THREE.Vector3().subVectors(corners[1], A).normalize();
    const w = new THREE.Vector3().subVectors(corners[corners.length - 1], A);
    let n = new THREE.Vector3().crossVectors(u, w).normalize();
    if (n.dot(outwardDir) < 0) n.negate();
    const v = new THREE.Vector3().crossVectors(n, u).normalize();
    const quad2D = corners.map((P) => {
      const d = new THREE.Vector3().subVectors(P, A);
      return { x: d.dot(u), y: d.dot(v) };
    });
    const grp = this._armorPlate(quad2D, opts);
    grp.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(u, v, n));
    grp.position.copy(A);
    this.group.add(grp);
  }

  // A single beveled plate with a routed recess. The base plate is an extruded, beveled
  // polygon; a slightly smaller inner panel is raised proud of it, so the ring of base
  // surface left exposed around the perimeter reads as a recessed (routed) channel.
  _armorPlate(quad2D, { thickness, bevel, route, routeDepth, mat }) {
    const grp = new THREE.Group();
    const exo = { depth: thickness, bevelEnabled: true, bevelThickness: bevel,
                  bevelSize: bevel, bevelSegments: 1, steps: 1 };
    const toShape = (pts) => {
      const s = new THREE.Shape();
      s.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) s.lineTo(pts[i].x, pts[i].y);
      s.closePath();
      return s;
    };
    let base = new THREE.ExtrudeGeometry(toShape(quad2D), exo);
    base = applyFacetedCamoUVs(base, CAMO_TILE);
    grp.add(new THREE.Mesh(base, mat));

    const inner = this._insetPoly(quad2D, route);
    let cen = new THREE.ExtrudeGeometry(toShape(inner),
      { ...exo, bevelThickness: bevel * 0.8, bevelSize: bevel * 0.8 });
    cen = applyFacetedCamoUVs(cen, CAMO_TILE);
    const cm = new THREE.Mesh(cen, mat);
    cm.position.z = routeDepth;                 // raise the panel → recessed border channel
    grp.add(cm);
    return grp;
  }

  // Inset a convex polygon inward by `d` (offset every edge along its inward normal and
  // re-intersect adjacent edges). Winding-agnostic; returns points in the input order.
  _insetPoly(pts, d) {
    const n = pts.length;
    let area = 0;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n]; area += a.x * b.y - b.x * a.y; }
    const s = area > 0 ? 1 : -1;                 // inward-normal sign
    const off = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      let dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const nx = -dy * s, ny = dx * s;
      off.push([{ x: a.x + nx * d, y: a.y + ny * d }, { x: b.x + nx * d, y: b.y + ny * d }]);
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const e0 = off[(i - 1 + n) % n], e1 = off[i];
      out.push(this._lineInt(e0[0], e0[1], e1[0], e1[1]));
    }
    return out;
  }

  _lineInt(p1, p2, p3, p4) {
    const den = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
    if (Math.abs(den) < 1e-9) return { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
    const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / den;
    return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
  }

  // ── Octagonal "gem" — three 8-sided cylinders stacked on the vertical axis: a
  // tapered top cap, a thin octagonal middle slice, and a tapered bottom cap, then
  // stretched front-to-back. The caps are truncated frustums ending in a half-diameter
  // octagon (not a point), so two gems stack cleanly waist-to-waist. Added to `parent`.
  _octaGem(parent, { R, hSlice, hCap, stretch }) {
    const off = hSlice / 2 + hCap / 2;
    const camoMat = makeCamoMaterial({ roughness: 0.6, metalness: 0.5 });   // team digi camo
    const piece = (geo, y) => {
      geo.scale(1, 1, stretch);                                   // bake the front-to-back stretch
      geo = applyFacetedCamoUVs(geo, CAMO_TILE);                  // camo UVs (consistent density)
      const m = new THREE.Mesh(geo, camoMat);
      m.position.y = y;
      parent.add(m);
    };
    piece(new THREE.CylinderGeometry(R, R, hSlice, 8), 0);              // middle slice
    piece(new THREE.CylinderGeometry(R * 0.5, R, hCap, 8),  off);       // top cap → half-Ø octagon
    piece(new THREE.CylinderGeometry(R, R * 0.5, hCap, 8), -off);       // bottom cap → half-Ø octagon
  }

  // ── Turret head + body ──────────────────────────────────────────────────────────
  // The head is a slim octagonal gem perched at the high rear, in its own group so it
  // can be aimed later. The body is the same gem shape ~3× taller, stacked directly
  // below it (their half-Ø waists meet), forming the hull under the scale armor.
  _turretHead(cfg) {
    const headZ = cfg.a * 0.65;                                    // perched at the high rear
    const highTop = cfg.front.lift + cfg.front.r, lowTop = cfg.rear.r * 2;
    const topAtHead = lowTop + (highTop - lowTop) * ((headZ + cfg.a) / (2 * cfg.a));
    const headY = cfg.centerY + topAtHead + 0.25;                  // sit lower over the raised rear

    const head = { R: 0.42, hSlice: 0.08, hCap: 0.09, stretch: 1.6 };   // slim head
    this.turretGroup = new THREE.Group();
    this.turretGroup.position.set(0, headY, headZ);
    this._turretBaseZ = headZ;                    // rest position; update() sways z around this
    this.group.add(this.turretGroup);
    this._octaGem(this.turretGroup, head);

    // Rail gun — two triangular rails (3-sided cones), exact mirrors of each other.
    // Each rail's INNER edge runs straight along the firing axis at a tiny ±xInner
    // offset, so the two inner edges stay parallel and just inches apart the whole way
    // to the tip (the rail channel the slug rides). At the back each rail flares out to
    // a tall, wide VERTICAL base (outer vertices pushed out to xOuter, one high one low),
    // then tapers forward to a point. Built from explicit verts so the orientation is
    // exact rather than relying on cone rotation.
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x0c0c10, roughness: 0.45, metalness: 0.9 });
    gunMat.side = THREE.DoubleSide;
    // Glowing inner core material: cloned rail geometry, recoloured to the team glow.
    const railGlowColor = getTeamColor();
    const glowMat = new THREE.MeshStandardMaterial({ color: railGlowColor, roughness: 0.3, metalness: 0.6,
      emissive: new THREE.Color(railGlowColor), emissiveIntensity: 1.5 });
    glowMat.side = THREE.DoubleSide;
    // The glow core shares the SAME apex as the dark rail (same tip point) and is just a
    // slightly fatter sheath: its base spills past BOTH side faces by GLOW_OUT, tapering to
    // nothing at the shared tip → glow reads evenly on the inside AND outside. Adjust after render.
    const GLOW_OUT = 0.04;   // base widen past BOTH the inner and outer side faces
    const GLOW_H   = 0.30;   // glow base height vs the dark rail (thinned down)
    const gunLen = cfg.a * 1.8;
    const xInner = 0.05, xOuter = 0.30, hBase = 0.15, gunY = 0;
    const faces = [
      [1, 2, 3],   // vertical back base (inner-back + the two flared outer corners)
      [0, 2, 1],   // top face  (tip → outer-top-back → inner-back)
      [0, 3, 2],   // outer face (tip → outer-bottom-back → outer-top-back)
      [0, 1, 3],   // bottom face (tip → inner-back → outer-bottom-back)
    ];
    // Build one triangular rail wedge from explicit corners: apex (tipX,tipZ) tapering back
    // to a flared vertical base (inner edge at baseInnerX, outer edge at baseOuterX, height baseH).
    const makeRail = (tipX, tipZ, baseInnerX, baseOuterX, baseH) => {
      const V = [
        [ tipX,       gunY,            tipZ ],   // 0 apex
        [ baseInnerX, gunY,            0    ],   // 1 inner-back
        [ baseOuterX, gunY + baseH/2,  0    ],   // 2 outer-top-back
        [ baseOuterX, gunY - baseH/2,  0    ],   // 3 outer-bottom-back
      ];
      const pos = [];
      for (const f of faces) for (const i of f) pos.push(V[i][0], V[i][1], V[i][2]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    };

    for (const sgn of [-1, 1]) {
      // Dark rail: apex on the inner edge so the two inner edges stay ∥ → the slug channel.
      this.turretGroup.add(new THREE.Mesh(
        makeRail(sgn * xInner, -gunLen, sgn * xInner, sgn * xOuter, hBase), gunMat));

      // Glow core: SAME apex as the dark rail (sgn*xInner, -gunLen), just a fatter sheath whose
      // base spills past BOTH side faces (±GLOW_OUT) → glow reads on the inside AND the outside.
      this.turretGroup.add(new THREE.Mesh(
        makeRail(sgn * xInner, -gunLen,
                 sgn * (xInner - GLOW_OUT), sgn * (xOuter + GLOW_OUT), hBase * GLOW_H), glowMat));
    }

    // Muzzle flash at the shared rail apex (team-glow, big — it's a railgun).
    const railFlash = makeMuzzleFlash(railGlowColor, 1.05);
    railFlash.position.set(0, gunY, -gunLen - 0.05);
    this.turretGroup.add(railFlash);
    this._muzzles.push(railFlash);

    // Body — a faceted wedge hull beneath the armor.
    this._wedgeBody(cfg);

    // Black triangular neck under the head, pointing forward.
    this._neck();
  }

  // ── Throat / neck ─────────────────────────────────────────────────────────────────
  // A black triangular prism slung directly under the head: flat top + flat bottom, with a
  // triangular cross-section pointing forward (front tip at -Z, two corners splayed at the
  // back). Built from explicit verts so the front tip can be pushed forward independently.
  _neck() {
    const headY = this.turretGroup.position.y, headZ = this.turretGroup.position.z;
    const yTop = headY - 0.13;          // flat top, right under the head
    const yBot = yTop - 0.34;           // flat bottom
    const zBack = headZ + 0.08;         // back edge, just behind head centre
    const zTip  = headZ - 0.78;         // forward point — slide this further -Z to extend the tip
    const w     = 0.30;                 // half-width of the back edge

    //         tip(0)
    //        /      \      cross-section (looking down): one point forward, two corners back
    //  back-L(1)---back-R(2)
    const T = [[0, yTop, zTip], [-w, yTop, zBack], [ w, yTop, zBack]];  // top triangle
    const B = [[0, yBot, zTip], [-w, yBot, zBack], [ w, yBot, zBack]];  // bottom triangle
    const V = [...T, ...B];             // 0-2 top, 3-5 bottom
    const F = [
      0, 2, 1,            // flat top
      3, 4, 5,            // flat bottom
      0, 1, 4,  0, 4, 3,  // left side (tip → back-L)
      0, 3, 5,  0, 5, 2,  // right side (tip → back-R)
      1, 2, 5,  1, 5, 4,  // back face
    ];
    const pos = [];
    for (const i of F) pos.push(V[i][0], V[i][1], V[i][2]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.5, metalness: 0.4 });
    mat.side = THREE.DoubleSide;
    this.group.add(new THREE.Mesh(geo, mat));
  }

  // ── Wedge hull body ─────────────────────────────────────────────────────────────
  // The mass under the scale armor: a slab-sided faceted hull with a sloped top deck
  // matching the armor's underside angle, a front face dropping to a forward bottom
  // edge, a flat trapezoid bottom, and an angled back whose top edge reaches the
  // rearmost scales and whose raised bottom edge spans the full rear width.
  _wedgeBody(cfg) {
    const a = cfg.a, centerY = cfg.centerY, lift = 0.09;
    const highTop = cfg.front.lift + cfg.front.r, lowTop = cfg.rear.r * 2;
    const topY  = (z) => lowTop + (highTop - lowTop) * THREE.MathUtils.clamp((z + a) / (2 * a), 0, 1);
    const deckY = (z) => centerY + topY(z) + lift + 0.02;   // slightly into the scale bases so they fuse

    const zFront = -a * 0.25, zProw = a * 0.05;             // top-front leads; front-bottom swept further aft
    const zRearTop = a * 1.10, zRearBot = a * 0.90;          // top-rear reaches the furthest scales
    const wF = 0.26, wR = 0.36;                              // front / rear half-widths
    const prowY = centerY + 0.24, backBotY = centerY + 0.40; // raised well off the ground

    const V = [
      [-wF, deckY(zFront),   zFront],    // 0 top-front-left
      [ wF, deckY(zFront),   zFront],    // 1 top-front-right
      [-wR, deckY(zRearTop), zRearTop],  // 2 top-rear-left
      [ wR, deckY(zRearTop), zRearTop],  // 3 top-rear-right
      [-wF, prowY,           zProw],     // 4 front-bottom-left   (prow is now an edge, width = top-front)
      [ wF, prowY,           zProw],     // 5 front-bottom-right
      [-wR, backBotY,        zRearBot],  // 6 back-bottom-left    (raised, full rear width)
      [ wR, backBotY,        zRearBot],  // 7 back-bottom-right
    ];
    const F = [
      0, 1, 3,  0, 3, 2,   // sloped top deck
      0, 1, 5,  0, 5, 4,   // front face (top-front edge → front-bottom edge)
      4, 5, 7,  4, 7, 6,   // bottom (trapezoid)
      2, 3, 7,  2, 7, 6,   // angled back (top-rear edge → raised back-bottom edge)
      0, 2, 6,  0, 6, 4,   // left side
      1, 5, 7,  1, 7, 3,   // right side
    ];

    const pos = [];
    for (const i of F) pos.push(V[i][0], V[i][1], V[i][2]);
    let geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    geo = applyFacetedCamoUVs(geo, CAMO_TILE);

    const mat = makeCamoMaterial({ roughness: 0.6, metalness: 0.5 });
    mat.side = THREE.DoubleSide;
    this.group.add(new THREE.Mesh(geo, mat));
  }

  // ── Rear center filler ────────────────────────────────────────────────────────────
  // The tall rear idler lifts the top track run high at the back, leaving an open wedge
  // between the two belts. Fill it with ONE thick trapezoid slab: a side-profile
  // trapezoid (in the Y-Z plane) whose TOP edge follows the belt-top slope so it tucks
  // up under the upper run, with a flat bottom — then extruded clear across X (nearly the
  // full inter-track span) so it reads as solid mass fused to the hull, not a thin panel.
  _centerFiller(cfg, { sideX, linkW, centerY }) {
    const a = cfg.a;
    const highTop = cfg.front.lift + cfg.front.r;   // tall rear idler — REAR (+Z), high
    const lowTop  = cfg.rear.r * 2;                  // low front idler — FRONT (-Z), low
    const topY = (z) => lowTop + (highTop - lowTop) * THREE.MathUtils.clamp((z + a) / (2 * a), 0, 1);

    const zF = 0.28 * a;                              // front of the filler (where the run starts climbing)
    const zB = 0.76 * a;                              // back — pulled in a touch more, short of the rear idler
    const TOP_GAP = 0.07;                             // tuck the slanted top just under the belt top
    const yTop = (z) => centerY + topY(z) - TOP_GAP;
    const yBot = centerY + 0.45;                      // flat bottom

    // Reach out toward each track's OUTER face, then scaled to 85% of that span so the tracks
    // read as embedded in a solid block without fully burying their outer faces.
    const xHalf = (sideX + linkW / 2 - 0.02) * 0.85;

    const mat = makeCamoMaterial({ roughness: 0.6, metalness: 0.5 });
    mat.side = THREE.DoubleSide;
    // Really thick (spans the whole gap) so it fuses to the body; modest bevel + a routed
    // panel for the family look. thickness = the full X span the slab is extruded across.
    const opts = { thickness: 2 * xHalf, bevel: 0.03, route: 0.20, routeDepth: 0.022, mat };

    // Side-profile trapezoid at x = -xHalf, then extruded +X across to +xHalf.
    // Order gives an outward normal of +X (u = up, w = +Z ⇒ n = +X).
    this._quadPlate([
      new THREE.Vector3(-xHalf, yBot,      zF),       // front-bottom
      new THREE.Vector3(-xHalf, yTop(zF),  zF),       // front-top
      new THREE.Vector3(-xHalf, yTop(zB),  zB),       // back-top  (higher → slanted top)
      new THREE.Vector3(-xHalf, yBot,      zB),       // back-bottom
    ], new THREE.Vector3(1, 0, 0), opts);
  }

  update(delta, forwardInput = 0, turnInput = 0) {
    this.hoverTime += delta;
    this.group.position.y = (Math.abs(forwardInput) + Math.abs(turnInput)) * Math.sin(this.hoverTime * 22) * 0.005;
    // Idle units SCAN (sweep the head). A controlled unit instead eases the head to
    // its aim (`aimYaw`, 0 = forward) so the front reads while driving / firing.
    if (this.turretGroup) {
      if (this.autoScan === false) {
        this.turretGroup.rotation.y += ((this.aimYaw || 0) - this.turretGroup.rotation.y) * Math.min(1, delta * 8);
      } else {
        this.turretGroup.rotation.y = Math.sin(this.hoverTime * 0.6) * 0.6;
      }
      // Heavy railgun recoil: the head slams back off its rest, then settles. The kick
      // runs along the head's AIM (turret yaw), not the hull's Z, so a head turned to
      // fire off-axis slams straight back down its own barrel.
      this._recoil = decayRecoil(this._recoil, delta, 0.32);
      const recoilDist = this._recoil * 0.4, ty = this.turretGroup.rotation.y;
      this.turretGroup.position.x = Math.sin(ty) * recoilDist;
      this.turretGroup.position.z = this._turretBaseZ + Math.cos(ty) * recoilDist;
    }
    for (const m of this._muzzles) updateMuzzle(m, delta);
    // Skid-steer: turning runs the two belts at opposite rates, so the tracks visibly
    // move (and counter-rotate for a pivot turn) even when not driving forward.
    const k = delta * 1.1;
    this.treadOffsetL = (this.treadOffsetL + (forwardInput - turnInput) * k + 1) % 1;
    this.treadOffsetR = (this.treadOffsetR + (forwardInput + turnInput) * k + 1) % 1;
    this._updateTreads();
  }

  // Fire the railgun — one big flash + a heavy recoil slam. Returns the muzzle
  // (for projectile spawning).
  fire() {
    if (this._muzzles[0]) flashMuzzle(this._muzzles[0]);
    this._recoil = 1;
    return this._muzzles[0];
  }
}
