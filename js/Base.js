// Base.js — a team base: stone compound with destructible perimeter walls,
// a central command building, and two defensive gun turrets. Every piece is
// registered with the shared DestructibleManager so it can be shot to rubble.

import * as THREE from 'three';
import { Destructible } from './Destructible.js?v=1';

// Materials shared across all bases (cheap; built once).
const STONE = new THREE.MeshStandardMaterial({ color: '#9a948a', roughness: 0.92, metalness: 0.0 });
const STONE_DARK = new THREE.MeshStandardMaterial({ color: '#6f6a61', roughness: 0.95 });
const METAL = new THREE.MeshStandardMaterial({ color: '#3b3f44', roughness: 0.5, metalness: 0.6 });
const RUBBLE = new THREE.MeshStandardMaterial({ color: '#5b554c', roughness: 1.0 });

// Team accent colors (kept simple here; reconcile with vehicle camo palette later).
const TEAM = {
  red:  new THREE.Color('#c0392b'),
  blue: new THREE.Color('#2e6fc0'),
};

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

// A low scattered debris pile, used as the rubble state for any base piece.
function makeRubble(w, d) {
  return () => {
    const g = new THREE.Group();
    const n = 5 + Math.floor(Math.random() * 5);
    for (let i = 0; i < n; i++) {
      const s = 0.4 + Math.random() * 0.7;
      const chunk = box(s, s * 0.6, s, RUBBLE);
      chunk.position.set(
        (Math.random() - 0.5) * w,
        s * 0.3,
        (Math.random() - 0.5) * d,
      );
      chunk.rotation.y = Math.random() * Math.PI;
      g.add(chunk);
    }
    return g;
  };
}

export class Base {
  // pos: THREE.Vector3 (ground point), team: 'red'|'blue', manager: DestructibleManager
  constructor(pos, team, manager) {
    this.group = new THREE.Group();
    this.group.position.copy(pos);
    this.team = team;
    this.accent = TEAM[team] || TEAM.blue;
    this.guns = [];

    this.SIZE = 24;        // compound footprint (world units)
    this.WALL_H = 3.2;
    this.WALL_T = 1.2;

    this._build(manager);
  }

  _teamMat() {
    return new THREE.MeshStandardMaterial({ color: this.accent, roughness: 0.6, metalness: 0.2 });
  }

  _build(manager) {
    const S = this.SIZE, H = this.WALL_H, T = this.WALL_T;
    const half = S / 2;

    // Concrete pad (not destructible — it's the ground footprint).
    const pad = box(S + 2, 0.4, S + 2, STONE_DARK);
    pad.position.y = 0.2;
    pad.castShadow = false;
    this.group.add(pad);

    // Perimeter walls. Each side is split into segments so it crumbles piecewise.
    // Front side (+Z, facing the battlefield) has a central gate gap.
    const SEG = S / 4;                 // segment length
    const segH = H, segY = 0.4 + H / 2;
    const addWall = (x, z, w, d) => {
      const m = box(w, segH, d, STONE);
      m.position.set(x, segY, z);
      this.group.add(m);
      manager.add(new Destructible(m, { type: 'wall', hp: 140, makeRubble: makeRubble(w, d) }));
    };
    for (let i = 0; i < 4; i++) {
      const off = -half + SEG / 2 + i * SEG;
      // back wall (-Z)
      addWall(off, -half, SEG, T);
      // left / right walls (±X)
      addWall(-half, off, T, SEG);
      addWall(half, off, T, SEG);
      // front wall (+Z) — skip the middle two segments for a gate
      if (i === 0 || i === 3) addWall(off, half, SEG, T);
    }
    // Gate posts framing the opening.
    for (const sx of [-SEG / 2, SEG / 2]) {
      const post = box(T * 1.3, H * 1.25, T * 1.3, STONE_DARK);
      post.position.set(sx, 0.4 + H * 1.25 / 2, half);
      this.group.add(post);
      manager.add(new Destructible(post, { type: 'wall', hp: 200, makeRubble: makeRubble(2, 2) }));
    }

    // Central command building — stepped stone block with a team-color band + mast.
    const bld = new THREE.Group();
    const base = box(9, 5, 9, STONE);
    base.position.y = 0.4 + 2.5;
    bld.add(base);
    const band = box(9.2, 1.0, 9.2, this._teamMat());
    band.position.y = 0.4 + 4.0;
    bld.add(band);
    const top = box(5.5, 3, 5.5, STONE);
    top.position.y = 0.4 + 6.5;
    bld.add(top);
    const mast = box(0.3, 4, 0.3, METAL);
    mast.position.y = 0.4 + 9.5;
    bld.add(mast);
    const flag = box(2.4, 1.3, 0.15, this._teamMat());
    flag.position.set(1.2, 0.4 + 10.4, 0);
    bld.add(flag);
    this.group.add(bld);
    manager.add(new Destructible(bld, { type: 'building', hp: 600, makeRubble: makeRubble(9, 9) }));

    // Two defensive gun turrets at the front corners.
    for (const sx of [-half + 3, half - 3]) {
      const gun = this._makeGun();
      gun.group.position.set(sx, 0.4, half - 3);
      this.group.add(gun.group);
      this.guns.push(gun);
      manager.add(new Destructible(gun.group, {
        type: 'gun', hp: 220, makeRubble: makeRubble(3, 3),
        onDestroyed: () => { gun.dead = true; },
      }));
    }
  }

  // A defensive turret: pedestal + rotating turret head with twin barrels.
  _makeGun() {
    const g = new THREE.Group();
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 1.6, 12), STONE_DARK);
    ped.position.y = 0.8; ped.castShadow = true;
    g.add(ped);

    const head = new THREE.Group();
    head.position.y = 1.7;
    const body = box(2.2, 1.2, 2.6, METAL);
    body.position.y = 0.3;
    head.add(body);
    const accentMat = new THREE.MeshStandardMaterial({ color: this.accent, roughness: 0.5, metalness: 0.3 });
    const stripe = box(2.3, 0.35, 2.0, accentMat);
    stripe.position.y = 0.95;
    head.add(stripe);
    for (const bx of [-0.5, 0.5]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 2.4, 8), METAL);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set(bx, 0.35, 1.6);
      head.add(barrel);
    }
    g.add(head);

    return { group: g, head, dead: false, _sweep: Math.random() * Math.PI * 2 };
  }

  // Idle: turrets sweep back-and-forth around forward (sweep, not spin).
  update(dt) {
    for (const gun of this.guns) {
      if (gun.dead) continue;
      gun._sweep += dt * 0.6;
      gun.head.rotation.y = Math.sin(gun._sweep) * 0.8;
    }
  }
}
