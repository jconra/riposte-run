// AssetBuilder.js — turn an asset-designer EXPORT (its minimal JSON config) into a live
// THREE.Group, in the GAME (no dependency on the designer — preserves the one-way rule:
// the config is committed as plain data, the game owns the build code).
//
// The config shape mirrors the designer's exportConfig: { parts:[ { kind, pos?, rot?,
// scale?, mat?, fallAt?, dmgStyle?, params?, geo? } ] }. Every field is optional and
// defaults to the SAME load-time defaults the designer uses, so a minimal (defaults-
// stripped) export round-trips identically. Authored at CELL=5 world units.

import * as THREE from 'three';
import {
  concreteTexture, ribbedMetalTexture, fabricTexture, crateTexture, roofTexture,
  accentPlateTexture, hazardTexture, noiseTexture, grimeTexture, rustTexture, scratchedTexture,
} from './Textures.js?v=2';

const DESIGN_CELL = 5;   // the designer builds on a CELL=5 grid; configs are in those units

// Material defaults — MUST match the designer's MAT_DEF / new-part material so an export
// that OMITS a default field reconstructs to the same value.
const MAT_DEF = { color: '#b0b6bb', roughness: 0.8, metalness: 0.1, flatShading: true, opacity: 1, bumpScale: 0.4 };

const TEX_FN = {
  concrete: concreteTexture, metal: ribbedMetalTexture, fabric: fabricTexture, crate: crateTexture,
  roof: roofTexture, accent: accentPlateTexture, hazard: hazardTexture, noise: noiseTexture,
  grime: grimeTexture, rust: rustTexture, scratched: scratchedTexture,
};
// One texture per kind+tiling, shared across every asset (a handful of small canvases).
const _texCache = new Map();
function tex(kind, tile) {
  const fn = TEX_FN[kind]; if (!fn) return null;
  const key = kind + '|' + tile[0] + '|' + tile[1];
  let t = _texCache.get(key);
  if (!t) { t = fn(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(tile[0], tile[1]); _texCache.set(key, t); }
  return t;
}

function buildGeo(part) {
  if (part.geo) return new THREE.BufferGeometryLoader().parse(part.geo);   // frozen/custom mesh
  const p = part.params || {};
  switch (part.kind) {
    case 'box': return new THREE.BoxGeometry(p.w ?? 2, p.h ?? 2, p.d ?? 2);
    case 'sphere': return new THREE.IcosahedronGeometry(p.r ?? 1.4, p.detail ?? 1);
    case 'cylinder': return new THREE.CylinderGeometry(p.rt ?? 1, p.rb ?? 1, p.h ?? 3, p.seg ?? 14);
    case 'cone': return new THREE.ConeGeometry(p.r ?? 1.2, p.h ?? 3, p.seg ?? 14);
    case 'plane': return new THREE.PlaneGeometry(p.w ?? 3, p.h ?? 3);
    default: return new THREE.BoxGeometry(2, 2, 2);
  }
}

function buildMat(u = {}, accent) {
  const team = !!u.team;                                  // follows the team colour
  const color = team ? accent : (u.color || MAT_DEF.color);
  let mat;
  if (u.kind === 'basic') {
    mat = new THREE.MeshBasicMaterial({ color, transparent: !!u.transparent, opacity: u.opacity ?? MAT_DEF.opacity, side: THREE.DoubleSide });
  } else {
    mat = new THREE.MeshStandardMaterial({
      color, roughness: u.roughness ?? MAT_DEF.roughness, metalness: u.metalness ?? MAT_DEF.metalness,
      flatShading: u.flatShading ?? MAT_DEF.flatShading, transparent: !!u.transparent, opacity: u.opacity ?? MAT_DEF.opacity,
      side: THREE.DoubleSide,
    });
    if (u.emissive && u.emissive !== '#000000') { mat.emissive = new THREE.Color(u.emissive); mat.emissiveIntensity = u.emissiveIntensity ?? 1; }
  }
  const tile = u.tile || [1, 1];
  if (u.mapKind) mat.map = tex(u.mapKind, tile);
  if (u.bumpKind) { mat.bumpMap = tex(u.bumpKind, tile); mat.bumpScale = u.bumpScale ?? MAT_DEF.bumpScale; }
  if (u.specKind && mat.isMeshStandardMaterial) mat.roughnessMap = tex(u.specKind, tile);
  if (team) mat.userData.accent = true;                  // lets Camp.setAccent recolour it (map rides along)
  mat.needsUpdate = true;
  return mat;
}

// Build the asset's Group (base at y=0). `accent` = team colour for team-flagged parts;
// `cell` rescales from the design grid (configs authored at CELL=5).
export function buildAssetGroup(cfg, accent, { cell = DESIGN_CELL } = {}) {
  const g = new THREE.Group();
  for (const part of (cfg.parts || [])) {
    const mesh = new THREE.Mesh(buildGeo(part), buildMat(part.mat, accent));
    const pos = part.pos, rot = part.rot, scale = part.scale;
    if (pos) mesh.position.set(pos[0] ?? 0, pos[1] ?? 0, pos[2] ?? 0);
    if (rot) mesh.rotation.set(rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0);
    if (scale) mesh.scale.set(scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1);
    mesh.castShadow = true; mesh.receiveShadow = true;
    // staged-destruction data read by Destructible (which piece sheds at which HP, and how)
    mesh.userData.fallAt = part.fallAt ?? 0;
    mesh.userData.dmgStyle = part.dmgStyle || 'tumble';
    g.add(mesh);
  }
  if (cell !== DESIGN_CELL) g.scale.setScalar(cell / DESIGN_CELL);
  return g;
}
