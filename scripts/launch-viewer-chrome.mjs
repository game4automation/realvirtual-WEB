// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * launch-viewer-chrome — start Chrome on the viewer with background throttling OFF.
 *
 * ## The problem this solves
 *
 * Chrome aggressively throttles a page it believes nobody is looking at. Two
 * separate mechanisms bite an agent-driven MCP session, and they are NOT the
 * same thing:
 *
 *  1. **Timer throttling.** A hidden page's `setTimeout` is clamped to >= 1 s,
 *     and after ~5 minutes hidden, *intensive wake-up throttling* clamps it to
 *     once per MINUTE. Every `sleep()` in the MCP path (choreography beat,
 *     camera settle, the verify_drive glide) then takes a minute instead of
 *     80 ms, so the call blows through the bridge's 15 s timeout and surfaces
 *     as `timed out ... outcome=unknown` — while CONNECT is perfectly healthy
 *     and `/health` answers instantly. Diagnosing that from the outside costs
 *     real time; `web_ping` was added to report it in one call.
 *
 *  2. **Renderer backgrounding / native window occlusion.** On Windows Chrome
 *     detects that its window is *covered* (by the IDE, say) and backgrounds
 *     the renderer — this hits a tab that is the ACTIVE tab of its window, so
 *     it fires in the normal "I am working in the editor while the agent drives
 *     the viewer" case, which is exactly this workflow.
 *
 * The switches below disable both. This is the same set Playwright and
 * Puppeteer pass for the same reason, so it is well-trodden rather than exotic.
 *
 * ## What this does NOT fix
 *
 * A genuinely BACKGROUND TAB (another tab selected in the same window) still
 * gets no `requestAnimationFrame` callbacks — the compositor produces no frames
 * for a tab that is not the visible one, and no flag changes that. Keep the
 * viewer as the active tab of its window; the window itself may then sit behind
 * the IDE freely, which is the case that actually matters.
 *
 * MCP screenshots survive even that, because `captureFrameCanvas()` drives
 * `renderFrameForCapture()` synchronously instead of waiting for the animation
 * loop. Camera *animations* are the part that needs live frames.
 *
 * ## Usage
 *
 *   node scripts/launch-viewer-chrome.mjs
 *   node scripts/launch-viewer-chrome.mjs --url http://localhost:5100/?project=kinematictest
 *   node scripts/launch-viewer-chrome.mjs --profile-dir D:\rv-chrome-profile
 *   node scripts/launch-viewer-chrome.mjs --debug-port 9333   (default 9222)
 *   node scripts/launch-viewer-chrome.mjs --no-debug-port
 *
 * ## Agent mode (`npm run viewer:agent`, plan-564)
 *
 *   node scripts/launch-viewer-chrome.mjs --agent [--doc <id>] [--connect http://127.0.0.1:5100]
 *
 * One command that ends with a visible, CLAIMED, connected viewer tab an agent
 * can drive through CONNECT's `web_*` tools — or exits 1 with a diagnosis:
 *
 *  1. checks `/health.webBridgeStandby` (an older CONNECT is named as such);
 *  2. fetches a single-use claim token from `POST /bridge/claim-token`
 *     (loopback, no browser Origin — a web page cannot get one);
 *  3. starts Chrome with a DEDICATED agent profile and CDP on `about:blank`;
 *  4. registers `Page.addScriptToEvaluateOnNewDocument` that — ONLY on the
 *     viewer's origin — switches the AI Bridge on (`rv-ai-bridge`) and records
 *     the AI-Bridge consent of THIS profile (the version is read from
 *     `ai-consent-store.ts`, the key from `rv-storage-keys.ts`);
 *  5. navigates to `<url>?mcpClaim=<token>&consent=decline[&doc=<id>]`
 *     (`consent=decline` answers the analytics dialog with "no" for the session);
 *  6. waits until the protected `/bridge/status` shows THIS claim as the active
 *     tab with a catalog, and a `POST /bridge/ping` roundtrip reaches the same
 *     claim in the same owner generation. Exit 0 with a status line, or exit 1
 *     after 60 s. A redirect to another origin is an error.
 *
 * The consent seeding is deliberate and limited to the agent's own profile:
 * the operator asks for an agent-driven viewer by running this command.
 *
 * ## Remote control (Chrome DevTools Protocol)
 *
 * The window listens for CDP on 127.0.0.1:<debug-port> (loopback only), so an
 * agent can drive THIS window — the one the user watches — instead of a
 * browser of its own: Playwright MCP started with
 * `--cdp-endpoint http://localhost:9222` attaches to it (clicks, screenshots,
 * reloads, dialogs), and the viewer's own MCP bridge keeps talking to CONNECT
 * as before. `--no-debug-port` launches without it.
 *
 * A dedicated `--user-data-dir` is used by default so these switches do not
 * leak into the everyday browsing profile, and so launching never has to
 * attach to an already-running Chrome (a second `chrome.exe` against the same
 * profile just forwards the URL to the existing process and DROPS the
 * switches, which is the classic reason "I passed the flags and nothing
 * changed").
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_URL = 'http://localhost:5100/';
const DEFAULT_CONNECT = 'http://127.0.0.1:5100';
const DEFAULT_AGENT_TIMEOUT_MS = 60_000;
const VIEWER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Chrome switches that keep a covered/hidden page running at full speed. */
export const ANTI_THROTTLE_SWITCHES = [
  // Timer clamping in hidden pages.
  '--disable-background-timer-throttling',
  // Renderer priority drop when the window is covered by another window.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // ONE --disable-features switch only: Chrome does not merge repeated
  // occurrences, it honours the last one and silently drops the rest.
  //   CalculateNativeWinOcclusion   Windows "my window is covered" detector
  //   IntensiveWakeUpThrottling     the once-per-minute clamp after ~5 min hidden
  //   HighEfficiencyModeAvailable   Memory Saver discarding a long-idle tab
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable',
];

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : null,
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  if (process.env.RV_CHROME && existsSync(process.env.RV_CHROME)) return process.env.RV_CHROME;
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  return null;
}

// ── Pure, testable pieces (tests/launch-viewer-agent.node.test.ts) ──

/**
 * Parse the command line. Returns `{ error }` for an invalid combination
 * instead of exiting, so the rules are testable.
 */
export function parseLauncherArgs(argv) {
  const value = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const agent = argv.includes('--agent');
  const noDebugPort = argv.includes('--no-debug-port');
  if (agent && noDebugPort) {
    return { error: '--agent needs the DevTools port: it seeds the profile and waits through CDP. Drop --no-debug-port.' };
  }
  const debugPort = noDebugPort ? null : value('debug-port', '9222');
  if (debugPort !== null && !/^\d{2,5}$/.test(debugPort)) return { error: `Invalid --debug-port '${debugPort}'.` };
  const timeoutRaw = value('timeout', String(DEFAULT_AGENT_TIMEOUT_MS / 1000));
  const timeoutS = Number(timeoutRaw);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) return { error: `Invalid --timeout '${timeoutRaw}' (seconds).` };
  return {
    agent,
    url: value('url', DEFAULT_URL),
    // The agent gets its OWN profile: its seeded consent must never leak into the
    // everyday viewer profile, and a parallel normal launch must not collide with it.
    profileDir: value('profile-dir', join(tmpdir(), agent ? 'rv-viewer-agent-profile' : 'rv-viewer-chrome-profile')),
    debugPort,
    doc: value('doc', null),
    connect: value('connect', DEFAULT_CONNECT).replace(/\/$/, ''),
    timeoutMs: timeoutS * 1000,
  };
}

