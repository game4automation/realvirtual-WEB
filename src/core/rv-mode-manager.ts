// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ModeManager — Blender-style workspace modes (plan-198).
 *
 * A "mode" is a named workspace (HMI / DES / Planner). Exactly one mode is
 * active at a time; switching a mode activates/deactivates a set of plugins
 * AND their UI. A plugin declares its mode membership once via `plugin.modes`
 * (`undefined` = shared/all-modes; `core: true` = always active), and that
 * single declaration drives both simulation participation (enable/disable) and
 * UI visibility (a `mode:<id>` context).
 *
 * This subsystem is deliberately thin and Three.js-free: it owns the active
 * mode, the descriptor registry, persistence, and the switch orchestration. All
 * scene-side effects live in plugin `onModeActivate`/`onModeDeactivate` hooks.
 * The narrow {@link ModeHost} interface decouples it from RVViewer so it can be
 * unit-tested with a pure mock host.
 *
 * NOTE: This is ORTHOGONAL to the simulation kernel's execution mode
 * (`'continuous' | 'des'`, see SimulationKernel / `simulation-mode-changed`).
 * Entering the DES *workspace* does NOT switch the *kernel* execution mode.
 */

import type { RVViewer } from './rv-viewer';
import type { RVViewerPlugin } from './rv-plugin';

/** Workspace mode identifier. Extensible via any string. */
export type ModeId = 'hmi' | 'des' | 'planner' | (string & {});

/** Describes a selectable mode (for the dropdown + registry). */
export interface ModeDescriptor {
  id: ModeId;
  /** Human-readable label shown in the dropdown. */
  label: string;
  /** Optional MUI icon name (resolved by the dropdown component). */
  icon?: string;
  /** Sort order in the dropdown (lower = first). Default: 100. */
  order?: number;
  /**
   * Whether the SimulationRuntime integrates time in this mode.
   * `'simulation'` (default) — the fixed-update loop runs normally.
   * `'detached'` — zero time integration: no fixedUpdate scheduling at all
   * (stronger than a pause reason — cannot be resumed by `clearPauseReasons()`).
   * Used by authoring workspaces like the asset editor. Rendering is unaffected.
   */
  runtime?: 'simulation' | 'detached';
}

/** Payload for `mode-changing` / `mode-changed` events. */
export interface ModeChangeEvent {
  from: ModeId | null;
  to: ModeId;
}

/**
 * The four plugin sets a mode switch operates on. `enable`/`disable` reconcile
 * the actual active state against the target mode; `activateHooks`/
 * `deactivateHooks` fire the mode lifecycle hooks on the participation
 * transition `from → to`. The sets differ at boot (everything starts active but
 * not all plugins "participate" in the null mode), which is why both are needed.
 */
export interface ModePluginSets {
  enable: RVViewerPlugin[];
  disable: RVViewerPlugin[];
  activateHooks: RVViewerPlugin[];
  deactivateHooks: RVViewerPlugin[];
}

/**
 * Narrow host the ModeManager drives — implemented by RVViewer. Keeps the
 * manager free of any direct RVViewer/Three.js runtime dependency.
 */
export interface ModeHost {
  /** The viewer, passed as the 2nd arg to onModeActivate/onModeDeactivate. */
  readonly viewer: RVViewer;
  /** Compute the plugin sets for a `from → to` transition. */
  pluginsForMode(from: ModeId | null, to: ModeId): ModePluginSets;
  enablePlugin(id: string): void;
  disablePlugin(id: string): void;
  callPlugin(plugin: RVViewerPlugin, method: string, ...args: unknown[]): void;
  setContext(ctx: string, active: boolean): void;
  emit(event: 'mode-changing' | 'mode-changed', data: ModeChangeEvent): void;
}

/**
 * Guard consulted before LEAVING a mode via {@link ModeManager.requestMode}.
 * Return `false` (or resolve to `false`) to cancel the switch — e.g. the asset
 * editor vetoes while unsaved changes exist until the user chooses Save /
 * Discard / Cancel. Guards run only on the user-facing `requestMode` path;
 * `setMode` stays synchronous and guard-free ("force" semantics: boot,
 * `lock()`, tests, programmatic switches).
 */
export type ModeExitGuard = (from: ModeId, to: ModeId) => boolean | Promise<boolean>;

/** localStorage key for the persisted active mode. */
const LS_KEY = 'rv-active-mode';

/** Context name for a mode (e.g. 'hmi' → 'mode:hmi'). */
export function modeContext(id: ModeId): string {
  return `mode:${id}`;
}

export class ModeManager {
  private readonly host: ModeHost;
  private _modes = new Map<ModeId, ModeDescriptor>();
  private _active: ModeId | null = null;
  private _lockedMode: ModeId | null = null;
  private _switching = false;
  private _version = 0;
  private _listeners = new Set<() => void>();
  /** Exit guards per mode id (run by requestMode before leaving that mode). */
  private _exitGuards = new Map<ModeId, Set<ModeExitGuard>>();
  /** Re-entrancy guard for requestMode (guards may show async dialogs). */
  private _requesting = false;

