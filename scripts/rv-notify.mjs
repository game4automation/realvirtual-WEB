// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-notify.mjs — a Windows balloon notification without any npm package
 * (plan-503 §2.6). Used by the /dev deploy watcher (dev-deploy-watch.mjs) when
 * the post-deploy demo smoke turns red.
 *
 * `System.Windows.Forms.NotifyIcon.ShowBalloonTip` needs neither a PowerShell
 * module nor an AppId registration; it is visible in an interactive session,
 * which is what the watcher's task is ("run only when user is logged on").
 *
 * Self-contained on purpose: only `node:` imports, because `--install` copies
 * this file next to the watcher into `<root>\bin\`. NEVER throws — a failed
 * notification is returned (and logged by the caller), it never breaks a tick.
 */

import { spawnSync } from 'node:child_process';

//! Balloon limits of Windows: title 63, text 255 characters.
const TITLE_MAX = 63;
const TEXT_MAX = 255;

const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const clip = (value, max) => (String(value).length > max ? `${String(value).slice(0, max - 1)}…` : String(value));

//! The PowerShell that shows the balloon and keeps the icon alive long enough to be seen.
export function balloonScript(title, body, { level = 'Error', showMs = 15_000, holdSeconds = 8 } = {}) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    `$n.Icon = [System.Drawing.SystemIcons]::${level === 'Error' ? 'Error' : 'Information'}`,
    `$n.Text = ${psQuote(clip(title, TITLE_MAX))}`,
    `$n.BalloonTipIcon = ${psQuote(level === 'Error' ? 'Error' : 'Info')}`,
    `$n.BalloonTipTitle = ${psQuote(clip(title, TITLE_MAX))}`,
    `$n.BalloonTipText = ${psQuote(clip(body, TEXT_MAX))}`,
    '$n.Visible = $true',
    `$n.ShowBalloonTip(${Math.round(showMs)})`,
    `Start-Sleep -Seconds ${Math.round(holdSeconds)}`,
    '$n.Dispose()',
  ].join('; ');
}

//! Shows a balloon notification. Returns `{ ok, skipped?, error? }`; never throws.
//! `options.spawn` is a test seam with the signature of `spawnSync`.
export function notifyWindows(title, body, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { ok: false, skipped: true, error: `no notification on ${platform}` };
  try {
    const run = options.spawn ?? spawnSync;
    const result = run('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', balloonScript(title, body, options),
    ], { windowsHide: true, timeout: options.timeoutMs ?? 15_000, encoding: 'utf8' });
    if (result?.error) return { ok: false, error: String(result.error.message ?? result.error) };
    if (result?.status !== 0) return { ok: false, error: `powershell exit ${result?.status}: ${String(result?.stderr ?? '').trim().slice(0, 300)}` };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
