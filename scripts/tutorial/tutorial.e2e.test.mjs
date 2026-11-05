// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createServer } from 'node:http';
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { main, runTutorial, TutorialRunError, withBudget } from './run.mjs';
import { execFileSync } from 'node:child_process';
import {
  aviRawChunks, extractFrame, probeFrames, readStamps, stampsContiguous,
} from './lib/tutorial-capture.mjs';
import { frameAtStart, frameToSec } from './lib/tutorial-events.mjs';
import { parseTutorial } from './lib/tutorial-schema.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_DIR = join(ROOT, 'scripts', 'tutorial', 'fixture');
const FIXTURE_HTML = readFileSync(join(FIXTURE_DIR, 'index.html'));
// The PREBUILT single-file ESM bundle, not the module tree: served as one file there is no
// relative-specifier resolution for the page to get wrong, and reading the PTS of the finished MP4
// stays ONE method.
const MEDIABUNNY_BUNDLE = join(ROOT, 'node_modules', 'mediabunny', 'dist', 'bundles', 'mediabunny.mjs');
const TEST_ROOT = join(ROOT, '.tutorial-out', '.e2e');
const FFMPEG = process.env.RV_FFMPEG
  ?? 'E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe';
const FFPROBE = process.env.RV_FFPROBE
  ?? 'E:/remotion/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe';
const LONG = { timeout: 240_000 };

let fixture;
let base;
let serial = 0;
let servedVideo = null;
const dispatched = [];
const simLog = [];
const executedLog = [];
const geometryLog = [];
const storageLog = [];
// node:test aborts `t.signal` when a test times out or is cancelled. Every run gets it, so a test
// timeout tears the runner down (browser, ffmpeg, server) instead of leaving them alive — the
// 2026-10-27 hang kept Chrome and ffmpeg running for 37 minutes after its test had given up.
let currentSignal;
beforeEach((t) => { currentSignal = t.signal; });
beforeEach(() => { simLog.length = 0; executedLog.length = 0; geometryLog.length = 0; storageLog.length = 0; });

function mime(file) {
  return ({ '.js': 'text/javascript', '.json': 'application/json', '.mp4': 'video/mp4' })[extname(file)]
    ?? 'application/octet-stream';
}

function listen(server, port = 0) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server.address().port));
  });
}

function close(server) {
  return new Promise((resolvePromise) => server?.close(() => resolvePromise()));
}

before(async () => {
  if (!existsSync(FFMPEG) || !existsSync(FFPROBE)) {
    assert.fail(`tutorial E2E requires both encoders; missing: ${[FFMPEG, FFPROBE].filter((p) => !existsSync(p)).join(', ')}`);
  }
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  fixture = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/sim') {
      simLog.push({ frame: Number(url.searchParams.get('frame')), t: Number(url.searchParams.get('t')) });
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/storage') {
      storageLog.push(JSON.parse(url.searchParams.get('data')));
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/exec' || url.pathname === '/geometry') {
      (url.pathname === '/exec' ? executedLog : geometryLog).push(JSON.parse(url.searchParams.get('data')));
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/event') {
      dispatched.push({ id: url.searchParams.get('id'), x: Number(url.searchParams.get('x')), y: Number(url.searchParams.get('y')) });
      response.writeHead(204); response.end(); return;
    }
    if (url.pathname === '/recording.mp4' && servedVideo) {
      response.writeHead(200, { 'content-type': 'video/mp4', 'cache-control': 'no-store' });
      response.end(readFileSync(servedVideo)); return;
    }
    if (url.pathname === '/mediabunny/index.js') {
      if (!existsSync(MEDIABUNNY_BUNDLE)) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      response.end(readFileSync(MEDIABUNNY_BUNDLE)); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(FIXTURE_HTML);
  });
  const port = await listen(fixture);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await close(fixture);
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

function storyboard(id, steps, extra = {}) {
  return {
    $schema: 'rv-tutorial/1', id, title: id, url: extra.url ?? '/', ready: '#instant',
    viewport: { width: 1920, height: 1080 }, minStepSec: 0.01, motionRegion: { x: 760, y: 500, w: 400, h: 400 },
    setup: [], steps, ...extra,
  };
}

function oneClick(id = 'click', selector = null, extra = {}) {
  const target = selector ? { selector } : { x: 960, y: 510 };
  return storyboard(id, [{ id: 'click', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'click', target }], ...extra }]);
}

function casePaths(label, outputDir) {
  const key = `${String(++serial).padStart(3, '0')}-${label}`;
  const dir = outputDir ?? join(TEST_ROOT, key);
  const script = join(TEST_ROOT, `${key}.json`);
  return { dir, script };
}

async function runCase(label, raw, options = {}, deps = {}) {
  const paths = casePaths(label, options.outputDir);
  mkdirSync(dirname(paths.script), { recursive: true });
  writeFileSync(paths.script, `${JSON.stringify(raw, null, 2)}\n`);
  const opts = {
    script: paths.script, dir: paths.dir, base, ffmpeg: FFMPEG, ffprobe: FFPROBE,
    gpuCheck: 'off', motionCheck: 'off', signal: currentSignal, ...options,
  };
  delete opts.outputDir;
  try {
    const result = await runTutorial(opts, deps);
    return { result, error: null, ...paths };
  } catch (error) {
    return { result: null, error, ...paths };
  }
}

function expectError(run, exitCode, diagnosis) {
  assert.ok(run.error instanceof TutorialRunError, run.error?.stack ?? 'run unexpectedly succeeded');
  assert.equal(run.error.exitCode, exitCode);
  assert.equal(run.error.diagnosis, diagnosis);
}

function published(dir) {
  return existsSync(join(dir, 'events.json')) ? JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) : null;
}

function artifactNames(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith('.tutorial-run-')).sort() : [];
}

let primaryPromise;
function primaryRun() {
  if (!primaryPromise) {
    dispatched.length = 0;
    primaryPromise = runCase('primary', storyboard('primary', [{
      id: 'recording', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'wait', ms: 100 }],
    }]));
  }
  return primaryPromise;
}

async function decodePhasePixels(mp4) {
  servedVideo = mp4;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(base);
    return await page.evaluate(async () => {
      const { Input, ALL_FORMATS, BlobSource, VideoSampleSink } = await import('/mediabunny/index.js');
      const blob = await fetch('/recording.mp4', { cache: 'no-store' }).then((r) => r.blob());
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
      const track = await input.getPrimaryVideoTrack();
      const sink = new VideoSampleSink(track);
      const canvas = new OffscreenCanvas(1, 1);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const frames = [];
      for await (const sample of sink.samples()) {
        sample.draw(context, 700, 400, 1, 1, 0, 0, 1, 1);
        frames.push({ t: sample.timestamp, rgb: [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)] });
        sample.close();
      }
      input.dispose();
      return frames;
    });
  } finally { await browser.close(); }
}

test('Test_Run_Steps_WritesMp4AndEvents', LONG, async () => {
  const run = await primaryRun();
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(run.result.summary.connect, 'off');
  assert.equal(events.connect, 'off');
  assert.deepEqual(events.video.width, 1920);
  assert.deepEqual(events.video.height, 1080);
  // plan-2043: default stamp mode 'proof' — the stamp lives in its own track.
  assert.equal(events.video.stamp, 'proof');
  assert.equal(events.video.stampProof, 'stamp-proof.mp4');
  // `probeFrames` returns the whole stream record, not a bare count — Gate A's comparison is
  // against its `frames` field.
  const probed = await probeFrames(FFPROBE, join(run.dir, 'recording.mp4'));
  assert.equal(probed.frames, events.video.frames);
  assert.equal(typeof events.frameCheck.budget.min, 'number');
  assert.equal(typeof events.frameCheck.budget.max, 'number');
  assert.ok(existsSync(join(run.dir, 'motion-control.jpg')));
  assert.ok(readdirSync(run.dir).some((name) => /^stills-.*\.jpg$/.test(name)));
});

/** Per-cell mean grey (16 values) of the 320x20 stamp region of one frame of `mp4`. */
async function stampCellMeans(mp4, frame) {
  const jpg = `${mp4}.corner-f${frame}.jpg`;
  await extractFrame({ ffmpeg: FFMPEG, mp4, frame, out: jpg });
  const avi = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', jpg,
    '-vf', 'crop=320:20:0:0,scale=16:1:flags=area,format=gray', '-c:v', 'rawvideo', '-pix_fmt', 'gray',
    '-frames:v', '1', '-f', 'avi', 'pipe:1'], { maxBuffer: 1 << 24 });
  const [cells] = aviRawChunks(avi);
  assert.ok(cells && cells.length >= 16, `no corner pixels in ${jpg}`);
  return [...cells.subarray(0, 16)];
}

test('Test_Run_StampProof_PristineRecording_ProofContiguous', LONG, async () => {
  // plan-2043 (Beleg-Spur): recording.mp4 is the pristine app, the stamp is only in stamp-proof.mp4,
  // one proof frame per video frame, contiguous +1 over the whole run.
  const run = await primaryRun(); assert.ifError(run.error);
  const events = published(run.dir);
  const mp4 = join(run.dir, 'recording.mp4');
  const proof = join(run.dir, 'stamp-proof.mp4');
  assert.ok(existsSync(proof));
  const video = await probeFrames(FFPROBE, mp4);
  const probe = await probeFrames(FFPROBE, proof);
  assert.deepEqual([video.width, video.height], [1920, 1080]);
  assert.deepEqual([probe.width, probe.height], [320, 20]);
  assert.equal(video.frames, events.video.frames);
  assert.equal(probe.frames, events.video.frames);
  assert.equal(events.frameCheck.proofFrames, events.video.frames);
  assert.equal(events.frameCheck.stampsContiguous, true);
  const read = await readStamps({ ffmpeg: FFMPEG, mp4: proof });
  assert.equal(read.stamps.length, events.video.frames);
  assert.equal(stampsContiguous(read.stamps).contiguous, true);
  // The app's corner shows the fixture background (uniform #18202a), never the black/white cells:
  // a stamp would spread its cells over 0…255.
  for (const frame of [5, Math.floor(events.video.frames / 2)]) {
    const cells = await stampCellMeans(mp4, frame);
    assert.ok(Math.max(...cells) - Math.min(...cells) < 16, `frame ${frame}: corner cells ${cells.join(',')} look like a stamp`);
  }
});

