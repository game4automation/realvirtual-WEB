// plan-659 — WHAT THE VIEWER SMOKE TEST ACCEPTS. Its own module, so the
// criterion itself can be unit-tested (`smoke-acceptance.test.ts`) instead of
// only ever being exercised by the 60 s browser run it decides.
//
// ── Why it is not "no falls" ──────────────────────────────────────────────
//
// The acceptance asked for `falls === 0` while the scene was an empty floor.
// The scene now has an OBSTACLE FIELD, and the robot is supposed to trip over
// it once — that is the point of the field. A green run was therefore reported
// as a failure, which makes the smoke test worthless for every run after it:
// a test that is red when everything works is a test nobody reads.
//
// The scene's own promise is a different one: WHATEVER KNOCKS IT OVER, IT GETS
// BACK UP AND CARRIES ON. So the criterion is `recoveries >= falls` plus a cap
// against a robot that does nothing but fall, and the real failure case is
// GETTING STUCK, which both measured failures took:
//
//   * wedged between two close obstacles — 1 fall, 0 get-ups in 40 s;
//   * frozen on open floor in a tilted squat at projectedGravityZ = -0.71,
//     permanently above the -0.85 recovery threshold: neither fallen (> -0.5)
//     nor upright, so no counter moves at all and only the MOTION stops.
//
// Hence {@link stallAnalysis}: the longest stretch of sim time the BASE spent
// inside a 15 cm circle. At the reference pace (~0.10 m of ground per second)
// a quarter of a minute in one spot is not a gait, it is a robot stuck.

// ── Thresholds ───────────────────────────────────────────────────────────
// All derived from the reference run (60 s in the obstacle field: 3.60 m,
// 1 fall, 1 get-up, 0 dropped sim time, 0 policy stalls, 14 joints), with the
// margin named at each one. Everything scales with the run's SIM seconds, so
// `--sim 20` is not a tripwire and `--sim 300` is not a free pass.

/** Ground covered per second of sim time. Reference 0.060 m/s; a third of it
 *  is still unmistakably walking, and no stuck robot reaches it. */
export const MIN_DISTANCE_PER_SIM_S = 0.02;
/** Floor under that, so a very short run still has to travel (m). */
export const MIN_DISTANCE_M = 1;
/** At most one fall per this many seconds of sim time (reference: 1 in 60). */
export const SIM_S_PER_ALLOWED_FALL = 20;
/** …but never fewer than this many, so a short `--sim` run is not a tripwire. */
export const MIN_ALLOWED_FALLS = 2;
/**
 * Radius the base may stay inside without counting as moving (m).
 *
 * Measured: the robot covers ~0.10 m of ground per second while walking, and
 * a topple plus the stand policy getting back up displaces the base by a
 * decimetre or two. A machine that never leaves a 15 cm circle is doing
 * neither.
 *
 * It is the BASE POSITION, not `distanceM`: that is displacement from the
 * start, and a robot steering around a block walks back towards its start for
 * seconds at a time (measured: 1.149 m → 0.910 m → 1.166 m in one 20 s run)
 * while being anything but stuck.
 */
export const STALL_RADIUS_M = 0.15;
/** Sim seconds confined to that radius that count as stuck. A fall plus the
 *  stand policy getting back up measured ~6 s; 15 s is well clear of it. */
export const MAX_STALL_SIM_S = 15;
/**
 * Stalled inferences allowed per this many seconds of sim time.
 *
 * A "policy stall" is one ORT call that took longer than two policy periods
 * (> 40 ms at 50 Hz, `rv-mujoco-scheduler.ts`) — a WALL-CLOCK symptom, not a
 * correctness one: in `parity` mode the world waits for the action, so a slow
 * inference costs no sim time. That is why `droppedSimTimeS === 0` stays
 * absolute next to this one. The reference run is 0 in 3101 steps; on a loaded
 * machine the first calls after the ORT session warms up cross 40 ms, and
 * failing a green run for that is exactly the kind of false red this file was
 * written to stop. One per 10 s still fails a run that is genuinely starved.
 */
