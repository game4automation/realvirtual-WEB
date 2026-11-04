// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004) — the canonical frame conversion and the pure verdicts.
 *
 * This module is the ONE place where a duration in seconds becomes a frame count. Runner,
 * trace writer and tests go through these five functions exclusively; a direct
 * `Math.round(sec * fps)` anywhere else is a defect. `fps` is an explicit parameter in every
 * call — the default 30 lives exactly once, as `DEFAULT_FPS`, and callers pass it.
 *
 * It also holds the pure decisions of the three gates, so they can be tested at the value and
 * not only at the comparison:
 *   Gate A  `frameCountVerdict` + `traceCoverageVerdict`
 *   Gate B  `markerVerdict`
 *   Gate C  `mad8x8` + `motionVerdict` + `motionShapeVerdict`
 */

/** The one binding default frame rate of the recorder (Weg C was measured at 30 fps). */
export const DEFAULT_FPS = 30;

/**
 * A `waitFor` whose condition already holds still costs the frame it is checked in — the lower
 * bound of its budget term. Declared, so every budget boundary points at a named constant.
 */
export const MIN_WAIT_FOR_FRAMES = 1;

/** Marker overlay duration in seconds (6 frames at 30 fps). Goes through `framesOf`, never by hand. */
export const MARKER_SEC = 0.2;

/**
 * Lead before the start marker and tail after the end marker, in seconds — CONSTANTS, not the
 * measured onset (3 frames at 30 fps; the measured onset frame 3 confirms them). They live here,
 * next to MARKER_SEC, because both the runner and `frameBudget` need them.
 */
export const MARKER_LEAD_SEC = 0.1;
export const MARKER_TAIL_SEC = 0.1;

/** F4: a UI reaction may lag the logged click by at most this many frames. */
export const MAX_REACTION_FRAMES = 2;

/** Gate C: "moved" starts at this mean absolute difference on the 8-bit grey scale 0…255. */
export const STILL_THRESHOLD = 0.5;

/** Gate C: a run must show motion in at least this fraction of its frame pairs. */
export const MIN_MOVED_FRACTION = 0.1;

/** Gate C region default — the exact crop the spike measured (`crop=400:400:760:500`). */
export const DEFAULT_MOTION_REGION = Object.freeze({ x: 760, y: 500, w: 400, h: 400 });

/** The declared (non-measured) half of `events.motion`; identical in both union variants. */
export const MOTION_METRIC = 'mad8x8gray';
export const MOTION_SCALE = '8bit-gray-0-255';
export const MOTION_DOWNSCALE = 'scale=8:8:flags=area';

/** The one diagnosis name for every violation of the six trace conditions (i)-(vi). */
export const TRACE_DIAGNOSIS = 'trace-not-contiguous';

const SEGMENT_KINDS = Object.freeze(['action', 'command', 'wait', 'hold', 'marker']);

/**
 * Relative tolerance for the frame quantisation.
 *
 * NOT cosmetic: `1.2 * 30` is `36.00000000000001` in IEEE-754, so a naive `Math.ceil` returns 37
 * and misses the value this plan's own test vector fixes (`framesOf(1.2, 30) = 36`). The
 * quantisation therefore rounds a result that is within one part in 1e9 of an integer to that
 * integer before applying the declared direction. The direction itself is unchanged: a duration
 * genuinely above the integer (`1.201 s -> 37`) still rounds up, a maximum genuinely below it
 * (`0.99 s -> 29`) still rounds down.
 */
const EPS = 1e-9;

function tol(x) {
  return EPS * Math.max(1, Math.abs(x));
}

function requireFps(fps, fn) {
  if (typeof fps !== 'number' || !Number.isFinite(fps) || fps <= 0) {
    throw new TypeError(`${fn}: fps is a required, finite, positive argument (got ${String(fps)}) — there is no default at the call site`);
  }
  return fps;
}

function requireSeconds(sec, fn) {
  if (typeof sec !== 'number' || !Number.isFinite(sec)) {
    throw new TypeError(`${fn}: seconds must be a finite number (got ${String(sec)}) — an undefined duration would silently become NaN frames`);
  }
  return sec;
}

function requireFrame(frame, fn) {
  if (typeof frame !== 'number' || !Number.isFinite(frame)) {
    throw new TypeError(`${fn}: frame must be a finite number (got ${String(frame)})`);
  }
  return frame;
}

/**
 * Frame number -> video time, EXACTLY `frame / fps`.
 *
 * No rounding: with Weg C the frame number IS the time (measured: container duration 90.000 s
 * at 2700 frames).
 */