test('Test_Run_StampInline_OldBehaviour_NoProofFile_StampInRecording', LONG, async () => {
  // Regression: `stamp: 'inline'` is the pre-plan-2043 mode — stamp burned into the app corner.
  const run = await runCase('stamp-inline', storyboard('stamp-inline', [{
    id: 'recording', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'wait', ms: 100 }],
  }], { stamp: 'inline' }));
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(events.video.stamp, 'inline');
  assert.equal('stampProof' in events.video, false);
  assert.equal('proofFrames' in events.frameCheck, false);
  assert.equal(existsSync(join(run.dir, 'stamp-proof.mp4')), false);
  assert.equal(events.frameCheck.stampsContiguous, true);
  const read = await readStamps({ ffmpeg: FFMPEG, mp4: join(run.dir, 'recording.mp4') });
  assert.equal(stampsContiguous(read.stamps).contiguous, true);
});

test('Test_Run_StampCliOverride_WinsOverStoryboard_AndIsValidated', LONG, async () => {
  const run = await runCase('stamp-cli', storyboard('stamp-cli', [{
    id: 'recording', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'wait', ms: 100 }],
  }], { stamp: 'proof' }), { stamp: 'inline' });
  assert.ifError(run.error);
  assert.equal(published(run.dir).video.stamp, 'inline');
  assert.equal(existsSync(join(run.dir, 'stamp-proof.mp4')), false);
  assert.equal(await main(['--script', 'x.json', '--stamp', 'band']), 2);
});

test('Test_Run_ClickBox_MatchesFixtureRect', LONG, async () => {
  const run = await runCase('click-box', oneClick('click-box', '#instant')); assert.ifError(run.error);
  const events = published(run.dir);
  const target = events.segments.find((segment) => segment.target)?.target;
  const actual = dispatched.find((event) => event.id === 'instant');
  assert.ok(actual);
  assert.ok(Math.abs(target.x - actual.x + target.w / 2) <= 1);
  assert.ok(Math.abs(target.y - actual.y + target.h / 2) <= 1);
  assert.ok(Math.abs(target.w - 360) <= 1);
  assert.ok(Math.abs(target.h - 140) <= 1);
});

test('Test_Run_ClickPositionIsTheLoggedPoint', LONG, async () => {
  const start = dispatched.length;
  const run = await runCase('click-point', oneClick('click-point', '#instant')); assert.ifError(run.error);
  const event = published(run.dir).buttons.find((item) => item.type === 'down');
  const actual = dispatched.slice(start).find((item) => item.id === 'instant');
  assert.ok(actual);
  assert.ok(Math.abs(actual.x - event.x) <= 1 && Math.abs(actual.y - event.y) <= 1,
    `dispatched (${actual.x},${actual.y}) != logged (${event.x},${event.y})`);
});

test('Test_Run_ClickSync_FiveClicksDifferentPhases', { timeout: 300_000 }, async () => {
  const waits = [470, 510, 550, 590];
  const actions = [];
  for (let i = 0; i < 5; i++) {
    actions.push({ type: 'click', target: { x: 960, y: 510 } });
    if (i < waits.length) actions.push({ type: 'wait', ms: waits[i] });
  }
  const run = await runCase('five-phases', storyboard('five-phases', [{ id: 'five-clicks', holdSec: 0.01, tailSec: 0.01, actions }]));
  assert.ifError(run.error);
  const events = published(run.dir);
  const clicks = events.buttons.filter((item) => item.type === 'down');
  assert.equal(clicks.length, 5);
  const frames = await decodePhasePixels(join(run.dir, 'recording.mp4'));
  const palette = [[217, 72, 15], [43, 138, 62], [134, 46, 156], [230, 119, 0], [11, 114, 133]];
  // A TIGHT match, never a nearest-neighbour one, and the search walks forward. Nearest-neighbour
  // assigns the fixture's pre-click colour #273444 to palette entry 1 (squared distance 7448,
  // closer than to any other entry), so phase 2 would be "found" in frame 0 and its offset would
  // come out as a large NEGATIVE number. The tolerance covers the yuv420p round trip; the
  // pre-click colour is more than five times further away than it.
  const distance = (rgb, colour) => colour.reduce((sum, value, channel) => sum + (value - rgb[channel]) ** 2, 0);
  const TOLERANCE = 1500;
  let searchFrom = 0;
  for (let i = 0; i < clicks.length; i++) {
    const hit = frames.findIndex((frame, index) => index >= searchFrom && distance(frame.rgb, palette[i]) <= TOLERANCE);
    assert.notEqual(hit, -1, `phase ${i + 1} not found in decoded MP4`);
    const onset = frames[hit].t;
    searchFrom = hit + 1;
    const offset = onset - clicks[i].t;
    assert.ok(offset >= -1e-6 && offset <= frameToSec(2, events.video.fps) + 1e-6,
      `click ${i + 1} colour onset offset ${offset}s is outside F4`);
  }
});

test('Test_Run_Marker_OnsetFrameEqualsExpectedFrame', LONG, async () => {
  const run = await primaryRun(); assert.ifError(run.error);
  const events = published(run.dir);
  assert.deepEqual(events.sync.markers.map((marker) => marker.offsetFrames), [0, 0]);
  assert.equal(events.sync.driftFrames, 0);
});

test('Test_Run_ClickDuringHeldDrag_NotSwallowed', LONG, async () => {
  const raw = storyboard('drag-click', [{ id: 'drag-click', holdSec: 0.01, tailSec: 0.01, actions: [
    { type: 'drag', from: { selector: '#drag-from' }, to: { selector: '#drag-to' }, button: 'right', durationMs: 200 },
    { type: 'click', target: { x: 960, y: 510 } },
  ] }]);
  const start = dispatched.length;
  const run = await runCase('drag-click', raw); assert.ifError(run.error);
  const downs = published(run.dir).buttons.filter((event) => event.type === 'down');
  assert.equal(downs.filter((event) => event.button === 'right').length, 1);
  assert.equal(downs.filter((event) => event.button === 'left').length, 1);
  // Not only the bookkeeping: the PAGE must have received the click after the drag. The fixture
  // reports every pointerdown with its client point: the drag's press on #drag-from, then the
  // click at the logged viewport point 960/510 (the page is scrolled for the drag targets, so
  // which element sits there is not the point — that the press arrived is).
  const received = dispatched.slice(start);
  assert.equal(received.length, 2, `page saw ${JSON.stringify(received)}`);
  assert.equal(received[0].id, 'drag-from');
  assert.deepEqual([received[1].x, received[1].y], [960, 510]);
});

test('Test_Run_DoubleClickOnSelector_DispatchesExactlyTwoPresses', LONG, async () => {
  // Codex review 2026-10-27: `locator.click({ clickCount: 2 })` after a first click sent THREE
  // presses to the browser while the trace logged two.
  const start = dispatched.length;
  const raw = storyboard('double-click', [{ id: 'double', holdSec: 0.01, tailSec: 0.01, actions: [
    { type: 'doubleClick', target: { selector: '#instant' } },
  ] }]);
  const run = await runCase('double-click', raw); assert.ifError(run.error);
  assert.equal(published(run.dir).buttons.filter((event) => event.type === 'down').length, 2);
  assert.equal(dispatched.slice(start).filter((event) => event.id === 'instant').length, 2);
});

test('Test_Run_AmbiguousSelector_StepErrorExit1', LONG, async () => {
  const run = await runCase('ambiguous', oneClick('ambiguous', 'button'));
  expectError(run, 1, 'step-error');
  assert.match(run.error.message, /must be unique/);
});

test('Test_Run_WaitForAbsentSelector_TimesOutOnTheFrameClock', LONG, async () => {
  // An absent selector must not stall the take: the wait advances frames and gives up after
  // its own `timeoutMs` (here 300 ms = 9 frames), in seconds of wall time, not minutes.
  const started = Date.now();
  const raw = storyboard('absent', [{ id: 'absent', holdSec: 0.01, tailSec: 0.01, actions: [
    { type: 'waitFor', selector: '#never-there', timeoutMs: 300 },
  ] }]);
  const run = await runCase('absent', raw);
  expectError(run, 1, 'step-error');
  assert.match(run.error.message, /timed out after 300 ms/);
  assert.ok(Date.now() - started < 60_000, `absent-selector wait took ${Date.now() - started} ms`);
});

test('Test_Run_MotionGate_RunsBeforePublication_AndIsReportedInEvents', LONG, async () => {
  const run = await primaryRun(); assert.ifError(run.error);
  const motion = published(run.dir).motion;
  assert.deepEqual(motion.region, { x: 760, y: 500, w: 400, h: 400 });
  assert.equal(motion.metric, 'mad8x8gray');
  assert.equal(motion.scale, '8bit-gray-0-255');
  assert.equal(motion.downscale, 'scale=8:8:flags=area');
  assert.equal(motion.stillThreshold, 0.5);
  assert.equal(motion.minMovedFraction, 0.1);
  assert.equal(motion.verdict, 'skipped-no-viewer');
  assert.equal(motion.reason, 'motion-check-off-no-canvas');
  for (const field of ['frames', 'movedFrames', 'movedFraction', 'longestStillFrames', 'controlMad']) assert.equal(field in motion, false);
});

test('Test_Run_MotionCheckOff_WithCanvas_Exit2', LONG, async () => {
  // The canvas variant has to be requested through the STORYBOARD's url: the runner composes
  // `new URL(script.url, base)`, which drops a query string carried on `--base`. The storyboard
  // owns path and query; `--base` owns only origin.
  const withCanvas = storyboard('canvas-off', [{
    id: 'click', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'click', target: { x: 960, y: 510 } }],
  }], { url: '/?canvas=1' });
  const run = await runCase('canvas-off', withCanvas);
  expectError(run, 2, 'motion-check-off-with-viewer');
  assert.equal(published(run.dir), null);
});

test('Test_Run_EpochZeroDiagnosis_WithoutViewer_Exit2', LONG, async () => {
  const run = await runCase('epoch-no-viewer', oneClick('epoch-no-viewer'), { epochZeroDiagnosis: true });
  expectError(run, 2, 'epoch-zero-diagnosis-needs-viewer');
  assert.equal(readdirSync(run.dir).some((name) => name.startsWith('.tutorial-run-')), false);
});

