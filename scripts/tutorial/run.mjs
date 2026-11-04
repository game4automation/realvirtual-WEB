// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { createServer } from 'node:http';
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { extname, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { chromium } from 'playwright';

import { planMove } from './lib/cursor-path.mjs';
import {
  DEFAULT_FPS, DEFAULT_MOTION_REGION, MARKER_LEAD_SEC, MARKER_SEC, MARKER_TAIL_SEC, MIN_MOVED_FRACTION, MOTION_DOWNSCALE,
  MOTION_METRIC, MOTION_SCALE, STILL_THRESHOLD, controlFrameVerdict, frameAtStart, frameBudget,
  frameCountVerdict, frameToSec, framesOf, motionShapeVerdict, motionVerdict, syncVerdict,
  traceCoverageVerdict, segmentKindOf,
} from './lib/tutorial-events.mjs';
import { gpuVerdict, sceneVerdict } from './lib/scene-probe.mjs';
import {
  PREFLIGHT_WARMUP_SEC, PREFLIGHT_WINDOW_FRAMES, preflightVerdict, warmupEndIndex,
  clockOnlyVerdict, simProgressVerdict,
} from './lib/epoch-preflight.mjs';
import { parseTutorial } from './lib/tutorial-schema.mjs';
import { virtualClockInitScript } from './lib/virtual-clock.mjs';
import { installTutorialOverlay } from './lib/tutorial-overlay.mjs';
import {
  MARKER_RGB, STAMP, createEncoder, distInfo, extractFrame, killActiveChildren, markerOnsets, measureMotion,
  probeFrames as probeFramesProduction, readMarkerFrames, readStamps, resolveEncoders,
  stampsContiguous, thumbnailOf,
} from './lib/tutorial-capture.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNOPSIS = `Usage:
  node scripts/tutorial/run.mjs --script scripts/tutorial/storyboards/demo-basics.json \\
    [--dir <output folder>] [--dist <folder>] [--port 5199] [--base <url>] [--overwrite] \\
    [--ffmpeg <path>] [--ffprobe <path>] [--gpu-check require|off] \\
    [--motion-check require|off] [--keep-temp] [--epoch-zero-diagnosis] [--burn-cursor] \\
    [--stamp proof|inline] [--profile <dir>] [--save-profile <dir>]
  node scripts/tutorial/run.mjs --prepare-profile <dir> --base <url>`;
const GPU_ARGS = Object.freeze([
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
  '--disable-frame-rate-limit', '--disable-gpu-vsync', '--hide-scrollbars', '--mute-audio',
]);
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.hdr': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.data': 'application/octet-stream', '.ktx2': 'application/octet-stream',
  '.bin': 'application/octet-stream',
});
/**
 * Upper bound for EACH teardown step (encoder finish/abort, browser close, server close), in ms.
 * A DECLARED budget, not a measurement: a teardown that hangs must never outlive the run it ends —
 * 2026-10-27 a run whose test timed out kept Chrome and ffmpeg alive for 37 minutes, because
 * nothing ever reached the runner's `finally`.
 */
const TEARDOWN_BUDGET_MS = 15000;

/**
 * Resolves with `'done'` when `promise` settles (its rejection is swallowed — teardown is best
 * effort and the primary error wins) or with `'timeout'` after `ms`. Never rejects.
 */
export async function withBudget(promise, ms) {
  let timer;
  const timeout = new Promise((resolvePromise) => { timer = setTimeout(() => resolvePromise('timeout'), ms); });
  try {
    return await Promise.race([Promise.resolve(promise).then(() => 'done', () => 'done'), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TutorialRunError extends Error {
  constructor(exitCode, diagnosis, message, details = {}) {
    super(message);
    this.name = 'TutorialRunError';
    this.exitCode = exitCode;
    this.diagnosis = diagnosis;
    Object.assign(this, details);
  }
}

function fail(exitCode, diagnosis, message, details) {
  throw new TutorialRunError(exitCode, diagnosis, message, details);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `--save-profile` replaces its target recursively, so the target must be a fresh folder or an
 * existing Chrome profile — never the repo, an ancestor of it, or an ancestor of `--profile`.
 */
function checkSaveProfileTarget(target, source) {
  const inside = (child, parent) => {
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  if (inside(REPO_ROOT, target) || inside(target, REPO_ROOT) || (source && inside(source, target))) {
    throw new TutorialRunError(2, 'usage', `--save-profile ${target} must not be the repository, inside it, or a parent of --profile`);
  }
  if (existsSync(target) && !existsSync(join(target, 'Local State'))) {
    throw new TutorialRunError(2, 'usage', `--save-profile ${target} exists but is not a Chrome profile (no "Local State"); refusing to replace it`);
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    throw new TutorialRunError(2, 'usage', SYNOPSIS);
  }
  const opts = {};
  const flags = new Set(['--overwrite', '--keep-temp', '--epoch-zero-diagnosis', '--burn-cursor']);
  const values = new Map([
    ['--script', 'script'], ['--dir', 'dir'], ['--dist', 'dist'], ['--port', 'port'],
    ['--base', 'base'], ['--ffmpeg', 'ffmpeg'], ['--ffprobe', 'ffprobe'],
    ['--gpu-check', 'gpuCheck'], ['--motion-check', 'motionCheck'], ['--stamp', 'stamp'],
    ['--profile', 'profile'], ['--prepare-profile', 'prepareProfile'], ['--save-profile', 'saveProfile'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flags.has(arg)) {
      if (arg === '--overwrite') opts.overwrite = true;
      if (arg === '--keep-temp') opts.keepTemp = true;
      if (arg === '--epoch-zero-diagnosis') opts.epochZeroDiagnosis = true;
      if (arg === '--burn-cursor') opts.burnCursor = true;
      continue;
    }
    const key = values.get(arg);
    if (!key) throw new TutorialRunError(2, 'usage', `unknown option '${arg}'\n\n${SYNOPSIS}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new TutorialRunError(2, 'usage', `${arg} needs a value\n\n${SYNOPSIS}`);
    }
    opts[key] = key === 'port' ? Number(value) : value;
  }
  if (opts.prepareProfile) {
    if (!opts.base) throw new TutorialRunError(2, 'usage', `--prepare-profile needs --base\n\n${SYNOPSIS}`);
    return opts;
  }
  if (opts.profile && !existsSync(resolve(opts.profile))) {
    throw new TutorialRunError(2, 'usage', `--profile ${opts.profile} does not exist; create it with --prepare-profile`);
  }
  if (opts.saveProfile) checkSaveProfileTarget(resolve(opts.saveProfile), opts.profile ? resolve(opts.profile) : null);
  if (!opts.script) throw new TutorialRunError(2, 'usage', `--script is required\n\n${SYNOPSIS}`);
  if (opts.port !== undefined && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    throw new TutorialRunError(2, 'usage', '--port must be an integer in 1..65535');
  }
  if (opts.stamp !== undefined && !['proof', 'inline'].includes(opts.stamp)) {
    throw new TutorialRunError(2, 'usage', '--stamp must be proof or inline');
  }
  for (const key of ['gpuCheck', 'motionCheck']) {
    // 'warn' (motion check only): AI takes watch an assistant think for minutes, so Gate C reports
    // a low movedFraction instead of failing the take; the cut shortens those stretches.
    const allowed = key === 'motionCheck' ? ['require', 'off', 'warn'] : ['require', 'off'];
    if (opts[key] !== undefined && !allowed.includes(opts[key])) {
      throw new TutorialRunError(2, 'usage', `--${key === 'gpuCheck' ? 'gpu-check' : 'motion-check'} must be ${allowed.join(' or ')}`);
    }
  }
  return opts;
}

function checkedOutputDir(input) {
  const abs = resolve(process.cwd(), input);
  let existing = abs;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const tail = relative(existing, abs);
  const canonTarget = join(realpathSync.native(existing), tail);
  const canonRepo = realpathSync.native(REPO_ROOT);
  const rel = relative(canonRepo, canonTarget);
  const inside = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
  if (!inside) fail(2, 'dir-outside-repo', `--dir must resolve inside the WebViewer repo, not to its root or outside it: ${abs}`);

  // The non-existing tail followed no symlink during this check. A same-machine race remains:
  // another process could create that tail as a symlink before mkdir; O_NOFOLLOW per segment is
  // not portable on Windows, so that owner-controlled development-machine race stays unhandled.
  mkdirSync(canonTarget, { recursive: true });
  return canonTarget;
}

function validateDist(dist) {
  if (!existsSync(dist) || !existsSync(join(dist, 'index.html'))) {
    fail(2, 'configuration-error', `finished static build missing at ${dist}; run: npm run build`);
  }
}

