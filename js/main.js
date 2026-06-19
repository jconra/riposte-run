// main.js — Riposte Run bootstrap (fresh build).
// Bright Return Fire look: light sky, warm sun, tone mapping. Procedural islands
// with a live controls panel. Garage + vehicles land in later milestones.

import * as THREE from 'three';
import { IslandMap, DEFAULTS } from './IslandMap.js?v=50';
import { Controls } from './Controls.js';
import { DestructibleManager, Destructible } from './Destructible.js';
import { BuildGrid } from './BuildGrid.js';
import { Camp } from './Walls.js?v=50';
import { RoadNetwork } from './Roads.js';
import { Foliage } from './Foliage.js';
import { Vehicle, VEHICLE_TYPES } from './Vehicles.js';
import { Elevator } from './Elevator.js';
import { Garage } from './Garage.js';
import { TEAM_COLORS, updateCamo, camoParams } from '../../vehicle-designer/js/CamoTexture.js';
import { SoundManager } from '../../vehicle-designer/js/SoundManager.js';
import { Projectiles } from '../../vehicle-designer/js/Projectiles.js';
import { Brain, randomPersonality } from './AI.js?v=50';
import { drawStrategy, COUNTER } from './AIStrategies.js?v=50';
import { astarGrid } from './astar.js';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator, makeShieldBubble, RESUPPLY_TINT } from './Resupply.js';

// --- Renderer ----------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Shadows: enabled globally but only lights/meshes that opt in cast them. Right
// now that's just the garage selection spotlight (the field sun doesn't cast yet).
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// --- Scene + sky -------------------------------------------------------
const scene = new THREE.Scene();
const SKY = new THREE.Color('#bfe4f5');     // bright daytime sky
scene.background = SKY;
scene.fog = new THREE.Fog(SKY, 220, 460);   // soft horizon haze

// Warm key sun + cool sky-ground ambient = sunny beach.
const sun = new THREE.DirectionalLight('#fff3d6', 1.7);
sun.position.set(80, 130, 60);
scene.add(sun);
const hemi = new THREE.HemisphereLight('#dff1ff', '#c2a86a', 0.85);
scene.add(hemi);

// --- Camera + minimal orbit control -----------------------------------
const BASE_FOV = 55;   // landscape vertical fov
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.5, 1200);

// Perspective fov is VERTICAL, so a tall portrait window (a phone) collapses the
// horizontal view and feels zoomed in. In portrait, widen the vertical fov so the
// HORIZONTAL coverage holds at roughly its square-aspect amount; landscape keeps
// BASE_FOV. Clamped so very tall screens don't go fisheye.
function applyCameraFov() {
  const a = window.innerWidth / window.innerHeight;
  if (a >= 1) {
    camera.fov = BASE_FOV;
  } else {
    const baseTan = Math.tan(THREE.MathUtils.degToRad(BASE_FOV) / 2);   // horizontal target (at a=1)
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(baseTan / a));
    camera.fov = Math.min(82, fov);
  }
  camera.aspect = a;
  camera.updateProjectionMatrix();
}
applyCameraFov();
// yaw 0 = looking straight down the Z axis (North), squared to the grid.
const orbit = { target: new THREE.Vector3(0, 0, 0), dist: 150, yaw: 0, pitch: 1.2 };
let zoomMax = 420;
// Single-finger virtual joystick: pan toward the finger's offset from screen centre.
const touchPan = { active: false, x: 0, y: 0, sx: 0, sy: 0, t: 0 };
// Touch driving: hold a finger on the field and the vehicle heads toward that point
// (point-to-steer, set in the canvas touch handlers, consumed by driveInput). A quick
// tap fires instead of steering. null = no finger steering this frame.
let touchSteer = null;            // { x, y } screen point the vehicle should drive toward
const TOUCH_STOP_R = 7;           // world radius around the vehicle that reads as "stop"

function updateCamera() {
  const cp = Math.max(0.15, Math.min(1.45, orbit.pitch));
  orbit.pitch = cp;
  const x = orbit.target.x + orbit.dist * Math.cos(cp) * Math.sin(orbit.yaw);
  const y = orbit.target.y + orbit.dist * Math.sin(cp);
  const z = orbit.target.z + orbit.dist * Math.cos(cp) * Math.cos(orbit.yaw);
  camera.position.set(x, y, z);
  camera.lookAt(orbit.target);
}

(function bindOrbit() {
  // LEFT mouse = fire (hold to keep firing at the crosshair); RIGHT mouse drag =
  // orbit/look. (No SPACE-to-fire; touch fires on tap — see the touch handlers.)
  let dragging = false, lx = 0, ly = 0;
  const el = renderer.domElement;
  const move = (x, y) => {
    if (!dragging) return;
    orbit.yaw -= (x - lx) * 0.005;
    orbit.pitch -= (y - ly) * 0.005;
    lx = x; ly = y;
    updateCamera();
  };
  el.addEventListener('mousedown', e => {
    if (e.button === 2 || e.button === 1) { dragging = true; lx = e.clientX; ly = e.clientY; return; }   // right/middle = look
    if (e.button !== 0) return;
    if (onField && player && !player.dead) {            // LEFT = fire
      if (playerIsValkyrie()) acquireLock(e.clientX, e.clientY);   // lock the box; held missiles home onto it
      fireHeld = true;
    } else if (QS.has('tap')) damageTapAt(e.clientX, e.clientY);   // legacy debug damage tap
  });
  window.addEventListener('mousemove', e => { move(e.clientX, e.clientY); _cursor = { x: e.clientX, y: e.clientY }; });
  window.addEventListener('mouseup', e => { if (e.button === 0) fireHeld = false; else dragging = false; });
  el.addEventListener('contextmenu', e => e.preventDefault());   // right-drag look, no menu popup
  el.addEventListener('wheel', e => {
    orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + e.deltaY * 0.12));
    updateCamera();
  }, { passive: true });
  // Touch model:
  //   DRIVING — the FIRST finger steers (the vehicle heads toward it); release it as a
  //     quick tap and it fires instead. Any EXTRA finger is a tap-to-fire, so you can
  //     shoot without lifting the steering thumb. (No pinch-zoom while driving.)
  //   SPECTATING — one finger pans the camera, two fingers pinch-zoom.
  let pinchD = 0;
  let steerId = null, steerStart = null;   // the steering finger's id + its down pos/time
  const taps = {};                         // extra fingers being watched for a tap (by identifier)
  const humanDriving = () => onField && player && !player.dead;
  const fireAt = (x, y) => { if (playerIsValkyrie()) acquireLock(x, y); else fireAtPoint(x, y); };
  const isTap = s => Math.hypot(s.x - s.sx, s.y - s.sy) < 12 && performance.now() - s.t < 300;

  el.addEventListener('touchstart', e => {
    if (humanDriving()) {
      for (const t of e.changedTouches) {
        const s = { sx: t.clientX, sy: t.clientY, x: t.clientX, y: t.clientY, t: performance.now() };
        if (steerId === null) { steerId = t.identifier; steerStart = s; touchSteer = { x: t.clientX, y: t.clientY }; }
        else taps[t.identifier] = s;
      }
      return;
    }
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchPan.active = true; touchPan.x = touchPan.sx = t.clientX; touchPan.y = touchPan.sy = t.clientY;
      touchPan.t = performance.now();
    } else if (e.touches.length === 2) { touchPan.active = false; pinchD = touchDist(e); }
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (steerId !== null || Object.keys(taps).length) {
      for (const t of e.changedTouches) {
        if (t.identifier === steerId) { touchSteer.x = steerStart.x = t.clientX; touchSteer.y = steerStart.y = t.clientY; }
        else if (taps[t.identifier]) { taps[t.identifier].x = t.clientX; taps[t.identifier].y = t.clientY; }
      }
      return;
    }
    if (e.touches.length === 1 && touchPan.active) {
      touchPan.x = e.touches[0].clientX; touchPan.y = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const d = touchDist(e);
      orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + (pinchD - d) * 0.5));
      pinchD = d; updateCamera();
    }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === steerId) {
        if (isTap(steerStart) && onField && player && !player.dead) fireAt(steerStart.x, steerStart.y);   // a flick of the steer finger = a shot
        steerId = null; steerStart = null; touchSteer = null;
      } else if (taps[t.identifier]) {
        const s = taps[t.identifier]; delete taps[t.identifier];
        if (isTap(s) && onField && player && !player.dead) fireAt(s.x, s.y);
      }
    }
    if (!humanDriving() && touchPan.active && e.touches.length === 0) {
      if (isTap(touchPan) && QS.has('tap')) damageTapAt(touchPan.x, touchPan.y);
      touchPan.active = false;
    }
  });
  function touchDist(e) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.hypot(dx, dy);
  }
})();

// --- WASD pan (stands in for the future vehicle-follow camera) ---------
// For now this slides the camera target across the map. Once vehicles exist,
// WASD will drive the vehicle and the camera will track it the same way.
const keys = {};
window.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });   // firing is on the LEFT mouse / tap, not SPACE
window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

function panUpdate(dt) {
  let fwd = 0, strafe = 0;
  if (keys['w'] || keys['arrowup']) fwd += 1;
  if (keys['s'] || keys['arrowdown']) fwd -= 1;
  if (keys['d'] || keys['arrowright']) strafe += 1;
  if (keys['a'] || keys['arrowleft']) strafe -= 1;
  // Touch joystick: offset from screen centre (after a brief hold, with deadzone).
  if (touchPan.active && performance.now() - touchPan.t > 120) {
    const scale = window.innerHeight * 0.32;
    const dx = (touchPan.x - window.innerWidth / 2) / scale;
    const dy = (touchPan.y - window.innerHeight / 2) / scale;
    if (Math.hypot(dx, dy) > 0.14) { strafe += dx; fwd += -dy; }
  }
  if (!fwd && !strafe) return;
  const sin = Math.sin(orbit.yaw), cos = Math.cos(orbit.yaw);
  // forward (into the scene) = (-sin,-cos); right = (cos,-sin)
  let mx = -sin * fwd + cos * strafe;
  let mz = -cos * fwd - sin * strafe;
  const len = Math.hypot(mx, mz) || 1;
  const speed = orbit.dist * 0.7 * dt;
  orbit.target.x += (mx / len) * speed;
  orbit.target.z += (mz / len) * speed;
  updateCamera();
}

// When no human is playing (AI-vs-AI), drift the camera to follow the action —
// a flag carrier if there is one, otherwise the nearest pair of rivals. Returns
// true if it took the camera (so the free-pan is skipped).
const _spec = new THREE.Vector3();
// Spectator focus: null = auto (track a flag carrier, else the first living unit);
// otherwise a unit the viewer pinned with Tab/[/] (see the keydown handler).
let spectateTarget = null;
function cycleSpectate(dir) {
  const list = combatants.filter(v => !v.dead);
  if (!list.length) { spectateTarget = null; return; }
  let i = list.indexOf(spectateTarget);
  if (i < 0) i = dir > 0 ? -1 : 0;     // land on the first (fwd) / last (back) unit
  spectateTarget = list[(i + dir + list.length) % list.length];
}
function spectateUpdate(dt) {
  if (TEAM_CTRL[PLAYER_TEAM] === 'human') return false;
  ensureSpectateControls();   // on-screen prev/auto/next/log buttons (touch + click)
  if (spectateTarget && spectateTarget.dead) spectateTarget = null;   // pinned unit died → back to auto
  let focus = spectateTarget;
  if (!focus) for (const f of flags) if (f.carried && f.carrier && !f.carrier.dead) { focus = f.carrier; break; }
  if (!focus) for (const cmd of commanders) if (cmd.unit && !cmd.unit.dead) { focus = cmd.unit; break; }
  if (!focus) { if (spectateTagEl) spectateTagEl.style.display = 'none'; return false; }
  _spec.set(focus.holder.position.x, 0, focus.holder.position.z);
  orbit.target.lerp(_spec, 0.04);
  updateCamera();
  updateSpectateTag(focus);
  return true;
}
// Small "now watching" banner along the top — names the focused unit + its team
// colour, and reminds the viewer of the cycle keys.
let spectateTagEl = null;
function updateSpectateTag(focus) {
  if (!spectateTagEl) {
    spectateTagEl = document.createElement('div');
    spectateTagEl.id = 'spectate-tag';
    spectateTagEl.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);' +
      'font-family:"Courier New",monospace;font-size:13px;letter-spacing:2px;text-align:center;' +
      'text-shadow:0 1px 2px rgba(255,255,255,0.65);pointer-events:none;z-index:80;';
    document.body.appendChild(spectateTagEl);
  }
  spectateTagEl.style.display = 'block';
  const col = TEAM_COLORS[focus.colorIndex] ? '#' + TEAM_COLORS[focus.colorIndex].hex.toString(16).padStart(6, '0') : '#2b2118';
  const name = focus.ai && focus.ai.p ? focus.ai.p.name : (focus.team || '');
  const pin = spectateTarget ? '📌' : '▶';
  spectateTagEl.innerHTML = `<span style="color:${col};font-weight:bold">${pin} ${name.toUpperCase()}</span>` +
    `<span style="color:#1d2b33"> · ${focus.type.toUpperCase()}</span>`;
}
// Touch-friendly spectator controls (phone has no keyboard): prev / auto-follow /
// next unit, plus a LOG toggle. Built once on the first spectate frame; the buttons
// take pointer events so a tap doesn't fall through to the orbit camera.
let spectateControlsEl = null;
function ensureSpectateControls() {
  if (spectateControlsEl) return;
  const bar = document.createElement('div');
  bar.id = 'spectate-ctrl';
  bar.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:160;' +
    'display:flex;gap:10px;pointer-events:auto;';
  const mk = (label, fn) => {
    const btn = document.createElement('div');
    btn.textContent = label;
    btn.style.cssText = 'font-family:"Courier New",monospace;font-size:15px;font-weight:bold;letter-spacing:1px;' +
      'color:#eef4f8;background:rgba(8,12,18,0.7);border:1px solid rgba(255,255,255,0.35);border-radius:9px;' +
      'padding:13px 17px;min-width:52px;text-align:center;user-select:none;-webkit-user-select:none;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.3);touch-action:manipulation;cursor:pointer;';
    const press = (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      btn.style.background = 'rgba(60,90,120,0.85)';
      setTimeout(() => { btn.style.background = 'rgba(8,12,18,0.7)'; }, 130);
      fn();
    };
    btn.addEventListener('pointerdown', press);   // covers touch + mouse, fires once
    bar.appendChild(btn);
  };
  mk('◀', () => cycleSpectate(-1));
  mk('AUTO', () => { spectateTarget = null; });
  mk('▶', () => cycleSpectate(1));
  mk('LOG', () => { aiLogOn = !aiLogOn; updateAiLog(); });
  document.body.appendChild(bar);
  spectateControlsEl = bar;
}

// --- Shot mode ---------------------------------------------------------
// `?shot` builds a small map (and skips foliage unless `&fol`) so the headless
// render rig stays fast on the software-GL box. Gameplay defaults are untouched.
const QS = new URLSearchParams(location.search);
const SHOT = QS.has('shot');
const SHOT_SIZE = parseInt(QS.get('size')) || 96;
const SHOT_FOL = QS.has('fol');
const SHOT_SEED = QS.has('seed') ? parseInt(QS.get('seed')) : null;
// Map generation options, honoured in ANY field mode (so ?aivsai&size&seed is
// reproducible, not just ?shot). undefined → the map's own random default.
const GEN_OPTS = (SHOT || QS.has('size') || QS.has('seed')) ? {
  ...((SHOT || QS.has('size')) ? { cols: SHOT_SIZE, rows: SHOT_SIZE } : {}),
  ...(SHOT_SEED != null ? { seed: SHOT_SEED } : {}),
} : undefined;
// Normal play STARTS IN THE GARAGE (pick team colour + vehicle, then deploy). Only
// the headless test/spectate paths drop straight onto the field.
const SPECTATE = QS.has('aivsai') || QS.has('spectate') || QS.has('ai');
const FIELD_DIRECT = SHOT || QS.has('field') || SPECTATE;
const GARAGE = QS.has('garage') || !FIELD_DIRECT;   // render the hangar as the entry view
// Attrition preview: ?losses=firebrat:3,jotun:1 — until match results feed this.
const LOSSES = (() => {
  const raw = QS.get('losses');
  if (!raw) return null;
  const o = {};
  for (const part of raw.split(',')) { const [t, n] = part.split(':'); if (t) o[t.trim()] = parseInt(n) || 0; }
  return o;
})();
// Running attrition of the PLAYER's fleet — each death removes one of that type
// from the garage roster (seeded by the ?losses preview). Fed to garage.applyRoster.
const playerLosses = LOSSES ? { ...LOSSES } : {};

