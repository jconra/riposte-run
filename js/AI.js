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

import { COUNTER } from './AIStrategies.js?v=64';   // rock-paper-scissors web for fight-or-flight matchups

const TYPES = ['lurcher', 'firebrat', 'valkyrie', 'jotun'];

// Rough ground-speed rank for the "can I outrun what's shooting me?" survivability check
// in fightScore. Flyers (valkyrie) escape via altitude regardless — handled by view.flyer.
const SPEED = { firebrat: 4, valkyrie: 3, lurcher: 2, jotun: 1 };

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
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

// Fraction of ammo remaining (treat "unknown" as full, matching the old behaviour).
function ammoFrac(view) { return view.self.ammoFrac != null ? view.self.ammoFrac : 1; }
// Pull-out HP threshold: brave brains hold longer (0.27–0.45 across aggression). The
// Jotun is the exception — it's far too slow to flee (a crawling retreat just gets it
// shot in the back), so it holds and keeps firing down to nearly dead.
function bailOf(p, cfg, type) {
  if (type === 'jotun') return 0.12;
  return cfg.bailBase - p.aggression * cfg.bailAggr;
}

// FIGHT-OR-FLIGHT WEIGHTS — the tunable coefficients of the fightScore sum below. Pulled
// out of the code into a named table so the auto-tuning gym can sweep/optimise them (and
// A/B one weight-set against another) WITHOUT editing this file. Defaults reproduce the
// original hand-tuned behaviour exactly. main.js hands each unit its team's set via
// view.fofW (falls back to these), so the two sides can run different weights in self-play.
export const FOF_DEFAULT = {
  hpPivot: 0.45, hpGain: 3,          // healthy → fight, low → flee
  ammoHi: 1, ammoLow: -0.5, ammoDry: -4,   // dry guns can't win
  shield: 1,                         // we have armour to spend
  aggrPivot: 0.45, aggr: 2,          // brave brains press
  defvPivot: 0.4, defv: 1.2,         // cautious brains hold back
  fragile: 1.2,                      // firebrat dies in a hit or two
  numbers: 1.5,                      // local headcount edge
  crossfire: 3,                      // pinned by a turret AND a rival
  enemyShield: 1,                    // they're harder to crack
  counterUs: 1.6,                    // we counter them → press
  counteredBy: 1.8,                  // they counter us → avoid
  weaker: 1.5,                       // rival weaker / already running → finish it
  escape: 1.6,                       // can't outrun them → stand and trade
  facing: 1.0,                       // positional advantage (who has whose back)
  jotunFloor: 1,                     // a Jotun with ammo always fights (can't run)
};

