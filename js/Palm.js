// Palm.js — procedural low-poly palm tree (naturePack has no palms, and palms
// are the signature of the Return Fire beach look). Built with its base at y=0,
// flat-shaded to match the imported props. Returns a THREE.Group (trunk + crown)
// that Foliage.js instances like any other prop.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TRUNK_MAT = new THREE.MeshStandardMaterial({ color: '#9a7b4f', roughness: 1.0, flatShading: true });
const FROND_MAT = new THREE.MeshStandardMaterial({ color: '#416125', roughness: 0.95, flatShading: true, side: THREE.DoubleSide });
const COCO_MAT  = new THREE.MeshStandardMaterial({ color: '#5a4326', roughness: 1.0, flatShading: true });

// A single drooping frond blade along +X, tapering to a point, sagging in -Y.
function frondGeometry() {
  // Cross-sections along the blade: [x, yDroop, halfWidth]
  const sec = [
    [0.0, 0.00, 0.10],
    [0.7, 0.02, 0.26],
    [1.5, -0.10, 0.20],
    [2.3, -0.40, 0.11],
    [2.9, -0.85, 0.00],
  ];
  const pos = [];
  for (let i = 0; i < sec.length - 1; i++) {
    const [x0, y0, w0] = sec[i];
    const [x1, y1, w1] = sec[i + 1];
    // Two triangles forming the quad between section i and i+1.
    pos.push(x0, y0, -w0,  x1, y1, -w1,  x1, y1, w1);
    pos.push(x0, y0, -w0,  x1, y1, w1,   x0, y0, w0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.scale(0.8, 1, 1);   // fronds at 80% length (deliberate choice)
  g.computeVertexNormals();
  return g;
}

export function makePalm() {
  const group = new THREE.Group();

  // Trunk: tapered, slightly curved (lean) cylinder.
  const H = 4.2;
  const trunk = new THREE.CylinderGeometry(0.12, 0.24, H, 6, 6, true);
  trunk.translate(0, H / 2, 0);
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i);
    const t = y / H;
    tp.setX(i, tp.getX(i) + Math.sin(t * 1.3) * 0.55);   // gentle curve
    tp.setZ(i, tp.getZ(i) + t * 0.12);
  }
  trunk.computeVertexNormals();
  const trunkTopX = Math.sin(1.3) * 0.55, trunkTopZ = 0.12;
  group.add(new THREE.Mesh(trunk, TRUNK_MAT));

  // Crown: a ring of fronds at the trunk top.
  const fronds = [];
  const N = 9;
  for (let i = 0; i < N; i++) {
    const f = frondGeometry();
    const yaw = (i / N) * Math.PI * 2 + Math.random() * 0.2;
    const tilt = -0.35 - Math.random() * 0.25;            // droop outward/down
    const m = new THREE.Matrix4()
      .makeTranslation(trunkTopX, H, trunkTopZ)
      .multiply(new THREE.Matrix4().makeRotationY(yaw))
      .multiply(new THREE.Matrix4().makeRotationZ(tilt));
    f.applyMatrix4(m);
    fronds.push(f);
  }
  group.add(new THREE.Mesh(mergeGeometries(fronds), FROND_MAT));

  // A couple of coconuts under the crown.
  const cocos = [];
  for (let i = 0; i < 3; i++) {
    const c = new THREE.IcosahedronGeometry(0.13, 0);
    const a = Math.random() * Math.PI * 2;
    c.translate(trunkTopX + Math.cos(a) * 0.18, H - 0.2, trunkTopZ + Math.sin(a) * 0.18);
    cocos.push(c);
  }
  group.add(new THREE.Mesh(mergeGeometries(cocos), COCO_MAT));

  return group;
}
