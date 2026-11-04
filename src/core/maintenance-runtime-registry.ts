// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-runtime-registry — the open seam between the MaintenancePlugin
 * (open, the one state machine of a guide) and an optional maintenance runtime
 * that makes the machine follow the guide (plan-522 §2.3).
 *
 * Without a registered runtime the guide behaves as before: text, camera and
 * highlight only. A runtime (private feature) registers itself here; the plugin
 * asks for it when a scenario starts.
 *
 * The second half is the render-mode lock (plan-522 §2.7): while a guide with a
 * runtime runs, the runtime swaps `mesh.material` (transparency clones), and so
 * does the toon mode — a mode switch mid-guide would capture the wrong
 * originals. `render-mode-controller.ts` asks {@link maintenanceRenderLockReason}
 * and never imports the plugin.
 */

import type { MaintenanceProcedure } from './maintenance-parser';
import type { RVViewer } from './rv-viewer';

// ─── Runtime seam ───────────────────────────────────────────────────────

/** How a step was reached: Next (`forward`), Previous (`back`), stepper / resume (`jump`). */
export type StepDirection = 'forward' | 'back' | 'jump';

/** Why a guide's runtime ends. */
export type MaintenanceEndReason = 'exit' | 'live-handover' | 'reset';

export interface MaintenanceRuntime {
  /** Resolve targets and capture the baseline of the procedure. */
  begin(procedure: MaintenanceProcedure, viewer: RVViewer): void;
  /** Animate to state(stepIndex) (actions of steps 0..stepIndex, inclusive). Resolves when done or
   *  superseded; after abort it performs NO further action (checks the signal after every await). */
  applyStep(stepIndex: number, direction: StepDirection, signal: AbortSignal): Promise<void>;
  /** Terminal: invalidate the generation, stop the ticker, restore the baseline instantly, dispose.
   *  Idempotent. 'live-handover': restore visuals but write NO signals.
   *  'reset': dispose visuals (material clones, spray) only — NO drive/transform/signal restore,
   *  the simulation reset owns that state. */
  end(reason?: MaintenanceEndReason): void;
}

let _runtime: MaintenanceRuntime | null = null;

/**
 * Register the maintenance runtime (one at a time; a later registration
 * replaces the earlier one). Returns the unregister function, which only
 * removes THIS runtime.
 */
export function registerMaintenanceRuntime(rt: MaintenanceRuntime): () => void {
  _runtime = rt;
  return () => {
    if (_runtime === rt) _runtime = null;
  };
}

/** The registered maintenance runtime, or null (open build without the private feature). */
export function getMaintenanceRuntime(): MaintenanceRuntime | null {
  return _runtime;
}

// ─── Render-mode lock ───────────────────────────────────────────────────

/** The reason the render mode is refused while a maintenance guide runs. */
export const MAINTENANCE_RENDER_LOCKED = 'Not available during a maintenance guide';

let _renderLocked = false;
const _lockListeners = new Set<() => void>();

/** Set or release the render-mode lock (the MaintenancePlugin is the only caller). */
export function setMaintenanceRenderLock(locked: boolean): void {
  if (_renderLocked === locked) return;
  _renderLocked = locked;
  for (const cb of [..._lockListeners]) cb();
}

/** {@link MAINTENANCE_RENDER_LOCKED} while a guide holds the lock, else null. */
export function maintenanceRenderLockReason(): string | null {
  return _renderLocked ? MAINTENANCE_RENDER_LOCKED : null;
}

/** Subscribe to lock changes; returns the unsubscribe function. */
export function subscribeMaintenanceRenderLock(cb: () => void): () => void {
  _lockListeners.add(cb);
  return () => { _lockListeners.delete(cb); };
}