function staticHandler(root) {
  return (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      let file = resolve(root, `.${pathname}`);
      const rel = relative(root, file);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('path escapes dist');
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
      const bytes = readFileSync(file);
      response.writeHead(200, {
        'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cross-origin-opener-policy': 'same-origin',
        'cross-origin-embedder-policy': 'require-corp',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(errorText(error));
    }
  };
}

function listen(server, port) {
  return new Promise((resolvePromise, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolvePromise(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startStaticServer(dist, requestedPort) {
  const first = requestedPort ?? 5199;
  if (first === 5100 || first === 5173) {
    fail(2, 'configuration-error', `port ${first} is reserved for another realvirtual process and must stay untouched`);
  }
  const last = first >= 5199 && first <= 5209 ? 5209 : first;
  for (let port = first; port <= last; port++) {
    const server = createServer(staticHandler(dist));
    try {
      await listen(server, port);
      return { server, port, base: `http://127.0.0.1:${port}` };
    } catch (error) {
      if (server.listening) await new Promise((done) => server.close(() => done()));
      if (error?.code !== 'EADDRINUSE') throw error;
    }
  }
  fail(2, 'configuration-error', `no free tutorial server port in ${first}..${last}`);
}

async function closeServer(server) {
  if (!server?.listening) return;
  const closed = new Promise((resolvePromise) => server.close(() => resolvePromise()));
  // The run is over: idle keep-alive sockets of the closed browser must not hold `close()` open.
  server.closeAllConnections?.();
  await closed;
}

async function waitForServer(base) {
  const root = new URL('/', base).href;
  const deadline = Date.now() + 5000;
  let last = 'no response';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(root, { signal: controller.signal, cache: 'no-store' });
      if (response.status === 200) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = errorText(error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((done) => setTimeout(done, Math.min(100, Math.max(0, deadline - Date.now()))));
  }
  fail(1, 'server-not-ready', `GET / was not ready within 5 s at ${base}: ${last}`);
}

function pagePreparationInitScript(options) {
  try {
    localStorage.setItem('rv-terms-accepted', '1');
    localStorage.setItem('rv-connect-autoconnect-optout', '1');
    localStorage.setItem('rv-auto-quality-applied', '1');
    if (options.welcome !== 'show') localStorage.setItem('rv-welcome-dismissed', '1');
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('rv-panel-geo:') || key.startsWith('rv-panel-collapsed:')) localStorage.removeItem(key);
    }
  } catch { /* opaque origin */ }
  const dismissed = new WeakSet();
  const closeBanner = () => {
    const button = document.querySelector('button[aria-label="Hide dev server banner until reload"]');
    if (button && !dismissed.has(button)) { dismissed.add(button); button.click(); }
  };
  new MutationObserver(closeBanner).observe(document, { childList: true, subtree: true });
}

async function dismissNags(page) {
  for (let pass = 0; pass < 3; pass++) {
    const count = await page.evaluate(() => {
      let changed = 0;
      for (const button of document.querySelectorAll('button')) {
        const text = (button.textContent ?? '').trim();
        if (/^(ok|got it|accept|close)$/i.test(text) && button.offsetParent !== null) {
          button.click();
          changed++;
        }
      }
      for (const element of document.querySelectorAll('div,section')) {
        if ((element.textContent ?? '').startsWith('Browser is using integrated graphics')) {
          element.style.display = 'none';
          changed++;
        }
      }
      return changed;
    });
    if (count === 0) break;
    await page.waitForTimeout(400);
  }
}

async function readGpuRaw(page) {
  return page.evaluate(() => {
    for (const canvas of document.querySelectorAll('canvas')) {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) continue;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a';
      return { hasWebglCanvas: true, renderer: String(renderer) };
    }
    return { hasWebglCanvas: false, renderer: null };
  });
}

function buttonMask(button) {
  return button === 'right' ? 2 : button === 'middle' ? 4 : 1;
}

function buttonName(button) {
  return button ?? 'left';
}

function centerOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function movedMoreThanTwo(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y) > 2;
}

function substituteAction(action, bindings) {
  const copy = structuredClone(action);
  const replace = (value) => {
    if (typeof value === 'string' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return bindings.get(value.slice(1));
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
    return value;
  };
  for (const target of [copy.target, copy.from, copy.to, copy.at]) {
    if (!target || typeof target !== 'object') continue;
    if ('node' in target) target.node = replace(target.node);
    if ('recordingTarget' in target) target.key = replace(target.key);
  }
  if (copy.type === 'command' && copy.args !== undefined) copy.args = replace(copy.args);
  return copy;
}

async function requireRecordingSeam(page) {
  if (!await page.evaluate(() => Boolean(window.__rvRecording))) {
    fail(1, 'recording-seam-missing', 'window.__rvRecording is unavailable; the page requires ?recording=1');
  }
}

async function commandButtonLocator(page, target) {
  const escape = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\n\r\f]/g, (char) => `\\${char.charCodeAt(0).toString(16)} `);
  const selector = `[data-rv-command-id="${escape(target.command)}"]`
    + (target.buttonKey === undefined ? '' : `[data-rv-button-id="${escape(target.buttonKey)}"]`);
  const locator = page.locator(`${selector}:visible`);
  const count = await locator.count();
  if (count === 0) fail(1, 'command-button-missing', `no visible button for ${selector}`);
  if (count > 1) fail(1, 'command-button-ambiguous', `${count} visible buttons for ${selector}`);
  return locator;
}

function matchingCommand(events, action) {
  const event = events.find((candidate) => candidate.id === action.id);
  if (!event) return false;
  if (action.via !== 'direct' && action.args !== undefined && !isDeepStrictEqual(event.args, action.args)) {
    fail(1, 'command-args-mismatch', `${action.id}: expected ${JSON.stringify(action.args)}, actual ${JSON.stringify(event.args)}`);
  }
  if (event.ok === false) fail(1, 'command-failed', `${action.id}: command execution failed`);
  return true;
}

function bindPick(action, result, bindings) {
  if (!result || result.error || typeof result.path !== 'string') fail(1, 'pick-no-match', `no match for ${action.rule} among ${action.among}`);
  bindings.set(action.as, result.path);
}

async function inspectTarget(page, target, { requireHit = false } = {}) {
  if ('node' in target || 'recordingTarget' in target) {
    await requireRecordingSeam(page);
    const point = await page.evaluate((value) => 'node' in value
      ? window.__rvRecording.nodeScreen(value.node, value.anchor)
      : window.__rvRecording.target(value.recordingTarget, value.key), target);
    if (point == null) fail(1, 'node' in target ? 'node-target-missing' : 'recording-target-missing', `target unavailable: ${JSON.stringify(target)}`);
    return { point, box: { x: point.x, y: point.y, w: 1, h: 1 }, locator: null, position: null, dynamic: true };
  }
  if ('x' in target) return {
    box: { x: target.x, y: target.y, w: 1, h: 1 },
    point: { x: target.x, y: target.y }, locator: null, position: null,
  };
  // F2: the target must be UNIQUE. `.first()` alone would silently record an interaction with
  // whichever of several matches comes first (Codex review 2026-10-27).
  const candidates = 'command' in target ? await commandButtonLocator(page, target) : page.locator(target.selector);
  const matches = await candidates.count();
  if (matches === 0) throw new Error(`target '${target.selector}' does not exist`);
  if (matches > 1) throw new Error(`target '${target.selector}' matches ${matches} elements; a storyboard target must be unique`);
  const locator = candidates.first();
  await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
  const raw = await locator.evaluate((element, checkHit) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
      borderTop: Number.parseFloat(style.borderTopWidth) || 0,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && Number.parseFloat(style.opacity || '1') > 0,
      hit: !checkHit || hit === element || element.contains(hit),
    };
  }, requireHit);
  if (!raw.visible) throw new Error(`target '${target.selector}' is not visible`);
  if (!raw.hit) throw new Error(`target '${target.selector}' is covered at its click point`);
  const point = centerOf(raw.rect);
  return {
    box: raw.rect,
    point,
    locator,
    position: { x: point.x - (raw.rect.x + raw.borderLeft), y: point.y - (raw.rect.y + raw.borderTop) },
  };
}

function seedOf(stepId, actionIndex, attempt) {
  let seed = 2166136261;
  for (const char of `${stepId}:${actionIndex}:${attempt}`) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  return seed >>> 0;
}

async function performSetupAction(page, action, bindings) {
  action = substituteAction(action, bindings);
  const targetLocator = async (target) => {
    if ('command' in target) return commandButtonLocator(page, target);
    if (!('selector' in target)) return null;
    const locator = page.locator(target.selector).first();
    if (await locator.count() === 0) throw new Error(`setup target '${target.selector}' does not exist`);
    await locator.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'center' }));
    return locator;
  };
  switch (action.type) {
    case 'command': {
      await requireRecordingSeam(page);
      await page.evaluate(() => window.__rvRecording.armCommandWatch());
      try {
        const deadline = Date.now() + action.maxWaitSec * 1000;
        if (action.via === 'direct') {
          let timer;
          let result;
          try {
            result = await Promise.race([
              page.evaluate(async ({ id, args }) => {
                try { return await window.__rvRecording.execute(id, args); }
                catch (error) { return { ok: false, reason: String(error) }; }
              }, action),
              new Promise((done) => { timer = setTimeout(() => done(null), action.maxWaitSec * 1000); }),
            ]);
          } finally { clearTimeout(timer); }
          if (result === null) fail(1, 'command-timeout', `${action.id} exceeded ${action.maxWaitSec} s`);
          if (!result?.ok) fail(1, 'command-failed', `${action.id}: ${result?.reason ?? 'execution failed'}`);
        } else {
          const locator = await commandButtonLocator(page, { command: action.id, buttonKey: action.buttonKey });
          await locator.click({ force: true });
        }
        const events = [];
        for (;;) {
          events.push(...await page.evaluate(() => window.__rvRecording.takeCommandWatch()));
          if (matchingCommand(events, action)) break;
          if (Date.now() >= deadline) fail(1, 'command-timeout', `${action.id} exceeded ${action.maxWaitSec} s`);
          await page.waitForTimeout(Math.min(50, Math.max(0, deadline - Date.now())));
        }
        await page.waitForTimeout(action.waitSec * 1000);
      } finally {
        await page.evaluate(() => window.__rvRecording.stopCommandWatch());
      }
      break;
    }
    case 'pick': {
      await requireRecordingSeam(page);
      const token = await page.evaluate(({ rule, among }) => window.__rvRecording.pickBegin(rule, among), action);
      await page.waitForTimeout(action.sampleSec * 1000);
      const result = await page.evaluate(({ token, dt }) => window.__rvRecording.pickEnd(token, dt), { token, dt: action.sampleSec });
      bindPick(action, result, bindings);
      break;
    }
    case 'click': {
      const target = await targetLocator(action.target);
      if (target) await target.click({ button: action.button, force: true });
      else {
        const { point } = await inspectTarget(page, action.target);
        await page.mouse.click(point.x, point.y, { button: action.button });
      }
      break;
    }
    case 'doubleClick': {
      const target = await targetLocator(action.target);
      if (target) await target.dblclick({ button: action.button, force: true });
      else {
        const { point } = await inspectTarget(page, action.target);
        await page.mouse.dblclick(point.x, point.y, { button: action.button });
      }
      break;
    }
    case 'hover': {
      const target = await targetLocator(action.target);
      if (target) await target.hover({ force: true });
      else {
        const { point } = await inspectTarget(page, action.target);
        await page.mouse.move(point.x, point.y);
      }
      break;
    }
    case 'drag': {
      const from = await targetLocator(action.from);
      const to = await targetLocator(action.to);
      if (!from || !to) throw new Error('setup drag needs selector targets');
      await from.dragTo(to, { force: true });
      break;
    }
    case 'wheel': {
      const at = await targetLocator(action.at);
      if (at) await at.hover({ force: true });
      else {
        const { point } = await inspectTarget(page, action.at);
        await page.mouse.move(point.x, point.y);
      }
      await page.mouse.wheel(0, action.deltaY);
      break;
    }
    case 'press': await page.keyboard.press(action.key); break;
    case 'type': {
      const target = await targetLocator(action.target);
      if (target) {
        await target.click({ force: true });
        await target.pressSequentially(action.text, { delay: action.delayMs });
      } else {
        const { point } = await inspectTarget(page, action.target);
        await page.mouse.click(point.x, point.y);
        await page.keyboard.type(action.text, { delay: action.delayMs });
      }
      break;
    }
    case 'waitFor': {
      if (action.selector) await page.locator(action.selector).first().waitFor({ state: action.state, timeout: action.timeoutMs });
      if (action.scene) {
        // Same shape as the step path (`waitFor`, loop below): kick `whenSceneReady()` off ONCE,
        // then POLL. Awaiting it and reading `currentModelRoot` in the same microtask made this
        // path one-shot — measured, `whenSceneReady()` resolves after 0.10 ms on the already
        // settled promise of the empty start scene while `currentModelRoot` only appears
        // 1093-1351 ms later, so the budget was never consumed.
        //
        // What the loop waits for: `currentModelRoot` AND — if the storyboard names `doc` —
        // `currentModelUrl === doc`. LIMITATION: without `doc` the presence of a model root is
        // all there is to go on, so a WRONG document that loads successfully passes this gate.
        // Naming `doc` in the storyboard is the only way to rule that out.
        const waitKey = `rv-tutorial-setup-scene-${Date.now()}`;
        await page.evaluate((key) => {
          const state = { done: false };
          window[key] = state;
          Promise.resolve(window.viewer?.whenSceneReady?.()).then(() => { state.done = true; });
        }, waitKey);
        const pollMs = 50;
        const started = Date.now();
        let decision = null;
        for (;;) {
          const elapsedMs = Date.now() - started;
          const raw = await page.evaluate(({ key, elapsed }) => {
            const viewer = window.viewer;
            const progress = viewer?.placements?.progress;
            return {
              ready: window[key]?.done === true && (!progress || progress.pending === 0),
              modelRoot: viewer?.currentModelRoot?.name ?? null,
              doc: viewer?.currentModelUrl ?? null,
              elapsedMs: elapsed,
            };
          }, { key: waitKey, elapsed: elapsedMs });
          decision = sceneVerdict(raw, { doc: action.doc, timeoutMs: action.timeoutMs });
          if (decision.verdict !== 'waiting') break;
          // The HARD limit, and the same one the step path uses (`action.timeoutMs`). `sceneVerdict`
          // already turns an exhausted budget into an `error`, so this is a belt-and-braces exit
          // that can never leave the loop running silently — a setup step that waits forever is
          // worse than the one-shot path it replaced, because that one at least said so at once.
          if (elapsedMs >= action.timeoutMs) {
            decision = {
              verdict: 'error', diagnosis: 'step-error',
              reason: `waitFor scene gave up after ${action.timeoutMs} ms (last state: ${decision.reason})`,
            };
            break;
          }
          await page.waitForTimeout(pollMs);
        }
        await page.evaluate((key) => { delete window[key]; }, waitKey);
        if (decision.verdict !== 'ok') throw new Error(decision.reason);
      }
      break;
    }
    case 'wait': await page.waitForTimeout(action.ms); break;
    case 'camera': {
      await page.evaluate(({ position, target, durationSec }) => {
        const viewer = window.viewer;
        if (!viewer?.camera) throw new Error('camera action needs window.viewer.camera');
        const V = viewer.camera.position.constructor;
        viewer.animateCameraTo(new V(...position), new V(...target), durationSec, 'easeInOut', 'tutorial');
      }, action);
      await page.waitForTimeout(action.durationSec * 1000);
      break;
    }
    default: throw new Error(`unsupported setup action ${action.type}`);
  }
}

