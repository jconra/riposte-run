// main.js — RMRF bootstrap (fresh build).
// Bright Return Fire look: light sky, warm sun, tone mapping. Procedural islands
// with a live controls panel. Garage + vehicles land in later milestones.

import * as THREE from 'three';
import { IslandMap, DEFAULTS } from './IslandMap.js?v=68';
import { Controls } from './Controls.js';
import { DestructibleManager, Destructible } from './Destructible.js?v=5';
import { applyStaging } from './AssetStaging.js?v=1';
import { BuildGrid } from './BuildGrid.js';
import { Camp } from './Walls.js?v=59';
import { RoadNetwork } from './Roads.js?v=80';
import { Foliage } from './Foliage.js?v=3';
import { Vehicle, VEHICLE_TYPES } from './Vehicles.js?v=67';
import { Elevator } from './Elevator.js?v=3';
import { Garage, GARAGE_COUNTS } from './Garage.js?v=6';
import { TEAM_COLORS, updateCamo, camoParams } from './CamoTexture.js';
import { SoundManager } from './SoundManager.js?v=3';
import { Projectiles } from './Projectiles.js';
import { Brain, randomPersonality } from './AI.js?v=80';
import { makeDoctrine, pickArchetype, assignArchetypes, COUNTER } from './AIStrategies.js?v=66';
import { ExploreMemory } from './ExploreMemory.js?v=54';
import { astarGrid } from './astar.js?v=4';
import { AstarViz } from './AstarViz.js?v=3';
import { makeFuelTank, makeAmmoDepot, makeShieldGenerator, makeShieldBubble, RESUPPLY_TINT } from './Resupply.js';
import { SUPPLY_ASSETS } from './assets.manifest.js?v=1';

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

// Environment map = what shiny/metal surfaces REFLECT. A directional light gives a
// specular highlight, but a true reflection needs something to sample — without an
// env map, metals reflect nothing and render dark. We build a small procedural sky
// (gradient + warm sun disc), PMREM-filter it, and hang it on the scene so every
// MeshStandardMaterial picks it up: the metallic vehicles brighten and gain a moving
// sky sheen, and glossy water reflects the sky + sun.
function makeSkyEnv() {
  const W = 512, H = 256;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0.00, '#4f93c8');   // zenith (deeper blue)
  g.addColorStop(0.45, '#bfe4f5');   // sky
  g.addColorStop(0.50, '#eaf5fb');   // horizon glow
  g.addColorStop(0.56, '#cdd9d0');   // just below horizon
  g.addColorStop(1.00, '#8fa39a');   // ground/sea bounce
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const sx = W * 0.62, sy = H * 0.30, sr = H * 0.18;   // warm sun disc up in the sky
  const rg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr);
  rg.addColorStop(0.0, 'rgba(255,251,238,1)');
  rg.addColorStop(0.3, 'rgba(255,244,214,0.85)');
  rg.addColorStop(1.0, 'rgba(255,244,214,0)');
  ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const _pmrem = new THREE.PMREMGenerator(renderer);
const _skySrc = makeSkyEnv();
scene.environment = _pmrem.fromEquirectangular(_skySrc).texture;
_skySrc.dispose(); _pmrem.dispose();

// Warm key sun + cool sky-ground ambient = sunny beach. A mid-low sun angle
// (~40° up, afternoon) so light rakes across the vehicles' sides and catches
// highlights — a high midday sun just lit their tops and left the flanks dark.
const sun = new THREE.DirectionalLight('#fff3d6', 2.1);
sun.position.set(0, 202, -25);   // bro's chosen specular angle (overridden per-map by scaleScene)
scene.add(sun);
const hemi = new THREE.HemisphereLight('#dff1ff', '#c2a86a', 0.95);
scene.add(hemi);

// --- Camera + minimal orbit control -----------------------------------
const BASE_FOV = 55;   // landscape vertical fov
// near=3 (not 0.5): the orbit cam never gets closer than ~8u to the action, so a tiny
// near plane just threw away depth-buffer precision (far/near went from 2500 to ~415),
// which is what made the terrain/waterline z-fight so badly when zoomed out.
const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 3, 1200);

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
// A second finger HELD to one side (while the first steers) slides the hull straight
// sideways toward it, aim unchanged — { id, x, y, t(down-time) }. A quick second tap
// still fires; only a held finger strafes (see the dwell gate in driveInput).
let touchStrafe = null;
const TOUCH_STOP_R = 7;           // world radius around the vehicle that reads as "stop"
// Touch NAV stick (right thumb): "go in this direction" — the knob's offset is a
// camera-relative compass heading; the vehicle drives that world direction (tank types
// turn to face it, the omni Lurcher slides there). { nx, ny, mag } in stick space.
let touchNav = null;
// Touch AIM stick (left thumb): tilt sets the desired turret offset from the hull
// forward (clamped to the vehicle's arc), push to the rim FIRES. { nx, ny, mag } in
// stick space (nx right, ny down, mag 0..>1). touchAiming = a finger is on it now.
let touchAim = null;
let touchAiming = false;
const RIM_FIRE = 0.92;            // knob pushed this far toward the edge = pull the trigger
const ASSIST_CONE = 0.30;         // rad; an enemy within this of where you point gets auto-aimed
const ASSIST_RANGE = 150;         // u; aim-assist only reaches this far

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
    if (humanDriving()) return;   // zoom is a SPECTATOR control — the camera tracks the player at a fixed distance while driving
    orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + e.deltaY * 0.12));
    updateCamera();
  }, { passive: true });
  // Touch model:
  //   DRIVING — the FIRST finger steers (the vehicle heads toward it); release it as a
  //     quick tap and it fires instead. Any EXTRA finger is a tap-to-fire, so you can
  //     shoot without lifting the steering thumb. (No pinch-zoom while driving.)
  //   SPECTATING (AI-vs-AI) — one finger pans the camera, two fingers pinch-zoom.
  //   PvA — pinch-zoom is OFF (two thumbs on the sticks would trip a global 2-touch
  //     zoom); it's gated to spectator games where there are no sticks to conflict.
  let steerId = null, steerStart = null;   // the steering finger's id + its down pos/time
  const taps = {};                         // extra fingers being watched for a tap (by identifier)
  const humanDriving = () => onField && player && !player.dead;
  const spectatorGame = () => TEAM_CTRL[PLAYER_TEAM] !== 'human';   // true AI-vs-AI watch (no human sticks)
  let pinchD = 0;
  const touchDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const fireAt = (x, y) => { if (playerIsValkyrie()) acquireLock(x, y); else fireAtPoint(x, y); };
  const isTap = s => Math.hypot(s.x - s.sx, s.y - s.sy) < 12 && performance.now() - s.t < 300;

  el.addEventListener('touchstart', e => {
    // While driving, the two on-screen sticks own control (left = drive, right = aim);
    // the open field is inert (the camera auto-follows). Touches on the sticks hit their
    // own pointer handlers, not this canvas listener.
    if (humanDriving()) return;
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchPan.active = true; touchPan.x = touchPan.sx = t.clientX; touchPan.y = touchPan.sy = t.clientY;
      touchPan.t = performance.now();
    } else if (e.touches.length === 2 && spectatorGame()) {
      touchPan.active = false; pinchD = touchDist(e);   // spectator pinch-zoom
    }
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (steerId !== null || Object.keys(taps).length) {
      for (const t of e.changedTouches) {
        if (t.identifier === steerId) { touchSteer.x = steerStart.x = t.clientX; touchSteer.y = steerStart.y = t.clientY; }
        else if (taps[t.identifier]) {
          taps[t.identifier].x = t.clientX; taps[t.identifier].y = t.clientY;
          if (touchStrafe && touchStrafe.id === t.identifier) { touchStrafe.x = t.clientX; touchStrafe.y = t.clientY; }
        }
      }
      return;
    }
    if (e.touches.length === 1 && touchPan.active) {
      touchPan.x = e.touches[0].clientX; touchPan.y = e.touches[0].clientY;
    } else if (e.touches.length === 2 && spectatorGame()) {
      const d = touchDist(e);
      if (pinchD) { orbit.dist = Math.max(8, Math.min(zoomMax, orbit.dist + (pinchD - d) * 0.5)); updateCamera(); }
      pinchD = d;
    }
  }, { passive: true });

  el.addEventListener('touchend', e => {
    for (const t of e.changedTouches) {
      if (t.identifier === steerId) {
        if (isTap(steerStart) && onField && player && !player.dead) fireAt(steerStart.x, steerStart.y);   // a flick of the steer finger = a shot
        steerId = null; steerStart = null; touchSteer = null;
      } else if (taps[t.identifier]) {
        const s = taps[t.identifier]; delete taps[t.identifier];
        if (touchStrafe && touchStrafe.id === t.identifier) touchStrafe = null;
        if (isTap(s) && onField && player && !player.dead) fireAt(s.x, s.y);
      }
    }
    if (!humanDriving() && touchPan.active && e.touches.length === 0) {
      if (isTap(touchPan) && QS.has('tap')) damageTapAt(touchPan.x, touchPan.y);
      touchPan.active = false;
    }
  });
})();

// --- WASD pan (stands in for the future vehicle-follow camera) ---------
// For now this slides the camera target across the map. Once vehicles exist,
// WASD will drive the vehicle and the camera will track it the same way.
const keys = {};
window.addEventListener('keydown', e => {
  keys[e.key.toLowerCase()] = true;   // firing is on the LEFT mouse / tap, not SPACE
  if (e.key.toLowerCase() === 'v' && !e.repeat) toggleAstarViz();   // A* search visualizer overlay
});
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
let _specFocus = null;          // the unit the spectate camera is currently following (the sound HUD's "ears")
// Spectator focus: null = auto (track a flag carrier, else the first living unit);
// otherwise a unit the viewer pinned with Tab/[/] (see the keydown handler).
let spectateTarget = null;
let spectateFree = false;      // viewer is roaming the island freely; don't chase units until FOLLOW
function cycleSpectate(dir) {
  spectateFree = false;        // picking a unit means follow it again
  const list = combatants.filter(v => !v.dead);
  if (!list.length) { spectateTarget = null; return; }
  let i = list.indexOf(spectateTarget);
  if (i < 0) i = dir > 0 ? -1 : 0;     // land on the first (fwd) / last (back) unit
  spectateTarget = list[(i + dir + list.length) % list.length];
}
// Watch a specific team: each tap advances to the next living unit of that team (so the
// two spectate buttons each flip through their own side's units).
function cycleSpectateTeam(team) {
  spectateFree = false;
  const list = combatants.filter(v => !v.dead && v.team === team);
  if (!list.length) { spectateTarget = null; return; }
  const i = list.indexOf(spectateTarget);   // not on this team → i = -1 → starts at 0
  spectateTarget = list[(i + 1) % list.length];
}
// Is the viewer actively panning the camera (WASD, or a touch-drag past the deadzone)?
// Mirrors panUpdate's own movement test so a stray tap doesn't trip free-look.
function spectatePanning() {
  if (keys['w'] || keys['a'] || keys['s'] || keys['d'] ||
      keys['arrowup'] || keys['arrowdown'] || keys['arrowleft'] || keys['arrowright']) return true;
  if (touchPan.active && performance.now() - touchPan.t > 120) {
    const scale = window.innerHeight * 0.32;
    const dx = (touchPan.x - window.innerWidth / 2) / scale;
    const dy = (touchPan.y - window.innerHeight / 2) / scale;
    if (Math.hypot(dx, dy) > 0.14) return true;
  }
  return false;
}
function spectateUpdate(dt) {
  if (TEAM_CTRL[PLAYER_TEAM] === 'human') return false;
  ensureSpectateControls();   // on-screen team1 / follow / team2 / log buttons (touch + click)
  updateSpectateTeamButtons();   // keep the side buttons coloured + labelled per team
  if (spectateTarget && spectateTarget.dead) spectateTarget = null;   // pinned unit died → back to auto
  // Free-look: once the viewer starts panning, let them roam the island — stop yanking
  // the camera back to a unit until they hit FOLLOW. Returning false hands the camera to
  // panUpdate (which moves orbit.target from the same WASD / touch-pan input).
  if (spectatePanning()) spectateFree = true;
  if (spectateFree) { _specFocus = null; if (spectateTagEl) spectateTagEl.style.display = 'none'; return false; }
  let focus = spectateTarget;
  if (!focus) for (const f of flags) if (f.carried && f.carrier && !f.carrier.dead) { focus = f.carrier; break; }
  if (!focus) for (const cmd of commanders) if (cmd.unit && !cmd.unit.dead) { focus = cmd.unit; break; }
  _specFocus = focus || null;     // the watched unit = the sound HUD's listener in spectate
  if (!focus) { if (spectateTagEl) spectateTagEl.style.display = 'none'; return false; }
  _spec.set(focus.holder.position.x, 0, focus.holder.position.z);
  orbit.target.lerp(_spec, 0.04);
  updateCamera();
  return true;
}
// The old top-centre "now watching" banner is gone — the bottom spectate buttons
// already show which team you're following, so it was redundant. spectateTagEl stays
// null; the style.display guards above are now no-ops.
let spectateTagEl = null;
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
  const BASE = 'font-family:"Courier New",monospace;font-size:15px;font-weight:bold;letter-spacing:1px;' +
    'border:1px solid rgba(255,255,255,0.35);border-radius:9px;' +
    'padding:13px 17px;min-width:52px;text-align:center;user-select:none;-webkit-user-select:none;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.3);touch-action:manipulation;cursor:pointer;';
  // A side button: tap to flip through that TEAM's units. Its colour/label track the
  // live team colour (updateSpectateTeamButtons); _team is set there too.
  const mkTeam = () => {
    const btn = document.createElement('div');
    btn.style.cssText = BASE + 'color:#eef4f8;background:rgba(8,12,18,0.7);';
    btn._team = null;
    btn.addEventListener('pointerdown', (ev) => {
      ev.preventDefault(); ev.stopPropagation();
      if (btn._team) cycleSpectateTeam(btn._team);
    });
    bar.appendChild(btn);
    return btn;
  };
  // Two side buttons, one per team: tap to follow that team (cycle its units). There's
  // no FOLLOW button — selecting a team IS following; panning (WASD / drag) drops to
  // free-look. The LOG lives top-right now (see ensureLogToggle), not down here.
  const tA = mkTeam();
  const tB = mkTeam();
  spectateTeamBtns = [tA, tB];
  document.body.appendChild(bar);
  spectateControlsEl = bar;
}
// Keep the two side buttons coloured + labelled by the live team colours, and light up
// whichever team is currently being watched.
let spectateTeamBtns = [];
function updateSpectateTeamButtons() {
  if (!spectateTeamBtns.length) return;
  const teams = [...new Set(commanders.map(c => c.team))];
  for (let i = 0; i < spectateTeamBtns.length; i++) {
    const btn = spectateTeamBtns[i], team = teams[i];
    if (!team) { btn.style.display = 'none'; continue; }
    btn.style.display = '';
    btn._team = team;
    const hex = teamColor(team);
    btn.textContent = colorName(hex);
    const on = !spectateFree && spectateTarget && spectateTarget.team === team;
    btn.style.background = on ? hex : 'rgba(8,12,18,0.7)';
    btn.style.borderColor = hex;
    btn.style.color = on ? '#0a0e14' : '#eef4f8';   // dark text on the lit swatch
  }
}

// --- Shot mode ---------------------------------------------------------
// `?shot` builds a small map (and skips foliage unless `&fol`) so the headless
// render rig stays fast on the software-GL box. Gameplay defaults are untouched.
const QS = new URLSearchParams(location.search);
const SHOT = QS.has('shot');
const SHOT_SIZE = parseInt(QS.get('size')) || 96;
const SHOT_FOL = QS.has('fol');
const SHOT_SEED = QS.has('seed') ? parseInt(QS.get('seed')) : null;
// Seed policy: normal play gets a FRESH RANDOM map every load (each game is different).
// `?seed=N` pins it for reproducibility, and `?shot` keeps the fixed default seed so the
// headless render/test rigs stay deterministic. `?seed` always wins.
const wantSize = SHOT || QS.has('size');
const MAP_SEED = SHOT_SEED != null ? SHOT_SEED : SHOT ? null : (Math.random() * 2147483647) | 0;
// ?mapcfg=<base64 JSON> — a map authored in the Map Designer (terrain params + AI
// rules; placed assets/roads are authored but not yet honoured here). Decoded once;
// drives the terrain (below) and the AI commanders (applyMapCfgRules).
const MAP_CFG = (() => {
  if (!QS.has('mapcfg')) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(QS.get('mapcfg'))))); }
  catch (e) { console.warn('mapcfg: could not decode —', e && e.message); return null; }
})();
// A designed map can set the player's (team A / red) fleet — mutate the shared garage
// counts so the deploy roster reflects it. (Each AI team's fleet is set per-commander.)
if (MAP_CFG?.rules?.teams?.a?.roster) {
  for (const [k, v] of Object.entries(MAP_CFG.rules.teams.a.roster))
    if (k in GARAGE_COUNTS && Number.isFinite(v)) GARAGE_COUNTS[k] = Math.max(0, v | 0);
}
// Map generation options, honoured in ANY field mode (so ?aivsai&size&seed is
// reproducible, not just ?shot). undefined → the map's own fixed default. A designed
// map's `base` params win outright (deterministic: its own seed + shape).
const GEN_OPTS = (MAP_CFG && MAP_CFG.base) ? { ...MAP_CFG.base }
  : (wantSize || MAP_SEED != null) ? {
    ...(wantSize ? { cols: SHOT_SIZE, rows: SHOT_SIZE } : {}),
    ...(MAP_SEED != null ? { seed: MAP_SEED } : {}),
  } : undefined;
// Normal play STARTS IN THE GARAGE (pick team colour + vehicle, then deploy). Only
// the headless test/spectate paths drop straight onto the field.
const SPECTATE = QS.has('aivsai') || QS.has('spectate') || QS.has('ai');
const FIELD_DIRECT = SHOT || QS.has('field') || SPECTATE;
const GARAGE = QS.has('garage') || !FIELD_DIRECT;   // render the hangar as the entry view
// Start screen: the default interactive entry opens a game menu over the hangar
// (pick PLAYER VS AI / AI VS AI). ?play jumps straight to the deploy garage (the menu
// navigates here), and the headless/dev/spectate query flags bypass it entirely.
const START_MENU = !FIELD_DIRECT && !SHOT && !QS.has('play') && !QS.has('garage');
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

