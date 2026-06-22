// AIStrategies.js — the commander's brain at the MISSION level (the ai_behavior doc).
//
// Two layers, cleanly split:
//   MISSIONS  — reusable "high-level commands" (Scout, Attack, Siege, Capture, Defend).
//               Each only says HOW to execute: which vehicle, where to go, whether to
//               shoot, how close to get, and a log phrase. Missions hold no opinion about
//               WHEN to switch — that keeps them shareable across every personality.
//   PERSONAS  — the four commander identities (Warrior, Rogue, Hunter, Turtle). Each owns
//               an opening mission, a vehicle-role table, and a choose() that — re-checked
//               every tick — decides which mission to be running RIGHT NOW. A mission that
//               has nothing left to do (e.g. Hunter with no enemy to hunt) is simply not
//               chosen again, so a commander can never get stuck shelling an empty field.
//
// The commander (main.js) consumes the same interface it always did: a `strategy` object
// with .step (current mission key), .t, tick(), wantVehicle(), objective(), shoot(),
// arriveDist(), objectiveLabel(). onRunnerLost() replaces the old softenStep poke.

// Rough rock-paper-scissors for counter-picking what's been seen (tunable):
// firebrat ← lurcher (firepower) ← valkyrie (mobility) ← jotun (range) ← firebrat.
export const COUNTER = { firebrat: 'lurcher', lurcher: 'valkyrie', valkyrie: 'jotun', jotun: 'firebrat' };

const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

// ---- MISSIONS — reusable high-level commands ---------------------------------------
// A mission reads the running doctrine (this.doc) for its persona's vehicle-role table,
// so the SAME Siege means "Jotun" for a Warrior and "Valkyrie" for a Rogue.
class Mission {
  constructor() { this.t = 0; }
  enter(cmd, doc) { this.doc = doc; this.t = 0; }
  tick(cmd, dt) { this.t += dt; }
  wantVehicle(cmd) { return this.doc.role(this.key); }
  objective(cmd) { return cmd.enemyBasePos(); }
  shoot(cmd) { return true; }
  arriveDist(cmd) { return 12; }
  label(cmd) { return 'the objective'; }
  // Once carrying the flag, everyone just runs it home.
  _flagOrHome(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return cmd.homePos();
    if (f) return { x: f.group.position.x, z: f.group.position.z };
    return cmd.enemyBasePos();
  }
}