const CURSOR_PRESS_SEC = 0.15;

/**
 * The proof grab (plan-2043, `stamp: 'proof'`): ONLY the stamp region, inside the viewport — no
 * `captureBeyondViewport`, so the page sees no resize. The clip is in document coordinates, so it is
 * offset by the scroll position at which the viewport-fixed stamp was shown.
 */
function proofGrab(scroll) {
  return {
    format: 'jpeg', quality: 95, captureBeyondViewport: false, fromSurface: true,
    clip: { x: STAMP.x + scroll.x, y: STAMP.y + scroll.y, width: STAMP.w, height: STAMP.h, scale: 1 },
  };
}

function createCaptureState({ page, cdp, encoder, encoder2 = null, proofEncoder = null, fps, trace }) {
  let frame = 0;
  let ring = null; // { start, x, y } of the latest left press (burn-cursor only)
  let cursor = { x: 0, y: 0 };
  const timings = [];

  async function capture(dispatch) {
    const buttonsBefore = trace.buttons.length;
    if (dispatch) await dispatch(frame);
    if (encoder2) {
      const press = trace.buttons.slice(buttonsBefore).find((event) => event.type === 'down' && event.button === 'left');
      if (press) ring = { start: frame, x: press.x, y: press.y };
    }
    const timing = await page.evaluate(async ({ dt, wasPaused, proof }) => {
      // Proof mode: the stamp shown for the previous frame's proof grab is hidden again BEFORE this
      // frame's app grab — recording.mp4 never contains a stamp pixel.
      if (proof) window.__tutorialOverlay?.stamp(false);
      // Read the effective speed at resume, after the action and before its first step.
      let factor;
      if (wasPaused === true && window.viewer?.isSimulationPaused === false) {
        const result = await window.__rvRecording?.execute('des.status', {});
        factor = result?.ok && result.value?.subMode === 'hybrid' ? result.value.multiplier : 1;
      }
      const stepped = window.__vt.step(dt);
      const viewer = window.viewer;
      // DES clocks (read-only seam accessor): renderClock is continuous, simTime jumps per event.
      const desFields = () => {
        const clock = window.__rvRecording?.desClock?.();
        return clock ? { des: true, renderClock: clock.renderClock, desSubMode: clock.subMode } : {};
      };
      return {
        frame: stepped.frame,
        paused: viewer?.isSimulationPaused ?? null,
        simTime: viewer?.simTime ?? null,
        fixedStepCount: viewer?.fixedStepCount ?? null,
        factor,
        ...desFields(),
      };
    }, { dt: 1000 / fps, wasPaused: timings.at(-1)?.paused, proof: proofEncoder !== null });
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 95, captureBeyondViewport: false, fromSurface: true,
    });
    let shownAt = null; // proof mode: the scroll offset at which the stamp was shown
    try { await encoder.write(Buffer.from(shot.data, 'base64')); }
    catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg frame stream failed: ${errorText(error)}`); }
    if (encoder2) {
      // Grab B: the same virtual frame with the DOM cursor shown at the runner's pointer.
      const last = trace.pointer.at(-1);
      const at = ring && ring.start === frame ? ring : last;
      if (at) {
        const age = ring ? (frame - ring.start) / fps : undefined;
        await page.evaluate((state) => window.__tutorialOverlay.cursor(state), {
          x: at.x, y: at.y, pressed: age !== undefined && age < CURSOR_PRESS_SEC, ringAgeSec: age,
        });
        const shotB = await cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality: 95, captureBeyondViewport: false, fromSurface: true,
        });
        shownAt = await page.evaluate((proof) => {
          window.__tutorialOverlay.cursor(null);
          return proof ? window.__tutorialOverlay.stamp(true) : null;
        }, proofEncoder !== null);
        try { await encoder2.write(Buffer.from(shotB.data, 'base64')); }
        catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg cursor frame stream failed: ${errorText(error)}`); }
      } else {
        // No pointer yet: the cursor file shows the clean frame.
        try { await encoder2.write(Buffer.from(shot.data, 'base64')); }
        catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg cursor frame stream failed: ${errorText(error)}`); }
      }
    }
    if (proofEncoder) {
      // Grab P: the stamp region of the SAME virtual frame (no `__vt.step` since grab A).
      shownAt ??= await page.evaluate(() => window.__tutorialOverlay.stamp(true));
      const proof = await cdp.send('Page.captureScreenshot', proofGrab(shownAt));
      try { await proofEncoder.write(Buffer.from(proof.data, 'base64')); }
      catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg stamp-proof frame stream failed: ${errorText(error)}`); }
    }
    timings.push(timing);
    frame++;
    return timing;
  }

  async function moveTo(target, stepId, actionIndex) {
    let initialBox = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      const before = await inspectTarget(page, target);
      if (!initialBox) initialBox = before.box;
      const path = planMove(cursor, before.point, Math.max(1, Math.min(before.box.w, before.box.h)), seedOf(stepId, actionIndex, attempt), fps);
      for (let i = 0; i < path.length; i++) {
        const sample = path[i];
        const current = before.dynamic ? (await inspectTarget(page, target)).point : before.point;
        const weight = (i + 1) / path.length;
        const point = { x: sample.x + (current.x - before.point.x) * weight,
          y: sample.y + (current.y - before.point.y) * weight };
        await capture(async (atFrame) => {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 });
          trace.pointer.push({ frame: atFrame, t: frameToSec(atFrame, fps), x: point.x, y: point.y });
        });
        cursor = point;
      }
      const after = await inspectTarget(page, target);
      // Dynamic targets keep moving; their final projection belongs to the click boundary.
      if (before.dynamic || !movedMoreThanTwo(before.point, after.point)) return { ...after, approach: initialBox };
      if (attempt === 2) throw new Error(`target moved by more than 2 px after two re-approaches`);
    }
    throw new Error('unreachable re-approach state');
  }

  return { capture, moveTo, timings, get frame() { return frame; }, get cursor() { return cursor; }, set cursor(value) { cursor = value; } };
}

async function dispatchClick({ capture, cdp, page, inspected, target, button, clickCount, trace, fps }) {
  const atFrame = capture.frame;
  const t = frameToSec(atFrame, fps);
  let actualPoint = inspected.point;
  let actualBox = inspected.box;
  // `capture` here is the capture STATE object, not the per-frame function: inside
  // `createCaptureState` the bare name is the function, outside it only exposes it as `.capture`.
  await capture.capture(async () => {
    if (inspected.dynamic) {
      const fresh = await inspectTarget(page, target);
      actualPoint = fresh.point;
      actualBox = fresh.box;
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: actualPoint.x, y: actualPoint.y, buttons: 0 });
      capture.cursor = actualPoint;
      trace.pointer.push({ frame: atFrame, t, x: actualPoint.x, y: actualPoint.y });
    }
    if (inspected.locator) {
      const fresh = await inspectTarget(page, target, { requireHit: true });
      if (movedMoreThanTwo(inspected.point, fresh.point)) throw new Error('target moved between final approach and click');
      actualPoint = fresh.point;
      actualBox = fresh.box;
      if (clickCount === 1) {
        await fresh.locator.click({ button, position: fresh.position, force: true });
      } else {
        // The second press of a double click. `locator.click({ clickCount: 2 })` would send a
        // COMPLETE double click on top of the first click — three clicks in the browser, two in the
        // trace (Codex review 2026-10-27). One press/release with clickCount 2 at the hit-tested
        // point is what a human double click adds.
        const mask = buttonMask(button);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fresh.point.x, y: fresh.point.y, button, buttons: mask, clickCount });
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fresh.point.x, y: fresh.point.y, button, buttons: 0, clickCount });
      }
    } else {
      const mask = buttonMask(button);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: actualPoint.x, y: actualPoint.y, button, buttons: mask, clickCount });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: actualPoint.x, y: actualPoint.y, button, buttons: 0, clickCount });
    }
    trace.buttons.push({ t, type: 'down', button, x: actualPoint.x, y: actualPoint.y });
    trace.buttons.push({ t, type: 'up', button, x: actualPoint.x, y: actualPoint.y });
  });
  return { point: actualPoint, box: actualBox };
}

