import * as THREE from 'three';
import { applyCamoUVs, getTeamColor, makeCamoMaterial } from './CamoTexture.js';
import { makeMuzzleFlash, flashMuzzle, updateMuzzle, decayRecoil } from './GunFX.js';

export class Lurcher {
  constructor() {
    this.group       = new THREE.Group();
    this.hoverTime   = 0;
    this.legs        = [];
    this.gaitPhase   = 0;
    this.turretGroup = null;
    this._muzzles    = [];
    this._recoil     = 0;
    this._muzzleIx   = 0;

    // Shared leg constants
    this.THIGH_L = 0.68;
    this.SHIN_L  = 0.72;
    this.BODY_R  = 0.52;  // hip attachment radius
    this.HIP_H   = 0.24;  // hip height (body equator)
    this.REST_R  = 1.34;  // resting foot radial distance

    // Pre-allocated vectors to avoid GC pressure in update()
    this._hipV  = new THREE.Vector3();
    this._footV = new THREE.Vector3();
    this._pole  = new THREE.Vector3(0, 1, 0);
    this._up    = new THREE.Vector3(0, 1, 0);

    this._build();
  }

  _build() {
    this._buildModel();
  }

  // ── IK helpers ────────────────────────────────────────────────────────────────

  // Two-bone IK: returns knee world position.
  // Knee bends toward `pole` (up = insect high-knee stance).
  _solveIK(hip, foot, L1, L2, pole) {
    const toFoot = new THREE.Vector3().subVectors(foot, hip);
    const d = Math.min(toFoot.length(), L1 + L2 - 0.001);
    if (d < 0.001) return hip.clone().add(new THREE.Vector3(0, L1, 0));

    const dir      = toFoot.clone().normalize();
    const cosAngle = Math.max(-1, Math.min(1, (L1*L1 + d*d - L2*L2) / (2*L1*d)));
    const angle    = Math.acos(cosAngle);

    // Pole component perpendicular to reach direction
    const poleDot  = pole.dot(dir);
    const polePerp = pole.clone().addScaledVector(dir, -poleDot);
    if (polePerp.lengthSq() < 0.0001) polePerp.set(1, 0, 0);
    polePerp.normalize();

    return hip.clone()
      .add(dir.clone().multiplyScalar(L1 * Math.cos(angle)))
      .add(polePerp.multiplyScalar(L1 * Math.sin(angle)));
  }

  // Orient a CylinderGeometry mesh (Y-axis = long axis) so it spans from point A to point B.
  _placeSegment(mesh, a, b) {
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(b, a);
    if (dir.lengthSq() < 0.0001) return;
    dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(this._up, dir);
    mesh.setRotationFromQuaternion(q);
  }

  // ── Shared leg builder ────────────────────────────────────────────────────────

  _buildLegs(bodyMat, darkMat, accentMat, accentColor) {
    for (let i = 0; i < 6; i++) {
      const a  = i * Math.PI / 3;
      const hx = Math.cos(a) * this.BODY_R;
      const hz = -Math.sin(a) * this.BODY_R;
      const hip  = new THREE.Vector3(hx, this.HIP_H, hz);

      const fx0 = Math.cos(a) * this.REST_R;
      const fz0 = -Math.sin(a) * this.REST_R;
      const foot0 = new THREE.Vector3(fx0, 0, fz0);
      const knee0 = this._solveIK(hip, foot0, this.THIGH_L, this.SHIN_L, this._pole);

      // Hip joint sphere
      const hipSphere = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 6), darkMat);
      hipSphere.position.copy(hip);
      this.group.add(hipSphere);

      // Thigh — thick tapered cylinder
      const thighGeom = new THREE.CylinderGeometry(0.038, 0.058, this.THIGH_L, 8);
      applyCamoUVs(thighGeom);
      const thigh = new THREE.Mesh(thighGeom, bodyMat);
      this.group.add(thigh);
      this._placeSegment(thigh, hip, knee0);

