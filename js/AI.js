// AI.js — opponent "brains". Deliberately knows nothing about THREE or the scene:
// main.js builds a fog-of-war `view` each tick (only what this unit is allowed to
// perceive) and applies the returned intentions. That keeps the AI honest — it
// can't read the player's position unless it actually sees the player or stumbles
// on a freshly damaged wall.
//
// Each brain has a randomised PERSONALITY (aggression / defensiveness / wanderlust
// / a preferred vehicle / reaction jitter) so no two opponents play the same, and
// a little stochastic noise on top so they stay unpredictable.
//
// DATA-DRIVEN DECISION GRAPH: the tactical logic is split into three parts so it
// can be inspected and edited as a flowchart (and round-tripped through an external
// editor) without touching this file:
//   * CONDITIONS — named predicates over the `view` + latched memory.
//   * BEHAVIORS  — named steering routines that produce {fwd,turn,fire}. The trig
//                  lives here; the graph only chooses WHICH one runs and WHEN.
//   * DEFAULT_BRAIN — the graph itself: config knobs, latched interrupts, and an
//                  ordered transition table. `runBrain(graph, view, mem)` walks it.
// `Brain.think()` is now a thin wrapper around runBrain(DEFAULT_BRAIN, …); assign a
// different graph to a brain's `.graph` to change its behavior.

import { COUNTER } from './AIStrategies.js?v=57';   // rock-paper-scissors web for fight-or-flight matchups

const TYPES = ['lurcher', 'firebrat', 'valkyrie', 'jotun'];
const CALLSIGNS = ['Viper', 'Rook', 'Ghost', 'Talon', 'Hammer', 'Wraith', 'Jackal',
                   'Cinder', 'Bolt', 'Reaver', 'Specter', 'Mauler', 'Onyx', 'Karn'];

// AI combat handicap — the single knob for "how hard does the AI hit". A human on a
// touchscreen can't out-aim a perfect bot, so the opponents are deliberately reined in:
//   aimSpread > 1 sprays their shots wider (more clean misses)
//   fireProb  < 1 makes them shoot less often (longer gaps to react / flee)
// Set both to 1.0 for the old, ruthless behavior. Tune to taste.
const AI_HANDICAP = { aimSpread: 1.7, fireProb: 0.7 };