// FIGHT-OR-FLIGHT WEIGHT — should this unit pick a fight with the rival it sees, or keep
// moving and avoid it? A signed score: > 0 = fight, <= 0 = don't engage. Coefficients come
// from v.fofW (this team's weight set) or FOF_DEFAULT.
function fightScore(v, p) {
  const s = v.self, W = v.fofW || FOF_DEFAULT;
  let w = (s.hpFrac - W.hpPivot) * W.hpGain;
  w += s.ammoFrac > 0.5 ? W.ammoHi : (s.ammoFrac <= 0 ? W.ammoDry : W.ammoLow);
  if (s.shield > 0) w += W.shield;
  w += (p.aggression - W.aggrPivot) * W.aggr;
  w -= (p.defensiveness - W.defvPivot) * W.defv;
  if (s.type === 'firebrat') w -= W.fragile;
  // NUMBERS: our local headcount (this unit + nearby friendlies) vs nearby rivals. Even
  // odds is neutral; outnumbered tilts toward breaking off, having the numbers toward ganging
  // up. Only weighed when rivals are actually close (a far sighting isn't a brawl).
  if (v.enemiesNear > 0) w += (((v.alliesNear || 0) + 1) - v.enemiesNear) * W.numbers;
  // CROSSFIRE: pinned by a wall-turret AND a rival at once is a losing trade.
  if (v.threat && v.enemy) w -= W.crossfire;
  if (v.enemy) {
    if (v.enemy.shield > 0) w -= W.enemyShield;
    const et = v.enemy.type;
    if (et && COUNTER[et] === s.type) w += W.counterUs;
    if (et && COUNTER[s.type] === et) w -= W.counteredBy;
    // ENEMY RELATIVE HP: a rival weaker than us (or already running) is worth finishing even
    // when we're hurt — don't both limp away. (Subsumes the old finishHim.)
    if (v.enemy.retreating || (v.enemy.hpFrac != null && v.enemy.hpFrac <= s.hpFrac)) w += W.weaker;
    // ESCAPE SURVIVABILITY: can't outrun what's on us (not a flyer, slower than the rival) →
    // fleeing gets us shot in the back, so stand and trade. Generalises the Jotun's can't-run.
    if (!v.flyer && (SPEED[s.type] || 2) < (SPEED[et] || 2)) w += W.escape;
    // FACING / POSITIONAL ADVANTAGE: who has whose back? A rival turned away must swing around
    // before it can shoot back (free hits → press); if WE'RE caught facing away, they shoot
    // first (disengage). Symmetric, so whoever's exposed reads a flee bias.
    if (v.enemy.heading != null) {
      const dx = v.enemy.x - s.x, dz = v.enemy.z - s.z, d = Math.hypot(dx, dz) || 1;
      const nx = dx / d, nz = dz / d;
      const iFace = (-Math.sin(s.heading)) * nx + (-Math.cos(s.heading)) * nz;               // +1 = we're pointed at them
      const theyFace = (-Math.sin(v.enemy.heading)) * (-nx) + (-Math.cos(v.enemy.heading)) * (-nz);  // +1 = they're pointed at us
      if (iFace > 0.4 && theyFace < 0) w += W.facing;            // we have their back → press
      if (theyFace > 0.4 && iFace < 0) w -= W.facing;            // they have ours → disengage
    }
  }
  // The Jotun can't run, so as long as it has ammo it stands and fights regardless of odds.
  if (s.type === 'jotun' && s.ammoFrac > 0) return Math.max(w, W.jotunFloor);
  return w;
}