// On-screen drive stick (touch) — sets the SAME `keys` WASD does, so all the drive
// logic downstream is unchanged. Migrated from the Vehicle Designer. Field only;
// revealed on touch devices (window.showJoystick() forces it on for desktop tests).
(function setupJoystick() {
  const joystick = document.getElementById('touch-joystick');
  const knob = document.getElementById('touch-knob');
  // Wire it unconditionally (incl. ?garage flow): it only sets `keys`, which is
  // read while driving, and the widget itself is hidden until setFieldUI(true).
  if (!joystick || !knob) return;
  const DEADZONE = 0.30, MAX_TRAVEL = 42;
  let joyId = null;
  // Visibility is driven by setFieldUI (gated on a real touch — see touchUsed);
  // reveal() stays only as a manual override for desktop testing.
  const reveal = () => joystick.classList.add('visible');
  window.showJoystick = reveal;

  const applyVector = (cx, cy) => {
    const r = joystick.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    if (d > MAX_TRAVEL) { dx *= MAX_TRAVEL / d; dy *= MAX_TRAVEL / d; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / MAX_TRAVEL, ny = dy / MAX_TRAVEL;   // ny screen-down positive
    keys['w'] = ny < -DEADZONE; keys['s'] = ny > DEADZONE;
    keys['a'] = nx < -DEADZONE; keys['d'] = nx > DEADZONE;
  };
  const release = () => {
    joyId = null;
    knob.style.transform = 'translate(0px, 0px)';
    keys['w'] = keys['a'] = keys['s'] = keys['d'] = false;
  };
  joystick.addEventListener('pointerdown', e => {
    if (joyId !== null) return;
    joyId = e.pointerId;
    joystick.setPointerCapture(e.pointerId);
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  joystick.addEventListener('pointermove', e => {
    if (e.pointerId !== joyId) return;
    applyVector(e.clientX, e.clientY);
    e.preventDefault();
  });
  const end = e => { if (e.pointerId === joyId) release(); };
  joystick.addEventListener('pointerup', end);
  joystick.addEventListener('pointercancel', end);
})();

// On-screen fire button (touch) — holds fireHeld, the same flag SPACE sets.
// Revealed by setFieldUI on touch devices; field-only.
(function setupFireButton() {
  const btn = document.getElementById('fire-btn');
  if (!btn) return;
  const press = e => { fireHeld = true; btn.classList.add('pressed'); e.preventDefault(); };
  const lift  = () => { fireHeld = false; btn.classList.remove('pressed'); };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', lift);
  btn.addEventListener('pointercancel', lift);
  btn.addEventListener('pointerleave', lift);
})();

// Reveal the on-screen touch controls only AFTER a real touch — capability flags
// (maxTouchPoints / ontouchstart) are true on touchscreen laptops and many desktop
// browsers, so they'd wrongly show the drive stick + fire button on a mouse rig.
let touchUsed = false;
function onFirstTouch() {
  if (touchUsed) return;
  touchUsed = true;
  if (onField) setFieldUI(true);   // already on the island → show them now
}
window.addEventListener('pointerdown', e => { if (e.pointerType === 'touch') onFirstTouch(); });
window.addEventListener('touchstart', onFirstTouch, { passive: true });   // Safari fallback

// --- Map + camps -------------------------------------------------------
const map = new IslandMap();
const grid = new BuildGrid(map, 5);   // shared build grid (5-unit cells)
const roadNet = new RoadNetwork(map, grid);
let destructibles = new DestructibleManager();
let camps = [];
let elevators = [];   // animated FOB surface lifts (one per forward base)
let resupplies = [];  // neutral fuel/ammo/shield points of interest
let onField = false;  // true while the island is on screen (false = hangar view)
let fieldBuilt = false; // the island is generated once, then reused across deploys
let matchOver = false;  // a flag was captured — freeze the action, show the result
let flagsCaptured = 0;  // enemy flags the player has extracted into the garage (score)
let deploy = null;    // { type, colorIndex } captured when a deploy is confirmed
let fieldFadeT = 0;   // counts up after handoff to fade the black deploy overlay out
let garageFadeT = null; // when set, fades the garage in from black (on return)
let victoryReturn = false; // the current lift descent is a winning flag extraction (run the cinematic)
let victoryHoldT = 0;      // beat held at the bottom of a victory descent before fading out
const VICT_HOLD = 1.9;     // seconds to linger on the celebration at the bottom

// Team accent colours (match Camp's wall accents) + camo palette slot per team
// (indices into TEAM_COLORS: 4 = RED, 5 = BLUE).
const TEAM_ACCENT = { red: '#c0392b', blue: '#2e6fc0' };
const TEAM_CAMO   = { red: 4, blue: 5 };
// Default vehicle each team fields (used for the plain-field player until a real
// garage deploy chooses one).
const FOB_RIDER = { red: 'jotun', blue: 'firebrat' };
const PLAYER_TEAM = 'red';   // the garage / player's side
// Who runs each team: 'human' (player drive/garage) or 'ai' (an AICommander).
// Flexible by design — flip any team to 'ai' for AI-vs-AI, or extend for more
// teams. ?aivsai (or ?spectate) makes everyone AI; ?ai also makes the player AI.
const TEAM_CTRL = { red: 'human', blue: 'ai' };
if (QS.has('aivsai') || QS.has('spectate') || QS.has('ai')) { TEAM_CTRL.red = 'ai'; TEAM_CTRL.blue = 'ai'; }

// Nearest gate (object) of a camp to a world point.
function nearestGate(camp, point) {
  let best = camp.gates[0], bd = Infinity;
  for (const g of camp.gates) { const d = g.pos.distanceToSquared(point); if (d < bd) { bd = d; best = g; } }
  return best;
}

// Build the road network: each main base -> its FOB, and the two FOBs across.
function buildRoads() {
  const byTeam = {};
  for (const c of camps) (byTeam[c.team] ??= {})[c.role] = c;
  const conns = [];
  for (const t of ['red', 'blue']) {
    const m = byTeam[t] && byTeam[t].main, f = byTeam[t] && byTeam[t].fob;
    if (m && f) conns.push({ a: m.gates[0], b: nearestGate(f, m.center), y: m.center.y });
  }
  const rf = byTeam.red && byTeam.red.fob, bf = byTeam.blue && byTeam.blue.fob;
  if (rf && bf) conns.push({ a: nearestGate(rf, bf.center), b: nearestGate(bf, rf.center), y: rf.center.y });
  roadNet.setObstacles(camps);
  roadNet.build(conns);
  if (!roadNet.group.parent) scene.add(roadNet.group);
}

const CAMP_SIZE = 9;   // main base: ODD cells per side (3-cell gate centres on a cell)
const FOB_SIZE = 5;    // forward operating base: smaller, holds the elevator

// Pad descriptor (flat dry foundation) for a camp of `size` cells at a site.
function padFor(site, size) {
  const rInner = (size / 2) * grid.cell + grid.cell * 0.6;
  const rOuter = rInner + grid.cell * 2.5;
  return { x: site.x, z: site.z, rInner, rOuter, height: Math.max(site.y, map.params.beachHeight + 0.8) };
}

function placeCamps() {
  for (const c of camps) scene.remove(c.group);
  for (const e of elevators) { scene.remove(e.group); if (e.rider) scene.remove(e.rider.group); e.dispose(); }
  camps = [];
  elevators = [];
  destructibles = new DestructibleManager();

  const origin = new THREE.Vector3();
  const teams = ['red', 'blue'];
  const items = [];   // { site, size, role, team }
  const pads = [];

  map.findCampSites(2).forEach((mainSite, i) => {
    const mainPad = padFor(mainSite, CAMP_SIZE);
    items.push({ site: mainSite, size: CAMP_SIZE, role: 'main', team: teams[i] });
    pads.push(mainPad);

    // FOB sits forward of the main base (slightly toward centre) and offset well to
    // the SIDE (perpendicular) — opposite teams' perpendiculars point opposite ways,
    // so the two FOBs diverge instead of converging on the map centre. Sidestep is
    // pulled in until it lands on dry ground.
    const toCenter = origin.clone().sub(mainSite).setY(0);
    if (toCenter.lengthSq() < 1e-3) toCenter.set(1, 0, 0);
    toCenter.normalize();
    const perp = new THREE.Vector3(-toCenter.z, 0, toCenter.x);   // +90° about Y (flips per opposite team)
    const fobPadR = (FOB_SIZE / 2) * grid.cell + grid.cell * 0.6 + grid.cell * 2.5;
    const forward = mainPad.rOuter + fobPadR + 8;
    const span = Math.min(map.worldW, map.worldH);
    let fobSite = mainSite.clone().addScaledVector(toCenter, forward);   // fallback: inline
    for (const side of [span * 0.24, span * 0.18, span * 0.12]) {
      const cand = mainSite.clone().addScaledVector(toCenter, forward).addScaledVector(perp, side);
      if (map.isLand(cand.x, cand.z)) { fobSite = cand; break; }
    }
    fobSite.y = map.heightAt(fobSite.x, fobSite.z);
    items.push({ site: fobSite, size: FOB_SIZE, role: 'fob', team: teams[i] });
    pads.push(padFor(fobSite, FOB_SIZE));
  });

  map.flattenPads(pads);

  for (const it of items) {
    const cell = grid.worldToCell(it.site.x, it.site.z);
    const groundY = map.heightAt(it.site.x, it.site.z);   // flattened pad height
    const c = new Camp(grid, cell, it.size, it.team, destructibles, groundY, it.role);
    scene.add(c.group);
    camps.push(c);
  }
  scene.updateMatrixWorld(true);   // place groups in world space BEFORE measuring bounds
  destructibles.refreshAll();      // (else every worldCenter collapses near the origin)
  buildObstacles();

  // Animated surface lift at each FOB. Empty by default and parked flush at the
  // surface (so an idle FOB just reads as a pad); the PLAYER's lift gets a rider +
  // rise via deployToFOB. Centred on the camp's grid-SNAPPED centre, not the raw
  // site — the walls/gates snap to a cell, so the lift must too or it sits off to
  // one side and clips a gate road.
  items.forEach((it, i) => {
    if (it.role !== 'fob') return;
    const camp = camps[i];   // camps were pushed in items order
    const accent = TEAM_ACCENT[it.team] || '#c0392b';
    const elev = new Elevator(map, { x: camp.center.x, z: camp.center.z }, accent);
    elev.team = it.team;     // so deploy can find the player's lift
    elev.phase = 'top';      // idle FOBs sit flush
    elev.lift.position.y = elev.groundY;
    scene.add(elev.group);
    elevators.push(elev);
  });

  buildFlags();        // capturable flag at each main base
  placeResupplies();   // neutral fuel/ammo/shield points of interest
}

// Foliage (procedural low-poly props; scattered on load and on every rebuild).
const foliage = new Foliage();
foliage.build();
function scatterFoliage() {
  if (!foliage.props) return;
  const sites = camps.map(c => ({ x: c.center.x, z: c.center.z }));
  // Keep trees off the roads (and one cell either side) so units aren't blocked on
  // their own lanes — the A* navigator treats roads as the cheap path.
  const c = grid.cell;
  const onRoad = (x, z) => {
    if (!roadNet.cells) return false;
    const ci = Math.round(x / c), cj = Math.round(z / c);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++)
      if (roadNet.cells.has((ci + di) + ',' + (cj + dj))) return true;
    return false;
  };
  foliage.scatter(map, sites, { density: 1, avoid: onRoad });
  if (!foliage.group.parent) scene.add(foliage.group);
}

// --- Vehicles ----------------------------------------------------------
// The FOB elevator deck is a solid drivable surface at the FOB's ground height,
// even though the terrain underneath is a carved pit (or off-map ocean). Returns
// the elevator whose flush deck covers (x,z), else null.
function elevatorPadAt(x, z) {
  for (const e of elevators) {
    if (e.phase !== 'top') continue;   // only a flush deck is a surface
    const reach = e.padHalf + 1.2;
    if (Math.abs(x - e.center.x) <= reach && Math.abs(z - e.center.z) <= reach) return e;
  }
  return null;
}

// Ground height a vehicle should rest at (terrain + a small clearance; or the deck).
function vehicleGroundY(x, z) {
  const e = elevatorPadAt(x, z);
  return (e ? e.groundY : map.heightAt(x, z)) + 0.05;
}
const vehicles = [];          // ambient (non-player) vehicles, if any

// --- Combat: shooting, damage, movement traits, HP / fuel -------------
// Ported from the Vehicle Designer (muzzle flash + recoil + projectiles) and
// extended for the game: projectiles deal damage to walls, buildings, trees and
// vehicles; each vehicle type moves differently and carries HP + fuel.
const projectiles = new Projectiles(scene);
projectiles.missileScale = 3.4;   // Valkyrie missiles read tiny against the big world vehicles
const FIRE_INTERVALS = [0.32, 0.11, 1.05, 1.7];   // by soundIndex: Lurcher, Firebrat, Valkyrie, Jotun
const SHOT_DMG       = [35, 14, 90, 180];          // damage per hit
const SHOT_BLAST     = [1.2, 0.6, 4.5, 5.5];       // splash radius (laser/tracer tiny, missile/rail big)
// How far off the hull's forward a vehicle can aim a shot — the half-angle of the
// firing cone. A reticle only appears (and a shot is valid) inside it. Per the
// design: the Firebrat is a fixed forward gun (tiny 5° cone), the Jotun's heavy
// turret covers 30°, the Lurcher's turret reaches ANY direction (but slews there
// over ~1s), and the Valkyrie locks anywhere in its front hemisphere.
const SHOT_ARC = {
  lurcher:  Math.PI,          // 360° — turret reaches all the way around (slew-limited)
  firebrat: Math.PI / 36,     // 5° — basically a fixed forward gun
  valkyrie: Math.PI / 2,      // front hemisphere for missile lock acquisition
  jotun:    Math.PI / 6,      // 30° — heavy turret; steer the hull for the rest
};
// Turret slew speed (rad/s) for player aim tracking. The Lurcher takes ~1s to
// swing to the opposite side (π rad ÷ π/s); the Jotun's small arc snaps quicker.
const TURRET_SLEW = { lurcher: Math.PI, jotun: Math.PI * 2.0 };
const JOTUN_AIR_MIN = 30;     // Jotun can only reach AIR targets beyond this range (or straight overhead)
// The Lurcher's guns lose punch at range; the Jotun's don't. Scales shot damage by
// distance to the target: full inside NEAR, falling to FAR_MULT past FAR.
const LURCHER_FALLOFF = { near: 22, far: 72, farMult: 0.42 };
// Per-type collision/target radius. The Firebrat is deliberately small so it slips
// between trees and is a harder target; the heavies are bulky.
const VEH_HIT_R = { lurcher: 3.2, firebrat: 2.0, valkyrie: 3.0, jotun: 3.6 };
// Preferred AI stand-off distance per type — how far out a unit holds while shooting
// so it fights from its strength instead of charging into a base's kill zone. The
// Jotun (no range falloff) snipes from beyond most of the wall-turrets' reach; the
// Firebrat has to close to use its short forward gun. Drives both duels and the
// turret-suppression standoff (see AI.js engage/suppress).
const ENGAGE_RANGE = { lurcher: 50, firebrat: 24, valkyrie: 50, jotun: 70 };
// Where a unit SITS to silence a wall-turret — the standoff is placed radially
// OUTSIDE the base through the target turret, so only that one turret bears on it
// (no crossfire from the others). The Jotun parks beyond TURRET_RANGE (54) so it
// out-snipes the tower untouched; the Valkyrie flies its arc in; the Lurcher (no
// fly, sinks in water) sits at the corner and busts that tower/wall the hard way.
const TURRET_HOLD = { jotun: 64, valkyrie: 46, lurcher: 46, firebrat: 26 };

// Movement personality per type. cruise = rest altitude above the surface;
// ignoreWalls = flies over base walls; water = 'cross' (hover/fly) or 'sink'
// (land vehicle floods + drowns); tree = 'crush' | 'bump' (collide+chip) | 'fly'.
const VEH_MOVE = {
  lurcher:  { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush' },
  firebrat: { cruise: 2.4, ignoreWalls: false, water: 'cross', tree: 'bump'  },
  valkyrie: { cruise: 7.5, ignoreWalls: true,  water: 'cross', tree: 'fly'   },
  jotun:    { cruise: 0,   ignoreWalls: false, water: 'sink',  tree: 'crush' },
};
// Durability + thirst. burn = fuel/sec at full throttle (idle sips 25%).
// ammo = shots carried (fast guns carry more, heavy hitters few); shield = the
// MAX armour pool a shield-generator pickup can give this vehicle (starts at 0).
const VEH_STATS = {
  lurcher:  { hp: 220, fuel: 200, burn: 2.4, ammo: 45, shield: 110 },
  firebrat: { hp: 90,  fuel: 200, burn: 3.0, ammo: 90, shield: 45  },
  valkyrie: { hp: 140, fuel: 200, burn: 4.2, ammo: 24, shield: 75  },
  jotun:    { hp: 320, fuel: 200, burn: 2.0, ammo: 12, shield: 160 },
};
const SINK_RATE = 1.2;     // units/sec a land vehicle floods when over water
const SINK_KILL = 2.5;     // depth at which it's fully submerged → destroyed
const TREE_BUMP_DMG = 12;  // HP a light vehicle loses ramming a palm

let fireCooldown = 0;
let fireHeld = false;          // SPACE / on-screen fire button held
let playerColorIndex = 4;      // team colour index for the player's projectile tint
const combatants = [];         // every live, damageable Vehicle (player + AI)
const fx = [];                 // transient hit sparks / explosions ({obj,life,update})
const _muzzleWorld = new THREE.Vector3();
const _fireDir = new THREE.Vector3();
const _aimDir = new THREE.Vector3();
const _gunQuat = new THREE.Quaternion();
const wrapPi = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Aim a vehicle at a world point: swing its turret (Jotun/Lurcher) toward the
// target, clamped to the type's SHOT_ARC off the hull forward, and return the
// horizontal fire direction at that (clamped) yaw. Non-turret types just get the
// clamped direction (the body doesn't turn). Holds the aim briefly (decayAim).
function aimDir(veh, targetPoint) {
  const hp = veh.holder.position;
  const aimAng = Math.atan2(-(targetPoint.x - hp.x), -(targetPoint.z - hp.z));   // world yaw of the target dir
  const arc = SHOT_ARC[veh.type] ?? Math.PI / 5;
  const rel = Math.max(-arc, Math.min(arc, wrapPi(aimAng - veh.heading)));
  if (veh.model && veh.model.turretGroup) { veh.model.autoScan = false; veh.model.aimYaw = rel; veh._aimHold = 1.4; }
  const ang = veh.heading + rel;
  return _aimDir.set(-Math.sin(ang), 0, -Math.cos(ang)).normalize();
}
// The actual 3D fire direction toward a target: horizontal yaw clamped to the
// vehicle's arc (off the hull forward), but the VERTICAL pitch aimed straight at
// the target — so a Firebrat/AI can hit a flying Valkyrie instead of shooting flat
// underneath it. Swings the turret for AI turreted shooters (the player's turret
// is already tracked by aimPlayerTurret, so leave it alone).
function aimFireDir(veh, targetPoint, mpos) {
  const to = _vtmp.copy(targetPoint).sub(mpos);
  const horiz = Math.hypot(to.x, to.z) || 1e-3;
  const pitch = Math.atan2(to.y, horiz);                       // vertical aim, kept as-is
  const arc = SHOT_ARC[veh.type] ?? Math.PI / 5;
  const rel = Math.max(-arc, Math.min(arc, wrapPi(Math.atan2(-to.x, -to.z) - veh.heading)));
  if (veh !== player && veh.model && veh.model.turretGroup) { veh.model.autoScan = false; veh.model.aimYaw = rel; veh._aimHold = 1.4; }
  const yaw = veh.heading + rel, cy = Math.cos(pitch);
  return _aimDir.set(-Math.sin(yaw) * cy, Math.sin(pitch), -Math.cos(yaw) * cy).normalize();
}
// Let a held turret aim ease back to forward once the shot's hold has elapsed.
// (AI uses this; the player turret is driven continuously by aimPlayerTurret.)
function decayAim(veh, dt) {
  if (veh._aimHold > 0) { veh._aimHold -= dt; if (veh._aimHold <= 0 && veh.model) veh.model.aimYaw = 0; }
}

// Continuously swing the player's turret toward the aim cursor while driving — the
// gun FOLLOWS the mouse instead of snapping on-fire then drifting back (which read
// as idle sway). Clamped to the type's arc; slewed at TURRET_SLEW so the Lurcher
// takes ~1s to cross. Sets veh._turretRel (current yaw off hull) + veh._aligned
// (turret is on-target, so a shot connects). No turret (Firebrat/Valkyrie) = no-op.
function aimPlayerTurret(veh, dt) {
  if (!veh || !veh.model || !veh.model.turretGroup) return;
  const slew = (TURRET_SLEW[veh.type] ?? Math.PI) * dt;
  let desired;
  if (_aimPoint) {
    const hp = veh.holder.position;
    const ang = Math.atan2(-(_aimPoint.x - hp.x), -(_aimPoint.z - hp.z));
    const arc = SHOT_ARC[veh.type] ?? Math.PI;
    desired = Math.max(-arc, Math.min(arc, wrapPi(ang - veh.heading)));
  } else {
    desired = 0;   // no cursor (e.g. touch) → ease back to forward
  }
  const cur = veh.model.aimYaw || 0;
  let d = wrapPi(desired - cur);
  d = Math.max(-slew, Math.min(slew, d));
  veh.model.aimYaw = cur + d;
  veh.model.autoScan = false;
  veh._turretRel = veh.model.aimYaw;
  veh._aligned = Math.abs(wrapPi(desired - veh.model.aimYaw)) < 0.06;
}
const _vtmp = new THREE.Vector3();

// Outfit a freshly-built Vehicle for combat: team, HP, fuel, movement traits, a
// floating health bar (enemies) and registration for damage. Returns the vehicle.
function initCombatant(veh, team, colorIndex, isPlayer) {
  const st = VEH_STATS[veh.type] || VEH_STATS.lurcher;
  veh.team = team;
  veh.colorIndex = colorIndex;
  veh.maxHp = st.hp; veh.hp = st.hp;
  veh.maxFuel = st.fuel; veh.fuel = st.fuel;
  veh.burn = st.burn;
  veh.maxAmmo = st.ammo; veh.ammo = st.ammo;
  veh._ammoAcc = 0;                 // fractional rearm accumulator
  veh.maxShield = st.shield; veh.shield = 0;   // armour pool, picked up at a generator
  veh._shieldFx = null;             // force-field bubble, created on first pickup
  veh._move = VEH_MOVE[veh.type] || VEH_MOVE.lurcher;
  veh._blocked = blockedFor(veh._move, !isPlayer);   // AI paths around water; player may dive in
  veh._sink = 0;
  veh.hitR = VEH_HIT_R[veh.type] ?? 3.2;   // Firebrat is small + nimble; heavies are big targets
  veh.dead = false;
  veh.cooldown = 0;
  veh.isPlayer = !!isPlayer;
  veh._throttle = 0;
  veh._aimHold = 0;
  if (veh.model) { veh.model.autoScan = false; veh.model.aimYaw = 0; }   // controlled → face forward, not idle-sweep
  veh._engineId = null;   // assigned lazily by updateEngineSounds (non-player)
  if (!isPlayer) veh.bar = makeHealthBar(veh);   // enemies show a floating bar; player uses the HUD
  combatants.push(veh);
  return veh;
}

function removeCombatant(veh) {
  const i = combatants.indexOf(veh);
  if (i >= 0) combatants.splice(i, 1);
  if (veh.bar) { scene.remove(veh.bar.group); veh.bar = null; }
  if (veh._engineId != null && sound) { sound.dropSpatialEngine(veh._engineId); veh._engineId = null; }
  if (veh._shieldFx) { veh.holder.remove(veh._shieldFx); veh._shieldFx.geometry.dispose(); veh._shieldFx.material.dispose(); veh._shieldFx = null; }
}

// Fire a vehicle's gun: sound (player only), muzzle flash + recoil, and a damaging
// projectile aimed down the gun/turret. cause-checked discharge for the railgun.
function fireVehicle(veh, playSound, targetPoint = null, targetVeh = null) {
  if (!veh || veh.dead) return;
  if (veh.ammo <= 0) { if (veh.isPlayer) updatePlayerHud(); return; }   // dry — rearm at a depot/base
  veh.ammo -= 1;
  if (veh.isPlayer) updatePlayerHud();
  const idx = veh.def.soundIndex;
  if (playSound) { try { if (sound) sound.fireGun(); } catch (e) { /* best-effort */ } }
  // The player's turret is already tracking the cursor (aimPlayerTurret); only the
  // AI / non-turret shooters need aimDir to swing toward the target on trigger.
  const playerTurret = veh === player && veh.model && veh.model.turretGroup;
  if (targetPoint && !playerTurret) aimDir(veh, targetPoint);
  // A held green reticle on an enemy vehicle = a guaranteed hit for the turreted
  // guns (Lurcher fades with range, Jotun doesn't). The projectile becomes cosmetic.
  const guaranteed = veh === player && targetVeh && !targetVeh.dead && (idx === 0 || idx === 3);
  const discharge = () => {
    if (veh.dead) return;
    const muzzle = veh.fire ? veh.fire() : null;
    if (!muzzle) return;
    veh.group.updateMatrixWorld(true);
    const mpos = muzzle.getWorldPosition(_muzzleWorld);
    const aim = muzzle.parent || veh.group;
    const dir = _fireDir.set(0, 0, -1).applyQuaternion(aim.getWorldQuaternion(_gunQuat)).normalize();
    const hex = TEAM_COLORS[veh.colorIndex] ? TEAM_COLORS[veh.colorIndex].hex : 0xffffff;
    // Player Valkyrie with a lock: launch toward the locked point and home onto it.
    const guided = idx === 2 && veh === player && lock;
    if (guided) dir.copy(lock.point).sub(mpos).normalize();
    else if (targetPoint) dir.copy(aimFireDir(veh, targetPoint, mpos));   // 3D aim: clamp yaw to arc, keep pitch toward target
    if (guaranteed) {
      // Land the damage directly on the locked target; the slug is just a visual.
      const dist = targetVeh.holder.position.distanceTo(mpos);
      damageVehicle(targetVeh, SHOT_DMG[idx] * rangeFalloff(veh.type, dist), 'vehicle');
      projectiles.spawn(idx, mpos, dir, hex);   // no dmg payload → updateProjectileHits ignores it
    } else if (idx === 1) {
      // Firebrat laser = hitscan: damage the first thing along the beam now.
      raycastDamage(mpos, dir, 40, SHOT_DMG[idx], SHOT_BLAST[idx], veh.team, veh);
      projectiles.spawn(idx, mpos, dir, hex);
    } else {
      projectiles.spawn(idx, mpos, dir, hex);
      const shot = projectiles.items[projectiles.items.length - 1];
      if (shot) {
        shot.dmg = SHOT_DMG[idx]; shot.blast = SHOT_BLAST[idx]; shot.team = veh.team; shot.shooter = veh;
        // Home onto the locked target (live position) — but only if it's holdable;
        // a too-fast mover (red box) dumb-fires straight.
        if (guided && shot.setHoming && (lock.static || lock.locked)) {
          const fixed = lock.static ? lock.point.clone() : null;
          const tgt = lock.target;
          shot.setHoming(() => fixed || (tgt && !tgt.dead ? tgt.holder.position : null), MISSILE_TURN);
        }
      }
    }
  };
  if (idx === 3) setTimeout(discharge, 900);   // railgun charge
  else discharge();
  veh.cooldown = FIRE_INTERVALS[idx] || 0.3;
}

// Player convenience wrapper (cadence handled by driveUpdate's fireHeld loop).
// Fires at the aim crosshair if the cursor's over the field, else straight ahead.
function firePlayer() {
  if (!player || player.dead) return;
  if (playerIsValkyrie()) { fireVehicle(player, true, null); fireCooldown = player.cooldown; return; }
  if (_cursor) {
    // Mouse aim: only spend a shot when there's a valid firing solution (green reticle).
    if (!_aimValid) return;
    fireVehicle(player, true, _aimPoint, _aimTargetVeh);
  } else {
    fireVehicle(player, true, null);   // touch / no cursor → fire straight forward
  }
  fireCooldown = player.cooldown;
}

// Lurcher guns fade with range; the Jotun's railgun doesn't. dist = muzzle→target.
function rangeFalloff(type, dist) {
  if (type !== 'lurcher') return 1;
  const { near, far, farMult } = LURCHER_FALLOFF;
  if (dist <= near) return 1;
  if (dist >= far) return farMult;
  return 1 - (1 - farMult) * (dist - near) / (far - near);
}

// --- Valkyrie missile lock-on -------------------------------------------------
// The Valkyrie fires STEERABLE missiles, so the player clicks/taps a target to
// lock it; missiles then home onto the locked point. A target moving faster than
// LOCK_MAX_SPEED (a Firebrat at full tilt) can't be held — the box goes red and
// the shot dumb-fires. Walls/ground are static so they always lock.
const LOCK_MAX_SPEED = 17;        // u/s; above this the lock won't hold (Firebrat tops ~20)
const MISSILE_TURN = 2.6;         // rad/s the missile can curve while homing
const _gp = new THREE.Vector3();
const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
let lock = null;                  // { target, point, static, locked, lastPos, speed }
let reticle = null;

function playerIsValkyrie() { return player && !player.dead && player.type === 'valkyrie'; }

function ensureReticle() {
  if (reticle) return reticle;
  const g = new THREE.Group();
  // four L-shaped corner brackets around a unit square (billboarded, scaled by range)
  const mat = new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.95, depthTest: false });
  const arm = 0.42, half = 1.0;
  const corners = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
  for (const [sx, sy] of corners) {
    const pts = [
      new THREE.Vector3(sx * half - sx * arm, sy * half, 0),
      new THREE.Vector3(sx * half, sy * half, 0),
      new THREE.Vector3(sx * half, sy * half - sy * arm, 0),
    ];
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
  }
  g.renderOrder = 999;
  g.visible = false;
  reticle = g; reticle._mat = mat;
  scene.add(g);
  return g;
}

function setLock(target, point) {
  ensureReticle();
  if (!lock) lock = { target: null, point: new THREE.Vector3(), static: false, locked: true, lastPos: new THREE.Vector3(), speed: 0 };
  lock.target = target;
  lock.static = !target;
  if (target) { lock.point.copy(target.holder.position); lock.lastPos.copy(target.holder.position); lock.speed = 0; }
  else lock.point.copy(point);
  lock.locked = true;
  reticle.visible = true;
}

function clearLock() { lock = null; if (reticle) reticle.visible = false; }

// Raycast a screen point to a world target: prefer an enemy vehicle (returns the
// Vehicle), then a wall/building hit point, then the ground. Returns { veh, point }.
function pickWorldPoint(px, py) {
  const ndc = new THREE.Vector2((px / window.innerWidth) * 2 - 1, -(py / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let best = null, bestAlong = Infinity;
  for (const v of combatants) {
    if (v.dead || v === player || (player && v.team === player.team)) continue;
    const c = v.holder.position;
    if (ray.ray.distanceToPoint(c) < v.hitR + 2.5) {
      const along = ray.ray.origin.distanceToSquared(c);
      if (along < bestAlong) { bestAlong = along; best = v; }
    }
  }
  if (best) return { veh: best, point: best.holder.position.clone() };
  const hit = destructibles.pick(ray);
  if (hit) return { veh: null, point: hit.point.clone() };
  if (ray.ray.intersectPlane(_groundPlane, _gp)) {
    _gp.y = map.heightAt(_gp.x, _gp.z) + 0.5;
    return { veh: null, point: _gp.clone() };
  }
  return null;
}

// Valkyrie: a click LOCKS the target box (missiles then home). Prefer a vehicle.
function acquireLock(px, py) {
  if (!playerIsValkyrie()) return;
  const t = pickWorldPoint(px, py);
  if (!t) return;
  // Front-hemisphere only: the launcher can't lock something behind the hull.
  const hp = player.holder.position;
  const ang = Math.atan2(-(t.point.x - hp.x), -(t.point.z - hp.z));
  if (Math.abs(wrapPi(ang - player.heading)) > SHOT_ARC.valkyrie + 1e-3) return;
  setLock(t.veh, t.point);
}

// Every other vehicle: a click FIRES at that point (turret swings within its arc).
function fireAtPoint(px, py) {
  if (!player || player.dead || player.cooldown > 0) return;
  const t = pickWorldPoint(px, py);
  if (!t) return;
  fireVehicle(player, true, t.point);
  fireCooldown = player.cooldown;
}

// Cursor crosshair (desktop): follows the mouse over the field and shows where the
// shot will go — GREEN when the point is inside the vehicle's firing arc, AMBER
// when it's outside (the turret will clamp). Its world point feeds SPACE / the
// fire button too, so firing is reliable even if a click reads as an orbit drag.
let aimReticle = null, _cursor = null, _aimPoint = null, _aimValid = false, _aimTargetVeh = null;
function ensureAimReticle() {
  if (aimReticle) return aimReticle;
  const g = new THREE.Group();
  const mat = new THREE.LineBasicMaterial({ color: 0x66ff88, transparent: true, opacity: 0.9, depthTest: false });
  const ring = [];
  for (let i = 0; i <= 28; i++) { const a = i / 28 * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0)); }
  g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), mat));
  const ticks = [[-1.5, 0, -0.6, 0], [0.6, 0, 1.5, 0], [0, -1.5, 0, -0.6], [0, 0.6, 0, 1.5]];
  for (const [x1, y1, x2, y2] of ticks)
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x1, y1, 0), new THREE.Vector3(x2, y2, 0)]), mat));
  g.renderOrder = 998; g.visible = false;
  aimReticle = g; aimReticle._mat = mat;
  scene.add(g);
  return g;
}
function updateAimReticle() {
  _aimPoint = null; _aimValid = false; _aimTargetVeh = null;
  if (!onField || !player || player.dead || playerIsValkyrie() || !_cursor) { if (aimReticle) aimReticle.visible = false; return; }
  const t = pickWorldPoint(_cursor.x, _cursor.y);
  if (!t) { if (aimReticle) aimReticle.visible = false; return; }
  ensureAimReticle();
  _aimPoint = t.point; _aimTargetVeh = t.veh;
  const hp = player.holder.position;
  const aimAng = Math.atan2(-(t.point.x - hp.x), -(t.point.z - hp.z));
  const rel = Math.abs(wrapPi(aimAng - player.heading));
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  const horiz = Math.hypot(t.point.x - hp.x, t.point.z - hp.z);
  const isAir = t.point.y > map.heightAt(t.point.x, t.point.z) + 4;   // elevated target (flyer)

  // Per-type rules for when a shot is VALID (reticle shows green / fire connects).
  let valid = false, slewing = false;
  if (player.type === 'firebrat') {
    valid = rel <= arc + 1e-3;                          // fixed 5° forward gun
  } else if (player.type === 'jotun') {
    const inArc = rel <= arc + 1e-3;                    // 30° heavy turret
    valid = inArc && (!isAir || horiz >= JOTUN_AIR_MIN); // air targets only beyond min range / overhead
  } else { // lurcher — reaches any direction, but only HITS once the turret catches up
    valid = !!player._aligned;
    slewing = !valid;                                  // gun still swinging toward the point
  }
  _aimValid = valid;

  // Firebrat/Jotun: hide the reticle entirely when there's no solution. Lurcher:
  // keep it visible while the turret slews (amber), green once it's on-target.
  if (!valid && !slewing) { aimReticle.visible = false; return; }
  aimReticle.visible = true;
  aimReticle.position.copy(t.point);
  aimReticle.quaternion.copy(camera.quaternion);
  aimReticle.scale.setScalar(Math.max(0.8, camera.position.distanceTo(t.point) * 0.03));
  aimReticle._mat.color.setHex(valid ? 0x66ff88 : 0xffb030);   // green = will hit, amber = turret turning
}