/** The viewer URL the agent tab opens: claim token, session decline, optional document. */
export function buildAgentUrl(viewerUrl, token, doc) {
  const url = new URL(viewerUrl);
  url.searchParams.set('mcpClaim', token);
  url.searchParams.set('consent', 'decline');
  if (doc) url.searchParams.set('doc', doc);
  return url.toString();
}

/**
 * Read the AI-Bridge consent contract from the viewer source — the version from
 * `ai-consent-store.ts` and the storage key from `rv-storage-keys.ts` — so the
 * launcher can never seed a stale version or a renamed key.
 */
export function readConsentContract(root = VIEWER_ROOT) {
  const store = readFileSync(join(root, 'src/core/hmi/ai-consent-store.ts'), 'utf8');
  const keys = readFileSync(join(root, 'src/core/hmi/rv-storage-keys.ts'), 'utf8');
  const version = /export const AI_BRIDGE_CONSENT_VERSION\s*=\s*'([^']+)'/.exec(store)?.[1];
  const key = /export const AI_BRIDGE_CONSENT_KEY\s*=\s*'([^']+)'/.exec(keys)?.[1];
  if (!version || !key) throw new Error('AI_BRIDGE_CONSENT_VERSION / AI_BRIDGE_CONSENT_KEY not found in the viewer source.');
  return { version, key };
}

/**
 * The script Chrome runs before ANY page script on every new document. It acts
 * only on the viewer's own origin — localStorage belongs to an origin, and no
 * other site the agent profile may visit is touched.
 */
export function buildInitScript({ origin, bridgePort, consentKey, consentVersion }) {
  const settings = JSON.stringify({ enabled: true, port: String(bridgePort) });
  return `(() => {
  if (location.origin !== ${JSON.stringify(origin)}) return;
  try {
    localStorage.setItem('rv-ai-bridge', ${JSON.stringify(settings)});
    localStorage.setItem(${JSON.stringify(consentKey)}, ${JSON.stringify(consentVersion)});
  } catch (e) { /* storage disabled: the bridge stays off and the launcher reports it */ }
})();`;
}

