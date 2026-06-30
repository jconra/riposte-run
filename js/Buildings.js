// Buildings.js — procedural low-poly interior structures placed inside camps.
// Flag/HQ + barracks + depot for a MAIN base; an elevator for a FORWARD base.
// Each maker returns a THREE.Group with its base at y=0. Team accent passed in.

import * as THREE from 'three';
import { concreteTexture, ribbedMetalTexture, fabricTexture, crateTexture, roofTexture, accentPlateTexture } from './Textures.js?v=2';
import { buildAssetGroup } from './AssetBuilder.js?v=1';
import FLAGHQ_CFG from './flaghq.config.js?v=1';

// Shared neutral plate map tinted per-material by the team accent (matches Walls.js).
const ACCENT_TEX = accentPlateTexture();

// Textured materials (white base so the canvas texture reads at true value).
const STONE = new THREE.MeshStandardMaterial({ color: '#ffffff', map: concreteTexture('#9a948a'), roughness: 0.95 });
const ROOF  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: roofTexture('#6f6a61'), roughness: 0.95 });
const CRATE = new THREE.MeshStandardMaterial({ color: '#ffffff', map: crateTexture('#7a6f52'), roughness: 0.95 });
const METAL = new THREE.MeshStandardMaterial({ color: '#3b3f44', roughness: 0.5, metalness: 0.6, flatShading: true });
const LIFT  = new THREE.MeshStandardMaterial({ color: '#26282b', roughness: 0.8, metalness: 0.3, flatShading: true });
const QHUT  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: ribbedMetalTexture('#b9bdc0'), roughness: 0.7, metalness: 0.3 });
const TENT  = new THREE.MeshStandardMaterial({ color: '#ffffff', map: fabricTexture('#5f7a37'), roughness: 1.0 });

function box(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}
function accentMat(accent) {
  const m = new THREE.MeshStandardMaterial({ color: accent, map: ACCENT_TEX, roughness: 0.6, metalness: 0.2, flatShading: true });
  m.userData.accent = true;   // so Camp.setAccent can recolour building bands too (map rides along)
  return m;
}

// Command HQ — the heart of a main base, and the decoy buildings on designed maps.
// The geometry is Jacob's asset-designer creation (js/flaghq.config.js), assembled by
// the generic AssetBuilder; team-flagged parts take the accent and stay setAccent-able.
// (The capturable flag itself is a separate system — Camp/buildFlags — not this mesh.)
export function makeFlagHQ(cell, accent) {
  return buildAssetGroup(FLAGHQ_CFG, accent, { cell });
}

// Low barracks hut with an accent door stripe.
export function makeBarracks(cell, accent) {
  const g = new THREE.Group();
  const body = box(cell * 1.4, cell * 0.5, cell * 0.8, STONE);
  body.position.y = cell * 0.25; g.add(body);
  const roof = box(cell * 1.45, cell * 0.15, cell * 0.85, ROOF);
  roof.position.y = cell * 0.55; g.add(roof);
  const door = box(cell * 0.22, cell * 0.32, cell * 0.06, accentMat(accent));
  door.position.set(0, cell * 0.18, cell * 0.42); g.add(door);
  return g;
}

// Supply depot: a cluster of crates.
export function makeDepot(cell) {
  const g = new THREE.Group();
  const spots = [[-0.35, -0.2, 0.5], [0.3, -0.3, 0.45], [0.0, 0.35, 0.55], [0.45, 0.3, 0.4]];
  for (const [x, z, s] of spots) {
    const crate = box(cell * s, cell * s, cell * s, CRATE);
    crate.position.set(x * cell, cell * s * 0.5, z * cell);
    crate.rotation.y = Math.random() * 0.4;
    g.add(crate);
  }
  return g;
}

// Admin / office building — taller block with a team-colour window band.
export function makeAdmin(cell, accent) {
  const g = new THREE.Group();
  const base = box(cell * 1.3, cell * 1.2, cell * 1.0, STONE);
  base.position.y = cell * 0.6; g.add(base);
  const band = box(cell * 1.34, cell * 0.26, cell * 1.04, accentMat(accent));
  band.position.y = cell * 0.7; g.add(band);
  const roof = box(cell * 1.36, cell * 0.12, cell * 1.06, ROOF);
  roof.position.y = cell * 1.22; g.add(roof);
  return g;
}

// Clamshell / quonset hut: a FULL cylinder lying on its side, sunk halfway so
// the terrain hides the bottom and a clean dome shows above ground.
export function makeQuonset(cell, accent) {
  const g = new THREE.Group();
  const r = cell * 0.45, L = cell * 1.3;
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L, 16), QHUT);
  shell.rotation.x = Math.PI / 2;   // axis along Z (lying down)
  shell.position.y = 0;             // centre at ground level -> bottom half hidden
  shell.castShadow = true;
  g.add(shell);
  const door = box(cell * 0.3, cell * 0.4, cell * 0.06, accentMat(accent));
  door.position.set(0, cell * 0.18, L / 2 + 0.01); g.add(door);
  return g;
}

// Canvas ridge tent (Return Fire style): a green triangular-prism A-frame.
export function makeTent(cell, accent) {
  const g = new THREE.Group();
  const w = cell * 0.5, h = cell * 0.55, L = cell * 1.1;
  const shape = new THREE.Shape();
  shape.moveTo(-w, 0); shape.lineTo(w, 0); shape.lineTo(0, h); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: L, bevelEnabled: false });
  geo.translate(0, 0, -L / 2);   // centre the ridge along Z
  geo.computeVertexNormals();
  const tent = new THREE.Mesh(geo, TENT);
  tent.castShadow = true;
  g.add(tent);
  const flap = box(cell * 0.18, cell * 0.3, cell * 0.04, accentMat(accent));
  flap.position.set(0, cell * 0.15, L / 2 + 0.01); g.add(flap);
  return g;
}

// Surface elevator: a framed platform that vehicles rise onto (the underground
// garage rise animation hooks in later). Recessed dark lift pad + corner posts.
// Flat elevator pad (posts intentionally dropped): a stone apron with a recessed dark
// lift pad and accent edge stripes. The rise animation hooks in with the garage.
export function makeElevator(cell, accent) {
  const g = new THREE.Group();
  const am = accentMat(accent);
  const apron = box(cell * 1.35, cell * 0.18, cell * 1.35, STONE);
  apron.position.y = cell * 0.09; g.add(apron);
  const pad = box(cell * 0.95, cell * 0.12, cell * 0.95, LIFT);
  pad.position.y = cell * 0.2; g.add(pad);
  for (const sx of [-1, 1]) {
    const stripe = box(cell * 0.1, cell * 0.13, cell * 0.95, am);
    stripe.position.set(sx * cell * 0.48, cell * 0.2, 0); g.add(stripe);
  }
  return g;
}