test('Test_Run_FrameCount_ProbedEqualsTrace_AndBudgetOnlyReported', LONG, async () => {
  const inside = await runCase('budget-in', oneClick('budget-in'));
  const outside = await runCase('budget-out', storyboard('budget-out', [{ id: 'wait', holdSec: 0.01, tailSec: 0, actions: [{ type: 'waitFor', selector: '#instant', timeoutMs: 3000 }] }]));
  assert.ifError(inside.error); assert.ifError(outside.error);
  for (const run of [inside, outside]) {
    const events = published(run.dir);
    assert.equal(events.frameCheck.probedFrames, events.video.frames);
    assert.ok(existsSync(join(run.dir, 'events.json')));
    // The reported interval must CONTAIN a normal run (corrected 2026-10-27 after the first pilot,
    // whose 579 frames fell below a budget.min of 721) — reported, never a gate.
    assert.equal(events.frameCheck.budget.withinBudget, true, JSON.stringify(events.frameCheck.budget));
  }
});

test('Test_Run_InjectedTraceGap_StopsBeforeGateA', { timeout: 360_000 }, async () => {
  const variants = {
    prefix(events) { events.segments[0].start = 12; },
    suffix(events) { events.segments.at(-1).end = events.video.frames - 7; },
    inner(events) { events.segments.splice(Math.floor(events.segments.length / 2), 1); },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    let probes = 0;
    const run = await runCase(`gap-${name}`, oneClick(`gap-${name}`), {}, {
      buildTrace(events) { mutate(events); return events; },
      probeFrames() { probes++; return 0; },
    });
    expectError(run, 1, 'trace-not-contiguous');
    assert.equal(probes, 0);
    assert.deepEqual(artifactNames(run.dir), []);
  }
  let probes = 0;
  const counter = await runCase('gap-counter', oneClick('gap-counter'), {}, {
    // This proves only that the frame-count comparison is reached. Stamp decoding is a separate video-read path.
    async probeFrames(mp4) { probes++; return probeFrames(FFPROBE, mp4); },
  });
  assert.ifError(counter.error);
  // recording.mp4 and (default stamp mode 'proof', plan-2043) stamp-proof.mp4.
  assert.equal(probes, 2);
});

test('Test_Run_Events_StepBoundsMatchSegments_NoSegmentIndex', { timeout: 300_000 }, async () => {
  const run = await primaryRun(); assert.ifError(run.error);
  const events = published(run.dir);
  for (const step of events.steps) {
    assert.equal('segmentIndex' in step, false);
    const own = events.segments.filter((segment) => segment.stepId === step.id);
    assert.equal(own[0].start, step.start);
    assert.equal(own.at(-1).end, step.end);
  }
  const bad = await runCase('step-bounds', storyboard('step-bounds', [
    { id: 'one', holdSec: 0.01, tailSec: 0, actions: [{ type: 'wait', ms: 10 }] },
    { id: 'two', holdSec: 0.01, tailSec: 0, actions: [{ type: 'wait', ms: 10 }] },
  ]), {}, { buildTrace(events) { events.steps[1].end += 3; return events; } });
  expectError(bad, 1, 'trace-not-contiguous');
});

test('Test_Run_NonEmptySay_DoesNotRefuse_HoldsHoldSec', LONG, async () => {
  const run = await runCase('say', oneClick('say', '#instant', { say: 'Voice belongs to plan-676.', holdSec: 0.2 }));
  assert.ifError(run.error);
  assert.equal(published(run.dir).steps[0].holdSec, 0.2);
});

test('Test_Run_OffscreenTarget_ScrolledAndClicked', LONG, async () => {
  const start = dispatched.length;
  const run = await runCase('offscreen', oneClick('offscreen', '#offscreen'));
  assert.ifError(run.error);
  assert.ok(dispatched.slice(start).some((event) => event.id === 'offscreen'));
});

test('Test_Run_CoveredTarget_StepErrorExit1', LONG, async () => {
  const run = await runCase('covered', oneClick('covered', '#covered'));
  expectError(run, 1, 'step-error');
  assert.match(run.error.message, /covered/);
});

test('Test_Run_MovingTarget_Reapproached_ClickHits', LONG, async () => {
  const start = dispatched.length;
  const run = await runCase('moving', oneClick('moving', '#moving'));
  assert.ifError(run.error);
  const events = published(run.dir);
  const segment = events.segments.find((item) => item.target);
  assert.ok(Math.abs(segment.approach.x - segment.target.x) > 2, 'fixture did not exercise re-approach');
  assert.ok(dispatched.slice(start).some((event) => event.id === 'moving'));
});

test('Test_Run_ExistingOutput_WithoutOverwrite_Exit2', LONG, async () => {
  const paths = casePaths('existing'); mkdirSync(paths.dir, { recursive: true });
  writeFileSync(join(paths.dir, 'recording.mp4'), 'old');
  const run = await runCase('existing-run', oneClick('existing-run'), { outputDir: paths.dir, base: 'http://127.0.0.1:1' });
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /before recording/);
});

test('Test_Run_FailedRun_LeavesExistingOutputIntact', LONG, async () => {
  const paths = casePaths('failed-intact'); mkdirSync(paths.dir, { recursive: true });
  const oldVideo = Buffer.from('old-video'); const oldEvents = Buffer.from('{"old":true}\n');
  writeFileSync(join(paths.dir, 'recording.mp4'), oldVideo); writeFileSync(join(paths.dir, 'events.json'), oldEvents);
  const run = await runCase('failed-intact-run', oneClick('failed-intact-run', '#covered'), { outputDir: paths.dir, overwrite: true });
  expectError(run, 1, 'step-error');
  assert.deepEqual(readFileSync(join(paths.dir, 'recording.mp4')), oldVideo);
  assert.deepEqual(readFileSync(join(paths.dir, 'events.json')), oldEvents);
  const temp = readdirSync(paths.dir).find((name) => name.startsWith('.tutorial-run-'));
  assert.ok(temp && existsSync(join(paths.dir, temp, 'recording-failed.mp4')));
});

test('Test_Run_Success_PublishesAtomically_EventsLast_TempRemoved', { timeout: 300_000 }, async () => {
  const kept = await runCase('keep-temp', oneClick('keep-temp'), { keepTemp: true }); assert.ifError(kept.error);
  assert.ok(kept.result.tempDir && existsSync(kept.result.tempDir));
  const removed = await runCase('remove-temp', oneClick('remove-temp')); assert.ifError(removed.error);
  assert.equal(readdirSync(removed.dir).some((name) => name.startsWith('.tutorial-run-')), false);
  for (const name of ['recording.mp4', 'stamp-proof.mp4', 'motion-control.jpg', 'events.json']) assert.ok(existsSync(join(removed.dir, name)));
});

test('Test_Run_Publish_AbortAfterEachGroup_EventsNeverFirst', { timeout: 600_000 }, async () => {
  const calls = [];
  const green = await runCase('publish-order', oneClick('publish-order'), {}, {
    rename(from, to) { calls.push(basename(from)); renameSync(from, to); },
  });
  assert.ifError(green.error);
  assert.equal(calls[0], 'recording.mp4');
  assert.equal(calls[1], 'stamp-proof.mp4');
  assert.equal(calls[2], 'motion-control.jpg');
  assert.ok(calls.slice(3, -1).every((name) => /^stills-.*\.jpg$/.test(name)));
  assert.equal(calls.at(-1), 'events.json');

  for (const failGroup of ['motion-control.jpg', 'first-still', 'events.json']) {
    let failed = false;
    // The label becomes the storyboard id, and an id must be filename-safe (`[a-z0-9-]+`): a dot
    // from a file name like `motion-control.jpg` makes the schema refuse the storyboard, which
    // ends the run as Exit 2 before publication is ever reached.
    const label = `publish-${failGroup.replace(/[^a-z0-9-]+/g, '-')}`;
    const run = await runCase(label, oneClick(label), {}, {
      rename(from, to) {
        const name = basename(from);
        const hit = name === failGroup || (failGroup === 'first-still' && /^stills-/.test(name));
        if (hit && !failed) { failed = true; throw new Error(`prepared ${failGroup} failure`); }
        renameSync(from, to);
      },
    });
    expectError(run, 1, 'publish-incomplete');
    assert.match(run.error.message, /temp folder|\.tutorial-run-/);
    assert.equal(existsSync(join(run.dir, 'events.json')), false);
  }

  const old = casePaths('publish-old'); mkdirSync(old.dir, { recursive: true });
  const oldFiles = { 'recording.mp4': 'old-v', 'motion-control.jpg': 'old-c', 'stills-f000000-start.jpg': 'old-s', 'events.json': 'old-e' };
  for (const [name, bytes] of Object.entries(oldFiles)) writeFileSync(join(old.dir, name), bytes);
  let failNewControl = false;
  // The runner canonicalises --dir (realpath.native), so on a SUBST drive (E: -> C:\Daten) `to`
  // names the real path; compare against the same canonical form or the seam never fires.
  const oldDirCanon = realpathSync.native(old.dir);
  const replaced = await runCase('publish-old-run', oneClick('publish-old-run'), { outputDir: old.dir, overwrite: true }, {
    rename(from, to) {
      // The failure has to hit the PUBLICATION, which is recognised by its DESTINATION: the
      // move-aside step renames out of the project folder INTO `<temp>/replaced/`, and its source
      // path carries no marker to tell the two phases apart. Keyed on `from`, this seam aborted
      // the move-aside itself, so the old set never reached `replaced/` at all.
      if (basename(from) === 'motion-control.jpg' && dirname(to) === oldDirCanon && !failNewControl) {
        failNewControl = true; throw new Error('prepared replacement failure');
      }
      renameSync(from, to);
    },
  });
  expectError(replaced, 1, 'publish-incomplete');
  assert.equal(existsSync(join(old.dir, 'events.json')), false);
  const temp = readdirSync(old.dir).find((name) => name.startsWith('.tutorial-run-'));
  assert.ok(temp);
  for (const [name, bytes] of Object.entries(oldFiles)) assert.equal(readFileSync(join(old.dir, temp, 'replaced', name), 'utf8'), bytes);
});

test('Test_Run_MissingDist_Exit2_NamesBuildCommand', LONG, async () => {
  const run = await runCase('missing-dist', oneClick('missing-dist'), { base: undefined, dist: join(TEST_ROOT, 'missing-dist') });
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /npm run build/);
});

test('Test_Run_ConnectLiveWithoutBase_Exit2', LONG, async () => {
  const run = await runCase(
    'connect-live-needs-base',
    { ...oneClick('connect-live-needs-base'), connect: 'live' },
    { base: undefined, dist: FIXTURE_DIR },
  );
  expectError(run, 2, 'connect-live-needs-base');
  assert.match(run.error.message, /CONNECT must serve the page.*origin.*\/webviewer/i);
  assert.equal(existsSync(run.dir), false);
});

