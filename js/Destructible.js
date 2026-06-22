// Destructible.js — shared HP/damage system. Anything shootable (walls, base
// buildings, defensive guns, bridges, palms, grass) registers here. Keeps the
// damage model in ONE place so every prop behaves consistently.

import * as THREE from 'three';

let _id = 0;

// Progressive battle-damage look. Scorch = the colour a battered surface fades toward.
const SCORCH = new THREE.Color('#241f1b');
const CRACK_STAGES = 4;
// Draw an IMPACT FRACTURE onto a texture canvas: cracks radiate out from a single
// point (a hit), zigzagging and forking like a shattered panel — not scattered loose
// segments. Called cumulatively (each stage = a new impact star as HP falls). One-off
// canvas draw per stage (≤4 over a prop's life), so no per-frame cost.
function drawCracks(ctx, w, h, frac) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Impact origin — somewhere on the face, biased away from the very edges.
  const ox = w * (0.2 + Math.random() * 0.6), oy = h * (0.2 + Math.random() * 0.6);
  const rays = 5 + Math.floor(frac * 6);          // more fractures the more battered it is
  const reach = Math.min(w, h) * (0.22 + frac * 0.32);
  // A small dark impact blotch at the centre, so the star reads as a HIT.
  ctx.fillStyle = 'rgba(15,12,9,0.5)';
  ctx.beginPath(); ctx.arc(ox, oy, 1.5 + frac * 2.5, 0, Math.PI * 2); ctx.fill();

  const drawRay = (sx, sy, ang0, len, width) => {
    let x = sx, y = sy, ang = ang0;
    const steps = 3 + (Math.random() * 3 | 0), step = len / steps;
    for (let s = 0; s < steps; s++) {
      ang += (Math.random() - 0.5) * 0.9;         // zigzag wobble along the crack
      const nx = x + Math.cos(ang) * step, ny = y + Math.sin(ang) * step;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(nx, ny);
      const wd = width * (1 - s / steps) + 0.4;   // taper from thick at the origin to a hairline
      ctx.strokeStyle = 'rgba(15,12,9,0.9)'; ctx.lineWidth = wd; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.lineWidth = Math.max(0.5, wd * 0.5); ctx.stroke();
      // occasional fork partway out (one level deep — keeps it cheap)
      if (width > 1 && s > 0 && Math.random() < 0.28)
        drawRay(nx, ny, ang + (Math.random() - 0.5) * 1.7, step * (1 + Math.random()), wd * 0.7);
      x = nx; y = ny;
    }
  };
  for (let i = 0; i < rays; i++) {
    const ang = (i / rays) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    drawRay(ox, oy, ang, reach * (0.5 + Math.random() * 0.7), 1.8 + Math.random() * 0.8);
  }
}

export class Destructible {
  // mesh: the intact THREE.Object3D (already positioned in its parent).
  // opts.hp        — hit points
  // opts.type      — 'wall' | 'building' | 'gun' | 'bridge' | 'plant' ...
  // opts.makeRubble() -> Object3D to drop in place when destroyed (optional)
  // opts.blocks    — does it block movement/projectiles while alive (default true)
  // opts.onDestroyed(d) — callback
  constructor(mesh, opts = {}) {
    this.id = ++_id;
    this.mesh = mesh;
    this.type = opts.type || 'structure';
    this.maxHp = opts.hp ?? 100;
    this.hp = this.maxHp;
    this.makeRubble = opts.makeRubble || null;
    this.blocks = opts.blocks !== false;
    this.onDestroyed = opts.onDestroyed || null;
    this.onDamage = opts.onDamage || null;   // called after each hit (for staged crumble)
    this.dead = false;
    this.rubble = null;

    // Damage feedback state. Materials are cloned per-object on first hit so scarring
    // THIS prop never bleeds onto others sharing the same material/texture.
    this._flash = 0;
    this._unique = null;
    this._stage = 0;       // highest crack stage drawn so far

    this._worldCenter = new THREE.Vector3();
    this._radius = 1;
    this.refresh();
  }

  // Recompute world-space bounds (call after the mesh is added to the scene
  // graph and positioned, or after anything that moves it).
  refresh() {
    const box = new THREE.Box3().setFromObject(this.mesh);
    box.getCenter(this._worldCenter);
    const sph = new THREE.Sphere();
    box.getBoundingSphere(sph);
    this._radius = sph.radius;
  }

  get worldCenter() { return this._worldCenter; }
  get radius() { return this._radius; }

  damage(amount, point) {
    if (this.dead || amount <= 0) return;
    this.hp -= amount;
    this._flash = 1;        // white-hot flash on hit
    this._applyWear();      // deepen scorch + cracks for the new HP level
    if (this.onDamage) this.onDamage(this);
    if (this.hp <= 0) this._destroy();
  }