export function frameToSec(frame, fps) {
  requireFrame(frame, 'frameToSec');
  requireFps(fps, 'frameToSec');
  return frame / fps;
}

/**
 * DURATION -> frame count, rounded UP.
 *
 * Every declared duration is a minimum. `ceil` may lengthen a step but never shortens an action
 * or a hold.
 */
export function framesOf(sec, fps) {
  requireSeconds(sec, 'framesOf');
  requireFps(fps, 'framesOf');
  const exact = sec * fps;
  return Math.ceil(exact - tol(exact));
}

/**
 * START instant -> frame number, rounded DOWN.
 *
 * A start must never fall after the declared instant, or the first part of the content drops out
 * of the window.
 */
export function frameAtStart(sec, fps) {
  requireSeconds(sec, 'frameAtStart');
  requireFps(fps, 'frameAtStart');
  const exact = sec * fps;
  return Math.floor(exact + tol(exact));
}

/**
 * END instant -> frame number, rounded UP.
 *
 * An end must never fall before the declared instant; together with `frameAtStart` every interval
 * covers, never clips.
 */
export function frameAtEnd(sec, fps) {
  requireSeconds(sec, 'frameAtEnd');
  requireFps(fps, 'frameAtEnd');
  const exact = sec * fps;
  return Math.ceil(exact - tol(exact));
}

/**
 * MAXIMUM duration -> frame count, rounded DOWN — the counter-direction to `framesOf`.
 *
 * An upper bound must never be exceeded. `floor(1.2 * fps)` written by hand is a no-op at 30 fps
 * and the wrong direction at every other rate, which is why this exists as its own function.
 */
export function framesAtMost(sec, fps) {
  requireSeconds(sec, 'framesAtMost');
  requireFps(fps, 'framesAtMost');
  const exact = sec * fps;
  return Math.floor(exact + tol(exact));
}

/**
 * Gate B, per marker: Weg C tolerates a deviation of exactly 0 frames.
 *
 * Returns the record that goes into `events.sync.markers[i]`.
 */
export function markerVerdict(onsetFrame, expectedFrame) {
  requireFrame(onsetFrame, 'markerVerdict');
  requireFrame(expectedFrame, 'markerVerdict');
  const offsetFrames = onsetFrame - expectedFrame;
  return {
    onsetFrame,
    expectedFrame,
    offsetFrames,
    verdict: offsetFrames === 0 ? 'ok' : 'fail',
    ...(offsetFrames === 0 ? {} : { diagnosis: 'marker-mismatch' }),
  };
}

/**
 * Gate B over BOTH markers plus their drift.
 *
 * `driftFrames = markers[1].offsetFrames - markers[0].offsetFrames`. Weg C demands both offsets
 * and therefore the drift to be 0.
 */
export function syncVerdict(startMarker, endMarker) {
  const start = markerVerdict(startMarker.onsetFrame, startMarker.expectedFrame);
  const end = markerVerdict(endMarker.onsetFrame, endMarker.expectedFrame);
  const driftFrames = end.offsetFrames - start.offsetFrames;
  const ok = start.verdict === 'ok' && end.verdict === 'ok' && driftFrames === 0;
  return {
    markers: [
      { which: 'start', onsetFrame: start.onsetFrame, expectedFrame: start.expectedFrame, offsetFrames: start.offsetFrames },
      { which: 'end', onsetFrame: end.onsetFrame, expectedFrame: end.expectedFrame, offsetFrames: end.offsetFrames },
    ],
    driftFrames,
    verdict: ok ? 'ok' : 'fail',
    ...(ok ? {} : { diagnosis: 'marker-mismatch' }),
  };
}

/**
 * Gate C, the RECHNUNG — exported so a test can pin the VALUE, not only the comparison.
 *
 * Two 64-byte fields of the 8-bit grey scale 0…255 (the `8x8` thumbnail of the region after
 * `crop -> scale=8:8:flags=area -> format=gray`); `mad = sum|cur - prev| / 64`.
 *
 * WARNING to anyone reimplementing this: on a 0..1-normalised scale the same constant 0.5 becomes
 * 50 % of the range and every run fails.
 */
export function mad8x8(prev, cur) {
  if (!prev || !cur || prev.length !== 64 || cur.length !== 64) {
    throw new TypeError(`mad8x8: both fields must hold exactly 64 samples (got ${prev?.length} / ${cur?.length})`);
  }
  let sum = 0;
  for (let j = 0; j < 64; j++) sum += Math.abs(cur[j] - prev[j]);
  return sum / 64;
}