// Track the locked target, measure its speed, and position/colour the box.
function updateLock(dt) {
  if (!lock) return;
  if (!playerIsValkyrie()) { clearLock(); return; }
  if (lock.target) {
    if (lock.target.dead) { clearLock(); return; }
    const pos = lock.target.holder.position;
    lock.speed = pos.distanceTo(lock.lastPos) / Math.max(dt, 1e-3);
    lock.lastPos.copy(pos);
    lock.point.copy(pos);
    lock.locked = lock.speed <= LOCK_MAX_SPEED;
  } else {
    lock.locked = true;        // static point — always holdable
  }
  reticle.position.copy(lock.point);
  reticle.quaternion.copy(camera.quaternion);
  reticle.scale.setScalar(Math.max(0.7, camera.position.distanceTo(lock.point) * 0.05));
  reticle._mat.color.setHex(lock.locked ? 0x66ff88 : 0xff5a5a);
  reticle.visible = lock.locked || (Math.floor(performance.now() / 130) % 2 === 0);   // blink when no-lock
}

// Apply blast damage at a world point to walls/buildings, trees, and vehicles.
function explodeAt(point, blast, dmg, team, shooter) {
  destructibles.damageAt(point, blast, dmg);
  if (foliage) foliage.hitTreesAt(point, blast, dmg);
  damageVehiclesAt(point, blast, dmg, team, shooter);
  spawnImpact(point, blast);
}

// Damage enemy vehicles within blast of a point (never the shooter or its team).
function damageVehiclesAt(point, blast, dmg, team, shooter) {
  for (const v of combatants) {
    if (v.dead || v === shooter) continue;
    if (team != null && v.team === team) continue;
    const reach = blast + v.hitR;
    if (v.holder.position.distanceToSquared(point) <= reach * reach) damageVehicle(v, dmg, 'vehicle');
  }
}

// Running tally of damage dealt to vehicles, by source — powers siege diagnostics
// (are attackers dying to towers or to enemy vehicles?) and a future kill feed.
const dmgTally = { turret: 0, vehicle: 0, tree: 0, other: 0 };
function damageVehicle(veh, amount, cause = 'other') {
  if (veh.dead) return;
  dmgTally[cause] = (dmgTally[cause] || 0) + amount;
  if (veh.ai) veh._dmgBy = veh._dmgBy || { turret: 0, vehicle: 0, tree: 0, other: 0 }, veh._dmgBy[cause] += amount;
  // The shield pool soaks damage before the hull (body-armour style).
  if (veh.shield > 0) {
    const absorbed = Math.min(veh.shield, amount);
    veh.shield -= absorbed;
    amount -= absorbed;
    if (veh._shieldFx) veh._shieldFx.userData.hit = 1;   // flare the bubble on impact
    if (veh.shield <= 0 && veh._shieldFx) veh._shieldFx.visible = false;
  }
  if (amount > 0) veh.hp -= amount;
  if (veh.bar) updateHealthBar(veh);
  if (veh.isPlayer) updatePlayerHud();
  if (veh.hp <= 0) destroyVehicle(veh, 'killed');
}

// March a hitscan beam; damage the first solid/tree/vehicle it meets.
function raycastDamage(origin, dir, maxDist, dmg, blast, team, shooter) {
  const STEP = 1.2;
  for (let d = 1.0; d <= maxDist; d += STEP) {
    _vtmp.copy(dir).multiplyScalar(d).add(origin);
    const hv = nearestEnemyVehicle(_vtmp, 2.5, team, shooter);
    if (hv) {
      // Hit the DETECTED vehicle directly — the detection pad (2.5) is wider than
      // the tiny splash reach, so a point-blast here would miss what the beam met.
      damageVehicle(hv, dmg, 'vehicle');
      spawnImpact(hv.holder.position, blast);
      return;
    }
    if (destructibles.queryHit(_vtmp, 0.4) || (foliage && foliage.treeAt(_vtmp.x, _vtmp.z, 0.4))) {
      explodeAt(_vtmp, blast, dmg, team, shooter);
      return;
    }
  }
}

// --- Wall turrets ----------------------------------------------------------
// Corner turrets defend their camp: they track the nearest enemy vehicle in range
// with line of sight and fire on a cadence, damage falling off with distance — so
// you can't just waltz into a base. Destroying the turret head silences it.
const TURRET_RANGE = 54, TURRET_CD = 1.6, TURRET_DMG = 18;   // shorter reach — don't shred units from across the map
const TURRET_FALLOFF = { near: 16, far: 54, farMult: 0.45 };
// How far an AI unit can SENSE an enemy turret to suppress/snipe it — wider than the
// turret's own fire range so heavies (Jotun) can pick towers off from safely outside.
const TURRET_SENSE = 96;
const _tHead = new THREE.Vector3(), _tDir = new THREE.Vector3(), _threatV = new THREE.Vector3();
function turretFalloff(dist) {
  const { near, far, farMult } = TURRET_FALLOFF;
  if (dist <= near) return 1;
  if (dist >= far) return farMult;
  return 1 - (1 - farMult) * (dist - near) / (far - near);
}
function updateWallTurrets(dt) {
  if (matchOver) return;
  for (const c of camps) {
    for (const w of c.walls) {
      const t = w.turret;
      if (!t || t.dead || t.falling) continue;
      t._cd = (t._cd || 0) - dt;
      t.group.updateWorldMatrix(true, false);
      t.head.getWorldPosition(_tHead);
      // nearest enemy vehicle in range (turrets sit above the parapet → no wall-LOS check)
      let target = null, bestD = TURRET_RANGE * TURRET_RANGE;
      for (const v of combatants) {
        if (v.dead || v.team === c.team) continue;
        const dx = v.holder.position.x - _tHead.x, dz = v.holder.position.z - _tHead.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) { bestD = d2; target = v; }
      }
      if (!target) { t.aimYaw = null; continue; }   // nothing in range → idle sweep
      const tp = target.holder.position;
      t.aimYaw = Math.atan2(tp.x - _tHead.x, tp.z - _tHead.z);   // barrels point +Z local; swing the head onto it
      if (t._cd <= 0) {
        t._cd = TURRET_CD;
        // Damage the locked target directly (with range falloff) + a cosmetic tracer.
        // Direct, so the slug can't clip the turret's OWN walls on the way out.
        damageVehicle(target, TURRET_DMG * turretFalloff(Math.sqrt(bestD)), 'turret');
        _tDir.copy(tp).sub(_tHead).normalize();
        const hex = TEAM_ACCENT[c.team] ? new THREE.Color(TEAM_ACCENT[c.team]).getHex() : 0xffd0a0;
        projectiles.spawn(0, _tHead.clone(), _tDir.clone(), hex);   // cosmetic tracer toward the target
      }
    }
  }
}

function nearestEnemyVehicle(point, pad, team, shooter) {
  for (const v of combatants) {
    if (v.dead || v === shooter) continue;
    if (team != null && v.team === team) continue;
    const reach = pad + v.hitR;
    if (v.holder.position.distanceToSquared(point) <= reach * reach) return v;
  }
  return null;
}

// Advance travelling projectiles' damage: detonate on first solid/tree/vehicle/
// ground contact. (Projectiles.js already flies + fades them visually.)
function updateProjectileHits() {
  for (let i = projectiles.items.length - 1; i >= 0; i--) {
    const p = projectiles.items[i];
    if (p.dmg == null) continue;            // laser shots carry no travel damage
    const pos = p.obj.position;
    const hitSolid = destructibles.queryHit(pos, 0.3);
    const hitTree = foliage && p.team != null && foliage.treeAt(pos.x, pos.z, 0.3);
    const hitVeh = nearestEnemyVehicle(pos, 0.5, p.team, p.shooter);
    const hitGround = pos.y <= map.heightAt(pos.x, pos.z) + 0.2 && map.isLand(pos.x, pos.z);
    if (hitSolid || hitTree || hitVeh || hitGround) {
      if (hitSolid) hitSolid.damage(p.dmg, pos);   // direct hit = full damage (splash adds a little more)
      explodeAt(pos, p.blast, p.dmg, p.team, p.shooter);
      projectiles.scene.remove(p.obj); p.dispose(); projectiles.items.splice(i, 1);
    }
  }
}

