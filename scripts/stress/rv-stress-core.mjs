// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Stress harness — I/O part: own Vite dev server, headless browser, the
 * command driver, memory and responsiveness probes, console-error capture.
 *
 * Commands go through `runCommandStep` from the MCP bridge module — the exact
 * path `web_execute` / `web_query` take — so a stress finding is a finding on
 * the path agents and the UI use, not on a test-only shortcut.
 *
 * Process hygiene (shared machine, parallel sessions): this module only ever
 * ends processes it started itself — its own Vite child (by pid, tree kill) and
 * its own browser (`browser.close()`). It never looks up processes by name to
 * kill them.
 */

import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killTree } from '../lib/rv-proc.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = resolve(here, '..', '..');

/** Loads playwright from the WebViewer repo's own node_modules. */
export function loadPlaywright(root = WEB_ROOT) {
  const require = createRequire(join(root, 'package.json'));
  return require('playwright');
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Machine / process probes
// ---------------------------------------------------------------------------

const PROBE_PS = [
  "$os = Get-CimInstance Win32_OperatingSystem",
  "$p = Get-CimInstance Win32_Process -Filter \"Name='chrome-headless-shell.exe' OR Name='chrome.exe'\"",
  "@{ free = [double]$os.FreeVirtualMemory; total = [double]$os.TotalVirtualMemorySize;",
  "   procs = @($p | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; priv = [double]$_.PrivatePageCount;",
  "     type = ([regex]::Match([string]$_.CommandLine, '--type=(\\S+)').Groups[1].Value) } }) } | ConvertTo-Json -Compress -Depth 4",
].join('\n');

/**
 * One probe of the machine and of OUR browser's process tree.
 * `browserPid` is the browser process Playwright launched as a direct child of
 * this node process (found once by `findOwnBrowserPid`).
 * Windows only for the per-process numbers; elsewhere they are null.
 */
export function machineProbe(browserPid = null) {
  if (process.platform !== 'win32') return { freeCommitGB: null, totalCommitGB: null, rendererGB: null, gpuGB: null, browserPid: null, procs: [] };
  let data;
  try {
    data = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE_PS], { windowsHide: true, timeout: 30000 }).toString());
  } catch (e) {
    return { error: String(e).slice(0, 200), freeCommitGB: null, rendererGB: null, gpuGB: null, procs: [] };
  }
  const procs = (Array.isArray(data.procs) ? data.procs : data.procs ? [data.procs] : []).map(p => ({ ...p, type: p.type || 'browser' }));
  const kids = browserPid ? procs.filter(p => p.ppid === browserPid) : [];
  const sum = (t) => kids.filter(k => k.type === t).reduce((a, k) => a + k.priv, 0) / 2 ** 30;
  return {
    freeCommitGB: data.free / 2 ** 20,
    totalCommitGB: data.total / 2 ** 20,
    rendererGB: browserPid ? sum('renderer') : null,
    gpuGB: browserPid ? sum('gpu-process') : null,
    browserPid,
    procs,
  };
}

/** The browser process that is a direct child of this node process (Playwright launch). */
export function findOwnBrowserPid() {
  const m = machineProbe(null);
  const own = m.procs.filter(p => p.type === 'browser' && p.ppid === process.pid);
  return own.length === 1 ? own[0].pid : own.length ? own[own.length - 1].pid : null;
}

// ---------------------------------------------------------------------------
// Own Vite dev server
// ---------------------------------------------------------------------------

/**
 * Vite servers already running out of `root` (read-only process listing).
 * Commercial and community dev servers of the SAME checkout share
 * `node_modules/.vite` and corrupt each other's optimizer cache, so the runner
 * refuses to start a second one next to them. Never used to kill anything.
 */