/**
 * Gate C, the DECISION. `diffs` are the per-pair `mad` values of the finished MP4.
 *
 * Denominator is `diffs.length` = `frames - 1`, never `frames`.
 */
export function motionVerdict(diffs, stillThreshold = STILL_THRESHOLD, minMovedFraction = MIN_MOVED_FRACTION) {
  if (!Array.isArray(diffs) || diffs.length === 0) {
    throw new TypeError('motionVerdict: diffs must be a non-empty array of per-pair mad values');
  }
  let movedFrames = 0;
  let longestStillFrames = 0;
  let run = 0;
  for (const d of diffs) {
    if (d >= stillThreshold) {
      movedFrames++;
      run = 0;
    } else {
      run++;
      if (run > longestStillFrames) longestStillFrames = run;
    }
  }
  const movedFraction = movedFrames / diffs.length;
  return {
    diffs: diffs.length,
    movedFrames,
    movedFraction,
    longestStillFrames,
    verdict: movedFraction >= minMovedFraction ? 'ok' : 'fail',
    ...(movedFraction >= minMovedFraction ? {} : { diagnosis: 'motion-below-threshold' }),
  };
}

/**
 * The decoder control frame is its own check with the SAME metric and the SAME constant: the
 * region thumbnail must differ from an all-black frame by `mad >= stillThreshold`.
 *
 * A green ffmpeg exit code is not a proof — the spike's first decoder returned black frames at
 * exit 0.
 */
export function controlFrameVerdict(controlThumbnail, stillThreshold = STILL_THRESHOLD) {
  const black = new Uint8Array(64);
  const controlMad = mad8x8(black, controlThumbnail);
  return {
    controlMad,
    verdict: controlMad >= stillThreshold ? 'ok' : 'fail',
    ...(controlMad >= stillThreshold ? {} : { diagnosis: 'decoder-blank' }),
  };
}

const MOTION_MEASURED_FIELDS = Object.freeze([
  'frames', 'movedFrames', 'movedFraction', 'longestStillFrames', 'controlFrame', 'controlMad',
]);

const MOTION_DECLARED_FIELDS = Object.freeze([
  'region', 'metric', 'scale', 'downscale', 'stillThreshold', 'minMovedFraction',
]);

/**
 * `events.motion` is a DISCRIMINATED UNION — `verdict` is the discriminator.
 *
 * `ok`/`fail` carry EVERY measured field; `skipped-no-viewer` carries NONE of them (not 0, not
 * `null`) plus `reason`. The declared sizes are mandatory in both variants: they are
 * configuration, not measurement, and the run log must name them even in the skip case.
 */
export function motionShapeVerdict(motion) {
  const problems = [];
  if (!motion || typeof motion !== 'object') return { verdict: 'fail', problems: ['motion is not an object'] };

  for (const field of MOTION_DECLARED_FIELDS) {
    if (motion[field] === undefined) problems.push(`declared field missing: ${field}`);
  }
  if (motion.metric !== MOTION_METRIC) problems.push(`metric must be '${MOTION_METRIC}'`);
  if (motion.scale !== MOTION_SCALE) problems.push(`scale must be '${MOTION_SCALE}' — a 0..1 rebuild makes the 0.5 threshold meaningless`);
  if (motion.downscale !== MOTION_DOWNSCALE) problems.push(`downscale must be '${MOTION_DOWNSCALE}' — the filter is part of the metric`);

  if (motion.verdict === 'ok' || motion.verdict === 'fail') {
    for (const field of MOTION_MEASURED_FIELDS) {
      if (motion[field] === undefined || motion[field] === null) {
        problems.push(`measured field missing in variant '${motion.verdict}': ${field}`);
        continue;
      }
      // Present is not enough: a measured variant is valid only when every measured field is a
      // NUMBER (and `controlFrame` a path). A string where a count belongs is the shape that lets
      // a reader compute with it and get a silently wrong gate — the same class of defect that
      // made `movedFrames: null` illegal in the skip variant.
      if (field === 'controlFrame') {
        if (typeof motion[field] !== 'string' || motion[field].length === 0) {
          problems.push(`measured field '${field}' must be a non-empty path string (got ${typeof motion[field]})`);
        }
      } else if (typeof motion[field] !== 'number' || !Number.isFinite(motion[field])) {
        problems.push(`measured field '${field}' must be a finite number (got ${typeof motion[field]}: ${String(motion[field])})`);
      }
    }
    if (motion.reason !== undefined) problems.push("a measured variant carries no 'reason'");
  } else if (motion.verdict === 'skipped-no-viewer') {
    for (const field of MOTION_MEASURED_FIELDS) {
      if (field in motion) problems.push(`skip variant must omit the measured field entirely: ${field}`);
    }
    if (motion.reason !== 'motion-check-off-no-canvas') problems.push("skip variant needs reason: 'motion-check-off-no-canvas'");
  } else {
    problems.push(`unknown verdict: ${String(motion.verdict)}`);
  }
  return { verdict: problems.length === 0 ? 'ok' : 'fail', problems };
}

