// Foliage.js — scatters naturePack props (trees, bushes, plants, stones) across
// the islands using InstancedMesh, so thousands of props cost only a handful of
// draw calls. Load the GLB once, then scatter() can be re-run on map rebuild.

import * as THREE from 'three';
import { TILE } from './IslandMap.js';
import { makePalm } from './Palm.js?v=2';
import { makeTree, makeDeadTree, makeBush, makePlant, makeRock } from './FoliageModels.js?v=2';

// Procedural prop makers per category, and how many randomized variants to bake.
// Kept simple by design: a couple grasses + a couple bushes, plus beach palms.
const MAKERS = {
  plant: { make: makePlant, variants: 2 },              // "grasses"
  bush:  { make: makeBush,  variants: 2 },
  palm:  { make: makePalm,  variants: 2 },               // beach trees (on sand)
  tree:  { make: makeTree,  variants: 3, scale: 1.7 },   // inland trees (on grass) — native model is small, so size it up
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();

export class Foliage {
  constructor() {
    this.group = new THREE.Group();
    this.props = null;   // category -> [ { parts, baseScale, minY } ]
    // Destructible palms: each = { x,y,z, r, hp, dead, fell, axis, parts:[{inst,i,orig}] }.
    // (Only palms/trees are shootable; grass + bushes stay pure cosmetic instancing.)
    this.trees = [];
  }

  // Build all procedural props (synchronous). Several randomized variants per
  // category so the scatter looks varied.
  build() {
    this.props = {};
    for (const [cat, def] of Object.entries(MAKERS)) {
      this.props[cat] = [];
      for (let v = 0; v < def.variants; v++) {
        const prop = this._buildProp(def.make(), 0);  // 0 = native size
        if (prop) this.props[cat].push(prop);
      }
    }
    return this;
  }

  // Turn any Object3D into a prop: leaf meshes with node-relative matrices, plus
  // a scale that normalizes the prop to targetH (0 = keep native size) and the
  // node-local min-Y used to sit the base on the ground.
  _buildProp(node, targetH) {
    node.updateWorldMatrix(true, true);
    const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
    const parts = [];
    const localBox = new THREE.Box3();
    node.traverse(o => {
      if (!o.isMesh) return;
      const mat = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      parts.push({ geometry: o.geometry, material: o.material, matrix: mat });
      o.geometry.computeBoundingBox();
      localBox.union(o.geometry.boundingBox.clone().applyMatrix4(mat));
    });
    if (!parts.length) return null;
    const h = (localBox.max.y - localBox.min.y) || 1;
    return { parts, baseScale: targetH > 0 ? targetH / h : 1, minY: localBox.min.y };
  }

  // Scatter across the map. bases = [{x,z}], opts.density scales counts.
  scatter(map, bases = [], opts = {}) {
    if (!this.props) return;
    const density = opts.density ?? 1;
    this.group.clear();   // drop old InstancedMeshes (shared geometry is kept)
    this.trees = [];      // rebuilt below for the new scatter

    const halfW = map.worldW / 2, halfH = map.worldH / 2;
    const baseR2 = 32 * 32;   // keep foliage clear of base footprints (+ wall margin)

    // Bucket placements by prop so we know each InstancedMesh count up front.
    // key = `${cat}:${index}` -> array of {x,y,z,yaw,scale}
    const buckets = new Map();
    const attempts = Math.floor(map.params.cols * map.params.rows * 0.10 * density);

    for (let i = 0; i < attempts; i++) {
      const x = (Math.random() - 0.5) * map.worldW;
      const z = (Math.random() - 0.5) * map.worldH;
      const t = map.tileAt(x, z);
      if (t !== TILE.GRASS && t !== TILE.SAND) continue;

      let skip = false;
      for (const b of bases) {
        const dx = x - b.x, dz = z - b.z;
        if (dx * dx + dz * dz < baseR2) { skip = true; break; }
      }
      if (skip) continue;
      if (opts.avoid && opts.avoid(x, z)) continue;   // e.g. keep clear of roads

      // Choose a category by terrain. Trees scatter EVERYWHERE on land — through the
      // grass inland and creeping down onto the sand — alongside grasses/bushes and
      // the beach palms.
      let cat;
      const r = Math.random();
      if (t === TILE.GRASS) {
        if (r > 0.55) continue;             // lush but not crowded
        cat = r < 0.18 ? 'tree'             // inland trees
            : r < 0.38 ? 'plant'            // grasses
            : 'bush';                       // some bushes
      } else {
        if (r > 0.22) continue;             // beaches: sparser
        cat = r < 0.09 ? 'tree' : 'palm';   // mostly palms, a few trees down on the sand
      }
      const list = this.props[cat];
      if (!list || !list.length) continue;
      const idx = (Math.random() * list.length) | 0;

      const key = cat + ':' + idx;
      let arr = buckets.get(key);
      if (!arr) buckets.set(key, arr = []);
      const sMul = MAKERS[cat].scale || 1;   // per-category size boost (trees run small natively)
      arr.push({
        x, z, y: map.heightAt(x, z),
        yaw: Math.random() * Math.PI * 2,
        scale: list[idx].baseScale * sMul * (0.8 + Math.random() * 0.5),
      });
    }

    // Build InstancedMeshes: one per leaf part of each used prop.
    for (const [key, items] of buckets) {
      const [cat, idxStr] = key.split(':');
      const prop = this.props[cat][+idxStr];
      const partMeshes = [];   // the InstancedMeshes for this bucket (one per leaf part)
      for (const part of prop.parts) {
        const inst = new THREE.InstancedMesh(part.geometry, part.material, items.length);
        inst.frustumCulled = true;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          _q.setFromAxisAngle(_up, it.yaw);
          _pos.set(it.x, it.y - prop.minY * it.scale, it.z);
          _scl.setScalar(it.scale);
          _m.compose(_pos, _q, _scl).multiply(part.matrix);
          inst.setMatrixAt(i, _m);
        }
        inst.instanceMatrix.needsUpdate = true;
        this.group.add(inst);
        partMeshes.push(inst);
      }
      // Palms AND trees are shootable/crushable: register each instance, keeping a
      // reference to its slot in every part mesh so a fell can move/hide it. (Grasses
      // and bushes stay pure cosmetic instancing.)
      if (cat === 'palm' || cat === 'tree') {
        const radPer = cat === 'palm' ? 2.0 : 0.7;   // collision radius per unit scale (trees are narrower)
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const parts = partMeshes.map(inst => {
            const orig = new THREE.Matrix4();
            inst.getMatrixAt(i, orig);
            return { inst, i, orig };
          });
          this.trees.push({
            x: it.x, y: it.y, z: it.z, r: radPer * it.scale,
            hp: 30, dead: false, fell: 0, axis: null, parts,
          });
        }
      }
    }
  }

  // Damage palms within `radius` of a world point. amount>=hp fells the tree.
  // Returns true if any tree was hit (so a projectile can register an impact).
  hitTreesAt(point, radius, amount) {
    let hit = false;
    for (const t of this.trees) {
      if (t.dead) continue;
      const dx = t.x - point.x, dz = t.z - point.z;
      const reach = radius + t.r;
      if (dx * dx + dz * dz > reach * reach) continue;
      hit = true;
      t.hp -= amount;
      if (t.hp <= 0 && t.fell === 0) this._fell(t);
    }
    return hit;
  }

  // Is there a live tree overlapping (x,z) within pad? Returns it or null.
  treeAt(x, z, pad = 0) {
    for (const t of this.trees) {
      if (t.dead || t.fell > 0) continue;
      const dx = t.x - x, dz = t.z - z, reach = t.r + pad;
      if (dx * dx + dz * dz <= reach * reach) return t;
    }
    return null;
  }

  // Knock a tree over (heavy vehicle drove through, or it ran out of HP).
  fellTree(t) { if (t && !t.dead && t.fell === 0) this._fell(t); }

  _fell(t) {
    t.fell = 0.0001;   // >0 marks "toppling" (excluded from collision immediately)
    const a = Math.random() * Math.PI * 2;
    t.axis = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  }

  // Advance topple animations: rotate felled palms about their base, then hide.
  update(dt) {
    if (!this.trees.length) return;
    const FALL = 0.7;   // seconds to hit the ground
    for (const t of this.trees) {
      if (t.dead || t.fell === 0) continue;
      t.fell += dt;
      const p = Math.min(1, t.fell / FALL);
      const ease = 1 - (1 - p) * (1 - p);     // ease-out
      const angle = (Math.PI / 2) * ease;     // up to 90° — flat on the ground
      const pivot = new THREE.Matrix4()
        .makeTranslation(t.x, t.y, t.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(t.axis, angle))
        .multiply(new THREE.Matrix4().makeTranslation(-t.x, -t.y, -t.z));
      for (const pr of t.parts) {
        _m.multiplyMatrices(pivot, pr.orig);
        pr.inst.setMatrixAt(pr.i, _m);
        pr.inst.instanceMatrix.needsUpdate = true;
      }
      if (p >= 1) {   // fully down → hide the instance (zero scale)
        _m.makeScale(0, 0, 0);
        for (const pr of t.parts) { pr.inst.setMatrixAt(pr.i, _m); pr.inst.instanceMatrix.needsUpdate = true; }
        t.dead = true;
      }
    }
  }
}