async function runRecordedAction(ctx, action, step, actionIndex) {
  const { capture, trace, fps, page, cdp, bindings } = ctx;
  action = substituteAction(action, bindings);
  const start = capture.frame;
  let targetBox;
  let approachBox;
  // `camera.target` is the look-at VECTOR ([x, y, z]), not a pointer target — the two fields
  // share a name. Without this exclusion every recorded `camera` action tried to move the mouse
  // to that array, and `inspectTarget` refused with "target 'undefined' does not exist" (no `x`
  // key on an array, no `selector`). The defect was masked: no run ever reached a recorded step.
  const pointerTarget = action.type === 'command'
    ? (action.via === 'direct' ? undefined : { command: action.id, buttonKey: action.buttonKey })
    : action.type === 'camera' || action.type === 'pick' ? undefined : (action.target ?? action.from ?? action.at);
  let inspected = null;
  if (pointerTarget) {
    inspected = await capture.moveTo(pointerTarget, step.id, actionIndex);
    targetBox = inspected.box;
    approachBox = inspected.approach;
  }

  switch (action.type) {
    case 'command': {
      await requireRecordingSeam(page);
      await page.evaluate(() => window.__rvRecording.armCommandWatch());
      try {
        const commandStart = capture.frame;
        const budget = framesOf(action.maxWaitSec, fps);
        if (action.via === 'direct') {
          await capture.capture(() => page.evaluate(({ id, args }) => {
            window.__tutorialCommandResult = null;
            window.__tutorialCommandPromise = Promise.resolve().then(() => window.__rvRecording.execute(id, args)).then(
              (result) => { window.__tutorialCommandResult = result; },
              (error) => { window.__tutorialCommandResult = { ok: false, reason: String(error) }; },
            );
          }, action));
        } else {
          const clicked = await dispatchClick({ capture, cdp, page, inspected, target: pointerTarget,
            button: 'left', clickCount: 1, trace, fps });
          targetBox = clicked.box;
        }
        const events = [];
        let completed = false;
        const poll = async () => {
          if (action.via === 'direct') {
            const result = await page.evaluate(() => window.__tutorialCommandResult);
            if (result && !result.ok) fail(1, 'command-failed', `${action.id}: ${result.reason}`);
          }
          events.push(...await page.evaluate(() => window.__rvRecording.takeCommandWatch()));
          completed = matchingCommand(events, action);
        };
        // Read even the dispatch frame: a synchronous command may already be complete.
        await poll();
        const waitFrames = Math.max(1, framesOf(action.waitSec, fps));
        for (let i = 0; i < waitFrames; i++) {
          if (!completed && capture.frame - commandStart >= budget) fail(1, 'command-timeout', `${action.id} exceeded ${action.maxWaitSec} s`);
          await capture.capture();
          await poll();
        }
        while (!completed) {
          if (capture.frame - commandStart >= budget) fail(1, 'command-timeout', `${action.id} exceeded ${action.maxWaitSec} s`);
          await capture.capture();
          await poll();
        }
      } finally {
        await page.evaluate(() => window.__rvRecording.stopCommandWatch());
      }
      break;
    }
    case 'pick': {
      await requireRecordingSeam(page);
      const token = await page.evaluate(({ rule, among }) => window.__rvRecording.pickBegin(rule, among), action);
      const frames = Math.max(1, framesOf(action.sampleSec, fps));
      for (let i = 0; i < frames; i++) await capture.capture();
      const result = await page.evaluate(({ token, dt }) => window.__rvRecording.pickEnd(token, dt), { token, dt: frameToSec(frames, fps) });
      bindPick(action, result, bindings);
      break;
    }
    case 'click':
    case 'doubleClick': {
      const button = buttonName(action.button);
      const clicks = action.type === 'doubleClick' ? 2 : 1;
      for (let clickCount = 1; clickCount <= clicks; clickCount++) {
        const clicked = await dispatchClick({ capture, cdp, page, inspected, target: action.target, button, clickCount, trace, fps });
        inspected = { ...inspected, ...clicked };
        targetBox = clicked.box;
      }
      break;
    }
    case 'hover': {
      await capture.capture(async (frame) => {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: inspected.point.x, y: inspected.point.y, buttons: 0 });
        trace.pointer.push({ frame, t: frameToSec(frame, fps), x: inspected.point.x, y: inspected.point.y });
      });
      break;
    }
    case 'drag': {
      const to = await inspectTarget(page, action.to);
      const dragFrames = Math.max(1, framesOf(action.durationMs / 1000, fps));
      const path = planMove(inspected.point, to.point, Math.max(1, Math.min(to.box.w, to.box.h)), seedOf(step.id, actionIndex, 99), fps);
      const samples = path.length === dragFrames ? path : Array.from({ length: dragFrames }, (_, i) => {
        const k = dragFrames === 1 ? 1 : i / (dragFrames - 1);
        return { x: inspected.point.x + (to.point.x - inspected.point.x) * k, y: inspected.point.y + (to.point.y - inspected.point.y) * k };
      });
      const button = buttonName(action.button);
      const mask = buttonMask(button);
      for (let i = 0; i < samples.length; i++) {
        const point = samples[i];
        await capture.capture(async (frame) => {
          const t = frameToSec(frame, fps);
          if (i === 0) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button, buttons: mask, clickCount: 1 });
            trace.buttons.push({ t, type: 'down', button, x: point.x, y: point.y });
          }
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button, buttons: mask });
          trace.pointer.push({ frame, t, x: point.x, y: point.y });
          if (i === samples.length - 1) {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button, buttons: 0, clickCount: 1 });
            trace.buttons.push({ t, type: 'up', button, x: point.x, y: point.y });
          }
        });
        capture.cursor = point;
      }
      targetBox = to.box;
      break;
    }
    case 'wheel': {
      const steps = action.steps;
      for (let i = 0; i < steps; i++) {
        await capture.capture(() => cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: inspected.point.x, y: inspected.point.y,
          deltaX: 0, deltaY: action.deltaY / steps, buttons: 0,
        }));
      }
      break;
    }
    case 'press': {
      await capture.capture(async (frame) => {
        await page.keyboard.press(action.key);
        trace.keys.push({ t: frameToSec(frame, fps), key: action.key, kind: 'press' });
      });
      break;
    }
    case 'type': {
      const typeFrames = framesOf(action.text.length * action.delayMs / 1000, fps);
      let sent = 0;
      for (let i = 0; i < typeFrames; i++) {
        await capture.capture(async (frame) => {
          if (i === 0) {
            if (inspected.locator) {
              const fresh = await inspectTarget(page, action.target, { requireHit: true });
              await fresh.locator.focus();
            } else {
              await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: inspected.point.x, y: inspected.point.y, button: 'left', buttons: 1, clickCount: 1 });
              await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: inspected.point.x, y: inspected.point.y, button: 'left', buttons: 0, clickCount: 1 });
              const t = frameToSec(frame, fps);
              trace.buttons.push({ t, type: 'down', button: 'left', x: inspected.point.x, y: inspected.point.y });
              trace.buttons.push({ t, type: 'up', button: 'left', x: inspected.point.x, y: inspected.point.y });
            }
          }
          const through = Math.floor(((i + 1) * action.text.length) / typeFrames);
          const chunk = action.text.slice(sent, through);
          if (chunk) {
            await cdp.send('Input.insertText', { text: chunk });
            trace.keys.push({ t: frameToSec(frame, fps), key: chunk, kind: 'type' });
            sent = through;
          }
        });
      }
      break;
    }
    case 'wait': {
      const count = Math.max(1, framesOf(action.ms / 1000, fps));
      for (let i = 0; i < count; i++) await capture.capture();
      break;
    }
    case 'waitFor': {
      const limit = framesOf(action.timeoutMs / 1000, fps);
      const waitKey = `rv-tutorial-scene-${step.id}-${actionIndex}`;
      if (action.scene) {
        await page.evaluate((key) => {
          const state = { done: false };
          window[key] = state;
          Promise.resolve(window.viewer?.whenSceneReady?.()).then(() => { state.done = true; });
        }, waitKey);
      }
      let outcome = null;
      for (let i = 0; i < limit; i++) {
        if (action.scene) {
          const raw = await page.evaluate(({ key, elapsedMs }) => {
            const viewer = window.viewer;
            const progress = viewer?.placements?.progress;
            const settled = window[key]?.done === true && (!progress || progress.pending === 0);
            return {
              ready: settled,
              modelRoot: viewer?.currentModelRoot?.name ?? null,
              doc: viewer?.currentModelUrl ?? null,
              elapsedMs,
            };
          }, { key: waitKey, elapsedMs: frameToSec(i, fps) * 1000 });
          outcome = sceneVerdict(raw, { doc: action.doc, timeoutMs: action.timeoutMs });
        } else {
          // `locator.evaluate` WAITS for the element to attach — under the virtual clock nothing
          // can appear while it waits (no frame advances), so an absent selector would stall the
          // take. Count first (immediate), evaluate only an attached element (Codex review 2026-10-27).
          const attached = await page.locator(action.selector).count();
          const matched = attached === 0 ? action.state === 'hidden' : await page.locator(action.selector).first().evaluate((element, state) => {
            const style = getComputedStyle(element);
            const visible = element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
              && style.visibility !== 'hidden' && style.display !== 'none';
            return state === 'hidden' ? !visible : state === 'attached' ? true : visible;
          }, action.state).catch(() => action.state === 'hidden');
          outcome = matched ? { verdict: 'ok' } : { verdict: 'waiting' };
        }
        await capture.capture();
        if (outcome.verdict === 'ok') break;
        if (outcome.verdict === 'error') throw new Error(outcome.reason);
      }
      if (outcome?.verdict !== 'ok') throw new Error(`waitFor timed out after ${action.timeoutMs} ms`);
      trace.waitForActualFrames.push(capture.frame - start);
      break;
    }
    case 'camera': {
      await page.evaluate(({ position, target, durationSec }) => {
        const viewer = window.viewer;
        if (!viewer?.camera) throw new Error('camera action needs window.viewer.camera');
        const V = viewer.camera.position.constructor;
        viewer.animateCameraTo(new V(...position), new V(...target), durationSec, 'easeInOut', 'tutorial');
      }, action);
      const count = framesOf(action.durationSec, fps);
      for (let i = 0; i < count; i++) await capture.capture();
      const animating = await page.evaluate(() => window.viewer?.isCameraAnimating === true);
      if (animating) fail(1, 'camera-animation-not-finished', `camera action ${step.id}[${actionIndex}] is still animating after ${count} frames`);
      break;
    }
    default: throw new Error(`unsupported action ${action.type}`);
  }

  const segment = {
    kind: segmentKindOf(action.type),
    ...(action.type === 'command' ? { id: action.id } : {}),
    start, end: capture.frame, stepId: step.id, actionIndex,
    ...(targetBox ? { target: targetBox } : {}),
    ...(approachBox ? { approach: approachBox } : {}),
  };
  if (segment.end <= segment.start) throw new Error(`action ${step.id}[${actionIndex}] produced no frame`);
  trace.segments.push(segment);
}