/**
 * Gate A, the DECISION — exact, no tolerance, not even +-1.
 *
 * `traceFrames` is the reference (the trace's own book over the run), `probedFrames` the ONE
 * measurement at the artifact (`ffprobe -count_frames`). An incomplete trace is rejected BEFORE
 * any comparison is computed: a trace with a hole may never be the reference, otherwise the gate
 * checks itself.
 */
export function frameCountVerdict(traceFrames, probedFrames, stampsContiguous, traceContiguous) {
  if (traceContiguous !== true) {
    return { verdict: 'fail', diagnosis: TRACE_DIAGNOSIS, compared: false };
  }
  if (traceFrames !== probedFrames) {
    return { verdict: 'fail', diagnosis: 'frame-count-mismatch', compared: true };
  }
  if (stampsContiguous !== true) {
    return { verdict: 'fail', diagnosis: 'frame-count-mismatch', compared: true };
  }
  return { verdict: 'ok', compared: true };
}

/**
 * Gate A's trace check — the COVERAGE of `[0; frames)` as its own statement, over the GLOBAL run
 * segment list `events.segments`.
 *
 * All six conditions; every violation sets `verdict: 'fail'` with the one diagnosis
 * `trace-not-contiguous`:
 *   (i)   `segments[0].start === 0`
 *   (ii)  `segments.at(-1).end === frames`
 *   (iii) `end_i === start_{i+1}`, strictly monotonic
 *   (iv)  at most one `pointer` sample per frame
 *   (v)   exactly one owner per segment: `kind === 'marker'` iff `stepId === null`, and every
 *         other `stepId` names a step in `steps`; commands also carry a non-empty `id`
 *   (vi)  every step covers exactly its own segments: they are contiguous and their union is
 *         exactly `[step.start; step.end)`
 *
 * `steps` are the step RECORDS (`id`, `start`, `end`), not a list of names — without `start`/`end`
 * condition (vi) cannot be computed, and `steps[].start/end` would stay the same unchecked
 * derivation that `segmentIndex` was.
 */