// On-screen NAV stick (touch) — a "go in this direction" pad: the knob's offset is a
// camera-relative compass heading, consumed by driveInput (which turns the hull to face
// it and throttles by how far the knob is pushed). Field only; revealed on touch devices
// (window.showJoystick() forces it on for desktop tests).
(function setupJoystick() {
  const joystick = document.getElementById('touch-joystick');
  const knob = document.getElementById('touch-knob');
  // Wire it unconditionally (incl. ?garage flow): it only sets touchNav, which is
  // read while driving, and the widget itself is hidden until setFieldUI(true).
  if (!joystick || !knob) return;
  const MAX_TRAVEL = 42;
  let joyId = null;
  // Visibility is driven by setFieldUI (gated on a real touch — see touchUsed);
  // reveal() stays only as a manual override for desktop testing.
  const reveal = () => joystick.classList.add('visible');
  window.showJoystick = reveal;

  const applyVector = (cx, cy) => {
    const r = joystick.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const mag = d / MAX_TRAVEL;                          // 0..>1 push toward the rim = throttle
    let kx = dx, ky = dy;
    if (d > MAX_TRAVEL) { kx *= MAX_TRAVEL / d; ky *= MAX_TRAVEL / d; }
    knob.style.transform = `translate(${kx}px, ${ky}px)`;
    touchNav = { nx: dx / MAX_TRAVEL, ny: dy / MAX_TRAVEL, mag };   // ny screen-down positive
  };
  const release = () => {
    joyId = null;
    knob.style.transform = 'translate(0px, 0px)';
    touchNav = null;
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
  // A FIRE button in each bottom corner (left + right) so either thumb can fire while the
  // other steers on the field. Press holds fireHeld (same flag SPACE / mouse uses); the
  // driveUpdate cadence loop turns that into repeat shots.
  for (const id of ['fire-btn', 'fire-btn-l']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const press = e => { fireHeld = true; btn.classList.add('pressed'); e.preventDefault(); };
    const lift  = () => { fireHeld = false; btn.classList.remove('pressed'); };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', lift);
    btn.addEventListener('pointercancel', lift);
    btn.addEventListener('pointerleave', lift);
  }
})();

// On-screen AIM stick (touch, right thumb). Tilt to point the gun (knob angle =
// desired turret offset from the hull forward, clamped to the type's arc); push the
// knob to the rim to FIRE. The actual aiming + aim-assist runs per-frame in
// updateTouchAim — this handler only records the stick vector and draws the knob.
(function setupAimStick() {
  const stick = document.getElementById('touch-aim');
  const knob = document.getElementById('aim-knob');
  if (!stick || !knob) return;
  const MAX_TRAVEL = 46;
  let aimId = null;
  const apply = (cx, cy) => {
    const r = stick.getBoundingClientRect();
    let dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    const d = Math.hypot(dx, dy);
    const mag = d / MAX_TRAVEL;                 // raw, can exceed 1 when pushed past the rim
    let kx = dx, ky = dy;
    if (d > MAX_TRAVEL) { kx *= MAX_TRAVEL / d; ky *= MAX_TRAVEL / d; }
    knob.style.transform = `translate(${kx}px, ${ky}px)`;
    touchAim = { nx: dx / MAX_TRAVEL, ny: dy / MAX_TRAVEL, mag };
    stick.classList.toggle('firing', mag >= RIM_FIRE);
  };
  const release = () => {
    aimId = null; touchAim = null; touchAiming = false; fireHeld = false;
    knob.style.transform = 'translate(0px, 0px)';
    stick.classList.remove('firing');
  };
  stick.addEventListener('pointerdown', e => {
    if (aimId !== null) return;
    aimId = e.pointerId; stick.setPointerCapture(e.pointerId);
    apply(e.clientX, e.clientY); e.preventDefault();
  });
  stick.addEventListener('pointermove', e => {
    if (e.pointerId !== aimId) return;
    apply(e.clientX, e.clientY); e.preventDefault();
  });
  const end = e => { if (e.pointerId === aimId) release(); };
  stick.addEventListener('pointerup', end);
  stick.addEventListener('pointercancel', end);
})();

// Paint the aim stick's lit wedge to match the live vehicle's firing arc (forward =
// up). Full ring for the Lurcher (any direction); a narrow sector for the Jotun; a
// half for the Valkyrie. Tiny fixed-gun arcs (Firebrat) get a readable minimum.
function refreshAimArc() {
  const el = document.getElementById('aim-arc');
  if (!el || !player) return;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  const hi = 'rgba(120,210,150,0.30)';
  if (arc >= Math.PI - 1e-3) { el.style.background = 'rgba(120,210,150,0.18)'; return; }   // 360°
  const deg = Math.max(16, arc * 180 / Math.PI);   // min 16°/side so a fixed gun still shows
  el.style.background = `conic-gradient(${hi} 0 ${deg}deg, transparent ${deg}deg ${360 - deg}deg, ${hi} ${360 - deg}deg 360deg)`;
}
// Rotate the lit wedge so its CENTRE points where the vehicle's nose appears ON SCREEN
// (θ = camera yaw − hull heading). With the input now screen-relative, this keeps the arc
// pointing the way the vehicle's headed, so pushing the knob toward an on-screen target
// aims at it. Cheap per-frame DOM write; a full-ring (Lurcher) arc looks the same rotated.
function orientAimArc() {
  const el = document.getElementById('aim-arc');
  if (!el || !player || player.dead) return;
  el.style.transform = `rotate(${(orbit.yaw - player.heading) * 180 / Math.PI}deg)`;
}

// Per-frame: turn the aim stick's tilt into a world aim point (with aim-assist) so the
// existing turret-tracking + fire pipeline (aimPlayerTurret / firePlayer) just works on
// touch — no cursor needed. Sets _aimPoint/_aimTargetVeh/_aimValid and fireHeld.
const _aimStickV = new THREE.Vector3();
function updateTouchAim() {
  touchAiming = false;
  if (!onField || !player || player.dead || !touchAim) return;
  touchAiming = true;
  const hp = player.holder.position;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  // SCREEN-RELATIVE aim: push the knob toward where the target sits ON SCREEN and the gun
  // aims that way (your instinct is screen space, not hull space — pushing "down" when the
  // vehicle faces down should fire down, not backward). Convert the knob offset to a
  // camera-relative world direction (same basis as the drive pad), then express it as an
  // offset from the hull so the arc clamp + aim-assist stay hull-relative.
  const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
  const wx = (-sy) * (-touchAim.ny) + cy * touchAim.nx;        // camForward·(up) + camRight·(right)
  const wz = (-cy) * (-touchAim.ny) + (-sy) * touchAim.nx;
  const rawWorld = Math.atan2(-wx, -wz);                       // world heading the thumb points at
  const desired = Math.max(-arc, Math.min(arc, wrapPi(rawWorld - player.heading)));
  // Aim-assist (the touch "handicap"): snap to the nearest enemy within a cone of where
  // you point AND inside the vehicle's arc, so a human doesn't have to nail the angle.
  let best = null, bestErr = ASSIST_CONE;
  for (const v of combatants) {
    if (v.dead || v === player || v.team === player.team) continue;
    const dx = v.holder.position.x - hp.x, dz = v.holder.position.z - hp.z;
    if (Math.hypot(dx, dz) > ASSIST_RANGE) continue;
    const ang = Math.atan2(-dx, -dz);
    if (Math.abs(wrapPi(ang - player.heading)) > arc + 1e-3) continue;   // outside the arc
    const err = Math.abs(wrapPi(ang - rawWorld));
    if (err < bestErr) { bestErr = err; best = v; }
  }
  const fire = touchAim.mag >= RIM_FIRE;
  if (player.type === 'valkyrie') {
    // Missile lock toward the assisted enemy, or the ground point you're pointing at.
    if (best) setLock(best, best.holder.position);
    else {
      const ang = player.heading + desired;
      _aimStickV.set(hp.x - Math.sin(ang) * 60, 0, hp.z - Math.cos(ang) * 60);
      _aimStickV.y = map.heightAt(_aimStickV.x, _aimStickV.z) + 0.5;
      setLock(null, _aimStickV);
    }
    fireHeld = fire;
    return;
  }
  if (best) { _aimPoint = best.holder.position.clone(); _aimTargetVeh = best; }
  else {
    const ang = player.heading + desired;
    _aimStickV.set(hp.x - Math.sin(ang) * 60, 0, hp.z - Math.cos(ang) * 60);
    _aimStickV.y = map.heightAt(_aimStickV.x, _aimStickV.z) + 1.0;
    _aimPoint = _aimStickV.clone(); _aimTargetVeh = null;
  }
  _aimValid = true;
  fireHeld = fire;
}

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
let matchWon = false;   // last match's result for the PLAYER team (VICTORY vs DEFEAT on the end menu)
let flagsCaptured = 0;  // enemy flags the player has extracted into the garage (score)
let deploy = null;    // { type, colorIndex } captured when a deploy is confirmed
let fieldFadeT = 0;   // counts up after handoff to fade the black deploy overlay out
let garageFadeT = null; // when set, fades the garage in from black (on return)
let waterT = 0;         // elapsed seconds driving the animated water ripples (pauses with the game)
let victoryReturn = false; // the current lift descent is a winning flag extraction (run the cinematic)
let victoryHoldT = 0;      // beat held at the bottom of a victory descent before fading out
const VICT_HOLD = 1.9;     // seconds to linger on the celebration at the bottom
const WIN_CINEMATIC_MS = 5200;   // how long the in-hangar victory cinematic plays before the menu pops

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

// A vehicle still riding a FOB lift UP the shaft hasn't surfaced yet — down in the pit
// it's out of sight, so it can't be SEEN, targeted or shot until its lift tops out. This
// stops a unit camping the enemy's elevator mouth and shelling riders before they rise.
function vehicleHidden(v) {
  for (const e of elevators) if (e.rider === v && e.phase !== 'top') return true;
  return false;
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
// Effective projectile speed (u/s) for AI aim-leading, by soundIndex. Firebrat (1) is
// hitscan (0 = no lead). The Jotun (3) slug is a real 115 u/s round — its complication
// is the railgun CHARGE delay (below), not its speed. The missile (2) accelerates; ~32
// is roughly its average speed over a typical flight.
const PROJ_SPEED     = [85, 0, 32, 115];
// Extra fixed delay (s) between the AI deciding to fire and the round actually leaving the
// muzzle, by soundIndex — only the Jotun's railgun charges (setTimeout 900ms in fireVehicle).
// leadAim folds this into the flight time so the slug is aimed where the target WILL be when
// it finally discharges + flies there, not where it was when the gun started winding up.
const CHARGE_DELAY   = [0, 0, 0, 0.9];
// AI aim-leading strength: fraction of the predicted lead actually applied. Kept BELOW
// 1 on purpose — a perfect intercept gives a fleeing target no way out; this leads
// enough to connect on a straight runner but leaves room to juke (Jacob: "better, not
// perfect"). Per-shot personality jitter loosens it further.
const AIM_LEAD       = 0.7;
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
  lurcher:  { hp: 220, fuel: 200, burn: 2.4, ammo: 68, shield: 110 },
  firebrat: { hp: 90,  fuel: 200, burn: 3.0, ammo: 90, shield: 45  },
  valkyrie: { hp: 190, fuel: 260, burn: 4.2, ammo: 12, shield: 75  },   // 190 (was 140) so it survives ONE Jotun slug (flat 180 to vehicles)
  jotun:    { hp: 320, fuel: 200, burn: 2.0, ammo: 16, shield: 160 },
};
const SINK_RATE = 1.2;     // units/sec a land vehicle floods when over water
const SINK_KILL = 2.5;     // depth at which it's fully submerged → destroyed
const WADE_MIN = 0.25;     // fording draft below the waterline AT the shore (just dips in)
const WADE_MAX = 1.6;      // draft in the deepest fordable water (mostly under, top still shows);
                           // the opaque water-coloured terrain hides the submerged hull
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
// Stamp each combatant's planar velocity (u/s) once per frame from its movement, so
// AI gunners can lead a moving target. Lightly smoothed so one jittery frame doesn't
// throw the aim off; the values are read a frame later, which is plenty fresh.
function trackVelocities(dt) {
  if (dt <= 0) return;
  for (const v of combatants) {
    const x = v.holder.position.x, z = v.holder.position.z;
    if (v._velPx != null) {
      const ax = (x - v._velPx) / dt, az = (z - v._velPz) / dt;
      v._vx = (v._vx || 0) * 0.6 + ax * 0.4;
      v._vz = (v._vz || 0) * 0.6 + az * 0.4;
    }
    v._velPx = x; v._velPz = z;
  }
}

// Predict where to aim so a shot meets a moving target. Solves the intercept time from
// the projectile's speed (a couple of iterations), then applies only AIM_LEAD of the
// predicted offset (plus the gunner's aim jitter) — good enough to punish a straight
// runner, loose enough to dodge. Hitscan / charge weapons (PROJ_SPEED 0) and stationary
// targets just aim at the current position. Returns a shared Vector3 — clone if kept.
const _leadV = new THREE.Vector3();
function leadAim(shooterPos, enemy, soundIndex, jitter = 0) {
  const sp = PROJ_SPEED[soundIndex] || 0;
  const vx = enemy.vx || 0, vz = enemy.vz || 0;
  if (sp <= 0 || (vx === 0 && vz === 0)) return _leadV.set(enemy.x, enemy.y, enemy.z);
  // Total time to impact = the gun's charge delay (Jotun railgun) + the round's flight time.
  // Seed the solve with the charge so the first flight-distance estimate already looks ahead.
  const charge = CHARGE_DELAY[soundIndex] || 0;
  let t = charge;
  for (let i = 0; i < 4; i++) {
    const ex = enemy.x + vx * t, ez = enemy.z + vz * t;
    t = charge + Math.hypot(ex - shooterPos.x, ez - shooterPos.z) / sp;
  }
  const lead = AIM_LEAD * (1 + (Math.random() - 0.5) * jitter);
  return _leadV.set(enemy.x + vx * t * lead, enemy.y, enemy.z + vz * t * lead);
}

function fireVehicle(veh, playSound, targetPoint = null, targetVeh = null, aimedAtEnemy = false) {
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
    // Remote/AI shot → a positioned report so you HEAR enemies fire (player matches +
    // AI-vs-AI observation). The player's own gun already sounded via fireGun() above.
    if (!playSound && sound && sound.spatialReady) {
      try { sound.fireGunAt(idx, mpos.x, mpos.y, mpos.z); } catch (e) { /* best-effort */ }
    }
    emitSoundPing(mpos.x, mpos.y, mpos.z, idx, veh.team);   // sound-awareness HUD: a loud, far-carrying gun report
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
      damageVehicle(targetVeh, SHOT_DMG[idx] * rangeFalloff(veh.type, dist), 'vehicle', veh);
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
        shot.atVehicle = aimedAtEnemy;   // shot-feedback: was this round aimed at an enemy vehicle?
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

// Nearest enemy inside the player's forward gun arc (+ range). Gives the fixed-gun Firebrat
// a way to hit ELEVATED targets: firing AT the vehicle's position pitches the beam up, so a
// player who points the nose at a swooping Valkyrie auto-elevates onto it (no manual pitch).
function acquireForwardTarget() {
  if (!player || player.dead) return null;
  const hp = player.holder.position;
  const arc = SHOT_ARC[player.type] ?? Math.PI / 5;
  let best = null, bestErr = arc + 1e-3;
  for (const v of combatants) {
    if (v.dead || v === player || v.team === player.team || vehicleHidden(v)) continue;
    const dx = v.holder.position.x - hp.x, dz = v.holder.position.z - hp.z;
    if (dx * dx + dz * dz > ASSIST_RANGE * ASSIST_RANGE) continue;
    const err = Math.abs(wrapPi(Math.atan2(-dx, -dz) - player.heading));   // off the gun centreline
    if (err < bestErr) { bestErr = err; best = v; }                         // most-centred target wins
  }
  return best;
}

// Player convenience wrapper (cadence handled by driveUpdate's fireHeld loop).
// Fires at the aim crosshair if the cursor's over the field, else straight ahead.
function firePlayer() {
  if (!player || player.dead) return;
  if (playerIsValkyrie()) { fireVehicle(player, true, null); fireCooldown = player.cooldown; return; }
  // Firebrat has a fixed forward gun — clicking fires straight ahead (no crosshair gating).
  // But if an enemy sits in the forward arc, fire AT it so the beam auto-pitches onto it —
  // the only way to hit a Valkyrie overhead. Touch routes through the aim stick (touchAiming).
  if (player.type === 'firebrat' && !touchAiming) {
    const tgt = acquireForwardTarget();
    if (tgt) fireVehicle(player, true, tgt.holder.position.clone(), tgt, true);
    else fireVehicle(player, true, null);
    fireCooldown = player.cooldown;
    return;
  }
  if (_cursor || touchAiming) {
    // Mouse / aim-stick: only spend a shot when there's a valid firing solution. On touch
    // updateTouchAim sets _aimPoint (+ _aimTargetVeh from aim-assist) and _aimValid.
    if (!_aimValid) return;
    fireVehicle(player, true, _aimPoint, _aimTargetVeh, !!_aimTargetVeh);
  } else {
    fireVehicle(player, true, null);   // no cursor / no aim → fire straight forward
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
    if (v.dead || v === player || (player && v.team === player.team) || vehicleHidden(v)) continue;
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
  // On touch the aim stick owns _aimPoint (set in updateTouchAim, earlier this frame) —
  // leave it be and hide the desktop crosshair.
  if (touchAiming) { if (aimReticle) aimReticle.visible = false; return; }
  _aimPoint = null; _aimValid = false; _aimTargetVeh = null;
  // Firebrat fires straight forward and just clicks to shoot, so it gets no crosshair
  // helper — having it follow the mouse all the time was more clutter than aid.
  if (!onField || !player || player.dead || playerIsValkyrie() || player.type === 'firebrat' || !_cursor) { if (aimReticle) aimReticle.visible = false; return; }
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
// Returns true if the blast actually damaged an enemy vehicle (direct or splash) — the
// caller uses this to tell a clean hit from a shot that detonated on terrain/cover.
function explodeAt(point, blast, dmg, team, shooter) {
  destructibles.damageAt(point, blast, dmg);
  if (foliage) foliage.hitTreesAt(point, blast, dmg);
  const tagged = damageVehiclesAt(point, blast, dmg, team, shooter);
  spawnImpact(point, blast);
  return tagged;
}

// Damage enemy vehicles within blast of a point (never the shooter or its team).
// Returns true if it hit at least one enemy vehicle.
function damageVehiclesAt(point, blast, dmg, team, shooter) {
  let hitAny = false;
  for (const v of combatants) {
    if (v.dead || v === shooter) continue;
    if (team != null && v.team === team) continue;
    const reach = blast + v.hitR;
    if (v.holder.position.distanceToSquared(point) <= reach * reach) { damageVehicle(v, dmg, 'vehicle', shooter); hitAny = true; }
  }
  return hitAny;
}

// Running tally of damage dealt to vehicles, by source — powers siege diagnostics
// (are attackers dying to towers or to enemy vehicles?) and a future kill feed.
const dmgTally = { turret: 0, vehicle: 0, tree: 0, other: 0 };
function damageVehicle(veh, amount, cause = 'other', shooter = null) {
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
  if (veh.hp <= 0) destroyVehicle(veh, 'killed', shooter);
}

// March a hitscan beam; damage the first solid/tree/vehicle it meets.
function raycastDamage(origin, dir, maxDist, dmg, blast, team, shooter) {
  const STEP = 1.2;
  // Forgiving beam: a fat detection pad so the Firebrat's laser connects even when the
  // shot is a touch off — aiming it precisely with a fixed forward gun is the hard part.
  const PAD = 4.0;
  for (let d = 1.0; d <= maxDist; d += STEP) {
    _vtmp.copy(dir).multiplyScalar(d).add(origin);
    const hv = nearestEnemyVehicle(_vtmp, PAD, team, shooter);
    if (hv) {
      // Hit the DETECTED vehicle directly — the detection pad (2.5) is wider than
      // the tiny splash reach, so a point-blast here would miss what the beam met.
      damageVehicle(hv, dmg, 'vehicle', shooter);
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
        if (v.dead || v.team === c.team || vehicleHidden(v)) continue;   // can't shoot a unit still down its lift shaft
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
      const tagged = explodeAt(pos, p.blast, p.dmg, p.team, p.shooter);
      // SHOT FEEDBACK: for a round AIMED at an enemy vehicle, tell a clean hit (it tagged
      // someone, direct or splash) from one that detonated on terrain/cover short of the
      // target. A run of blocked shots flags the shooter so its combat brain can sidestep
      // to open a clear lane (the "two units shoot the hill between them forever" stalemate).
      const sh = p.shooter;
      if (p.atVehicle && sh && !sh.dead) {
        if (tagged) { sh._blockedShots = 0; }
        else { sh._blockedShots = (sh._blockedShots || 0) + 1; sh._lastBlockT = performance.now(); }
      }
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

// Soft white radial alpha (foam core → clear edge) for wake puffs, baked once.
let _foamTex = null;
function foamTex() {
  if (_foamTex) return _foamTex;
  const s = 64, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.5, '#9a9a9a'); grd.addColorStop(1, '#000000');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  _foamTex = new THREE.CanvasTexture(cv);
  return _foamTex;
}
// One flat white foam puff on the water surface; it expands and fades like turbulence.
function spawnWake(x, y, z, r0) {
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5,
    alphaMap: foamTex(), depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  scene.add(m);
  fx.push({ obj: m, life: 1.0, max: 1.0,
    update(dt, k) { m.scale.setScalar(r0 * (0.8 + (1 - k) * 2.6)); mat.opacity = 0.55 * k; },
    dispose() { m.geometry.dispose(); mat.dispose(); } });
}

function updateFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.life -= dt;
    f.update(dt, Math.max(0, f.life / f.max));
    if (f.life <= 0) { scene.remove(f.obj); f.dispose(); fx.splice(i, 1); }
  }
}

// Destroy a vehicle: explosion, then remove it (or send the player to the garage).
// Credit a kill to the firing unit's commander (ignores self/team kills, environment
// deaths where there's no killer, and the player who has no commander). Powers the
// "after a couple kills" doctrine transitions and a short kill-feed line.
function creditKill(killer, victim) {
  if (!killer || killer.team == null || killer.team === victim.team) return;
  const cmd = commanders.find(c => c.team === killer.team);
  if (!cmd) return;
  cmd.kills = (cmd.kills || 0) + 1;
  aiLog(killer.team, `${cmd.cname} ${killer.type} downs a ${victim.type} (${cmd.kills} kills)`);
}
function destroyVehicle(veh, cause, killer = null) {
  if (veh.dead) return;
  veh.dead = true;
  spawnExplosion(veh.holder.position, veh.type === 'jotun');
  creditKill(killer, veh);   // credit the firing unit's commander (drives Warrior/Hunter doctrine + kill feed)
  if (veh.isPlayer) { killPlayer(); return; }
  // Surface what happened to the AI unit — drowned/destroyed units used to just vanish.
  if (veh.ai && veh.team) {
    const how = cause === 'sank' ? 'DROWNED' : 'destroyed';
    aiLog(veh.team, `${teamLabel(veh.colorIndex)} ${veh.type} ${how}`);
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
      if (o.body && o.body.dead) continue;           // a blown-up wall/tower no longer blocks — drive over the rubble
      const dx = x - o.x, dz = z - o.z, rr = o.r + VEH_R;
      if (dx * dx + dz * dz < rr * rr) return true;
    }
    if (move.tree === 'bump' && foliage && foliage.treeAt(x, z, VEH_R * 0.5)) return true;
    return false;
  };
}

// Top surface height of a ROAD cell at a world point, or null if (x,z) isn't on one.
// A road is a raised surface — a flat asphalt slab on land, a plank deck over water —
// so vehicles ride its top instead of sinking into the slab / wading under the planks.
// Must match the grade Roads.js builds each tile at (see tile()/deck() there).
function roadDeckY(x, z) {
  if (!roadNet || !roadNet.cells) return null;
  const cx = Math.round(x / grid.cell), cz = Math.round(z / grid.cell);
  const cell = roadNet.cells.get(cx + ',' + cz);
  if (!cell) return null;
  const p = map.params;
  if (!map.isLand(x, z)) {
    // Over-water span: a plank deck seated at Math.max(cell grade, bridgeY) with its top
    // ~0.08 above the centre. The old flat bridgeY ignored the per-cell grade, so where the
    // road sat higher the deck was built above the vehicle's target and it sank through.
    const bridgeY = p.flatLand ? p.beachHeight + 0.8 : p.beachHeight + 0.5;
    return Math.max(cell.y, bridgeY) + 0.08;
  }
  // Land tile: a flat asphalt slab whose top sits 0.06 above its grade (tile(): topY =
  // gradeY + 0.06). Flat-land roads share ONE grade (the plateau); the legacy hilly map
  // falls back to each cell's own terrain height — same choice Roads.build() makes.
  const roadGrade = p.flatLand ? p.beachHeight + 0.8 : cell.y;
  return roadGrade + 0.06;
}

// Resolve altitude + water flooding for a vehicle, and crush/bump trees it touches.
function applyAltitude(veh, dt) {
  const m = veh._move; if (!m) return;
  const x = veh.holder.position.x, z = veh.holder.position.z;
  const deck = elevatorPadAt(x, z);
  const terrain = deck ? deck.groundY : map.heightAt(x, z);
  const overWater = !deck && !map.isLand(x, z);
  const deepWater = !deck && map.isDeepWater(x, z);   // only the deep part drowns a sinker
  // A road cell (land slab or over-water plank) is a raised surface — ride its top instead
  // of the terrain/water beneath it. Elevator decks and true flyers (ignoreWalls) opt out.
  const roadY = (deck || m.ignoreWalls) ? null : roadDeckY(x, z);
  let target;
  if (m.water === 'sink') {
    if (roadY != null) {
      veh._sink = Math.max(0, veh._sink - dt * SINK_RATE * 1.6);
      target = roadY - veh._sink;
    } else if (deepWater) {
      veh._sink += dt * SINK_RATE;
      target = -veh._sink;
      if (veh._sink >= SINK_KILL) { destroyVehicle(veh, 'sank'); return; }
    } else {
      // land OR shallow water. On land, sit just above the ground. FORDING, sink below the
      // waterline — DEEPER the bluer (deeper) the water — so it reads as riding the surface and
      // wading in, the opaque water-coloured terrain hiding the submerged hull (no water plane
      // exists to do it). Capped short of the drown depth so the top always shows.
      veh._sink = Math.max(0, veh._sink - dt * SINK_RATE * 1.6);
      const floor = deck ? deck.groundY : map.floorAt(x, z);
      if (overWater) {
        const f = Math.min(1, Math.max(0, -floor) / 0.8);   // 0 at shore → 1 at the ford limit (FORD_DEPTH = -0.8)
        target = -(WADE_MIN + f * (WADE_MAX - WADE_MIN)) - veh._sink;
      } else {
        target = floor + 0.05 - veh._sink;
      }
    }
  } else {
    // A hover craft (firebrat) on a road rides above its surface, not the terrain/water
    // beneath it; a true flyer (valkyrie, ignoreWalls) just cruises over everything.
    const base = roadY != null ? roadY : (overWater ? 0 : terrain);
    target = base + m.cruise;
  }
  // Flyers (the Valkyrie) ease to altitude GENTLY so they float up off the lift instead of
  // popping to cruise height; ground craft snap to the grade so they don't sink visibly.
  const altRate = m.ignoreWalls ? 1.8 : 5;
  veh.holder.position.y += (target - veh.holder.position.y) * Math.min(1, dt * altRate);

  // Wake: while a ground (sinker) vehicle fords open water and is actually moving, trail
  // expanding white foam puffs behind it on the water surface.
  if (m.water === 'sink' && overWater && roadY == null) {
    const sp = Math.hypot(veh._vx || 0, veh._vz || 0);
    if (sp > 2) {
      veh._wakeT = (veh._wakeT || 0) - dt;
      if (veh._wakeT <= 0) {
        veh._wakeT = 0.06;   // ~16 puffs/sec while moving
        const inv = veh.hitR / sp, bx = x - veh._vx * inv, bz = z - veh._vz * inv;   // one hull-radius behind
        if (!map.isLand(bx, bz)) spawnWake(bx, map.floorAt(bx, bz) + 0.1, bz, veh.hitR * 0.95);
      }
    }
  }

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
  const st = inp.strafe || 0;
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25), strafe: st * LIMP };
  const load = (Math.abs(inp.fwd) + Math.abs(inp.turn) * 0.5 + Math.abs(st) * 0.6);
  veh.fuel = Math.max(0, veh.fuel - veh.burn * (0.25 + 0.75 * Math.min(1, load)) * dt);
  if (veh.isPlayer) updatePlayerHud();
  if (veh.fuel <= 0) return { fwd: inp.fwd * LIMP, turn: inp.turn * (LIMP + 0.25), strafe: st * LIMP };
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
// AI HEARING: how loud (same 0..1 audibility scale as the sound HUD) an unseen rival must
// be before a unit investigates the noise. A heard contact only steers navigation — it is
// NEVER a firing solution (enemy/seesEnemy stay line-of-sight). Gunfire easily clears this;
// a moving Jotun's drone clears it at range; an idling unit barely makes a whisper.
const AI_HEARD_MIN = 0.18;
const SHIELD_GRAB_RANGE = 130;  // max detour a Lurcher/Valkyrie will take to top up at a known shield generator
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
// Pass role='main' to count ONLY the flag-HQ camp's turrets (the ones that gate a flag
// steal); the FOB/elevator turrets are optional and shouldn't hold back the win logic.
function turretCountOf(team, role = null) {
  let n = 0;
  for (const c of camps) if (c.team === team && (!role || c.role === role)) for (const w of c.walls) {
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
        showBanner(`${flagColorName(f)} HQ DOWN — FLAG EXPOSED`, { color: '#ffd0a0' });
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
          if (displaced) { f.group.position.set(f.home.x, f.home.y, f.home.z); showBanner(`${flagColorName(f)} FLAG RECOVERED`, { color: '#9bd6ff' }); }
        } else {
          f.carried = true; f.carrier = v; showBanner(`${flagColorName(f)} FLAG TAKEN`, { color: '#' + f.cloth.material.color.getHexString() });
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

// A neutral site on the PERPENDICULAR BISECTOR of the two FOBs: every point on it is
// equidistant from both elevators (fair — favours neither team), and we push out along
// it to a flank so the shield is a contested, hard-to-reach prize rather than sitting in
// one team's lap. Sweeps from far-flank inward, alternating sides, until it hits clear
// land; falls back to the radial neutralSite if the geometry doesn't cooperate.
function bisectorSite(reach) {
  const fobs = camps.filter(c => c.role === 'fob');
  if (fobs.length < 2) return neutralSite(reach);
  const a = fobs[0].center, b = fobs[1].center;
  const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
  let dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
  const px = -dz, pz = dx;                          // perpendicular to the base-to-base line
  const baseOff = Math.min(d * 0.45, reach * 1.4);  // how far out to the flank to try first
  for (let t = 0; t < 80; t++) {
    const sign = (t % 2 === 0) ? 1 : -1;            // try both flanks
    const off = baseOff * (1 - (t / 80) * 0.75) * (0.9 + Math.random() * 0.2);
    const x = mx + px * off * sign, z = mz + pz * off * sign;
    if (!map.isLand(x, z) || blockedAt(x, z)) continue;
    let ok = true;
    for (const c of camps) if (Math.hypot(x - c.center.x, z - c.center.z) < 28) { ok = false; break; }
    if (ok) for (const rp of resupplies) if (Math.hypot(x - rp.pos.x, z - rp.pos.z) < 24) { ok = false; break; }
    if (ok) return { x, z };
  }
  return neutralSite(reach);
}

function placeResupplies() {
  for (const r of resupplies) scene.remove(r.group);
  resupplies = [];
  if (QS.has('nopoi')) return;
  const span = Math.min(map.worldW, map.worldH) / 2;
  const cell = grid.cell;
  // fuel + ammo near the contested middle; the shield generator sits out on the FLANK,
  // on the bisector between the two elevators — equidistant + hard to grab (see bisectorSite).
  const specs = [
    { kind: 'fuel',   r: span * 0.26, make: makeFuelTank,        hp: 130 },
    { kind: 'ammo',   r: span * 0.32, make: makeAmmoDepot,       hp: 150 },
    { kind: 'shield', r: span * 0.52, make: makeShieldGenerator, hp: 110, bisect: true },
  ];
  for (const sp of specs) {
    const site = sp.bisect ? bisectorSite(sp.r) : neutralSite(sp.r);
    if (!site) continue;
    const g = sp.make(cell);
    const gy = map.heightAt(site.x, site.z);
    g.position.set(site.x, gy, site.z);
    scene.add(g);
    const rp = { kind: sp.kind, group: g, pos: new THREE.Vector3(site.x, gy, site.z), radius: cell * 2.2, dead: false };
    applyStaging(g, sp.kind);   // authored fallAt/dmgStyle (if any) before the Destructible reads them
    destructibles.add(new Destructible(g, { type: 'structure', hp: sp.hp, blocks: true, staged: true,
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
// A flag base resupplies only while its HQ still stands — once the building is rubble
// (flag exposed) the wreckage can't rearm/refuel/heal anyone. The FOB (elevator) is a
// separate structure and keeps working.
function flagBaseAlive(team) {
  const f = flags.find(fl => fl.team === team);
  return !(f && f.hqBody && f.hqBody.dead);
}
function nearOwnSupply(v, vx, vz) {
  const main = teamCamp(v.team, 'main'), fob = teamCamp(v.team, 'fob');
  if (main && flagBaseAlive(v.team) && Math.hypot(vx - main.center.x, vz - main.center.z) < 16) return true;
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
// A* passability for a grid cell. It mirrors the player's collision `_blocked` so a
// planned path is one the full-radius hull can actually drive: walls keep nearly the
// collision margin (a path that hugs a fat CORNER tower the nav once thought passable
// but collision didn't sent units grinding into the corner). Gate corridors, roads
// and elevator pads are explicitly open (so the tighter margin can't seal a gate), and
// sinkers still avoid open water. drive()'s full-radius slide handles the final sliver.
function cellBlocked(v, i, j) {
  const c = grid.cell, x = i * c, z = j * c;
  const halfW = map.worldW / 2 + 24, halfH = map.worldH / 2 + 24;
  if (x < -halfW || x > halfW || z < -halfH || z > halfH) return true;
  if (islandBound && x * x + z * z > islandBound * islandBound) return true;
  if (gateCells.has(i + ',' + j)) return false;
  if (roadNet.cells && roadNet.cells.has(i + ',' + j)) return false;
  if (elevatorPadAt(x, z)) return false;
  if (gateSideCells.has(i + ',' + j)) return true;   // a gate flank — force the centre throat
  if (navAvoid.size) {                               // temporary no-go (a spot a unit kept grinding) — NEVER over a gate/road/pad (handled above) so it can't strand
    const e = navAvoid.get(i + ',' + j);
    if (e !== undefined) { if (e > performance.now()) return true; navAvoid.delete(i + ',' + j); }
  }
  const m = v._move;
  if (m.water === 'sink' && map.isDeepWater(x, z)) return true;   // sinkers route around DEEP water; shallow is fordable
  if (!m.ignoreWalls) {
    const margin = VEH_R * 0.9;   // ≈ collision's full VEH_R, so A* won't route into a corner the hull can't enter
    for (const o of obstacles) {
      if (o.body && o.body.dead) continue;           // destroyed wall/tower → A* may route through the gap
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
// Grid cells that contain a tree — the "forest" the Hunter likes to travel through. Built
// once from the foliage scatter (rebuilt on a new match via page reload), looked up cheaply
// in the A* cost. Stays null until foliage exists so we don't cache an empty set early.
let forestCells = null;
function forestHas(k) {
  if (forestCells === null) {
    if (!foliage || !foliage.trees) return false;
    forestCells = new Set();
    const fc = grid.cell;
    for (const t of foliage.trees) forestCells.add(Math.round(t.x / fc) + ',' + Math.round(t.z / fc));
  }
  return forestCells.has(k);
}
function planPath(v, dest) {
  const c = grid.cell;
  const start = { i: Math.round(v.holder.position.x / c), j: Math.round(v.holder.position.z / c) };
  let goal = { i: Math.round(dest.x / c), j: Math.round(dest.z / c) };
  goal = nearestOpenCell(v, goal.i, goal.j, 7) || goal;
  const iMax = Math.ceil(map.worldW / 2 / c) + 10, jMax = Math.ceil(map.worldH / 2 / c) + 10;
  const inBounds = (i, j) => i >= -iMax && i <= iMax && j >= -jMax && j <= jMax;
  const roads = roadNet.cells;
  const arch = v._archetype;
  const onRoad = (i, j) => roads && (roads.has(i + ',' + j) || gateCells.has(i + ',' + j));
  // Personality terrain preference (ai_behavior): each commander has its OWN cheap highway.
  // Warrior (and the player/default) uses ROADS; the Rogue sneaks over OCEAN; the Hunter
  // moves under FOREST cover. The preference only bites for units that can traverse it —
  // cellBlocked already bars sinkers from deep water and light units from trees.
  const cost = (i, j) => {
    if (cellBlocked(v, i, j)) return Infinity;
    if (arch === 'rogue') return !map.isLand(i * c, j * c) ? 0.45 : (onRoad(i, j) ? 0.8 : 1);
    if (arch === 'hunter') return forestHas(i + ',' + j) ? 0.45 : (onRoad(i, j) ? 0.8 : 1);
    return onRoad(i, j) ? 0.5 : 1;   // Warrior + default: roads are the cheap lane
  };
  const path = astarGrid({ start, goal, cost, inBounds, turnPenalty: 3, allowDiagonal: true });
  if (!path || path.length < 2) return null;
  return path.map(n => ({ x: n.i * c, z: n.j * c }));
}

// --- A* search visualizer (debug overlay) ------------------------------------
// Toggle with the `v` key (or RR.astar()). It records the real A* search and lets
// you step/scrub through the frontier expansion. buildGrid(name) hands the viz the
// SAME cost field the game uses, so what you watch is exactly what units/roads see.
let _astarViz = null;
function buildAstarGrid(name) {
  const c = grid.cell;
  if (name === 'road layout') {
    const iMax = Math.floor(map.worldW / 2 / c), jMax = Math.floor(map.worldH / 2 / c);
    return {
      cost: (i, j) => roadNet._cost(i, j),
      inBounds: (i, j) => roadNet._inBounds(i, j),
      bounds: { iMin: -iMax, iMax, jMin: -jMax, jMax },
      allowDiagonal: false, turnPenalty: 6,
    };
  }
  // unit nav: reproduce planPath's cost for a representative live vehicle.
  const rep = player || combatants[0] ||
    { _move: { water: 'sink', ignoreWalls: false, tree: 'bump' }, _archetype: 'warrior' };
  const arch = rep._archetype || 'warrior';
  const roads = roadNet.cells;
  const onRoad = (i, j) => roads && (roads.has(i + ',' + j) || gateCells.has(i + ',' + j));
  const cost = (i, j) => {
    if (cellBlocked(rep, i, j)) return Infinity;
    if (arch === 'rogue') return !map.isLand(i * c, j * c) ? 0.45 : (onRoad(i, j) ? 0.8 : 1);
    if (arch === 'hunter') return forestHas(i + ',' + j) ? 0.45 : (onRoad(i, j) ? 0.8 : 1);
    return onRoad(i, j) ? 0.5 : 1;
  };
  const iMax = Math.ceil(map.worldW / 2 / c) + 2, jMax = Math.ceil(map.worldH / 2 / c) + 2;
  return { cost, inBounds: (i, j) => i >= -iMax && i <= iMax && j >= -jMax && j <= jMax,
    bounds: { iMin: -iMax, iMax, jMin: -jMax, jMax }, allowDiagonal: true, turnPenalty: 3 };
}
// Hover height for the overlay plane: just above the tallest terrain in the grid
// (coarse sample) so the sheet floats over the island, bases poking through.
function astarHoverY() {
  const c = grid.cell, iMax = Math.ceil(map.worldW / 2 / c), jMax = Math.ceil(map.worldH / 2 / c);
  let mx = -Infinity;
  for (let i = -iMax; i <= iMax; i += 4) for (let j = -jMax; j <= jMax; j += 4) {
    const h = map.heightAt(i * c, j * c); if (isFinite(h) && h > mx) mx = h;
  }
  return (isFinite(mx) ? mx : 0) + 8;
}
function toggleAstarViz() {
  if (!_astarViz) _astarViz = new AstarViz();
  if (_astarViz.isOpen) { _astarViz.close(); paused = false; return; }   // resume the sim
  _astarViz.open({
    buildGrid: buildAstarGrid, gridNames: ['unit nav', 'road layout'], defaultGrid: 'unit nav',
    three: THREE, scene, camera, domElement: renderer.domElement, cell: grid.cell, hoverY: astarHoverY(),
  });
  paused = true;   // freeze the sim while inspecting paths, like the full-screen log
}
// Stuck-escalation: after this many seconds genuinely stuck, a unit marks the spot it's
// grinding impassable (avoidCell) and replans AROUND it, instead of repeating forever.
const NAV_BLOCK_AFTER = 6.0;        // seconds stuck before we blacklist the trouble spot + replan
const NAV_AVOID_MS = 5000;          // how long a blacklisted cell stays no-go (then it reopens)
const navAvoid = new Map();         // cellKey "i,j" -> expiry timestamp (ms); temporary A* no-go zones
function avoidCell(x, z) {
  const c = grid.cell, i = Math.round(x / c), j = Math.round(z / c);
  navAvoid.set(i + ',' + j, performance.now() + NAV_AVOID_MS);
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
  // Follow the path LOCALLY: consume the current waypoint only once the unit reaches it
  // (capture radius) or has clearly driven PAST it (it's nearer the NEXT node). Both
  // tests compare just idx vs idx+1, so the index marches forward one step at a time and
  // can NEVER leap to a far waypoint that merely sits near the unit. (Scanning the whole
  // remaining path for the global nearest did exactly that on a curving/staircase road —
  // a later node passes close, idx jumps to it, waypoints vanish off the front and the
  // unit veers off-road chasing it, until the next replan resets it. That was the jitter.)
  const px = v.holder.position.x, pz = v.holder.position.z;
  while (nav.idx < nav.path.length - 1) {
    const w = nav.path[nav.idx], nx = nav.path[nav.idx + 1];
    const dCur = (w.x - px) ** 2 + (w.z - pz) ** 2;
    if (dCur < (c * 1.2) ** 2) { nav.idx++; continue; }    // reached this waypoint
    if ((nx.x - px) ** 2 + (nx.z - pz) ** 2 < dCur) { nav.idx++; continue; }   // driven past it (nearer the next)
    break;
  }
  return nav.path[nav.idx];
}
// Steer a vehicle toward a world point. SQUARE UP before committing forward: pivot in
// place when badly mis-aimed, ease in at part-throttle while lining up, and only run at
// full speed once roughly on heading. The old 69° gate let a slow tank charge forward
// at up to 69° off and arc straight into a gate jamb / wall corner instead of turning to
// face the gap first. drive() still slides on the fine bit.
function steerToward(v, wx, wz) {
  const dx = wx - v.holder.position.x, dz = wz - v.holder.position.z;
  const err = wrapPi(Math.atan2(-dx, -dz) - v.heading);
  const a = Math.abs(err);
  const fwd = a > 0.6 ? 0 : a > 0.25 ? 0.45 : 1;   // >34° pivot in place; 14–34° crawl + turn; <14° full
  // Small deadzone near zero so a unit that's basically on-heading drives STRAIGHT
  // instead of micro-correcting left/right every frame (the "shaking its head" wobble).
  const turn = a < 0.06 ? 0 : Math.max(-1, Math.min(1, err * 2.2));
  return { fwd, turn };
}

class AICommander {
  constructor(team, archetype = null) {
    this.team = team;
    this.personality = randomPersonality();
    this.archetype = archetype || pickArchetype(Math.random);   // named doctrine (Warrior/Turtle/...) — drives the whole plan
    // The doctrine shapes disposition: both archetypes FIGHT and finish a routed enemy
    // (pursue needs aggression > 0.6). A Warrior presses hardest; a Turtle is still
    // willing to chase a repelled attacker — it just holds a defensive post to do it.
    const aggMin = this.archetype === 'warrior' ? 0.75 : this.archetype === 'turtle' ? 0.66 : 0;
    if (this.personality.aggression < aggMin) this.personality.aggression = aggMin;
    this.colorIndex = null;
    this.started = false;
    this.unit = null;
    this.respawnT = 0;
    this.deaths = 0;
    this.kills = 0;                                   // enemy vehicles this commander's units have downed
    this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, null, m => aiLog(this.team, `${this.cname} ${m}`));   // the archetype's mission doctrine
    this.fortHp0 = null;                              // enemy fort HP when this card started
    this.seenTypes = {};                              // rival vehicle types this team has spotted
    this.knownSupplies = new Set();                   // fog-of-war: resupply POIs this team has SCOUTED
    this.knownElev = false;                           // scouted the enemy FOB/elevator yet?
    this.knownFlag = false;                           // scouted the enemy flag HQ yet?
    this._knownSig = '';                              // last logged known-POI signature (log only on change)
    this.explore = new ExploreMemory(map.worldW, map.worldH);   // coarse "where have we looked" grid
    this._exploreWp = null;                           // current recon waypoint (held until reached)
    this.roster = { ...GARAGE_COUNTS };               // finite fleet, same numbers as the player's garage; a death removes one
    this._eliminated = false;                         // true once the roster is empty (no more vehicles to field)
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
  enemyFobPos() { return teamCenter(this.targetTeam(), 'fob'); }   // where the enemy's units rise — the Warrior hunts here
  homeBasePos() { return teamCenter(this.team, 'main'); }           // our own flag base
  // Comma-list of the points this team has SCOUTED (for the known-POI log readout):
  // discovered supply depots by kind + the enemy elevator/flag once seen.
  _knownSummary() {
    const kinds = new Set();
    for (const rp of this.knownSupplies) if (!rp.dead) kinds.add(rp.kind);
    const parts = [];
    if (kinds.has('ammo')) parts.push('AMO');
    if (kinds.has('fuel')) parts.push('FUL');
    if (kinds.has('shield')) parts.push('SHD');
    if (this.knownFlag) parts.push('FLG');     // enemy flag HQ
    if (this.knownElev) parts.push('ELV');     // enemy elevator/FOB
    return parts.length ? parts.join(' ') : 'none';
  }
  // Have we ever laid eyes on an enemy vehicle? (drives Hunter scout → attack)
  knowsEnemy() { return Object.keys(this.seenTypes).length > 0; }
  // The enemy's last-known position, if seen recently (else null → fall back to the
  // elevator). Lets the Attack mission "recall the last known location" (ai_behavior).
  lastEnemyPos() {
    const s = this._lastEnemyPos;
    return s && (performance.now() - s.t) < 12000 ? { x: s.x, z: s.z } : null;
  }
  // Is the target team out of the fight for good — no live unit AND its commander is
  // eliminated? (A human team has no commander and can always redeploy, so never "out".)
  // Lets a mission like the Hunter's hunt END instead of firing at an empty elevator.
  enemyEliminated() {
    const tt = this.targetTeam();
    for (const o of combatants) if (!o.dead && o.team === tt) return false;
    const ec = commanders.find(c => c.team === tt);
    return !!(ec && ec._eliminated);
  }
  // A holding spot to the SIDE of our flag base — on the enemy-facing edge but offset
  // off the approach lane, inside tower cover. The Turtle ambushes from here and flanks
  // an attacker, instead of huddling on the flag HQ (which is what looked too passive).
  ambushSpot() {
    const base = this.homeBasePos(), enemy = this.enemyBasePos();
    let dx = enemy.x - base.x, dz = enemy.z - base.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;            // unit vector toward the threat
    const px = -dz, pz = dx;                                        // perpendicular = "to the side"
    const side = this.team === 'red' ? 1 : -1;                      // each team commits to one flank
    const FWD = 18, SIDE = 26;                                      // forward a touch, well to the side, still in tower range
    return { x: base.x + dx * FWD + px * SIDE * side, z: base.z + dz * FWD + pz * SIDE * side };
  }
  // A patrol that sweeps the CORRIDOR between our two bases — the flag HQ (rear) and the
  // elevator (forward) — so a defending Turtle covers everything it has to protect instead
  // of pacing one base (the old loop huddled on the flag HQ, which read as too passive).
  // Each waypoint is nudged toward the threat so the route hugs the enemy-facing side of
  // the corridor (where an attacker comes from), still on home ground in tower cover. The
  // index advances as the unit nears its waypoint, oscillating flag↔mid↔elevator↔mid, so it
  // never settles. The brain still drops into engage the instant it spots an attacker —
  // this only fills the idle "nothing in sight" time.
  patrolSpot() {
    const flag = this.homeBasePos(), fob = this.homePos(), enemy = this.enemyBasePos();
    if (!this._patrol) {
      const mid = { x: (flag.x + fob.x) / 2, z: (flag.z + fob.z) / 2 };
      let tx = enemy.x - mid.x, tz = enemy.z - mid.z;
      const td = Math.hypot(tx, tz) || 1; tx /= td; tz /= td;       // unit vector toward the threat
      const NUDGE = 16;                                             // lean the route toward the enemy-facing edge
      const at = (b) => ({ x: b.x + tx * NUDGE, z: b.z + tz * NUDGE });
      this._patrol = [ at(flag), at(mid), at(fob), at(mid) ];       // flag → mid → elevator → mid → …
      this._patrolI = 0;
    }
    const wp = this._patrol[this._patrolI];
    if (this.unit) {
      const u = this.unit.holder.position;
      if (Math.hypot(u.x - wp.x, u.z - wp.z) < 12) this._patrolI = (this._patrolI + 1) % this._patrol.length;
    }
    return this._patrol[this._patrolI];
  }
  flag() { return enemyFlagOf(this.team); }
  // Our OWN flag (the one a rival steals). ourFlagStolen → a live enemy is carrying it.
  ourFlag() { return flags.find(f => f.team === this.team) || null; }
  ourFlagStolen() { const f = this.ourFlag(); return !!(f && f.carried && f.carrier && !f.carrier.dead && f.carrier.team !== this.team); }
  // Our flag base has lost all its turrets → a defender can't lean on tower cover and
  // should switch to a Valkyrie's mobility (ai_behavior Defend).
  ownTowersDown() { return turretCountOf(this.team) === 0; }
  // DEFEND intercept point (ai_behavior): chase the carrier directly; if it's somehow
  // out of play fall back to the enemy's elevator — where they must take it to score.
  interceptSpot() {
    const f = this.ourFlag();
    if (f && f.carried && f.carrier && !f.carrier.dead) { const c = f.carrier.holder.position; return { x: c.x, z: c.z }; }
    return this.enemyFobPos();
  }
  // Nearest KNOWN, live shield generator to (x,z) — only POIs this team has discovered
  // (fog-of-war), so a commander won't beeline to a generator it's never seen.
  nearestKnownShield(x, z) {
    let best = null, bd = Infinity;
    for (const rp of this.knownSupplies) {
      if (rp.dead || rp.kind !== 'shield') continue;
      const d = (rp.pos.x - x) ** 2 + (rp.pos.z - z) ** 2;
      if (d < bd) { bd = d; best = rp; }
    }
    return best;
  }
  fortFrac() { return this.fortHp0 ? fortHpOf(this.targetTeam()) / this.fortHp0 : 1; }
  // Only the FLAG-HQ (main camp) turrets gate the win — they guard the flag. The
  // FOB/elevator turrets are optional (a unit still suppresses one that's shooting it,
  // but they no longer hold back the runner or inflate the "towers left" readout).
  turretsLive() { return turretCountOf(this.targetTeam(), 'main'); }
  // Tower-first: the flag-HQ is "breached" (safe to send a Firebrat runner) only once
  // ALL its turrets are down. A single live tower over the flag will shred the runner on
  // the grab, so we don't commit one until the defenses are fully silenced.
  fortDown() { return this.turretsLive() === 0; }
  // The runner only goes when the flag is both EXPOSED (HQ building rubble) and its
  // turrets are DOWN — otherwise it's sent to die over a guarded or sealed flag.
  flagGrabbable() { return this.flagExposed() && this.fortDown(); }
  // The enemy flag is sealed inside its HQ until that building is rubble. The
  // runner can't grab it before then, so the heavy must finish the HQ first —
  // strategy cards gate the open→grab handoff on this.
  flagExposed() { const f = this.flag(); return !!(f && f.revealed); }
  // A staging point on the FAR (back) side of the enemy flag base — past its centre,
  // away from the lane our units approach on. A Rogue runner curls around to here to slip
  // in the BACK instead of the hot front (ai_behavior Capture).
  enemyRearApproach() {
    const base = this.enemyBasePos(), from = this.homePos();
    let dx = base.x - from.x, dz = base.z - from.z;
    const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
    return { x: base.x + dx * 30, z: base.z + dz * 30 };
  }
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
    // Don't ask for a counter we've run out of — fall back to one we still have.
    const c = (topType && COUNTER[topType]) || 'lurcher';
    return (this.roster[c] || 0) > 0 ? c : (this._pickAvailableType(c) || c);
  }
  // Total vehicles this commander has left to field (the fielded unit still counts).
  fleetLeft() { let n = 0; for (const k in this.roster) n += this.roster[k]; return n; }
  // The type to actually field: the wanted one if any remain, else a same-class
  // substitute, else whatever we have most of, else null (roster empty → eliminated).
  _pickAvailableType(want) {
    const have = t => this.roster[t] || 0;
    // Substitute by ROLE, not raw speed. The Valkyrie is a base-ATTACKER (like the
    // heavies); the Firebrat is the fragile flag RUNNER. The old by-speed grouping fell a
    // dead-Valkyrie siege role back to a Firebrat (both "fast") and shoved a paper-thin
    // runner into a tower duel — it got shredded. A wanted SIEGER substitutes another
    // sieger (Jotun first, then Lurcher); a wanted runner has no real stand-in.
    const pool = want === 'firebrat' ? [] : ['jotun', 'lurcher', 'valkyrie'];
    // SAVE THE LAST OF A TYPE: don't burn a type's FINAL vehicle while another type still
    // has 2+ to spare — hold each type's last unit in reserve for the endgame. So a brain
    // that wants a type it's down to one of (or out of) fields an abundant same-role
    // substitute first. (Firebrats are the only runner, so they have no stand-in and skip
    // this — the Hunter's own firebrat reserve handles saving those for the capture.)
    if (have(want) >= 2) return want;                      // plenty of the wanted type — use it
    const richSub = pool.filter(t => t !== want && have(t) >= 2);
    if (richSub.length) { richSub.sort((a, b) => have(b) - have(a)); return richSub[0]; }
    // Nothing abundant left to spare — everything's down to its last, so it's now fine to
    // spend a final unit: the wanted type if any remain, else a same-role sub, else
    // whatever we have most of (e.g. a firebrat-only fleet).
    if (have(want) > 0) return want;
    const sub = pool.filter(t => t !== want && have(t) > 0);
    if (sub.length) return sub[0];
    const any = Object.keys(this.roster).filter(t => have(t) > 0);
    if (!any.length) return null;
    any.sort((a, b) => have(b) - have(a));   // last resort (e.g. a firebrat-only fleet) — most numerous
    return any[0];
  }
  // A recon waypoint into unexplored map, held until the unit reaches it, then advanced
  // to the next — so a scout sweeps the island outward instead of beelining the base.
  // Returns null once the map is mostly known (the card then falls back to its real goal).
  exploreTarget() {
    const v = this.unit; if (!v) return null;
    if (this.explore.fraction() > 0.8) return null;        // map's mostly mapped — stop wandering
    const px = v.holder.position.x, pz = v.holder.position.z;
    if (this._exploreWp) {
      // Clear (and repick a farther) waypoint BEFORE the unit gets close enough that the
      // seek behavior parks on it (it stops within arriveDist). If the clear-radius were
      // smaller than arriveDist, a waypoint landing in that dead zone would freeze the
      // scout: arrived (so it stops) but not cleared (so it never picks a new target).
      const reach = this.strategy.arriveDist(this) + 8;
      if ((this._exploreWp.x - px) ** 2 + (this._exploreWp.z - pz) ** 2 < reach * reach) this._exploreWp = null;
    }
    if (!this._exploreWp) { const home = this.homePos(); this._exploreWp = this.explore.pickTarget(px, pz, home.x, home.z); }
    return this._exploreWp;
  }

  // Log label = this team's palette colour name (PURPLE, CYAN…), so a log line reads
  // as the colour the team actually wears on the field — clearer than a flavour name.
  get cname() { return teamLabel(this.colorIndex); }

  // Draw a fresh card (on repeated losses / stalls) — keeps the AI unpredictable.
  redraw() { this.strategy = makeDoctrine(this.archetype, this.personality, Math.random, this.strategy.constructor, m => aiLog(this.team, `${this.cname} ${m}`)); this.fortHp0 = fortHpOf(this.targetTeam()) || this.fortHp0; this.failStreak = 0; aiLog(this.team, `${this.cname} regroups (new plan)`); }

  deploy() {
    const want = this.strategy.wantVehicle(this);
    const type = this._pickAvailableType(want);
    if (!type) {                               // roster empty — this commander is out of the fight
      this.unit = null;
      if (!this._eliminated) { this._eliminated = true; aiLog(this.team, `${this.cname} has no vehicles left`); }
      return;
    }
    this._stepAtDeploy = this.strategy.step;   // lock the type for this step — no mid-step churn
    this._recalling = false;
    const sub = type !== want ? ` (out of ${want})` : '';
    aiLog(this.team, `${this.cname} deploys ${type}${sub} — ${this.fleetLeft()} left`);
    const home = this.homePos();
    const v = new Vehicle(type); v.setScale(0.72);
    v.setCamo(this.colorIndex); v.setTeamColor(TEAM_COLORS[this.colorIndex].hex);
    scene.add(v.group);
    initCombatant(v, this.team, this.colorIndex, false);
    v.ai = new Brain(this.personality);
    v._archetype = this.archetype;   // drives the nav terrain preference (Rogue ocean / Hunter forest)
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
        ? `${this.cname}: enemy turrets CLEAR — breaching HQ`
        : `${this.cname}: turret down — ${liveTowers} enemy turrets left`);
      this._lastTowers = liveTowers;
    } else if (liveTowers > this._lastTowers) { this._lastTowers = liveTowers; }   // match reset
    // MOVEMENT HEALTH — the half the log was missing: it showed INTENT ("assault turret")
    // but not whether the unit is actually getting there. Compare real ground covered vs
    // intent; when it wants to move but isn't, rack up stuck-time and name a likely cause.
    const pX = v.holder.position.x, pZ = v.holder.position.z;
    const step = this._lpx != null ? Math.hypot(pX - this._lpx, pZ - this._lpz) : 1;
    this._lpx = pX; this._lpz = pZ;
    const wantsMove = Math.abs(cmd.fwd) > 0.2 || Math.abs(cmd.turn) > 0.5 || cmd.state === 'engage';
    if (wantsMove && step < view.dt * 0.8) this._stuckT = (this._stuckT || 0) + view.dt; else this._stuckT = 0;
    let stuckWhy = '';
    if (this._stuckT > 0.6) {
      stuckWhy = !map.isLand(pX, pZ) ? 'in water'
        : view.blockedAhead ? 'wall/obstacle ahead'
        : (view.blockedLeft && view.blockedRight) ? 'boxed in'
        : 'wedged on terrain';
    }
    this._dbg = {
      name: this.cname, type: v.type, state: cmd.state,
      stuck: this._stuckT > 0.8 ? +this._stuckT.toFixed(1) : 0, stuckWhy,
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +cmd.fwd.toFixed(2), turn: +cmd.turn.toFixed(2),
      blk: (view.blockedLeft ? 'L' : '·') + (view.blockedAhead ? 'A' : '·') + (view.blockedRight ? 'R' : '·'),
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel), shield: Math.round(v.shield),
      distFob: Math.round(Math.hypot(v.holder.position.x - fob.x, v.holder.position.z - fob.z)),
      px: Math.round(v.holder.position.x), pz: Math.round(v.holder.position.z),
      gx: view.goal ? Math.round(view.goal.x) : null, gz: view.goal ? Math.round(view.goal.z) : null,
      towers: this.turretsLive(),   // enemy turrets still standing (tower-first ordering)
    };
    if (cmd.state !== prev) {
      // Plain-language state line: WHAT the unit is doing and WHERE/AT-WHAT, plus the
      // active strategy card in [brackets]. The wording deliberately distinguishes the
      // two combat states the bare names conflate — `engage` is duelling a moving enemy
      // VEHICLE, `suppress` is shelling a static enemy TOWER.
      const card = (this.strategy.constructor.name || 'Card').replace('Strategy', '');
      const dest = this._intercepting ? 'to intercept the flag runner!'
        : this._shielding ? 'to grab a shield'
        : (this.strategy.objectiveLabel ? this.strategy.objectiveLabel(this) : 'the objective');
      const hpPct = Math.round(v.hp / v.maxHp * 100);
      let line;
      switch (cmd.state) {
        case 'exit':     line = `rolling out → ${dest}`; break;
        case 'advance':  line = `advancing → ${dest}`; break;
        case 'flee':     line = `dodging the enemy → ${dest}`; break;
        case 'pursue':   line = 'chasing the last-seen enemy'; break;
        case 'retreat':  line = `falling back to heal (hp ${hpPct}%)`; break;
        case 'resupply': line = v.ammo <= 0 ? 'returning to rearm (out of ammo)' : `returning to refuel (fuel ${Math.round(v.fuel / v.maxFuel * 100)}%)`; break;
        case 'engage':   line = `engaging enemy ${view.enemy ? view.enemy.type : 'vehicle'}`; break;
        case 'suppress': {
          const inPos = view.threatStand && Math.hypot(view.threatStand.x - v.holder.position.x, view.threatStand.z - v.holder.position.z) <= 6;
          line = `${inPos ? 'shelling a turret' : 'skirting to isolate a turret'} (${this.turretsLive()} left)`;
          break;
        }
        case 'assault':  line = `sieging ${dest} (${this.turretsLive()} turrets left)`; break;
        default:         line = cmd.state;
      }
      aiLog(this.team, `${this.cname} ${v.type}: ${line} [${card}]`);
    }
  }

  // Path-follow the long-haul TRAVEL states with A* (advance to the objective, run
  // home to resupply/retreat, close to siege standoff). Combat (engage/suppress),
  // the gate exit, and the unstick reflex keep their own tuned steering. Flyers go
  // straight. Falls back to the brain's seek when there's no route.
  _navOverride(v, view, cmd, dt) {
    if (v._move.ignoreWalls) return;
    if (cmd.breakAim) return;     // brain is squaring up to shoot a blocker — don't steer it around
    const st = cmd.state;
    let dest = null, slack = 9;
    if (st === 'exit') { dest = this._exit || this.strategy.objective(this); slack = 5; }   // thread the gate via A*
    // Use the RESOLVED goal the brain is acting on (view.goal already folds in the shield-grab
    // and intercept detours), not the raw mission objective — else a ground unit's A* steers it
    // to the patrol/objective spot while it claims to be "grabbing a shield" and never gets there.
    else if (st === 'advance') dest = view.goal || this.strategy.objective(this);
    else if (st === 'pursue') dest = v.ai.lastSeen || this.strategy.objective(this);
    else if (st === 'retreat') dest = this._home;          // heal at own base (only place HP regens)
    else if (st === 'resupply') dest = this._supply;       // nearest fuel/ammo (own base or a depot)
    else if (st === 'assault') { dest = this.strategy.objective(this); slack = (view.engageRange || 36) * 0.7 * 1.25; }
    else { if (st === 'unstick') this._nav.path = null; return; }   // engage/suppress: steer as-is; unstick: drop the route so it replans fresh after the jolt (not straight back into the wall)
    if (!dest) return;
    const d2 = (dest.x - v.holder.position.x) ** 2 + (dest.z - v.holder.position.z) ** 2;
    if (d2 < slack * slack) return;                 // close enough — hand back to the behavior
    // ESCALATION: when a unit has been genuinely stuck a long time (the local jolt + the
    // routine replan didn't break it), the PATH itself is the problem — it keeps routing
    // back into the same spot. So mark that spot impassable for a few seconds and replan
    // a REAL way around it. This preserves a valid, obstacle-avoiding route (the old "skip
    // ahead N nodes" just aimed at a far waypoint in a straight line, cutting across
    // everything the path was avoiding — turning a good path into a bad one).
    if (this._stuckT > NAV_BLOCK_AFTER) {
      const hx = -Math.sin(v.heading), hz = -Math.cos(v.heading);
      avoidCell(v.holder.position.x + hx * VEH_R, v.holder.position.z + hz * VEH_R);   // the obstacle right at the nose
      this._nav.path = null;                         // force a replan that routes around it
      this._stuckT = NAV_BLOCK_AFTER * 0.4;          // back off the timer (don't re-fire every tick; re-escalate if still stuck)
    }
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
    // Compare against the type we'd ACTUALLY field (after save-last / role substitution),
    // not the raw role want — otherwise a unit that's already the best available substitute
    // gets recalled to "swap" for a wanted type we'd only re-substitute right back to it.
    const want = this._pickAvailableType(this.strategy.wantVehicle(this));
    this._stepAtDeploy = this.strategy.step;                        // consume the step change either way
    if (!want || this.unit.type === want) return;                  // new beat wants the same vehicle → carry on
    this._recalling = true;
    this._recallBestD = Infinity;                                  // closest we've gotten to home so far
    this._recallStallT = 0;                                        // time since we last made headway toward home
    this._nav.path = null;                                          // replan toward home
    aiLog(this.team, `${this.cname} pulls ${this.unit.type} home to swap for ${want}`);
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
    // PROGRESS-based recall: a unit gets as long as it needs to crawl home (a slow Jotun
    // from across the map is fine — that's the game). We only give up if it makes NO
    // headway toward home for a while = TRULY wedged (the nav stuck-escalation couldn't
    // free it). Any new closest-to-home distance resets the stall clock.
    const RECALL_STALL = 10;                                       // s of zero progress = stuck
    if (d < this._recallBestD - 0.5) { this._recallBestD = d; this._recallStallT = 0; }
    else this._recallStallT += dt;
    const stuck = this._recallStallT > RECALL_STALL;
    if (d < reach || stuck) {
      aiLog(this.team, `${this.cname} ${v.type} ${d < reach ? 'home — swapping' : 'stuck, no progress home — swapping'}`);
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
      name: this.cname, type: v.type, state: 'return-to-base',
      card: (this.strategy.constructor.name || 'Card').replace('Strategy', ''),
      fwd: +s.fwd.toFixed(2), turn: +s.turn.toFixed(2), blk: '···',
      hp: Math.round(v.hp / v.maxHp * 100), ammo: v.ammo, fuel: Math.round(v.fuel), distFob: Math.round(d),
      towers: this.turretsLive(),
    };
  }

  update(dt) {
    // Notify once the moment the enemy fleet is wiped — instead of a unit silently
    // wandering off to "chase the last seen enemy" that no longer exists.
    if (!this._enemyGoneAnnounced && this.enemyEliminated()) {
      this._enemyGoneAnnounced = true;
      aiLog(this.team, `${this.cname} — enemy fleet destroyed, pressing the base`);
    }
    if (!this.unit || this.unit.dead) {
      if (this.unit && this.unit.dead) {
        this.deaths++;
        this.failStreak = (this.failStreak || 0) + 1;
        const lost = this.unit.type;                 // attrition: that vehicle is gone from the roster
        if (this.roster[lost] != null) this.roster[lost] = Math.max(0, this.roster[lost] - 1);
        // A runner died storming the base → the approach isn't safe yet. Go BACK to
        // softening (send a heavy to finish the towers) instead of feeding another
        // Firebrat into the exact same death.
        if (this.unit.type === 'firebrat' && this.strategy.step === 'capture') {
          this.strategy.onRunnerLost(this);
          aiLog(this.team, `${this.cname} runner down — re-softening (towers still up)`);
        }
        // Keep losing the same way? Each repeat raises the odds of a brand-new plan — but
        // only for legacy deck commanders. An archetype keeps its doctrine (losing a unit
        // mid-siege shouldn't restart the whole plan from scratch); it just redeploys.
        if (!this.archetype && Math.random() < Math.min(0.85, 0.25 + this.failStreak * 0.2)) this.redraw();
      }
      this.unit = null;
      this._rising = false; this._recalling = false;
      this.respawnT -= dt;
      if (this.started && !this._eliminated && this.respawnT <= 0) { this.respawnT = 4 + Math.random() * 3; this.deploy(); }
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
    v._aiState = cmd.state;                 // exposed so a rival's _view can tell this unit is retreating ("finish him")
    this._navOverride(v, view, cmd, dt);   // route travel states with A* (around water/trees, through gates)
    this._logTick(v, view, cmd);
    const out = burnFuel(v, { fwd: cmd.fwd, turn: cmd.turn, strafe: cmd.strafe || 0 }, dt);
    v._throttle = Math.min(1, Math.abs(out.fwd) + Math.abs(out.turn) * 0.6 + Math.abs(out.strafe || 0) * 0.6);   // for spatial engine RPM
    v.drive(dt, out.fwd, out.turn, null, v._blocked, out.strafe || 0);
    applyAltitude(v, dt);
    decayAim(v, dt);
    if (v.dead) { this.unit = null; this.respawnT = 4; this._rising = false; return; }
    v.cooldown -= dt;
    // Fire at the current target: a suppressed wall-turret (aimed at its raised head so
    // the slug arcs up). With NO clean line to it (a wall/HQ blocks the shot) a siege
    // unit aims LOW instead — at the obstruction — so the shell demolishes a path through
    // rather than arcing uselessly over the wall at a turret it can't reach.
    if (cmd.fire && v.cooldown <= 0) {
      let tp = null, atEnemy = false;
      if (cmd.state === 'suppress' && view.threat) {
        tp = (!view.threatLOS && view.demolishTarget)
          ? _aimDir.set(view.demolishTarget.x, view.demolishTarget.y, view.demolishTarget.z).clone()
          : _aimDir.set(view.threat.x, view.threat.y, view.threat.z).clone();
      }
      else if (view.enemy) { tp = leadAim(v.holder.position, view.enemy, v.def.soundIndex, v.ai.p.jitter).clone(); atEnemy = true; }   // lead a moving target (Lurcher/Valkyrie/Jotun; charge-compensated for the railgun)
      else if (cmd.breakAim) tp = _aimDir.set(cmd.breakAim.x, cmd.breakAim.y, cmd.breakAim.z).clone();   // blasting a blocker out of the way
      fireVehicle(v, false, tp, null, atEnemy);
    }
  }

  _view(v, dt) {
    const px = v.holder.position.x, pz = v.holder.position.z, h = v.heading;
    const flyer = v._move.ignoreWalls;
    this.explore.mark(px, pz, AI_VISION * 0.7);   // paint this patch of map "known" for the team's recon memory
    let seesEnemy = false, enemy = null, seen = null, best = AI_VISION * AI_VISION;
    // Local-brawl headcount for the fight-or-flight weight: how many rivals vs friendlies
    // are within striking distance of THIS unit (so it breaks off a losing gang-fight and
    // presses when it has the numbers). Counted by proximity (LOS-independent — being
    // surrounded matters even if one foe ducks behind cover for a beat).
    let enemiesNear = 0, alliesNear = 0;
    const FIGHT_R2 = 48 * 48;
    for (const o of combatants) {                       // nearest VISIBLE rival of any other team
      if (o.dead || vehicleHidden(o)) continue;          // a unit still down the lift shaft isn't on the field yet
      const d = (o.holder.position.x - px) ** 2 + (o.holder.position.z - pz) ** 2;
      if (o.team === this.team) { if (o !== v && d < FIGHT_R2) alliesNear++; continue; }
      if (d < FIGHT_R2) enemiesNear++;
      if (d < best && (flyer || hasLOS(px, pz, o.holder.position.x, o.holder.position.z))) {
        best = d; enemy = { x: o.holder.position.x, y: o.holder.position.y, z: o.holder.position.z, type: o.type, shield: o.shield, vx: o._vx || 0, vz: o._vz || 0,
          hpFrac: o.maxHp ? o.hp / o.maxHp : 1, retreating: o._aiState === 'retreat' || o._aiState === 'resupply' }; seen = o; seesEnemy = true;
      }
    }
    // Remember WHERE the enemy was last seen (team-shared) so the Attack mission can recall
    // their last-known position instead of only marching to the fixed elevator (ai_behavior).
    if (seen) this._lastEnemyPos = { x: enemy.x, z: enemy.z, t: performance.now() };
    // HEARING: if it can't SEE a rival, it may still HEAR one — engine drone from movers +
    // gunfire reports, damped by its own engine noise (same model as the player's sound HUD).
    // A heard contact is intel, NOT a firing solution — it only updates the team's last-known
    // enemy position so the unit investigates the noise instead of staying blind. enemy/
    // seesEnemy stay line-of-sight, so it still has to round the corner to actually shoot.
    let heard = null;
    if (!seesEnemy) {
      let loudest = null;
      for (const s of soundSources(v)) if (!loudest || s.loud > loudest.loud) loudest = s;
      if (loudest && loudest.loud > AI_HEARD_MIN) {
        heard = { x: loudest.pos.x, z: loudest.pos.z, loud: loudest.loud };
        this._lastEnemyPos = { x: heard.x, z: heard.z, t: performance.now(), heard: true };
      }
    }
    // Fog-of-war intel: remember what the enemy keeps fielding so counterVehicle() works.
    if (seen) this.seenTypes[seen.type] = (this.seenTypes[seen.type] || 0) + 1;
    // DISCOVER nearby supply points — the team only "knows" a depot once one of its
    // units has come within sight of it (LOS for ground units; flyers see over walls).
    // Discoveries are remembered on the commander, so the team keeps the intel even
    // after this unit dies and a new one deploys. The shield generator is a TALL glowing
    // beacon, so it's spotted from much further off than a low fuel/ammo crate — a unit
    // out on the field sees it across the map (still needs LOS, so it's earned, not given).
    // That's what makes the flank generator actually get discovered + used.
    for (const rp of resupplies) {
      if (rp.dead || this.knownSupplies.has(rp)) continue;
      const sight = rp.kind === 'shield' ? AI_VISION * 2.6 : AI_VISION;
      const d2 = (rp.pos.x - px) ** 2 + (rp.pos.z - pz) ** 2;
      if (d2 < sight * sight && (flyer || hasLOS(px, pz, rp.pos.x, rp.pos.z))) this.knownSupplies.add(rp);
    }
    // Same fog-of-war for the enemy's key STRUCTURES (its FOB/elevator + flag HQ): the
    // team only "knows" one once a unit has come within sight of it (tall towers carry, so
    // a wider sight than a crate; LOS for ground). Tracked for the known-POI log readout.
    {
      const bSight = AI_VISION * 2.0;
      if (!this.knownElev) { const e = this.enemyFobPos(); const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2; if (d2 < bSight * bSight && (flyer || hasLOS(px, pz, e.x, e.z))) this.knownElev = true; }
      if (!this.knownFlag) { const e = this.enemyBasePos(); const d2 = (e.x - px) ** 2 + (e.z - pz) ** 2; if (d2 < bSight * bSight && (flyer || hasLOS(px, pz, e.x, e.z))) this.knownFlag = true; }
    }
    // The set of points this team is aware of is read live into the log's per-team box
    // (a persistent status line), so it's no longer logged as a rolling event.
    let goal = this.strategy.objective(this);
    // DEFEND override (ai_behavior): if a rival is running off with OUR flag, abandon the
    // plan and chase the carrier toward its delivery point — so a stolen flag is always
    // contested. Skip it if WE'RE carrying the enemy flag (don't blow a winning run).
    this._intercepting = false;
    if (this.ourFlagStolen() && !(this.flag() && this.flag().carrier === v)) {
      const ip = this.interceptSpot();
      if (ip) { goal = ip; this._intercepting = true; }
    }
    // ATTACK prep (ai_behavior): a Lurcher/Valkyrie rolling out with little shield swings
    // by a KNOWN, nearby shield generator to armour up first. (Firebrats run — speed is
    // their armour; Jotuns siege — too slow to detour. Intercept always outranks this.)
    this._shielding = false;
    if (!this._intercepting && (v.type === 'lurcher' || v.type === 'valkyrie')
        && v.maxShield > 0 && v.shield < v.maxShield * 0.6
        && !(this.flag() && this.flag().carrier === v)) {
      const gen = this.nearestKnownShield(px, pz);
      // Detour distance scales with how EMPTY the shield is: a fresh unit (0 armour) will
      // go well out of its way to top up (×1.6), one already half-full barely diverts (×1).
      // So armour-capable units reliably swing by the generator on the way out, instead of
      // only grabbing it when it happens to be right next to them.
      const reach = SHIELD_GRAB_RANGE * (1.6 - v.shield / v.maxShield);
      if (gen && Math.hypot(gen.pos.x - px, gen.pos.z - pz) < reach) {
        goal = { x: gen.pos.x, z: gen.pos.z }; this._shielding = true;
      }
    }
    // Where to rearm/refuel: the NEAREST valid source for what we need — own base
    // (always restocks fuel + ammo) OR a DISCOVERED neutral depot. A neutral depot gives
    // just ONE resource, so we only divert to one when topping it gets the unit combat-
    // ready (the OTHER resource is still OK enough to fight/move on — config fuelOK 0.25 /
    // ammoOK 0.5, matching the depot latch-clear). Only when BOTH are genuinely low does it
    // trek to base for the full top-off + heal — otherwise it tops the one thing the depot
    // offers, the latch (which still wants the other) stays stuck, and it camps the tank
    // forever (the "Jotun parked at a fuel supply" bug). NOTE: a unit that ran dry on AMMO
    // with HALF a tank used to be dragged all the way to base, because "low fuel" was set
    // at <0.5 — far above the point fuel actually needs topping. Now it grabs ammo at the
    // nearest depot and gets back in the fight, refuelling separately only if fuel gets low.
    const fob = teamCamp(this.team, 'fob'), home = teamCamp(this.team, 'main');
    const needAmmo = v.ammo < v.maxAmmo * 0.6;      // want to top ammo (config.ammoFull)
    const needFuel = v.fuel < v.maxFuel * 0.5;      // want to top fuel (config.fuelFull)
    const fuelOk = v.fuel >= v.maxFuel * 0.25;      // still enough gas to keep going (config.fuelOK)
    const ammoOk = v.ammo >= v.maxAmmo * 0.5;       // still enough rounds to keep fighting (config.ammoOK)
    let supply = null, bestD = Infinity, supplyHeals = false;
    // isBase = an OWN base (restocks fuel + ammo AND patches the hull); a depot does not.
    const consider = (x, z, isBase) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < bestD) { bestD = d; supply = { center: { x, z } }; supplyHeals = isBase; } };
    if (fob) consider(fob.center.x, fob.center.z, true);
    if (home && flagBaseAlive(this.team)) consider(home.center.x, home.center.z, true);   // a levelled flag base resupplies no one
    // Divert to a single-resource depot when it fixes the actual need AND the other
    // resource is still OK (so the latch will clear there). Both genuinely low → base only.
    const depotKind = (needAmmo && fuelOk) ? 'ammo' : (needFuel && ammoOk) ? 'fuel' : null;
    if (depotKind) for (const rp of resupplies) if (!rp.dead && rp.kind === depotKind && this.knownSupplies.has(rp)) consider(rp.pos.x, rp.pos.z, false);
    this._supply = supply ? { x: supply.center.x, z: supply.center.z } : null;   // nav target while resupplying
    this._supplyHeals = supplyHeals;   // chosen supply is an own base → hold for a FULL top-off (ammo+fuel+hp)
    // HEAL home: HP only regenerates at an OWN base (a neutral fuel/ammo depot can't
    // patch the hull) — so a hurt unit must fall back HERE, not to the nearest depot,
    // or it camps a fuel tank forever waiting for health that never comes.
    let healHome = null, healD = Infinity;
    const considerHome = (x, z) => { const d = (px - x) ** 2 + (pz - z) ** 2; if (d < healD) { healD = d; healHome = { x, z }; } };
    if (fob) considerHome(fob.center.x, fob.center.z);
    if (home && flagBaseAlive(this.team)) considerHome(home.center.x, home.center.z);   // can't heal at a destroyed flag base
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
    // SIEGE FLATTEN: with no clean line on the tower, a siege unit demolishes the nearest
    // enemy WALL in its way (a real, solidly-hittable target at its true position) to blow
    // a path through to the far side — aimed shots at the hidden turret just arc over.
    let demolishTarget = null;
    if (threat && !threatLOS && threatCamp) {
      let bestW = Infinity;
      for (const w of threatCamp.walls) {
        if (!w.body || w.body.dead) continue;
        const wx = w.group.position.x, wz = w.group.position.z;
        const d = (wx - px) ** 2 + (wz - pz) ** 2;
        if (d < bestW) { bestW = d; demolishTarget = { x: wx, y: map.heightAt(wx, wz) + 2.5, z: wz }; }
      }
    }
    const fx = -Math.sin(h), fz = -Math.cos(h), lx = -Math.sin(h + 0.6), lz = -Math.cos(h + 0.6),
          rx = -Math.sin(h - 0.6), rz = -Math.cos(h - 0.6), P = 9;
    // Sweep each feeler from the hull edge out to P, not just the far point — a single
    // 9u sample sailed PAST a tree/wall the unit was already nosed into (so it never
    // registered as blocked and the break-through never fired). Near + far catches both
    // "about to hit it" and "already touching it".
    const feeler = (ax, az) => v._blocked(px + ax * VEH_R, pz + az * VEH_R) || v._blocked(px + ax * P, pz + az * P);
    const blockedAhead = feeler(fx, fz);
    // BREAK-THROUGH: when the nose is blocked, find the destructible dead ahead (the
    // nearest enemy/neutral WALL in front, else a TREE on the path) so a stuck ground
    // unit can shoot it out of the way instead of circling. Only the obstacles that
    // actually block are walls and trees — both take fire — so anything found here is a
    // valid target; water / world-edge leave it null and the unit dodges as before.
    let breakTarget = null;
    if (!flyer && blockedAhead) {
      const reach = 16;
      let best = null, bestD = reach * reach, ty = 2.0;
      for (const o of obstacles) {
        if (o.team === this.team) continue;            // never shoot our OWN base walls (the trigger-happy own-flag-shredding bug)
        if (o.body && o.body.dead) continue;           // already rubble — nothing to shoot
        const ox = o.x - px, oz = o.z - pz;
        if (ox * fx + oz * fz <= 0) continue;          // behind the nose
        const d = ox * ox + oz * oz;
        if (d < bestD) { bestD = d; best = o; ty = 2.0; }
      }
      if (foliage) {
        for (let s = VEH_R; s <= reach; s += 2.5) {     // walk the forward ray for a palm
          const t = foliage.treeAt(px + fx * s, pz + fz * s, VEH_R);
          if (t) { const d = (t.x - px) ** 2 + (t.z - pz) ** 2; if (!best || d < bestD) { best = t; ty = 3.0; } break; }
        }
      }
      if (best) breakTarget = { x: best.x, y: map.heightAt(best.x, best.z) + ty, z: best.z };
    }
    return {
      dt,
      self: { x: px, z: pz, heading: h, type: v.type, shield: v.shield, hpFrac: v.hp / v.maxHp, fuelFrac: v.fuel / v.maxFuel, ammoFrac: v.ammo / v.maxAmmo },
      seesEnemy, enemy, heard, enemiesNear, alliesNear, flyer, shotArc: SHOT_ARC[v.type] ?? Math.PI / 5,
      // shot-feedback: ≥2 of our recent rounds (last ~2s) detonated on terrain/cover, not on
      // the enemy → the firing lane is blocked; the combat brain sidesteps to clear it.
      shotBlocked: (v._blockedShots || 0) >= 2 && (performance.now() - (v._lastBlockT || 0)) < 2000,
      enemyGone: this.enemyEliminated(),   // target fleet wiped → don't waste time ghost-chasing a dead sighting
      support: turretCountOf(this.team) > 0 ? this.homeBasePos() : null,   // rally toward own tower cover (ai_behavior duels)
      threat, threatLOS, flankSide, threatStand, demolishTarget, breakTarget, engageRange: ENGAGE_RANGE[v.type] || 36,
      goal: mustGo ? this._exit : goal,
      mustGo,
      resupply: supply ? { x: supply.center.x, z: supply.center.z } : goal,
      supplyHeals,   // the chosen resupply point is an own base → hold until ammo+fuel+hp are all maxed
      home: healHome || goal,
      // While DETOURING (grabbing a shield / intercepting), the goal is a place to GO, not a
      // thing to shell — so suppress shootGoal or the unit would "assault" (and gun down) the
      // shield generator / intercept spot it's heading for. It still engages real enemies via
      // the combat transitions; this only stops it firing at the detour waypoint.
      shootGoal: this.strategy.shoot(this) && !this._shielding && !this._intercepting,
      arriveDist: this._intercepting ? 4 : this._shielding ? 6 : this.strategy.arriveDist(this),
      // Is this unit on a flee-contact RUNNER mission (grab the flag / scout — avoid fights)
      // vs one the commander sent it out to FIGHT on (attack/siege/defend/intercept)? Gates
      // the Firebrat's runnerFlee reflex so an ordered-to-engage Firebrat actually closes +
      // shoots instead of dodging the instant an enemy is near.
      runnerMode: this.strategy.step === 'capture' || this.strategy.step === 'scout',
      blockedAhead,
      blockedLeft: feeler(lx, lz),
      blockedRight: feeler(rx, rz),
    };
  }
}

// Designer teams are identity-only ('a'/'b'); the game's internals are 'red'/'blue'.
// 'a' is the first/player side → red. (Players still pick their colour in-game.)
const CFG_TEAM_OF = { red: 'a', blue: 'b' };
function cfgRulesFor(team) {
  const R = MAP_CFG && MAP_CFG.rules; const t = R && R.teams && R.teams[CFG_TEAM_OF[team]];
  return t ? { rules: R, team: t } : null;
}
// A designed map's difficulty becomes an AI handicap by scaling aim/steer noise
// (jitter) and decision lag (reaction): easy = sloppier + slower, hard = sharper.
const DIFF_HANDICAP = { easy: { j: 1.7, r: 1.5 }, normal: { j: 1, r: 1 }, hard: { j: 0.5, r: 0.6 } };
// Push the designer's per-team rules onto a freshly-built commander: personality
// knobs, fleet roster, and the difficulty handicap. Archetype is set at construction.
function applyCfgRules(cmd) {
  const c = cfgRulesFor(cmd.team); if (!c) return;
  const T = c.team, p = cmd.personality;
  if (T.aggression != null) p.aggression = T.aggression;
  if (T.defensiveness != null) p.defensiveness = T.defensiveness;
  if (T.triggerHappy != null) p.triggerHappy = T.triggerHappy;
  const aggMin = cmd.archetype === 'warrior' ? 0.75 : cmd.archetype === 'turtle' ? 0.66 : 0;   // mirror the constructor's floor
  if (p.aggression < aggMin) p.aggression = aggMin;
  const k = DIFF_HANDICAP[c.rules.difficulty] || DIFF_HANDICAP.normal;
  p.jitter = Math.min(1, (p.jitter ?? 0.25) * k.j);
  p.reaction = (p.reaction ?? 0.3) * k.r;
  if (T.roster) cmd.roster = { ...cmd.roster, ...T.roster };
}

// Create an AICommander for every AI-controlled team (called at field build).
function setupCommanders() {
  commanders.length = 0;
  if (QS.has('noai')) return;
  const teamIds = [...new Set(camps.filter(c => c.role === 'main').map(c => c.team))];
  const aiTeams = teamIds.filter(t => TEAM_CTRL[t] === 'ai');
  const archs = assignArchetypes(aiTeams.length);   // distinct doctrines → a real contrast each match
  aiTeams.forEach((t, i) => {
    const designed = cfgRulesFor(t);   // a designed map fixes each side's doctrine
    const cmd = new AICommander(t, (designed && designed.team.archetype) || archs[i]);
    applyCfgRules(cmd);
    commanders.push(cmd);
  });
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
  // An AI commander wears the colour IT picked — only the human's team reads
  // playerColorIndex. (Without the ctrl check, an AI 'red' team always showed RED,
  // since PLAYER_TEAM === 'red' and playerColorIndex defaults to the red slot.)
  const cmd = commanders.find(c => c.team === team && c.colorIndex != null);
  if (TEAM_CTRL[team] === 'human') return TEAM_COLORS[playerColorIndex] ? TEAM_COLORS[playerColorIndex].hex : '#ffffff';
  if (cmd && TEAM_COLORS[cmd.colorIndex]) return TEAM_COLORS[cmd.colorIndex].hex;
  return team === PLAYER_TEAM && TEAM_COLORS[playerColorIndex] ? TEAM_COLORS[playerColorIndex].hex : '#ffffff';
}
// Name flag messages after the flag's ACTUAL colour, not its internal team id —
// a team painted SNOW shouldn't read "RED FLAG TAKEN". Nearest palette swatch by
// RGB distance (tolerates emissive/recolour drift).
function colorName(hex) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let best = 'FLAG', bestD = Infinity;
  for (const c of TEAM_COLORS) {
    const cr = parseInt(c.hex.slice(1, 3), 16), cg = parseInt(c.hex.slice(3, 5), 16), cb = parseInt(c.hex.slice(5, 7), 16);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestD) { bestD = d; best = c.name; }
  }
  return best;
}
function flagColorName(f) { return colorName('#' + f.cloth.material.color.getHexString()); }
// The palette NAME of a colour index (CYAN, PURPLE, GREY…) — the unambiguous team
// label in the log, so a line's identity matches the team's actual on-field colour.
function teamLabel(colorIndex) { const c = TEAM_COLORS[colorIndex]; return c ? c.name : '—'; }
// Lighten a team colour so it stays legible on the dark log panel while keeping its hue
// (the darker palette slots — RED, BLUE, PURPLE, GREY — are nearly black otherwise).
function logTint(hex) {
  let r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum < 150) { const k = 150 / Math.max(lum, 1); r = Math.min(255, r * k); g = Math.min(255, g * k); b = Math.min(255, b * k); }
  const f = v => Math.round(v).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
// A team's log colour: its real on-field tint, brightened for the panel.
function teamLogColor(team) { return logTint(teamColor(team)); }
// A team's PALETTE COLOUR NAME (GREY, PURPLE, CYAN…) for banners/menus — so a win
// message names the colour the team actually wears, never the internal red/blue id.
function teamColorName(team) { return colorName(teamColor(team)); }
// Remaining fleet as a glyph string, one letter per ALIVE vehicle (the fielded one
// counts until it dies), grouped by type: e.g. FFFFFF-LLL-VV-JJ → 6 Firebrats, 3
// Lurchers, 2 Valkyries, 2 Jotuns. Empty groups drop out; a wiped fleet shows "—".
function fleetStr(cmd) {
  const GLYPH = { firebrat: 'F', lurcher: 'L', valkyrie: 'V', jotun: 'J' };
  const parts = [];
  for (const t of ['firebrat', 'lurcher', 'valkyrie', 'jotun']) {
    const n = cmd.roster ? (cmd.roster[t] || 0) : 0;
    if (n > 0) parts.push(GLYPH[t].repeat(n));
  }
  return parts.length ? parts.join('-') : '—';
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
// Three states: 'hidden' (just the top-right LOG button), 'brief' (top info + the
// single latest event — small, phone-friendly) and 'full' (whole window, scrollable
// through every event, with the game PAUSED). The box's own – / + header switches
// between them; – collapses (full→brief→hidden), + expands to full.
let aiLogMode = (QS.has('ailog') || SPECTATE) ? 'brief' : 'hidden';
let paused = false;    // game frozen while the log is expanded full-screen
const aiEvents = [];   // rolling [{t, team, msg}]
const _t0 = performance.now();
function aiLog(team, msg) {
  aiEvents.push({ t: (performance.now() - _t0) / 1000, team, msg });
  while (aiEvents.length > 80) aiEvents.shift();   // deep enough to scroll back in full view
}
function setLogMode(mode) {
  aiLogMode = mode;
  paused = (mode === 'full');
  updateLogToggle();
  updateAstarToggle();
  updateAiLog();
}
function ensureLogStyle() {
  if (document.getElementById('ai-log-style')) return;
  const s = document.createElement('style'); s.id = 'ai-log-style';
  s.textContent = `
    #ai-log { position:fixed; z-index:150; pointer-events:none; font-family:"Courier New",monospace;
      color:#dfe8ef; background:rgba(8,12,18,0.8); border:1px solid rgba(255,255,255,0.18);
      border-radius:6px; text-shadow:0 1px 2px rgba(0,0,0,0.8); font-variant-numeric:tabular-nums; }
    #ai-log.brief { top:12px; right:12px; width:360px; max-width:90vw; }
    #ai-log.full  { inset:10px; pointer-events:auto; display:flex; flex-direction:column; }
    #ai-log-head { display:flex; align-items:center; justify-content:space-between; pointer-events:auto;
      padding:6px 6px 6px 9px; border-bottom:1px solid rgba(255,255,255,0.14); }
    #ai-log-title { font-weight:bold; font-size:12px; letter-spacing:2px; }
    #ai-log-btns { display:flex; gap:6px; }
    #ai-log .lg-btn { width:26px; height:26px; line-height:24px; text-align:center; cursor:pointer;
      border:1px solid rgba(255,255,255,0.3); border-radius:5px; background:rgba(255,255,255,0.07);
      font-weight:bold; font-size:16px; user-select:none; -webkit-user-select:none; touch-action:manipulation; }
    #ai-log .lg-btn:active { background:rgba(255,255,255,0.22); }
    #ai-log-body { padding:7px 8px; font-size:11px; line-height:1.4; letter-spacing:0.2px; white-space:pre-wrap; }
    #ai-log.brief #ai-log-body { overflow:hidden; }
    #ai-log.full  #ai-log-body { overflow-y:auto; flex:1; -webkit-overflow-scrolling:touch; }
    /* One box per team: status (mission/known/fleet) + that team's latest event. */
    #ai-log .tbox { border-left:3px solid #888; border-radius:4px; background:rgba(255,255,255,0.035);
      padding:4px 8px; margin:0 0 6px; }
    #ai-log .tbox:last-child { margin-bottom:0; }
    #ai-log .tb-h { font-weight:bold; letter-spacing:0.6px; font-size:12px; }
    #ai-log .tb-l { opacity:0.82; }
    #ai-log .tb-ev { margin-top:3px; opacity:0.95; }
    #ai-log .tb-t { opacity:0.6; }
    #ai-log .tb-feed { margin-top:4px; border-top:1px solid rgba(255,255,255,0.14); padding-top:6px; opacity:0.92; }`;
  document.head.appendChild(s);
}
function ensureAiLogEl() {
  let el = document.getElementById('ai-log');
  if (el) return el;
  ensureLogStyle();
  el = document.createElement('div'); el.id = 'ai-log';
  el.innerHTML =
    '<div id="ai-log-head"><span id="ai-log-title">AI LOG</span>' +
    '<span id="ai-log-btns"><span class="lg-btn" data-act="export" title="Copy a snapshot to share">⧉</span>' +
    '<span class="lg-btn" data-act="minus">–</span>' +
    '<span class="lg-btn" data-act="plus">+</span></span></div>' +
    '<div id="ai-log-body"></div>';
  el.addEventListener('pointerdown', e => {
    const b = e.target.closest('.lg-btn'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.dataset.act === 'export') exportLog();
    else if (b.dataset.act === 'minus') setLogMode(aiLogMode === 'full' ? 'brief' : 'hidden');
    else setLogMode('full');
  });
  document.body.appendChild(el);
  return el;
}
// Trim a log event down to just its CHANGING part for a team's brief box: the box
// already shows the team colour, vehicle and personality, so drop a leading "COLOUR"
// (and a following vehicle-type word) and a trailing "[card]".
const _VTYPES = ['firebrat', 'lurcher', 'valkyrie', 'jotun'];
function briefEvent(cmd, msg) {
  let m = msg;
  if (cmd.cname && m.toUpperCase().startsWith(cmd.cname.toUpperCase())) m = m.slice(cmd.cname.length);
  m = m.replace(/^[\s:·—-]+/, '');                                   // leading separators
  for (const t of _VTYPES) if (m.toLowerCase().startsWith(t)) { m = m.slice(t.length).replace(/^[\s:·—-]+/, ''); break; }
  m = m.replace(/\s*\[[^\]]*\]\s*$/, '');                            // trailing [card]
  return m.trim();
}
function updateAiLog() {
  const el = document.getElementById('ai-log');
  if (aiLogMode === 'hidden') { if (el) el.style.display = 'none'; return; }
  const box = ensureAiLogEl(); box.style.display = '';
  box.className = aiLogMode;
  document.getElementById('ai-log-title').textContent = aiLogMode === 'full' ? 'AI LOG · PAUSED' : 'AI LOG';
  // The most-recent event for a team (its "running" line), or null.
  const latestFor = team => { for (let i = aiEvents.length - 1; i >= 0; i--) if (aiEvents[i].team === team) return aiEvents[i]; return null; };
  let html = '';
  // ONE BOX PER TEAM. Each box = that team's persistent status (the mission, the known
  // POIs, fleet) PLUS its single latest event — so a team's whole picture sits together,
  // identified by its colour, instead of all status then a shared event feed.
  for (const cmd of commanders) {
    const col = teamLogColor(cmd.team);
    const d = cmd._dbg;
    const mission = (cmd.strategy && cmd.strategy.step ? cmd.strategy.step : '—').toUpperCase();
    const known = cmd._knownSummary ? cmd._knownSummary() : 'none';
    const type = d ? d.type.toUpperCase() : 'DEPLOYING';
    const card = d ? d.card : (cmd.strategy ? (cmd.strategy.constructor.name || '').replace('Strategy', '') : '');
    html += `<div class="tbox" style="border-color:${col}">`;
    // Header: COLOUR · VEHICLE · MISSION · PERSONALITY — all dot-separated, no brackets.
    html += `<div class="tb-h" style="color:${col}">${cmd.cname} · ${type} · ${mission}${card ? ` · ${card.toUpperCase()}` : ''}</div>`;
    if (d) {
      html += `<div class="tb-l">${d.state} · hp ${d.hp}% · ammo ${d.ammo} · fuel ${d.fuel} · fob ${d.distFob}</div>`;
      if (d.stuck) html += `<div class="tb-l" style="color:#ffb030">⚠ STUCK ${d.stuck}s — ${d.stuckWhy}</div>`;
    }
    html += `<div class="tb-l">twrs ${d ? d.towers : '?'} · knows ${known}</div>`;
    html += `<div class="tb-l">fleet ${fleetStr(cmd)}</div>`;
    const ev = latestFor(cmd.team);
    // The box already names the team/vehicle/personality, so the event shows only the
    // changing part (front "COLOUR vehicle:" + trailing "[card]" stripped).
    if (ev) html += `<div class="tb-ev" style="color:${col}"><span class="tb-t">${ev.t.toFixed(0)}s</span> ${briefEvent(cmd, ev.msg)}</div>`;
    html += `</div>`;
  }
  // Full view also gets the whole chronological feed below the boxes (scrollable).
  if (aiLogMode === 'full') {
    html += `<div class="tb-feed">`;
    for (let i = aiEvents.length - 1; i >= 0; i--) {
      const e = aiEvents[i];
      html += `<div><span class="tb-t">${e.t.toFixed(0)}s</span> <span style="color:${teamLogColor(e.team)}">${e.msg}</span></div>`;
    }
    html += `</div>`;
  }
  document.getElementById('ai-log-body').innerHTML = html;
}

// Build a plain-text snapshot of the whole AI state — per-team status (mission, goal,
// hp/ammo/fuel, position) + the full recent event feed — for the player to copy and paste
// when they spot odd behaviour (saves typing it all out). Read-only; safe to call anytime.
function buildLogExport() {
  const ver = (((document.querySelector('script[src*="main.js"]') || {}).src || '').match(/v=(\d+)/) || [])[1] || '?';
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const t = ((performance.now() - _t0) / 1000).toFixed(0);
  let s = `=== RMRF LOG (v${ver}) ===\nmode: ${human ? 'Player vs AI' : 'AI vs AI'}   t: ${t}s\n`;
  if (player && !player.dead) {
    const pp = player.holder.position;
    s += `player: ${player.type} hp ${Math.round(player.hp / player.maxHp * 100)}% ammo ${player.ammo} @ (${Math.round(pp.x)},${Math.round(pp.z)})\n`;
  }
  for (const cmd of commanders) {
    const d = cmd._dbg;
    const mission = ((cmd.strategy && cmd.strategy.step) || '—').toUpperCase();
    const known = cmd._knownSummary ? cmd._knownSummary() : 'none';
    const goalLbl = cmd._intercepting ? 'intercept runner' : cmd._shielding ? 'grab shield'
      : (cmd.strategy && cmd.strategy.objectiveLabel ? cmd.strategy.objectiveLabel(cmd) : '—');
    s += `\n[${cmd.cname}] ${d ? d.type : 'deploying'} · ${mission}${d ? ` [${d.card}]` : ''}\n`;
    if (d) {
      s += `  ${d.state} → ${goalLbl}\n`;
      s += `  hp ${d.hp}% ammo ${d.ammo} fuel ${d.fuel} shld ${d.shield}\n`;
      s += `  pos (${d.px},${d.pz}) goal (${d.gx},${d.gz}) fob ${d.distFob}u blk ${d.blk} f/t ${d.fwd}/${d.turn}\n`;
      if (d.stuck) s += `  STUCK ${d.stuck}s — ${d.stuckWhy}\n`;
    }
    s += `  enemy twrs ${d ? d.towers : '?'} · knows ${known} · fleet ${fleetStr(cmd)}\n`;
  }
  s += `\n--- events (newest first) ---\n`;
  for (let i = aiEvents.length - 1; i >= 0; i--) s += `${aiEvents[i].t.toFixed(0)}s ${aiEvents[i].msg}\n`;
  return s;
}
// Copy the snapshot to the clipboard; always also pop a selectable overlay (the secure
// clipboard API is blocked on plain http, e.g. the phone over duckdns, so the overlay is
// the reliable fallback — pre-selected text + a Copy button using the legacy execCommand).
function exportLog() {
  const txt = buildLogExport();
  let copied = false;
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt); copied = true; } } catch (e) { /* http → fall back to overlay */ }
  showExportOverlay(txt, copied);
}
function showExportOverlay(txt, copied) {
  let ov = document.getElementById('log-export');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'log-export';
    ov.style.cssText = 'position:fixed;inset:0;z-index:400;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;padding:14px;gap:10px;';
    ov.innerHTML = '<div style="display:flex;gap:8px;align-items:center;font-family:\'Courier New\',monospace">'
      + '<span id="lx-status" style="color:#dfe8ef;font-size:13px;flex:1"></span>'
      + '<span id="lx-copy" class="lx-b">Copy</span><span id="lx-close" class="lx-b">Close</span></div>'
      + '<textarea id="lx-text" readonly></textarea>';
    document.body.appendChild(ov);
    const style = document.createElement('style');
    style.textContent = '#log-export .lx-b{padding:9px 16px;border:1px solid #567;border-radius:6px;color:#dfe8ef;'
      + 'background:rgba(255,255,255,0.1);font:bold 13px "Courier New",monospace;cursor:pointer;'
      + 'user-select:none;-webkit-user-select:none;touch-action:manipulation}'
      + '#log-export .lx-b:active{background:rgba(255,255,255,0.25)}'
      + '#lx-text{flex:1;width:100%;background:#0b0f14;color:#cfe3ef;border:1px solid #2c3a47;border-radius:6px;'
      + 'padding:8px;font:11px/1.4 "Courier New",monospace;white-space:pre;-webkit-user-select:text;user-select:text}';
    document.head.appendChild(style);
    ov.addEventListener('pointerdown', e => {
      if (e.target.id === 'lx-close') { e.preventDefault(); ov.style.display = 'none'; }
      else if (e.target.id === 'lx-copy') {
        e.preventDefault();
        const ta = document.getElementById('lx-text');
        ta.focus(); ta.select(); try { ta.setSelectionRange(0, ta.value.length); } catch (e2) {}
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (e3) {}
        if (!ok) { try { navigator.clipboard.writeText(ta.value); ok = true; } catch (e4) {} }
        document.getElementById('lx-status').textContent = ok ? '✓ Copied — paste it to Claude' : 'Select the text above, then copy';
      }
    });
  }
  ov.style.display = 'flex';
  const ta = document.getElementById('lx-text');
  ta.value = txt;
  document.getElementById('lx-status').textContent = copied ? '✓ Copied — paste it to Claude' : 'Tap Copy, then paste it to Claude';
  setTimeout(() => { try { ta.focus(); ta.select(); } catch (e) {} }, 30);
}

// A flag was carried home → that team wins. Freeze the field, announce, then reset
// (human → back to the garage for a fresh run; AI-vs-AI → re-arm the flags + play on).
function endMatch(winner) {
  if (matchOver) return;
  matchOver = true;
  const human = TEAM_CTRL[PLAYER_TEAM] === 'human';
  const won = winner === PLAYER_TEAM;
  matchWon = won;
  if (!human) { playVictory(winner); showCelebTitle(`${teamColorName(winner)} WINS`, teamColor(winner)); }
  else if (won) playVictory(PLAYER_TEAM);   // a non-extraction win (e.g. AI ally caps) still celebrates
  else playDefeat();
  try { if (sound && sound.enabled) sound.toggle(); } catch (e) { /* quiet the engine */ }
  setTimeout(() => {
    const el = document.getElementById('banner'); if (el) el.style.opacity = '0';
    if (human) { if (player && playerElev) { leftPad = true; beginReturn(); } else returnToGarage(); }
    // AI-vs-AI: the match is decided — open the play-again menu over the frozen field
    // (reload starts a fresh game; nothing rebuilds in place).
    else showGameMenu({ header: `${teamColorName(winner)} WINS`, sub: 'MATCH OVER', reload: true });
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
      if (o.body && o.body.dead) continue;           // a downed wall no longer blocks line of sight
      const ox = x - o.x, oz = z - o.z;
      if (ox * ox + oz * oz < o.r * o.r) return false;
    }
  }
  return true;
}

// --- Collision ---------------------------------------------------------
// Solid wall pieces the player can't drive through (gates excluded — drive-through).
let obstacles = [];           // { x, z, r }
const gateCells = new Set();  // grid cells the A* navigator treats as always-open + cheap (gate centre lane)
const gateSideCells = new Set();  // the gate's flanking cells — open to the eye but a full-radius vehicle scrapes the jamb there, so A* must NOT use them
let islandBound = 0;          // radius (from map centre) past which no vehicle may go
function buildObstacles() {
  obstacles = [];
  gateCells.clear();
  gateSideCells.clear();
  const c0 = grid.cell;
  for (const c of camps) for (const w of c.walls) {
    if (w.type && w.type.startsWith('GATE')) {
      // The gate opening is 3 cells wide, but a full-radius vehicle can only clear
      // it dead-centre (the flanking lanes scrape the wall the inflated obstacles
      // don't quite reach with the gentle nav margin). So carve a SINGLE-FILE centre
      // throat: open + road-cheap down the middle, and explicitly block the side
      // lanes through the gate plane so A* threads the centre instead of the jamb.
      const gx = w.group.position.x, gz = w.group.position.z;
      const gi = Math.round(gx / c0), gj = Math.round(gz / c0);
      const dx = gx - c.center.x, dz = gz - c.center.z;
      const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
      const sz = Math.abs(dx) >= Math.abs(dz) ? 0 : Math.sign(dz);
      const px = sx !== 0 ? 0 : 1, pz = sx !== 0 ? 1 : 0;   // along-the-wall (perpendicular to the normal)
      for (let k = -2; k <= 2; k++) {
        gateCells.add((gi + sx * k) + ',' + (gj + sz * k));
        if (k >= -1 && k <= 1)
          for (const s of [-1, 1]) gateSideCells.add((gi + sx * k + px * s) + ',' + (gj + sz * k + pz * s));
      }
      continue;
    }
    obstacles.push({ x: w.group.position.x, z: w.group.position.z, team: c.team, body: w.body,
                     r: w.type === 'CORNER' ? grid.cell * 0.7 : grid.cell * 0.5 });
  }
  // The flag HQ is a SOLID building, not a drive-through. Add it as an obstacle so vehicles
  // STOP at it (and a sieger nosed against it shoots it down — that's the breach path that
  // actually cracks the HQ + exposes the flag) and A* routes around it instead of plowing
  // through. The surrounding ring is road (handled first in blockedFor/cellBlocked) so the
  // approach lanes stay open; once the HQ is rubble the dead-body skip below lets the flag
  // runner roll over the wreck to the flag. Radius ≈ the cell*1.7 footprint half.
  for (const c of camps) {
    if (!c.flagHQ || c.flagHQ.dead) continue;
    obstacles.push({ x: c.center.x, z: c.center.z, team: c.team, body: c.flagHQ, r: grid.cell * 0.85 });
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
  refreshAimArc();            // aim-stick wedge matches the deployed vehicle's arc
  startCommanders(colorIndex);   // AI teams pick remaining colours + deploy in response
  leftPad = false;            // must drive off the pad before a park can return it
  parkT = 0;

  orbit.target.set(cx, 0, cz);
  orbit.dist = 64; orbit.pitch = 0.9;
  updateCamera();
}

// Forward/turn in [-1, 1]. Touch: the left on-screen stick sets the same WASD keys.
// Keyboard (desktop): WASD/arrows, the classic tank turn + throttle.
function driveInput() {
  // The Lurcher has NO front (omni-directional): it moves along whatever world vector you
  // push, and the hull auto-faces its travel. The other three keep their tank steering.
  const omni = !!(player && player.type === 'lurcher');
  // Touch NAV stick: "go in this direction." The stick offset is a camera-relative
  // compass point — up = into the screen, right = screen-right — so the vehicle heads
  // that WORLD direction regardless of which way the hull faces. Tank types turn to face
  // it then drive; the omni Lurcher just slides there. Push distance = throttle.
  if (touchNav && player && !player.dead) {
    const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
    const fX = -sy, fZ = -cy;            // camera forward on the ground (into the screen)
    const rX = cy,  rZ = -sy;            // camera right on the ground
    let mx = fX * (-touchNav.ny) + rX * touchNav.nx;
    let mz = fZ * (-touchNav.ny) + rZ * touchNav.nx;
    const len = Math.hypot(mx, mz);
    let mag = (touchNav.mag - 0.20) / 0.80;             // deadzone, then linear 0..1 throttle
    mag = Math.max(0, Math.min(1, mag));
    if (len < 1e-4 || mag <= 0) return omni ? { omni: true, mx: 0, mz: 0 } : { fwd: 0, turn: 0 };
    mx /= len; mz /= len;                                // unit world heading
    if (omni) return { omni: true, mx: mx * mag, mz: mz * mag };
    const aim = Math.atan2(-mx, -mz);                   // heading whose front (-Z) faces the push
    const err = wrapPi(aim - player.heading);
    const turn = Math.max(-1, Math.min(1, err * 2.4));
    const fwd = Math.abs(err) > 1.3 ? 0 : mag;          // pivot in place if badly mis-aimed, else throttle
    return { fwd, turn };
  }
  if (touchSteer && player && !player.dead) {
    const t = pickWorldPoint(touchSteer.x, touchSteer.y);
    if (t) {
      const hp = player.holder.position;
      const dx = t.point.x - hp.x, dz = t.point.z - hp.z;
      const distXZ = Math.hypot(dx, dz);
      if (omni) {
        // Move straight toward the finger — no turn-then-drive — easing to a stop on arrival.
        if (distXZ < TOUCH_STOP_R) return { omni: true, mx: 0, mz: 0 };
        const inv = 1 / distXZ;
        return { omni: true, mx: dx * inv, mz: dz * inv };
      }
      const aim = Math.atan2(-dx, -dz);                 // heading whose front (-Z) points at the finger
      const err = wrapPi(aim - player.heading);
      const turn = Math.max(-1, Math.min(1, err * 2.4));
      // Two-finger strafe: a second finger HELD to one side slides the hull straight
      // sideways toward that finger while the first keeps aiming — no forward drive. The
      // strafe sign is the second finger's offset projected onto the hull's right axis,
      // so "finger on the right" = strafe right regardless of camera angle. Jotun can't.
      if (touchStrafe && player.type !== 'jotun' && performance.now() - touchStrafe.t > 140) {
        const b = pickWorldPoint(touchStrafe.x, touchStrafe.y);
        if (b) {
          const h = player.heading, rx = Math.cos(h), rz = -Math.sin(h);   // hull right axis
          let bx = b.point.x - hp.x, bz = b.point.z - hp.z;
          const bl = Math.hypot(bx, bz) || 1;
          const strafe = Math.max(-1, Math.min(1, ((bx / bl) * rx + (bz / bl) * rz) * 1.5));
          return { fwd: 0, turn, strafe };
        }
      }
      // Pivot in place when badly mis-aimed (>~75°) so we don't arc wide; otherwise
      // drive forward, easing to a stop once the finger sits on the vehicle.
      const fwd = Math.abs(err) > 1.3 ? 0 : (distXZ < TOUCH_STOP_R ? 0 : 1);
      return { fwd, turn };
    }
  }
  if (omni) {
    // Camera-relative 8-way: W/S move into/out of the screen, A/D move screen-left/right,
    // independent of which way the hull happens to be facing.
    const sy = Math.sin(orbit.yaw), cy = Math.cos(orbit.yaw);
    const fX = -sy, fZ = -cy;        // camera forward on the ground (into the screen)
    const rX = cy,  rZ = -sy;        // camera right on the ground
    const wv = (keys['w'] || keys['arrowup']   ? 1 : 0) - (keys['s'] || keys['arrowdown']  ? 1 : 0);
    const rv = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
    let mx = fX * wv + rX * rv, mz = fZ * wv + rZ * rv;
    const m = Math.hypot(mx, mz);
    if (m > 1) { mx /= m; mz /= m; }
    return { omni: true, mx, mz };
  }
  const fwd    = (keys['w'] || keys['arrowup']   ? 1 : 0) - (keys['s'] || keys['arrowdown']  ? 1 : 0);
  const turn   = (keys['a'] || keys['arrowleft'] ? 1 : 0) - (keys['d'] || keys['arrowright'] ? 1 : 0);
  const strafe = (keys['e'] ? 1 : 0) - (keys['q'] ? 1 : 0);   // Q/E slide sideways (no turn)
  return { fwd, turn, strafe };
}

// Drive the player vehicle and track the camera on it. Returns true if it drove
// (so the caller skips the free-camera pan). Hands control over once the deploy
// lift tops out.
function driveUpdate(dt) {
  if (playerElev && player && playerElev.rider === player && playerElev.phase === 'top') {
    playerElev.rider = null;   // detach so drive() owns the transform
    driving = true;
    refreshAimArc();           // tint the aim wedge to this vehicle's arc, now that it's live
  }
  if (!driving || !player || player.dead) return false;
  const inp = matchOver ? { fwd: 0, turn: 0, strafe: 0 } : driveInput();   // controls freeze on win
  let revFwd, revTurn, stopped;
  if (inp.omni) {
    // Omni Lurcher: burnFuel for the accounting (+ LIMP scaling when dry), then drive the
    // world vector. The fuel call's fwd-out / fwd-in ratio gives the LIMP factor (1 fueled).
    const mag = Math.hypot(inp.mx, inp.mz);
    const fuelOut = burnFuel(player, { fwd: mag, turn: 0, strafe: 0 }, dt);
    const k = mag > 0.0001 ? fuelOut.fwd / mag : 1;
    player.driveOmni(dt, inp.mx * k, inp.mz * k, null, player._blocked);
    revFwd = mag; revTurn = 0; stopped = mag < 0.01;
  } else {
    const out = burnFuel(player, inp, dt);  // no fuel → engine dead, can't move
    const strafe = player.type === 'jotun' ? 0 : (out.strafe || 0);   // the Jotun is a fortress — no sidestep
    player.drive(dt, out.fwd, out.turn, null, player._blocked, strafe);
    revFwd = out.fwd; revTurn = out.turn; stopped = inp.fwd === 0 && inp.turn === 0;
  }
  applyAltitude(player, dt);                // altitude / water flooding / tree crush
  if (!player || player.dead) return true;  // sank/destroyed this frame → bail before touching it
  aimPlayerTurret(player, dt);              // turret continuously follows the aim cursor
  player._throttle = Math.min(1, Math.abs(revFwd) + Math.abs(revTurn) * 0.6);   // own-noise floor for the sound HUD's masking
  if (sound) sound.update(revFwd, revTurn);   // rev the engine RPM with throttle (idle ↔ max)
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
    if (leftPad && dist < playerElev.padHalf * 0.7 && stopped) {
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
  // Sun nearly overhead, tilted slightly toward -Z — the specular look bro dialled in
  // (x:0, z:-25 on the default 480 map). Kept proportional to span so any map size gets
  // the same light DIRECTION, not just the default one.
  sun.position.set(0, span * 0.42, -span * 0.052);
}

// Initial camera framing — only used once, on load (the spectator start view).
function frameMap() {
  scaleScene();
  orbit.dist = Math.max(map.worldW, map.worldH) * 0.425;   // closer start (was 0.85 — felt very far)
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

// Team colour is global and locks the instant the first vehicle deploys — after that
// the garage's colour swatches stay gone for the rest of the match (you've committed).
let teamColorLocked = false;
// Toggle the garage overlays (CCTV / HUD / team selector) and the field UI (title +
// touch joystick) when switching between the hangar view and the island.
function setGarageOverlays(show) {
  for (const id of ['cctv', 'hud-name', 'hud-stats', 'teamsel']) {
    const el = document.getElementById(id);
    if (!el) continue;
    // Once locked, never re-reveal the colour swatches on later garage visits.
    const vis = show && !(id === 'teamsel' && teamColorLocked);
    el.style.display = vis ? '' : 'none';
  }
}
function setFieldUI(show) {
  const hud = document.getElementById('hud');
  if (hud) hud.style.display = show ? '' : 'none';
  // Touch controls: two fixed sticks — RIGHT is the directional NAV pad ("go this way"),
  // LEFT aims+fires within the vehicle's arc with aim-assist. The old corner FIRE buttons +
  // field point-to-steer are retired (firing-by-cursor was unreliable; thumb angles too hard).
  // Only when a human actually drives — in AI-vs-AI / spectate the sticks do nothing.
  const onTouch = show && touchUsed && TEAM_CTRL[PLAYER_TEAM] === 'human';
  document.getElementById('touch-joystick')?.classList.toggle('visible', onTouch);
  document.getElementById('touch-aim')?.classList.toggle('visible', onTouch);
  for (const id of ['fire-btn', 'fire-btn-l']) {
    document.getElementById(id)?.classList.remove('visible');
  }
  if (show) refreshAimArc();   // tint the aim wedge to the deployed vehicle's arc
  ensureLogToggle(); updateLogToggle();   // phone-friendly AI-log button (top-right)
  ensureAstarToggle(); updateAstarToggle();   // PATH button (left of LOG) — opens the A* visualizer
  if (!show) { fireHeld = false; touchAim = null; touchAiming = false; }   // drop a held shot at the garage
}
// Top-right LOG button (where the old map ⚙ sat) — reveals the log from hidden. It
// only shows while the field is up and the log is hidden; once open, the box's own
// – button re-hides it.
function ensureLogToggle() {
  let b = document.getElementById('ailog-toggle');
  if (b) return b;
  b = document.createElement('div'); b.id = 'ailog-toggle'; b.textContent = 'LOG';
  b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:151;padding:7px 12px;border-radius:7px;' +
    'font-family:"Courier New",monospace;font-weight:bold;font-size:13px;letter-spacing:2px;color:#dfe8ef;' +
    'background:rgba(8,12,18,0.7);border:1px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer;';
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); setLogMode('brief'); });
  document.body.appendChild(b);
  return b;
}
function updateLogToggle() {
  const b = document.getElementById('ailog-toggle');
  if (b) b.style.display = (onField && aiLogMode === 'hidden') ? 'block' : 'none';
}
// PATH button — sits just left of LOG (phones have no keyboard, so the `v` hotkey
// is useless on mobile). Opens the A* search visualizer. Same visibility rule as
// LOG so it never collides with the brief log box.
function ensureAstarToggle() {
  let b = document.getElementById('astar-toggle');
  if (b) return b;
  b = document.createElement('div'); b.id = 'astar-toggle'; b.textContent = 'PATH';
  b.style.cssText = 'position:fixed;top:12px;right:76px;z-index:151;padding:7px 12px;border-radius:7px;' +
    'font-family:"Courier New",monospace;font-weight:bold;font-size:13px;letter-spacing:2px;color:#dfe8ef;' +
    'background:rgba(8,12,18,0.7);border:1px solid rgba(255,255,255,0.3);box-shadow:0 2px 8px rgba(0,0,0,0.3);' +
    'user-select:none;-webkit-user-select:none;touch-action:manipulation;cursor:pointer;';
  b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); toggleAstarViz(); });
  document.body.appendChild(b);
  return b;
}
function updateAstarToggle() {
  const b = document.getElementById('astar-toggle');
  if (b) b.style.display = (onField && aiLogMode === 'hidden') ? 'block' : 'none';
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
    teamColorLocked = true;              // team colour locked at first deploy — swatches gone for good
    const ts = document.getElementById('teamsel');
    if (ts) ts.style.display = 'none';
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

  // Field hotkeys. The AI log is toggled by the on-screen LOG button (no keyboard on a
  // phone). Camera-cycle keys (Tab/]/[ to pin next/prev unit) are spectate-only.
  window.addEventListener('keydown', (e) => {
    if (!onField) return;
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

// --- Game menu (start screen + play-again) ------------------------------
// A win/loss can't just keep playing the same world — towers, walls and foliage are
// gone for good. The clean reset is a full page RELOAD: a fresh load regenerates the
// map (new random seed) and every bit of state. So the menu's mode buttons just
// navigate (PLAYER VS AI -> ?play, AI VS AI -> ?aivsai), which reloads into a brand
// new game. The one exception is PLAYER VS AI on the very first screen (nothing's
// dirty yet): it just reveals the deploy hangar in place, no reload needed.
const MENU_BASE = location.pathname;
function ensureMenuStyle() {
  if (document.getElementById('menu-style')) return;
  const s = document.createElement('style'); s.id = 'menu-style';
  s.textContent = `
    #gamemenu { position:fixed; inset:0; z-index:400; display:none;
      flex-direction:column; align-items:center; justify-content:center; gap:12px;
      overflow:auto; padding:24px 0;
      background:radial-gradient(ellipse at center, rgba(6,10,16,0.55), rgba(4,7,12,0.85));
      font-family:"Courier New",monospace; -webkit-user-select:none; user-select:none; }
    #gamemenu.show { display:flex; }
    #gamemenu .gm-title { color:#e9fff1; font-size:clamp(40px,12vw,56px); font-weight:bold; letter-spacing:18px;
      text-shadow:0 0 22px rgba(80,255,150,0.55), 0 3px 16px rgba(0,0,0,0.85);
      text-align:center; padding-left:18px; }
    /* the joke as a live shell line — persistent brand mark, never overridden */
    #gamemenu .gm-cmd { color:#7fe7a3; font-size:15px; letter-spacing:1px; margin-top:4px;
      text-shadow:0 0 8px rgba(80,255,150,0.35); white-space:nowrap; }
    #gamemenu .gm-cmd .pr { color:#4ad968; font-weight:bold; }
    #gamemenu .gm-cmd .fl { color:#e9fff1; }
    #gamemenu .gm-cmd .ct { color:#9bffc4; animation:gm-blink 1.05s steps(1) infinite; }
    @keyframes gm-blink { 0%,50% { opacity:1; } 50.01%,100% { opacity:0; } }
    #gamemenu .gm-sub { color:#7f9a8b; font-size:11px; letter-spacing:5px; margin:6px 0 20px; }
    #gamemenu button { width:262px; padding:15px 0; font-family:inherit; font-size:15px;
      letter-spacing:3px; font-weight:bold; color:#dfe8ef; cursor:pointer;
      background:rgba(20,30,42,0.88); border:1px solid rgba(255,255,255,0.28); border-radius:6px;
      box-shadow:0 2px 10px rgba(0,0,0,0.4); transition:background .12s, transform .06s; }
    #gamemenu button:hover { background:rgba(40,58,80,0.96); }
    #gamemenu button:active { transform:scale(0.97); }
    #gamemenu .gm-group { display:flex; flex-direction:column; align-items:center; gap:12px; }
    /* CAMPAIGN — present but not playable yet */
    #gamemenu .gm-soon { position:relative; opacity:0.5; cursor:default; }
    #gamemenu .gm-soon:hover { background:rgba(20,30,42,0.88); }
    #gamemenu .gm-badge { position:absolute; top:-9px; right:-10px; background:#caa64a; color:#1a1208;
      font-size:8px; font-weight:bold; letter-spacing:1px; padding:2px 7px; border-radius:10px;
      transform:rotate(6deg); box-shadow:0 1px 4px rgba(0,0,0,0.5); }
    /* DEV TOOLS submenu */
    #gamemenu .gm-devhdr { color:#7fe7a3; font-size:13px; letter-spacing:6px; font-weight:bold;
      margin-bottom:2px; text-shadow:0 0 8px rgba(80,255,150,0.35); }
    #gamemenu .gm-toollbl { color:#5f7a6b; font-size:9px; letter-spacing:4px; margin:8px 0 -2px; }
    #gamemenu a.gm-tool { width:262px; padding:13px 0; font-family:inherit; font-size:13px; letter-spacing:2px;
      font-weight:bold; color:#9fc7e0; text-align:center; text-decoration:none; box-sizing:border-box;
      background:rgba(14,22,32,0.88); border:1px solid rgba(120,180,220,0.28); border-radius:6px;
      box-shadow:0 2px 10px rgba(0,0,0,0.4); transition:background .12s, transform .06s; }
    #gamemenu a.gm-tool:hover { background:rgba(28,44,62,0.96); }
    #gamemenu a.gm-tool:active { transform:scale(0.97); }
    #gamemenu .gm-help { width:min(86vw,340px); color:#aebecd; font-size:11px; line-height:1.6; letter-spacing:0.5px;
      background:rgba(8,12,18,0.72); border:1px solid rgba(255,255,255,0.15); border-radius:6px;
      padding:12px 16px; white-space:normal; text-align:left; margin-top:6px;
      max-height:40vh; overflow-y:auto; }
    #gamemenu .gm-help h4 { color:#e6eef5; font-size:10px; letter-spacing:2px; margin:10px 0 3px; font-weight:bold; }
    #gamemenu .gm-help h4:first-child { margin-top:0; }
    #gamemenu .gm-help b { color:#dfe8ef; }
    #gamemenu .gm-help .supply-row { display:flex; align-items:center; gap:10px; margin:7px 0; }
    #gamemenu .gm-help .supply-row img { width:48px; height:48px; flex-shrink:0; object-fit:contain;
      background:rgba(120,210,150,0.06); border:1px solid #1d3850; border-radius:5px; }
    #gamemenu .gm-help .supply-row span { color:#9fb2c2; }`;
  document.head.appendChild(s);
}
function ensureGameMenu() {
  let m = document.getElementById('gamemenu');
  if (m) return m;
  ensureMenuStyle();
  m = document.createElement('div'); m.id = 'gamemenu';
  m.innerHTML =
    '<div class="gm-title" id="gm-title">RMRF</div>' +
    '<div class="gm-cmd"><span class="pr">$</span> rm <span class="fl">-rf</span> /their/base | grep flag<span class="ct">&#9608;</span></div>' +
    '<div class="gm-sub" id="gm-sub">ISLAND CTF</div>' +
    '<div class="gm-group" id="gm-main">' +
      '<button data-act="pva">PLAYER VS AI</button>' +
      '<button class="gm-soon" disabled>CAMPAIGN<span class="gm-badge">COMING SOON</span></button>' +
      '<button data-act="dev">DEV TOOLS &#9656;</button>' +
    '</div>' +
    '<div class="gm-group" id="gm-dev" style="display:none">' +
      '<div class="gm-devhdr">DEV TOOLS</div>' +
      '<button data-act="ava">AI VS AI</button>' +
      '<div class="gm-toollbl">EDITORS &amp; LABS</div>' +
      '<a class="gm-tool" href="https://asset-designer.rmrfbase.com" target="_blank" rel="noopener">ASSET DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://map-designer.rmrfbase.com" target="_blank" rel="noopener">MAP DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://vehicle-designer.rmrfbase.com" target="_blank" rel="noopener">VEHICLE DESIGNER &#8599;</a>' +
      '<a class="gm-tool" href="https://sound-lab.rmrfbase.com" target="_blank" rel="noopener">SOUND LAB &#8599;</a>' +
      '<button data-act="back">&#9666; BACK</button>' +
    '</div>' +
    '<div class="gm-help" id="gm-help">' +
      '<h4>GOAL</h4>' +
      'Destroy the enemy flag HQ, then send a <b>Firebrat</b> to grab the exposed flag and ride it down your own lift to win.' +
      '<h4>CONTROLS</h4>' +
      '<b>Move</b> WASD / drag toward a point &nbsp; <b>Fire</b> click / FIRE button &nbsp; <b>Strafe</b> Q E / two fingers &nbsp; <b>Aim</b> toward the cursor' +
      '<h4>VEHICLES</h4>' +
      '<b>Lurcher</b> — fast omni scout, 360° turret.<br>' +
      '<b>Firebrat</b> — fragile flag runner, fixed gun.<br>' +
      '<b>Valkyrie</b> — flying missile gunship.<br>' +
      '<b>Jotun</b> — slow railgun siege tank.' +
      '<h4>SUPPLIES</h4>' +
      'Neutral points — either team can use them, or blow one up to deny it.' +
      SUPPLY_ASSETS.map(a =>
        `<div class="supply-row"><img src="thumbnails/${a.id}.png" alt="${a.name}" loading="lazy"><div><b>${a.name}</b><br><span>${a.desc}</span></div></div>`
      ).join('') +
    '</div>';
  document.body.appendChild(m);
  // Swap between the main buttons and the DEV TOOLS submenu (help hides in dev view).
  function setDevView(on) {
    m.querySelector('#gm-main').style.display = on ? 'none' : '';
    m.querySelector('#gm-dev').style.display = on ? '' : 'none';
    const help = m.querySelector('#gm-help'); if (help) help.style.display = on ? 'none' : '';
  }
  m._setDevView = setDevView;
  m.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;   // CAMPAIGN is disabled
    const act = b.dataset.act;
    if (act === 'dev') { setDevView(true); return; }
    if (act === 'back') { setDevView(false); return; }
    if (act === 'ava') { location.href = MENU_BASE + '?aivsai'; return; }
    // PLAYER VS AI: reload into a fresh game after a match; on the first screen just open the hangar.
    if (m.dataset.reload === '1') { location.href = MENU_BASE + '?play'; return; }
    hideGameMenu();
    setGarageOverlays(true);
  });
  return m;
}
function showGameMenu(opts = {}) {
  const m = ensureGameMenu();
  document.getElementById('gm-title').textContent = opts.header || 'RMRF';
  document.getElementById('gm-sub').textContent = opts.sub || 'ISLAND CTF';
  m.dataset.reload = opts.reload ? '1' : '0';
  if (m._setDevView) m._setDevView(false);   // always (re)open on the main view
  m.classList.add('show');
  setGarageOverlays(false);   // hide the deploy HUD behind the menu
}
function hideGameMenu() { const m = document.getElementById('gamemenu'); if (m) m.classList.remove('show'); }

if (GARAGE) ensureGarage();
if (QS.has('win')) {
  // Preview the in-hangar victory cinematic without playing a match: ?win or ?win=jotun.
  setGarageOverlays(false);
  const c = teamColor(PLAYER_TEAM);
  garage.playWin(QS.get('win') || 'firebrat', c);
  showCelebTitle('VICTORY!', c, 'FLAG SECURED');
} else if (START_MENU) showGameMenu();   // open the start screen over the hangar

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
  // Title only on the field descent — the confetti celebration now plays in 3D
  // inside the hangar once the lift lands (see returnToGarage → garage.playWin).
  if (victoryReturn) showCelebTitle('VICTORY!', teamColor(PLAYER_TEAM), 'FLAG SECURED');
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
    // The player extraction is the WIN, but it never routes through endMatch (that
    // path only handles AI captures). Mark the match decided here so the block below
    // runs the victory cinematic + play-again menu instead of dropping back into a
    // live garage and letting the match continue.
    matchOver = true; matchWon = true;
  }
  clearCeleb();        // tidy any field confetti/title before the hangar shows
  // Match decided (not a mid-match death/redeploy) → celebrate, then open the
  // play-again menu (a pick reloads into a brand new world).
  if (matchOver) {
    if (matchWon) {
      // In-hangar victory cinematic: the winner presented on the lift with the flag
      // and 3D confetti, VICTORY title, then the menu pops over it after a beat.
      const c = teamColor(PLAYER_TEAM);
      garage.playWin('firebrat', c);   // the Firebrat is the only flag-carrier, so it's always the winner on the lift
      showCelebTitle('VICTORY!', c, 'FLAG SECURED');
      setTimeout(() => { hideCelebTitle(); showGameMenu({ header: 'VICTORY', sub: 'MATCH OVER', reload: true }); }, WIN_CINEMATIC_MS);
    } else {
      showGameMenu({ header: 'DEFEAT', sub: 'MATCH OVER', reload: true });
    }
  }
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
    ['Q E', 'strafe'],
    ['Click / tap', 'fire'],
    ['Scroll', 'zoom (spectate)'],
    ['LOG', 'AI decision log'],
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
// Map-gen tuning panel (the ⚙ MAP button + sliders) is dialled in — keep it out of
// normal play, available on demand with ?mapgen for tuning sessions.
if (!GARAGE && QS.has('mapgen')) new Controls(DEFAULTS, rebuild);

