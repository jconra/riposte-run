// AIStrategies.js — the commander's "deck of moves". Each strategy is a small
// state machine that tells the commander, every tick: which vehicle to field,
// where to go, and whether to shoot what's ahead. A commander DRAWS a strategy
// (weighted by its personality), plays it, and re-draws on big events — so the
// opponent keeps surprising you (frontal blitz one match, a flanking breach the
// next, an air-snatch with a wall-ignoring Valkyrie the next).
//
// Strategies stay engine-agnostic: they only call back into `cmd` for intel
// (enemy base, the weakest wall, the flag, what vehicles have been spotted), the
// same fog-of-war the units use. New cards (mine-laying, sensor pylons, hitting
// fuel/ammo resupplies) slot in here — see DECK at the bottom + the TODO notes.

// Rough rock-paper-scissors for counter-picking what's been seen (tunable):
// firebrat ← lurcher (firepower) ← valkyrie (mobility) ← jotun (range) ← firebrat.
export const COUNTER = { firebrat: 'lurcher', lurcher: 'valkyrie', valkyrie: 'jotun', jotun: 'firebrat' };
const HEAVY = ['jotun', 'lurcher'];
const FAST = ['firebrat', 'valkyrie'];
function pick(arr, rng) { return arr[(rng() * arr.length) | 0]; }

// Base class: a two-beat "attack then grab" most cards specialise.
// IMPORTANT: wantVehicle() is polled every tick (the commander recalls its unit
// when the answer changes), so it MUST be stable — never re-randomise per call,
// or the unit churns in/out of base forever. Cards lock their pick in `_heavy`/
// `_fast` (chosen once) and only change it on a deliberate step transition.
class Strategy {
  constructor(rng) {
    this.rng = rng; this.step = 'open'; this.t = 0;
    this._heavy = pick(HEAVY, rng);   // this card's committed heavy
    this._fast = pick(FAST, rng);     // ...and fast pick, both fixed for the card
  }
  tick(cmd, dt) { this.t += dt; }
  wantVehicle(cmd) { return this._heavy; }
  objective(cmd) { return cmd.enemyBasePos(); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return 10; }
  // Once carrying the flag, everyone just runs it home.
  _flagOrHome(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return cmd.homePos();
    if (f) return { x: f.group.position.x, z: f.group.position.z };
    return cmd.enemyBasePos();
  }
  // A short, human phrase for whatever objective() currently points at — purely for
  // the AI log so "advance" reads as "advancing → the front gate" instead of a bare
  // verb. The open-step phrase is per-card (`_openLabel`); the grab/carry phrasing is
  // shared. Keep these in sync with objective().
  // Which step to fall BACK to when a runner dies storming a base that isn't soft yet
  // (send a heavy to finish the turrets). Legacy cards re-open; archetypes override.
  softenStep() { return 'open'; }
  _openLabel(cmd) { return 'the enemy base'; }
  objectiveLabel(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return 'home with the flag';
    if (this.step === 'grab') return 'the enemy flag';
    return this._openLabel(cmd);
  }
}

// BLITZ — roll a heavy straight at the front gate, level everything, then send a
// runner once the fortifications buckle. Favoured by aggressive personalities.
class Blitz extends Strategy {
  static weight(p) { return 0.2 + p.aggression * 1.2; }
  tick(cmd, dt) { super.tick(cmd, dt); if (this.step === 'open' && cmd.flagExposed() && (cmd.fortDown() || this.t > 75)) this.step = 'grab'; }
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : this._heavy; }
  objective(cmd) { return this.step === 'grab' ? this._flagOrHome(cmd) : cmd.enemyBasePos(); }
  shoot(cmd) { return this.step !== 'grab'; }
  _openLabel() { return 'the front gate'; }
}

// FLANK & BREACH — skirt to the enemy's WEAKEST wall, punch a hole there with a
// heavy, then slip a Firebrat through the gap to the flag. Patient, sneaky.
class FlankBreach extends Strategy {
  static weight(p) { return 0.5 + (1 - p.aggression) * 0.8 + p.jitter; }
  tick(cmd, dt) { super.tick(cmd, dt); if (this.step === 'open' && cmd.flagExposed() && (cmd.fortDown() || this.t > 85)) this.step = 'grab'; }
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : this._heavy; }
  objective(cmd) { return this.step === 'grab' ? this._flagOrHome(cmd) : cmd.weakestApproach(); }
  shoot(cmd) { return this.step !== 'grab'; }
  _openLabel() { return 'the weakest wall'; }
}

// AIR SNATCH — a Valkyrie ignores walls entirely: fly straight in and shell the
// HQ open from point-blank (only a Firebrat can lift the flag, so the air unit
// can't grab — it's the breacher). Once the flag is exposed, a Firebrat dashes in
// and runs it home. High-risk wildcard; loves a daring commander.
class AirSnatch extends Strategy {
  static weight(p) { return 0.3 + p.wanderlust * 0.9; }
  tick(cmd, dt) { super.tick(cmd, dt); if (this.step === 'open' && cmd.flagExposed()) this.step = 'grab'; }
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : 'valkyrie'; }
  objective(cmd) { return this.step === 'grab' ? this._flagOrHome(cmd) : cmd.enemyBasePos(); }
  shoot(cmd) { return this.step !== 'grab'; }   // valkyrie cracks the HQ; runner holds fire
  arriveDist(cmd) { return this.step === 'grab' ? 3 : 8; }
  _openLabel() { return 'the HQ (flying in)'; }
}