// A short additive flash + a few sparks where something was hit.
function spawnImpact(point, size) {
  const r = Math.max(0.5, size);
  const geo = new THREE.SphereGeometry(r, 8, 8);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffd27f, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.position.copy(point); scene.add(m);
  fx.push({ obj: m, life: 0.22, max: 0.22, update(dt, k) { m.scale.setScalar(1 + (1 - k) * 2.5); mat.opacity = 0.9 * k; },
    dispose() { geo.dispose(); mat.dispose(); } });
}

function spawnExplosion(point, big) {
  const r = big ? 5 : 3;
  const geo = new THREE.SphereGeometry(r, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const m = new THREE.Mesh(geo, mat); m.position.copy(point); scene.add(m);
  fx.push({ obj: m, life: 0.5, max: 0.5, update(dt, k) { m.scale.setScalar(0.3 + (1 - k) * 1.8); mat.opacity = k; },
    dispose() { geo.dispose(); mat.dispose(); } });
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.life -= dt;
    f.update(dt, Math.max(0, f.life / f.max));
    if (f.life <= 0) { scene.remove(f.obj); f.dispose(); fx.splice(i, 1); }
  }
}

// Destroy a vehicle: explosion, then remove it (or send the player to the garage).
function destroyVehicle(veh, cause) {
  if (veh.dead) return;
  veh.dead = true;
  spawnExplosion(veh.holder.position, veh.type === 'jotun');
  if (veh.isPlayer) { killPlayer(); return; }
  // Surface what happened to the AI unit — drowned/destroyed units used to just vanish.
  if (veh.ai && veh.team) {
    const how = cause === 'sank' ? 'DROWNED' : 'destroyed';
    aiLog(veh.team, `${veh.ai.p ? veh.ai.p.name : '?'} ${veh.type} ${how}`);
  }
  removeCombatant(veh);
  if (veh.ai) veh.ai.dead = true;
  scene.remove(veh.group);
}

let playerDead = false;
function killPlayer() {
  if (playerDead) return;
  playerDead = true;
  driving = false;
  clearLock();
  if (player) playerLosses[player.type] = (playerLosses[player.type] || 0) + 1;   // attrition: one fewer in the garage
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* engine winds down on death */ }
  removeCombatant(player);
  scene.remove(player.group);
  player = null;
  const fade = document.getElementById('deployfade');
  if (fade) fade.style.opacity = 1;
  setTimeout(() => { playerDead = false; returnToGarage(); }, 1400);
}

// Per-vehicle blocked(x,z): map bounds, walls (unless it flies), and bump-trees.
// avoidWater makes a land vehicle treat open sea as solid — used for the AI so it
// paths around the coast; the player keeps avoidWater=false so it CAN drive in
// (and flood/sink, see applyAltitude).
function blockedFor(move, avoidWater) {
  return (x, z) => {
    const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
    if (x < -halfW || x > halfW || z < -halfH || z > halfH) return true;
    if (islandBound && (x * x + z * z) > islandBound * islandBound) return true;   // off the island → walled off
    const cx = Math.round(x / grid.cell), cz = Math.round(z / grid.cell);
    if (roadNet.cells && roadNet.cells.has(cx + ',' + cz)) return false;
    if (elevatorPadAt(x, z)) return false;
    if (avoidWater && move.water === 'sink' && map.isDeepWater(x, z)) return true;   // shallow is fordable
    if (move.ignoreWalls) return false;              // Valkyrie clears walls
    for (const o of obstacles) {
      const dx = x - o.x, dz = z - o.z, rr = o.r + VEH_R;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    if (move.tree === 'bump' && foliage && foliage.treeAt(x, z, VEH_R * 0.5)) return true;
    return false;
  };
}

// Resolve altitude + water flooding for a vehicle, and crush/bump trees it touches.
function applyAltitude(veh, dt) {
  const m = veh._move; if (!m) return;
  const x = veh.holder.position.x, z = veh.holder.position.z;
  const deck = elevatorPadAt(x, z);
  const terrain = deck ? deck.groundY : map.heightAt(x, z);
  const overWater = !deck && !map.isLand(x, z);
  const deepWater = !deck && map.isDeepWater(x, z);   // only the deep part drowns a sinker
  let target;
  if (m.water === 'sink') {
    if (deepWater) {
      veh._sink += dt * SINK_RATE;
      target = -veh._sink;
      if (veh._sink >= SINK_KILL) { destroyVehicle(veh, 'sank'); return; }
    } else {
      // land OR shallow water → ride the actual floor (negative in shallow water, so
      // the hull sits partly submerged and reads as WADING, not floating on top),
      // bleeding off any sink it built up wading out of the deep.
      veh._sink = Math.max(0, veh._sink - dt * SINK_RATE * 1.6);
      const floor = deck ? deck.groundY : map.floorAt(x, z);
      target = floor + 0.05 - veh._sink;
    }
  } else {
    const base = overWater ? 0 : terrain;
    target = base + m.cruise;
  }
  veh.holder.position.y += (target - veh.holder.position.y) * Math.min(1, dt * 5);

  // Trees in contact: heavy vehicles flatten them; light ones chip themselves.
  if (m.tree !== 'fly' && foliage) {
    const t = foliage.treeAt(x, z, veh.hitR * 0.5);
    if (t) {
      if (m.tree === 'crush') { foliage.fellTree(t); }
      else if (m.tree === 'bump' && veh._touchTree !== t) { veh._touchTree = t; damageVehicle(veh, TREE_BUMP_DMG, 'tree'); }
    } else { veh._touchTree = null; }
  }
}

// Burn fuel against throttle. An empty tank doesn't strand you — the engine
// "limps" at reduced power (LIMP). Idle sips a quarter of the full-throttle rate.
const LIMP = 0.35;
function burnFuel(veh, inp, dt) {
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25) };
  const load = (Math.abs(inp.fwd) + Math.abs(inp.turn) * 0.5);
  veh.fuel = Math.max(0, veh.fuel - veh.burn * (0.25 + 0.75 * Math.min(1, load)) * dt);
  if (veh.isPlayer) updatePlayerHud();
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25) };
  return inp;
}

// --- Health bars + player HUD -----------------------------------------
// A floating canvas-textured bar above a vehicle (enemies). Cheap: one sprite.
function makeHealthBar(veh) {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 10;
  const tex = new THREE.CanvasTexture(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sp = new THREE.Sprite(mat); sp.scale.set(6, 0.95, 1);
  const group = new THREE.Group(); group.add(sp);
  scene.add(group);
  const bar = { group, sprite: sp, tex, cv, ctx: cv.getContext('2d') };
  veh.bar = bar; updateHealthBar(veh); return bar;
}
function updateHealthBar(veh) {
  const b = veh.bar; if (!b) return;
  const f = Math.max(0, veh.hp / veh.maxHp);
  const c = b.ctx; c.clearRect(0, 0, 64, 10);
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, 64, 10);
  c.fillStyle = f > 0.5 ? '#4fd14f' : f > 0.25 ? '#e0c020' : '#e04020';
  c.fillRect(1, 1, 62 * f, 8);
  b.tex.needsUpdate = true;
}
// Keep bars above their vehicle and facing the camera (sprites already billboard).
function updateHealthBars() {
  for (const v of combatants) {
    if (!v.bar) continue;
    v.bar.group.position.set(v.holder.position.x, v.holder.position.y + 7, v.holder.position.z);
  }
}

function updatePlayerHud() {
  const hp = document.getElementById('hp-fill'), fu = document.getElementById('fuel-fill');
  const wrap = document.getElementById('player-bars');
  if (!wrap) return;
  if (!player || player.dead) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  if (hp) { const f = Math.max(0, player.hp / player.maxHp); hp.style.width = (f * 100) + '%';
    hp.style.background = f > 0.5 ? '#4fd14f' : f > 0.25 ? '#e0c020' : '#e04020'; }
  if (fu) fu.style.width = (Math.max(0, player.fuel / player.maxFuel) * 100) + '%';
  const am = document.getElementById('ammo-fill'), amTxt = document.getElementById('ammo-txt');
  if (am) { const f = Math.max(0, player.ammo / player.maxAmmo); am.style.width = (f * 100) + '%';
    am.style.background = player.ammo > 0 ? '#cf6f3a' : '#7a2a2a'; }
  if (amTxt) amTxt.textContent = `${player.ammo}`;
  const shRow = document.getElementById('shield-row'), sh = document.getElementById('shield-fill');
  if (shRow) shRow.style.display = player.shield > 0 ? 'flex' : 'none';
  if (sh) sh.style.width = (Math.max(0, player.shield / player.maxShield) * 100) + '%';
}

// --- Teams, flags, and AI commanders -----------------------------------
// A "commander" runs one team: a single active vehicle at a time, deployed from
// its base, pursuing the CTF objective (scout → smash the enemy's fortifications
// → send a Firebrat to steal their flag). It's one class per team, so any team
// can be AI — enabling AI-vs-AI and (with more bases) N independent sides. A
// HUMAN team is run by the player drive/deploy code instead. Perception is
// team-relative (a unit only knows rivals it actually sees), so nothing cheats.
const AI_VISION = 66;
const commanders = [];          // one AICommander per AI-controlled team

function teamCamp(team, role) { return camps.find(c => c.team === team && c.role === role); }
function teamCenter(team, role) { const c = teamCamp(team, role); return c ? c.center : { x: 0, z: 0 }; }
// Total standing wall HP of a team's bases (what an attacker must grind down).
function fortHpOf(team) {
  let s = 0;
  for (const c of camps) if (c.team === team) for (const w of c.walls) if (w.body && !w.body.dead) s += w.body.hp;
  return s;
}
// Live defensive turrets a team still has — the towers that actually shoot attackers.
// The commander uses this for tower-first ordering (don't send a runner into live towers).
function turretCountOf(team) {
  let n = 0;
  for (const c of camps) if (c.team === team) for (const w of c.walls) {
    const t = w.turret; if (t && !t.dead && !t.falling) n++;
  }
  return n;
}

// Capturable flag at every main base. Stolen by any rival unit touching it;
// captured when carried home to the thief's own main base.
const flags = [];
function buildFlags() {
  for (const f of flags) scene.remove(f.group);
  flags.length = 0;
  for (const c of camps) {
    if (c.role !== 'main') continue;
    // Match the camp's live accent (team colour), so a player-chosen colour shows
    // on the flag too — not a hard-coded red/blue. Recoloured on team-colour lock.
    const hex = '#' + c.accent.getHexString();
    const g = new THREE.Group();
    const H = 8;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, H, 6),
      new THREE.MeshStandardMaterial({ color: 0x9a9a9a, metalness: 0.6, roughness: 0.4 }));
    pole.position.y = H / 2; g.add(pole);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.6),
      new THREE.MeshStandardMaterial({ color: hex, emissive: hex, emissiveIntensity: 0.3, side: THREE.DoubleSide }));
    cloth.position.set(1.4, H - 1.1, 0); g.add(cloth);
    const gx = c.center.x, gz = c.center.z, gy = map.heightAt(gx, gz);
    g.position.set(gx, gy, gz);
    // The HQ wears the flag on its roof; this capturable pole stays HIDDEN inside
    // until the building is levelled — then it's revealed in the rubble and drops
    // to the ground (see updateFlags) for a Firebrat to grab.
    g.visible = false;
    scene.add(g);
    flags.push({ team: c.team, group: g, cloth, hqBody: c.flagHQ || null, revealed: false, dropT: 0,
      home: { x: gx, y: gy, z: gz }, carried: false, carrier: null, returnT: 0 });
  }
}
// Tint a team's capturable flag to a chosen colour (player team-colour lock).
function recolorFlag(team, hex) {
  for (const f of flags) if (f.team === team) { f.cloth.material.color.set(hex); f.cloth.material.emissive.set(hex); }
}
// Nearest rival flag to `team`'s base (its steal target).
function enemyFlagOf(team) {
  const home = teamCenter(team, 'fob');
  let best = Infinity, f = null;
  for (const fl of flags) {
    if (fl.team === team) continue;
    const d = (fl.group.position.x - home.x) ** 2 + (fl.group.position.z - home.z) ** 2;
    if (d < best) { best = d; f = fl; }
  }
  return f;
}
function updateFlags(dt) {
  if (matchOver) return;
  const GRAB = 6, CAP = 12, CAP_FOB = 16;   // FOB capture zone a touch wider (the deck)
  const DROP_FROM = 12, DROP_DUR = 1.1;     // flag falls ~12u from the roofline over ~1.1s
  for (const f of flags) {
    // The flag is sealed inside its HQ until the building is rubble. On the kill,
    // reveal it and let it FALL from the roofline to the ground at the rubble.
    if (!f.revealed) {
      if (f.hqBody && f.hqBody.dead) {
        f.revealed = true; f.group.visible = true; f.dropT = DROP_DUR;
        showBanner(`${f.team.toUpperCase()} HQ DOWN — FLAG EXPOSED`, { color: '#ffd0a0' });
      } else if (!f.carried) { continue; }   // still entombed and not in play — skip
    }
    if (f.dropT > 0 && !f.carried) {          // gravity-ish drop into the rubble
      f.dropT = Math.max(0, f.dropT - dt);
      const e = 1 - f.dropT / DROP_DUR;       // 0 (top) -> 1 (ground)
      f.group.position.y = f.home.y + DROP_FROM * (1 - e * e);
    }
    if (f.carried && f.carrier) {
      if (f.carrier.dead) {
        // Carrier killed (anywhere — including on the lift) → the flag drops where
        // it fell and STAYS there until a Firebrat re-grabs it (no auto-return).
        const c = f.carrier.holder.position;
        f.group.position.set(c.x, map.heightAt(c.x, c.z) + 0.2, c.z);
        f.carried = false; f.carrier = null;
      } else {
        const c = f.carrier.holder.position;
        f.group.position.set(c.x, c.y + 4.5, c.z);
        // AI carriers score by reaching their own base. The PLAYER must EXTRACT it —
        // ride the flag down the FOB lift into the secure garage (see returnToGarage).
        if (f.carrier !== player) {
          const main = teamCamp(f.carrier.team, 'main'), fob = teamCamp(f.carrier.team, 'fob');
          const atMain = main && Math.hypot(c.x - main.center.x, c.z - main.center.z) < CAP;
          const atFob = fob && Math.hypot(c.x - fob.center.x, c.z - fob.center.z) < CAP_FOB;
          if (atMain || atFob) onCapture(f.carrier.team, f);
        }
        continue;
      }
    }
    if (!f.carried) {                                  // a dropped/displaced flag — only a FIREBRAT can lift it
      const fx = f.group.position.x, fz = f.group.position.z;
      const displaced = Math.hypot(fx - f.home.x, fz - f.home.z) > GRAB;
      for (const v of combatants) {
        if (v.dead || v.type !== 'firebrat') continue;
        if (Math.hypot(v.holder.position.x - fx, v.holder.position.z - fz) >= GRAB) continue;
        if (v.team === f.team) {
          // Own team reaching its DISPLACED flag recovers it — snaps straight home
          // (you can't carry your own flag; this denies the thief a re-grab).
          if (displaced) { f.group.position.set(f.home.x, f.home.y, f.home.z); showBanner(`${f.team.toUpperCase()} FLAG RECOVERED`, { color: '#9bd6ff' }); }
        } else {
          f.carried = true; f.carrier = v; showBanner(`${f.team.toUpperCase()} FLAG TAKEN`);
        }
        break;
      }
    }
  }
}
// Carrying a rival flag home to your main base WINS the match.
function onCapture(team, f) {
  f.carried = false; f.carrier = null; f.returnT = 0;
  f.group.position.set(f.home.x, f.home.y, f.home.z);
  endMatch(team);
}

// --- Resupply points of interest (neutral, contested, destructible) -----------
// Fuel tanks / ammo depots / shield generators dotted around the open map. Any
// vehicle of either team that lingers nearby gets topped up (fuel/ammo/shield);
// destroying one denies it to everyone. A vehicle also resupplies (fuel + ammo)
// at its OWN base/FOB.
const FUEL_RATE = 28, AMMO_RATE = 6, SHIELD_RATE = 55, REPAIR_RATE = 13;   // per second

// Find an open land point ~targetR from map centre, clear of bases and each other.
function neutralSite(targetR) {
  for (let t = 0; t < 240; t++) {
    const ang = Math.random() * Math.PI * 2;
    const r = targetR * (0.78 + Math.random() * 0.44);
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < 28) { ok = false; break; }
    if (ok) for (const rp of resupplies) if (Math.hypot(x - rp.pos.x, z - rp.pos.z) < 24) { ok = false; break; }
    if (ok) return { x, z };
  }
  return null;
}

function placeResupplies() {
  for (const r of resupplies) scene.remove(r.group);
  resupplies = [];
  if (QS.has('nopoi')) return;
  const span = Math.min(map.worldW, map.worldH) / 2;
  const cell = grid.cell;
  // fuel + ammo near the contested middle; shield generator out toward the edge.
  const specs = [
    { kind: 'fuel',   r: span * 0.26, make: makeFuelTank,        hp: 130 },
    { kind: 'ammo',   r: span * 0.32, make: makeAmmoDepot,       hp: 150 },
    { kind: 'shield', r: span * 0.52, make: makeShieldGenerator, hp: 110 },
  ];
  for (const sp of specs) {
    const site = neutralSite(sp.r);
    if (!site) continue;
    const g = sp.make(cell);
    const gy = map.heightAt(site.x, site.z);
    g.position.set(site.x, gy, site.z);
    scene.add(g);
    const rp = { kind: sp.kind, group: g, pos: new THREE.Vector3(site.x, gy, site.z), radius: cell * 2.2, dead: false };
    destructibles.add(new Destructible(g, { type: 'structure', hp: sp.hp, blocks: true,
      onDestroyed: () => { rp.dead = true; } }));
    resupplies.push(rp);
  }
  scene.updateMatrixWorld(true);   // position before measuring bounds (worldCenter trap)
  destructibles.refreshAll();
}

function refuel(v, dt) {
  if (v.fuel >= v.maxFuel) return;
  v.fuel = Math.min(v.maxFuel, v.fuel + FUEL_RATE * dt);
  if (v.isPlayer) updatePlayerHud();
}
function rearm(v, dt) {
  if (v.ammo >= v.maxAmmo) return;
  v._ammoAcc += AMMO_RATE * dt;
  if (v._ammoAcc >= 1) {
    const n = Math.floor(v._ammoAcc); v._ammoAcc -= n;
    v.ammo = Math.min(v.maxAmmo, v.ammo + n);
    if (v.isPlayer) updatePlayerHud();
  }
}
function repair(v, dt) {
  if (v.hp >= v.maxHp) return;
  v.hp = Math.min(v.maxHp, v.hp + REPAIR_RATE * dt);
  if (v.bar) updateHealthBar(v);
  if (v.isPlayer) updatePlayerHud();
}
function reshield(v, dt) {
  if (v.shield >= v.maxShield) return;
  v.shield = Math.min(v.maxShield, v.shield + SHIELD_RATE * dt);
  ensureShieldFx(v);
  if (v.isPlayer) updatePlayerHud();
}
function nearOwnSupply(v, vx, vz) {
  const main = teamCamp(v.team, 'main'), fob = teamCamp(v.team, 'fob');
  if (main && Math.hypot(vx - main.center.x, vz - main.center.z) < 16) return true;
  if (fob && Math.hypot(vx - fob.center.x, vz - fob.center.z) < 12) return true;
  return false;
}