test('Test_Run_DirInsideRepo_ExistingSubdir_Accepted', LONG, async () => {
  const dir = join(TEST_ROOT, 'existing-subdir'); mkdirSync(dir, { recursive: true });
  const run = await runCase('inside-existing', oneClick('inside-existing'), { outputDir: dir });
  assert.ifError(run.error); assert.ok(existsSync(join(dir, 'events.json')));
});

test('Test_Run_DirInsideRepo_NotYetExisting_Accepted', LONG, async () => {
  const dir = join(TEST_ROOT, 'not-yet-existing'); rmSync(dir, { recursive: true, force: true });
  const run = await runCase('inside-new', oneClick('inside-new'), { outputDir: dir });
  assert.ifError(run.error); assert.ok(existsSync(dir));
});

test('Test_Run_DirSiblingWithSamePrefix_Exit2', LONG, async () => {
  const sibling = `${ROOT}-outside`; mkdirSync(sibling, { recursive: true });
  try {
    const run = await runCase('sibling', oneClick('sibling'), { outputDir: join(sibling, 'tutorial'), base: 'http://127.0.0.1:1' });
    expectError(run, 2, 'dir-outside-repo');
  } finally { rmSync(sibling, { recursive: true, force: true }); }
});

test('Test_Run_DirDotDotEscape_Exit2', LONG, async () => {
  const run = await runCase('dotdot', oneClick('dotdot'), { outputDir: resolve(ROOT, '..', 'tutorial-dotdot'), base: 'http://127.0.0.1:1' });
  expectError(run, 2, 'dir-outside-repo');
});

test('Test_Run_DirSymlinkEscape_Exit2', LONG, async (t) => {
  const link = join(TEST_ROOT, 'link-out');
  try { symlinkSync(process.env.TEMP ?? 'C:/Windows/Temp', link, 'junction'); }
  catch (error) { t.skip(`symlink creation unavailable: ${error.code ?? error.message}`); return; }
  const run = await runCase('symlink', oneClick('symlink'), { outputDir: join(link, 'tutorial'), base: 'http://127.0.0.1:1' });
  expectError(run, 2, 'dir-outside-repo');
});

test('Test_Run_PortOccupied_TakesNextFree_AndClosesServerOnEveryExit', { timeout: 300_000 }, async () => {
  const blocker = createServer((_request, response) => { response.writeHead(200); response.end('occupied'); });
  try {
    try { await listen(blocker, 5199); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
    const raw = oneClick('owned-server');
    const paths = casePaths('owned-server'); writeFileSync(paths.script, `${JSON.stringify(raw)}\n`);
    const result = await runTutorial({ script: paths.script, dir: paths.dir, dist: FIXTURE_DIR, port: 5199, ffmpeg: FFMPEG, ffprobe: FFPROBE, gpuCheck: 'off', motionCheck: 'off', signal: currentSignal });
    assert.ok(result.summary.port >= 5200 && result.summary.port <= 5209);
    const probe = createServer(); await listen(probe, result.summary.port); await close(probe);
  } finally {
    await close(blocker);
  }
});

test('Test_Run_NoFfmpeg_Exit2_ClearMessage', LONG, async () => {
  const run = await runCase('no-ffmpeg', oneClick('no-ffmpeg'), { ffmpeg: join(TEST_ROOT, 'missing-ffmpeg.exe'), ffprobe: join(TEST_ROOT, 'missing-ffprobe.exe') });
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /no ffmpeg could be resolved|ffmpeg/i);
});

test('Test_WithBudget_HangingPromise_ResolvesTimeoutAndNeverRejects', async () => {
  assert.equal(await withBudget(new Promise(() => {}), 50), 'timeout');
  assert.equal(await withBudget(Promise.reject(new Error('boom')), 50), 'done');
  assert.equal(await withBudget(Promise.resolve(1), 50), 'done');
});

test('Test_Run_AbortSignal_TearsDownBrowserFfmpegServerWithinBudget', { timeout: 120_000 }, async () => {
  // The 37-minute hang of 2026-10-27, as an oracle: a run that is aborted mid-take must end on its
  // own — Exit 1 `aborted`, its server port free again, its temp folder kept with the log — long
  // before the take would have finished (120 s of `wait` = 3600 frames).
  const PORT = 5207;
  const free = createServer(); await listen(free, PORT); await close(free);
  const raw = storyboard('aborted', [{ id: 'long', holdSec: 0.01, tailSec: 0, actions: [{ type: 'wait', ms: 120_000 }] }]);
  const paths = casePaths('aborted'); writeFileSync(paths.script, `${JSON.stringify(raw)}\n`);
  const controller = new AbortController();
  // Abort only once the take is demonstrably running: ffmpeg has written its first bytes into the
  // temp folder. A fixed timer could fire during browser start-up and never touch the encoder.
  let liveTake = null;
  const watcher = setInterval(() => {
    if (!existsSync(paths.dir)) return;
    const temp = readdirSync(paths.dir).find((name) => name.startsWith('.tutorial-run-'));
    const mp4 = temp && join(paths.dir, temp, 'recording.mp4');
    if (mp4 && existsSync(mp4) && statSync(mp4).size > 0) {
      liveTake = mp4;
      clearInterval(watcher);
      controller.abort(new Error('test abort'));
    }
  }, 100);
  const started = Date.now();
  let error = null;
  try {
    await runTutorial({ script: paths.script, dir: paths.dir, dist: FIXTURE_DIR, port: PORT, ffmpeg: FFMPEG, ffprobe: FFPROBE, gpuCheck: 'off', motionCheck: 'off', signal: controller.signal });
  } catch (caught) { error = caught; } finally { clearInterval(watcher); }
  const elapsed = Date.now() - started;
  assert.ok(liveTake, 'the take never started writing — the abort did not hit a running encoder');
  assert.ok(error instanceof TutorialRunError, error?.stack ?? 'aborted run unexpectedly succeeded');
  assert.equal(error.exitCode, 1);
  assert.equal(error.diagnosis, 'aborted');
  assert.ok(elapsed < 60_000, `aborted run took ${elapsed} ms to end`);
  const probe = createServer(); await listen(probe, PORT); await close(probe);
  assert.equal(existsSync(join(paths.dir, 'events.json')), false);
  const temp = readdirSync(paths.dir).find((name) => name.startsWith('.tutorial-run-'));
  assert.ok(temp, 'aborted run did not keep its temp folder');
  // ffmpeg is gone: on Windows a running encoder holds its output open, so the rename to the
  // diagnostic name only succeeds after the process has ended.
  assert.equal(existsSync(join(paths.dir, temp, 'recording.mp4')), false);
  assert.ok(existsSync(join(paths.dir, temp, 'recording-failed.mp4')));
  assert.equal(JSON.parse(readFileSync(join(paths.dir, temp, 'run.log'), 'utf8')).diagnosis, 'aborted');
});

test('Test_Run_AlreadyAbortedSignal_RefusesBeforeAnyWork', LONG, async () => {
  const controller = new AbortController();
  controller.abort(new Error('pre-aborted'));
  const run = await runCase('pre-aborted', oneClick('pre-aborted'), { signal: controller.signal });
  expectError(run, 1, 'aborted');
  assert.deepEqual(artifactNames(run.dir), []);
});

function commandStoryboard(id, actions, extra = {}) {
  return storyboard(id, [{ id: 'exercise', holdSec: 0.01, tailSec: 0.01, actions }], {
    url: '/?cmdfixture=1', ...extra,
  });
}

function pausedStoryboard(id, setup = []) {
  return commandStoryboard(id, [
    { type: 'command', id: 'sim.playPause', via: 'direct' },
    { type: 'wait', ms: 500 },
  ], { start: 'paused', url: '/?cmdfixture=1&paused=1&mode=hybrid&factor=5', setup });
}

function recordedSimSeries(run) {
  // Setup uses native rAF (frame -1). Sort HTTP arrivals by the actual output frame.
  const series = simLog.filter((sample) => sample.frame >= 0).sort((a, b) => a.frame - b.frame);
  assert.deepEqual(series.map((sample) => sample.frame),
    Array.from({ length: published(run.dir).video.frames }, (_, frame) => frame));
  return series.map(({ frame, t }) => [frame, t]);
}

test('Test_Run_CommandClick_ResetExactlyOnceAtButtonCenter', LONG, async () => {
  // Plan 9.6 bullet 1: command click owns a segment and ends on its button.
  const run = await runCase('command-reset', commandStoryboard('command-reset', [{ type: 'command', id: 'sim.reset' }]));
  assert.ifError(run.error);
  const events = published(run.dir);
  const segment = events.segments.find((item) => item.kind === 'command' && item.id === 'sim.reset');
  const click = events.buttons.filter((item) => item.type === 'down').at(-1);
  const actual = geometryLog.find((item) => item.id === 'reset-command');
  assert.ok(segment?.target && click && actual);
  assert.ok(Math.abs(segment.target.x + segment.target.w / 2 - click.x) <= 1);
  assert.ok(Math.abs(segment.target.y + segment.target.h / 2 - click.y) <= 1);
  assert.ok(Math.abs(actual.x - click.x) <= 1 && Math.abs(actual.y - click.y) <= 1);
  assert.ok(click.x >= actual.rect.x && click.x <= actual.rect.x + actual.rect.w);
  assert.ok(click.y >= actual.rect.y && click.y <= actual.rect.y + actual.rect.h);
  assert.equal(executedLog.filter((item) => item.id === 'sim.reset').length, 1);
});

for (const [variant, diagnosis, action] of [
  ['ambiguous', 'command-button-ambiguous', { type: 'command', id: 'sim.reset' }],
  ['hidden', 'command-button-missing', { type: 'command', id: 'sim.reset' }],
  ['mismatch', 'command-args-mismatch', { type: 'command', id: 'selection.select', args: { path: 'B' } }],
]) {
  test(`Test_Run_CommandClick_${variant}_Exit1`, LONG, async () => {
    // Plan 9.6 bullet 2: uniqueness, visibility and executed arguments are enforced.
    const id = `command-${variant}`;
    const run = await runCase(id, commandStoryboard(id, [action], { url: `/?cmdfixture=1&variant=${variant}` }));
    expectError(run, 1, diagnosis);
  });
}

