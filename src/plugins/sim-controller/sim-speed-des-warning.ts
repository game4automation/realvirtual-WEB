// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readSessionStorage, removeSessionStorage, writeSessionStorage } from '../../core/rv-safe-storage';

/**
 * Simulation-speed warning for DES blocks in a continuous workspace.
 *
 * The sim toolbar's speed factor makes simulated time run faster in the
 * continuous executor too (see `rv-speed-override.ts`), but it stays a 60 Hz
 * fixed step: above ~10× small parts can tunnel past sensors, and a long run is
 * still bounded by wall time. DES mode jumps from event to event and has a real
 * fast-forward, so when the scene carries DES blocks the speed menu points
 * there once. Pure decision + session flag here; the Snackbar lives in
 * `SimControllerToolbar.tsx`. UI-only — MCP calls of `sim.speedOverride` never
 * reach this code (no dialog for agents).
 */

/** Factor from which the warning appears (the first choice where sensor misses become likely). */
export const DES_SPEED_WARN_FACTOR = 10;

/** sessionStorage key of "Don't ask again" (per browser session). */
export const DES_SPEED_WARN_DISMISS_KEY = 'rv-sim-speed-des-warning-dismissed';

/** Workspaces in which the warning never appears: DES already is the fast mode,
 *  the editor's test run cannot switch to DES without leaving the editor. */
const NO_WARN_MODES: ReadonlySet<string> = new Set(['des', 'editor', 'hmi']);

let dismissedInMemory = false;

/** Minimal viewer surface the warning needs (duck-typed, no Private import). */
export interface DesSpeedWarnViewer {
  readonly features?: { isActive(id: string): boolean } | null;
  readonly modes?: {
    readonly activeMode: string | null;
    has(id: string): boolean;
    /** Present on the real ModeManager but never called here: DES is an on-demand
     *  feature, so the switch goes through {@link setModeAsync} (plan-652 §9.10). */
    setMode?(id: string): unknown;
    setModeAsync(id: string): Promise<boolean>;
  } | null;
}

/** True when the user chose "Don't ask again" in this browser session. */
export function isDesSpeedWarningDismissed(): boolean {
  if (dismissedInMemory) return true;
  try {
    return readSessionStorage(DES_SPEED_WARN_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Remember "Don't ask again" for the rest of this browser session. */
export function dismissDesSpeedWarningForSession(): void {
  dismissedInMemory = true;
  try {
    writeSessionStorage(DES_SPEED_WARN_DISMISS_KEY, '1');
  } catch {
    /* private window / blocked storage — the in-memory flag still holds */
  }
}

/** Test hook: forget the session dismissal. */
export function resetDesSpeedWarningForTests(): void {
  dismissedInMemory = false;
  try {
    removeSessionStorage(DES_SPEED_WARN_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Should choosing `factor` in the speed menu show the warning? Yes when the new
 * factor reaches {@link DES_SPEED_WARN_FACTOR}, the previous one was below it
 * (no repeat while moving between high factors), the DES feature is active
 * (= the scene carries DES blocks), a DES workspace exists to switch to, the
 * active workspace is a continuous one, and the user has not dismissed it.
 */
export function shouldWarnDesSpeed(viewer: DesSpeedWarnViewer | null | undefined, factor: number, previous: number): boolean {
  if (!viewer) return false;
  if (!(factor >= DES_SPEED_WARN_FACTOR) || previous >= DES_SPEED_WARN_FACTOR) return false;
  if (viewer.features?.isActive('des') !== true) return false;
  const modes = viewer.modes;
  if (!modes || !modes.has('des')) return false;
  const active = modes.activeMode;
  if (active && NO_WARN_MODES.has(active)) return false;
  return !isDesSpeedWarningDismissed();
}

/** Switch the workspace to DES (the DES workspace plugin moves the kernel to its executor). */
export function switchToDesMode(viewer: DesSpeedWarnViewer | null | undefined): void {
  const modes = viewer?.modes;
  if (!modes || !modes.has('des')) return;
  void modes.setModeAsync('des');
}