/** One line about where the claim stands, for progress and the timeout diagnosis. */
export function describeBridgeStatus(status, claimId) {
  if (!status) return 'no bridge status yet';
  const active = status.active;
  if (!active) return `no tab owns the bridge (${status.clients ?? 0} connected)`;
  const who = active.claimId === claimId ? 'OUR claimed tab'
    : active.claimId ? `another claim (${active.claimId})`
      : `an unclaimed tab (visible=${active.visible}, legacy=${active.legacy})`;
  return `owner is ${who}, ${active.tools} tools, generation ${status.generation}, ${status.standby?.length ?? 0} standby`;
}

/**
 * Wait until THIS claim owns the bridge with a non-empty catalog AND a ping
 * roundtrip reached the same claim in the same owner generation. Everything
 * the outside world provides is injected, so the logic runs against fakes.
 *
 * @returns {{ ok: true, status, ping } | { ok: false, reason: 'timeout'|'redirect', diagnosis: string }}
 */
export async function waitForOwnClaim({
  claimId, fetchStatus, ping, checkOrigin, timeoutMs, intervalMs = 250,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onProgress = () => {},
}) {
  const deadline = now() + timeoutMs;
  let diagnosis = 'no bridge status yet';
  let lastLine = '';
  while (now() < deadline) {
    if (checkOrigin) {
      const origin = await checkOrigin().catch(() => null);
      if (origin && origin.ok === false) {
        return { ok: false, reason: 'redirect', diagnosis: `the tab left the viewer origin: ${origin.actual}` };
      }
    }
    let status = null;
    try {
      status = await fetchStatus();
      diagnosis = describeBridgeStatus(status, claimId);
    } catch (e) {
      diagnosis = `bridge status unavailable: ${e?.message ?? e}`;
    }
    if (diagnosis !== lastLine) { onProgress(diagnosis); lastLine = diagnosis; }
    const active = status?.active;
    if (active && active.claimId === claimId && active.tools > 0) {
      try {
        const answer = await ping();
        if (answer?.ok && answer.claimId === claimId && answer.generation === status.generation) {
          return { ok: true, status, ping: answer };
        }
        diagnosis = answer?.ok
          ? `roundtrip reached claim ${answer.claimId} in generation ${answer.generation}, expected ${claimId} in ${status.generation}`
          : `roundtrip failed: ${answer?.error ?? 'no answer'}`;
      } catch (e) {
        diagnosis = `roundtrip failed: ${e?.message ?? e}`;
      }
    }
    await sleep(intervalMs);
  }
  return { ok: false, reason: 'timeout', diagnosis };
}

// ── Side effects: HTTP, Chrome, CDP ──

async function httpJson(method, url, timeoutMs = 5000) {
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: response.status, body, text };
}