  // Clone this object's materials (and any texture maps) so progressive damage marks
  // only THIS prop, not everything sharing the original material/texture.
  _makeUnique() {
    this._unique = [];
    this.mesh.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      const cloned = arr.map(m => {
        const c = m.clone();
        const u = { mat: c, base: c.color ? c.color.clone() : null };
        if (c.map && c.map.image) {
          const img = c.map.image, w = img.width || 128, h = img.height || 128;
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
          const tex = new THREE.CanvasTexture(cv);
          tex.colorSpace = c.map.colorSpace; tex.wrapS = c.map.wrapS; tex.wrapT = c.map.wrapT;
          tex.repeat.copy(c.map.repeat); tex.anisotropy = c.map.anisotropy;
          c.map = tex; u.ctx = ctx; u.tex = tex; u.w = w; u.h = h;
        }
        this._unique.push(u);
        return c;
      });
      o.material = Array.isArray(o.material) ? cloned : cloned[0];
    });
  }

  // Darken toward scorch + scratch in new cracks as HP falls.
  _applyWear() {
    const sev = this.maxHp ? 1 - Math.max(0, this.hp) / this.maxHp : 0;
    if (sev <= 0) return;
    if (!this._unique) this._makeUnique();
    for (const u of this._unique) if (u.base) u.mat.color.copy(u.base).lerp(SCORCH, sev * 0.65);
    const stage = Math.min(CRACK_STAGES, Math.ceil(sev * CRACK_STAGES));
    while (this._stage < stage) {
      this._stage++;
      for (const u of this._unique) if (u.ctx) { drawCracks(u.ctx, u.w, u.h, this._stage / CRACK_STAGES); u.tex.needsUpdate = true; }
    }
  }

  _destroy() {
    this.dead = true;
    const parent = this.mesh.parent;
    if (this.makeRubble && parent) {
      const r = this.makeRubble();
      r.position.copy(this.mesh.position);
      r.quaternion.copy(this.mesh.quaternion);
      r.scale.copy(this.mesh.scale);
      parent.add(r);
      this.rubble = r;
    }
    if (parent) parent.remove(this.mesh);
    if (this.onDestroyed) this.onDestroyed(this);
  }

  // Per-frame: the white hit-flash decays to nothing. Sustained battle damage is read
  // from the DARKENED surface (the scorch lerp in _applyWear) + the crack fractures —
  // no coloured ember glow (a damaged prop should just look charred, not lit red). Only
  // touches materials while the flash is live (by then they've been cloned).
  update(dt) {
    if (this.dead || this._flash <= 0) return;
    this._flash = Math.max(0, this._flash - dt * 3.2);
    const k = this._flash;
    this.mesh.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of arr) if (m.emissive) m.emissive.setRGB(k, k, k);   // neutral white flash → dark
    });
  }
}

export class DestructibleManager {
  constructor() {
    this.items = [];
    this._byMesh = new Map();   // child-mesh uuid -> Destructible (for raycasts)
    this._meshes = [];          // flat list of raycastable meshes
  }

  add(d) {
    this.items.push(d);
    d.mesh.traverse(o => {
      if (o.isMesh) {
        this._byMesh.set(o.uuid, d);
        this._meshes.push(o);
      }
    });
    return d;
  }

  // Recompute all bounds (after bases/props are placed in the scene).
  refreshAll() { for (const d of this.items) d.refresh(); }

  // Radial/splash damage at a world point.
  damageAt(point, radius, amount) {
    for (const d of this.items) {
      if (d.dead) continue;
      const dist = d.worldCenter.distanceTo(point);
      const reach = radius + d.radius;
      if (dist <= reach) {
        const falloff = 1 - Math.min(1, dist / reach);
        d.damage(amount * falloff, point);
      }
    }
  }

  // First live, blocking destructible near `point` (horizontal distance, since
  // walls/buildings are tall and projectiles fly low), else null. Impact tests.
  queryHit(point, pad = 0) {
    for (const d of this.items) {
      if (d.dead || !d.blocks) continue;
      const dx = point.x - d._worldCenter.x, dz = point.z - d._worldCenter.z;
      const reach = d._radius + pad;
      if (dx * dx + dz * dz <= reach * reach) return d;
    }
    return null;
  }

  // Resolve a raycast to the Destructible that was hit (or null).
  pick(raycaster) {
    const hits = raycaster.intersectObjects(this._meshes, false);
    for (const h of hits) {
      const d = this._byMesh.get(h.object.uuid);
      if (d && !d.dead) return { d, point: h.point };
    }
    return null;
  }

  update(dt) { for (const d of this.items) d.update(dt); }
}