// --- CONDITIONS ---------------------------------------------------------
// Each returns a bool from (view, mem, p, cfg). Used both to update latches and to
// pick the active state in the transition table.
const CONDITIONS = {
  always:       () => true,
  mustGo:       (v) => !!v.mustGo,                         // still inside the gate
  hurtLatched:  (v, m) => m._hurt,                         // pulled out to patch up
  // Runner evasion: a Firebrat is too fragile to duel — when an enemy is close it flees
  // (curving toward its goal) instead of engaging. Only firebrats; only a near threat; and
  // only on a RUNNER mission (grabbing the flag / scouting). When the commander has sent it
  // out to FIGHT (attack/siege/defend/intercept), it must NOT flee at the first sight of an
  // enemy — that left it dodging out at 60u, never closing to its 24u gun range, so it never
  // attacked. There it engages instead (see the 'engaging' transition below).
  runnerFlee: (v) => {
    if (v.self.type !== 'firebrat' || !v.runnerMode || !v.seesEnemy || !v.enemy) return false;
    const dx = v.enemy.x - v.self.x, dz = v.enemy.z - v.self.z;
    return dx * dx + dz * dz < 60 * 60;
  },
  // (finishHim removed: "hurt but the rival's weaker → turn and finish" is now a term in
  // fightScore + the engaging-before-retreat ordering, so it needs no special condition.)
  resupLatched: (v, m) => m._resup,                        // heading home to rearm/refuel
  shootGoal:    (v) => !!v.shootGoal,                      // the goal is a fortification

  // Fight-or-flight: only duel a spotted rival when the weighted odds favour it (good
  // hp/ammo/matchup), otherwise keep moving instead of trading into a loss.
  engaging: (v, m, p) => v.seesEnemy && (m._fof != null ? m._fof : fightScore(v, p)) > 0,
  // A wall-turret is shelling us and we still have teeth → silence it first.
  threatened: (v, m, p, cfg) => !!v.threat && ammoFrac(v) > 0 && v.self.hpFrac > bailOf(p, cfg, v.self.type),
  // Chase a recent sighting, but only brave brains bother — and never chase a ghost once
  // the enemy fleet is gone (the commander redirects to the base instead of wasting time).
  pursuing: (v, m, p) => {
    if (v.enemyGone) return false;
    const seenRecently = m.lastSeen && (m.t - m.lastSeen.t) < (3 + p.aggression * 5);
    return seenRecently && p.aggression > 0.6;
  },

  // --- latch triggers ---
  resupNeeded: (v, m, p, cfg) => ammoFrac(v) <= 0 || v.self.fuelFrac < cfg.fuelLow,
  // At an OWN BASE (which also patches the hull) hold until ammo, fuel AND hp are ALL
  // topped off — don't roll back out half-healed. At a single-resource depot, clear once
  // the resource it fills is topped AND the OTHER one is merely "OK to carry on" (not full
  // — the depot can't fill it, so requiring full would camp it forever). This is the match
  // to the routing: a unit only diverts to the ammo depot when fuel is already ≥ fuelOK.
  resupDone:   (v, m, p, cfg) => v.supplyHeals
    ? (ammoFrac(v) >= cfg.topFull && v.self.fuelFrac >= cfg.topFull && v.self.hpFrac >= cfg.topFull)
    : ((ammoFrac(v) >= cfg.ammoFull && v.self.fuelFrac >= cfg.fuelOK) ||
       (v.self.fuelFrac >= cfg.fuelFull && ammoFrac(v) >= cfg.ammoOK)),
  hurtNeeded:  (v, m, p, cfg) => v.self.hpFrac < bailOf(p, cfg, v.self.type),
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

// Per-duel FOOTWORK, the ai_behavior matchup table distilled into three intents:
//   strafe — lateral orbit intensity 0..1 to stay out of the enemy's kill arc (facing the
//            enemy + strafing = orbiting toward its flank/rear).
//   press  — 0..1 desire to CLOSE the distance / cut off a fleeing target (we have the edge).
//   kite   — 0..1 desire to fall back toward our own TOWER COVER when out-matched/pursued.
// Read straight off the doc's per-pair notes (Lurcher vs Jotun = flank to the rear; Lurcher
// vs Valkyrie = strafe but retreat to towers; Valkyrie vs Jotun = circle-strafe; etc.).
function duelTactic(selfType, enemyType) {
  if (selfType === 'valkyrie') {
    if (enemyType === 'jotun')    return { strafe: 1.0, press: 0.2, kite: 0 };    // circle-strafe; the Jotun can't track it
    if (enemyType === 'firebrat') return { strafe: 0.3, press: 0.7, kite: 0 };    // run it down, lead if it flees
    if (enemyType === 'valkyrie') return { strafe: 1.0, press: 0.2, kite: 0.5 };  // no fleeing — back toward our turrets
    return { strafe: 1.0, press: 0.1, kite: 0.4 };                                // vs Lurcher: strafe-and-go, then heal/return
  }
  if (selfType === 'lurcher') {
    if (enemyType === 'jotun')    return { strafe: 1.0, press: 0.6, kite: 0 };     // flank out of the 30° front arc, get behind
    if (enemyType === 'valkyrie') return { strafe: 0.85, press: 0.1, kite: 0.7 }; // jink, and fall back to tower support
    if (enemyType === 'firebrat') return { strafe: 0.5, press: 0.8, kite: 0 };    // close in; cut it off if it runs
    return { strafe: 0.2, press: 0.4, kite: 0.4 };                                // Lurcher mirror: trade close, near our towers
  }
  return { strafe: 0, press: 0, kite: 0 };           // Jotun plants (it WANTS them in its arc); Firebrat runs, doesn't duel
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
    let turn = clamp(steer * 2.0, -1, 1);
    let fwd;
    if (!los) fwd = 0.6;                          // no clean shot → circle in to find one
    else if (dist < range * 0.6) fwd = -0.5;      // inside the danger band → back out
    else if (dist < range * 0.95) fwd = 0;        // hold and pour fire
    else fwd = 1;                                  // close to range
    let fire = false;
    const gate = mode === 'suppress' ? aimGate + 0.05 : aimGate;
    if (los && Math.abs(err) < gate && dist < range * 1.3) fire = mem.rng() < (0.65 + p.aggression * 0.35) * AI_HANDICAP.fireProb;
    // DUEL FOOTWORK (the ai_behavior matchup table) — engage only; suppress keeps its
    // planted siege standoff above. Picks kite / press / strafe from the pairing.
    let strafe = 0;
    if (mode === 'engage' && view.enemy && los) {
      const tac = duelTactic(self.type, view.enemy.type);
      const arc = Math.min(view.shotArc || 0.26, Math.PI);   // how far off-hull the turret can still bear
      const pressured = self.hpFrac < 0.55 || dist < range * 0.6;
      // KITE — out-matched or pressed: fall back toward our own TOWER COVER while the turret
      // keeps bearing on the enemy. Steer the HULL at support; fire whenever the gun bears.
      if (tac.kite > 0.3 && view.support && pressured) {
        const sx = view.support.x - self.x, sz = view.support.z - self.z;
        turn = clamp(wrapPi(Math.atan2(-sx, -sz) - self.heading) * 2.0, -1, 1);
        fwd = 1;
        fire = (Math.abs(err) < arc && dist < range * 1.4) ? mem.rng() < 0.6 * AI_HANDICAP.fireProb : false;
        mem._wantMove = true;
        return { fwd, turn, fire, strafe: 0, state: mode };
      }
      // BLOCKED LINE (shot-feedback): our last rounds kept detonating on the terrain/cover
      // between us and the target instead of on the enemy. Grinding the same shot is the
      // "two units fire at the hill between them forever" stalemate — so commit to a hard
      // sidestep (held ~1.5s so it actually clears the hump) while still test-firing the new
      // lane; the instant a shot connects the feedback resets and normal footwork resumes.
      if (view.shotBlocked) {
        if (mem._unblockT == null || (mem.t - mem._unblockT) > 1.5) {
          mem._unblockDir = mem.rng() < 0.5 ? -1 : 1; mem._unblockT = mem.t;
        }
        mem._wantMove = true;
        return { fwd: 0.35, turn, fire, strafe: mem._unblockDir * 0.95, state: mode };
      }
      // AMBUSH A JOTUN (ai_behavior Hunter): its 30° front arc is a guaranteed hit, so
      // never trade there — if we're in front of a MOVING Jotun, let it roll by: hold fire,
      // ease out of the kill zone, and orbit hard toward its blind rear. Once we're off its
      // nose the normal press/strafe below takes over and we hit it from behind.
      let holdOff = false;
      if (view.enemy.type === 'jotun' && Math.hypot(view.enemy.vx || 0, view.enemy.vz || 0) > 1.5) {
        const rel = wrapPi(Math.atan2(self.x - view.enemy.x, self.z - view.enemy.z)
                         - Math.atan2(view.enemy.vx, view.enemy.vz));   // 0 = on its nose, ±π = behind it
        if (Math.abs(rel) < 1.0) {
          holdOff = true;
          mem._strafeDir = rel >= 0 ? 1 : -1;            // orbit the short way to the rear
          strafe = mem._strafeDir * Math.max(tac.strafe, 0.9);
          fire = false;
          if (dist < range * 0.9) fwd = -0.3;            // back out of the front arc
        }
      }
      // PRESS — we hold the edge (or they're running): close in, and CUT OFF a fleeing
      // target by steering at a point AHEAD of its travel instead of its current spot.
      if (!holdOff && tac.press > 0 && (view.enemy.retreating || tac.press >= 0.7)) {
        if (dist > range * 0.5) fwd = 1;
        if (view.enemy.retreating) {
          const tx = view.enemy.x + (view.enemy.vx || 0) * 0.9, tz = view.enemy.z + (view.enemy.vz || 0) * 0.9;
          turn = clamp(wrapPi(Math.atan2(-(tx - self.x), -(tz - self.z)) - self.heading) * 2.0, -1, 1);
        }
      }
      // STRAFE — orbit out of the kill arc; direction flips on a jittered timer (≈ the
      // "switch directions to dodge the rocket" reflex). Skipped while holding off a Jotun
      // (that sets its own rear-ward orbit just above).
      if (!holdOff && tac.strafe > 0 && dist < range * 1.6) {
        // Juke far more often against a Valkyrie — frequent direction changes throw its
        // homing rockets off (the doc's "switch directions when they fire" reflex, without
        // needing to know the exact moment it shoots).
        const flip = view.enemy.type === 'valkyrie' ? (1.0 + mem.rng() * 1.2) : (2.2 + mem.rng() * 2.2);
        if (mem._strafeT == null || (mem.t - mem._strafeT) > flip) {
          mem._strafeDir = mem.rng() < 0.5 ? -1 : 1; mem._strafeT = mem.t;
        }
        strafe = mem._strafeDir * tac.strafe;
      }
    }
    mem._wantMove = Math.abs(fwd) > 0.3 || Math.abs(strafe) > 0.3;
    return { fwd, turn, fire, strafe, state: mode };
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

  // RUNNER EVASION (ai_behavior Capture): a Firebrat doesn't trade shots — it flees to the
  // OPPOSITE direction and carries on out over the water. The away-from-threat vector leads;
  // the goal is folded in ONLY when it points somewhere safe (not back across the pursuer).
  // The old version always blended the goal and let its weight grow as the unit pulled
  // away, so it kept curving back toward a goal that sat past the enemy — orbiting it to
  // death. Gating the goal pull on "does it lead me back toward the threat?" breaks that.
  flee(ctx) {
    const { view, mem, self } = ctx;
    const e = view.enemy;
    let ax = self.x - e.x, az = self.z - e.z;                       // away from the threat (leads)
    const al = Math.hypot(ax, az) || 1; ax /= al; az /= al;
    let gx = view.goal.x - self.x, gz = view.goal.z - self.z;       // toward the objective
    const gl = Math.hypot(gx, gz) || 1; gx /= gl; gz /= gl;
    // Fold the goal in only when heading for it doesn't mean heading back toward the enemy
    // (goal-dir and away-dir roughly agree). Otherwise run PURE away — straight off the
    // threat (and naturally toward open water) instead of circling back to die.
    const gw = (gx * ax + gz * az) > 0 ? 0.7 : 0;
    const fx = ax + gx * gw, fz = az + gz * gw;
    const desired = Math.atan2(-fx, -fz);                          // model front is local -Z
    const turn = clamp(wrapPi(desired - self.heading) * 2.4, -1, 1);
    mem._wantMove = true;
    return { fwd: 1, turn, fire: false, state: ctx.mode };          // run flat out, hold fire
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
    wedgeLimit: 1.6,     // seconds PRESSED on an obstacle with no gain on the goal before the jolt (a unit sliding along a wall/turret is "moving" but going nowhere)
    wedgeGain: 0.4,      // goal distance must shrink by at least this to count as progress
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
    fuelFull: 0.5,       // fuel fraction that marks "fuel topped" (the resource a fuel depot fills)
    ammoFull: 0.6,       // ammo fraction that marks "ammo topped" (the resource an ammo depot fills)
    fuelOK: 0.25,        // fuel that's "enough to carry on" — the bar the OTHER resource must clear at a depot
    ammoOK: 0.5,         // ammo that's "enough to carry on"
    topFull: 0.99,       // at an OWN BASE (heals too) don't leave until ammo, fuel AND hp are ALL maxed
  },
  // Latched interrupts: once tripped they hold (hysteresis) until their clear
  // condition, and force the matching state via the transition table below.
  latches: [
    { flag: '_resup', trip: 'resupNeeded', clear: 'resupDone' },
    { flag: '_hurt',  trip: 'hurtNeeded',  clear: 'hurtDone' },
  ],
  states: {
    exit:     { behavior: 'exit', skipWhiskers: true },
    flee:     { behavior: 'flee' },
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
    { when: 'runnerFlee',   mode: 'flee',     target: 'goal' },
    // FIGHT-OR-FLIGHT LEADS when a rival is in range: fightScore already weighs hp, ammo,
    // matchup, numbers AND (now) escape-survivability, so let IT decide fight-vs-flee before
    // the blunt hurt-retreat. `fightScore>0` → engage (even if hurt, when the odds justify
    // it); `<=0` → fall through to the retreat below (that's the flight). This replaces the
    // old ordering where a flat "I'm hurt" latch pre-empted the weighted decision (and the
    // finishHim patch that existed only to poke a hole in that override).
    { when: 'engaging',     mode: 'engage',   target: 'enemy' },
    { when: 'hurtLatched',  mode: 'retreat',  target: 'home' },     // hurt AND no fight to be had → limp home to heal
    { when: 'resupLatched', mode: 'resupply', target: 'resupplyOrGoal' },
    { when: 'threatened',   mode: 'suppress', target: 'threat' },
    { when: 'pursuing',     mode: 'pursue',   target: 'lastSeen' },
    { when: 'shootGoal',    mode: 'assault',  target: 'goal' },
    { when: 'always',       mode: 'advance',  target: 'goal' },
  ],
};

// --- FLIGHT RECORDER (debug, off by default) -----------------------------
// Captures each unit's DECISION whenever it CHANGES: the causal `view` fields, WHICH
// transition fired (rule.when = the reason), and the resulting action. This is the
// ground-truth "why did it do that" trace that state-sampling could only infer. Zero
// cost when off (one boolean check per tick). The sim harness / RR toggles it.
let REC_ON = false, REC_MODE = 'changes';   // 'changes' = log on decision change; 'all' = every tick
const REC = []; const REC_CAP = 40000;
export function recStart(mode = 'changes') { REC_ON = true; REC_MODE = mode; REC.length = 0; }
export function recStop() { REC_ON = false; }
export function recDump() { return REC.slice(); }
export function recActive() { return REC_ON; }

// --- runtime-tunable brain config (the auto-tuning gym) ----------------------
// Mutates DEFAULT_BRAIN.config in place so a sweep can try different knob values
// (bailBase, hurtClear, unstickDur, …) across matches WITHOUT a rebuild — every unit on
// the default brain reads the new value next tick. getBrainConfig() with no key returns
// a copy of the whole config so the harness can snapshot/restore it.
export function setBrainConfig(k, v) { if (k in DEFAULT_BRAIN.config) DEFAULT_BRAIN.config[k] = v; return DEFAULT_BRAIN.config[k]; }
export function getBrainConfig(k) { return k ? DEFAULT_BRAIN.config[k] : { ...DEFAULT_BRAIN.config }; }
function maybeRecord(view, mem, reason, state, out) {
  if (!REC_ON) return;
  const key = state + '|' + reason;
  if (REC_MODE !== 'all' && key === mem._recKey) return;   // only when the decision changes
  mem._recKey = key;
  const s = view.self, e = view.enemy;
  REC.push({
    t: +mem.t.toFixed(2), ty: s.type, reason, state,
    hp: +s.hpFrac.toFixed(2), am: +s.ammoFrac.toFixed(2), fu: +s.fuelFrac.toFixed(2),
    sees: !!view.seesEnemy, enemyD: e ? Math.round(Math.hypot(e.x - s.x, e.z - s.z)) : null,
    threat: !!view.threat, threatLOS: !!view.threatLOS, demolish: !!view.demolishTarget, breakT: !!view.breakTarget,
    near: (view.enemiesNear | 0) + 'v' + (view.alliesNear | 0), shotBlk: !!view.shotBlocked, enemyGone: !!view.enemyGone,
    fof: mem._fof != null ? +mem._fof.toFixed(2) : null,
    out: { f: +(out.fwd || 0).toFixed(2), t: +(out.turn || 0).toFixed(2), fire: !!out.fire, s: +(out.strafe || 0).toFixed(2) },
  });
  if (REC.length > REC_CAP) REC.shift();
}

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
    const r = { fwd: -cfg.unstickRev, turn: mem._unstickTurn, fire: false, state: 'unstick' };
    maybeRecord(view, mem, 'unstick', 'unstick', r);
    return r;
  }
  if (mem._wantMove && moved < cfg.stillEps) mem._stillT += view.dt; else mem._stillT = 0;
  // Progress wedge: a unit can SLIDE along a wall/turret at full speed (so the motion
  // check above never trips) yet make no headway toward its goal — it just grinds the
  // obstacle. If it's pressed against something AND its distance to the goal stops
  // shrinking, count that as a wedge too and fire the same reverse-pivot to spin free.
  const pressed = view.blockedAhead || view.blockedLeft || view.blockedRight;
  // …unless it's deliberately squared up shooting a wall/tree clear (a breach) — that's
  // intentional pressing, so let the breach/patience system own it instead of jolting.
  const breaching = view.breakTarget && view.blockedAhead && mem.state !== 'engage' && mem.state !== 'suppress';
  const gd = view.goal ? Math.hypot(view.goal.x - self.x, view.goal.z - self.z) : 0;
  if (mem._wantMove && pressed && !breaching) {
    if (mem._bestGoalD == null || gd < mem._bestGoalD - cfg.wedgeGain) { mem._bestGoalD = gd; mem._wedgeT = 0; }
    else mem._wedgeT += view.dt;
  } else { mem._bestGoalD = gd; mem._wedgeT = 0; }
  if (mem._stillT > cfg.stillLimit || mem._wedgeT > cfg.wedgeLimit) {
    mem._unstick = cfg.unstickDur; mem._unstickTurn = mem.rng() < 0.5 ? -1 : 1;
    mem._stillT = 0; mem._wedgeT = 0; mem._bestGoalD = null;
  }

  // Remember the last confirmed sighting (fuels the 'pursuing' condition).
  if (view.seesEnemy && view.enemy) mem.lastSeen = { x: view.enemy.x, z: view.enemy.z, t: mem.t };

  // Update latched interrupts (hysteresis).
  for (const L of graph.latches) {
    if (!mem[L.flag] && CONDITIONS[L.trip](view, mem, p, cfg)) mem[L.flag] = true;
    else if (mem[L.flag] && CONDITIONS[L.clear](view, mem, p, cfg)) mem[L.flag] = false;
  }

  // Fight-or-flight score for the rival in sight (null if none) — computed ONCE here so the
  // `engaging` condition, the log overlay and the flight recorder all read the same number.
  mem._fof = (view.seesEnemy && view.enemy) ? fightScore(view, p) : null;

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
  const result = stateDef.skipWhiskers ? out : BEHAVIORS.avoid(ctx, out);
  maybeRecord(view, mem, rule.when, mode, result);
  return result;
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
    this._wedgeT = 0;         // time PRESSED on an obstacle with no gain on the goal (sliding-along-a-wall wedge)
    this._bestGoalD = null;   // closest the unit has gotten to the goal during the current press
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
