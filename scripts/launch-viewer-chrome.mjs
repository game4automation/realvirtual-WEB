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
 *
 * A dedicated `--user-data-dir` is used by default so these switches do not
 * leak into the everyday browsing profile, and so launching never has to
 * attach to an already-running Chrome (a second `chrome.exe` against the same
 * profile just forwards the URL to the existing process and DROPS the
 * switches, which is the classic reason "I passed the flags and nothing
 * changed").
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DEFAULT_URL = 'http://localhost:5100/';

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

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('Chrome not found. Set RV_CHROME to the chrome.exe path.');
    process.exit(1);
  }

  const url = arg('url', DEFAULT_URL);
  const profileDir = arg('profile-dir', join(tmpdir(), 'rv-viewer-chrome-profile'));
  if (!existsSync(profileDir)) mkdirSync(profileDir, { recursive: true });

  const args = [...new Set(ANTI_THROTTLE_SWITCHES), `--user-data-dir=${profileDir}`, url];

  console.log('Launching Chrome without background throttling:');
  console.log(`  chrome:  ${chrome}`);
  console.log(`  profile: ${profileDir}`);
  console.log(`  url:     ${url}`);
  console.log('\nKeep the viewer as the ACTIVE TAB of its window; the window itself');
  console.log('may sit behind the IDE. Verify any time with the MCP tool web_ping.');

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

main();