function ensureShieldFx(v) {
  if (v._shieldFx) { v._shieldFx.visible = true; return; }
  const b = makeShieldBubble(v.hitR * 1.5);
  b.position.y = 2.0;
  v.holder.add(b);            // rides with the hull (holder is unscaled)
  v._shieldFx = b;
}
function updateShieldFx(v, dt) {
  const b = v._shieldFx;
  if (!b) return;
  if (v.shield <= 0) { b.visible = false; return; }
  b.visible = true;
  const hit = b.userData.hit || 0;
  b.material.opacity = 0.12 + 0.16 * (v.shield / v.maxShield) + hit * 0.6;
  if (hit > 0) b.userData.hit = Math.max(0, hit - dt * 3);
  b.rotation.y += dt * 0.6;
}

function updateResupplies(dt) {
  for (const rp of resupplies) {
    if (!rp.dead && rp.kind === 'shield' && rp.group.userData.spin) rp.group.userData.spin.rotation.z += dt * 1.5;
  }
  for (const v of combatants) {
    if (v.dead) continue;
    const vx = v.holder.position.x, vz = v.holder.position.z;
    for (const rp of resupplies) {
      if (rp.dead || Math.hypot(vx - rp.pos.x, vz - rp.pos.z) > rp.radius) continue;
      if (rp.kind === 'fuel') refuel(v, dt);
      else if (rp.kind === 'ammo') rearm(v, dt);
      else if (rp.kind === 'shield') reshield(v, dt);
    }
    if (nearOwnSupply(v, vx, vz)) { refuel(v, dt); rearm(v, dt); repair(v, dt); }   // home base tops fuel + ammo + patches the hull
    updateShieldFx(v, dt);
  }
}

// --- Ground-unit navigation (A*) ---------------------------------------
// Units used to greedy-steer at their objective and only dodge walls locally, so a
// water inlet or a tree clump was a dead end (the Lurcher drowned at the shore, the
// Firebrat wedged in trees). Now ground units route with A* over the build grid,
// reusing each vehicle's OWN `_blocked` oracle as the passability test — so walls,
// the coast (for sinkers) and bump-trees (for the Firebrat) are all impassable, while
// crushers plough through trees and roads are preferred. Flyers skip this entirely.
// A* passability for a grid cell — a NAV-specific oracle, gentler than the player's
// collision `_blocked`: walls keep a smaller margin (so gates/tight spots stay
// threadable; drive()'s full-radius slide handles the fine bit), gate corridors,
// roads and elevator pads are explicitly open, and sinkers still avoid open water.
function cellBlocked(v, i, j) {
  const c = grid.cell, x = i * c, z = j * c;
  const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
  if (x < -halfW || x > halfW || z < -halfH || z > halfH) return true;
  if (islandBound && x * x + z * z > islandBound * islandBound) return true;
  if (gateCells.has(i + ',' + j)) return false;
  if (roadNet.cells && roadNet.cells.has(i + ',' + j)) return false;
  if (elevatorPadAt(x, z)) return false;
  const m = v._move;
  if (m.water === 'sink' && map.isDeepWater(x, z)) return true;   // sinkers route around DEEP water; shallow is fordable
  if (!m.ignoreWalls) {
    const margin = VEH_R * 0.45;
    for (const o of obstacles) {
      const dx = x - o.x, dz = z - o.z, rr = o.r + margin;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
  }
  if (m.tree === 'bump' && foliage && foliage.treeAt(x, z, VEH_R * 0.5)) return true;
  return false;
}
// Nearest open cell to (gi,gj) within `R` rings — lets us aim at a goal that sits
// inside a wall/water (snap to the closest spot the unit can actually stand).
function nearestOpenCell(v, gi, gj, R) {
  if (!cellBlocked(v, gi, gj)) return { i: gi, j: gj };
  for (let r = 1; r <= R; r++)
    for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      if (!cellBlocked(v, gi + di, gj + dj)) return { i: gi + di, j: gj + dj };
    }
  return null;
}
// Plan a cell path from the unit to `dest`; returns world waypoints [{x,z}] or null.
function planPath(v, dest) {
  const c = grid.cell;
  const start = { i: Math.round(v.holder.position.x / c), j: Math.round(v.holder.position.z / c) };
  let goal = { i: Math.round(dest.x / c), j: Math.round(dest.z / c) };
  goal = nearestOpenCell(v, goal.i, goal.j, 7) || goal;
  const iMax = Math.ceil(map.worldW / 2 / c) + 10, jMax = Math.ceil(map.worldH / 2 / c) + 10;
  const inBounds = (i, j) => i >= -iMax && i <= iMax && j >= -jMax && j <= jMax;
  const roads = roadNet.cells;
  const cost = (i, j) => {
    if (cellBlocked(v, i, j)) return Infinity;
    return roads && roads.has(i + ',' + j) ? 0.5 : 1;   // roads are the cheap lane
  };
  const path = astarGrid({ start, goal, cost, inBounds, turnPenalty: 3 });
  if (!path || path.length < 2) return null;
  return path.map(n => ({ x: n.i * c, z: n.j * c }));
}
// Maintain a unit's cached path toward `dest` and return the next waypoint to steer
// at (skips waypoints already reached). Replans on a timer, when the goal moves, or
// when the path runs out. Returns a world {x,z}, or null to fall back to direct seek.
function navWaypoint(nav, v, dest, dt) {
  nav.t -= dt;
  const moved2 = nav.dx == null ? Infinity : (dest.x - nav.dx) ** 2 + (dest.z - nav.dz) ** 2;
  const c = grid.cell;
  if (!nav.path || nav.idx >= nav.path.length || nav.t <= 0 || moved2 > (c * 2) ** 2) {
    nav.path = planPath(v, dest); nav.idx = 0; nav.t = 1.1; nav.dx = dest.x; nav.dz = dest.z;
    if (!nav.path) return null;
  }
  const px = v.holder.position.x, pz = v.holder.position.z;
  while (nav.idx < nav.path.length - 1) {
    const w = nav.path[nav.idx];
    if ((w.x - px) ** 2 + (w.z - pz) ** 2 < (c * 1.3) ** 2) nav.idx++; else break;
  }
  return nav.path[nav.idx];
}
// Steer a vehicle toward a world point: pivot in place when badly mis-aimed, else drive.
function steerToward(v, wx, wz) {
  const dx = wx - v.holder.position.x, dz = wz - v.holder.position.z;
  const err = wrapPi(Math.atan2(-dx, -dz) - v.heading);
  return { fwd: Math.abs(err) > 1.2 ? 0 : 1, turn: Math.max(-1, Math.min(1, err * 2.2)) };
}

class AICommander {
  constructor(team) {
    this.team = team;
    this.personality = randomPersonality();
    this.colorIndex = null;
    this.started = false;
    this.unit = null;
    this.respawnT = 0;
    this.deaths = 0;
    this.strategy = drawStrategy(this.personality);   // current "card" from the deck
    this.fortHp0 = null;                              // enemy fort HP when this card started
    this.seenTypes = {};                              // rival vehicle types this team has spotted
    this.knownSupplies = new Set();                   // fog-of-war: resupply POIs this team has SCOUTED
    this._rising = false; this._elev = null;          // FOB-lift deploy state
    this._exit = null; this._exitT = 0;               // post-deploy "drive out through the gate" waypoint
    this._nav = { path: null, idx: 0, t: 0, dx: null, dz: null };   // A* path cache
    this._supply = null;                              // current rearm/refuel point (for nav)
    this._stepAtDeploy = null;                        // strategy step when this unit deployed (swap only on a NEW step)
    this._recalling = false;                          // unit is driving home to be swapped (not vanished mid-field)
    this.failStreak = 0;                              // consecutive unit losses on the current plan (drives adaptive redraws)
  }

  start(colorIndex) {
    if (this.started) return;
    this.started = true;
    this.colorIndex = colorIndex;
    const accent = TEAM_COLORS[colorIndex].hex;
    for (const c of camps) if (c.team === this.team) c.setAccent(accent);
    recolorFlag(this.team, accent);
    const elev = elevators.find(e => e.team === this.team); if (elev) elev.setAccent(accent);
    this.fortHp0 = fortHpOf(this.targetTeam()) || 1;
    this.targetTurrets0 = turretCountOf(this.targetTeam());   // baseline for tower-first ordering
    this.deploy();
  }

  // --- intel the strategy cards read (all fog-of-war honest) -------------
  homePos() { return teamCenter(this.team, 'fob'); }
  targetTeam() {
    const home = teamCenter(this.team, 'fob'); let best = Infinity, t = null;
    for (const c of camps) {
      if (c.role !== 'main' || c.team === this.team) continue;
      const d = (c.center.x - home.x) ** 2 + (c.center.z - home.z) ** 2;
      if (d < best) { best = d; t = c.team; }
    }
    return t;
  }
  enemyBasePos() { return teamCenter(this.targetTeam(), 'main'); }
  flag() { return enemyFlagOf(this.team); }
  fortFrac() { return this.fortHp0 ? fortHpOf(this.targetTeam()) / this.fortHp0 : 1; }
  turretsLive() { return turretCountOf(this.targetTeam()); }
  // Tower-first: the enemy fort is "breached" (safe to send a Firebrat runner) once
  // its defensive turrets are mostly gone — not on a blind timer that walked the
  // runner into live towers. No towers to begin with → breached immediately.
  fortDown() {
    const live = this.turretsLive();
    return live === 0 || live <= (this.targetTurrets0 || 0) * 0.34;
  }
  // The enemy flag is sealed inside its HQ until that building is rubble. The
  // runner can't grab it before then, so the heavy must finish the HQ first —
  // strategy cards gate the open→grab handoff on this.
  flagExposed() { const f = this.flag(); return !!(f && f.revealed); }
  // A point just outside the enemy base's lowest-HP wall — where to punch through.
  weakestApproach() {
    const tt = this.targetTeam(), base = this.enemyBasePos();
    let best = Infinity, wx = base.x, wz = base.z;
    for (const c of camps) {
      if (c.team !== tt) continue;
      for (const w of c.walls) {
        if (!w.body || w.body.dead || (w.type && w.type.startsWith('GATE'))) continue;
        if (w.body.hp < best) { best = w.body.hp; wx = w.group.position.x; wz = w.group.position.z; }
      }
    }
    // step ~14u outward from base centre so the unit approaches the wall from outside
    const dx = wx - base.x, dz = wz - base.z, d = Math.hypot(dx, dz) || 1;
    return { x: wx + (dx / d) * 14, z: wz + (dz / d) * 14 };
  }
  counterVehicle() {
    let topType = null, topN = 0;
    for (const k in this.seenTypes) if (this.seenTypes[k] > topN) { topN = this.seenTypes[k]; topType = k; }
    return (topType && COUNTER[topType]) || 'lurcher';
  }

  // Draw a fresh card (on repeated losses / stalls) — keeps the AI unpredictable.
  redraw() { this.strategy = drawStrategy(this.personality, Math.random, this.strategy.constructor); this.fortHp0 = fortHpOf(this.targetTeam()) || this.fortHp0; this.targetTurrets0 = turretCountOf(this.targetTeam()); this.failStreak = 0; aiLog(this.team, `${this.personality.name} draws ${(this.strategy.constructor.name || 'card').replace('Strategy', '')} (new plan)`); }

  deploy() {
    const type = this.strategy.wantVehicle(this);
    this._stepAtDeploy = this.strategy.step;   // lock the type for this step — no mid-step churn
    this._recalling = false;
    aiLog(this.team, `${this.personality.name} deploys ${type}`);
    const home = this.homePos();
    const v = new Vehicle(type); v.setScale(0.72);
    v.setCamo(this.colorIndex); v.setTeamColor(TEAM_COLORS[this.colorIndex].hex);
    scene.add(v.group);
    initCombatant(v, this.team, this.colorIndex, false);
    v.ai = new Brain(this.personality);
    this.unit = v;
    // Ride up the FOB elevator like the player does — it can't leave (or shoot)
    // until the lift tops out, so neither side gets a head start (see update()).
    const elev = elevators.find(e => e.team === this.team);
    if (elev && !this._elevBusy(elev)) {
      // Face the gate it will drive out of (not just map centre) so heavies roll
      // straight through the opening instead of grinding into a corner wall.
      const ex = this._computeExit();
      const heading = ex ? Math.atan2(elev.center.x - ex.x, elev.center.z - ex.z)
                         : Math.atan2(elev.center.x, elev.center.z);
      elev.loop = false; elev.phase = 'down'; elev.t = 0;
      elev.lift.position.y = elev.bottomY;
      elev.setRider(v, heading);
      elev.start();
      this._elev = elev; this._rising = true;
      return;
    }
    // Fallback (no lift / lift busy): spawn on clear land outside the FOB.
    const obj = this.strategy.objective(this);
    const toward = Math.atan2(obj.x - home.x, obj.z - home.z);
    let sx = home.x, sz = home.z;
    for (let t = 0; t < 40; t++) {
      const a = toward + (Math.random() - 0.5) * 1.8, r = 26 + Math.random() * 20;
      const tx = home.x + Math.sin(a) * r, tz = home.z + Math.cos(a) * r;
      if (map.isLand(tx, tz) && !v._blocked(tx, tz)) { sx = tx; sz = tz; break; }
    }
    v.setPose(sx, vehicleGroundY(sx, sz), sz, toward);
  }
  _elevBusy(elev) { return elev.rider && elev.rider !== this.unit; }

  // A GROUND unit is boxed in by the FOB walls — the only way out is a gate. Pick the
  // gate nearest the objective and return a waypoint ~16u beyond it. Flyers (Valkyrie)
  // clear walls, so no exit plan. Used to FACE the unit at the gate on deploy AND as
  // the drive-out waypoint after it tops — so heavies stop "dancing on the elevator".
  _computeExit() {
    const v = this.unit; if (!v || v._move.ignoreWalls) return null;
    const fob = teamCamp(this.team, 'fob'); if (!fob) return null;
    const gates = fob.walls.filter(w => w.type && w.type.startsWith('GATE'));
    if (!gates.length) return null;
    const obj = this.strategy.objective(this);
    let best = null, bestD = Infinity;
    for (const g of gates) {
      const gx = g.group.position.x, gz = g.group.position.z;
      const d = (gx - obj.x) ** 2 + (gz - obj.z) ** 2;
      if (d < bestD) { bestD = d; best = { x: gx, z: gz }; }
    }
    const dx = best.x - fob.center.x, dz = best.z - fob.center.z, m = Math.hypot(dx, dz) || 1;
    return { x: best.x + dx / m * 16, z: best.z + dz / m * 16 };
  }
  _planExit() { this._exit = this._computeExit(); this._exitT = this._exit ? 8 : 0; }

