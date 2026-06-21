// FoliageModels.js — procedural low-poly foliage (trees, bushes, plants, rocks,
// dead trees) in the same flat-shaded style as the palm. Each maker returns a
// THREE.Group with its base at y=0. Variants come from internal randomness, so
// calling a maker several times yields a varied set. Foliage.js instances them.

import * as THREE from 'three';

const BARK   = new THREE.MeshStandardMaterial({ color: '#8a6a42', roughness: 1.0, flatShading: true });
const DRYBARK= new THREE.MeshStandardMaterial({ color: '#9c8460', roughness: 1.0, flatShading: true });
const LEAF   = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true });
const LEAF2  = new THREE.MeshStandardMaterial({ color: '#4c6d29', roughness: 0.95, flatShading: true });
const ROCK   = new THREE.MeshStandardMaterial({ color: '#9a948a', roughness: 1.0, flatShading: true });

const rand = (a, b) => a + Math.random() * (b - a);

// Jitter an icosphere's vertices a little so blobs/rocks aren't perfectly round.
function lumpy(geo, amt) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * (1 + rand(-amt, amt)),
      p.getY(i) * (1 + rand(-amt, amt)),
      p.getZ(i) * (1 + rand(-amt, amt)));
  }
  geo.computeVertexNormals();
  return geo;
}

// Rounded leafy tree: tapered trunk + a clustered blobby canopy.
export function makeTree() {
  const g = new THREE.Group();
  const h = rand(1.3, 1.9);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, h, 6), BARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.55, 0.85);
    const blob = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.18), mat);
    blob.position.set(rand(-0.4, 0.4), h + rand(0.1, 0.8), rand(-0.4, 0.4));
    g.add(blob);
  }
  return g;
}

// Bare, spiky dead tree: thin trunk + a few angled branches.
export function makeDeadTree() {
  const g = new THREE.Group();
  const h = rand(1.8, 2.6);
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, h, 5), DRYBARK);
  trunk.position.y = h / 2;
  g.add(trunk);
  const branches = 3 + (Math.random() * 3 | 0);
  for (let i = 0; i < branches; i++) {
    const bl = rand(0.4, 0.9);
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.06, bl, 4), DRYBARK);
    br.position.y = bl / 2;
    const pivot = new THREE.Group();
    pivot.add(br);
    pivot.position.y = rand(h * 0.5, h * 0.95);
    pivot.rotation.z = rand(0.5, 1.1) * (Math.random() < 0.5 ? 1 : -1);
    pivot.rotation.y = Math.random() * Math.PI * 2;
    g.add(pivot);
  }
  return g;
}

// Low leafy bush: a couple of clustered blobs near the ground.
export function makeBush() {
  const g = new THREE.Group();
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blobs = 2 + (Math.random() * 2 | 0);
  for (let i = 0; i < blobs; i++) {
    const r = rand(0.35, 0.55);
    const blob = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.22), mat);
    blob.position.set(rand(-0.35, 0.35), r * rand(0.7, 1.0), rand(-0.35, 0.35));
    g.add(blob);
  }
  return g;
}

// Small grass/plant tuft: a few splayed blades.
export function makePlant() {
  const g = new THREE.Group();
  const mat = Math.random() < 0.5 ? LEAF : LEAF2;
  const blades = 4 + (Math.random() * 3 | 0);
  for (let i = 0; i < blades; i++) {
    const bl = rand(0.35, 0.6);
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.0, 0.05, bl, 4), mat);
    blade.position.y = bl / 2;
    const pivot = new THREE.Group();
    pivot.add(blade);
    pivot.rotation.z = rand(-0.4, 0.4);
    pivot.rotation.y = Math.random() * Math.PI * 2;
    pivot.position.set(rand(-0.12, 0.12), 0, rand(-0.12, 0.12));
    g.add(pivot);
  }
  return g;
}

// Rock: a flattened lumpy icosphere.
export function makeRock() {
  const g = new THREE.Group();
  const r = rand(0.35, 0.6);
  const rock = new THREE.Mesh(lumpy(new THREE.IcosahedronGeometry(r, 0), 0.28), ROCK);
  rock.scale.y = rand(0.5, 0.8);
  rock.position.y = r * 0.3;
  rock.rotation.y = Math.random() * Math.PI * 2;
  g.add(rock);
  return g;
}