function productionBuildTrace(raw) {
  return raw;
}

function motionDeclaration(region) {
  return {
    region, metric: MOTION_METRIC, scale: MOTION_SCALE, downscale: MOTION_DOWNSCALE,
    stillThreshold: STILL_THRESHOLD, minMovedFraction: MIN_MOVED_FRACTION,
  };
}

function buildStillSelection(events, script) {
  const roles = new Map();
  const add = (frame, role) => {
    if (!Number.isInteger(frame) || frame < 0 || frame >= events.video.frames) return;
    if (!roles.has(frame)) roles.set(frame, new Set());
    roles.get(frame).add(role);
  };
  let click = 0;
  for (const event of events.buttons) {
    if (event.type === 'down') add(frameAtStart(event.t, events.video.fps), `click-${++click}`);
  }
  let command = 0;
  for (const segment of events.segments) {
    if (segment.kind === 'command') add(segment.start, `cmd-${++command}-${segment.id.toLowerCase().replace(/[^a-z0-9]/g, '-')}`);
  }
  let camera = 0;
  for (const segment of events.segments) {
    if (segment.stepId === null || segment.actionIndex === undefined) continue;
    const step = script.steps.find((candidate) => candidate.id === segment.stepId);
    if (step?.actions[segment.actionIndex]?.type !== 'camera') continue;
    camera++;
    add(segment.start, `cam-${camera}-begin`);
    add(segment.end - 1, `cam-${camera}-end`);
  }
  for (const step of events.steps) add(step.start, `step-${step.id}`);
  add(0, 'start');
  add(Math.floor((events.video.frames - 1) / 2), 'mid');
  add(events.video.frames - 1, 'end');

  const rank = (role) => role === 'start' ? 0 : role === 'mid' ? 1 : role === 'end' ? 2
    : role.startsWith('step-') ? 3 : (role.startsWith('click-') || role.startsWith('cmd-')) ? 4 : 5;
  return [...roles.entries()].sort((a, b) => a[0] - b[0]).map(([frame, set]) => {
    const ordered = [...set].sort((a, b) => rank(a) - rank(b));
    return { frame, roles: ordered, file: `stills-f${String(frame).padStart(6, '0')}-${ordered.join('+')}.jpg` };
  });
}

function uniqueTempDir(outputDir) {
  const iso = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = join(outputDir, `.tutorial-run-${iso}`);
  let suffix = 1;
  while (existsSync(candidate)) candidate = join(outputDir, `.tutorial-run-${iso}-${suffix++}`);
  mkdirSync(candidate);
  return candidate;
}

function existingPublishedFiles(outputDir) {
  if (!existsSync(outputDir)) return [];
  const fixed = ['recording.mp4', 'recording-cursor.mp4', 'stamp-proof.mp4', 'motion-control.jpg', 'events.json'];
  const stills = readdirSync(outputDir).filter((name) => /^stills-.*\.jpg$/i.test(name)).sort();
  return [...fixed.filter((name) => existsSync(join(outputDir, name))), ...stills];
}

function publishArtifacts({ outputDir, tempDir, stills, overwrite, rename, cursorVideo = false, proofVideo = false }) {
  const old = existingPublishedFiles(outputDir);
  const moved = [];
  try {
    if (old.length > 0) {
      if (!overwrite) fail(2, 'configuration-error', `recording.mp4/events.json already exist in ${outputDir}; pass --overwrite to replace the set`);
      const replaced = join(tempDir, 'replaced');
      mkdirSync(replaced);
      // Remove the completion marker first: even an interrupted replacement cannot masquerade as
      // a complete set while the remaining old files are being moved aside.
      const asideOrder = [...old].sort((a, b) => (a === 'events.json' ? -1 : b === 'events.json' ? 1 : a.localeCompare(b)));
      for (const name of asideOrder) rename(join(outputDir, name), join(replaced, name));
    }
    const order = ['recording.mp4', ...(cursorVideo ? ['recording-cursor.mp4'] : []), ...(proofVideo ? ['stamp-proof.mp4'] : []), 'motion-control.jpg', ...stills.map((item) => item.file), 'events.json'];
    for (const name of order) {
      rename(join(tempDir, name), join(outputDir, name));
      moved.push(name);
    }
    return moved;
  } catch (error) {
    if (error instanceof TutorialRunError) throw error;
    fail(1, 'publish-incomplete', `publication stopped after [${moved.join(', ')}]; temp folder: ${tempDir}; ${errorText(error)}`, { tempDir, moved });
  }
}

function writeRunLog(tempDir, summary) {
  writeFileSync(join(tempDir, 'run.log'), `${JSON.stringify(summary, null, 2)}\n`);
}

function preserveFailureArtifacts({ tempDir, mp4, events, summary }) {
  if (!tempDir) return;
  try {
    if (mp4 && existsSync(mp4)) renameSync(mp4, join(tempDir, 'recording-failed.mp4'));
  } catch { /* keep whichever diagnostic name survived */ }
  try {
    if (events) writeFileSync(join(tempDir, 'events-failed.json'), `${JSON.stringify(events, null, 2)}\n`);
  } catch { /* the primary error remains the useful result */ }
  try { writeRunLog(tempDir, summary); } catch { /* the primary error remains the useful result */ }
}

/**
 * Records one storyboard. The second parameter is the complete test seam; the CLI never passes it.
 *
 * `deps` (tests only): `buildTrace`, `probeFrames`, `rename` (J3/J4) and `overlayStacking`
 * (`{ rootZIndex, stampZIndex }`, Defekt D: the marker-over-stamp counter-case reproduces the
 * spike's stacking without a production switch).
 *
 * `opts.signal` (an AbortSignal) ends a run from outside: the browser, ffmpeg and the server are
 * torn down at once — each step within `TEARDOWN_BUDGET_MS` — so the pending page operation
 * rejects and the run ends with Exit 1 `aborted` instead of hanging. The tests pass node:test's
 * `t.signal`, `main()` an AbortController wired to SIGINT/SIGTERM.
 */