/** Minimal CDP client over Node's global WebSocket (Node >= 22). */
async function cdpConnect(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', () => fail(new Error(`CDP connection to ${webSocketUrl} failed`)), { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    const entry = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.fail(new Error(`${msg.error.message} (${entry.method})`));
    else entry.ok(msg.result);
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((ok, fail) => pending.set(id, { ok, fail, method }));
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

async function cdpAnswers(port) {
  try {
    const r = await httpJson('GET', `http://127.0.0.1:${port}/json/version`, 1500);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function waitForPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpJson('GET', `http://127.0.0.1:${port}/json/list`, 1500);
      const page = Array.isArray(r.body) ? r.body.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) : null;
      if (page) return page;
    } catch { /* Chrome still starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

function fail(message) {
  console.error(`viewer:agent — ${message}`);
  process.exit(1);
}

async function runAgent(options, chrome) {
  const started = Date.now();
  const viewerOrigin = new URL(options.url).origin;
  const connectUrl = new URL(options.connect);

  // 1. Capability: an older CONNECT has neither standby nor claims.
  let health;
  try {
    health = await httpJson('GET', `${options.connect}/health`);
  } catch (e) {
    fail(`CONNECT not reachable at ${options.connect} (${e.message}). Start CONNECT first.`);
  }
  if (health.body?.bridgeEnabled === false) fail('The CONNECT MCP server is off (Tray ▸ MCP server ▸ Enabled, then restart CONNECT).');
  if (health.body?.webBridgeStandby !== true) {
    fail('This CONNECT has no agent claim support (/health.webBridgeStandby missing) — update CONNECT to a release with plan-564.');
  }

  // 2. Claim token (loopback, no Origin).
  const claim = await httpJson('POST', `${options.connect}/bridge/claim-token`);
  if (claim.status !== 200 || !claim.body?.token) fail(`No claim token (HTTP ${claim.status}): ${claim.text}`);
  const { token, claimId } = claim.body;

  // 3. Chrome with a dedicated profile on about:blank — refuse to hijack a running one.
  if (await cdpAnswers(options.debugPort)) {
    fail(`DevTools port ${options.debugPort} is already in use — another Chrome (or this agent profile) is running. Close it or pass --debug-port.`);
  }
  if (!existsSync(options.profileDir)) mkdirSync(options.profileDir, { recursive: true });
  const activePortFile = join(options.profileDir, 'DevToolsActivePort');
  if (existsSync(activePortFile)) {
    const usedPort = readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]?.trim();
    if (usedPort && await cdpAnswers(usedPort)) {
      fail(`The agent profile ${options.profileDir} is in use by a running Chrome (DevTools port ${usedPort}). Close it or pass --profile-dir.`);
    }
  }
  const args = [...new Set(ANTI_THROTTLE_SWITCHES),
    `--remote-debugging-port=${options.debugPort}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${options.profileDir}`, '--no-first-run', '--no-default-browser-check', 'about:blank'];
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const page = await waitForPageTarget(options.debugPort, 15_000);
  if (!page) fail(`Chrome did not open DevTools on port ${options.debugPort} within 15 s — is the profile ${options.profileDir} used by another Chrome?`);
  const cdp = await cdpConnect(page.webSocketDebuggerUrl);

  // 4. Seed bridge switch + AI consent, ONLY for the viewer origin.
  const consent = readConsentContract();
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildInitScript({
      origin: viewerOrigin,
      bridgePort: connectUrl.port || '5100',
      consentKey: consent.key,
      consentVersion: consent.version,
    }),
  });
  console.log(`viewer:agent — AI-Einwilligung im Agent-Profil gesetzt (${consent.key}=${consent.version}, nur ${viewerOrigin}).`);

  // 5. Navigate.
  const target = buildAgentUrl(options.url, token, options.doc);
  await cdp.send('Page.navigate', { url: target });
  await cdp.send('Page.bringToFront').catch(() => {});

  // 6. Wait for OUR claim + roundtrip.
  const result = await waitForOwnClaim({
    claimId,
    timeoutMs: options.timeoutMs,
    fetchStatus: async () => {
      const r = await httpJson('GET', `${options.connect}/bridge/status`);
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return r.body;
    },
    ping: async () => (await httpJson('POST', `${options.connect}/bridge/ping`, 12_000)).body,
    checkOrigin: async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
      const href = String(r?.result?.value ?? '');
      if (!href || href === 'about:blank') return { ok: true };
      const actual = new URL(href).origin;
      return { ok: actual === viewerOrigin, actual };
    },
    onProgress: (line) => console.log(`viewer:agent — ${line}`),
  });
  cdp.close();

  if (!result.ok) {
    fail(result.reason === 'redirect'
      ? `${result.diagnosis} (expected ${viewerOrigin}).`
      : `not ready after ${Math.round(options.timeoutMs / 1000)} s: ${result.diagnosis}`);
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`viewer:agent — READY in ${seconds} s: claim ${claimId} owns the bridge `
    + `(generation ${result.status.generation}, ${result.status.active.tools} tools, `
    + `${result.status.standby.length} standby). CDP http://localhost:${options.debugPort}`);
  process.exit(0);
}

function runPlain(options, chrome) {
  if (!existsSync(options.profileDir)) mkdirSync(options.profileDir, { recursive: true });
  const cdpSwitches = options.debugPort
    ? [`--remote-debugging-port=${options.debugPort}`, '--remote-debugging-address=127.0.0.1']
    : [];
  const args = [...new Set(ANTI_THROTTLE_SWITCHES), ...cdpSwitches, `--user-data-dir=${options.profileDir}`, options.url];

  console.log('Launching Chrome without background throttling:');
  console.log(`  chrome:  ${chrome}`);
  console.log(`  profile: ${options.profileDir}`);
  console.log(`  url:     ${options.url}`);
  console.log(`  cdp:     ${options.debugPort ? `http://localhost:${options.debugPort} (Playwright MCP --cdp-endpoint)` : 'off'}`);
  console.log('\nKeep the viewer as the ACTIVE TAB of its window; the window itself');
  console.log('may sit behind the IDE. Verify any time with the MCP tool web_ping.');

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

async function main() {
  const options = parseLauncherArgs(process.argv.slice(2));
  if (options.error) fail(options.error);
  const chrome = findChrome();
  if (!chrome) fail('Chrome not found. Set RV_CHROME to the chrome.exe path.');
  if (options.agent) await runAgent(options, chrome);
  else runPlain(options, chrome);
}

// Run only when executed, never when a test imports the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => fail(e?.stack ?? String(e)));
}