      // Knee joint sphere
      const kneeSphere = new THREE.Mesh(new THREE.SphereGeometry(0.052, 8, 6), darkMat);
      kneeSphere.position.copy(knee0);
      this.group.add(kneeSphere);

      // Shin — thinner tapered cylinder
      const shinGeom = new THREE.CylinderGeometry(0.020, 0.036, this.SHIN_L, 8);
      applyCamoUVs(shinGeom);
      const shin = new THREE.Mesh(shinGeom, bodyMat);
      this.group.add(shin);
      this._placeSegment(shin, knee0, foot0);

      // Foot — a plus-shaped claw: a center hub with four LOW-POLY (4-sided) tapered prongs
      // radiating along ±X / ±Z, angled downward so the pointed tips bite toward the ground.
      const footPad = new THREE.Group();
      const DOWN = 0.14, LIFT = 0;                                       // tip droop angle; no lift
      footPad.add(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.04, 6), darkMat));
      for (let p = 0; p < 4; p++) {
        const th   = p * Math.PI / 2;
        const dir  = new THREE.Vector3(Math.cos(th) * Math.cos(DOWN), -Math.sin(DOWN), Math.sin(th) * Math.cos(DOWN));
        const claw = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.03, 0.14, 3), darkMat);
        claw.quaternion.setFromUnitVectors(this._up, dir);              // point the taper outward + down
        claw.position.copy(dir).multiplyScalar(0.07).add(new THREE.Vector3(0, LIFT, 0));   // base at hub, tip out
        footPad.add(claw);
      }
      footPad.position.copy(foot0);
      this.group.add(footPad);

      this.legs.push({
        angle: a,
        hip,
        thigh, kneeSphere, shin, footPad,
        phaseOffset: i / 6,
      });
    }
  }

  // ── Ironclad chassis — steel + cyan, twin barrels, armor panels ──────────────
  _buildModel() {
    const accentColor = getTeamColor();
    const bodyMat  = makeCamoMaterial({ roughness: 0.55, metalness: 0.70 });
    const accentMat= new THREE.MeshStandardMaterial({ color: accentColor, roughness: 0.30, metalness: 0.90, emissive: new THREE.Color(accentColor), emissiveIntensity: 0.38 });
    const darkMat  = new THREE.MeshStandardMaterial({ color: 0x0a1420, roughness: 0.65, metalness: 0.55 });

    this._buildLegs(bodyMat, darkMat, accentMat, accentColor);
    this._buildBody(bodyMat, accentMat, 0.52, 0.60, 0.30, 0.56);
    this._buildNeck(bodyMat, 0.30, 0.36, 0.24);

    // Thin black hex bands for contrast/detail: a collar at the base of the neck and a
    // ring slung under the body. 6-sided so they share the hull's facet alignment.
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1.0, metalness: 0.0 });
    this._buildHexRing(blackMat, this.HIP_H + 0.14, 0.42, 0.05);   // neck-base collar
    this._buildHexRing(blackMat, this.HIP_H - 0.17, 0.63, 0.05);   // under-body ring

    const TY = this.HIP_H + 0.15 + 0.24 + 0.06;
    const BY = TY + 0.15;   // raise barrels to clear legs during turret rotation
    this.turretGroup = new THREE.Group();
    this.group.add(this.turretGroup);
    this._buildHexTurret(bodyMat, darkMat, accentMat, accentColor, TY, 0.44, 0.48, 0.12);

    // Twin barrels — one mantlet drum per barrel
    for (const bx of [-0.15, 0.15]) {
      const mantletGeom = new THREE.CylinderGeometry(0.14, 0.14, 1.10, 8);
      applyCamoUVs(mantletGeom);
      const mantlet = new THREE.Mesh(mantletGeom, bodyMat);
      mantlet.rotation.x = Math.PI / 2;
      mantlet.position.set(bx, BY, -0.10);
      this.turretGroup.add(mantlet);

      const mantletCap = new THREE.Mesh(applyCamoUVs(new THREE.CylinderGeometry(0.070, 0.14, 0.10, 8)), bodyMat);
      mantletCap.rotation.x = Math.PI / 2;
      mantletCap.position.set(bx, BY, 0.50);
      this.turretGroup.add(mantletCap);

      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.052, 1.30, 8), darkMat);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(bx, BY, -1.30);
      this.turretGroup.add(barrel);

      const tip = new THREE.Mesh(applyCamoUVs(new THREE.CylinderGeometry(0.084, 0.068, 0.12, 8)), bodyMat);
      tip.rotation.x = Math.PI / 2;
      tip.position.set(bx, BY, -1.86);
      this.turretGroup.add(tip);

      // Muzzle flash anchored just past each barrel tip.
      const flash = makeMuzzleFlash(0xffe6a0, 0.42);
      flash.position.set(bx, BY, -1.98);
      this.turretGroup.add(flash);
      this._muzzles.push(flash);
    }

    // Black hex plate nestled in the seam: bottom resting on the turret hex head, top tucked
    // up against the underside of the barrels.
    const topHex = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.16, 6), blackMat);
    topHex.position.set(0, BY - 0.08, 0);
    this.turretGroup.add(topHex);

    // Single whip antenna at the rear of the guns, centred between the twin barrels.
    const whipDir  = new THREE.Vector3(0, 1, 0.35).normalize();   // up, raked back (+Z)
    const whipBase = new THREE.Vector3(0, BY, 0.25);              // between barrels, on the breech
    const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.018, 0.9, 7), darkMat);
    whip.quaternion.setFromUnitVectors(this._up, whipDir);
    whip.position.copy(whipBase).addScaledVector(whipDir, 0.45);  // foot pinned at the base
    this.turretGroup.add(whip);

    const gl = new THREE.PointLight(accentColor, 0.55, 3.4);
    gl.position.y = 0.35;
    this.group.add(gl);
  }

  // ── Shared body / neck / turret sub-builders ──────────────────────────────────

  _buildBody(bodyMat, accentMat, topR, botR, h, ringR) {
    const bodyGeom = new THREE.CylinderGeometry(topR, botR, h, 6);
    applyCamoUVs(bodyGeom);
    const body = new THREE.Mesh(bodyGeom, bodyMat);
    body.position.y = this.HIP_H;
    this.group.add(body);
  }

  _buildNeck(bodyMat, topR, botR, h) {
    const neckGeom = new THREE.CylinderGeometry(topR, botR, h, 6);
    applyCamoUVs(neckGeom);
    const neck = new THREE.Mesh(neckGeom, bodyMat);
    neck.position.y = this.HIP_H + 0.14 + h / 2;
    this.group.add(neck);
  }

  // Thin 6-sided band ring (flat hex disc), aligned with the hull facets. Sits proud of the
  // hull at radius `r`, height `h`. Used for contrast detailing on the body/neck.
  _buildHexRing(mat, y, r, h) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 6), mat);
    ring.position.y = y;
    this.group.add(ring);
    return ring;
  }

  _buildHexTurret(bodyMat, darkMat, accentMat, accentColor, cy, topR, botR, h) {
    const hexGeom = new THREE.CylinderGeometry(topR, botR, h, 6);
    applyCamoUVs(hexGeom);
    const hex = new THREE.Mesh(hexGeom, bodyMat);
    hex.position.y = cy;
    this.turretGroup.add(hex);
  }

  // ── Gait update ───────────────────────────────────────────────────────────────

  update(delta, forwardInput = 0, turnInput = 0) {
    this.hoverTime += delta;

    const fwdMag  = Math.abs(forwardInput);
    const turnMag = Math.abs(turnInput);
    const moving  = fwdMag + turnMag * 0.7;

    // Phase advances faster when moving; ticks slowly at idle for a subtle fidget
    this.gaitPhase = (this.gaitPhase + delta * (moving * 1.9 + 0.06)) % 1;

    const SWING      = 0.28;   // fraction of cycle spent swinging forward
    const MAX_STRIDE = 0.36;
    const MAX_STEP   = 0.20;   // foot lift height
    const IDLE_STR   = 0.03;   // tiny residual stride when stationary

    const stride = moving > 0.05 ? MAX_STRIDE * Math.max(fwdMag, turnMag * 0.7) : IDLE_STR;
    const stepH  = moving > 0.05 ? MAX_STEP : MAX_STEP * 0.15;

    for (let i = 0; i < this.legs.length; i++) {
      const leg   = this.legs[i];
      const a     = leg.angle;
      const phase = (this.gaitPhase + leg.phaseOffset) % 1;

      // Rest foot position in vehicle-local space
      const rx = Math.cos(a) * this.REST_R;
      const rz = -Math.sin(a) * this.REST_R;

      // Stride direction components:
      //   forward/back  → along -Z (vehicle forward) scaled by forwardInput
      //   turn          → tangential: (-sin a, 0, -cos a) × turnInput
      const fwdDZ  = -forwardInput;
      const trnDX  = -Math.sin(a) * turnInput;
      const trnDZ  = -Math.cos(a) * turnInput;

      // strideDir: -1 = back of stroke (foot behind), +1 = front (foot ahead)
      let strideDir, footY;
      if (phase < SWING) {
        // Swing: arcs quickly from back to front
        const t  = phase / SWING;
        strideDir = -1 + 2 * t;                        // −1 → +1
        footY     = stepH * Math.sin(Math.PI * t);
      } else {
        // Stance: slides slowly from front to back (propulsion)
        const t  = (phase - SWING) / (1 - SWING);
        strideDir = 1 - 2 * t;                         // +1 → −1
        footY     = 0;
      }

      const fx = rx + stride * trnDX  * strideDir;
      const fz = rz + stride * (fwdDZ + trnDZ) * strideDir;
      const fy = Math.max(0, footY);

      this._hipV.copy(leg.hip);
      this._footV.set(fx, fy, fz);

      const knee = this._solveIK(this._hipV, this._footV,
                                  this.THIGH_L, this.SHIN_L, this._pole);

      this._placeSegment(leg.thigh,     this._hipV,  knee);
      this._placeSegment(leg.shin,      knee,         this._footV);
      leg.kneeSphere.position.copy(knee);
      leg.footPad.position.copy(this._footV);
    }

    // Gentle body bob tied to gait
    this.group.position.y = moving > 0.05
      ? Math.sin(this.hoverTime * moving * 14) * 0.010
      : 0;

    // Idle units sweep the turret around forward; a controlled unit eases it to its
    // aim (`aimYaw`, 0 = forward) so the front stays readable while driving / firing.
    if (this.autoScan === false) {
      this.turretGroup.rotation.y += ((this.aimYaw || 0) - this.turretGroup.rotation.y) * Math.min(1, delta * 8);
    } else {
      this.turretGroup.rotation.y = Math.sin(this.hoverTime * 0.6) * 0.6;
    }

    // Recoil: turret kicks back on a shot and slides forward to rest; flashes fade.
    // Kick STRAIGHT BACK along the barrels' aim (turret yaw), not the hull's Z — so a
    // turret rotated to fire sideways recoils sideways too, matching the shot direction.
    this._recoil = decayRecoil(this._recoil, delta, 0.16);
    const recoilDist = this._recoil * 0.22, ty = this.turretGroup.rotation.y;
    this.turretGroup.position.x = Math.sin(ty) * recoilDist;
    this.turretGroup.position.z = Math.cos(ty) * recoilDist;
    for (const m of this._muzzles) updateMuzzle(m, delta);

    // Subtle body roll into turns
    this.group.rotation.z +=
      (-turnInput * 0.04 - this.group.rotation.z) * Math.min(1, delta * 5);
  }

  // Fire one barrel (alternating) — kicks the turret and pops that muzzle.
  // Returns the fired muzzle (for projectile spawning).
  fire() {
    const m = this._muzzles[this._muzzleIx % this._muzzles.length];
    this._muzzleIx++;
    flashMuzzle(m);
    this._recoil = 1;
    return m;
  }
}