// HUNTER — field the COUNTER to whatever the enemy keeps fielding, roam to find
// and destroy their vehicles, then grab the flag once they're thinned out.
class Hunter extends Strategy {
  static weight(p) { return 0.3 + p.aggression * 0.7; }
  tick(cmd, dt) { super.tick(cmd, dt); if (this.step === 'open' && cmd.flagExposed() && (cmd.fortDown() || this.t > 70)) this.step = 'grab'; }
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : cmd.counterVehicle(); }
  objective(cmd) { return this.step === 'grab' ? this._flagOrHome(cmd) : cmd.enemyBasePos(); }
  shoot(cmd) { return this.step !== 'grab'; }
  _openLabel() { return 'enemy vehicles (hunting)'; }
}

// SCOUT & SNATCH — a Valkyrie flies recon to reveal the field + supply points (it
// sees over walls and crosses water, the best scout), then a Firebrat dashes for the
// flag once the towers are down. Favoured by cautious types.
class ScoutSnatch extends Strategy {
  static weight(p) { return 0.3 + p.defensiveness * 0.8; }
  tick(cmd, dt) { super.tick(cmd, dt); if (this.step === 'open' && cmd.flagExposed() && (cmd.fortDown() || this.t > 55)) this.step = 'grab'; }
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : 'valkyrie'; }
  // Open step: sweep unexplored map (recon) until it's mostly known, THEN press the base.
  objective(cmd) { return this.step === 'grab' ? this._flagOrHome(cmd) : (cmd.exploreTarget() || cmd.enemyBasePos()); }
  shoot(cmd) { return false; }
  arriveDist(cmd) { return this.step === 'grab' ? 3 : 30; }
  _openLabel(cmd) { return cmd && cmd._exploreWp ? 'sweeping for recon' : 'the enemy base'; }
}

// TODO (need new game systems first, then add cards here):
//  - MineLayer / PylonNet: drop area-denial mines + sensor pylons that extend the
//    commander's vision (a "deployables" system on vehicles).
//  - SupplyRaid: hit the enemy's fuel/ammo resupply points first to starve them
//    (needs resupply nodes on the map + the commander knowing/seeing them).

const DECK = [Blitz, FlankBreach, AirSnatch, Hunter, ScoutSnatch];

// --- ARCHETYPES — named commander doctrines (the redesign in ai_behavior.txt) -------
// Unlike a deck CARD (one mood, drawn at random), an ARCHETYPE is the commander's whole
// identity: a fixed multi-phase plan it always runs. First one in: the WARRIOR.
//
// WARRIOR doctrine — "ride out, rack up kills, then break the base":
//   hunt   — take a Lurcher out toward the enemy's elevator to kill what emerges; if we
//            don't know where they are yet, sweep the map (explore) to find them.
//   siege  — after a couple of kills (or a patience timer), bring up a Jotun and level
//            the enemy base, turret-first.
//   grab   — once the fort's breached, send a Firebrat to lift the flag and run it home.
// Steps reuse the 'grab' name so the existing runner-died re-softening logic still fires.
class Warrior extends Strategy {
  constructor(rng) { super(rng); this.step = 'hunt'; }
  tick(cmd, dt) {
    super.tick(cmd, dt);
    if (this.step === 'hunt') {
      if (cmd.kills >= 2 || this.t > 70) { this.step = 'siege'; this.t = 0; }   // bloodied enough → press the base
    } else if (this.step === 'siege') {
      if (cmd.flagExposed() && (cmd.fortDown() || this.t > 85)) { this.step = 'grab'; this.t = 0; }
    }
  }
  softenStep() { return 'siege'; }   // runner died → bring the Jotun back to finish the turrets
  wantVehicle(cmd) { return this.step === 'grab' ? 'firebrat' : this.step === 'siege' ? 'jotun' : 'lurcher'; }
  objective(cmd) {
    if (this.step === 'grab') return this._flagOrHome(cmd);
    if (this.step === 'siege') return cmd.enemyBasePos();
    return cmd.enemyFobPos();   // hunt: ride out to the enemy's elevator and kill what emerges
  }
  shoot(cmd) { return this.step !== 'grab'; }
  arriveDist(cmd) { return this.step === 'grab' ? 3 : 10; }
  objectiveLabel(cmd) {
    const f = cmd.flag();
    if (f && f.carrier === cmd.unit) return 'home with the flag';
    if (this.step === 'grab') return 'the enemy flag';
    if (this.step === 'siege') return 'the enemy base';
    return 'the enemy elevator';
  }
}

// Pick a commander's archetype. Only the Warrior exists so far, so every AI is a Warrior
// for now; as Rogue/Hunter/Turtle land this becomes a weighted choice.
export function pickArchetype(rng = Math.random) { return 'warrior'; }

// Build the strategy a commander runs: its archetype's fixed doctrine, or — until an
// archetype is implemented — a random card off the legacy deck.
export function makeDoctrine(archetype, personality, rng = Math.random, avoid = null) {
  if (archetype === 'warrior') return new Warrior(rng);
  return drawStrategy(personality, rng, avoid);
}

// Weighted random draw, biased by personality, with a dash of pure noise so the
// pick is never fully predictable. `avoid` lets a re-draw prefer something new.
export function drawStrategy(personality, rng = Math.random, avoid = null) {
  const weights = DECK.map(S => {
    let w = Math.max(0.01, S.weight(personality)) * (0.6 + rng() * 0.8);
    if (avoid && S === avoid) w *= 0.25;
    return w;
  });
  let total = weights.reduce((a, b) => a + b, 0), r = rng() * total;
  for (let i = 0; i < DECK.length; i++) { if ((r -= weights[i]) <= 0) return new DECK[i](rng); }
  return new DECK[0](rng);
}