// --- Tap-to-damage test (temporary, until vehicles can shoot) ----------
// A quick tap (not an orbit drag) fires a damage burst at whatever it hits,
// so destructibility is verifiable on a phone with no console.
const ray = new THREE.Raycaster();
// Debug handle (headless verification / console poking).
window.RR = {
  THREE, scene, camera, map,
  mapCfg: () => MAP_CFG,                                       // debug: the decoded ?mapcfg (designed map), or null
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
  winDemo: (type = 'firebrat', hex = '#46d6ff') => { ensureGarage(); garage.playWin(type, hex); },   // headless: stage the victory cinematic
  get onField() { return onField; },
  get returning() { return returning; },
  forceReturn: () => { if (player && playerElev) { leftPad = true; beginReturn(); } },
  // Preview the end-of-match cinematic without playing a whole round.
  celebrate: (kind = 'victory', team = PLAYER_TEAM) => kind === 'defeat' ? playDefeat() : playVictory(team),
  teamColorName: (t) => teamColorName(t),                     // debug: a team's palette colour name (win banner)
  roadDeckY: (x, z) => roadDeckY(x, z),                       // debug: road/bridge surface height, or null
  bridgeDeckY: (x, z) => roadDeckY(x, z),                     // alias (kept for older verification scripts)
  navPlan: (v, x, z) => planPath(v, { x, z }),                 // debug: A* path for a unit
  navCellBlocked: (v, i, j) => cellBlocked(v, i, j),          // debug: nav passability of a cell
  astar: () => toggleAstarViz(),                              // open/close the A* search visualizer overlay
  get paused() { return paused; },                            // debug: is the sim frozen (full log or A* viz open)

  get astarViz() { if (!_astarViz) _astarViz = new AstarViz(); return _astarViz; },   // debug: the viz instance
  astarBuildGrid: (name) => buildAstarGrid(name),            // debug: the cost/inBounds/bounds for a grid
  avoidCell: (x, z) => avoidCell(x, z),                       // debug: blacklist a cell (stuck-escalation)
  get gateCells() { return [...gateCells]; },
  get gateSideCells() { return [...gateSideCells]; },
  get aiEvents() { return aiEvents.slice(); },                 // debug: the rolling AI decision log (headless can't read the DOM overlay)
  exploreFrac: (i = 0) => { const c = commanders[i]; return c && c.explore ? c.explore.fraction() : null; },   // debug: fraction of map this team has scouted
  exploreWp: (i = 0) => { const c = commanders[i]; return c ? c._exploreWp : null; },                          // debug: current recon waypoint
  aiRoster: (i = 0) => { const c = commanders[i]; return c ? { roster: { ...c.roster }, left: c.fleetLeft(), eliminated: c._eliminated } : null; },   // debug: remaining fleet
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
  acquireForwardTarget: () => { const t = acquireForwardTarget(); return t ? t.type : null; },
  // --- sound-awareness HUD hooks ---
  soundListenerType: () => { const l = soundListener(); return l ? l.type : null; },
  soundSources: () => { const l = soundListener(); return soundSources(l).map(s => ({ type: s.type, loud: +s.loud.toFixed(3) })); },
  emitSoundPing: (x, y, z, idx, team) => emitSoundPing(x, y, z, idx, team),
  get projectiles() { return projectiles; },
  get combatants() { return combatants; },
  get commanders() { return commanders; },
  get flags() { return flags; },
  get teamCtrl() { return TEAM_CTRL; },
  damageVehicle: (v, amt, shooter = null) => damageVehicle(v || player, amt, 'vehicle', shooter),
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
  get matchWon() { return matchWon; },
  tickFlags: (dt = 0.1) => updateFlags(dt),
  tickResupply: (dt = 0.1) => updateResupplies(dt),
  fireUnit: (v) => fireVehicle(v, false),
  fireAtWorld: (x, y, z, v, atEnemy = false) => fireVehicle(v || player, false, new THREE.Vector3(x, y, z), null, atEnemy),
  tickLock: (dt = 0.1) => updateLock(dt),
  lockOnVehicle: (v) => setLock(v, null),
  lockPoint: (x, y, z) => setLock(null, new THREE.Vector3(x, y, z)),
  clearLock: () => clearLock(),
  acquireLock: (px, py) => acquireLock(px, py),
  tickDrive: (dt = 0.1) => driveUpdate(dt),
  refreshHud: () => updatePlayerHud(),
  // --- touch aim-stick test hooks ---
  setAimStick: (nx, ny, mag) => { touchAim = { nx, ny, mag: mag == null ? Math.hypot(nx, ny) : mag }; },
  clearAimStick: () => { touchAim = null; touchAiming = false; fireHeld = false; },
  tickTouchAim: () => updateTouchAim(),
  // --- touch nav-stick test hooks ---
  setNav: (nx, ny, mag) => { touchNav = nx == null ? null : { nx, ny, mag: mag == null ? Math.hypot(nx, ny) : mag }; },
  navInput: () => (player && !player.dead ? driveInput() : null),
  orbitYaw: () => orbit.yaw,
  get touchAimState() { return { aiming: touchAiming, fireHeld, aimPoint: _aimPoint ? { x: _aimPoint.x, y: _aimPoint.y, z: _aimPoint.z } : null, target: _aimTargetVeh ? _aimTargetVeh.type : null, valid: _aimValid }; },
  showTouchControls: () => { touchUsed = true; if (onField) setFieldUI(true); },
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
  // Headless targeting hook: where would the AI aim to lead this moving enemy? (jitter 0 → deterministic)
  leadAim: (sx, sy, sz, ex, ez, vx, vz, soundIndex) => { const p = leadAim({ x: sx, y: sy, z: sz }, { x: ex, y: 0, z: ez, vx, vz }, soundIndex, 0); return { x: p.x, y: p.y, z: p.z }; },
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
// --- A* path overlay (?nav) -------------------------------------------
// Draws each AI unit's CACHED route (commander._nav.path) as a ground line in the team
// colour, a bright dot on the current target waypoint, and a cone on the destination.
// Pure visualisation of data the navigator already stores — no extra pathfinding. Runs
// live and KEEPS drawing while the sim is paused (full-screen log), so you can freeze a
// wedged unit and read exactly where its path is sending it (e.g. a line into the sea).
const NAV_DEBUG = QS.has('nav');
let navLines = null;   // Map<commander, {line, posAttr, wp, dest}>
function _makeNavObj() {
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(256 * 3), 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ depthTest: false, transparent: true, opacity: 0.95 }));
  line.frustumCulled = false; line.renderOrder = 998;
  const wp = new THREE.Mesh(new THREE.SphereGeometry(0.9, 10, 10), new THREE.MeshBasicMaterial({ color: '#ffe24a', depthTest: false }));
  wp.renderOrder = 999;
  const dest = new THREE.Mesh(new THREE.ConeGeometry(1.5, 4.5, 10), new THREE.MeshBasicMaterial({ depthTest: false, transparent: true, opacity: 0.85 }));
  dest.rotation.x = Math.PI;   // apex points DOWN at the destination cell
  dest.renderOrder = 999;
  scene.add(line); scene.add(wp); scene.add(dest);
  return { line, posAttr, wp, dest };
}
function updateNavOverlay() {
  if (!NAV_DEBUG) return;
  if (!navLines) navLines = new Map();
  for (const o of navLines.values()) { o.line.visible = false; o.wp.visible = false; o.dest.visible = false; }
  if (!onField) return;
  for (const cmd of commanders) {
    const v = cmd.unit, nav = cmd._nav;
    if (!v || v.dead || !nav || !nav.path || !nav.path.length) continue;
    let o = navLines.get(cmd);
    if (!o) { o = _makeNavObj(); navLines.set(cmd, o); }
    const col = new THREE.Color(teamColor(cmd.team));
    o.line.material.color.copy(col); o.dest.material.color.copy(col);
    const pts = nav.path, arr = o.posAttr.array;
    let n = 0;
    const add = (x, z) => { if (n >= 256) return; arr[n * 3] = x; arr[n * 3 + 1] = map.heightAt(x, z) + 1.3; arr[n * 3 + 2] = z; n++; };
    add(v.holder.position.x, v.holder.position.z);          // start the line at the unit itself
    // …then only the REMAINING route (from the current target onward). Drawing from
    // index 0 looped back to the path's original start — already behind the unit — which
    // read as the line "going backwards" before heading for the dot.
    for (let i = Math.min(nav.idx, pts.length - 1); i < pts.length; i++) add(pts[i].x, pts[i].z);
    o.posAttr.needsUpdate = true;
    o.line.geometry.setDrawRange(0, n);
    o.line.visible = true;
    // Dot = the next BEND in the route (or the destination), not the per-tick look-ahead
    // cell. The look-ahead point slides ~1 cell ahead of the unit every frame and looked
    // frantic; a bend is a stable landmark — it holds while the unit drives the straight
    // toward it, then hops to the next corner once passed.
    let bi = pts.length - 1;
    const start = Math.min(nav.idx, pts.length - 2);
    if (start >= 0) {
      const seg = i => Math.sign(pts[i + 1].x - pts[i].x) + ',' + Math.sign(pts[i + 1].z - pts[i].z);
      const d0 = seg(start);
      for (let i = start + 1; i <= pts.length - 2; i++) { if (seg(i) !== d0) { bi = i; break; } }
    }
    const w = pts[Math.min(bi, pts.length - 1)];             // the next turn the unit is driving toward
    o.wp.position.set(w.x, map.heightAt(w.x, w.z) + 1.6, w.z); o.wp.visible = true;
    const dp = pts[pts.length - 1];                          // the route's end (its destination)
    o.dest.position.set(dp.x, map.heightAt(dp.x, dp.z) + 3.2, dp.z); o.dest.visible = true;
  }
}