export function traceCoverageVerdict(segments, pointer, frames, steps) {
  const problems = [];
  const stepBounds = { ok: true, problems: [] };
  const fail = (msg) => problems.push(msg);

  if (!Array.isArray(segments) || segments.length === 0) {
    return { verdict: 'fail', diagnosis: TRACE_DIAGNOSIS, stepBoundsOk: false, firstStart: null, lastEnd: null, problems: ['segments is empty'] };
  }
  if (!Number.isInteger(frames) || frames <= 0) {
    return { verdict: 'fail', diagnosis: TRACE_DIAGNOSIS, stepBoundsOk: false, firstStart: null, lastEnd: null, problems: [`frames must be a positive integer (got ${String(frames)})`] };
  }

  const stepList = Array.isArray(steps) ? steps : [];
  const byId = new Map();
  for (const step of stepList) {
    byId.set(step.id, step);
    // The schema-side counterpart of J2: a materialised index view in the artifact is the second
    // truth that was removed. A rebuild that reintroduces it "for convenience" fails here.
    if (step && Object.prototype.hasOwnProperty.call(step, 'segmentIndex')) {
      fail(`steps[${step.id}] carries a materialised segmentIndex — removed (J2); filter segments by stepId instead`);
    }
  }

  const firstStart = segments[0].start;
  const lastEnd = segments[segments.length - 1].end;

  // (i) + (ii) — coverage of the whole run, not just neighbourhood.
  if (firstStart !== 0) fail(`(i) segments[0].start is ${firstStart}, must be 0 — prefix gap`);
  if (lastEnd !== frames) fail(`(ii) last segment ends at ${lastEnd}, must be ${frames} — suffix gap`);

  // (iii) + (v) per segment.
  for (let i = 0; i < segments.length; i++) {
    const sg = segments[i];
    if (!Number.isInteger(sg.start) || !Number.isInteger(sg.end)) {
      fail(`(iii) segment ${i} has non-integer bounds (${String(sg.start)}; ${String(sg.end)}) — bounds are frame numbers`);
      continue;
    }
    if (sg.end <= sg.start) fail(`(iii) segment ${i} is not strictly monotonic: [${sg.start}; ${sg.end})`);
    if (i > 0 && segments[i - 1].end !== sg.start) {
      fail(`(iii) gap or overlap between segment ${i - 1} (ends ${segments[i - 1].end}) and ${i} (starts ${sg.start})`);
    }
    if (!SEGMENT_KINDS.includes(sg.kind)) fail(`(v) segment ${i} has unknown kind ${String(sg.kind)}`);
    if (sg.kind === 'command' && (typeof sg.id !== 'string' || sg.id.length === 0)) {
      fail(`(v) segment ${i}: kind 'command' needs a non-empty id`);
    }
    const isMarker = sg.kind === 'marker';
    // `stepId` is a REQUIRED field of the shape `string | null`, so a MISSING key is not the same
    // as `null`: "no segment without an owner entry" is part of condition (v). Treating an absent
    // key as ownerless would let a trace omit the field entirely and still pass, which is exactly
    // the hole the explicit owner contract closes.
    if (!Object.prototype.hasOwnProperty.call(sg, 'stepId')) {
      fail(`(v) segment ${i} has no stepId entry at all — the field is required and is 'string | null', never absent`);
    }
    const ownerless = sg.stepId === null;
    if (isMarker !== ownerless) {
      fail(`(v) segment ${i}: kind === 'marker' must hold exactly when stepId === null (kind ${String(sg.kind)}, stepId ${String(sg.stepId)})`);
    }
    if (!ownerless && !byId.has(sg.stepId)) {
      fail(`(v) segment ${i} names stepId ${String(sg.stepId)}, which is not in steps[]`);
    }
  }

  // (iv) — at most one pointer sample per frame.
  const seenFrames = new Set();
  for (const sample of Array.isArray(pointer) ? pointer : []) {
    if (seenFrames.has(sample.frame)) {
      fail(`(iv) more than one pointer sample for frame ${sample.frame} — one CDP position per frame, a second does not physically exist`);
      break;
    }
    seenFrames.add(sample.frame);
  }

  // (vi) — step bounds are the union of their own segments.
  for (const step of stepList) {
    const own = [];
    for (let i = 0; i < segments.length; i++) if (segments[i].stepId === step.id) own.push(i);
    if (own.length === 0) {
      stepBounds.problems.push(`(vi) step ${step.id} owns no segment`);
      continue;
    }
    for (let k = 1; k < own.length; k++) {
      if (own[k] !== own[k - 1] + 1) {
        stepBounds.problems.push(`(vi) step ${step.id} has its segments split by a segment of another step`);
        break;
      }
    }
    const unionStart = segments[own[0]].start;
    const unionEnd = segments[own[own.length - 1]].end;
    if (step.start !== unionStart) stepBounds.problems.push(`(vi) step ${step.id}: start ${step.start} != ${unionStart} (first own segment)`);
    if (step.end !== unionEnd) stepBounds.problems.push(`(vi) step ${step.id}: end ${step.end} != ${unionEnd} (last own segment)`);
  }
  stepBounds.ok = stepBounds.problems.length === 0;
  problems.push(...stepBounds.problems);

  return {
    verdict: problems.length === 0 ? 'ok' : 'fail',
    ...(problems.length === 0 ? {} : { diagnosis: TRACE_DIAGNOSIS }),
    stepBoundsOk: stepBounds.ok,
    firstStart,
    lastEnd,
    problems,
  };
}

/** The six action types that drive the cursor to a target and therefore carry the approach term. */
const POINTER_ACTIONS = Object.freeze(['click', 'doubleClick', 'hover', 'drag', 'wheel', 'type']);

/** Lower / upper bound of one cursor approach in frames — the Fitts clamp of § 2.3 point 2. */
export function moveFrameBounds(fps) {
  requireFps(fps, 'moveFrameBounds');
  return { min: framesOf(0.35, fps), max: framesAtMost(1.2, fps) };
}

function segmentKindOf(actionType) {
  if (actionType === 'command') return 'command';
  if (actionType === 'wait' || actionType === 'waitFor') return 'wait';
  return 'action';
}