test('Test_Run_PausedStart_RejectsRunningSetup', LONG, async () => {
  // Plan 9.6 bullet 3: paused start requires setup to finish paused.
  const run = await runCase('setup-running', commandStoryboard('setup-running', [{ type: 'wait', ms: 10 }], {
    start: 'paused', url: '/?cmdfixture=1&paused=0',
  }));
  expectError(run, 1, 'setup-not-paused');
});

test('Test_Run_PausedStart_FiveTimesProgressPerFrame', LONG, async () => {
  // Plan 9.6 bullet 3: resume at a frame boundary and validate the DES multiplier.
  const run = await runCase('paused-five', pausedStoryboard('paused-five'));
  assert.ifError(run.error);
  assert.equal(run.result.summary.simProgress.verdict, 'ok');
  assert.equal(run.result.summary.simProgress.factor, 5);
  const series = recordedSimSeries(run);
  const resumed = series.findIndex(([, t]) => t > 0);
  assert.ok(resumed > 0, 'capture must contain both paused and running frames');
  for (let i = 0; i < resumed; i++) assert.equal(series[i][1], 0);
  for (let i = resumed; i < series.length; i++) {
    assert.ok(Math.abs(series[i][1] - series[i - 1][1] - 5 / 30) <= 1e-6, `wrong delta at frame ${series[i][0]}`);
  }
});

test('Test_Run_PausedStart_NeverResumed_Exit1', LONG, async () => {
  // Plan 9.6 bullet 3: a take that stays paused cannot pass the progress gate.
  const run = await runCase('never-resumed', commandStoryboard('never-resumed', [{ type: 'wait', ms: 100 }], {
    start: 'paused', url: '/?cmdfixture=1&paused=1',
  }));
  expectError(run, 1, 'paused-never-started');
});

for (const [initialMode, startMode, factor] of [['hybrid', 'animated', 1], ['animated', 'hybrid', 5]]) {
  test(`Test_Run_PausedStart_${initialMode}To${startMode}_ReadsFactorAtStart`, LONG, async () => {
    const id = `mode-${initialMode}-${startMode}`;
    const run = await runCase(id, commandStoryboard(id, [
      { type: 'command', id: 'fixture.setMode', args: { mode: startMode }, via: 'direct' },
      { type: 'command', id: 'sim.playPause', via: 'direct' },
      { type: 'wait', ms: 500 },
    ], { start: 'paused', url: `/?cmdfixture=1&paused=1&mode=${initialMode}&factor=5` }));
    assert.ifError(run.error);
    assert.equal(run.result.summary.simProgress.verdict, 'ok');
    assert.equal(run.result.summary.simProgress.factor, factor);
    const series = recordedSimSeries(run);
    const resumed = series.findIndex(([, t]) => t > 0);
    assert.ok(resumed > 0);
    for (let i = resumed; i < series.length; i++) {
      assert.ok(Math.abs(series[i][1] - series[i - 1][1] - factor / 30) <= 1e-6);
    }
  });
}

test('Test_Run_PausedStart_SetupDelayDoesNotChangeSimSeries', LONG, async () => {
  // Plan 9.6 bullet 3: wall-time setup delay must not affect recorded simulation time.
  const first = await runCase('determinism-first', pausedStoryboard('determinism'));
  assert.ifError(first.error);
  const expected = recordedSimSeries(first);
  simLog.length = 0; executedLog.length = 0; geometryLog.length = 0;
  const second = await runCase('determinism-delayed', pausedStoryboard('determinism', [{ type: 'wait', ms: 700 }]));
  assert.ifError(second.error);
  assert.equal(first.result.summary.simProgress.verdict, 'ok');
  assert.equal(second.result.summary.simProgress.verdict, 'ok');
  assert.deepEqual(recordedSimSeries(second), expected);
});

test('Test_Run_LegacyStoryboard_DefaultStartCompatibility', LONG, async () => {
  // Plan 9.6 bullet 4: legacy fixture runs; demo-basics parses with running as its default.
  const raw = oneClick('legacy-start');
  assert.equal('start' in raw, false);
  const run = await runCase('legacy-start', raw);
  assert.ifError(run.error);
  assert.equal(run.result.summary.simProgress, undefined);
  const demo = JSON.parse(readFileSync(join(ROOT, 'scripts', 'tutorial', 'storyboards', 'demo-basics.json'), 'utf8'));
  assert.equal(parseTutorial(demo).start, 'running');
});

for (const [variant, expected] of [['none', null], ['tie', 'Yard/AGV_1'], ['fast', 'Yard/AGV_2']]) {
  test(`Test_Run_PickMovingVehicle_${variant}`, LONG, async () => {
    // Plan 9.6 bullet 5: glob-filtered fastest pick, lexical tie-break and empty diagnosis.
    const id = `pick-${variant}`;
    const run = await runCase(id, commandStoryboard(id, [
      { type: 'pick', rule: 'moving-vehicle', among: 'Yard/AGV_*', as: 'agv' },
      { type: 'command', id: 'selection.select', via: 'direct', args: { path: '$agv' } },
    ], { url: `/?cmdfixture=1&pick=${variant}` }));
    if (expected === null) {
      expectError(run, 1, 'pick-no-match');
      assert.equal(executedLog.some((item) => item.id === 'selection.select'), false);
    } else {
      assert.ifError(run.error);
      assert.deepEqual(executedLog.filter((item) => item.id === 'selection.select').map((item) => item.args), [{ path: expected }]);
    }
  });
}

test('Test_Run_RecordingTarget_UsesMovedBarCenter', LONG, async () => {
  // Plan 9.6 bullet 6: panel movement changes the resolved screen position.
  const run = await runCase('bar-moved', commandStoryboard('bar-moved', [
    { type: 'click', target: { recordingTarget: 'des-stats-bar', key: 'agv' } },
  ], { setup: [{ type: 'command', id: 'fixture.moveBar', via: 'direct' }] }));
  assert.ifError(run.error);
  const actual = geometryLog.find((item) => item.id === 'bar-agv');
  const click = published(run.dir).buttons.find((item) => item.type === 'down');
  assert.ok(actual?.bar && click);
  assert.equal(actual.bar.x, 1920 - 20 - 400 + 160 + 60);
  assert.ok(Math.abs(click.x - actual.bar.x) <= 1 && Math.abs(click.y - actual.bar.y) <= 1);
  assert.ok(Math.abs(actual.x - actual.bar.x) <= 1 && Math.abs(actual.y - actual.bar.y) <= 1);
});

test('Test_Run_RecordingTarget_RemovedBar_Exit1', LONG, async () => {
  // Plan 9.6 bullet 6: an unmounted chart target must fail explicitly.
  const run = await runCase('bar-removed', commandStoryboard('bar-removed', [
    { type: 'click', target: { recordingTarget: 'des-stats-bar', key: 'agv' } },
  ], { setup: [{ type: 'command', id: 'fixture.removeBar', via: 'direct' }] }));
  expectError(run, 1, 'recording-target-missing');
});

test('Test_Run_NodeTarget_MotionEndsAtLastCenter', LONG, async () => {
  // Plan 9.6 bullet 7: the dynamic node projection is refreshed during cursor motion.
  const run = await runCase('node-moving', commandStoryboard('node-moving', [
    { type: 'click', target: { node: 'Yard/AGV_1' } },
  ]));
  assert.ifError(run.error);
  const actual = geometryLog.find((item) => item.id === 'node-dot');
  const events = published(run.dir);
  const click = events.buttons.find((item) => item.type === 'down');
  const segment = events.segments.find((item) => item.target);
  assert.ok(actual?.dot && click && segment?.approach);
  assert.equal(actual.dotTicks, 15, 'the fixture must finish its 15 motion ticks');
  assert.ok(actual.dot.x - segment.approach.x >= 140, 'the target must move during the approach');
  assert.ok(Math.abs(click.x - actual.dot.x) <= 2 && Math.abs(click.y - actual.dot.y) <= 2);
  assert.ok(Math.abs(actual.x - actual.dot.x) <= 2 && Math.abs(actual.y - actual.dot.y) <= 2);
});

for (const [kind, target, element, centerKey] of [
  ['node', { node: 'Yard/AGV_1' }, 'node-dot', 'dot'],
  ['recording', { recordingTarget: 'des-stats-bar', key: 'agv' }, 'bar-agv', 'bar'],
]) {
  test(`Test_Run_${kind}_ContinuousThreePixelsPerFrame_ClickMatchesTrace`, LONG, async () => {
    const id = `continuous-${kind}`;
    const run = await runCase(id, commandStoryboard(id, [{ type: 'click', target }], {
      url: '/?cmdfixture=1&motion=continuous',
    }));
    assert.ifError(run.error);
    const actual = geometryLog.find((item) => item.id === element);
    const events = published(run.dir);
    const click = events.buttons.find((item) => item.type === 'down');
    const pointer = events.pointer.find((item) => item.t === click?.t);
    const segment = events.segments.find((item) => item.target);
    assert.ok(actual && click && pointer && segment);
    assert.ok(actual.dotTicks > 15, 'motion must continue beyond the old fixture cutoff');
    assert.equal(actual[centerKey].x, 1500 + 3 * actual.dotTicks + (kind === 'node' ? 10 : 60));
    for (const point of [click, pointer, actual, segment.target]) {
      assert.ok(Math.abs(point.x - actual[centerKey].x) <= 1);
      assert.ok(Math.abs(point.y - actual[centerKey].y) <= 1);
    }
  });
}

// Plan 9.7 (plan-2031 P3): --burn-cursor writes a second MP4 with a visible cursor.
function regionPixels(mp4, frame, point, size = 48) {
  const jpg = `${mp4}.f${frame}.jpg`;
  return extractFrame({ ffmpeg: FFMPEG, mp4, frame, out: jpg }).then(() => {
    const x = Math.max(0, Math.round(point.x) - size / 2);
    const y = Math.max(0, Math.round(point.y) - size / 2);
    return execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', jpg,
      '-vf', `crop=${size}:${size}:${x}:${y}`, '-c:v', 'rawvideo', '-pix_fmt', 'bgr24', '-frames:v', '1', '-f', 'avi', 'pipe:1'],
    { maxBuffer: 1 << 24 });
  });
}

