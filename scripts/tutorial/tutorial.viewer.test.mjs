// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTutorial, TutorialRunError } from './run.mjs';
import { STILL_THRESHOLD, frameAtStart, framesOf } from './lib/tutorial-events.mjs';
import { measureMotion } from './lib/tutorial-capture.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, '.tutorial-out', '.viewer');
const FFMPEG = process.env.RV_FFMPEG
  ?? 'E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe';
const FFPROBE = process.env.RV_FFPROBE
  ?? 'E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe';
const LONG = { timeout: 600_000 };
let serial = 0;
// A timed-out test aborts its `t.signal`; the runner then tears down browser, ffmpeg and server
// instead of outliving the test (the 2026-10-27 37-minute hang).
let currentSignal;
beforeEach((t) => { currentSignal = t.signal; });

before(() => {
  assert.ok(existsSync(join(DIST, 'index.html')), `viewer integration requires a finished dist/index.html; run npm run build (looked in ${DIST})`);
  assert.ok(existsSync(FFMPEG), `viewer integration requires ffmpeg at ${FFMPEG} or RV_FFMPEG`);
  assert.ok(existsSync(FFPROBE), `viewer integration requires ffprobe at ${FFPROBE} or RV_FFPROBE`);
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
});

after(() => rmSync(OUT, { recursive: true, force: true }));

function script(id, { setup = [], actions = [{ type: 'wait', ms: 1000 }], motionRegion, stamp } = {}) {
  return {
    $schema: 'rv-tutorial/1', id, title: id, url: '/?model=DemoRealvirtualWeb.glb',
    viewport: { width: 1920, height: 1080 }, ready: '#rv-viewport', minStepSec: 0.1,
    ...(motionRegion ? { motionRegion } : {}),
    ...(stamp ? { stamp } : {}),
    setup: [{ type: 'waitFor', scene: true, timeoutMs: 120000 }, ...setup],
    steps: [{ id: 'viewer', holdSec: 0.2, tailSec: 0.1, actions }],
  };
}

async function runViewer(label, raw = script(label), options = {}, deps = {}) {
  const key = `${String(++serial).padStart(2, '0')}-${label}`;
  const dir = join(OUT, key);
  const story = join(OUT, `${key}.json`);
  writeFileSync(story, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    const result = await runTutorial({
      script: story, dir, dist: DIST, port: 5199, ffmpeg: FFMPEG, ffprobe: FFPROBE,
      gpuCheck: 'require', motionCheck: 'require', signal: currentSignal, ...options,
    }, deps);
    return { result, error: null, dir };
  } catch (error) { return { result: null, error, dir }; }
}

function expectError(run, diagnosis, exitCode = 1) {
  assert.ok(run.error instanceof TutorialRunError, run.error?.stack ?? 'viewer run unexpectedly succeeded');
  assert.equal(run.error.exitCode, exitCode);
  assert.equal(run.error.diagnosis, diagnosis);
}

function readEvents(run, failed = false) {
  if (!failed) return JSON.parse(readFileSync(join(run.dir, 'events.json'), 'utf8'));
  const temp = readdirSync(run.dir).find((name) => name.startsWith('.tutorial-run-'));
  assert.ok(temp, 'failed viewer run did not retain its diagnostic temp folder');
  return JSON.parse(readFileSync(join(run.dir, temp, 'events-failed.json'), 'utf8'));
}

let primaryPromise;
function primary() {
  primaryPromise ??= runViewer('primary', script('primary', { actions: [
    { type: 'camera', position: [4, 3, 4], target: [0, 0, 0], durationSec: 0.6 },
    { type: 'wait', ms: 1800 },
  ] }));
  return primaryPromise;
}

test('Test_Viewer_VirtualClockEpochNotZero_PreflightPasses', LONG, async () => {
  // B2 rule (2026-10-27): bounded warm-up to the first fixed step, then 40 frames with every frame
  // ≥ 1 step and |Σ Δ simTime − 40/fps| ≤ fixedDt_obs + 1e-4. The report carries every number.
  const run = await primary(); assert.ifError(run.error);
  const preflight = run.result.summary.virtualClockPreflight;
  assert.equal(preflight.verdict, 'ok', preflight.reason ?? '');
  assert.ok(preflight.epoch > 0);
  assert.ok(preflight.warmupFrames >= 1 && preflight.warmupFrames <= framesOf(2, 30));
  assert.equal(preflight.window.length, 40);
  assert.ok(preflight.window.every((d) => d.dSteps >= 1));
  assert.ok(preflight.deviation <= preflight.tolerance);
});