  // Snapshot for the AI log overlay + an event when the unit changes its mind.
  _logTick(v, view, cmd) {
    const fob = teamCenter(this.team, 'fob');
    const prev = this._dbg && this._dbg.state;
    // Visible siege progress: shout when an enemy tower falls, and when the last one
    // does (defenses clear → time to crack the HQ). Tracked on the commander so it
    // survives unit deaths/swaps mid-siege.
    const liveTowers = this.turretsLive();
    if (this._lastTowers == null) this._lastTowers = liveTowers;
    if (liveTowers < this._lastTowers) {
      aiLog(this.team, liveTowers === 0
        ? `${this.personality.name}: enemy towers CLEAR — breaching HQ`
        : `${this.personality.name}: tower down — ${liveTowers} enemy towers left`);
      this._lastTowers = liveTowers;
    } else if (liveTowers > this._lastTowers) { this._lastTowers = liveTowers; }   // match reset
    this._dbg = {
      name: this.personality.name, type: v.type, state: cmd.state,
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +cmd.fwd.toFixed(2), turn: +cmd.turn.toFixed(2),
      blk: (view.blockedLeft ? 'L' : '·') + (view.blockedAhead ? 'A' : '·') + (view.blockedRight ? 'R' : '·'),
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel),
      distFob: Math.round(Math.hypot(v.holder.position.x - fob.x, v.holder.position.z - fob.z)),
      towers: this.turretsLive(),   // enemy turrets still standing (tower-first ordering)
    };
    if (cmd.state !== prev) {
      let why = '';
      if (cmd.state === 'retreat') why = ` (hp ${Math.round(v.hp / v.maxHp * 100)}%)`;
      else if (cmd.state === 'resupply') why = v.ammo <= 0 ? ' (out of ammo)' : ` (fuel ${Math.round(v.fuel / v.maxFuel * 100)}%)`;
      else if (cmd.state === 'suppress') {
        const inPos = view.threatStand && Math.hypot(view.threatStand.x - v.holder.position.x, view.threatStand.z - v.holder.position.z) <= 6;
        why = inPos ? ` (shelling tower — ${this.turretsLive()} left)` : ' (skirting to isolate a tower)';
      }
      else if (cmd.state === 'engage') why = ' (enemy in sight)';
      else if (cmd.state === 'assault') why = ` (sieging, ${this.turretsLive()} towers left)`;
      aiLog(this.team, `${this.personality.name} ${v.type}: ${cmd.state}${why}`);
    }
  }

  // Path-follow the long-haul TRAVEL states with A* (advance to the objective, run
  // home to resupply/retreat, close to siege standoff). Combat (engage/suppress),
  // the gate exit, and the unstick reflex keep their own tuned steering. Flyers go
  // straight. Falls back to the brain's seek when there's no route.
  _navOverride(v, view, cmd, dt) {
    if (v._move.ignoreWalls) return;
    const st = cmd.state;
    let dest = null, slack = 9;
    if (st === 'exit') { dest = this._exit || this.strategy.objective(this); slack = 5; }   // thread the gate via A*
    else if (st === 'advance') dest = this.strategy.objective(this);
    else if (st === 'pursue') dest = v.ai.lastSeen || this.strategy.objective(this);
    else if (st === 'retreat') dest = this._home;          // heal at own base (only place HP regens)
    else if (st === 'resupply') dest = this._supply;       // nearest fuel/ammo (own base or a depot)
    else if (st === 'assault') { dest = this.strategy.objective(this); slack = (view.engageRange || 36) * 0.7 * 1.25; }
    else return;   // engage / suppress / unstick — leave the steering as-is
    if (!dest) return;
    const d2 = (dest.x - v.holder.position.x) ** 2 + (dest.z - v.holder.position.z) ** 2;
    if (d2 < slack * slack) return;                 // close enough — hand back to the behavior
    const wp = navWaypoint(this._nav, v, dest, dt);
    if (!wp) return;                                // no route — keep the brain's command
    const s = steerToward(v, wp.x, wp.z);
    cmd.fwd = s.fwd; cmd.turn = s.turn;
    v.ai._wantMove = s.fwd > 0.3;                   // keep the anti-wedge motion check honest
  }

  // Decide whether to change the deployed vehicle. We only do this on a DELIBERATE
  // strategy beat — when the card advances to a new step (e.g. open -> grab = "the
  // fort's down, send the runner"). Per-tick counter-pick wobble no longer triggers a
  // swap, which was the churn that made units blink out. And instead of vanishing the
  // unit, we flag it to DRIVE HOME and get swapped at base (see _driveHome).
  _maybeRecall() {
    if (!this.unit || this._recalling) return;
    if (this.strategy.step === this._stepAtDeploy) return;          // same beat → keep the current unit
    const want = this.strategy.wantVehicle(this);
    this._stepAtDeploy = this.strategy.step;                        // consume the step change either way
    if (this.unit.type === want) return;                           // new beat wants the same vehicle → carry on
    this._recalling = true; this._recallT = 22;                    // backstop: give up the trip after 22s
    this._nav.path = null;                                          // replan toward home
    aiLog(this.team, `${this.personality.name} pulls ${this.unit.type} home to swap for ${want}`);
  }

  // Drive a recalled unit back to its FOB, then despawn it quietly (no explosion) so
  // the next deploy rolls out the wanted vehicle — a clean role change, not a suicide.
  _driveHome(dt) {
    const v = this.unit;
    this.strategy.tick(this, dt);
    applyAltitude(v, dt); decayAim(v, dt); v.cooldown -= dt;
    if (v.dead) { this.unit = null; this._recalling = false; this.respawnT = 3; return; }
    const home = teamCenter(this.team, 'fob');
    const d = Math.hypot(v.holder.position.x - home.x, v.holder.position.z - home.z);
    const reach = (this._elev ? this._elev.padHalf : 8) + 5;
    this._recallT -= dt;
    if (d < reach || this._recallT <= 0) {
      aiLog(this.team, `${this.personality.name} ${v.type} ${d < reach ? 'home — swapping' : 'recall timed out — swapping'}`);
      removeCombatant(v); scene.remove(v.group); this.unit = null; this._recalling = false; this.respawnT = 1.0;
      return;
    }
    const wp = navWaypoint(this._nav, v, home, dt) || home;
    const s = steerToward(v, wp.x, wp.z);
    const out = burnFuel(v, { fwd: s.fwd, turn: s.turn }, dt);
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6);
    v.drive(dt, out.fwd, out.turn, null, v._blocked);
    v.ai._wantMove = s.fwd > 0.3;
    this._dbg = {
      name: this.personality.name, type: v.type, state: 'return-to-base',
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +s.fwd.toFixed(2), turn: +s.turn.toFixed(2), blk: '···',
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel), distFob: Math.round(d),
      towers: this.turretsLive(),
    };
  }

  update(dt) {
    if (!this.unit || this.unit.dead) {
      if (this.unit && this.unit.dead) {
        this.deaths++;
        this.failStreak = (this.failStreak || 0) + 1;
        // A runner died storming the base → the approach isn't safe yet. Go BACK to
        // softening (send a heavy to finish the towers) instead of feeding another
        // Firebrat into the exact same death.
        if (this.unit.type === 'firebrat' && this.strategy.step === 'grab') {
          this.strategy.step = 'open'; this.strategy.t = 0;
          this.targetTurrets0 = turretCountOf(this.targetTeam());
          aiLog(this.team, `${this.personality.name} runner down — re-softening (towers still up)`);
        }
        // Keep losing the same way? Each repeat raises the odds of a brand-new plan.
        if (Math.random() < Math.min(0.85, 0.25 + this.failStreak * 0.2)) this.redraw();
      }
      this.unit = null;
      this._rising = false; this._recalling = false;
      this.respawnT -= dt;
      if (this.started && this.respawnT <= 0) { this.respawnT = 4 + Math.random() * 3; this.deploy(); }
      return;
    }
    // Still riding the FOB lift up? Hold (no driving/firing) until it tops, then
    // detach so the brain takes the wheel — mirrors the player's deploy handover.
    if (this._rising) {
      if (this._elev && this._elev.rider === this.unit && this._elev.phase === 'top') {
        this._elev.rider = null; this._rising = false;
        this._planExit();   // ground units must aim at a GATE and drive out before pursuing
      } else { return; }
    }
    if (this._recalling) { this._driveHome(dt); return; }   // heading back to base to swap
    this.strategy.tick(this, dt);
    this._maybeRecall();
    if (this._recalling) return;   // just started the trip home
    const v = this.unit;
    if (!v) return;
    const view = this._view(v, dt);
    const cmd = v.ai.think(view);
    this._navOverride(v, view, cmd, dt);   // route travel states with A* (around water/trees, through gates)
    this._logTick(v, view, cmd);
    const out = burnFuel(v, { fwd: cmd.fwd, turn: cmd.turn }, dt);
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6);   // for spatial engine RPM
    v.drive(dt, out.fwd, out.turn, null, v._blocked);
    applyAltitude(v, dt);
    decayAim(v, dt);
    if (v.dead) { this.unit = null; this.respawnT = 4; this._rising = false; return; }
    v.cooldown -= dt;
    // Fire at the current target: a suppressed wall-turret (aimed at its raised head
    // so the slug arcs up), else the spotted rival, else straight ahead.
    if (cmd.fire && v.cooldown <= 0) {
      let tp = null;
      if (cmd.state === 'suppress' && view.threat) tp = _aimDir.set(view.threat.x, view.threat.y, view.threat.z).clone();
      else if (view.enemy) tp = _aimDir.set(view.enemy.x, view.enemy.y, view.enemy.z).clone();
      fireVehicle(v, false, tp);
    }
  }

  _view(v, dt) {
    const px = v.holder.position.x, pz = v.holder.position.z, h = v.heading;
    const flyer = v._move.ignoreWalls;
    let seesEnemy = false, enemy = null, seen = null, best = AI_VISION * AI_VISION;
    for (const o of combatants) {                       // nearest VISIBLE rival of any other team
      if (o.dead || o.team === this.team) continue;
      const d = (o.holder.position.x - px) ** 2 + (o.holder.position.z - pz) ** 2;
      if (d < best && (flyer || hasLOS(px, pz, o.holder.position.x, o.holder.position.z))) {
        best = d; enemy = { x: o.holder.position.x, y: o.holder.position.y, z: o.holder.position.z, type: o.type, shield: o.shield }; seen = o; seesEnemy = true;
      }
    }
    // Fog-of-war intel: remember what the enemy keeps fielding so counterVehicle() works.
    if (seen) this.seenTypes[seen.type] = (this.seenTypes[seen.type] || 0) + 1;
    // DISCOVER nearby supply points — the team only "knows" a depot once one of its
    // units has come within sight of it (LOS for ground units; flyers see over walls).
    // Discoveries are remembered on the commander, so the team keeps the intel even
    // after this unit dies and a new one deploys.
    for (const rp of resupplies) {
      if (rp.dead || this.knownSupplies.has(rp)) continue;
      const d2 = (rp.pos.x - px) ** 2 + (rp.pos.z - pz) ** 2;
      if (d2 < AI_VISION * AI_VISION && (flyer || hasLOS(px, pz, rp.pos.x, rp.pos.z))) this.knownSupplies.add(rp);
    }
    const goal = this.strategy.objective(this);
    // Where to rearm/refuel: the NEAREST valid source for what we need — own base
    // (always known) OR a DISCOVERED neutral fuel/ammo supply point. Out of ammo is
    // the priority (head for ammo); otherwise top up the low tank.
    const fob = teamCamp(this.team, 'fob'), home = teamCamp(this.team, 'main');
    const needAmmo = v.ammo <= 0;
    const wantKind = needAmmo ? 'ammo' : 'fuel';
    let supply = null, bestD = Infinity;
    const consider = (x, z) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < bestD) { bestD = d; supply = { center: { x, z } }; } };
    if (fob) consider(fob.center.x, fob.center.z);
    if (home) consider(home.center.x, home.center.z);
    for (const rp of resupplies) if (!rp.dead && rp.kind === wantKind && this.knownSupplies.has(rp)) consider(rp.pos.x, rp.pos.z);
    this._supply = supply ? { x: supply.center.x, z: supply.center.z } : null;   // nav target while resupplying
    // HEAL home: HP only regenerates at an OWN base (a neutral fuel/ammo depot can't
    // patch the hull) — so a hurt unit must fall back HERE, not to the nearest depot,
    // or it camps a fuel tank forever waiting for health that never comes.
    let healHome = null, healD = Infinity;
    const considerHome = (x, z) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < healD) { healD = d; healHome = { x, z }; } };
    if (fob) considerHome(fob.center.x, fob.center.z);
    if (home) considerHome(home.center.x, home.center.z);
    this._home = healHome;
    // Post-deploy: drive OUT through the gate first. mustGo forces the brain to head
    // straight for the exit waypoint (no engaging/firing) until it clears the gate.
    let mustGo = false;
    if (this._exit) {
      this._exitT -= dt;
      const dd = (px - this._exit.x) ** 2 + (pz - this._exit.z) ** 2;
      if (dd < 8 * 8 || this._exitT <= 0) this._exit = null;   // cleared the gate (or timed out)
      else mustGo = true;
    }
    // The nearest LIVE enemy wall-turret this unit can actually SHOOT — sensed wide
    // (TURRET_SENSE) so heavies snipe from outside the towers' own range, but ONLY
    // counted if there's a clear line to it. That LOS gate is the key: a unit no
    // longer wastes shots hammering the front wall trying to hit a tower behind it —
    // it picks the tower it can see (a near/flank corner), and as that one dies the
    // line to the next opens up. `flankSide` nudges the approach around to the side
    // instead of charging straight into the gap between two towers (see AI.js).
    let threat = null, threatD = TURRET_SENSE * TURRET_SENSE, threatCamp = null;
    for (const c of camps) {
      if (c.team === this.team) continue;
      for (const w of c.walls) {
        const t = w.turret;
        if (!t || t.dead || t.falling) continue;
        t.group.updateWorldMatrix(true, false);
        t.head.getWorldPosition(_threatV);
        const d = (_threatV.x - px) ** 2 + (_threatV.z - pz) ** 2;
        if (d < threatD) { threatD = d; threat = { x: _threatV.x, y: _threatV.y, z: _threatV.z }; threatCamp = c; }
      }
    }
    // Is there a CLEAR shot at the nearest tower, and which way to peel around it?
    // `threatLOS` lets the brain hold + fire when it can see the tower, or swing wide
    // to the flank (rather than hammer the wall in front of it) when it can't. The
    // cross product of (base→tower) × (tower→unit) picks the nearer side to arc to.
    let flankSide = 0, threatLOS = false, threatStand = null;
    if (threat) {
      threatLOS = flyer || hasLOS(px, pz, threat.x, threat.z);
      if (threatCamp) {
        const bx = threat.x - threatCamp.center.x, bz = threat.z - threatCamp.center.z;
        const ux = px - threat.x, uz = pz - threat.z;
        flankSide = (bx * uz - bz * ux) >= 0 ? 1 : -1;
        // The one-gun-at-a-time spot: radially OUTSIDE the base through this turret,
        // at the type's hold range — far from the OTHER corner turrets' fire arcs.
        const om = Math.hypot(bx, bz) || 1;
        const hold = TURRET_HOLD[v.type] || (ENGAGE_RANGE[v.type] || 36) * 0.9;
        threatStand = { x: threat.x + (bx / om) * hold, z: threat.z + (bz / om) * hold };
      }
    }
    const fx = -Math.sin(h), fz = -Math.cos(h), lx = -Math.sin(h + 0.6), lz = -Math.cos(h + 0.6),
          rx = -Math.sin(h - 0.6), rz = -Math.cos(h - 0.6), P = 9;
    return {
      dt,
      self: { x: px, z: pz, heading: h, type: v.type, shield: v.shield, hpFrac: v.hp / v.maxHp, fuelFrac: v.fuel / v.maxFuel, ammoFrac: v.ammo / v.maxAmmo },
      seesEnemy, enemy,
      threat, threatLOS, flankSide, threatStand, engageRange: ENGAGE_RANGE[v.type] || 36,
      goal: mustGo ? this._exit : goal,
      mustGo,
      resupply: supply ? { x: supply.center.x, z: supply.center.z } : goal,
      home: healHome || goal,
      shootGoal: this.strategy.shoot(this), arriveDist: this.strategy.arriveDist(this),
      blockedAhead: v._blocked(px + fx * P, pz + fz * P),
      blockedLeft: v._blocked(px + lx * P, pz + lz * P),
      blockedRight: v._blocked(px + rx * P, pz + rz * P),
    };
  }
}

// Create an AICommander for every AI-controlled team (called at field build).
function setupCommanders() {
  commanders.length = 0;
  if (QS.has('noai')) return;
  const teamIds = [...new Set(camps.filter(c => c.role === 'main').map(c => c.team))];
  for (const t of teamIds) if (TEAM_CTRL[t] === 'ai') commanders.push(new AICommander(t));
  // If no human is playing (e.g. AI-vs-AI spectate), kick everyone off immediately.
  if (!teamIds.some(t => TEAM_CTRL[t] === 'human')) startCommanders(null);
}
// Assign each un-started AI commander a colour distinct from those already taken
// (the human's pick is reserved), then deploy it.
function startCommanders(reservedColorIndex) {
  const used = new Set(); if (reservedColorIndex != null) used.add(reservedColorIndex);
  for (const cmd of commanders) {
    if (cmd.started) continue;
    let idx = pickFreeColor(used); used.add(idx);
    cmd.start(idx);
  }
}
function pickFreeColor(used) {
  const free = [];
  for (let i = 0; i < TEAM_COLORS.length; i++) if (!used.has(i)) free.push(i);
  const pool = free.length ? free : [...TEAM_COLORS.keys()];
  return pool[(Math.random() * pool.length) | 0];
}
function updateCommanders(dt) { for (const cmd of commanders) cmd.update(dt); updateFlags(dt); }

// Brief on-screen toast (flag captures, etc.).
function showBanner(text, opts = {}) {
  let el = document.getElementById('banner');
  if (!el) {
    el = document.createElement('div'); el.id = 'banner';
    el.style.cssText = 'position:fixed;top:18%;left:50%;transform:translateX(-50%);z-index:200;' +
      'font-family:"Courier New",monospace;font-weight:bold;letter-spacing:3px;' +
      'color:#fff;background:rgba(10,14,20,0.78);padding:14px 26px;border:1px solid rgba(255,255,255,0.35);' +
      'border-radius:6px;text-shadow:0 2px 4px rgba(0,0,0,0.6);pointer-events:none;transition:opacity 0.4s;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.opacity = '1';
  el.style.fontSize = opts.big ? '46px' : '22px';
  el.style.color = opts.color || '#fff';
  clearTimeout(showBanner._t);
  if (!opts.persist) showBanner._t = setTimeout(() => { el.style.opacity = '0'; }, opts.ms || 2600);
}

// --- Victory / Defeat cinematic ----------------------------------------
// The win is the player Firebrat riding the stolen flag down the FOB lift. Over
// that live descent we rain team-colour confetti and pop a big VICTORY! title;
// a rival capture pops DEFEAT instead. Pure DOM overlay — no extra render passes.
// TEAM_COLORS[i].hex is already a CSS string ('#rrggbb').
function teamColor(team) {
  if (team === PLAYER_TEAM) return TEAM_COLORS[playerColorIndex] ? TEAM_COLORS[playerColorIndex].hex : '#ffffff';
  const cmd = commanders.find(c => c.team === team && c.colorIndex != null);
  return cmd && TEAM_COLORS[cmd.colorIndex] ? TEAM_COLORS[cmd.colorIndex].hex : '#ffffff';
}
function ensureCelebStyle() {
  if (document.getElementById('celeb-style')) return;
  const s = document.createElement('style'); s.id = 'celeb-style';
  s.textContent = `
    #celeb-title { position:fixed; top:30%; left:50%; transform:translate(-50%,-50%) scale(0.4);
      z-index:300; font-family:"Courier New",monospace; font-weight:bold; letter-spacing:8px;
      font-size:84px; opacity:0; pointer-events:none; white-space:nowrap; text-align:center;
      text-shadow:0 4px 20px rgba(0,0,0,0.85); transition:opacity .45s ease, transform .6s cubic-bezier(.2,1.35,.4,1); }
    #celeb-title.in { opacity:1; transform:translate(-50%,-50%) scale(1); }
    #celeb-title .sub { display:block; margin-top:16px; font-size:21px; letter-spacing:5px; opacity:.85; color:#dfe8ef; }
    .confetti { position:fixed; top:-24px; width:10px; height:16px; z-index:290; pointer-events:none; will-change:transform; }
    @keyframes confetti-fall { to { transform:translateY(115vh) rotateZ(720deg); } }`;
  document.head.appendChild(s);
}
function showCelebTitle(text, color, sub) {
  ensureCelebStyle();
  let t = document.getElementById('celeb-title');
  if (!t) { t = document.createElement('div'); t.id = 'celeb-title'; document.body.appendChild(t); }
  t.style.color = color;
  t.innerHTML = text + (sub ? `<span class="sub">${sub}</span>` : '');
  t.classList.remove('in'); void t.offsetWidth;   // restart the pop-in transition
  requestAnimationFrame(() => t.classList.add('in'));
}
function hideCelebTitle() { const t = document.getElementById('celeb-title'); if (t) t.classList.remove('in'); }
// Rain confetti in (mostly) the team colour with a couple of bright accents. One
// staggered burst (per-piece CSS animation-delay) rather than a timer, so the rain
// can't be throttled away when the tab/render loop is busy.
function rainConfetti(color, durationMs = 5000) {
  ensureCelebStyle();
  const palette = [color, color, color, '#ffffff', '#ffd24a'];
  const secs = durationMs / 1000, N = Math.round(durationMs / 60);
  for (let i = 0; i < N; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.background = palette[(Math.random() * palette.length) | 0];
    if (Math.random() < 0.5) c.style.borderRadius = '50%';
    c.style.opacity = (0.75 + Math.random() * 0.25).toFixed(2);
    const dur = 2.4 + Math.random() * 1.9, delay = Math.random() * secs;
    c.style.animation = `confetti-fall ${dur.toFixed(2)}s linear ${delay.toFixed(2)}s forwards`;
    document.body.appendChild(c);
    setTimeout(() => c.remove(), (delay + dur) * 1000 + 80);
  }
}
function clearCeleb() {
  hideCelebTitle();
  document.querySelectorAll('.confetti').forEach(c => c.remove());
}
function playVictory(team) { const c = teamColor(team); rainConfetti(c, 6000); showCelebTitle('VICTORY!', c, 'FLAG SECURED'); }
function playDefeat() { clearCeleb(); showCelebTitle('DEFEAT', '#ff6a6a', 'FLAG LOST'); }

// --- AI decision log (debug overlay) --------------------------------------
// An on-screen window into what each AI commander is THINKING — live per-unit
// status + a rolling event feed. Built for phone debugging (no console). Toggle
// with the 'L' key or ?ailog; on by default while spectating AI-vs-AI.
let aiLogOn = QS.has('ailog') || SPECTATE;
const aiEvents = [];   // rolling [{t, team, msg}]
const _t0 = performance.now();
function aiLog(team, msg) {
  aiEvents.push({ t: (performance.now() - _t0) / 1000, team, msg });
  while (aiEvents.length > 18) aiEvents.shift();
}
function ensureAiLogEl() {
  let el = document.getElementById('ai-log');
  if (el) return el;
  el = document.createElement('div'); el.id = 'ai-log';
  // Fixed width (not max-width) so the box doesn't resize/jitter as the text changes;
  // overflow clipped + tabular digits keep the columns from dancing.
  el.style.cssText = 'position:fixed;top:14px;right:12px;z-index:150;pointer-events:none;' +
    'font-family:"Courier New",monospace;font-size:11px;line-height:1.45;letter-spacing:0.5px;' +
    'color:#dfe8ef;background:rgba(8,12,18,0.72);padding:8px 10px;border:1px solid rgba(255,255,255,0.18);' +
    'border-radius:5px;width:330px;max-width:80vw;max-height:90vh;overflow:hidden;white-space:pre;' +
    'font-variant-numeric:tabular-nums;text-shadow:0 1px 2px rgba(0,0,0,0.8);';
  document.body.appendChild(el);
  return el;
}
function updateAiLog() {
  const el = document.getElementById('ai-log');
  if (!aiLogOn) { if (el) el.style.display = 'none'; return; }
  const box = ensureAiLogEl(); box.style.display = '';
  let html = '<b>AI LOG</b>  (L to hide)\n';
  for (const cmd of commanders) {
    const d = cmd._dbg;
    const col = TEAM_ACCENT[cmd.team] || '#aaa';
    if (!d) { html += `<span style="color:${col}">${cmd.team}</span> — deploying…\n`; continue; }
    html += `<span style="color:${col}">${d.name} ${d.type}</span> ${d.card}  enemyTwrs:${d.towers}\n`;
    html += `  ${d.state}  blk:${d.blk}  f/t:${d.fwd}/${d.turn}\n`;
    html += `  hp:${d.hp}% ammo:${d.ammo} fuel:${d.fuel}  fob:${d.distFob}u\n`;
  }
  html += '<span style="opacity:0.55">────────────</span>\n';
  for (let i = aiEvents.length - 1; i >= 0; i--) {
    const e = aiEvents[i], col = TEAM_ACCENT[e.team] || '#aaa';
    html += `<span style="opacity:0.8">${e.t.toFixed(0)}s</span> <span style="color:${col}">${e.msg}</span>\n`;
  }
  box.innerHTML = html;
}

// A flag was carried home → that team wins. Freeze the field, announce, then reset
// (human → back to the garage for a fresh run; AI-vs-AI → re-arm the flags + play on).
function endMatch(winner) {
  if (matchOver) return;
  matchOver = true;
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const won = winner === PLAYER_TEAM;
  if (!human) { playVictory(winner); showCelebTitle(`${winner.toUpperCase()} WINS`, teamColor(winner)); }
  else if (won) playVictory(PLAYER_TEAM);   // a non-extraction win (e.g. AI ally caps) still celebrates
  else playDefeat();
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* quiet the engine */ }
  setTimeout(() => {
    const el = document.getElementById('banner'); if (el) el.style.opacity = '0';
    if (human) { if (player && playerElev) { leftPad = true; beginReturn(); } else returnToGarage(); }
    else { clearCeleb(); for (const f of flags) f.group.position.set(f.home.x, f.home.y, f.home.z); matchOver = false; }   // AI-vs-AI plays on
  }, 5000);
}