function meanAbsDiff(a, b) {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

test('Test_Run_BurnCursor_SecondMp4_SameFrames_CursorOnlyInSecond', LONG, async () => {
  const board = (id) => commandStoryboard(id, [{ type: 'command', id: 'sim.reset' }]);
  const plain = await runCase('burn-off', board('burn-off'));
  assert.ifError(plain.error);
  const burned = await runCase('burn-on', board('burn-on'), { burnCursor: true });
  assert.ifError(burned.error);

  assert.ok(!existsSync(join(plain.dir, 'recording-cursor.mp4')), 'no flag, no second file');
  const cleanMp4 = join(burned.dir, 'recording.mp4');
  const cursorMp4 = join(burned.dir, 'recording-cursor.mp4');
  assert.ok(existsSync(cursorMp4));
  const a = (await probeFrames(FFPROBE, cleanMp4)).frames;
  const b = (await probeFrames(FFPROBE, cursorMp4)).frames;
  assert.equal(a, b);

  const events = published(burned.dir);
  assert.equal(events.frameCheck.verdict, 'ok');
  assert.equal(events.sync.markers.length, 2, 'Gate B ran on the clean file');
  const click = events.buttons.find((item) => item.type === 'down');
  const clickFrame = Math.round(click.t * events.video.fps);
  const point = events.pointer.find((item) => item.frame === clickFrame) ?? { x: click.x, y: click.y };

  const cleanSpot = await regionPixels(cleanMp4, clickFrame, point);
  const cursorSpot = await regionPixels(cursorMp4, clickFrame, point);
  const plainSpot = await regionPixels(join(plain.dir, 'recording.mp4'), clickFrame, point);
  assert.ok(meanAbsDiff(cleanSpot, cursorSpot) > 3, 'the cursor file shows the cursor at pointer[frame]');
  assert.ok(meanAbsDiff(cleanSpot, plainSpot) < 2, 'recording.mp4 is unchanged by the flag');
});

// ── plan-2240: Gate C per step, storyboard storage, target offsets ────────────────────────────

/** A pulse step: switch the block on, let it flip for a second, switch it off. */
function pulseStep(id, extra = {}) {
  return {
    id, holdSec: 0.01, tailSec: 0.01, ...extra,
    actions: [
      { type: 'click', target: { selector: '#pulse-on' } },
      { type: 'wait', ms: 1000 },
      { type: 'click', target: { selector: '#pulse-off' } },
    ],
  };
}

function stillStep(extra = {}) {
  return { id: 'still', holdSec: 0.01, tailSec: 0.01, actions: [{ type: 'wait', ms: 1000 }], ...extra };
}

function gateStoryboard(id, still) {
  return storyboard(id, [pulseStep('move-a'), still, pulseStep('move-b')], { url: '/?pulse=1' });
}

/** Gate C measured for real: the canvas-less fixture, but without `--motion-check off`. */
const MEASURED = { gpuCheck: 'off', motionCheck: undefined };

test('Test_Run_GateC_StandingStepWithoutMotion_NoCli_Fails', LONG, async () => {
  const run = await runCase('gate-still-default', gateStoryboard('gate-still-default', stillStep()), MEASURED);
  expectError(run, 1, 'motion-below-threshold');
  assert.match(run.error.message, /step 'still' \(require\)/);
  assert.doesNotMatch(run.error.message, /move-a|move-b/);
  assert.equal(published(run.dir), null);
});

test('Test_Run_GateC_StandingStepWarn_PublishesWithWarning', LONG, async () => {
  const run = await runCase('gate-still-warn', gateStoryboard('gate-still-warn', stillStep({ motion: 'warn' })), MEASURED);
  assert.ifError(run.error);
  const motion = published(run.dir).motion;
  const still = motion.perStep.find((entry) => entry.stepId === 'still');
  assert.equal(still.verdict, 'warn');
  assert.equal(still.policy, 'warn');
  assert.equal(still.source, 'step');
  assert.equal(still.reason, 'motion-below-threshold');
  for (const id of ['move-a', 'move-b']) assert.equal(motion.perStep.find((entry) => entry.stepId === id).verdict, 'ok', id);
  // Additive only: the whole-take fields are still there.
  for (const field of ['frames', 'movedFrames', 'movedFraction', 'longestStillFrames', 'controlMad', 'verdict']) assert.ok(field in motion, field);
});

test('Test_Run_GateC_MixedOffStep_Succeeds', LONG, async () => {
  const run = await runCase('gate-still-off', gateStoryboard('gate-still-off', stillStep({ motion: 'off' })), MEASURED);
  assert.ifError(run.error);
  const still = published(run.dir).motion.perStep.find((entry) => entry.stepId === 'still');
  assert.equal(still.verdict, 'skipped');
  assert.equal('movedFraction' in still, false);
});

test('Test_Run_GateC_OnlyOffSteps_Rejected', LONG, async () => {
  const raw = storyboard('gate-only-off', [stillStep({ motion: 'off' })], { url: '/?pulse=1' });
  const run = await runCase('gate-only-off', raw, MEASURED);
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /every step has motion 'off'/);
});

test('Test_Run_GateC_ExplicitRequire_UnderCliWarn_Fails', LONG, async () => {
  const run = await runCase('gate-require-cliwarn', gateStoryboard('gate-require-cliwarn', stillStep({ motion: 'require' })),
    { ...MEASURED, motionCheck: 'warn' });
  expectError(run, 1, 'motion-below-threshold');
  assert.match(run.error.message, /step 'still' \(require\)/);
});

test('Test_Run_GateC_StepWithoutMotion_UnderCliWarn_WarnsAndPublishes', LONG, async () => {
  const run = await runCase('gate-default-cliwarn', gateStoryboard('gate-default-cliwarn', stillStep()),
    { ...MEASURED, motionCheck: 'warn' });
  assert.ifError(run.error);
  const still = published(run.dir).motion.perStep.find((entry) => entry.stepId === 'still');
  assert.equal(still.verdict, 'warn');
  assert.equal(still.source, 'cli');
});

test('Test_Run_GateC_OneFrameRequireStep_TooShort', LONG, async () => {
  const raw = storyboard('gate-one-frame', [
    pulseStep('move-a'),
    { id: 'one', holdSec: 0.01, tailSec: 0, actions: [{ type: 'press', key: 'Shift' }] },
  ], { url: '/?pulse=1' });
  const run = await runCase('gate-one-frame', raw, MEASURED);
  expectError(run, 1, 'motion-below-threshold');
  assert.match(run.error.message, /step 'one' \(require\): too short/);
});

test('Test_Run_Storage_SeededAfterCleanup_PanelKeyKept', LONG, async () => {
  const raw = storyboard('storage-seed', [stillStep()], {
    url: '/?storage=1',
    storage: { 'rv-tutorial-e2e': 'seed', 'rv-panel-geo:e2e': '{"x":1}' },
  });
  const run = await runCase('storage-seed', raw);
  assert.ifError(run.error);
  assert.ok(storageLog.length >= 1, 'the fixture did not report its storage');
  const seen = storageLog[0];
  assert.equal(seen['rv-tutorial-e2e'], 'seed');
  assert.equal(seen['rv-panel-geo:e2e'], '{"x":1}');
  assert.equal(seen['rv-terms-accepted'], '1');
});

test('Test_Run_Storage_RecorderSeedWithoutOverride_Rejected', LONG, async () => {
  const raw = storyboard('storage-protected', [stillStep()], { storage: { 'rv-terms-accepted': '0' } });
  const run = await runCase('storage-protected', raw);
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /storageOverride/);
});

function near(actual, expected, what) {
  assert.ok(actual, `${what}: no event logged`);
  assert.ok(Math.abs(actual.x - expected.x) <= 1 && Math.abs(actual.y - expected.y) <= 1,
    `${what}: (${actual.x}, ${actual.y}) != expected (${expected.x}, ${expected.y})`);
}

function centrePlus(rect, offset) {
  return { x: rect.x + rect.w / 2 + offset.dx, y: rect.y + rect.h / 2 + offset.dy };
}

test('Test_Run_OffsetClick_SetupAndTake_LandAtCentrePlusOffset', LONG, async () => {
  const setupOffset = { dx: 120, dy: 40 };
  const takeOffset = { dx: -120, dy: -40 };
  const raw = storyboard('offset-click', [{
    id: 'click', holdSec: 0.01, tailSec: 0.01,
    actions: [{ type: 'click', target: { selector: '#instant', offset: takeOffset } }],
  }], { url: '/?offset=1', setup: [{ type: 'click', target: { selector: '#instant', offset: setupOffset } }] });
  const run = await runCase('offset-click', raw);
  assert.ifError(run.error);
  const downs = geometryLog.filter((entry) => entry.type === 'pointerdown');
  assert.equal(downs.length, 2, JSON.stringify(downs));
  near(downs[0], centrePlus(downs[0].rects.instant, setupOffset), 'setup click');
  near(downs[1], centrePlus(downs[1].rects.instant, takeOffset), 'take click');
  assert.equal(downs[1].id, 'instant');
});

test('Test_Run_OffsetDrag_SetupAndTake_LandAtCentrePlusOffset', LONG, async () => {
  const from = { dx: 30, dy: 10 };
  const to = { dx: 80, dy: -10 };   // beside #drag-to, on the stage (an ancestor): not covered
  const raw = storyboard('offset-drag', [{
    id: 'drag', holdSec: 0.01, tailSec: 0.01,
    actions: [{ type: 'drag', from: { selector: '#drag-from', offset: from }, to: { selector: '#drag-to', offset: to }, durationMs: 200 }],
  }], {
    url: '/?offset=1',
    setup: [{ type: 'drag', from: { selector: '#drag-from', offset: from }, to: { selector: '#drag-to', offset: to } }],
  });
  const run = await runCase('offset-drag', raw);
  assert.ifError(run.error);
  const downs = geometryLog.filter((entry) => entry.type === 'pointerdown');
  const ups = geometryLog.filter((entry) => entry.type === 'pointerup');
  assert.equal(downs.length, 2, JSON.stringify(downs));
  assert.equal(ups.length, 2, JSON.stringify(ups));
  for (const [index, label] of [[0, 'setup'], [1, 'take']]) {
    near(downs[index], centrePlus(downs[index].rects.dragFrom, from), `${label} drag start`);
    near(ups[index], centrePlus(ups[index].rects.dragTo, to), `${label} drag end`);
  }
});