test('Test_Viewer_VirtualClockEpochZero_PreflightFailsExit1', LONG, async () => {
  const run = await runViewer('epoch-zero-preflight', script('epoch-zero-preflight'), { epochZeroDiagnosis: true });
  expectError(run, 'virtual-clock-epoch');
  assert.match(run.error.message, /nothing published/);
});

test('Test_Viewer_MotionGate_RealRun_AboveThreshold', LONG, async () => {
  const run = await primary(); assert.ifError(run.error);
  const motion = readEvents(run).motion;
  assert.equal(motion.verdict, 'ok');
  assert.ok(motion.movedFraction >= 0.10);
});

test('Test_Viewer_MotionGate_PausedSimulation_FailsExit1', LONG, async () => {
  // The pause is the FIRST action of the take, not a setup step: the null-epoch preflight runs
  // between setup and take and needs a RUNNING simulation — a sim paused in setup is
  // indistinguishable from a frozen clock and is refused with `virtual-clock-epoch` (measured
  // 2026-10-27, first run of this case). Three seconds of paused take keep the few moved frames
  // (marker on/off transitions, the lead frames before the press) well under 10 %.
  const run = await runViewer('paused', script('paused', {
    actions: [{ type: 'press', key: 'Space' }, { type: 'wait', ms: 3000 }],
  }));
  expectError(run, 'motion-below-threshold');
  assert.equal(existsSync(join(run.dir, 'events.json')), false);
});

test('Test_Viewer_DecoderControlFrame_NotBlank', LONG, async () => {
  const run = await primary(); assert.ifError(run.error);
  const motion = readEvents(run).motion;
  assert.ok(motion.controlMad >= 0.5);
  assert.ok(existsSync(join(run.dir, 'motion-control.jpg')));
});

test('Test_Viewer_MotionCheckOff_IsRefusedWithCanvas', LONG, async () => {
  const run = await runViewer('motion-off', script('motion-off'), { motionCheck: 'off' });
  expectError(run, 'motion-check-off-with-viewer', 2);
});

test('Test_Viewer_ClickSync_ExactlyZeroFrames', LONG, async () => {
  // Reference point (decided 2026-10-27): the click's OWN frame, `frameAtStart(buttons[down].t)` —
  // the F4/A2 definition (first reacting frame minus the logged event). The old assertion compared
  // against `segment.start`, i.e. against the first frame of the pointer approach, and could only
  // hold if the cursor already stood on the target.
  // The reaction is MEASURED in the video: the Drives button opens the Drive Monitor panel over the
  // bottom-left floor area (probe 2026-10-27: x 72..772, y 716..1015), which nothing else touches —
  // the pointer approaches along the left sidebar, the camera is at rest after its flight, the cell
  // and its motion are elsewhere. Same instrument and threshold as Gate C (mad8x8gray, 0.5 on the
  // 8-bit scale), no new number. The camera flight is the storyboard's motion for Gate C
  // (decided 2026-10-27: a storyboard fix, not a special threshold).
  const REACTION_REGION = { x: 96, y: 752, w: 640, h: 240 };
  const run = await runViewer('click-sync', script('click-sync', {
    actions: [
      { type: 'camera', position: [6.2, 5.1, 5.8], target: [0.62, 1.23, 0.13], durationSec: 1 },
      { type: 'wait', ms: 500 },
      { type: 'click', target: { selector: 'button[aria-label="Drives"]' } },
      { type: 'wait', ms: 1000 },
    ],
  }));
  assert.ifError(run.error);
  const events = readEvents(run);
  const fps = events.video.fps;
  const click = events.buttons.find((event) => event.type === 'down');
  const clickFrame = frameAtStart(click.t, fps);
  const approach = events.segments.find((item) => item.stepId === 'viewer' && item.actionIndex === 2);
  const { diffs } = await measureMotion({ ffmpeg: FFMPEG, mp4: join(run.dir, 'recording.mp4'), region: REACTION_REGION });
  // diffs[f - 1] compares frame f with frame f - 1; search from the start of the click action.
  let reactionFrame = -1;
  for (let f = approach.start; f < events.video.frames; f++) {
    if (diffs[f - 1] >= STILL_THRESHOLD) { reactionFrame = f; break; }
  }
  assert.notEqual(reactionFrame, -1, 'the Drive Monitor panel never appeared in the reaction region');
  assert.equal(reactionFrame - clickFrame, 0, `reaction at frame ${reactionFrame}, click at frame ${clickFrame}`);
});

test('Test_Viewer_StampVisibleOverMarker_SequenceStrictlyPlusOne', LONG, async () => {
  const run = await primary(); assert.ifError(run.error);
  const events = readEvents(run);
  assert.equal(events.frameCheck.stampsContiguous, true);
  assert.deepEqual(events.sync.markers.map((marker) => marker.offsetFrames), [0, 0]);
});