// SCOUT — sweep unexplored map to find the enemy + supply points; don't pick fights.
class Scout extends Mission {
  get key() { return 'scout'; }
  objective(cmd) { return cmd.exploreTarget() || cmd.enemyFobPos(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 30; }
  label(cmd) { return 'sweeping for recon'; }
}

// ATTACK — recall the enemy's last-known position and hunt them down; with no recent
// sighting, fall back to where they emerge (the elevator).
class Attack extends Mission {
  get key() { return 'attack'; }
  objective(cmd) { return cmd.lastEnemyPos() || cmd.enemyFobPos(); }
  arriveDist(cmd) { return 12; }
  label(cmd) { return cmd.lastEnemyPos() ? 'hunting their last position' : 'hunting their vehicles'; }
}

// SIEGE — level the enemy base, turret-first, until the flag is exposed.
class Siege extends Mission {
  get key() { return 'siege'; }
  objective(cmd) { return cmd.enemyBasePos(); }
  arriveDist(cmd) { return cmd.unit && cmd.unit.type === 'valkyrie' ? 26 : 12; }   // flyers shell from standoff
  label(cmd) { return 'the enemy base'; }
}

// CAPTURE — run a Firebrat for the flag; do NOT engage (the runner flees contact).
class Capture extends Mission {
  get key() { return 'capture'; }
  wantVehicle(cmd) { return 'firebrat'; }
  objective(cmd) { return this._flagOrHome(cmd); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 3; }
  label(cmd) { const f = cmd.flag(); return (f && f.carrier === cmd.unit) ? 'home with the flag' : 'snatching the flag'; }
}

// DEFEND — hold the home base under tower cover; the brain still engages on sight. Once
// the towers are gone there's no cover to hold, so switch to a Valkyrie's mobility.
class Defend extends Mission {
  get key() { return 'defend'; }
  wantVehicle(cmd) { return cmd.ownTowersDown() ? 'valkyrie' : this.doc.role('defend'); }
  objective(cmd) { return cmd.patrolSpot(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 8; }
  label(cmd) { return 'holding the flank (ambush)'; }
}

// INTERCEPT — our flag's been lifted: only a Valkyrie is mobile enough to run the thief
// down before it reaches their elevator. Drop everything and chase (ai_behavior Defend).
class Intercept extends Mission {
  get key() { return 'intercept'; }
  wantVehicle(cmd) { return 'valkyrie'; }
  objective(cmd) { return cmd.interceptSpot(); }
  arriveDist(cmd) { return 4; }
  label(cmd) { return 'intercepting the flag runner!'; }
}

const MISSIONS = { scout: Scout, attack: Attack, siege: Siege, capture: Capture, defend: Defend, intercept: Intercept };
function makeMission(key) { return new (MISSIONS[key] || Attack)(); }

// ---- DOCTRINE — a persona running one mission at a time ------------------------------
// Re-evaluates choose() every tick. A change only takes effect once the current mission
// has run a short dwell (anti-thrash) — except URGENT transitions (grab the flag now),
// which fire immediately. This is what makes missions complete/abort cleanly instead of
// the old linear step machine that could never let go of a finished objective.
const URGENT = new Set(['capture', 'intercept']);
const DWELL = 1.5;   // seconds a mission must run before a non-urgent switch

class Doctrine {
  constructor(rng = Math.random, log = null) {
    this.rng = rng; this.log = log; this.t = 0;
    this.mission = makeMission(this.opening);
    this.mission.enter(null, this);
    this.step = this.mission.key;
  }
  role(key) { return this.roles[key] || this.roles.attack || 'lurcher'; }
  tick(cmd, dt) {
    this.t += dt;
    this.mission.tick(cmd, dt);
    const next = this._urgent(cmd) || this.choose(cmd);
    if (next && next !== this.step && (this.t > DWELL || URGENT.has(next))) this._switch(next, cmd);
  }
  // Emergencies that preempt any persona's plan: our flag's been lifted → run it down
  // (unless WE'RE the one carrying the enemy flag home — don't blow a winning run).
  _urgent(cmd) {
    if (cmd.ourFlagStolen() && !(cmd.flag() && cmd.flag().carrier === cmd.unit)) return 'intercept';
    return null;
  }
  _switch(key, cmd) {
    if (!key || key === this.step) { this.t = 0; return; }
    const from = this.step;
    this.mission = makeMission(key);
    this.mission.enter(cmd, this);
    this.step = key; this.t = 0;
    if (this.log) this.log(`${from} → ${key}`);
  }
  // Runner died storming the base → the approach isn't safe; go back to softening it.
  onRunnerLost(cmd) { this._switch(this.softenKey, cmd); }
  get softenKey() { return 'siege'; }
  // --- interface the commander consumes (delegated to the running mission) ---
  wantVehicle(cmd) { return this.mission.wantVehicle(cmd); }
  objective(cmd) { return this.mission.objective(cmd); }
  shoot(cmd) { return this.mission.shoot(cmd); }
  arriveDist(cmd) { return this.mission.arriveDist(cmd); }
  objectiveLabel(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return 'home with the flag';
    return this.mission.label(cmd);
  }
  softenStep() { return this.softenKey; }   // back-compat (no longer poked directly)
}

// WARRIOR — "ride out, rack up kills, then break the base" (uses Lurcher → Jotun → runner).
class Warrior extends Doctrine {
  get opening() { return 'attack'; }
  get roles() { return { scout: 'lurcher', attack: 'lurcher', siege: 'jotun', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagExposed() && cmd.fortDown()) return 'capture';
    if (cmd.kills >= 2 || cmd.enemyEliminated()) return 'siege';
    return 'attack';
  }
}

// ROGUE — "snatch before they know you're there": a Valkyrie quietly softens the flag
// base from range, then a Firebrat races in the instant it's open. Avoids brawls.
class Rogue extends Doctrine {
  get opening() { return 'siege'; }
  get roles() { return { scout: 'firebrat', attack: 'valkyrie', siege: 'valkyrie', defend: 'valkyrie', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagExposed()) return 'capture';   // a race — go the moment the flag shows
    return 'siege';
  }
}

// HUNTER — "own the field, ambush the weak, then snatch". Scouts with a Valkyrie to find
// the enemy (RESERVING its Firebrats for the capture), hunts with a Lurcher, and — the
// key fix — when there's nothing left to hunt, cracks the base instead of firing at air.
class Hunter extends Doctrine {
  get opening() { return 'scout'; }
  get roles() { return { scout: 'valkyrie', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagExposed() && cmd.fortDown()) return 'capture';
    if (cmd.enemyEliminated()) return 'siege';                 // no one to hunt → press the base
    if (cmd.kills >= 3 && cmd.flagExposed()) return 'capture';
    if (!cmd.knowsEnemy()) return 'scout';                     // haven't found them yet → recon
    return 'attack';
  }
}

// TURTLE — "hold the wall, bleed them, then sortie". Defends under tower cover and only
// goes on the offensive once it's beaten attackers back.
class Turtle extends Doctrine {
  get opening() { return 'defend'; }
  get roles() { return { scout: 'lurcher', attack: 'lurcher', siege: 'valkyrie', defend: 'lurcher', capture: 'firebrat' }; }
  choose(cmd) {
    if (cmd.flagExposed() && cmd.fortDown()) return 'capture';
    if (cmd.kills >= 2 || cmd.enemyEliminated()) return 'siege';
    return 'defend';
  }
}

const DOCTRINE_CLASS = { warrior: Warrior, turtle: Turtle, rogue: Rogue, hunter: Hunter };
const ARCHETYPES = Object.keys(DOCTRINE_CLASS);

// One commander's archetype (random). Used for the lone AI in a human match.
export function pickArchetype(rng = Math.random) { return ARCHETYPES[(rng() * ARCHETYPES.length) | 0]; }

// Deal DISTINCT archetypes across N commanders so an AI-vs-AI match is a CONTRAST
// (a Warrior vs a Turtle will actually fight). Shuffles the roster, cycles if N is bigger.
export function assignArchetypes(n, rng = Math.random) {
  const pool = [...ARCHETYPES];
  for (let i = pool.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
  return Array.from({ length: n }, (_, i) => pool[i % pool.length]);
}

// Build the doctrine a commander runs from its archetype name. `log` (optional) is a
// per-commander logger so mission switches surface in the AI overlay.
export function makeDoctrine(archetype, personality, rng = Math.random, avoid = null, log = null) {
  const C = DOCTRINE_CLASS[archetype] || Warrior;
  return new C(rng, log);
}
