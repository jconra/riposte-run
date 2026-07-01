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
  accentPlateTexture, hazardTexture, noiseTexture, grimeTexture, woodTexture, scratchedTexture,
  toNormalTexture,
} from './Textures.js?v=6';
import { getCamoTextures, TEAM_COLORS } from './CamoTexture.js';

const DESIGN_CELL = 5;   // the designer builds on a CELL=5 grid; configs are in those units

// Material defaults — MUST match the designer's MAT_DEF / new-part material so an export
// that OMITS a default field reconstructs to the same value.
const MAT_DEF = { color: '#b0b6bb', roughness: 0.8, metalness: 0.1, flatShading: true, opacity: 1, normalScale: 1 };

const TEX_FN = {
  concrete: concreteTexture, metal: ribbedMetalTexture, fabric: fabricTexture, crate: crateTexture,
  roof: roofTexture, accent: accentPlateTexture, hazard: hazardTexture, noise: noiseTexture,
  grime: grimeTexture, wood: woodTexture, scratched: scratchedTexture,
};
// One texture per kind+tiling, shared across every asset (a handful of small canvases).
const _texCache = new Map();
// Bake a multiple-of-90° rotation into a texture's canvas (keeps a derived normal map's
// vectors correct, unlike a plain tex.rotation UV spin).
function rotTex(srcTex, deg) {
  deg = ((deg % 360) + 360) % 360;
  const src = srcTex.image, swap = deg === 90 || deg === 270;
  const cv = document.createElement('canvas');
  cv.width = swap ? src.height : src.width; cv.height = swap ? src.width : src.height;
  const ctx = cv.getContext('2d');
  ctx.translate(cv.width / 2, cv.height / 2); ctx.rotate(deg * Math.PI / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = srcTex.colorSpace; t.anisotropy = 4;
  if (srcTex.userData && srcTex.userData.kind) t.userData.kind = srcTex.userData.kind;
  return t;
}
function tex(kind, tile, rot = 0) {
  const fn = TEX_FN[kind]; if (!fn) return null;
  const key = kind + '|' + tile[0] + '|' + tile[1] + '|' + rot;
  let t = _texCache.get(key);
  if (!t) { t = rot ? rotTex(fn(), rot) : fn(); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(tile[0], tile[1]); _texCache.set(key, t); }
  return t;
}
// A NORMAL map derived from a kind's procedural texture, cached per kind+tiling+rotation.
const _normCache = new Map();
function ntex(kind, tile, rot = 0) {
  if (!TEX_FN[kind]) return null;
  const key = kind + '|n|' + tile[0] + '|' + tile[1] + '|' + rot;
  let t = _normCache.get(key);
  if (!t) { t = toNormalTexture(tex(kind, [1, 1], rot), 1); t.repeat.set(tile[0], tile[1]); _normCache.set(key, t); }
  return t;
}

// Camo is a special kind: getCamoTextures builds a whole team-coloured SET at once
// (colour + normal + roughness), keyed by a TEAM_COLORS index, so we can't route it
// through tex()/ntex(). Resolve the build accent to the nearest team colour so a
// camo-skinned asset reads in its side's colour, then hand back the requested slot.
const _camoIdx = new Map();
function camoIndex(accent) {
  const c = new THREE.Color(accent ?? 0xffffff), key = c.getHexString();
  let idx = _camoIdx.get(key);
  if (idx === undefined) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < TEAM_COLORS.length; i++) {
      const t = new THREE.Color(TEAM_COLORS[i].hex);
      const d = (c.r - t.r) ** 2 + (c.g - t.g) ** 2 + (c.b - t.b) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    idx = best; _camoIdx.set(key, idx);
  }
  return idx;
}
// slot: 'map' | 'normalMap' | 'roughnessMap'. Textures from the cached set are shared;
// clone only when a non-unit tiling is needed so we don't disturb other users.
function camoTex(slot, accent, tile) {
  const t = getCamoTextures(camoIndex(accent))[slot];
  if (!t) return null;
  if (tile && (tile[0] !== 1 || tile[1] !== 1)) {
    const c = t.clone(); c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(tile[0], tile[1]); c.needsUpdate = true; return c;
  }
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
  const tile = u.tile || [1, 1], rot = u.rot || 0;
  if (u.mapKind === 'camo') { mat.map = camoTex('map', accent, tile); mat.color.set('#ffffff'); }
  else if (u.mapKind) mat.map = tex(u.mapKind, tile, rot);
  if (u.normalKind === 'camo') { const nm = camoTex('normalMap', accent, tile); if (nm) { mat.normalMap = nm; const ns = u.normalScale ?? MAT_DEF.normalScale; mat.normalScale.set(ns, ns); } }
  else if (u.normalKind) { const nm = ntex(u.normalKind, tile, rot); if (nm) { mat.normalMap = nm; const ns = u.normalScale ?? MAT_DEF.normalScale; mat.normalScale.set(ns, ns); } }
  if (mat.isMeshStandardMaterial) {
    if (u.specKind === 'camo') mat.roughnessMap = camoTex('roughnessMap', accent, tile);
    else if (u.specKind) mat.roughnessMap = tex(u.specKind, tile, rot);
  }
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