export function randomPersonality(rng = Math.random) {
  // Bias toward a "lead trait" so personalities feel distinct, not all-average.
  const aggression = clamp01(0.25 + rng() * 0.75);
  return {
    aggression,
    defensiveness: clamp01(0.15 + rng() * 0.7),
    wanderlust: 0.35 + rng() * 0.65,
    reaction: 0.15 + rng() * 0.5,        // decision lag (seconds)
    jitter: 0.1 + rng() * 0.4,           // aim/steer noise
    // How readily this brain shoots a destructible obstacle out of its way instead of
    // driving around it. High = trigger-happy: blasts trees/walls on contact and burns
    // ammo (then has to peel off and reload); low = patient: tries to skirt first.
    triggerHappy: clamp01(0.15 + rng() * 0.85),
    pref: TYPES[(rng() * TYPES.length) | 0],
    name: CALLSIGNS[(rng() * CALLSIGNS.length) | 0],
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

// Fraction of ammo remaining (treat "unknown" as full, matching the old behaviour).
function ammoFrac(view) { return view.self.ammoFrac != null ? view.self.ammoFrac : 1; }
// Pull-out HP threshold: brave brains hold longer (0.27–0.45 across aggression).
function bailOf(p, cfg) { return cfg.bailBase - p.aggression * cfg.bailAggr; }

// FIGHT-OR-FLIGHT WEIGHT — should this unit pick a fight with the rival it sees, or
// keep moving and avoid it? A signed score: > 0 = fight, <= 0 = don't engage (carry on
// the mission / let the hurt-latch pull it out if it's taking fire). Built from the
// factors Jacob sketched (hp, ammo, shield, fragility, personality) plus the counter web.
function fightScore(v, p) {
  const s = v.self;
  let w = (s.hpFrac - 0.45) * 3;                                  // healthy → fight, low → flee
  w += s.ammoFrac > 0.5 ? 1 : (s.ammoFrac <= 0 ? -4 : -0.5);      // dry guns can't win
  if (s.shield > 0) w += 1;                                       // we have armour to spend
  w += (p.aggression - 0.45) * 2;                                 // brave brains press
  w -= (p.defensiveness - 0.4) * 1.2;                             // cautious brains hold back
  if (s.type === 'firebrat') w -= 1.2;                            // fragile — dies in a hit or two
  if (v.enemy) {
    if (v.enemy.shield > 0) w -= 1;                               // they're harder to crack
    const et = v.enemy.type;
    if (et && COUNTER[et] === s.type) w += 1.6;                   // we counter them → press
    if (et && COUNTER[s.type] === et) w -= 1.8;                   // they counter us → avoid
  }
  return w;
}

// --- CONDITIONS ---------------------------------------------------------
// Each returns a bool from (view, mem, p, cfg). Used both to update latches and to
// pick the active state in the transition table.
const CONDITIONS = {
  always:       () => true,
  mustGo:       (v) => !!v.mustGo,                         // still inside the gate
  hurtLatched:  (v, m) => m._hurt,                         // pulled out to patch up
  // "Finish him": we're hurt enough to bail, BUT the rival we see is even worse off
  // (lower hp) or is itself running — and we still have ammo. Don't both limp away;
  // turn and put it down. Overrides the hurt retreat only (evaluated just above it).
  finishHim: (v, m, p) => m._hurt && v.seesEnemy && v.enemy && ammoFrac(v) > 0 &&
    (v.enemy.retreating || (v.enemy.hpFrac != null && v.enemy.hpFrac <= v.self.hpFrac)),
  resupLatched: (v, m) => m._resup,                        // heading home to rearm/refuel
  shootGoal:    (v) => !!v.shootGoal,                      // the goal is a fortification

  // Fight-or-flight: only duel a spotted rival when the weighted odds favour it (good
  // hp/ammo/matchup), otherwise keep moving instead of trading into a loss.
  engaging: (v, m, p) => v.seesEnemy && fightScore(v, p) > 0,
  // A wall-turret is shelling us and we still have teeth → silence it first.
  threatened: (v, m, p, cfg) => !!v.threat && ammoFrac(v) > 0 && v.self.hpFrac > bailOf(p, cfg),
  // Chase a recent sighting, but only brave brains bother.
  pursuing: (v, m, p) => {
    const seenRecently = m.lastSeen && (m.t - m.lastSeen.t) < (3 + p.aggression * 5);
    return seenRecently && p.aggression > 0.6;
  },

  // --- latch triggers ---
  resupNeeded: (v, m, p, cfg) => ammoFrac(v) <= 0 || v.self.fuelFrac < cfg.fuelLow,
  resupDone:   (v, m, p, cfg) => ammoFrac(v) > cfg.ammoFull && v.self.fuelFrac > cfg.fuelFull,
  hurtNeeded:  (v, m, p, cfg) => v.self.hpFrac < bailOf(p, cfg),
  hurtDone:    (v, m, p, cfg) => v.self.hpFrac > cfg.hurtClear,
};

// Resolve a transition's `target` key to a world point the behavior aims at.
function resolveTarget(key, view, mem) {
  switch (key) {
    case 'enemy': return view.enemy;
    case 'threat': return view.threat;
    case 'lastSeen': return mem.lastSeen;
    case 'home': return view.home || view.resupply || view.goal;   // where HP actually heals (own base)
    case 'resupplyOrGoal': return view.resupply || view.goal;
    default: return view.goal;
  }
}

// --- BEHAVIORS ----------------------------------------------------------
// Each takes a ctx { view, mem, p, cfg, mode, target, dist, err } and returns the
// motor command. ctx.err is the (jittered) heading error toward the target; the
// behaviors own all the steering geometry.
const BEHAVIORS = {
  // Leaving the FOB: rotate IN PLACE until lined up on the gate, then drive straight
  // out. No dodge overlay here (the graph marks this state skipWhiskers).
  exit(ctx) {
    const { err, mem, cfg } = ctx;
    const turn = clamp(err * cfg.exitTurnGain, -1, 1);
    const fwd = Math.abs(err) < cfg.exitAlign ? 1 : 0;
    mem._wantMove = fwd > 0.3;
    return { fwd, turn, fire: false, state: ctx.mode };
  },

  // Hold at effective range and shoot rather than charging the kill zone. Shared by
  // 'engage' (mobile duel — aggressive brains press closer) and 'suppress' (keep a
  // wall-turret at arm's length and arc around its flank to find a clean line).
  combat(ctx) {
    const { view, mem, p, err, dist, mode, self } = ctx;
    const aimGate = 0.18 + p.aggression * 0.12;
    const want = view.engageRange || 36;
    const range = mode === 'suppress' ? want : want * (1 - p.aggression * 0.45);
    // SIEGE DOCTRINE: silence a turret from a spot where only IT can hit back. If we
    // already have a clean line on the tower, PLANT and pour fire (don't wander off a
    // good shot). Otherwise drive to the radial standoff — outside the base through
    // the turret, away from the other towers' arcs — which also squares us onto it.
    if (mode === 'suppress' && view.threatStand) {
      // SIEGE DOCTRINE: silence the towers ONE AT A TIME from the radial standoff —
      // the spot OUTSIDE the base, through the target turret, where only THAT gun can
      // hit back. The old code planted and fired the instant its NOSE lined up on a
      // tower, so a Valkyrie sat out front hammering one gun while every OTHER tower
      // chewed it. The fix turns on two facts: (1) the turret has an ARC (Valkyrie
      // 90°, Lurcher 360°), so the weapon can keep BEARING on the tower while the hull
      // points elsewhere; (2) so we can steer the hull toward the standoff to SKIRT
      // around the base AND fire the whole way. err here is the hull→tower angle.
      const dsx = view.threatStand.x - self.x, dsz = view.threatStand.z - self.z;
      const dStand = Math.hypot(dsx, dsz);
      const atStand = dStand < 9;                          // arrived at the one-gun spot
      // Fire whenever the turret can bear on the tower (target inside the arc) and it's
      // in range with a clear line — independent of where the hull is pointed.
      const arc = Math.min(view.shotArc || 0.26, Math.PI * 0.55);
      const aimed = Math.abs(err) < arc && dist < want * 1.3;
      const canBear = view.threatLOS && aimed;
      // SIEGE FLATTEN: a ground unit with NO clean line on the tower (a wall/HQ blocks
      // it) doesn't circle forever hunting an angle — it PLANTS, squares onto the nearest
      // WALL in the way, and blasts a path through, so it levels the far side too.
      // Gate on the WALL's range, not the (possibly far) turret's — the obstruction is
      // right in front even when the tower behind it is way out of reach. (Flyers skip
      // this: a Valkyrie clears walls and shoots over them.)
      let demolish = false, demoErr = 0, demoAimed = false;
      if (!view.flyer && !view.threatLOS && view.demolishTarget) {
        const ddx = view.demolishTarget.x - self.x, ddz = view.demolishTarget.z - self.z;
        if (Math.hypot(ddx, ddz) < want * 1.3) {
          demolish = true;
          demoErr = wrapPi(Math.atan2(-ddx, -ddz) - self.heading);   // hull-relative bearing to the wall
          demoAimed = Math.abs(demoErr) < arc;
        }
      }
      const fire = (canBear || (demolish && demoAimed)) ? mem.rng() < (0.7 + p.aggression * 0.3) * AI_HANDICAP.fireProb : false;
      // A ground unit can be physically barred from the standoff (water / coast / a
      // wall it must blow through first). If it's wedged on the way, stop trying to
      // skirt — square up and pour fire into whatever it can see (this fallback is
      // what the earlier "march to the standoff cold" attempt lacked).
      const barred = !view.flyer && mem._stillT > 0.5;
      if (atStand || barred || demolish) {
        const turn = clamp((demolish ? demoErr : err) * 2.2, -1, 1);   // square onto the wall (demolish) or tower
        const fwd = dist > want ? 0.4 : 0;                 // ease into range, then plant
        mem._wantMove = fwd > 0.3;
        return { fwd, turn, fire, state: mode };
      }
      // Skirt: drive the hull toward the standoff (arcing around the base) while the
      // turret keeps firing on the tower whenever it bears. The point is to REACH the
      // flank, not dance out front.
      const eMove = wrapPi(Math.atan2(-dsx, -dsz) - self.heading);
      mem._wantMove = true;
      return { fwd: 1, turn: clamp(eMove * 2.0, -1, 1), fire, state: mode };
    }
    const los = mode !== 'suppress' || view.threatLOS;   // duel target is always visible
    let steer = err;
    if (mode === 'suppress' && view.flankSide) {
      const k = clamp((dist - range) / range, 0, 1);     // 1 far out → 0 at range
      steer = view.threatLOS ? err + view.flankSide * 0.85 * k
                             : err + view.flankSide * 1.5;
    }
    const turn = clamp(steer * 2.0, -1, 1);
    let fwd;
    if (!los) fwd = 0.6;                          // no clean shot → circle in to find one
    else if (dist < range * 0.6) fwd = -0.5;      // inside the danger band → back out
    else if (dist < range * 0.95) fwd = 0;        // hold and pour fire
    else fwd = 1;                                  // close to range
    let fire = false;
    const gate = mode === 'suppress' ? aimGate + 0.05 : aimGate;
    if (los && Math.abs(err) < gate && dist < range * 1.3) fire = mem.rng() < (0.65 + p.aggression * 0.35) * AI_HANDICAP.fireProb;
    mem._wantMove = Math.abs(fwd) > 0.3;
    return { fwd, turn, fire, state: mode };
  },

  // Pound a fortification from the type's reach — heavies shell it from outside the
  // turrets' best range instead of nosing up to the wall.
  assault(ctx) {
    const { view, mem, p, err, dist, mode } = ctx;
    const aimGate = 0.18 + p.aggression * 0.12;
    const want = view.engageRange || 36;
    const standoff = want * 0.7;
    const turn = clamp(err * 2.0, -1, 1);
    const fwd = dist < standoff ? 0.1 : 1;
    let fire = false;
    if (Math.abs(err) < aimGate + 0.06 && dist < standoff * 1.4) fire = mem.rng() < 0.75 * AI_HANDICAP.fireProb;
    mem._wantMove = Math.abs(fwd) > 0.3;
    return { fwd, turn, fire, state: mode };
  },

  // advance / pursue / resupply / retreat — just get to the target.
  seek(ctx) {
    const { view, mem, err, dist, mode } = ctx;
    // Heading HOME to heal/rearm must actually REACH the base (its heal radius is
    // ~12u), so use a tight arrival here — NOT the card's objective standoff, which
    // can be large (e.g. ScoutSnatch parks 30u out to scout) and would otherwise
    // leave a wounded unit frozen just outside its own supply, never healing.
    const homeward = mode === 'retreat' || mode === 'resupply';
    const arrive = homeward ? 5 : (view.arriveDist || 8);
    const turn = clamp(err * 2.0, -1, 1);
    const fwd = dist < arrive ? 0 : 1;
    mem._wantMove = Math.abs(fwd) > 0.3;
    return { fwd, turn, fire: false, state: ctx.mode };
  },

  // Obstacle avoidance OVERLAY (not a standalone state): takes the behavior's intended
  // command and, when the path ahead is blocked, steers around the obstacle while
  // KEEPING the behavior's fire decision. The old version re-decided which way to go
  // EVERY frame and reset the choice the instant the nose cleared — so on anything but
  // a flat wall (a water inlet, a peninsula, a tree clump) it rocked back and forth
  // across the edge making no progress, with its guns switched off: the "dance".
  //
  // The fix is COMMITMENT. Pick a way around ONCE and hold it (so the nose clearing
  // mid-turn doesn't snap us back into the obstacle), keep holding it for `dodgeClear`
  // seconds AFTER the path opens (so we actually get past, not re-block), and only
  // forget the choice once we've been clear a while. If we circle one way for
  // `dodgeFlip` seconds and stay blocked, flip — that breaks a concave trap. And we
  // never gag the weapons: a blocked unit can still fire at whatever's in front of it.
  // True wedges (driving but not moving) are still caught by the unstick reflex.
  avoid(ctx, cmd) {
    const { view, mem, cfg, p } = ctx;
    // SHOOT-THROUGH: a destructible (wall or tree) is dead ahead on the way to the goal.
    // Rather than always circling it, a brain can square the nose onto it and blast a
    // path clear — a Firebrat that can't crush a palm just shoots it down; a heavy
    // levels a wall. How eagerly is the triggerHappy knob: a trigger-happy brain fires
    // almost on contact (and spends ammo, so it has to reload later), a patient one
    // tries to skirt for a beat first and only shoots if it's still wedged. Combat
    // states keep their own targeting (the siege-flatten in `combat`), so skip those.
    const hasAmmo = view.self.ammoFrac == null || view.self.ammoFrac > 0;
    const canBreak = hasAmmo && view.breakTarget && view.blockedAhead && cmd.state !== 'engage' && cmd.state !== 'suppress';
    if (canBreak) {
      mem._breakT = (mem._breakT || 0) + view.dt;
      const patience = (1 - (p.triggerHappy ?? 0.5)) * cfg.breakPatience;   // eager → ~0s, patient → full
      if (mem._breakT > patience) {
        const bt = view.breakTarget, s = view.self;
        const berr = wrapPi(Math.atan2(-(bt.x - s.x), -(bt.z - s.z)) - s.heading);
        mem._wantMove = true;
        return { fwd: 0.3, turn: clamp(berr * 2.4, -1, 1), fire: true, state: cmd.state, breakAim: bt };
      }
    } else {
      mem._breakT = 0;
    }
    if (view.blockedAhead) {
      mem._dodgeClearT = 0;
      if (!mem._dodgeTurn) {                       // choose a way around ONCE, then commit
        mem._dodgeTurn = view.blockedLeft && !view.blockedRight ? 1
                       : view.blockedRight && !view.blockedLeft ? -1
                       : (mem.rng() < 0.5 ? -1 : 1);
        mem._dodgeEpisodeT = 0;
      }
      mem._dodgeEpisodeT += view.dt;
      if (mem._dodgeEpisodeT > cfg.dodgeFlip) { mem._dodgeTurn = -mem._dodgeTurn; mem._dodgeEpisodeT = 0; }
    } else if (mem._dodgeTurn) {
      mem._dodgeClearT += view.dt;                 // path clear — hold the turn a moment, then forget it
      if (mem._dodgeClearT > cfg.dodgeClear) { mem._dodgeTurn = 0; mem._dodgeEpisodeT = 0; }
    }
    if (!mem._dodgeTurn) return cmd;               // no obstacle to round → behavior steers itself
    const boxed = view.blockedLeft && view.blockedRight;   // walled on both feelers → back out, still turning
    mem._wantMove = true;
    return { fwd: boxed ? -0.6 : 0.35, turn: mem._dodgeTurn, fire: cmd.fire, state: cmd.state };
  },
};

// --- DEFAULT_BRAIN — the graph the game ships with ----------------------
// Pure data (no functions): config knobs, latched interrupts, and an ordered
// transition table. This reproduces the hand-written brain exactly and is what the
// flowchart editor loads/exports. States name a BEHAVIOR + whether they skip the
// dodge overlay (skipWhiskers); transitions are evaluated top-to-bottom, first match wins.
export const DEFAULT_BRAIN = {
  version: 1,
  type: 'unit-brain',
  config: {
    stillEps: 0.05,      // movement under this (units/tick) counts as "not moving"
    stillLimit: 1.8,     // seconds wedged before the unstick jolt fires
    unstickDur: 0.7,     // jolt duration (seconds)
    unstickRev: 0.7,     // reverse throttle during the jolt
    dodgeClear: 0.6,     // seconds the path must stay clear before forgetting which way we were going round
    dodgeFlip: 3.0,      // seconds stuck circling one way before flipping to the other (escape a trap)
    breakPatience: 2.4,  // max seconds a PATIENT brain skirts a destructible before it gives up and shoots it (triggerHappy scales this down toward 0)
    exitAlign: 0.30,     // |heading error| under which the exit state drives straight
    exitTurnGain: 2.2,   // steer gain while lining up on the gate
    bailBase: 0.45,      // hp pull-out threshold = bailBase - aggression*bailAggr
    bailAggr: 0.18,
    hurtClear: 0.8,      // hp fraction that clears the "hurt" retreat latch
    fuelLow: 0.18,       // fuel fraction that trips the resupply latch
    fuelFull: 0.5,       // fuel fraction that clears it
    ammoFull: 0.6,       // ammo fraction that clears it
  },
  // Latched interrupts: once tripped they hold (hysteresis) until their clear
  // condition, and force the matching state via the transition table below.
  latches: [
    { flag: '_resup', trip: 'resupNeeded', clear: 'resupDone' },
    { flag: '_hurt',  trip: 'hurtNeeded',  clear: 'hurtDone' },
  ],
  states: {
    exit:     { behavior: 'exit', skipWhiskers: true },
    retreat:  { behavior: 'seek' },
    resupply: { behavior: 'seek' },
    engage:   { behavior: 'combat' },
    suppress: { behavior: 'combat' },
    pursue:   { behavior: 'seek' },
    assault:  { behavior: 'assault' },
    advance:  { behavior: 'seek' },
    unstick:  { behavior: 'unstick' },   // entered only via the anti-wedge reflex
  },
  // Priority ladder: clear the gate first, then self-preservation, then fighting,
  // then the objective. `target` says what the chosen behavior aims at.
  transitions: [
    { when: 'mustGo',       mode: 'exit',     target: 'goal' },
    { when: 'finishHim',    mode: 'engage',   target: 'enemy' },
    { when: 'hurtLatched',  mode: 'retreat',  target: 'home' },
    { when: 'resupLatched', mode: 'resupply', target: 'resupplyOrGoal' },
    { when: 'engaging',     mode: 'engage',   target: 'enemy' },
    { when: 'threatened',   mode: 'suppress', target: 'threat' },
    { when: 'pursuing',     mode: 'pursue',   target: 'lastSeen' },
    { when: 'shootGoal',    mode: 'assault',  target: 'goal' },
    { when: 'always',       mode: 'advance',  target: 'goal' },
  ],
};

// --- the interpreter ----------------------------------------------------
// Walks `graph` against `view`, mutating `mem` (the per-unit latched memory =
// the Brain instance). Reproduces the original think() order of operations exactly,
// including the order of rng() draws, so behavior is identical to the hand-written
// version when run with DEFAULT_BRAIN.
export function runBrain(graph, view, mem) {
  const cfg = graph.config, p = mem.p, self = view.self;
  mem.t += view.dt;

  // --- anti-wedge reflex ---
  // Track motion; if the unit keeps TRYING to drive but isn't moving (jammed on a
  // gate post / wall corner / lift lip) it racks up "still" time and jolts free with
  // a reverse + hard pivot — the backstop that breaks any wedge a behavior can't.
  const moved = mem._lx != null ? Math.hypot(self.x - mem._lx, self.z - mem._lz) : 1;
  mem._lx = self.x; mem._lz = self.z;
  if (mem._unstick > 0) {
    mem._unstick -= view.dt;
    return { fwd: -cfg.unstickRev, turn: mem._unstickTurn, fire: false, state: 'unstick' };
  }
  if (mem._wantMove && moved < cfg.stillEps) mem._stillT += view.dt; else mem._stillT = 0;
  if (mem._stillT > cfg.stillLimit) { mem._unstick = cfg.unstickDur; mem._unstickTurn = mem.rng() < 0.5 ? -1 : 1; mem._stillT = 0; }

  // Remember the last confirmed sighting (fuels the 'pursuing' condition).
  if (view.seesEnemy && view.enemy) mem.lastSeen = { x: view.enemy.x, z: view.enemy.z, t: mem.t };

  // Update latched interrupts (hysteresis).
  for (const L of graph.latches) {
    if (!mem[L.flag] && CONDITIONS[L.trip](view, mem, p, cfg)) mem[L.flag] = true;
    else if (mem[L.flag] && CONDITIONS[L.clear](view, mem, p, cfg)) mem[L.flag] = false;
  }

  // Pick the active state: first transition whose condition holds.
  let rule = graph.transitions[graph.transitions.length - 1];
  for (const t of graph.transitions) { if (CONDITIONS[t.when](view, mem, p, cfg)) { rule = t; break; } }
  const mode = rule.mode;
  mem.state = mode;
  const target = resolveTarget(rule.target, view, mem);

  // Common steering bag: heading error toward the target (with personality jitter).
  const dx = target.x - self.x, dz = target.z - self.z;
  const dist = Math.hypot(dx, dz) || 0.0001;
  // Vehicle front is local -Z → forward = (-sin h, -cos h), so aim = atan2(-dx,-dz).
  const aim = Math.atan2(-dx, -dz);
  const err = wrapPi(aim - self.heading) + (mem.rng() - 0.5) * p.jitter * 0.6 * AI_HANDICAP.aimSpread;
  const ctx = { view, mem, p, cfg, mode, target, dist, err, self };

  const stateDef = graph.states[mode];
  const out = BEHAVIORS[stateDef.behavior](ctx);
  // Overlay obstacle avoidance on the behavior's steering (commit to one way around,
  // keep firing) for any state that doesn't opt out — exit drives itself through the
  // gate, so it skips this.
  return stateDef.skipWhiskers ? out : BEHAVIORS.avoid(ctx, out);
}

export class Brain {
  constructor(personality, rng = Math.random) {
    this.p = personality;
    this.rng = rng;
    this.graph = DEFAULT_BRAIN;   // swap for a custom decision graph (e.g. from the editor)
    this.state = 'patrol';
    this.t = 0;
    this.decideT = 0;
    this.lastSeen = null;     // { x, z, t } — last confirmed enemy sighting
    this.wp = null;           // current patrol waypoint
    this.wpUntil = 0;
    this._dodgeTurn = 0;      // committed way around an obstacle (±1, 0 = none) — held, not re-picked each frame
    this._dodgeClearT = 0;    // seconds the path ahead has been clear (forget the dodge after dodgeClear)
    this._dodgeEpisodeT = 0;  // seconds circling one way while still blocked (flip after dodgeFlip to escape a trap)
    this._resup = false;      // latched: heading home to rearm/refuel (don't dry-chase)
    this._hurt = false;       // latched: badly damaged → fall back to base to patch up
    this._lx = null; this._lz = null;   // last position (anti-wedge movement check)
    this._stillT = 0;         // time spent trying to move but not moving
    this._unstick = 0;        // remaining time of a reverse-and-pivot jolt
    this._unstickTurn = 1;
    this._wantMove = false;   // did last tick intend to drive forward?
  }

  // Tactical layer: drive toward the commander's strategic GOAL, but break off to
  // fight a rival that's actually seen (fog of war). The commander (main.js) decides
  // the goal + whether to shoot it; this executes it with personality + reflexes.
  //
  // view: {
  //   dt, self:{x,z,heading,hpFrac,fuelFrac,ammoFrac},
  //   seesEnemy:bool, enemy:{x,z}|null, threat:{x,z}|null, threatLOS:bool, flankSide:±1,
  //   goal:{x,z}, resupply:{x,z}|null, shootGoal:bool, mustGo:bool,
  //   arriveDist:number, engageRange:number,
  //   blockedAhead:bool, blockedLeft:bool, blockedRight:bool
  // }
  // returns { fwd:-1..1, turn:-1..1, fire:bool, state }
  think(view) {
    return runBrain(this.graph || DEFAULT_BRAIN, view, this);
  }
}
