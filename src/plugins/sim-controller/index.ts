// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimControllerPlugin — Global Play/Pause/Reset for the continuous simulation.
 *
 * Registers a 2-button toolbar widget (Play/Pause toggle + Reset) plus an
 * optional Pause-Badge. Pause is implemented as a named reason on the
 * viewer's reference-counted pause set (`setSimulationPaused('user', …)`),
 * so it composes cleanly with WebXR (`'ar-placement'`), Layout-Planner
 * (`'layout-edit'`), and any future plugin that needs to hold the sim.
 *
 * Reset (`resetSimulation()`) clears MUs and LogicSteps; drives and signals
 * stay untouched so Live mode continues to work.
 *
 * Keyboard shortcuts (registered at plugin construction, scoped globally
 * but suppressed when an input element has focus):
 *   • Space    — toggle Play/Pause
 *   • Shift+R  — Reset
 *
 * Defense-in-Depth against pause-reason leaks:
 *   1. UI Pause button toggles `'user'` reason explicitly.
 *   2. `dispose()` always releases `'user'` as a safety net.
 *   3. `viewer.clearPauseReasons()` exists as a dev-tools escape.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { UISlotEntry } from '../../core/rv-ui-plugin';
import { modeContext } from '../../core/rv-mode-manager';
import { USER_PAUSE_REASON } from '../../core/engine/rv-constants';
import { SimControllerToolbar } from './SimControllerToolbar';
import { ModeSwitchNotice } from './ModeSwitchNotice';

/** The pause-reason key used by this plugin. Exported so tests + adjacent
 *  modules (e.g. config helpers) can reference it without typo risk.
 *  Canonically defined in core (`USER_PAUSE_REASON`) so Layout-Planner edit
 *  gestures can engage the same reason the toolbar Play button releases. */
export const SIM_CONTROLLER_PAUSE_REASON = USER_PAUSE_REASON;

/** Configuration shape consumed by `config.simController` in app-config / GLB. */
export interface SimControllerConfig {
  /** Render the pause-reason badge next to the buttons. Default: true. */
  showBadge?: boolean;
  /** Enable Space / Shift+R keyboard shortcuts. Default: true. */
  shortcuts?: boolean;
}

export class SimControllerPlugin implements RVViewerPlugin {
  readonly id = 'sim-controller';
  readonly order = 50;

  readonly slots: UISlotEntry[] = [
    // Leading slot renders BEFORE the Hierarchy button — primary sim controls
    // (Play/Pause + Reset + Speed) live at the very start of the TopBar, right
    // after the realvirtual logo / online indicator.
    //
    // Visible only in the Planner workspace. Hidden in:
    //   • DES (`mode:des`)  — the DESControllerToolbar (registered by
    //     DESWorkspacePlugin) takes this slot instead, so the leading controls
    //     reflect the active DES execution kernel.
    //   • HMI (`mode:hmi`)  — the operator / monitoring view exposes no
    //     Play/Pause/Reset/Speed controls; the twin is observed (or driven
    //     externally in Live mode), not authored from this view.
    // (plan-194 / plan-198.)
    {
      slot: 'toolbar-button-leading',
      component: SimControllerToolbar,
      order: 10,
      visibilityId: 'sim-controller-continuous',
      // Also hidden in the Editor workspace — its runtime is detached, so there
      // is no continuous sim to hold; the AssetEditorPlugin owns this slot there
      // and puts the in-place test run in it (reusing the segments below once a
      // run is live) — and in the Viewer (plan-387), which is a pure spectator:
      // the kinematics run, but nobody drives them from here.
      visibilityRule: {
        hiddenIn: [
          modeContext('des'), modeContext('hmi'),
          modeContext('editor'), modeContext('viewer'),
        ],
      },
    },
    // Always-mounted overlay (no visibility rule) so it catches every workspace
    // switch and informs the user that switching clears MUs (no cross-mode
    // continuity yet).
    {
      slot: 'overlay',
      component: ModeSwitchNotice,
      order: 10,
    },
  ];

  /** Set in `onModelLoaded`. Used by `dispose()` for safety-net cleanup
   *  and by the keyboard-shortcut handler. */
  private _viewer: RVViewer | null = null;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private _shortcutsEnabled: boolean;

  constructor(opts: { shortcuts?: boolean } = {}) {
    // Default to enabled. App-level config can override by passing an explicit
    // value via `new SimControllerPlugin({ shortcuts: false })` in main.ts.
    this._shortcutsEnabled = opts.shortcuts ?? true;
  }

  onModelLoaded(_result: unknown, viewer: RVViewer): void {
    this._viewer = viewer;
    if (this._shortcutsEnabled && !this._keyHandler) {
      this._installShortcuts();
    }
  }

  /**
   * plan-435: without this hook the keyboard shortcuts would keep firing after
   * the user switched the plugin off, and a held `'user'` pause reason would
   * freeze the simulation with no way left to release it. Releases exactly
   * what {@link _installShortcuts} and the pause button own — no model state,
   * so invariant 3 holds.
   */
  onDeactivate(): void {
    this._removeShortcuts();
    this._viewer?.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, false);
  }

  /** Re-install the shortcuts torn down by {@link onDeactivate}. */
  onActivate(viewer: RVViewer): void {
    this._viewer = viewer;
    if (this._shortcutsEnabled && !this._keyHandler) {
      this._installShortcuts();
    }
  }

  /** Safety net: release `'user'` reason so a forgotten Pause does not leave
   *  the simulation frozen after the plugin tears down. */
  dispose(): void {
    this._removeShortcuts();
    this._viewer?.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, false);
    this._viewer = null;
  }

  /** Idempotent removal of the global keydown listener. */
  private _removeShortcuts(): void {
    if (!this._keyHandler) return;
    window.removeEventListener('keydown', this._keyHandler, true);
    this._keyHandler = null;
  }

  // ── Keyboard shortcuts ──

  private _installShortcuts(): void {
    const handler = (e: KeyboardEvent): void => {
      // Don't steal Space/Shift+R from text inputs, contenteditable, etc.
      const t = e.target as HTMLElement | null;
      if (t) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) {
          return;
        }
      }
      const viewer = this._viewer;
      if (!viewer) return;

      // Space — toggle Play/Pause
      if (e.code === 'Space' && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        const userPaused = viewer.simulationPauseReasons.includes(SIM_CONTROLLER_PAUSE_REASON);
        viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, !userPaused);
        e.preventDefault();
        return;
      }
      // Shift+R — Reset. Use Shift to avoid hijacking Ctrl+R / Cmd+R (browser reload).
      if (e.code === 'KeyR' && e.shiftKey && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
        viewer.resetSimulation();
        e.preventDefault();
        return;
      }
    };
    this._keyHandler = handler;
    window.addEventListener('keydown', handler, true);
  }
}