export async function runTutorial(opts, deps = {}) {
  const buildTrace = deps.buildTrace ?? productionBuildTrace;
  const probeFrames = deps.probeFrames ?? ((mp4) => probeFramesProduction(encoders.ffprobe, mp4));
  const rename = deps.rename ?? renameSync;
  const overlayStacking = deps.overlayStacking ?? null;
  const fps = DEFAULT_FPS;
  const gpuCheck = opts.gpuCheck ?? 'require';
  const motionCheck = opts.motionCheck ?? 'require';
  const epochZeroDiagnosis = opts.epochZeroDiagnosis === true;
  let server = null;
  let browser = null;
  let profileCopy = null;
  let runSucceeded = false;
  let encoder = null;
  let encoderFinished = false;
  let encoder2 = null;
  let encoder2Finished = false;
  let mp4Cursor = null;
  let proofEncoder = null;
  let proofEncoderFinished = false;
  let mp4Proof = null;
  let stampMode = 'inline';
  let tempDir = null;
  let mp4 = null;
  let events = null;
  let encoders;
  let outputDir;
  let capture;
  let trace = null;
  let script = null;
  let preflight = null;
  let motionMadSequence = null;
  // Set once `preserveFailureArtifacts` has written the COMPLETE diagnostic set (the epoch-zero
  // diagnosis path). The outer catch then must not write `events-failed.json` a second time: its
  // reconstruction carries no `motion` and used to overwrite the better file.
  let failureArtifactsPreserved = false;
  const summary = {
    status: 'failed', gpuCheck, motionCheck, virtualClockPreflight: null,
  };

  // `aborted` is the FACT, `abortReason` only the text — an empty reason must not disable the checks.
  let aborted = false;
  let abortReason = '';
  const signal = opts.signal ?? null;
  const onAbort = () => {
    aborted = true;
    const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? '');
    abortReason = reason || 'aborted';
    // Tear the run down from outside: closing the browser rejects whatever page operation the run
    // is awaiting, killing ffmpeg releases a blocked frame write and a pending finish, killing the
    // decoder/probe children ends a post-take stage. All bounded, never awaited here.
    if (browser) void withBudget(browser.close(), TEARDOWN_BUDGET_MS);
    if (encoder && !encoderFinished) void withBudget(encoder.abort(), TEARDOWN_BUDGET_MS);
    if (encoder2 && !encoder2Finished) void withBudget(encoder2.abort(), TEARDOWN_BUDGET_MS);
    if (proofEncoder && !proofEncoderFinished) void withBudget(proofEncoder.abort(), TEARDOWN_BUDGET_MS);
    killActiveChildren();
  };
  // Called after every asynchronous stage that a teardown cannot interrupt by itself, and right
  // before publication: an aborted run never publishes.
  const checkAborted = () => { if (aborted) fail(1, 'aborted', `run aborted: ${abortReason}`); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    checkAborted();
    if (!opts.script) fail(2, 'usage', `--script is required\n\n${SYNOPSIS}`);
    const scriptPath = resolve(process.cwd(), opts.script);
    try { script = parseTutorial(JSON.parse(readFileSync(scriptPath, 'utf8'))); }
    catch (error) { fail(2, 'configuration-error', `cannot load storyboard ${scriptPath}: ${errorText(error)}`); }
    summary.connect = script.connect;
    // plan-2043: `--stamp` wins over the storyboard. 'proof' = pristine recording.mp4 + stamp-proof.mp4.
    stampMode = opts.stamp ?? script.stamp ?? 'proof';
    if (!['proof', 'inline'].includes(stampMode)) fail(2, 'configuration-error', `stamp must be proof or inline, got ${stampMode}`);
    summary.stamp = stampMode;
    if (script.connect === 'live' && !opts.base) {
      fail(2, 'connect-live-needs-base', "storyboard connect 'live' requires --base because CONNECT must serve the page so the origin and /webviewer channel match");
    }

    outputDir = checkedOutputDir(opts.dir ?? join(REPO_ROOT, '.tutorial-out', script.id));
    const already = ['recording.mp4', 'events.json'].filter((name) => existsSync(join(outputDir, name)));
    if (already.length > 0 && !opts.overwrite) {
      fail(2, 'configuration-error', `${already.join(' and ')} already exist in ${outputDir}; pass --overwrite before recording`);
    }
    if (motionCheck === 'off' && gpuCheck !== 'off') {
      fail(2, 'motion-check-off-with-viewer', '--motion-check off is accepted only with --gpu-check off and a page without a WebGL canvas');
    }
    if (epochZeroDiagnosis && gpuCheck === 'off') {
      fail(2, 'epoch-zero-diagnosis-needs-viewer', '--epoch-zero-diagnosis requires a viewer; --gpu-check off declares the canvas-less fixture path');
    }

    const dist = resolve(process.cwd(), opts.dist ?? join(REPO_ROOT, 'dist'));
    if (!opts.base) validateDist(dist);
    try { encoders = resolveEncoders({ ffmpeg: opts.ffmpeg, ffprobe: opts.ffprobe, repoRoot: REPO_ROOT }); }
    catch (error) { fail(2, 'configuration-error', errorText(error)); }
    const budget = frameBudget(script, fps);
    summary.dist = distInfo(dist);
    summary.frameBudget = budget;

    let base;
    if (opts.base) base = new URL(opts.base).href.replace(/\/$/, '');
    else {
      const owned = await startStaticServer(dist, opts.port);
      server = owned.server;
      base = owned.base;
      summary.port = owned.port;
    }
    await waitForServer(base);

    tempDir = uniqueTempDir(outputDir);
    mp4 = join(tempDir, 'recording.mp4');

    let context;
    if (opts.profile) {
      // A prepared profile (`--prepare-profile`) carries what a fresh one cannot get headless: a
      // folder picked in the OS dialog and its "allow on every visit" grant. Each take runs on a
      // COPY, so consent, AI control and panel geometry still start from zero every time.
      // OUTSIDE the repo: the temp folder lives under .tutorial-out, and a Vite dev server
      // watching the repo crashes with EBUSY on Chrome's locked profile files.
      profileCopy = join(tmpdir(), `rv-tutorial-profile-${process.pid}-${Date.now()}`);
      cpSync(resolve(opts.profile), profileCopy, { recursive: true });
      context = await chromium.launchPersistentContext(profileCopy, {
        channel: 'chrome', headless: true, args: [...GPU_ARGS],
        viewport: script.viewport, deviceScaleFactor: 1,
      });
      browser = context;
    } else {
      browser = await chromium.launch({
        channel: 'chrome', headless: true, args: [...GPU_ARGS],
      });
      checkAborted();
      context = await browser.newContext({ viewport: script.viewport, deviceScaleFactor: 1 });
    }
    checkAborted();
    await context.addInitScript(pagePreparationInitScript, { welcome: script.welcome });
    await context.addInitScript(virtualClockInitScript, { forceEpochZero: epochZeroDiagnosis });
    const page = await context.newPage();
    // Browser errors next to the take (`<id>.console.log`, outside the published set): a crash in
    // the viewer ("The interface crashed") is otherwise only visible in a console nobody can read.
    const consoleLog = `${outputDir}.console.log`;
    try { writeFileSync(consoleLog, ''); } catch { /* best effort */ }
    const logBrowser = (line) => {
      try { appendFileSync(consoleLog, `${new Date().toISOString()} ${line}\n`); } catch { /* best effort */ }
    };
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') logBrowser(`[${message.type()}] ${message.text()}`);
    });
    page.on('pageerror', (error) => logBrowser(`[pageerror] ${error.stack ?? error.message}`));
    const targetUrl = new URL(script.url, `${base}/`);
    targetUrl.searchParams.set('recording', '1');
    if (script.connect === 'off') {
      targetUrl.searchParams.set('consent', 'decline');
      targetUrl.searchParams.set('mcpPort', '1');
    }
    await page.goto(targetUrl.href, { waitUntil: 'domcontentloaded', timeout: 0 });
    await page.locator(script.ready).first().waitFor({ state: 'visible', timeout: 0 });
    await dismissNags(page);

    const gpuRaw = await readGpuRaw(page);
    const gpu = gpuVerdict(gpuRaw, { gpuCheck, motionCheck, epochZeroDiagnosis });
    summary.gpu = gpu;
    if (gpu.verdict === 'error') fail(gpu.exitCode, gpu.diagnosis, gpu.reason);

    const bindings = new Map();
    for (const action of script.setup) await performSetupAction(page, action, bindings);
    await dismissNags(page);

    const pausedStart = script.start === 'paused';
    // An editor take: the simulation stands still by design, so neither the running-sim preflight
    // nor the paused/resume contract applies; the clock-only preflight still does.
    const clockOnlyStart = pausedStart || script.start === 'editor';
    const hasViewer = await page.evaluate(() => Boolean(window.viewer));
    if (pausedStart && hasViewer && !await page.evaluate(() => window.viewer?.isSimulationPaused === true)) {
      fail(1, 'setup-not-paused', 'start: paused requires setup to leave the viewer paused');
    }
    const epoch = await page.evaluate(() => performance.now());
    const enabled = await page.evaluate(() => window.__vt.enable());
    summary.virtualClockEnable = enabled;
    if (gpu.hasCanvas) {
      // B2 (2026-10-27): bounded warm-up until the first frame with a fixed step (the catch-up
      // burst stays inside it), then the N-frame window. `epoch-preflight.mjs` decides over the
      // complete reading sequence; this loop only steps and reads.
      const warmupMaxFrames = framesOf(PREFLIGHT_WARMUP_SEC, fps);
      const readAfterStep = () => page.evaluate(({ dt, epochValue }) => {
        window.__vt.step(dt);
        return {
          now: performance.now(),
          nowAtLeastEpoch: performance.now() >= epochValue,
          simTime: window.viewer?.simTime ?? null,
          fixedStepCount: window.viewer?.fixedStepCount ?? null,
        };
      }, { dt: 1000 / fps, epochValue: epoch });
      const samples = [await page.evaluate(() => ({
        simTime: window.viewer?.simTime ?? null,
        fixedStepCount: window.viewer?.fixedStepCount ?? null,
      }))];
      if (clockOnlyStart) {
        const clockSamples = [];
        for (let k = 0; k < 3; k++) clockSamples.push(await readAfterStep());
        preflight = clockOnlyVerdict({ samples: clockSamples, epoch: enabled.epoch });
      } else {
        while (warmupEndIndex(samples, warmupMaxFrames) === null) samples.push(await readAfterStep());
        if (warmupEndIndex(samples, warmupMaxFrames) > 0) {
          for (let k = 0; k < PREFLIGHT_WINDOW_FRAMES; k++) samples.push(await readAfterStep());
        }
        preflight = preflightVerdict({ samples, fps, warmupMaxFrames, epoch: enabled.epoch });
      }
      summary.virtualClockPreflight = preflight;
      if (preflight.verdict !== 'ok' && !epochZeroDiagnosis) {
        fail(1, 'virtual-clock-epoch', `virtual clock preflight failed: ${preflight.reason}`);
      }
    } else {
      preflight = 'skipped-no-viewer';
      summary.virtualClockPreflight = preflight;
    }

    await page.evaluate(() => window.__vt.beginCapture());
    await page.evaluate(installTutorialOverlay, {
      stamp: STAMP, stampMode, markerRgb: MARKER_RGB, ...(overlayStacking ? { stacking: overlayStacking } : {}),
    });
    // Guard (plan-2043): no grab may resize the page. On viewer pages the renderer's drawing-buffer
    // resizes during the take are counted (summary.rendererSetSize, expected 0) — the symptom the
    // rejected captureBeyondViewport band produced (a transient 1x1 window, panels moved).
    if (hasViewer) {
      await page.evaluate(() => {
        const renderer = window.viewer?.renderer;
        if (!renderer || typeof renderer.setSize !== 'function' || renderer.__rvTutorialSetSizeCount) return;
        const original = renderer.setSize;
        const counter = { calls: 0 };
        renderer.__rvTutorialSetSizeCount = counter;
        renderer.setSize = function countedSetSize(...args) { counter.calls++; return original.apply(this, args); };
      });
    }
    const cdp = await context.newCDPSession(page);
    encoder = createEncoder({ ffmpeg: encoders.ffmpeg, fps, out: mp4 });
    if (opts.burnCursor === true) {
      mp4Cursor = join(tempDir, 'recording-cursor.mp4');
      encoder2 = createEncoder({ ffmpeg: encoders.ffmpeg, fps, out: mp4Cursor });
    }
    if (stampMode === 'proof') {
      mp4Proof = join(tempDir, 'stamp-proof.mp4');
      proofEncoder = createEncoder({ ffmpeg: encoders.ffmpeg, fps, out: mp4Proof });
    }
    trace = { pointer: [], buttons: [], keys: [], segments: [], steps: [], waitForActualFrames: [] };
    capture = createCaptureState({ page, cdp, encoder, encoder2, proofEncoder, fps, trace });
    const takeStartedMs = Date.now();

    if (epochZeroDiagnosis) {
      for (let i = 0; i < PREFLIGHT_WINDOW_FRAMES; i++) await capture.capture();
      trace.segments.push({ kind: 'marker', start: 0, end: capture.frame, stepId: null });
    } else {
      const markerFrames = framesOf(MARKER_SEC, fps);
      const leadFrames = framesOf(MARKER_LEAD_SEC, fps);
      for (let i = 0; i < leadFrames; i++) await capture.capture();
      const startOnsetExpected = capture.frame;
      await page.evaluate(() => window.__tutorialOverlay.marker(true));
      for (let i = 0; i < markerFrames; i++) await capture.capture();
      await page.evaluate(() => window.__tutorialOverlay.marker(false));
      trace.segments.push({ kind: 'marker', start: 0, end: capture.frame, stepId: null });

      for (const step of script.steps) {
        const stepStart = capture.frame;
        const record = { id: step.id, start: stepStart, end: stepStart, holdSec: step.holdSec, outcome: 'ok' };
        trace.steps.push(record);
        try {
          for (let actionIndex = 0; actionIndex < step.actions.length; actionIndex++) {
            await runRecordedAction({ capture, trace, fps, page, cdp, bindings }, step.actions[actionIndex], step, actionIndex);
          }
          const declaredEnd = frameAtStart(frameToSec(stepStart, fps), fps)
            + Math.max(framesOf(script.minStepSec, fps), framesOf(step.holdSec, fps) + framesOf(step.tailSec, fps));
          if (capture.frame < declaredEnd) {
            const holdStart = capture.frame;
            while (capture.frame < declaredEnd) await capture.capture();
            trace.segments.push({ kind: 'hold', start: holdStart, end: capture.frame, stepId: step.id });
          }
          record.end = capture.frame;
        } catch (error) {
          record.outcome = 'error';
          record.error = errorText(error);
          record.end = capture.frame;
          if (error instanceof TutorialRunError) throw error;
          fail(1, 'step-error', `step '${step.id}' failed: ${record.error}`);
        }
      }

      const endOnsetExpected = capture.frame;
      await page.evaluate(() => window.__tutorialOverlay.marker(true));
      for (let i = 0; i < markerFrames; i++) await capture.capture();
      await page.evaluate(() => window.__tutorialOverlay.marker(false));
      const tailFrames = framesOf(MARKER_TAIL_SEC, fps);
      for (let i = 0; i < tailFrames; i++) await capture.capture();
      trace.segments.push({ kind: 'marker', start: endOnsetExpected, end: capture.frame, stepId: null });
      trace.markerExpected = { start: startOnsetExpected, end: endOnsetExpected };
    }

    if (pausedStart && hasViewer) {
      const timings = capture.timings;
      const resumed = timings.findIndex((timing, index) => index > 0
        && timing.paused === false && timings[index - 1].paused === true);
      if (resumed < 0) fail(1, 'paused-never-started', 'the viewer never resumed during capture');
      const desRun = timings[resumed].des === true;
      const samples = timings.slice(resumed - 1, resumed + (desRun ? timings.length - resumed : Math.min(10, timings.length - resumed)));
      const progress = simProgressVerdict({ samples, fps, factor: timings[resumed].factor, windowFrames: samples.length - 1 });
      summary.simProgress = progress;
      // Determinism evidence: the per-frame clock series of the whole take goes to the run log.
      summary.clockSeries = timings.map((t, i) => [i, t.simTime, t.renderClock ?? null]);
      console.log(`[rv-tutorial] sim-progress ${progress.verdict} on ${progress.clock}: advanced ${progress.sumSimTime} of ${progress.expectedSimTime} s (+/- ${progress.tolerance})`);
      console.log(`[rv-tutorial] clock-series ${JSON.stringify(summary.clockSeries)}`);
      if (progress.verdict !== 'ok') fail(1, 'sim-progress', progress.reason);
    }

    // Wall time of the take (all grabs incl. the proof grab), for the cost of a stamp mode.
    summary.takeMs = Date.now() - takeStartedMs;
    summary.msPerFrame = capture.frame > 0 ? Math.round((summary.takeMs / capture.frame) * 10) / 10 : null;
    if (hasViewer) {
      summary.rendererSetSize = await page.evaluate(() => window.viewer?.renderer?.__rvTutorialSetSizeCount?.calls ?? null);
      if (summary.rendererSetSize) console.warn(`[rv-tutorial] warning: the viewer's renderer was resized ${summary.rendererSetSize} time(s) during the take`);
    }

    try { await encoder.finish(); encoderFinished = true; }
    catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg encoding failed: ${errorText(error)}`); }
    if (encoder2) {
      try { await encoder2.finish(); encoder2Finished = true; }
      catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg cursor encoding failed: ${errorText(error)}`); }
    }
    if (proofEncoder) {
      try { await proofEncoder.finish(); proofEncoderFinished = true; }
      catch (error) { fail(1, 'ffmpeg-failed', `ffmpeg stamp-proof encoding failed: ${errorText(error)}`); }
    }
    checkAborted();
    // Bounded like every other teardown step: a hanging close must not keep the run alive.
    await withBudget(browser.close(), TEARDOWN_BUDGET_MS);
    browser = null;

    const frames = capture.frame;
    const rawEvents = {
      $schema: 'rv-tutorial-events/1',
      connect: script.connect,
      video: {
        file: 'recording.mp4', fps, width: script.viewport.width, height: script.viewport.height,
        stamp: stampMode, ...(stampMode === 'proof' ? { stampProof: 'stamp-proof.mp4' } : {}),
        duration: frameToSec(frames, fps), frames,
      },
      sync: epochZeroDiagnosis
        ? { method: 'virtual-clock', offsetSec: 0, markers: [
          { which: 'start', onsetFrame: 0, expectedFrame: 0, offsetFrames: 0 },
          { which: 'end', onsetFrame: 0, expectedFrame: 0, offsetFrames: 0 },
        ], driftFrames: 0 }
        : { method: 'virtual-clock', offsetSec: 0, markers: [], driftFrames: 0 },
      pointer: trace.pointer, buttons: trace.buttons, keys: trace.keys,
      segments: trace.segments, steps: trace.steps,
    };
    events = await buildTrace(rawEvents);
    if (!events || typeof events !== 'object') fail(1, 'trace-not-contiguous', 'buildTrace did not return an events object');

    if (!epochZeroDiagnosis) {
      const coverage = traceCoverageVerdict(events.segments, events.pointer, events.video.frames, events.steps);
      events.frameCheck = {
        frames: events.video.frames, probedFrames: 0, stampsContiguous: false,
        traceContiguous: coverage.verdict === 'ok', traceStepBoundsOk: coverage.stepBoundsOk,
        traceFirstStart: coverage.firstStart, traceLastEnd: coverage.lastEnd,
        budget: { ...budget, withinBudget: events.video.frames >= budget.min && events.video.frames <= budget.max },
        waitForActualFrames: trace.waitForActualFrames, verdict: 'fail',
      };
      if (coverage.verdict !== 'ok') {
        fail(1, 'trace-not-contiguous', `trace is not a complete reference: ${coverage.problems.join('; ')}`);
      }

      let probed;
      try { probed = await probeFrames(mp4); }
      catch (error) { fail(1, 'ffmpeg-failed', `ffprobe failed: ${errorText(error)}`); }
      checkAborted();
      const probedFrames = typeof probed === 'number' ? probed : probed.frames;
      events.frameCheck.probedFrames = probedFrames;
      if (mp4Cursor) {
        let probedCursor;
        try { probedCursor = await probeFrames(mp4Cursor); }
        catch (error) { fail(1, 'ffmpeg-failed', `ffprobe failed on recording-cursor.mp4: ${errorText(error)}`); }
        const cursorFrames = typeof probedCursor === 'number' ? probedCursor : probedCursor.frames;
        summary.cursorFrames = cursorFrames;
        if (cursorFrames !== probedFrames) {
          fail(1, 'burn-cursor-frame-mismatch', `recording-cursor.mp4 has ${cursorFrames} frames, recording.mp4 has ${probedFrames}`);
        }
      }

      // plan-2043: in proof mode the stamps are read from the proof track, whose decoded frame count
      // must equal the recording's — one proof frame per video frame, both equal to the trace.
      let proofFrames = null;
      if (mp4Proof) {
        let probedProof;
        try { probedProof = await probeFrames(mp4Proof); }
        catch (error) { fail(1, 'ffmpeg-failed', `ffprobe failed on stamp-proof.mp4: ${errorText(error)}`); }
        proofFrames = typeof probedProof === 'number' ? probedProof : probedProof.frames;
        events.frameCheck.proofFrames = proofFrames;
      }
      let stampRead;
      try { stampRead = await readStamps({ ffmpeg: encoders.ffmpeg, mp4: mp4Proof ?? mp4 }); }
      catch (error) { fail(1, 'ffmpeg-failed', `frame-stamp decode failed: ${errorText(error)}`); }
      checkAborted();
      const stampSequence = stampsContiguous(stampRead.stamps);
      const stampsCoverWholeRun = stampRead.stamps.length === events.video.frames && stampSequence.contiguous
        && (proofFrames === null || proofFrames === probedFrames);
      events.frameCheck.stampsContiguous = stampsCoverWholeRun;
      const countDecision = frameCountVerdict(events.video.frames, probedFrames, stampsCoverWholeRun, true);
      events.frameCheck.verdict = countDecision.verdict;
      if (countDecision.verdict !== 'ok') {
        fail(1, countDecision.diagnosis, `Gate A failed: trace=${events.video.frames}, ffprobe=${probedFrames}${proofFrames === null ? '' : `, proof=${proofFrames}`}, stamps=${stampRead.stamps.length}, contiguous=${stampSequence.contiguous}; ${stampSequence.reason ?? ''}`);
      }

      let markerFlags;
      try { markerFlags = await readMarkerFrames({ ffmpeg: encoders.ffmpeg, mp4 }); }
      catch (error) { fail(1, 'ffmpeg-failed', `marker decode failed: ${errorText(error)}`); }
      checkAborted();
      const onsets = markerOnsets(markerFlags);
      const sync = syncVerdict(
        { onsetFrame: onsets.start ?? -1, expectedFrame: trace.markerExpected.start },
        { onsetFrame: onsets.end ?? -1, expectedFrame: trace.markerExpected.end },
      );
      events.sync = { method: 'virtual-clock', offsetSec: 0, markers: sync.markers, driftFrames: sync.driftFrames };
      if (sync.verdict !== 'ok') fail(1, 'marker-mismatch', `Gate B failed: ${JSON.stringify(events.sync)}`);
    }

    const region = script.motionRegion ?? DEFAULT_MOTION_REGION;
    const controlFrame = Math.floor((events.video.frames - 1) / 2);
    const controlPath = join(tempDir, 'motion-control.jpg');
    try { await extractFrame({ ffmpeg: encoders.ffmpeg, mp4, frame: controlFrame, out: controlPath }); }
    catch (error) { fail(1, 'ffmpeg-failed', `control frame extraction failed: ${errorText(error)}`); }

    if (motionCheck === 'off') {
      events.motion = {
        ...motionDeclaration(region), verdict: 'skipped-no-viewer', reason: 'motion-check-off-no-canvas',
      };
    } else {
      let measured;
      try { measured = await measureMotion({ ffmpeg: encoders.ffmpeg, mp4, region }); }
      catch (error) { fail(1, 'ffmpeg-failed', `motion decode failed: ${errorText(error)}`); }
      checkAborted();
      const motion = motionVerdict(measured.diffs, STILL_THRESHOLD, MIN_MOVED_FRACTION);
      let control;
      try {
        const thumbnail = await thumbnailOf({ ffmpeg: encoders.ffmpeg, image: controlPath, region });
        control = controlFrameVerdict(thumbnail, STILL_THRESHOLD);
      } catch (error) { fail(1, 'ffmpeg-failed', `control frame decode failed: ${errorText(error)}`); }
      events.motion = {
        ...motionDeclaration(region), verdict: motion.verdict, frames: measured.frames,
        movedFrames: motion.movedFrames, movedFraction: motion.movedFraction,
        longestStillFrames: motion.longestStillFrames, controlFrame: 'motion-control.jpg',
        controlMad: control.controlMad,
      };
      if (epochZeroDiagnosis) motionMadSequence = measured.diffs;
      if (!epochZeroDiagnosis && control.verdict !== 'ok') fail(1, 'decoder-blank', `decoder control frame is black (mad ${control.controlMad})`);
      if (!epochZeroDiagnosis && motion.verdict !== 'ok') {
        const text = `Gate C: movedFraction ${motion.movedFraction} < ${MIN_MOVED_FRACTION}`;
        if (motionCheck === 'warn') console.error(`[rv-tutorial] warning: ${text} (accepted, --motion-check warn)`);
        else fail(1, 'motion-below-threshold', `${text.replace('Gate C:', 'Gate C failed:')}`);
      }
    }
    const motionShape = motionShapeVerdict(events.motion);
    if (motionShape.verdict !== 'ok') fail(1, 'step-error', `events.motion has the wrong shape: ${motionShape.problems.join('; ')}`);

    if (epochZeroDiagnosis) {
      summary.motion = events.motion;
      summary.motionMadSequence = motionMadSequence;
      summary.frames = events.video.frames;
      summary.status = 'diagnosis-complete';
      // The diagnosis set is complete HERE (events WITH motion). Publication is structurally
      // unreachable — `fail()` throws before step 6b —, so nothing needs nulling to prevent it; the
      // flag only stops the outer catch from rewriting `events-failed.json` with its motion-free
      // reconstruction (the defect found 2026-10-27). `run.log` is still rewritten there, which
      // keeps the final status and diagnosis.
      preserveFailureArtifacts({ tempDir, mp4, events, summary });
      failureArtifactsPreserved = true;
      mp4 = null;
      fail(1, 'virtual-clock-epoch', `forced epoch-zero diagnosis completed; nothing published; temp folder: ${tempDir}`, { tempDir });
    }

    if (events.steps.some((step) => step.outcome !== 'ok')) {
      fail(1, 'step-error', 'publication refused because at least one trace step has outcome other than ok');
    }

    const stills = buildStillSelection(events, script);
    try {
      for (const still of stills) {
        await extractFrame({ ffmpeg: encoders.ffmpeg, mp4, frame: still.frame, out: join(tempDir, still.file) });
      }
    } catch (error) { fail(1, 'ffmpeg-failed', `contact-sheet extraction failed: ${errorText(error)}`); }
    checkAborted();

    writeFileSync(join(tempDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`);
    summary.status = 'gates-green';
    summary.stills = stills.length;
    summary.steps = events.steps.map(({ id, start, end, holdSec }) => ({ id, start, end, holdSec }));
    summary.clicks = events.buttons.filter((event) => event.type === 'down').length;
    summary.cameraFlights = script.steps.flatMap((step) => step.actions).filter((action) => action.type === 'camera').length;
    summary.motion = events.motion;
    summary.frameCheck = events.frameCheck;
    writeRunLog(tempDir, summary);

    checkAborted();
    const moved = publishArtifacts({
      outputDir, tempDir, stills, overwrite: opts.overwrite === true, rename,
      cursorVideo: mp4Cursor !== null, proofVideo: mp4Proof !== null,
    });
    summary.status = 'published';
    summary.published = moved;
    runSucceeded = true;
    writeRunLog(tempDir, summary);
    if (!opts.keepTemp) rmSync(tempDir, { recursive: true, force: false });
    return { exitCode: 0, diagnosis: null, outputDir, tempDir: opts.keepTemp ? tempDir : null, events, summary };
  } catch (caught) {
    let error = caught;
    // An aborted run ends with whatever its pending page operation threw ("Target closed", a
    // killed ffmpeg pipe, …); the useful diagnosis is the abort itself.
    if (aborted && !(error instanceof TutorialRunError && error.diagnosis === 'aborted')) {
      error = new TutorialRunError(1, 'aborted', `run aborted: ${abortReason} (${errorText(error)})`);
    }
    if (encoder && !encoderFinished) {
      if (aborted) {
        await withBudget(encoder.abort(), TEARDOWN_BUDGET_MS);
        encoderFinished = true;
      } else {
        // Finishing keeps the partial take as `recording-failed.mp4` — bounded, and killed when
        // ffmpeg does not end within the budget.
        let finishError = null;
        const outcome = await withBudget(encoder.finish().then(() => { encoderFinished = true; }, (e) => { finishError = e; }), TEARDOWN_BUDGET_MS);
        if (outcome === 'timeout') await withBudget(encoder.abort(), TEARDOWN_BUDGET_MS);
        if (finishError && !(error instanceof TutorialRunError)) {
          error = new TutorialRunError(1, 'ffmpeg-failed', `ffmpeg encoding failed: ${errorText(finishError)}`);
        }
        encoderFinished = true;
      }
    }
    if (encoder2 && !encoder2Finished) { await withBudget(encoder2.abort(), TEARDOWN_BUDGET_MS); encoder2Finished = true; }
    if (proofEncoder && !proofEncoderFinished) { await withBudget(proofEncoder.abort(), TEARDOWN_BUDGET_MS); proofEncoderFinished = true; }
    if (!(error instanceof TutorialRunError)) error = new TutorialRunError(1, 'step-error', errorText(error));
    if (browser) { await withBudget(browser.close(), TEARDOWN_BUDGET_MS); browser = null; }
    summary.status = 'failed';
    summary.diagnosis = error.diagnosis;
    summary.error = error.message;
    if (tempDir && error.diagnosis !== 'publish-incomplete' && !error.message.includes(tempDir)) {
      error.message = `${error.message}; temp folder: ${tempDir}`;
    }
    if (failureArtifactsPreserved) {
      // events-failed.json and recording-failed.mp4 are already complete; only the log changes.
      try { writeRunLog(tempDir, summary); } catch { /* primary error wins */ }
      throw error;
    }
    if (!events && trace && capture && script) {
      const frames = capture.frame;
      events = {
        $schema: 'rv-tutorial-events/1',
        connect: script.connect,
        video: {
          file: 'recording.mp4', fps, width: script.viewport.width, height: script.viewport.height,
          stamp: stampMode, ...(stampMode === 'proof' ? { stampProof: 'stamp-proof.mp4' } : {}),
          duration: frameToSec(frames, fps), frames,
        },
        sync: { method: 'virtual-clock', offsetSec: 0, markers: [], driftFrames: 0 },
        pointer: trace.pointer, buttons: trace.buttons, keys: trace.keys,
        segments: trace.segments, steps: trace.steps,
      };
    }
    if (tempDir && events) preserveFailureArtifacts({ tempDir, mp4, events, summary });
    else if (tempDir) {
      try {
        if (mp4 && existsSync(mp4)) renameSync(mp4, join(tempDir, 'recording-failed.mp4'));
        writeRunLog(tempDir, summary);
      } catch { /* primary error wins */ }
    }
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (encoder && !encoderFinished) await withBudget(encoder.abort(), TEARDOWN_BUDGET_MS);
    if (encoder2 && !encoder2Finished) await withBudget(encoder2.abort(), TEARDOWN_BUDGET_MS);
    if (proofEncoder && !proofEncoderFinished) await withBudget(proofEncoder.abort(), TEARDOWN_BUDGET_MS);
    if (aborted) killActiveChildren();
    if (browser) await withBudget(browser.close(), TEARDOWN_BUDGET_MS);
    await withBudget(closeServer(server), TEARDOWN_BUDGET_MS);
    if (profileCopy) {
      // `--save-profile`: a published take hands its end state (linked projects, folder grants)
      // to the next take, so a chain of takes can restart at any link.
      if (runSucceeded && opts.saveProfile) {
        try {
          rmSync(resolve(opts.saveProfile), { recursive: true, force: true });
          cpSync(profileCopy, resolve(opts.saveProfile), { recursive: true });
        } catch (error) { console.error(`[rv-tutorial] warning: saving the profile failed: ${errorText(error)}`); }
      }
      try { rmSync(profileCopy, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const controller = new AbortController();
  const stop = (name) => () => controller.abort(new Error(`received ${name}`));
  const onInt = stop('SIGINT');
  const onTerm = stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  try {
    const opts = parseArgs(argv);
    if (opts.prepareProfile) return await prepareProfile(opts);
    const result = await runTutorial({ ...opts, signal: controller.signal });
    console.log(`[rv-tutorial] published ${result.events.video.frames} frames to ${result.outputDir}`);
    return 0;
  } catch (error) {
    const exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    const diagnosis = error?.diagnosis ?? 'step-error';
    console.error(`[rv-tutorial] ${diagnosis}: ${errorText(error)}`);
    return exitCode;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

/**
 * `--prepare-profile <dir> --base <url>`: open a VISIBLE Chrome on that profile so a person can do
 * once what a headless take cannot: pick a folder in the OS dialog (e.g. the parent for new
 * projects) and grant "allow on every visit". Returns when the window is closed.
 */
async function prepareProfile(opts) {
  const dir = resolve(opts.prepareProfile);
  mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, { channel: 'chrome', headless: false, viewport: null });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(new URL(opts.base).href, { waitUntil: 'domcontentloaded', timeout: 0 });
  console.log(`[rv-tutorial] profile ${dir} is open - prepare it, then close the browser window`);
  await new Promise((done) => context.on('close', done));
  console.log(`[rv-tutorial] profile ${dir} saved`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