export function viteServersOf(root = WEB_ROOT) {
  if (process.platform !== 'win32') return [];
  try {
    const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'vite' } | ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }).toString();
    const norm = (x) => x.replace(/\\/g, '/').toLowerCase();
    const r = norm(root);
    return out.split(/\r?\n/).filter(Boolean)
      .map(l => { const i = l.indexOf('|'); return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) }; })
      .filter(p => norm(p.cmd).includes(r + '/node_modules'));
  } catch { return []; }
}

/** First free TCP port in [from, to] on 127.0.0.1. */
export async function findFreePort(from = 5300, to = 5399) {
  for (let port = from; port <= to; port++) {
    const free = await new Promise(res => {
      const srv = createServer();
      srv.once('error', () => res(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
    });
    if (free) return port;
  }
  throw new Error(`no free port in ${from}-${to}`);
}

/**
 * Starts the WebViewer dev server of `root` on `port` (strict), with the
 * browser-open switch forced off. Resolves once the server answers HTTP.
 * Returns `{ base, pid, stop() }` — `stop()` tree-kills only this child.
 */
export async function startVite({ root = WEB_ROOT, port, env = {}, log = () => {}, timeoutMs = 180000 }) {
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    env: { ...process.env, ...env, RV_VITE_OPEN: '0', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const tail = [];
  const keep = (b) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) { tail.push(l); if (tail.length > 40) tail.shift(); } };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (exited !== null) throw new Error(`vite exited (${exited}) before serving:\n${tail.join('\n')}`);
    try {
      const r = await fetch(base + '/', { signal: AbortSignal.timeout(5000) });
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) { killTree(child.pid); throw new Error(`vite did not serve within ${timeoutMs} ms:\n${tail.join('\n')}`); }
    await sleep(1000);
  }
  log(`vite up on ${base} (pid ${child.pid}) after ${Date.now() - t0} ms`);
  return {
    base,
    pid: child.pid,
    tail,
    stop() { if (exited === null) killTree(child.pid); },
  };
}

// ---------------------------------------------------------------------------
// Browser + viewer
// ---------------------------------------------------------------------------

/**
 * Launches headless Chromium (SwiftShader, gc exposed), opens the viewer at
 * `base/?<query>`, dismisses the first-run dialogs, waits for the scene and for
 * the scenario's own readiness predicate, and installs the command module.
 *
 * Error capture starts BEFORE navigation: console errors, uncaught exceptions
 * and renderer crashes land in `errors` with a timestamp.
 */