// --- Sound-awareness HUD ----------------------------------------------------
// Lets the player HEAR opponents they can't see: a soft glow on the screen edge points
// toward an off-screen enemy's noise. Loudness = the enemy's engine (louder while moving)
// or a gunfire burst, scaled by distance + engine SIZE, and DAMPED by the player's own
// engine noise (you hear less while driving hard). Works with the volume muted — it's the
// visual twin of the spatial audio (mirrors SoundManager's ENGINE_SPATIAL tuning).
const ACOUSTIC = [
  { ref: 18, max: 125, gain: 0.95 },   // 0 Lurcher
  { ref: 12, max: 78,  gain: 0.60 },   // 1 Firebrat
  { ref: 16, max: 112, gain: 0.85 },   // 2 Valkyrie
  { ref: 26, max: 175, gain: 1.15 },   // 3 Jotun
];
const GUN_RANGE = 700;                 // gunfire carries far (matches SoundManager.fireGunAt)
const SND = { idleEmit: 0.30, gunLoud: 1.6, gunDecay: 1.2, selfMask: 0.6, minAudible: 0.10 };
const soundPings = [];                 // recent gun reports: { x, y, z, idx, team, life }
function emitSoundPing(x, y, z, idx, team) {
  soundPings.push({ x, y, z, idx, team, life: 1 });
  if (soundPings.length > 48) soundPings.shift();
}
function acFall(dist, ref, max) {
  if (dist <= ref) return 1;
  if (dist >= max) return 0;
  return (max - dist) / (max - ref);
}
let soundHudCanvas = null, soundHudCtx = null;
function ensureSoundHud() {
  if (soundHudCanvas) return;
  const c = document.createElement('canvas');
  c.id = 'sound-hud';
  c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:55;';
  document.body.appendChild(c);
  soundHudCanvas = c; soundHudCtx = c.getContext('2d');
}
// Whose "ears" the HUD uses: the human player while driving, else the unit being spectated
// (so AvA / spectate shows what the watched unit hears). null = nobody to listen for.
function soundListener() {
  if (onField && player && !player.dead && TEAM_CTRL[PLAYER_TEAM] === 'human') return player;
  if (onField && _specFocus && !_specFocus.dead) return _specFocus;
  return null;
}
// Enemy sound sources currently audible to `listener` (for drawing + headless test).
function soundSources(listener) {
  const out = [];
  if (!listener || listener.dead) return out;
  const hp = listener.holder.position;
  const pa = ACOUSTIC[listener.def.soundIndex] || ACOUSTIC[0];
  const selfNoise = pa.gain * (SND.idleEmit + (1 - SND.idleEmit) * (listener._throttle || 0)) * SND.selfMask;
  for (const v of combatants) {
    if (v.dead || v === listener || v.team === listener.team || vehicleHidden(v)) continue;
    const a = ACOUSTIC[v.def.soundIndex] || ACOUSTIC[0];
    const dist = Math.hypot(v.holder.position.x - hp.x, v.holder.position.z - hp.z);
    const emit = a.gain * (SND.idleEmit + (1 - SND.idleEmit) * (v._throttle || 0));
    const loud = emit * acFall(dist, a.ref, a.max) - selfNoise;
    if (loud > SND.minAudible) out.push({ pos: v.holder.position, loud, type: 'engine' });
  }
  for (const p of soundPings) {
    if (p.team === listener.team) continue;
    const a = ACOUSTIC[p.idx] || ACOUSTIC[0];
    const dist = Math.hypot(p.x - hp.x, p.z - hp.z);
    const loud = SND.gunLoud * a.gain * acFall(dist, a.ref, GUN_RANGE) * p.life - selfNoise;
    if (loud > SND.minAudible) out.push({ pos: { x: p.x, y: p.y, z: p.z }, loud, type: 'gun' });
  }
  return out;
}
const _shv = new THREE.Vector3();
// True if this source got drawn as an EDGE glow (i.e. it's off-screen / behind you).
function drawEdgeGlow(g, W, H, s) {
  _shv.set(s.pos.x, s.pos.y, s.pos.z).project(camera);
  let nx = _shv.x, ny = _shv.y;
  const behind = _shv.z > 1;
  if (behind) { nx = -nx; ny = -ny; }
  if (!behind && nx >= -0.96 && nx <= 0.96 && ny >= -0.96 && ny <= 0.96) return false;   // on-screen → you can see it
  let dx = nx, dy = -ny;                                   // NDC → screen space (y down)
  const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
  const cx = W / 2, cy = H / 2, pad = 48;
  const sc = Math.min(dx !== 0 ? (W / 2 - pad) / Math.abs(dx) : Infinity,
                      dy !== 0 ? (H / 2 - pad) / Math.abs(dy) : Infinity);
  const ex = cx + dx * sc, ey = cy + dy * sc;
  const loud = Math.max(0, Math.min(1.2, s.loud));
  const R = 50 + loud * 95;
  const alpha = Math.max(0.12, Math.min(0.85, loud * 0.9));
  const col = s.type === 'gun' ? '255,80,55' : '255,190,110';
  const grad = g.createRadialGradient(ex, ey, 0, ex, ey, R);
  grad.addColorStop(0, `rgba(${col},${alpha})`);
  grad.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = grad;
  g.beginPath(); g.arc(ex, ey, R, 0, Math.PI * 2); g.fill();
  return true;
}
function updateSoundHud(dt) {
  for (let i = soundPings.length - 1; i >= 0; i--) {          // decay gun reports (always, so they don't pile up)
    soundPings[i].life -= dt * SND.gunDecay;
    if (soundPings[i].life <= 0) soundPings.splice(i, 1);
  }
  const listener = soundListener();
  if (!listener) { if (soundHudCanvas) soundHudCanvas.style.display = 'none'; return; }
  ensureSoundHud();
  soundHudCanvas.style.display = '';
  const W = window.innerWidth, H = window.innerHeight;
  if (soundHudCanvas.width !== W) soundHudCanvas.width = W;
  if (soundHudCanvas.height !== H) soundHudCanvas.height = H;
  const g = soundHudCtx; g.clearRect(0, 0, W, H);
  for (const s of soundSources(listener)) drawEdgeGlow(g, W, H, s);
}

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
    if (!paused) {                         // full-screen log freezes the whole sim
      updateTouchAim();                      // aim stick → _aimPoint/fireHeld (before drive reads them)
      if (!driveUpdate(dt)) spectateUpdate(dt) || panUpdate(dt);   // player, else follow the action / free cam
      trackVelocities(dt);                 // per-vehicle velocity for AI aim-leading
      if (!matchOver) updateCommanders(dt);  // AI teams (fog-of-war) + flag carry/capture — frozen on win
      for (const c of camps) c.update(dt);
      for (const e of elevators) e.update(dt);
      for (const v of vehicles) v.idle(dt);
      projectiles.update(dt);
      updateProjectileHits();
      if (foliage) foliage.update(dt);       // tree topple animations
      waterT += dt; map.tickWater(waterT);   // animate the water-surface ripples
      destructibles.update(dt);
      updateFx(dt);
      updateHealthBars();
      updateLock(dt);                        // Valkyrie target box: track + colour the lock
      updateAimReticle();                    // cursor crosshair (other vehicles) + aim point
      updateSoundHud(dt);                    // edge-glow cue toward off-screen enemy noise (sound awareness)
      if (touchUsed) orientAimArc();         // keep the touch aim wedge pointing the way the vehicle faces (screen-relative)
      updateResupplies(dt);                  // fuel/ammo/shield POIs + base resupply + shield FX
      updateWallTurrets(dt);                 // base corner turrets fire on intruders in range
      updatePlayerHud();                     // live HUD: fuel drains every frame, not just on events
      updateEngineSounds();                  // spatial enemy/AI engine noise (distance-based)
    }
    updateAiLog();                         // AI decision overlay (renders even while paused)
    updateNavOverlay();                    // ?nav: draw each unit's A* path (also while paused)
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