test('Test_Run_SetupDrag_AbsoluteCoordinates', LONG, async () => {
  const raw = storyboard('setup-drag-xy', [stillStep()], {
    url: '/?offset=1',
    setup: [{ type: 'drag', from: { x: 300, y: 300 }, to: { x: 420, y: 330 } }],
  });
  const run = await runCase('setup-drag-xy', raw);
  assert.ifError(run.error);
  near(geometryLog.find((entry) => entry.type === 'pointerdown'), { x: 300, y: 300 }, 'absolute drag start');
  near(geometryLog.find((entry) => entry.type === 'pointerup'), { x: 420, y: 330 }, 'absolute drag end');
});

test('Test_Run_CoveredOffsetPoint_StepErrorExit1', LONG, async () => {
  // #instant itself is free; its centre + offset lies on #cover.
  const raw = storyboard('offset-covered', [{
    id: 'click', holdSec: 0.01, tailSec: 0.01,
    actions: [{ type: 'click', target: { selector: '#instant', offset: { dx: -130, dy: 355 } } }],
  }], { url: '/?offset=1' });
  const run = await runCase('offset-covered', raw);
  expectError(run, 1, 'step-error');
  assert.match(run.error.message, /covered at its offset point/);
});

// ─── plan-2237: time control (segment gate, time commands in the take, time-lapse) ──────────────

function runLogOf(run) {
  const temp = /temp folder: (.+?)(?:;|$)/.exec(run.error?.message ?? '')?.[1]?.trim();
  return temp && existsSync(join(temp, 'run.log')) ? JSON.parse(readFileSync(join(temp, 'run.log'), 'utf8')) : null;
}

const batch = (ticks, timelapse = { fps: 4, maxWallSec: 20 }, extra = {}) => ({
  type: 'command', id: 'experiment.run', via: 'direct', args: { ticks }, timelapse, waitSec: 0.2, ...extra,
});

test('Test_Run_Gate_RunningStart_FactorChangeOverCommandPath_Green', LONG, async () => {
  // F3/F4: a running start is gated too; the speed override ends a segment, the next one judges 5x.
  const run = await runCase('gate-factor', commandStoryboard('gate-factor', [
    { type: 'wait', ms: 400 },
    { type: 'command', id: 'sim.speedOverride', via: 'direct', args: { factor: 5 } },
    { type: 'wait', ms: 600 },
  ]));
  assert.ifError(run.error);
  const progress = run.result.summary.simProgress;
  assert.equal(progress.verdict, 'ok');
  const judged = progress.segments.filter((segment) => segment.verdict === 'pass');
  assert.deepEqual([...new Set(judged.map((segment) => segment.factor))], [1, 5]);
  const events = published(run.dir);
  assert.equal(events.simProgress.verdict, 'ok');
  assert.deepEqual(events.simJumps, []);
});

test('Test_Run_Gate_DesFiftyFastForwardCheckpointLoad_OneTake_GreenWithJumps', LONG, async () => {
  // F5/F7: setMode 50x -> fast-forward (in the take) -> earlier checkpoint (async, 3 frames) -> step mode.
  const run = await runCase('gate-des-jumps', commandStoryboard('gate-des-jumps', [
    { type: 'wait', ms: 300 },
    { type: 'command', id: 'des.setMode', via: 'direct', args: { subMode: 'hybrid', multiplier: 50 } },
    { type: 'wait', ms: 300 },
    { type: 'command', id: 'des.fastForward', via: 'direct', args: { untilSimTime: 10800 } },
    { type: 'wait', ms: 300 },
    { type: 'command', id: 'des.checkpoint.load', via: 'direct', args: { t: 3600 } },
    { type: 'command', id: 'sim.playPause', via: 'direct', args: { paused: false } },
    { type: 'wait', ms: 300 },
  ], { url: '/?cmdfixture=1&mode=animated&factor=1' }));
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(events.simProgress.verdict, 'ok');
  assert.deepEqual(events.simJumps.map((jump) => jump.cmd), ['des.fastForward', 'des.checkpoint.load']);
  const back = events.simJumps.find((jump) => jump.cmd === 'des.checkpoint.load');
  assert.equal(back.toSim, 3600);
  assert.ok(back.fromSim > back.toSim, 'the checkpoint lies earlier: a backwards jump');
  const kinds = events.simProgress.segments.filter((s) => s.verdict === 'pass').map((s) => `${s.kind}:${s.factor}`);
  assert.ok(kinds.includes('run:50') && kinds.includes('hold:0'), kinds.join(','));
});

test('Test_Run_Timelapse_ThreeDisjointSegments_GateAGreenAcrossBothTransitions', LONG, async () => {
  // Phase 2: command (dispatch) | timelapse (wall clock) | command (rest) — Gate A (frame count,
  // proof stamps) holds over wallBegin and wallEnd, the published take is gapless.
  // Dispatched by a recorded CLICK, so the approach is the head segment; the click itself is the
  // first act inside wall mode (a direct dispatch has no approach and its head segment is dropped).
  const run = await runCase('timelapse', commandStoryboard('timelapse', [
    { type: 'command', id: 'experiment.run', timelapse: { fps: 4, maxWallSec: 20 }, waitSec: 0.2 },
    { type: 'wait', ms: 300 },
  ], { url: '/?cmdfixture=1&batchbutton=1&ticks=90' }));
  assert.ifError(run.error);
  const events = published(run.dir);
  const own = events.segments.filter((segment) => segment.stepId === 'exercise' && segment.actionIndex === 0);
  assert.deepEqual(own.map((segment) => segment.kind), ['command', 'timelapse', 'command']);
  assert.ok(own.every((segment, i) => i === 0 || segment.start === own[i - 1].end));
  const lapse = own[1];
  assert.equal(lapse.cmd, 'experiment.run');
  assert.equal(lapse.wallFps, 4);
  assert.equal(lapse.wallMs.length, lapse.end - lapse.start);
  assert.ok(lapse.wallMs.every((ms, i) => i === 0 || ms > lapse.wallMs[i - 1]), 'wall stamps are monotonic');
  assert.equal(events.frameCheck.verdict, 'ok');
  assert.equal(events.frameCheck.stampsContiguous, true);
  assert.equal(events.frameCheck.budget.withinBudget, true);
  assert.equal(events.simProgress.verdict, 'ok');
  assert.ok(events.simProgress.segments.some((segment) => segment.kind === 'timelapse' && segment.verdict === 'skipped'));
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run').length, 1);
  assert.ok(run.result.summary.timelapses[0].wallEnd && run.result.summary.timelapses[0].wallEnd.already !== true);
  assert.equal(events.buttons.filter((event) => event.type === 'down').length, 1);
});

test('Test_Run_Timelapse_Long_DroppedSlotsCountedNotFrames', { timeout: 300_000 }, async () => {
  // A longer batch (~5 s wall at the fixture's 60 Hz pump) at 8 fps: output frames never exceed
  // ceil(maxWallSec * fps), dropped slots are counted, not recorded.
  const run = await runCase('timelapse-long', commandStoryboard('timelapse-long', [batch(300, { fps: 8, maxWallSec: 30 })]));
  assert.ifError(run.error);
  const events = published(run.dir);
  const lapse = events.segments.find((segment) => segment.kind === 'timelapse');
  assert.ok(lapse.end - lapse.start <= Math.ceil(30 * 8));
  assert.ok(lapse.end - lapse.start >= 10, `only ${lapse.end - lapse.start} time-lapse frames`);
  assert.ok(Number.isInteger(lapse.droppedSlots) && lapse.droppedSlots >= 0);
  assert.equal(events.frameCheck.budget.withinBudget, true);
  assert.equal(events.frameCheck.verdict, 'ok');
});

test('Test_Run_Timelapse_ImmediateCompletion_EmptyTimelapseSegmentDropped', LONG, async () => {
  const run = await runCase('timelapse-immediate', commandStoryboard('timelapse-immediate', [
    { type: 'command', id: 'sim.reset', via: 'direct', timelapse: { fps: 4, maxWallSec: 5 } },
  ]));
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(events.segments.some((segment) => segment.kind === 'timelapse'), false);
  assert.equal(events.segments.filter((segment) => segment.kind === 'command').length, 1);
  // wallBegin -> dispatch -> already complete -> wallEnd: no wall frame was taken.
  assert.equal(run.result.summary.timelapses.length, 1);
  assert.equal(run.result.summary.timelapses[0].start, run.result.summary.timelapses[0].end);
});

test('Test_Run_Timelapse_Timeout_CancelsBatch_Exit1', LONG, async () => {
  const run = await runCase('timelapse-timeout', commandStoryboard('timelapse-timeout', [batch(1_000_000, { fps: 4, maxWallSec: 1 })]));
  expectError(run, 1, 'timelapse-timeout');
  assert.match(run.error.message, /experiment\.run\.cancel: ok/);
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run.cancel').length, 1);
  const log = runLogOf(run);
  assert.ok(log?.timelapses?.[0]?.wallEnd, 'wallEnd ran in finally');
});

test('Test_Run_Timelapse_MaxWaitSecBelowMaxWallSec_Exit2', LONG, async () => {
  const run = await runCase('timelapse-budget', commandStoryboard('timelapse-budget', [batch(30, { fps: 4, maxWallSec: 60 }, { maxWaitSec: 10 })]));
  expectError(run, 2, 'configuration-error');
  assert.match(run.error.message, /maxWaitSec 10 s is below timelapse\.maxWallSec 60 s/);
});

test('Test_Run_Timelapse_GrabTimeoutTwice_Exit1_ClockRestored', LONG, async () => {
  let calls = 0;
  const run = await runCase('timelapse-grab', commandStoryboard('timelapse-grab', [batch(600)]), {}, {
    // Every time-lapse grab misses its deadline: one re-grab of the same frame, then Exit 1.
    timelapseGrab: async () => { calls++; return null; },
  });
  expectError(run, 1, 'timelapse-grab-timeout');
  assert.equal(calls, 2, 'exactly one re-grab of the same frame, never a duplicate');
  const log = runLogOf(run);
  assert.ok(log?.timelapses?.[0]?.wallEnd && log.timelapses[0].wallEnd.already !== true, 'wallEnd restored the clock after the abort');
});