export const SIM_S_PER_ALLOWED_POLICY_STALL = 10;

/**
 * The longest stretch of sim time the base spent inside {@link STALL_RADIUS_M}
 * of where it was — the stuck detector.
 *
 * `samples` are `{ sim, x, y, gz, policy }`, one per wall-clock second of the
 * run. Quadratic in the sample count (a 60 s run has ~60 of them).
 */
export function stallAnalysis(samples) {
  let best = 0;
  let bestAt = null;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    for (let j = i + 1; j < samples.length; j++) {
      const b = samples[j];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= STALL_RADIUS_M) break;
      const span = b.sim - a.sim;
      if (span > best) {
        best = span;
        bestAt = { fromSimS: a.sim, toSimS: b.sim, atM: [a.x, a.y], gz: b.gz, policy: b.policy };
      }
    }
  }
  return { longestStallSimS: Number(best.toFixed(2)), at: bestAt };
}

/** The sentence the report leads with. */
export const ACCEPTANCE_CRITERION =
  'every fall is followed by a get-up, the robot never gets stuck, and nothing is '
  + 'dropped — falling itself is expected in the obstacle field';

/**
 * The verdict. One named check per line, each with its measured value next to
 * its limit, so a red run says WHICH promise broke instead of just "false".
 *
 * @param run      the `report.run` block of the smoke test
 * @param samples  the per-second samples (for {@link stallAnalysis})
 * @param extra    `{ lazyLoad, registry }` — the two structural checks
 */
export function evaluateAcceptance(run, samples, extra) {
  const stall = stallAnalysis(samples);
  const minDistanceM = Math.max(MIN_DISTANCE_M, MIN_DISTANCE_PER_SIM_S * run.simSeconds);
  const maxFalls = Math.max(MIN_ALLOWED_FALLS, Math.round(run.simSeconds / SIM_S_PER_ALLOWED_FALL));
  const maxPolicyStalls = Math.max(1, Math.round(run.simSeconds / SIM_S_PER_ALLOWED_POLICY_STALL));
  const checks = [
    { id: 'lazy-load', pass: extra.lazyLoad.passed, got: extra.lazyLoad.requested.length, limit: '2 plain wasm, no jsep' },
    { id: 'joints-addressable', pass: extra.registry.allAddressable, got: extra.registry.joints.length, limit: 14 },
    // Falling is allowed — the obstacle field is there to make it happen. Not
    // getting back up is not.
    { id: 'every-fall-recovered', pass: run.recoveries >= run.falls, got: `${run.falls} falls / ${run.recoveries} get-ups`, limit: 'get-ups >= falls' },
    { id: 'falls-capped', pass: run.falls <= maxFalls, got: run.falls, limit: `<= ${maxFalls}` },
    // The actual failure case: wedged, or frozen in a tilted squat.
    { id: 'never-stuck', pass: stall.longestStallSimS <= MAX_STALL_SIM_S, got: stall.longestStallSimS, limit: `<= ${MAX_STALL_SIM_S} s inside a ${STALL_RADIUS_M} m circle` },
    { id: 'distance', pass: run.distanceM >= minDistanceM, got: Number(run.distanceM.toFixed(3)), limit: `>= ${minDistanceM.toFixed(2)} m` },
    { id: 'no-dropped-sim-time', pass: run.droppedSimTimeS === 0, got: run.droppedSimTimeS, limit: 0 },
    { id: 'policy-keeps-up', pass: run.policyStalls <= maxPolicyStalls, got: `${run.policyStalls} of ${run.policySteps} steps`, limit: `<= ${maxPolicyStalls}` },
    { id: 'no-non-finite-actions', pass: run.nonFiniteActions === 0, got: run.nonFiniteActions, limit: 0 },
    { id: 'state-finite', pass: run.finite === true, got: run.finite, limit: true },
  ];
  return {
    ok: checks.every((c) => c.pass),
    stall,
    acceptance: {
      criterion: ACCEPTANCE_CRITERION,
      checks,
      failed: checks.filter((c) => !c.pass).map((c) => c.id),
    },
  };
}