test('Test_Viewer_MarkerOverStamp_CounterCase_FrameCountMismatch', LONG, async () => {
  // Defekt D: the counter-case the plan names as mandatory. The `overlayStacking` seam (tests only,
  // never reachable from main()) restores the SPIKE stacking — overlay root 2147483002 ABOVE a stamp
  // at 2147483000 (`probe.mjs:13/17/35`). The marker then hides the stamp in its frames, the read
  // sequence breaks inside the start-marker window, and Gate A refuses with `frame-count-mismatch`.
  // It is the ROOT that matters: the marker is a child of the root and cannot leave its stacking
  // context (measured 2026-10-27 — raising the marker's own z-index changed nothing).
  // plan-2043: only `stamp: 'inline'` grabs the stamp together with the marker; in proof mode the
  // stamp is never in the app grab, so the counter-case is pinned to inline.
  const run = await runViewer('marker-over-stamp', script('marker-over-stamp', { stamp: 'inline', actions: [
    { type: 'camera', position: [4, 3, 4], target: [0, 0, 0], durationSec: 0.6 },
  ] }), {}, { overlayStacking: { rootZIndex: 2147483002, stampZIndex: 2147483000 } });
  expectError(run, 'frame-count-mismatch');
  assert.match(run.error.message, /contiguous=false/);
  assert.equal(existsSync(join(run.dir, 'events.json')), false);
});

test('Test_Viewer_StampProof_NoResizeReachesTheApp_ProofContiguous', LONG, async () => {
  // plan-2043 (Beleg-Spur): every grab is a plain in-viewport capture, so nothing resizes the page —
  // the renderer is never resized during the take (the guard against captureBeyondViewport's 1x1
  // window). The proof track decodes contiguously and has the recording's frame count.
  const run = await primary(); assert.ifError(run.error);
  const events = readEvents(run);
  assert.deepEqual([events.video.width, events.video.height, events.video.stamp], [1920, 1080, 'proof']);
  assert.equal(events.frameCheck.proofFrames, events.video.frames);
  assert.equal(events.frameCheck.stampsContiguous, true);
  assert.equal(run.result.summary.rendererSetSize, 0, 'no resize may reach the viewer during the take');
  assert.equal(run.result.summary.virtualClockPreflight.verdict, 'ok');
});

test('Test_Viewer_CameraAction_FinishesWithinItsSegment', LONG, async () => {
  const run = await primary(); assert.ifError(run.error);
  const events = readEvents(run);
  const camera = events.segments.find((segment) => segment.actionIndex === 0 && segment.kind === 'action');
  assert.equal(camera.end - camera.start, framesOf(0.6, events.video.fps));
});

test('Test_Viewer_CameraAction_TupleWouldThrow', LONG, async () => {
  const run = await runViewer('camera-tuple-contract', script('camera-tuple-contract', {
    actions: [{ type: 'camera', position: [4, 3, 4], target: [0, 0, 0], durationSec: 0.2 }],
  }));
  assert.ifError(run.error);
  assert.ok(readEvents(run).segments.some((segment) => segment.actionIndex === 0),
    'runner must construct viewer-native Vector3 values; passing storyboard tuples through would throw clone is not a function');
});

test('Test_Viewer_EpochZeroDiagnosis_ProducesFailedMotionLog_PublishesNothing', LONG, async () => {
  const run = await runViewer('epoch-zero-log', script('epoch-zero-log'), { epochZeroDiagnosis: true });
  expectError(run, 'virtual-clock-epoch');
  assert.equal(existsSync(join(run.dir, 'events.json')), false);
  // The motion log of a FAILED run lives in `run.log` (`summary.motion`, run.mjs:1073), which the
  // diagnosis path fills right before it refuses. `events-failed.json` is a snapshot of the
  // in-flight `events` object and is NOT the documented place for this measurement — so this
  // assertion reads the one artefact the runner guarantees, and reads it ONCE for all four fields
  // plus the sequence.
  const temp = readdirSync(run.dir).find((name) => name.startsWith('.tutorial-run-'));
  assert.ok(temp, 'failed viewer run did not retain its diagnostic temp folder');
  const log = JSON.parse(readFileSync(join(run.dir, temp, 'run.log'), 'utf8'));
  for (const field of ['movedFraction', 'movedFrames', 'longestStillFrames', 'controlMad']) assert.equal(typeof log.motion[field], 'number');
  assert.equal(log.motionMadSequence.length, 39);
});