test('Test_Run_CommunityBuild_CommercialCommandUnavailable_Exit1Diagnosis', LONG, async () => {
  // F9 (contract-tier-boundary rules 5/6): a Community build answers "unavailable" for
  // des.checkpoint.*, experiment.* and snapshot.* — the recorder names the command, no crash.
  const run = await runCase('community', commandStoryboard('community', [
    { type: 'command', id: 'des.checkpoint.load', via: 'direct', args: { t: 0 } },
  ], { url: '/?cmdfixture=1&community=1&mode=animated' }));
  expectError(run, 1, 'command-unavailable');
  assert.match(run.error.message, /'des\.checkpoint\.load' is not available in this build \(commercial-feature/);
  assert.match(run.error.message, /Commercial command/);
});

// ── plan-2237 post-implementation review (Codex 2026-11-04) ──────────────────────────────────

test('Test_Run_Timelapse_CompletionAfterAbsoluteDeadline_TimeoutWithCancel', LONG, async () => {
  // Review 1: maxWallSec 0.1 at 2 fps, the batch completes at ~400 ms (24 pump ticks). The next slot
  // (500 ms) lies after the deadline: no further frame, `timelapse-timeout`, cancel dispatched.
  const started = Date.now();
  const run = await runCase('timelapse-deadline', commandStoryboard('timelapse-deadline', [
    batch(24, { fps: 2, maxWallSec: 0.1 }),
  ]));
  expectError(run, 1, 'timelapse-timeout');
  assert.match(run.error.message, /timelapse\.maxWallSec 0\.1 s; experiment\.run\.cancel: ok/);
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run.cancel').length, 1);
  const lapse = runLogOf(run)?.timelapses?.[0];
  assert.ok(lapse, 'the time-lapse ran');
  assert.equal(lapse.end - lapse.start, 1, 'only the slot at 0 ms lies before the deadline');
  assert.ok(lapse.wallEnd.wallMs < 400, `wallEnd after ${lapse.wallEnd.wallMs} ms — the section outlived its deadline`);
  assert.ok(Date.now() - started < 120_000);
});

test('Test_Run_Timelapse_GrabBTimeout_RetryYieldsCleanAAndB', LONG, async () => {
  // Review 2: the first B grab of the first time-lapse frame times out; the re-grab of that frame
  // must start from a clean page — no proof stamp and no cursor in A, no stamp in B.
  let calls = 0;
  const run = await runCase('timelapse-b-retry', commandStoryboard('timelapse-b-retry', [
    { type: 'command', id: 'experiment.run', timelapse: { fps: 4, maxWallSec: 20 }, waitSec: 0.2 },
  ], { url: '/?cmdfixture=1&batchbutton=1&ticks=60' }), { burnCursor: true }, {
    timelapseGrab: async (params, ms, real) => (++calls === 2 ? null : real(params, ms)),
  });
  assert.ifError(run.error);
  const events = published(run.dir);
  const lapse = events.segments.find((segment) => segment.kind === 'timelapse');
  assert.ok(lapse, 'a time-lapse segment exists');
  assert.equal(events.frameCheck.verdict, 'ok');
  assert.equal(events.frameCheck.stampsContiguous, true, 'the re-grabbed frame carries its own stamp in the proof track');
  for (const file of ['recording.mp4', 'recording-cursor.mp4']) {
    const cells = await stampCellMeans(join(run.dir, file), lapse.start);
    assert.ok(Math.max(...cells) - Math.min(...cells) < 16, `${file} frame ${lapse.start}: corner cells ${cells.join(',')} look like a stamp`);
  }
  const press = events.buttons.find((event) => event.type === 'down');
  const clean = await regionPixels(join(run.dir, 'recording.mp4'), lapse.start, press);
  const later = await regionPixels(join(run.dir, 'recording.mp4'), lapse.start + 1, press);
  assert.ok(meanAbsDiff(clean, later) < 3, 'no cursor in the re-grabbed app frame');
});

test('Test_Run_Gate_UiReset_ClickWithoutCommandAction_WindowAndSimJump', LONG, async () => {
  // Review 3: a UI click on the reset button (a plain click, not a command action) jumps the clock
  // without changing mode, factor or pause. The take-wide time watch makes it a transition.
  const run = await runCase('gate-ui-reset', commandStoryboard('gate-ui-reset', [
    { type: 'wait', ms: 400 },
    { type: 'click', target: { selector: '#reset-command' } },
    { type: 'wait', ms: 400 },
  ]));
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(events.simProgress.verdict, 'ok');
  assert.deepEqual(events.simJumps.map((jump) => jump.cmd), ['sim.reset']);
  assert.equal(events.simJumps[0].toSim < events.simJumps[0].fromSim, true);
});

test('Test_Run_Gate_UiDesStep_ClickWithoutCommandAction_WindowAndSimJump', LONG, async () => {
  const run = await runCase('gate-ui-step', commandStoryboard('gate-ui-step', [
    { type: 'wait', ms: 400 },
    { type: 'click', target: { selector: '#step-command' } },
    { type: 'wait', ms: 400 },
  ], { url: '/?cmdfixture=1&mode=animated&stepbutton=1' }));
  assert.ifError(run.error);
  const events = published(run.dir);
  assert.equal(events.simProgress.verdict, 'ok');
  assert.deepEqual(events.simJumps.map((jump) => jump.cmd), ['des.step']);
});

test('Test_Run_CommunityBuild_CommercialCommandByClick_Exit1Diagnosis', LONG, async () => {
  // Review 4: the default click path keeps the structured cause from the command watch.
  const run = await runCase('community-click', commandStoryboard('community-click', [
    { type: 'command', id: 'des.checkpoint.load' },
  ], { url: '/?cmdfixture=1&community=1&mode=animated&checkpointbutton=1' }));
  expectError(run, 1, 'command-unavailable');
  assert.match(run.error.message, /'des\.checkpoint\.load' is not available in this build \(commercial-feature/);
  assert.match(run.error.message, /Commercial command/);
});

test('Test_Run_SimProgressSummary_KeepsPrePlanFields', LONG, async () => {
  // Review 5: summary.simProgress keeps sumSimTime / expectedSimTime / deviation / tolerance —
  // the actual produced summary, not a hand-made object.
  const run = await runCase('compat', pausedStoryboard('compat'));
  assert.ifError(run.error);
  const progress = run.result.summary.simProgress;
  for (const field of ['verdict', 'factor', 'clock', 'windowFrames', 'sumSimTime', 'expectedSimTime', 'deviation', 'tolerance']) {
    assert.ok(field in progress, `summary.simProgress.${field} is missing`);
  }
  assert.equal(progress.verdict, 'ok');
  assert.equal(progress.factor, 5);
  for (const field of ['sumSimTime', 'expectedSimTime', 'deviation', 'tolerance']) assert.equal(typeof progress[field], 'number', field);
  const first = progress.segments.find((segment) => segment.kind === 'run' && segment.verdict === 'pass');
  assert.ok(Math.abs(progress.expectedSimTime - 5 * first.frames / 30) < 1e-9);
  assert.ok(Math.abs(progress.sumSimTime - first.sumClock) < 1e-12);
  assert.ok(progress.deviation <= progress.tolerance);
});

// ── plan-2237 review round 2 (Codex 2026-11-04) ──────────────────────────────────────────────

test('Test_Run_Timelapse_NextSlotBeyondDeadline_CompletionBeforeDeadline_NoCancel', LONG, async () => {
  // Round 2, finding 1: at 2 fps the next slot (500 ms) lies beyond maxWallSec 0.3 s. The section
  // must keep waiting for the completion (~150 ms: 9 pump ticks) up to the deadline instead of
  // giving up after the first frame — the command completes and is NOT cancelled.
  const run = await runCase('timelapse-wait-to-deadline', commandStoryboard('timelapse-wait-to-deadline', [
    batch(9, { fps: 2, maxWallSec: 0.3 }),
  ]));
  assert.ifError(run.error);
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run.cancel').length, 0, 'a command completing before the deadline is never cancelled');
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run' && item.ok).length, 1);
  const lapse = run.result.summary.timelapses[0];
  assert.ok(lapse.end - lapse.start <= 1, 'no frame after the last slot that fits before the deadline');
  assert.ok(lapse.wallEnd.wallMs < 300, `wallEnd after ${lapse.wallEnd.wallMs} ms`);
});

test('Test_Run_Timelapse_HangingGrabsBoundedByDeadline_TimeoutWithCancel', LONG, async () => {
  // Round 2, finding 2: grabs that hang until their budget must not stretch maxWallSec 0.1 s (the
  // slot allowance at 2 fps is 1000 ms). Each grab gets at most the time left; the miss that the
  // deadline caused is `timelapse-timeout` WITH the cancel, not `timelapse-grab-timeout`.
  const budgets = [];
  const run = await runCase('timelapse-hanging-grabs', commandStoryboard('timelapse-hanging-grabs', [
    batch(1_000_000, { fps: 2, maxWallSec: 0.1 }),
  ]), {}, {
    timelapseGrab: (params, ms) => { budgets.push(ms); return new Promise((done) => setTimeout(() => done(null), ms)); },
  });
  expectError(run, 1, 'timelapse-timeout');
  assert.match(run.error.message, /experiment\.run\.cancel: ok/);
  assert.equal(executedLog.filter((item) => item.id === 'experiment.run.cancel').length, 1);
  assert.ok(budgets.length >= 1 && budgets.every((ms) => ms <= 100), `grab budgets ${budgets.join(',')} exceed the 100-ms section`);
  const lapse = runLogOf(run)?.timelapses?.[0];
  assert.ok(lapse?.wallEnd && lapse.wallEnd.wallMs < 400, `wallEnd after ${lapse?.wallEnd?.wallMs} ms — the deadline did not bound the grabs`);
});

for (const [variant, url] of [
  ['MissingCommunityButton', '/?cmdfixture=1&community=1&mode=animated'],
  ['DisabledCommunityButton', '/?cmdfixture=1&community=1&mode=animated&checkpointbutton=disabled'],
  ['DisabledProductionButton', '/?cmdfixture=1&commercial=disabled&mode=animated&checkpointbutton=disabled'],
]) {
  test(`Test_Run_ClickPath_${variant}_CommandUnavailableWithCommercialHint`, LONG, async () => {
    // Round 2, finding 3: the registry is asked (read-only) before the button lookup, so neither a
    // missing button nor a disabled one hides the cause; nothing is dispatched.
    const id = `click-${variant.toLowerCase()}`;
    const run = await runCase(id, commandStoryboard(id, [{ type: 'command', id: 'des.checkpoint.load' }], { url }));
    expectError(run, 1, 'command-unavailable');
    assert.match(run.error.message, /'des\.checkpoint\.load' is not available in this build/);
    assert.match(run.error.message, /Commercial command/);
    assert.equal(executedLog.filter((item) => item.id === 'des.checkpoint.load').length, 0);
  });
}