  constructor(host: ModeHost) {
    this.host = host;
  }

  /** Register (or override) a selectable mode. Chainable. */
  register(descriptor: ModeDescriptor): this {
    this._modes.set(descriptor.id, descriptor);
    this._bump();
    return this;
  }

  /** All registered modes, sorted by `order` (then insertion order). */
  list(): ModeDescriptor[] {
    return [...this._modes.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
  }

  /** Whether a mode id is registered. */
  has(id: ModeId): boolean {
    return this._modes.has(id);
  }

  /** The registered descriptor for a mode id, or undefined if unknown. */
  descriptor(id: ModeId): ModeDescriptor | undefined {
    return this._modes.get(id);
  }

  /** The currently active mode, or null before the first switch. */
  get activeMode(): ModeId | null {
    return this._active;
  }

  /**
   * Switch to a mode. No-op if it's already active, unknown, or a switch is
   * already in progress (re-entrancy guard). Orchestrates, in order:
   *   1. emit 'mode-changing'
   *   2. onModeDeactivate hooks (scene refs still valid) → disable leaving plugins
   *   3. swap the mode:<id> UI context
   *   4. enable entering plugins (replays missed onModelLoaded) → onModeActivate hooks
   *   5. persist, notify, emit 'mode-changed'
   */
  setMode(id: ModeId): void {
    if (this._switching) {
      console.warn(`[ModeManager] setMode('${id}') ignored — switch already in progress`);
      return;
    }
    if (this._lockedMode !== null && id !== this._lockedMode) {
      console.warn(`[ModeManager] setMode('${id}') ignored — locked to '${this._lockedMode}'`);
      return;
    }
    if (!this._modes.has(id)) {
      console.warn(`[ModeManager] setMode('${id}') ignored — unknown mode`);
      return;
    }
    if (id === this._active) return;

    const from = this._active;
    this._switching = true;
    try {
      this.host.emit('mode-changing', { from, to: id });

      const sets = this.host.pluginsForMode(from, id);

      // Leave the old mode: hooks first (scene refs valid), then disable.
      for (const p of sets.deactivateHooks) {
        this.host.callPlugin(p, 'onModeDeactivate', from, this.host.viewer);
      }
      for (const p of sets.disable) {
        this.host.disablePlugin(p.id);
      }

      // Swap UI context (mutual exclusivity: exactly one mode:<id> active).
      if (from) this.host.setContext(modeContext(from), false);
      this.host.setContext(modeContext(id), true);

      // Enter the new mode: enable (replays missed onModelLoaded), then hooks.
      for (const p of sets.enable) {
        this.host.enablePlugin(p.id);
      }
      for (const p of sets.activateHooks) {
        this.host.callPlugin(p, 'onModeActivate', id, this.host.viewer);
      }

      this._active = id;
      this._persist(id);
      this._bump();
      this.host.emit('mode-changed', { from, to: id });
    } finally {
      this._switching = false;
    }
  }

  /**
   * Register an exit guard for a mode. The guard runs when the USER requests
   * leaving `modeId` via {@link requestMode}; returning/resolving `false`
   * cancels the switch. Returns an unregister function. `lock()` and direct
   * `setMode()` bypass guards by design (kiosk / boot / programmatic).
   */
  registerExitGuard(modeId: ModeId, guard: ModeExitGuard): () => void {
    let set = this._exitGuards.get(modeId);
    if (!set) { set = new Set(); this._exitGuards.set(modeId, set); }
    set.add(guard);
    return () => { set!.delete(guard); };
  }

  /**
   * Guarded, async mode switch — the path every USER-facing switch takes
   * (mode dropdown, "Edit asset" library action, deep links after boot).
   * Runs the current mode's exit guards first; any veto cancels the switch.
   * Resolves `true` when the mode was switched (or already active).
   */
  async requestMode(id: ModeId): Promise<boolean> {
    if (id === this._active) return true;
    if (this._requesting) {
      console.warn(`[ModeManager] requestMode('${id}') ignored — a guarded switch is already in progress`);
      return false;
    }
    if (!this._modes.has(id)) {
      console.warn(`[ModeManager] requestMode('${id}') ignored — unknown mode`);
      return false;
    }
    this._requesting = true;
    try {
      const from = this._active;
      if (from !== null) {
        const guards = this._exitGuards.get(from);
        if (guards) {
          for (const guard of [...guards]) {
            let ok: boolean;
            try {
              ok = await guard(from, id);
            } catch (e) {
              console.error('[ModeManager] exit guard threw — treating as veto:', e);
              ok = false;
            }
            if (!ok) return false;
          }
        }
      }
      this.setMode(id);
      return this._active === id;
    } finally {
      this._requesting = false;
    }
  }

  /**
   * Lock the workspace to a single mode. While locked, the mode dropdown hides
   * (see ModeDropdown) and every `setMode()` to a different mode is rejected —
   * `restore()` and the `?mode=` boot path included. Used by single-purpose /
   * kiosk deployments (e.g. the Mauser 3D-HMI) that must stay in HMI and never
   * expose DES / Planner. Activates `id` immediately so a later restore() or
   * `?mode=` cannot leave the workspace on a different (or null) mode.
   */
  lock(id: ModeId): void {
    if (!this._modes.has(id)) {
      console.warn(`[ModeManager] lock('${id}') ignored — unknown mode`);
      return;
    }
    this._lockedMode = id;
    this.setMode(id);
    this._bump();
  }

  /** Release a previous {@link lock}, restoring free switching + the dropdown. */
  unlock(): void {
    if (this._lockedMode === null) return;
    this._lockedMode = null;
    this._bump();
  }

  /** The mode the workspace is locked to, or null when unlocked. */
  get lockedMode(): ModeId | null {
    return this._lockedMode;
  }

  /**
   * Restore the persisted mode (or `fallback`). The `?mode=` URL param, when
   * handled by the caller, takes precedence over this — caller order:
   * URL param > restore() (persisted) > fallback. When the workspace is locked
   * (see {@link lock}), the locked mode wins over all of the above.
   */
  restore(fallback: ModeId = 'hmi'): void {
    if (this._lockedMode !== null) {
      this.setMode(this._lockedMode);
      return;
    }
    let target: ModeId = fallback;
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && this._modes.has(saved)) target = saved;
    } catch {
      /* localStorage unavailable — use fallback */
    }
    if (!this._modes.has(target)) {
      target = this.list()[0]?.id ?? fallback;
    }
    if (this._modes.has(target)) this.setMode(target);
  }

  /** Subscribe to mode changes (useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Version snapshot (useSyncExternalStore). */
  getSnapshot = (): number => this._version;

  private _persist(id: ModeId): void {
    try {
      localStorage.setItem(LS_KEY, id);
    } catch {
      /* localStorage unavailable — persistence is best-effort */
    }
  }

  private _bump(): void {
    this._version++;
    for (const fn of this._listeners) fn();
  }

  /** Test-only: reset all state. */
  _reset(): void {
    this._modes.clear();
    this._active = null;
    this._lockedMode = null;
    this._switching = false;
    this._requesting = false;
    this._version = 0;
    this._listeners.clear();
    this._exitGuards.clear();
  }
}