export async function openViewer({ base, query = {}, headed = false, ready = null, commands = [], log = () => {}, viewport = { width: 1600, height: 1000 } }) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({
    headless: !headed,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--js-flags=--expose-gc'],
  });
  const browserPid = findOwnBrowserPid();
  const page = await browser.newPage({ viewport });
  const errors = [];
  const t0 = Date.now();
  const at = () => new Date().toISOString();
  page.on('pageerror', e => errors.push({ kind: 'pageerror', text: String(e?.stack ?? e).slice(0, 1200), at: at() }));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (text.startsWith('Failed to load resource')) return; // 404 favicon & co.; network failures surface elsewhere
    errors.push({ kind: 'console', text: text.slice(0, 1200), at: at() });
  });
  page.on('crash', () => errors.push({ kind: 'crash', text: 'page crashed (renderer process gone)', at: at() }));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');

  // Keep the run off every other local service: the viewer falls back to a CONNECT gateway on
  // localhost:5100 on its own, and a stress run must never reach a gateway another session uses.
  const ownPort = new URL(base).port;
  const isForeignLoopback = (u) => {
    try {
      const { hostname, port } = new URL(u);
      return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname) && port !== ownPort;
    } catch { return false; }
  };
  let blocked = 0;
  await page.context().route(u => isForeignLoopback(u.href), route => { blocked++; return route.abort(); });
  await page.context().routeWebSocket(u => isForeignLoopback(u.href), ws => { blocked++; return ws.close(); });
  page.on('close', () => log(`foreign loopback requests blocked: ${blocked}`));

  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();
  const url = `${base}/${qs ? '?' + qs : ''}`;
  log(`open ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await dismissFirstRunDialogs(page);
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => window.viewer.whenSceneReady?.());
  if (ready) await page.waitForFunction(ready, null, { timeout: 240000, polling: 1000 });
  const missingCommands = await waitForCommands(page, commands);
  if (missingCommands.length) log(`commands not registered after 180 s: ${missingCommands.join(', ')}`);
  await sleep(3000);
  await dismissFirstRunDialogs(page, 2000);
  await page.evaluate(async () => {
    window.__rvStressCmd = await import('/src/plugins/mcp-bridge/rv-mcp-command-tools.ts');
  });
  log(`viewer ready after ${Date.now() - t0} ms (browser pid ${browserPid ?? 'n/a'})`);
  return { browser, page, cdp, errors, url, browserPid, missingCommands };
}

/**
 * Waits until every command id is registered. Feature commands (e.g. the DES
 * experiment manager) register when their feature activates, seconds after the
 * scene is ready; driving them earlier yields `unknown` / `commercial-feature`
 * refusals that look like product findings but are harness timing (seen in the
 * first proof run of this harness). Returns the ids still missing.
 */
export async function waitForCommands(page, ids, timeoutMs = 180000) {
  if (!ids?.length) return [];
  try {
    await page.waitForFunction(async (want) => {
      const m = await import('/src/core/hmi/rv-command-registry.ts');
      return want.every(id => !!m.commandRegistry.get(id));
    }, ids, { timeout: timeoutMs, polling: 1000 });
    return [];
  } catch {
    return page.evaluate(async (want) => {
      const m = await import('/src/core/hmi/rv-command-registry.ts');
      return want.filter(id => !m.commandRegistry.get(id));
    }, ids).catch(() => ids);
  }
}

/**
 * Reloads the page in place (same browser) and waits for the viewer again —
 * for "first run after page load" checks and per-session leak isolation.
 * Errors keep flowing into the listeners installed by `openViewer`.
 */
export async function reloadViewer(page, { ready = null, commands = [], log = () => {} } = {}) {
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 180000 });
  await dismissFirstRunDialogs(page, 10000);
  await page.waitForFunction(() => !!window.viewer, null, { timeout: 240000, polling: 500 });
  await page.evaluate(() => window.viewer.whenSceneReady?.());
  if (ready) await page.waitForFunction(ready, null, { timeout: 240000, polling: 1000 });
  const missing = await waitForCommands(page, commands);
  await page.evaluate(async () => { window.__rvStressCmd = await import('/src/plugins/mcp-bridge/rv-mcp-command-tools.ts'); });
  log(`reloaded in ${Date.now() - t0} ms${missing.length ? `, commands still missing: ${missing.join(', ')}` : ''}`);
  return missing;
}

async function dismissFirstRunDialogs(page, waitMs = 20000) {
  const accept = page.getByRole('button', { name: 'Accept & continue' });
  try { await accept.waitFor({ state: 'visible', timeout: waitMs }); await accept.click(); } catch { /* none */ }
  const q = page.locator('[aria-labelledby="rv-auto-quality-title"] button', { hasText: 'OK' });
  try { if (await q.count()) await q.first().click({ timeout: 2000 }); } catch { /* none */ }
}

/**
 * The command driver: `web_execute` / `web_query` equivalent. Returns
 * `{ ok, value }` or `{ ok:false, kind, reason, detail }`, always with `ms`.
 * A command that does not answer within `timeoutMs` resolves as
 * `kind: 'HARNESS-TIMEOUT'` — a HANG candidate, which the caller must report.
 *
 * Command values of the shape `{ ok:false, error }` (a command that "succeeds"
 * with a refusal payload) are normalised to a failure, so scenarios see one form.
 */
export function makeCommandDriver(page, { log = () => {}, defaultTimeoutMs = 600000 } = {}) {
  async function cmd(id, args = {}, timeoutMs = defaultTimeoutMs) {
    const t0 = Date.now();
    let timer;
    const r = await Promise.race([
      page.evaluate(async ({ id, args }) => {
        const o = await window.__rvStressCmd.runCommandStep({ command: id, args, viewer: window.viewer, record: false });
        const res = o.result;
        return JSON.parse(JSON.stringify(res.ok ? { ok: true, value: res.value } : { ok: false, kind: res.kind, reason: res.reason, detail: res.detail }));
      }, { id, args }).catch(e => ({ ok: false, kind: 'EVALUATE-FAILED', reason: String(e).slice(0, 400) })),
      new Promise(res => { timer = setTimeout(() => res({ ok: false, kind: 'HARNESS-TIMEOUT', reason: `no answer after ${timeoutMs} ms` }), timeoutMs); timer.unref?.(); }),
    ]);
    clearTimeout(timer);
    if (r.ok && r.value && typeof r.value === 'object' && r.value.ok === false) {
      return { ok: false, kind: 'REFUSED', reason: r.value.error ?? r.value.detail ?? JSON.stringify(r.value).slice(0, 400), value: r.value, ms: Date.now() - t0 };
    }
    // Some commands answer a refusal as a successful value `{ error, ... }` (seen: des.setMode).
    // Normalised to a failure with its own kind, so callers see a refusal and the
    // inconsistency stays visible in the report.
    if (r.ok && r.value && typeof r.value === 'object' && typeof r.value.error === 'string' && r.value.ok === undefined) {
      return { ok: false, kind: 'REFUSED-IN-VALUE', reason: r.value.error, value: r.value, ms: Date.now() - t0 };
    }
    r.ms = Date.now() - t0;
    return r;
  }
  /** Like `cmd`, but logs a failure. Use where a refusal is unexpected. */
  async function must(id, args = {}, timeoutMs) {
    const r = await cmd(id, args, timeoutMs);
    if (!r.ok) log(`CMD FAIL ${id} ${JSON.stringify(args).slice(0, 200)} → ${r.kind}: ${String(r.reason).slice(0, 300)}`);
    return r;
  }
  return { cmd, must };
}

// ---------------------------------------------------------------------------
// In-page probes
// ---------------------------------------------------------------------------

/**
 * Memory inside the renderer: JS heap after a forced gc (needs --expose-gc),
 * embedder heap (Blink/DOM/IndexedDB — tonight's DES leak lived HERE, the JS heap
 * stayed flat), DOM nodes and JS event listeners.
 */
export async function heapProbe(page, cdp) {
  try { await page.evaluate(() => window.gc?.()); } catch { /* page busy */ }
  const out = {};
  try {
    const m = await cdp.send('Performance.getMetrics');
    const get = n => m.metrics.find(x => x.name === n)?.value ?? null;
    out.heapMB = get('JSHeapUsedSize') / 1048576;
    out.heapTotalMB = get('JSHeapTotalSize') / 1048576;
    out.domNodes = get('Nodes');
    out.listeners = get('JSEventListeners');
  } catch (e) { out.heapError = String(e).slice(0, 120); }
  try {
    const h = await cdp.send('Runtime.getHeapUsage');
    if (h.embedderHeapUsedSize !== undefined) out.embedderMB = h.embedderHeapUsedSize / 1048576;
    if (h.backingStorageSize !== undefined) out.backingMB = h.backingStorageSize / 1048576;
  } catch { /* older chromium */ }
  return out;
}

/**
 * Responsiveness: one page.evaluate that resolves on the next animation frame.
 * Measures the main thread's latency as an agent or user would feel it.
 * A blocked main thread caps at `capMs` and is reported as that value.
 */
export async function rttProbe(page, capMs = 30000) {
  const t0 = Date.now();
  let timer;
  await Promise.race([
    page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(1)))).catch(() => {}),
    new Promise(r => { timer = setTimeout(r, capMs); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  return Date.now() - t0;
}
