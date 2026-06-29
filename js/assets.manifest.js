// assets.manifest.js — the shared asset INDEX for RMRF.
//
// This is the single source of truth that both the GAME and the standalone
// asset/map designers read. It does NOT store geometry — each asset is still a
// procedural maker function (in Buildings.js / Resupply.js etc.). The manifest
// is an index over those makers plus the metadata everything downstream needs:
//   - footprint : grid cells the asset occupies (for snap, overlap checks, and
//                 feeding the foliage `avoid` test so trees skip built cells).
//                 Verified against the asset-designer's measured bounding box.
//   - destructible : { type, hp } the game wraps each placed asset in
//   - accent : does the maker take a team-colour accent argument?
//   - category : 'structure' (free-placeable building)
//              | 'supply'    (neutral resupply POI — fuel/ammo/shield)
//              | 'special'   (functional, placed by base logic — shown in the
//                             designer but handled specially)
//   - desc : one-line player-facing blurb (drives the in-game help page +
//            the designer/map palette tooltips)
//
// Dependency direction is ONE WAY: the designers import this; the shipped game
// imports this; the manifest never imports anything from the designer tools.

import {
  makeFlagHQ, makeBarracks, makeDepot, makeAdmin,
  makeQuonset, makeTent, makeElevator,
} from './Buildings.js?v=3';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator } from './Resupply.js';   // no ?v: match main.js so the module dedupes
import { makeWall, makeTower, makeGate } from './Walls.js?v=60';   // perimeter kit (visual makers; Wall/Camp classes do the combat)

export const ASSETS = [
  // ── Structures ─────────────────────────────────────────────────────────────
  {
    id: 'flagHQ', name: 'Flag HQ', make: makeFlagHQ,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 600 },
    category: 'special',   // the capturable flag hides inside until it falls
    desc: 'Command HQ flying the team flag. Destroy it to expose the capturable flag inside.',
  },
  {
    id: 'admin', name: 'Admin Block', make: makeAdmin,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 160 },
    category: 'structure',
    desc: 'A tall office block inside the compound.',
  },
  {
    id: 'quonset', name: 'Quonset Hut', make: makeQuonset,
    footprint: { w: 1, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 140 },
    category: 'structure',
    desc: 'A curved-roof storage shed.',
  },
  {
    id: 'barracks', name: 'Barracks', make: makeBarracks,
    footprint: { w: 2, d: 1 }, accent: true,
    destructible: { type: 'building', hp: 120 },
    category: 'structure',
    desc: 'Troop housing with a team-colour door.',
  },
  {
    id: 'depot', name: 'Supply Depot', make: makeDepot,
    footprint: { w: 2, d: 2 }, accent: false,   // makeDepot(cell) takes no accent; 2x2 measured in asset-designer
    destructible: { type: 'building', hp: 80 },
    category: 'structure',
    desc: 'A cluster of stacked crates.',
  },
  {
    id: 'tent', name: 'Ridge Tent', make: makeTent,
    footprint: { w: 1, d: 2 }, accent: true,
    destructible: { type: 'building', hp: 50 },
    category: 'structure',
    desc: 'A canvas A-frame shelter.',
  },
  {
    id: 'elevator', name: 'Surface Elevator', make: makeElevator,
    footprint: { w: 2, d: 2 }, accent: true,
    destructible: null,    // functional rig, not shot to rubble
    category: 'special',
    desc: 'Vehicles rise onto the island here from the garage below.',
  },

  // ── Perimeter kit (the Camp class auto-rings a base with these) ──────────────
  {
    id: 'wall', name: 'Wall', make: makeWall,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'wall', hp: 200 },
    category: 'structure',
    desc: 'A stone perimeter wall segment; the top course wears the team colour.',
  },
  {
    id: 'tower', name: 'Corner Tower', make: makeTower,
    footprint: { w: 1, d: 1 }, accent: true,
    destructible: { type: 'wall', hp: 340 },
    category: 'structure',
    desc: 'A corner bastion that mounts an auto-turret (guns live only on corners).',
  },
  {
    id: 'gate', name: 'Gate', make: makeGate,
    footprint: { w: 3, d: 1 }, accent: true,   // 3-wide: a 1-cell road threads its centre (matches the in-game wall gate)
    destructible: { type: 'wall', hp: 300 },
    category: 'structure',
    desc: 'A drive-through gateway: two posts under a team-colour lintel.',
  },

  // ── Supply POIs (neutral; either team can use them, or blow one to deny it) ──
  {
    id: 'fuel', name: 'Fuel Tank', make: makeFuelTank,
    footprint: { w: 2, d: 1 }, accent: false,   // 2x1 measured (tank lies lengthwise)
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to refill fuel.',
  },
  {
    id: 'ammo', name: 'Ammo Depot', make: makeAmmoDepot,
    footprint: { w: 1, d: 1 }, accent: false,
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to rearm.',
  },
  {
    id: 'shield', name: 'Shield Generator', make: makeShieldGenerator,
    footprint: { w: 2, d: 2 }, accent: false,   // 2x2 measured (emitter ~5.5u spills past one cell)
    destructible: { type: 'building', hp: 60 },
    category: 'supply',
    desc: 'Drive near it to pick up a shield that absorbs damage before your hull.',
  },
];

// Convenience lookups (both designers and the game key off these).
export const ASSETS_BY_ID = Object.fromEntries(ASSETS.map(a => [a.id, a]));
export const SUPPLY_ASSETS = ASSETS.filter(a => a.category === 'supply');