/**
 * Pure helper: does a plugin participate in `mode`? Shared (`modes` undefined)
 * and `core` plugins participate in every mode (including the null "no mode"
 * baseline). Mode-specific plugins participate only in their listed modes (and
 * never in the null baseline). Exported for RVViewer.pluginsForMode + tests.
 *
 * PARTICIPATION, NOT VISIBILITY — this answers "does the plugin run?", never
 * "is its UI shown?". UI visibility is compiled separately from `modes` by
 * `UIPluginRegistry.register` (rv-ui-registry.ts), which ignores `core`; a
 * `core: true` plugin therefore participates everywhere while its slots can
 * still be gated to a single mode. See doc-ui-visibility.md.
 *
 * Other consumers of this same semantics: `computeModePluginSets` (below),
 * `RVViewer.pluginsForMode`, and the feature matrix in the private repo
 * (`build-feature-matrix.ts` / `feature-matrix-plugin.tsx`), which projects
 * `core`/`modes` into a user-visible table.
 */
export function pluginParticipatesInMode(
  plugin: Pick<RVViewerPlugin, 'modes' | 'core'>,
  mode: ModeId | null,
): boolean {
  if (plugin.core === true) return true;
  if (plugin.modes === undefined) return true;
  if (mode === null) return false;
  return plugin.modes.includes(mode);
}

/**
 * Pure computation of the four plugin sets for a `from → to` transition.
 * `enable`/`disable` reconcile the actual active state (`isDisabled`) against
 * the target mode; `activateHooks`/`deactivateHooks` fire on the participation
 * transition. Shared/core plugins participate in every mode, so they never
 * appear in any set (the backward-compat guarantee). Exported for unit tests;
 * RVViewer.pluginsForMode delegates here.
 */
export function computeModePluginSets(
  plugins: readonly RVViewerPlugin[],
  isDisabled: (id: string) => boolean,
  from: ModeId | null,
  to: ModeId,
  isUserDisabled: (id: string) => boolean = () => false,
): ModePluginSets {
  const enable: RVViewerPlugin[] = [];
  const disable: RVViewerPlugin[] = [];
  const activateHooks: RVViewerPlugin[] = [];
  const deactivateHooks: RVViewerPlugin[] = [];
  for (const p of plugins) {
    const inFrom = pluginParticipatesInMode(p, from);
    const inTo = pluginParticipatesInMode(p, to);
    const disabled = isDisabled(p.id);
    const userDisabled = isUserDisabled(p.id);
    if (inTo && disabled && !userDisabled) enable.push(p);
    if (!inTo && !disabled) disable.push(p);
    if (inTo && !inFrom && !userDisabled) activateHooks.push(p);
    if (inFrom && !inTo && !userDisabled) deactivateHooks.push(p);
  }
  return { enable, disable, activateHooks, deactivateHooks };
}