/**
 * The REPORTED plausibility value, never a gate: `[min; max]` of the frame count derivable from
 * the storyboard.
 *
 * Its width comes from pointer approaches (at most 2 re-approaches), `waitFor` timeouts and
 * async command waits. Only click commands approach a button; direct commands dispatch in place.
 *
 * What the budget explicitly does NOT cover: a lost frame of the recording. That is Gate A alone,
 * and the budget must never replace or soften it.
 */
export function frameBudget(script, fps) {
  requireFps(fps, 'frameBudget');
  const move = moveFrameBounds(fps);
  const minStepSec = script.minStepSec ?? 2;
  let min = 0;
  let max = 0;

  // The two marker windows INCLUDING lead-in and tail — exactly the two `marker` segments the
  // runner writes (corrected 2026-10-27 at the first pilot: the budget counted the overlay only).
  const markerWindows = framesOf(MARKER_LEAD_SEC, fps) + 2 * framesOf(MARKER_SEC, fps) + framesOf(MARKER_TAIL_SEC, fps);
  min += markerWindows;
  max += markerWindows;

  for (const step of script.steps ?? []) {
    let stepMin = 0;
    let stepMax = 0;
    for (const action of step.actions ?? []) {
      if (POINTER_ACTIONS.includes(action.type)) {
        stepMin += move.min;          // one approach, no re-approach
        stepMax += 3 * move.max;      // one approach + at most two re-approaches
      }
      switch (action.type) {
        case 'command': {
          // Only a click moves the pointer to a button; direct dispatch has no approach.
          if ((action.via ?? 'click') === 'click') {
            stepMin += move.min;
            stepMax += 3 * move.max;
          }
          const waitFrames = framesOf(action.waitSec ?? 0.3, fps);
          stepMin += 1 + Math.max(1, waitFrames);
          stepMax += 1 + Math.max(1, waitFrames, framesOf(action.maxWaitSec ?? 30, fps));
          break;
        }
        case 'pick': {
          const frames = Math.max(1, framesOf(action.sampleSec ?? 0.3, fps));
          stepMin += frames;
          stepMax += frames;
          break;
        }
        case 'drag': {
          const sec = (action.durationMs ?? 1000) / 1000;
          stepMin += framesOf(sec, fps);
          stepMax += framesOf(sec, fps);
          break;
        }
        case 'type': {
          const sec = (action.text?.length ?? 0) * (action.delayMs ?? 60) / 1000;
          stepMin += framesOf(sec, fps);
          stepMax += framesOf(sec, fps);
          break;
        }
        case 'wait': {
          // The runner records at least one frame for a wait (`Math.max(1, framesOf(…))`).
          const frames = Math.max(1, framesOf((action.ms ?? 0) / 1000, fps));
          stepMin += frames;
          stepMax += frames;
          break;
        }
        case 'waitFor': {
          stepMin += MIN_WAIT_FOR_FRAMES;
          stepMax += framesOf((action.timeoutMs ?? 60000) / 1000, fps);
          break;
        }
        case 'camera': {
          const sec = action.durationSec ?? 0.6;
          stepMin += framesOf(sec, fps);
          stepMax += framesOf(sec, fps);
          break;
        }
        case 'wheel': {
          const steps = action.steps ?? 1;
          stepMin += steps;
          stepMax += steps;
          break;
        }
        case 'doubleClick':
          // Two presses, each in its own frame.
          stepMin += 2;
          stepMax += 2;
          break;
        default:
          // click / hover / press: the event itself is one frame.
          stepMin += 1;
          stepMax += 1;
          break;
      }
    }
    // The hold window is measured from the STEP START and CONTAINS the actions: the runner holds
    // until `start + max(framesOf(minStepSec), framesOf(holdSec) + framesOf(tailSec))`, or longer
    // if the actions take longer (§ 2.4 step 4). Corrected 2026-10-27 at the first pilot, where
    // the additive form put `budget.min` (721) above the real run (579). framesOf PER FIELD (G10).
    const hold = framesOf(step.holdSec ?? minStepSec, fps) + framesOf(step.tailSec ?? 0.4, fps);
    const floorFrames = framesOf(minStepSec, fps);
    stepMin = Math.max(stepMin, hold, floorFrames);
    stepMax = Math.max(stepMax, hold, floorFrames);
    min += stepMin;
    max += stepMax;
  }
  return { min, max };
}

export { POINTER_ACTIONS, segmentKindOf, SEGMENT_KINDS };