// Line of sight: blocked if any wall obstacle straddles the segment a→b.
function hasLOS(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz) || 1;
  const steps = Math.ceil(len / 4);
  for (let s = 1; s < steps; s++) {
    const t = s / steps, x = ax + dx * t, z = az + dz * t;
    for (const o of obstacles) {
      const ox = x - o.x, oz = z - o.z;
      if (ox * ox + oz * oz < o.r * o.r) return false;
    }
  }
  return true;
}

// --- Collision ---------------------------------------------------------
// Solid wall pieces the player can't drive through (gates excluded — drive-through).
let obstacles = [];           // { x, z, r }
const gateCells = new Set();  // grid cells the A* navigator treats as always-open (gate corridors)
let islandBound = 0;          // radius (from map centre) past which no vehicle may go
function buildObstacles() {
  obstacles = [];
  gateCells.clear();
  const c0 = grid.cell;
  for (const c of camps) for (const w of c.walls) {
    if (w.type && w.type.startsWith('GATE')) {
      // Carve a passable corridor through the opening: the gate cell + a few cells
      // along its outward normal (in/out), so A* can thread the gap the inflated
      // wall obstacles would otherwise seal.
      const gx = w.group.position.x, gz = w.group.position.z;
      const gi = Math.round(gx / c0), gj = Math.round(gz / c0);
      const dx = gx - c.center.x, dz = gz - c.center.z;
      const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
      const sz = Math.abs(dx) >= Math.abs(dz) ? 0 : Math.sign(dz);
      for (let k = -2; k <= 2; k++) gateCells.add((gi + sx * k) + ',' + (gj + sz * k));
      continue;
    }
    obstacles.push({ x: w.group.position.x, z: w.group.position.z,
                     r: w.type === 'CORNER' ? grid.cell * 0.7 : grid.cell * 0.5 });
  }
  // Soft world edge: a ring ~70u beyond the outermost base. Keeps flyers (which
  // cross water) from wandering off the island into open ocean / the void. Land
  // craft already drown in the sea well before this. (See the ocean-submarine TODO.)
  let maxCamp = 0;
  for (const c of camps) maxCamp = Math.max(maxCamp, Math.hypot(c.center.x, c.center.z));
  islandBound = maxCamp + 70;
}

const VEH_R = 3.0;            // vehicle collision radius (vs walls/trees)
// Water no longer hard-blocks: hover/fly craft cross it, land craft enter and sink
// (see applyAltitude). blockedFor(move) builds a per-vehicle predicate; this is a
// land-vehicle default kept for the debug API.
const _landBlocked = blockedFor({ cruise: 0, ignoreWalls: false, water: 'sink', tree: 'crush' });
function blockedAt(x, z) { return _landBlocked(x, z); }

// The single player-controlled vehicle, driven with WASD / the touch joystick
// (migrated from the Vehicle Designer; Vehicle.drive() does the integration).
let player = null;
let playerElev = null;        // the lift it deploys from
let driving = false;          // true once control is handed to the player
let returning = false;        // true while the parked vehicle lowers back to base
let parkT = 0;                // dwell timer for "parked on own pad" detection
let leftPad = false;          // must drive OFF the pad before parking can return it
const _follow = new THREE.Vector3();

// Put the player's vehicle on their FOB. rise=true → starts in the pit and rides
// up, with control handed over when it tops; rise=false → already on the surface,
// drive immediately. The chosen colour becomes the whole player team's colour.
function deployToFOB(type, colorIndex, rise) {
  matchOver = false;               // fresh run
  playerColorIndex = colorIndex;   // tints this vehicle's projectiles
  const accent = TEAM_COLORS[colorIndex].hex;
  for (const c of camps) if (c.team === PLAYER_TEAM) c.setAccent(accent);
  recolorFlag(PLAYER_TEAM, accent);
  playerElev = elevators.find(e => e.team === PLAYER_TEAM) || null;
  const cx = playerElev ? playerElev.center.x : 0;
  const cz = playerElev ? playerElev.center.z : 0;
  const heading = Math.atan2(cx, cz);   // face the map centre (model front = -Z)

  const v = new Vehicle(type);
  v.setScale(0.72);
  v.setCamo(colorIndex);
  v.setTeamColor(accent);

  if (playerElev) playerElev.setAccent(accent);
  if (rise && playerElev) {
    playerElev.loop = false;
    playerElev.phase = 'down';
    playerElev.t = 0;
    playerElev.lift.position.y = playerElev.bottomY;
    playerElev.setRider(v, heading);
    playerElev.start();
    driving = false;            // control hands over at the top (see driveUpdate)
  } else {
    v.setPose(cx, vehicleGroundY(cx, cz), cz, heading);
    driving = true;
  }
  scene.add(v.group);
  player = v;
  initCombatant(v, PLAYER_TEAM, colorIndex, true);
  updatePlayerHud();
  startCommanders(colorIndex);   // AI teams pick remaining colours + deploy in response
  leftPad = false;            // must drive off the pad before a park can return it
  parkT = 0;

  orbit.target.set(cx, 0, cz);
  orbit.dist = 64; orbit.pitch = 0.9;
  updateCamera();
}

// Forward/turn in [-1, 1]. Touch: steer toward the held finger (point-to-steer).
// Keyboard (desktop): WASD/arrows, the classic tank turn + throttle.
function driveInput() {
  if (touchSteer && player && !player.dead) {
    const t = pickWorldPoint(touchSteer.x, touchSteer.y);
    if (t) {
      const hp = player.holder.position;
      const dx = t.point.x - hp.x, dz = t.point.z - hp.z;
      const distXZ = Math.hypot(dx, dz);
      const aim = Math.atan2(-dx, -dz);                 // heading whose front (-Z) points at the finger
      const err = wrapPi(aim - player.heading);
      const turn = Math.max(-1, Math.min(1, err * 2.4));
      // Pivot in place when badly mis-aimed (>~75°) so we don't arc wide; otherwise
      // drive forward, easing to a stop once the finger sits on the vehicle.
      const fwd = Math.abs(err) > 1.3 ? 0 : (distXZ < TOUCH_STOP_R ? 0 : 1);
      return { fwd, turn };
    }
  }
  const fwd  = (keys['w'] || keys['arrowup']   ? 1 : 0) - (keys['s'] || keys['arrowdown']  ? 1 : 0);
  const turn = (keys['a'] || keys['arrowleft'] ? 1 : 0) - (keys['d'] || keys['arrowright'] ? 1 : 0);
  return { fwd, turn };
}

// Drive the player vehicle and track the camera on it. Returns true if it drove
// (so the caller skips the free-camera pan). Hands control over once the deploy
// lift tops out.
function driveUpdate(dt) {
  if (playerElev && player && playerElev.rider === player && playerElev.phase === 'top') {
    playerElev.rider = null;   // detach so drive() owns the transform
    driving = true;
  }
  if (!driving || !player || player.dead) return false;
  const inp = matchOver ? { fwd: 0, turn: 0 } : driveInput();   // controls freeze on win
  const out = burnFuel(player, inp, dt);    // no fuel → engine dead, can't move
  player.drive(dt, out.fwd, out.turn, null, player._blocked);
  applyAltitude(player, dt);                // altitude / water flooding / tree crush
  if (!player || player.dead) return true;  // sank/destroyed this frame → bail before touching it
  aimPlayerTurret(player, dt);              // turret continuously follows the aim cursor
  if (sound) sound.update(out.fwd, out.turn);   // rev the engine RPM with throttle (idle ↔ max)
  fireCooldown -= dt;
  if (!matchOver && fireHeld && fireCooldown <= 0) firePlayer();   // hold to auto-fire at the crosshair
  _follow.set(player.holder.position.x, 0, player.holder.position.z);
  orbit.target.lerp(_follow, 0.12);
  updateCamera();

  // Park on your own FOB pad (centred + stopped for a moment) → lower it / return.
  // Must drive OFF the pad first, so the deploy spawn point doesn't instantly return.
  if (playerElev && !returning) {
    const dist = Math.hypot(player.holder.position.x - playerElev.center.x,
                            player.holder.position.z - playerElev.center.z);
    if (dist > playerElev.padHalf * 1.3) leftPad = true;
    if (leftPad && dist < playerElev.padHalf * 0.7 && inp.fwd === 0 && inp.turn === 0) {
      parkT += dt;
      if (parkT > 0.5) beginReturn();
    } else {
      parkT = 0;
    }
  }
  return true;
}

function rebuild(patch) {
  map.generate(patch);
  placeCamps();
  buildRoads();
  scatterFoliage();
  scaleScene();      // keep fog/far in sync, but DON'T move the camera
  updateCamera();
}

// Scale fog + far plane + sun to the map size so big maps don't fog out.
// Does NOT touch the camera distance/target — your view stays put on rebuild.
function scaleScene() {
  const span = Math.max(map.worldW, map.worldH);
  zoomMax = span * 1.6;
  scene.fog.near = span * 0.7;
  scene.fog.far = span * 1.6;
  camera.far = span * 3 + 200;
  camera.updateProjectionMatrix();
  sun.position.set(span * 0.25, span * 0.5, span * 0.2);
}

// Initial camera framing — only used once, on load.
function frameMap() {
  scaleScene();
  orbit.dist = Math.max(map.worldW, map.worldH) * 0.85;
  updateCamera();
}

let sound = null;   // procedural engine/gun synth; declared before the field-init block below uses it

if (!GARAGE) {
  map.generate(GEN_OPTS);
  scene.add(map.group);
  placeCamps();
  buildRoads();
  if (!SHOT || SHOT_FOL) scatterFoliage();
  frameMap();
  fieldBuilt = true;
  onField = true;
  ensureDeployFade();   // needed for the lower→garage fade on the first return
  setFieldUI(true);     // reveal the touch drive stick + fire button
  setupCommanders();    // stand up AI teams (deploys now if there's no human)
  // No garage flow here, so drop the human's vehicle straight onto their FOB,
  // already on the surface and driveable (WASD / touch). ?noveh / all-AI skip it.
  if (TEAM_CTRL[PLAYER_TEAM] === 'human' && !QS.has('noveh')) {
    deployToFOB(FOB_RIDER[PLAYER_TEAM], TEAM_CAMO[PLAYER_TEAM], false);
  }
  // Stand up the spatial engine bus now; it stays silent until a tap arms the
  // AudioContext (armFieldAudio) — covers AI-vs-AI spectating with no deploy.
  ensureSound().setSpatialActive(true);
}

// Underground garage (Phase A + sandbox). Lives in its own scene/camera, rendered
// instead of the field when ?garage is set. Tab cycles the selected vehicle;
// rendered instead of the field when ?garage is set. Phase B: pick a vehicle TYPE
// — ←/→ (or A/D) cycle the four types, 1-4 jump straight to one, or click a
// vehicle to select its type. Each highlights that type's deploy vehicle.
let garage = null;

function ensureSound() { if (!sound) sound = new SoundManager(); return sound; }

// Spatial engines need the AudioContext running, which browsers only allow from a
// user gesture. The garage deploy click covers human play; for AI-vs-AI spectating
// (no deploy) the first tap/click anywhere on the field arms it.
let _audioArmed = false;
function armFieldAudio() {
  if (_audioArmed || !onField) return;
  _audioArmed = true;
  ensureSound().setSpatialActive(true);
}
window.addEventListener('pointerdown', armFieldAudio, { passive: true });

// Reconcile the spatial engine voices against the live combatants each frame:
// listener follows the camera, every non-player vehicle gets a positioned engine
// that attenuates with distance (so you hear enemies coming, and AI-vs-AI hums).
const _camDir = new THREE.Vector3();
let _engineSeq = 0;
function updateEngineSounds() {
  if (!sound || !sound.spatialReady) return;
  camera.getWorldDirection(_camDir);
  sound.setListener(camera.position.x, camera.position.y, camera.position.z,
                    _camDir.x, _camDir.y, _camDir.z);
  for (const v of combatants) {
    if (v.isPlayer) continue;                 // the player hears its own engine centred
    const p = v.holder.position;
    if (v._engineId == null) {
      v._engineId = ++_engineSeq;
      sound.addSpatialEngine(v._engineId, v.def.soundIndex, p.x, p.y, p.z);
    }
    sound.updateSpatialEngine(v._engineId, p.x, p.y, p.z, v._throttle || 0);
  }
}

// Toggle the garage overlays (CCTV / HUD / team selector) and the field UI (title +
// touch joystick) when switching between the hangar view and the island.
function setGarageOverlays(show) {
  for (const id of ['cctv', 'hud-name', 'hud-stats', 'teamsel']) {
    const el = document.getElementById(id);
    if (el) el.style.display = show ? '' : 'none';
  }
}
function setFieldUI(show) {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = show ? '' : 'none';
  // The old drive stick + fire button are retired: touch now steers toward the finger
  // and taps to fire (see the canvas touch handlers). Keep them hidden either way.
  for (const id of ['touch-joystick', 'fire-btn']) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('visible');
  }
  const tog = ensureLogToggle(); tog.style.display = show ? 'flex' : 'none';   // phone-friendly AI-log toggle
  if (!show) fireHeld = false;   // don't carry a held shot back into the garage
}
// A small always-reachable button to flip the AI decision log (no keyboard on a phone).
function ensureLogToggle() {
  let b = document.getElementById('ailog-toggle');
  if (b) return b;
  b = document.createElement('div'); b.id = 'ailog-toggle'; b.textContent = 'AI';
  b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:160;width:46px;height:46px;border-radius:50%;' +
    'display:flex;align-items:center;justify-content:center;font-family:"Courier New",monospace;font-weight:bold;' +
    'font-size:13px;letter-spacing:1px;color:#dfe8ef;background:rgba(8,12,18,0.6);border:1px solid rgba(255,255,255,0.3);' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.3);user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer;';
  b.style.opacity = aiLogOn ? '1' : '0.55';
  const toggle = e => { e.preventDefault(); e.stopPropagation(); aiLogOn = !aiLogOn; b.style.opacity = aiLogOn ? '1' : '0.55'; updateAiLog(); };
  b.addEventListener('pointerdown', toggle);
  document.body.appendChild(b);
  return b;
}

// Build the garage scene + its UI/handlers. Called once via ensureGarage() — at
// load in ?garage mode, or lazily the first time a vehicle returns to base.
function setupGarageUI() {
  setupGarageUI._done = true;
  setFieldUI(false);
  mountCCTV();
  mountHangarHud(garage);
  mountTeamSelector();

  // Engine sound (procedural, from the designer's SoundManager) + team-colour lock,
  // both fired when a deploy is confirmed. AudioContext starts on the gesture.
  if (!sound) sound = new SoundManager();
  garage.onDeploy((type) => {
    try {
      sound.setVehicle(VEHICLE_TYPES[type].soundIndex);
      if (!sound.enabled) sound.toggle();
    } catch (e) { /* audio is best-effort */ }
    const ts = document.getElementById('teamsel');
    if (ts) ts.style.display = 'none';   // team colour locked at deploy
    deploy = { type, colorIndex: camoParams.colorIndex };   // carried over to the island
  });

  // Garage controls only act while the hangar is on screen (not while driving).
  window.addEventListener('keydown', (e) => {
    if (onField) return;
    const k = e.key.toLowerCase();
    if (k === ' ' || k === 'spacebar') { garage.confirm(); e.preventDefault(); }
    else if (k === 'arrowright' || k === 'd') { garage.cycleType(1); e.preventDefault(); }
    else if (k === 'arrowleft' || k === 'a') { garage.cycleType(-1); e.preventDefault(); }
    else if (k >= '1' && k <= '4') { garage.selectType(garage.types[+k - 1]); }
  });

  // Field hotkeys. L toggles the AI log in any field mode; the camera-cycle keys
  // (Tab/]/[ to pin next/prev unit, backtick to auto-follow) are spectate-only.
  window.addEventListener('keydown', (e) => {
    if (!onField) return;
    if (e.key === 'l' || e.key === 'L') { aiLogOn = !aiLogOn; updateAiLog(); return; }
    if (TEAM_CTRL[PLAYER_TEAM] === 'human') return;
    if (e.key === 'Tab' || e.key === ']') { cycleSpectate(e.shiftKey ? -1 : 1); e.preventDefault(); }
    else if (e.key === '[') { cycleSpectate(-1); e.preventDefault(); }
    else if (e.key === '`') { spectateTarget = null; }
  });

  // Click a vehicle to select its type; click the already-selected type again to
  // confirm/deploy it. (Ignore real drags / orbit.)
  let downXY = null;
  renderer.domElement.addEventListener('mousedown', (e) => { if (!onField) downXY = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('mouseup', (e) => {
    if (onField || !downXY) return;
    const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
    downXY = null;
    if (moved > 6) return;
    const ndc = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1,
    );
    const prev = garage.selType;
    const t = garage.pickType(ndc);
    if (t && t === prev) garage.confirm();   // clicked the already-selected type → deploy
  });

  ensureDeployFade();
  garage.applyRoster(playerLosses);   // attrition: hide reserves lost so far (incl. ?losses preview)
}

// Full-screen black overlay shared by deploy (fade out → field) and return (fade
// to black as the lift lowers, then fade the garage in).
function ensureDeployFade() {
  if (document.getElementById('deployfade')) return;
  const fade = document.createElement('div');
  fade.id = 'deployfade';
  fade.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:80;transition:none;';
  document.body.appendChild(fade);
}

function ensureGarage() {
  if (garage) return;
  garage = new Garage(PLAYER_TEAM);
  setupGarageUI();
}

if (GARAGE) ensureGarage();

// Garage → island handoff. Fired once the garage rise has fully faded to black
// (garage.phase === 'done'). Builds the island ONCE (behind the black overlay), then
// drops the deployed vehicle (in the colour locked at deploy) onto the player's FOB
// lift and rides it up — control hands to the player at the top, under the fade-in.
function enterField() {
  onField = true;
  fieldFadeT = 0;

  if (!fieldBuilt) {
    map.generate(GEN_OPTS);
    scene.add(map.group);
    placeCamps();
    buildRoads();
    if (!SHOT || SHOT_FOL) scatterFoliage();
    scaleScene();
    fieldBuilt = true;
    setupCommanders();
  }

  deployToFOB(deploy.type, deploy.colorIndex, true);   // rise out of the pit, then drive
  setGarageOverlays(false);
  setFieldUI(true);
  ensureSound().setSpatialActive(true);   // hear enemy/AI engines (ctx already live from the deploy click)
}

// Vehicle drives back onto its own FOB and parks → lower it (the visible bit) and,
// once it bottoms out, return to the garage (no inside-garage animation needed).
function beginReturn() {
  returning = true;
  driving = false;
  // Riding a stolen enemy flag down the lift IS the win — kick off the cinematic.
  victoryReturn = !!flags.find(f => f.carried && f.carrier === player);
  victoryHoldT = 0;
  if (victoryReturn) playVictory(PLAYER_TEAM);
  clearLock();
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* audio is best-effort */ }   // engine winds down as it parks + lowers
  const h = Math.atan2(playerElev.center.x, playerElev.center.z);
  player.setPose(playerElev.center.x, playerElev.groundY, playerElev.center.z, h);   // re-centre on the pad
  playerElev.loop = false;
  playerElev.phase = 'lowering';
  playerElev.t = 0;
  playerElev.lift.position.y = playerElev.groundY;
  playerElev.setRider(player, h);
}

function returnToGarage() {
  returning = false;
  // Did the player ride an enemy flag all the way down into the garage? That's the capture.
  const captured = flags.find(f => f.carried && f.carrier === player);
  if (player) { removeCombatant(player); scene.remove(player.group); player = null; }
  updatePlayerHud();
  ensureGarage();
  garage.reset();
  garage.applyRoster(playerLosses);   // reflect this match's losses in the roster
  onField = false;
  if (sound) sound.setSpatialActive(false);   // mute remote engines while in the hangar
  setGarageOverlays(true);
  setFieldUI(false);
  garageFadeT = 0;   // fade the garage in from black
  if (captured) {
    captured.carried = false; captured.carrier = null; captured.returnT = 0;
    captured.group.position.set(captured.home.x, captured.home.y, captured.home.z);   // flag back on its post
    flagsCaptured++;   // the VICTORY cinematic already played over the descent (playVictory)
  }
  clearCeleb();        // tidy any confetti/title before the hangar shows
}

// Security-camera overlay for the garage: vignette + scanlines + REC + clock.
function mountCCTV() {
  const style = document.createElement('style');
  style.textContent = `
    #cctv { position:fixed; inset:0; pointer-events:none; z-index:50;
      background:
        repeating-linear-gradient(0deg, rgba(0,0,0,0.13) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 3px),
        radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,0.6) 100%);
      font:13px ui-monospace, monospace; color:#cfe6cf; text-shadow:0 0 4px rgba(0,0,0,0.9); letter-spacing:1px; }
    #cctv .rec { position:absolute; bottom:40px; left:18px; color:#ff5a5a; display:flex; align-items:center; gap:7px; }
    #cctv .dot { width:9px; height:9px; border-radius:50%; background:#ff3b3b; box-shadow:0 0 7px #ff3b3b; animation:cctvb 1.4s steps(1) infinite; }
    #cctv .cam { position:absolute; bottom:16px; right:18px; opacity:0.85; }
    #cctv .clk { position:absolute; bottom:16px; left:18px; opacity:0.85; }
    @keyframes cctvb { 50% { opacity:0.1; } }`;
  document.head.appendChild(style);
  const o = document.createElement('div');
  o.id = 'cctv';
  o.innerHTML = '<div class="rec"><span class="dot"></span>REC</div><div class="cam">CAM 04 · HANGAR</div><div class="clk"></div>';
  document.body.appendChild(o);
  const clk = o.querySelector('.clk');
  const tick = () => { clk.textContent = new Date().toISOString().replace('T', '  ').replace(/\..+/, ''); };
  tick(); setInterval(tick, 1000);
}

// Hangar HUD — ported from the Vehicle Designer's stat card. The selected
// vehicle's NAME + role sit in the upper-left; its SPEED/ARMOR/FIREPOWER dot bars
// in the upper-right. Updates on every selection.
function mountHangarHud(garage) {
  const style = document.createElement('style');
  style.textContent = `
    #hud-name { position:fixed; top:18px; left:20px; z-index:58; pointer-events:none;
      font:13px ui-monospace, monospace; color:#00eeff; text-shadow:0 0 6px rgba(0,238,255,0.4); }
    #hud-name .nm { font-size:24px; font-weight:bold; letter-spacing:0.22em; }
    #hud-name .cnt { font-size:14px; font-weight:bold; margin-left:10px; color:#e8c84a; text-shadow:0 0 6px rgba(232,200,74,0.4); }
    #hud-name .role { display:block; margin-top:6px; max-width:340px; font-size:11px; line-height:1.5;
      letter-spacing:0.06em; color:#5fbfd0; text-shadow:none; }
    #hud-stats { position:fixed; top:18px; right:20px; z-index:58; pointer-events:none;
      background:rgba(5,12,20,0.78); border:1px solid #0e2030; padding:12px 16px; min-width:190px;
      font:11px ui-monospace, monospace; }
    #hud-stats .row { display:flex; align-items:center; justify-content:space-between; gap:14px; margin:5px 0; }
    #hud-stats .lab { letter-spacing:0.15em; color:#5a7a8a; }
    #hud-stats .bar { font-size:14px; letter-spacing:0.08em; color:#00eeff; }`;
  document.head.appendChild(style);

  const name = document.createElement('div');
  name.id = 'hud-name';
  name.innerHTML = `<span class="nm"></span><span class="cnt"></span><span class="role"></span>`;
  document.body.appendChild(name);

  const stats = document.createElement('div');
  stats.id = 'hud-stats';
  const ROWS = ['speed', 'armor', 'firepower'];
  stats.innerHTML = ROWS.map(k =>
    `<div class="row"><span class="lab">${k.toUpperCase()}</span><span class="bar" id="hud-${k}"></span></div>`).join('');
  document.body.appendChild(stats);

  const bar = (v, max = 5) => '▪'.repeat(v) + '▫'.repeat(max - v);
  const update = () => {
    const s = garage.selected();
    if (!s) return;
    const def = VEHICLE_TYPES[s.type];
    name.querySelector('.nm').textContent = def.label.toUpperCase();
    name.querySelector('.cnt').textContent = '×' + garage.remaining(s.type);
    name.querySelector('.role').textContent = def.role;
    for (const k of ROWS) document.getElementById('hud-' + k).textContent = bar(def.stat[k]);
  };
  garage.onSelect(update);
  update();
}

// Team-color selection — a row of swatches along the bottom. Picking one redraws
// the shared camo canvas, recolouring every vehicle at once. Free to change while
// in the garage; the choice gets LOCKED + recorded the moment the first vehicle is
// deployed up the elevator (Phase C), after which this row is no longer offered.
function mountTeamSelector() {
  const style = document.createElement('style');
  style.textContent = `
    #teamsel { position:fixed; bottom:16px; left:50%; transform:translateX(-50%); z-index:61;
      display:flex; gap:10px; align-items:center; padding:9px 14px; border-radius:11px;
      background:rgba(16,20,26,0.9); border:1px solid #2b333d; box-shadow:0 6px 20px rgba(0,0,0,0.5);
      font:11px ui-monospace, monospace; color:#9aa4b0; }
    #teamsel .lab { letter-spacing:1px; margin-right:2px; }
    #teamsel .sw { width:30px; height:30px; border-radius:7px; cursor:pointer; border:2px solid transparent;
      box-shadow:inset 0 0 0 1px rgba(0,0,0,0.4); position:relative; }
    #teamsel .sw.active { border-color:#fff; box-shadow:0 0 10px rgba(255,255,255,0.6); }
    #teamsel .name { min-width:54px; text-align:center; color:#dfe6ee; letter-spacing:1px; }`;
  document.head.appendChild(style);

  const row = document.createElement('div');
  row.id = 'teamsel';
  row.innerHTML = `<span class="lab">TEAM</span>`
    + TEAM_COLORS.map((c, i) =>
        `<div class="sw${i === camoParams.colorIndex ? ' active' : ''}" data-i="${i}" style="background:${c.hex}" title="${c.name}"></div>`).join('')
    + `<span class="name" id="teamname">${TEAM_COLORS[camoParams.colorIndex].name}</span>`;
  document.body.appendChild(row);

  row.querySelectorAll('.sw').forEach(sw => {
    sw.addEventListener('click', () => {
      const i = parseInt(sw.dataset.i);
      updateCamo({ colorIndex: i });                       // camo body (shared texture)
      const hex = TEAM_COLORS[i].hex;
      if (garage) for (const s of garage.slots) s.vehicle.setTeamColor(hex);   // glow/accent bits
      row.querySelectorAll('.sw').forEach(s => s.classList.toggle('active', s === sw));
      row.querySelector('#teamname').textContent = TEAM_COLORS[i].name;
    });
  });
}

// Help: a small "?" button (bottom-right) that toggles a controls panel, so the
// instructions aren't pinned on screen the whole time. Content depends on mode.
mountHelp();
function mountHelp() {
  const style = document.createElement('style');
  style.textContent = `
    #helpbtn { position:fixed; bottom:44px; right:14px; z-index:70; width:30px; height:30px;
      border-radius:50%; border:1px solid #2b333d; background:rgba(16,20,26,0.9); color:#cdd3da;
      font:bold 15px ui-monospace, monospace; cursor:pointer; }
    #helpbtn:hover { color:#fff; border-color:#3a4654; }
    #helppanel { position:fixed; bottom:82px; right:14px; z-index:70; width:250px; display:none;
      background:rgba(16,20,26,0.94); color:#cdd3da; border:1px solid #2b333d; border-radius:8px;
      padding:12px 14px; font:12px/1.5 ui-monospace, monospace; box-shadow:0 6px 20px rgba(0,0,0,0.5); }
    #helppanel.open { display:block; }
    #helppanel h3 { margin:0 0 8px; font-size:11px; letter-spacing:1px; color:#e8c84a; }
    #helppanel .k { color:#7fd0ff; }
    #helppanel div { margin:4px 0; }`;
  document.head.appendChild(style);

  const rows = GARAGE ? [
    ['◀ ▶ / A D', 'change vehicle type'],
    ['1 – 4', 'pick a type directly'],
    ['Click', 'select a vehicle’s type'],
    ['Space / click again', 'deploy'],
    ['Swatches', 'choose team color'],
  ] : [
    ['W A S D', 'drive'],
    ['Touch joystick', 'drive (drag from anywhere)'],
    ['Scroll / pinch', 'zoom'],
    ['⚙', 'tune the map'],
  ];
  const btn = document.createElement('button');
  btn.id = 'helpbtn'; btn.textContent = '?';
  const panel = document.createElement('div');
  panel.id = 'helppanel';
  panel.innerHTML = `<h3>${GARAGE ? 'HANGAR CONTROLS' : 'CONTROLS'}</h3>`
    + rows.map(([k, d]) => `<div><span class="k">${k}</span> — ${d}</div>`).join('');
  btn.addEventListener('click', () => panel.classList.toggle('open'));
  document.body.appendChild(btn);
  document.body.appendChild(panel);
}

// Live controls -> regenerate.
if (!GARAGE) new Controls(DEFAULTS, rebuild);

// --- Tap-to-damage test (temporary, until vehicles can shoot) ----------
// A quick tap (not an orbit drag) fires a damage burst at whatever it hits,
// so destructibility is verifiable on a phone with no console.
const ray = new THREE.Raycaster();
// Debug handle (headless verification / console poking).
window.RR = {
  THREE, scene, camera, map,
  get destructibles() { return destructibles; },
  get camps() { return camps; },
  damageTapAt: (x, y) => damageTapAt(x, y),
  rebuild: (patch) => rebuild(patch),
  frame: () => frameMap(),
  look: (x, z, dist, pitch) => { orbit.target.set(x, 0, z); orbit.dist = dist; if (pitch != null) orbit.pitch = pitch; updateCamera(); },
  get foliage() { return foliage; },
  get roadNet() { return roadNet; },
  get vehicles() { return vehicles; },
  get elevators() { return elevators; },
  get player() { return player; },
  spawnPlayer: (type = 'firebrat', colorIndex = 4, rise = false) => deployToFOB(type, colorIndex, rise),
  get garage() { return garage; },
  get onField() { return onField; },
  get returning() { return returning; },
  forceReturn: () => { if (player && playerElev) { leftPad = true; beginReturn(); } },
  // Preview the end-of-match cinematic without playing a whole round.
  celebrate: (kind = 'victory', team = PLAYER_TEAM) => kind === 'defeat' ? playDefeat() : playVictory(team),
  navPlan: (v, x, z) => planPath(v, { x, z }),                 // debug: A* path for a unit
  navCellBlocked: (v, i, j) => cellBlocked(v, i, j),          // debug: nav passability of a cell
  get gateCells() { return [...gateCells]; },
  // Fast-forward the field sim by fixed steps (headless verification runs ~0.2x
  // real-time, so this advances GAME time without waiting on the slow renderer).
  stepField: (dt = 0.05, n = 1) => {
    for (let k = 0; k < n; k++) {
      if (matchOver) break;
      updateCommanders(dt);
      for (const e of elevators) e.update(dt);
      for (const v of vehicles) v.idle(dt);
      projectiles.update(dt); updateProjectileHits();
      destructibles.update(dt);
      updateResupplies(dt); updateWallTurrets(dt); updateLock(dt);
    }
  },
  blockedAt: (x, z) => blockedAt(x, z),
  get obstacles() { return obstacles; },
  get grid() { return grid; },
  fire: () => firePlayer(),
  get projectiles() { return projectiles; },
  get combatants() { return combatants; },
  get commanders() { return commanders; },
  get flags() { return flags; },
  get teamCtrl() { return TEAM_CTRL; },
  damageVehicle: (v, amt) => damageVehicle(v || player, amt),
  get damageTally() { return { ...dmgTally }; },
  explodeAt: (x, y, z, blast = 4, dmg = 100) => explodeAt(new THREE.Vector3(x, y, z), blast, dmg, null, null),
  // Headless test hook: run one combat sim step (projectile flight + hits + fx).
  tickCombat: (dt = 0.05) => { projectiles.update(dt); updateProjectileHits(); if (foliage) foliage.update(dt); updateFx(dt); },
  tickAI: (dt = 0.1) => updateCommanders(dt),
  get sound() { return sound; },
  tickEngines: () => updateEngineSounds(),
  armAudio: () => { ensureSound().setSpatialActive(true); },
  applyAltitude: (v, dt = 0.1) => applyAltitude(v || player, dt),
  startCommanders: (reserved) => startCommanders(reserved),
  get lock() { return lock; },
  get resupplies() { return resupplies; },
  get playerLosses() { return playerLosses; },
  get matchOver() { return matchOver; },
  tickFlags: (dt = 0.1) => updateFlags(dt),
  tickResupply: (dt = 0.1) => updateResupplies(dt),
  fireUnit: (v) => fireVehicle(v, false),
  fireAtWorld: (x, y, z, v) => fireVehicle(v || player, false, new THREE.Vector3(x, y, z)),
  tickLock: (dt = 0.1) => updateLock(dt),
  lockOnVehicle: (v) => setLock(v, null),
  lockPoint: (x, y, z) => setLock(null, new THREE.Vector3(x, y, z)),
  clearLock: () => clearLock(),
  acquireLock: (px, py) => acquireLock(px, py),
  tickDrive: (dt = 0.1) => driveUpdate(dt),
  refreshHud: () => updatePlayerHud(),
  // --- targeting test hooks ---
  setCursor: (px, py) => { _cursor = { x: px, y: py }; },
  refreshReticle: () => updateAimReticle(),
  aimPlayerTurret: (dt = 0.1) => aimPlayerTurret(player, dt),
  aimInfo: () => ({
    valid: _aimValid,
    point: _aimPoint ? { x: _aimPoint.x, y: _aimPoint.y, z: _aimPoint.z } : null,
    targetVeh: _aimTargetVeh ? _aimTargetVeh.type : null,
    reticleVisible: aimReticle ? aimReticle.visible : false,
    reticleColor: aimReticle ? aimReticle._mat.color.getHex() : 0,
    turretYaw: player && player.model ? (player.model.aimYaw || 0) : null,
    aligned: player ? !!player._aligned : null,
  }),
  spawnEnemy: (type, x, z, y) => {
    const v = new Vehicle(type); v.setScale(0.72);
    const gy = y != null ? y : vehicleGroundY(x, z);
    v.setPose(x, gy, z, 0);
    scene.add(v.group);
    initCombatant(v, PLAYER_TEAM === 'red' ? 'blue' : 'red', 5, false);
    return v.hp;
  },
  enemyHp: () => { const e = combatants.find(c => !c.isPlayer && !c.dead); return e ? e.hp : null; },
  cycleSpectate: (dir = 1) => { cycleSpectate(dir); return spectateTarget ? spectateTarget.type : null; },
  tickSpectate: (dt = 0.1) => spectateUpdate(dt),
  refreshAiLog: () => updateAiLog(),
  get spectateFocus() { return spectateTarget; },
  aiView: (i = 0) => { const c = commanders[i]; return c && c.unit ? c._view(c.unit, 0.1) : null; },
  aiKnownSupplyCount: (i = 0) => { const c = commanders[i]; return c ? c.knownSupplies.size : null; },
  returnToGarage: () => returnToGarage(),
  get flagsCaptured() { return flagsCaptured; },
  tickTurrets: (dt = 0.1) => updateWallTurrets(dt),
  get islandBound() { return islandBound; },
};
function damageTapAt(px, py) {
  const ndc = new THREE.Vector2(
    (px / window.innerWidth) * 2 - 1,
    -(py / window.innerHeight) * 2 + 1,
  );
  ray.setFromCamera(ndc, camera);
  const hit = destructibles.pick(ray);
  if (hit) destructibles.damageAt(hit.point, 2.5, 90);
}

// --- Resize + loop -----------------------------------------------------
window.addEventListener('resize', () => {
  applyCameraFov();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (garage) garage.onResize();
});

// Perf readout (bottom-right). DRAW = draw calls — drops as chunks cull.
const perfEl = document.getElementById('perf');
let fpsEma = 60, perfTick = 0;

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());
  const fade = document.getElementById('deployfade');
  if (garage && !onField) {
    garage.update(dt);
    if (fade) {
      if (garageFadeT != null) {           // returned to base → fade the garage in from black
        garageFadeT += dt;
        const o = Math.max(0, 1 - garageFadeT / 1.0);
        fade.style.opacity = o;
        if (o <= 0) garageFadeT = null;
      } else {
        fade.style.opacity = garage.riseProgress;   // deploy rise → fade out to black
      }
    }
    renderer.render(garage.scene, garage.camera);
    // Rise finished + screen fully black → build the island and switch to it.
    if (garage.phase === 'done') enterField();
  } else {
    if (!driveUpdate(dt)) spectateUpdate(dt) || panUpdate(dt);   // player, else follow the action / free cam
    if (!matchOver) updateCommanders(dt);  // AI teams (fog-of-war) + flag carry/capture — frozen on win
    for (const c of camps) c.update(dt);
    for (const e of elevators) e.update(dt);
    for (const v of vehicles) v.idle(dt);
    projectiles.update(dt);
    updateProjectileHits();
    if (foliage) foliage.update(dt);       // tree topple animations
    destructibles.update(dt);
    updateFx(dt);
    updateHealthBars();
    updateLock(dt);                        // Valkyrie target box: track + colour the lock
    updateAimReticle();                    // cursor crosshair (other vehicles) + aim point
    updateResupplies(dt);                  // fuel/ammo/shield POIs + base resupply + shield FX
    updateWallTurrets(dt);                 // base corner turrets fire on intruders in range
    updatePlayerHud();                     // live HUD: fuel drains every frame, not just on events
    updateAiLog();                         // AI decision overlay (spectate / ?ailog)
    updateEngineSounds();                  // spatial enemy/AI engine noise (distance-based)
    renderer.render(scene, camera);
    if (fade) {
      if (returning && victoryReturn) {
        // Victory: stay clear so the confetti + descending Firebrat are visible,
        // hold a beat at the bottom on the celebration, then fade to the garage.
        if (playerElev && playerElev.phase === 'down') {
          victoryHoldT += dt;
          fade.style.opacity = Math.max(0, (victoryHoldT - VICT_HOLD) / 0.6);
          if (victoryHoldT > VICT_HOLD + 0.6) { victoryReturn = false; returnToGarage(); }
        } else {
          fade.style.opacity = 0;
        }
      } else if (returning) {
        // Fade to black as the lift nears the bottom; hand back to the garage at the floor.
        const k = playerElev ? (playerElev.lift.position.y - playerElev.bottomY) / playerElev.depth : 0;
        fade.style.opacity = Math.max(0, Math.min(1, 1 - k * 2.5));   // black over the last ~40%
        if (playerElev && playerElev.phase === 'down') returnToGarage();
      } else if (onField) {
        // After the deploy handoff, fade the black overlay back out as the lift rises.
        fieldFadeT += dt;
        fade.style.opacity = Math.max(0, 1 - fieldFadeT / 1.3);
      }
    }
  }

  perfTick++;
  fpsEma += (1 / Math.max(dt, 0.0001) - fpsEma) * 0.08;
  if (perfEl && perfTick % 20 === 0) {
    perfEl.innerHTML =
      `FPS: ${Math.round(fpsEma)}<br>` +
      `MS: ${(dt * 1000).toFixed(1)}<br>` +
      `DRAW: ${renderer.info.render.calls}<br>` +
      `TRIS: ${(renderer.info.render.triangles / 1000).toFixed(1)}K`;
  }
}
updateCamera();
animate();
