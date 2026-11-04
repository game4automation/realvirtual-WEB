// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DESWorkspacePlugin — the DES (Discrete Event Simulation) workspace mode
 * (plan-198) and the bridge between the DES *workspace* and the DES *execution
 * kernel* (plan-194).
 *
 * Two responsibilities:
 *
 *  1. UI — it owns the leading sim-control toolbar WHILE in DES mode: the
 *     `DESControllerToolbar` (Play/Pause + Reset + Animated/Hybrid/FastForward/
 *     Step) is registered in `toolbar-button-leading` and auto-gated to
 *     `mode:des` (because `modes: ['des']`). The continuous `SimControllerToolbar`
 *     hides itself in `mode:des`, so the top-left controls always reflect the
 *     active kernel. A small overlay panel only shows the honest "not available"
 *     stub when the private DES runner is missing (public build).
 *
 *  2. Kernel coupling — entering the DES workspace switches the unified
 *     `SimulationKernel` to its DES executor (`setMode('des')`); leaving it
 *     restores the continuous executor (`setMode('continuous')`). The
 *     ModeManager itself stays orthogonal/generic (see rv-mode-manager.ts); this
 *     plugin is the dedicated place that couples the two so the DES controls are
 *     actually live in DES mode. `onModelLoaded` re-syncs for the boot-into-DES
 *     case (model loads after the workspace is already DES).
 */

import { lazy, Suspense, useSyncExternalStore } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { AccountTree } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import { DESControllerToolbar } from '../sim-controller/DESControllerToolbar';
import {
  isEventQueueWindowOpen, setEventQueueWindowOpen, subscribeEventQueueWindow,
} from '../sim-controller/event-queue-window-store';
import { LazyPanelBoundary } from '../../core/hmi/LazyPanelBoundary';

// The Event Queue window (filter/category/footer) — part of the DES core since
// plan-680, the same module in every build.
// plan-652 Phase 3: imported on first open only. A static import pulled the DES
// manager (`DESMode`) into the startup entry, although the window exists only in
// DES mode after the user opens it.
const EventQueueOverlayBody = lazy(() =>
  import('./hmi/event-queue-overlay').then((m) => ({ default: m.EventQueueOverlay })));

/** Mounts the Event Queue window once it was opened (stays mounted after). */
function EventQueueOverlay(props: UISlotProps) {
  const open = useSyncExternalStore(subscribeEventQueueWindow, isEventQueueWindowOpen);
  if (!open && !openedOnce.has(props.viewer)) return null;
  openedOnce.add(props.viewer);
  return (
    <LazyPanelBoundary label="Event Queue">
      <Suspense fallback={null}>
        <EventQueueOverlayBody {...props} />
      </Suspense>
    </LazyPanelBoundary>
  );
}
const openedOnce = new WeakSet<object>();

/**
 * Honest stub shown only when the private DES runner is absent (public build).
 * When the runner is present the toolbar controls are self-explanatory, so no
 * overlay is rendered.
 */
function DESWorkspacePanel({ viewer }: UISlotProps) {
  const hasRunner = viewer.simulationKernel?.hasDesRunner() ?? false;
  if (hasRunner) return null;
  // plan-652: declared on demand but not active yet → it is loading, not missing.
  const loading = viewer.features?.isDeclared('des') === true && !viewer.features.isActive('des');
  return (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        px: 2,
        py: 1.25,
        borderRadius: 2,
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        maxWidth: 420,
      }}
    >
      <AccountTree fontSize="small" />
      <Box>
        <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.2 }}>
          Discrete Event Simulation
        </Typography>
        <Typography sx={{ fontSize: 12, opacity: 0.75, lineHeight: 1.3 }}>
          {loading ? 'Loading DES simulation …' : 'DES runner not available in this build.'}
        </Typography>
      </Box>
    </Paper>
  );
}

export class DESWorkspacePlugin implements RVViewerPlugin {
  readonly id = 'des-workspace';
  readonly order = 260;

  /** plan-198: this plugin (and its UI) is active only in DES workspace mode. */
  readonly modes: ModeId[] = ['des'];

  readonly slots: UISlotEntry[] = [
    // The DES sim controls take the leading toolbar slot — auto-gated to
    // `mode:des` because of `modes: ['des']`. Same order as the continuous
    // SimControllerToolbar (which is hidden in DES), so they swap cleanly.
    { slot: 'toolbar-button-leading', component: DESControllerToolbar, order: 10 },
    // Event Queue window (toggled from the DES toolbar) — gated to `mode:des`.
    // Window with filter/category/footer, imported on first open.
    { slot: 'overlay', component: EventQueueOverlay, order: 90 },
    // Overlay stub — only renders when the DES runner is unavailable.
    { slot: 'overlay', component: DESWorkspacePanel, order: 100 },
  ];

  // ── Kernel coupling (plan-194 ⇄ plan-198) ──

  /**
   * Entering the DES workspace → switch the unified kernel to its DES executor
   * so the DES sub-mode controls are live. No-op when the unified kernel / DES
   * runner is unavailable (public build) — the toolbar then shows only
   * Play/Pause + Reset and the overlay stub explains why.
   */
  onModeActivate(_mode: ModeId, viewer: RVViewer): void {
    this._syncKernelToDes(viewer);
    // The sim END / statistics-reset settings live in the scene (GLB-first) on a
    // singleton 'Simulation' node with a DESManager component. Entering the mode
    // touches nothing — the document stays clean (plan-616 Teil 1, LOP #196);
    // readers call `readDesManagerSettings` where they need the values. The
    // toolbar creates the node with the user's first edit of a setting
    // (`ensureDesManagerNode` right before its `setField`).
  }

  /** Leaving the DES workspace → restore the continuous (Realtime) executor
   *  and close the Event Queue window so it doesn't linger into other modes. */
  onModeDeactivate(_from: ModeId | null, viewer: RVViewer): void {
    setEventQueueWindowOpen(false);
    viewer.simulationKernel?.setMode('continuous');
  }

  /**
   * Boot-into-DES safety net: when a model loads while DES is already the active
   * workspace, the kernel (built lazily on model load) must follow. Only called
   * while this plugin participates (i.e. DES is active), so syncing to DES here
   * is always correct.
   */
  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._syncKernelToDes(viewer);
  }

  /**
   * plan-435: `onModelLoaded` pushes the unified kernel into DES mode, and the
   * only way back is `onModeDeactivate`. Switching the plugin off must not
   * leave the kernel executing DES events with no DES workspace in sight, so
   * the teardown is the mode-leave path. Kernel mode is not model state
   * (invariant 3).
   */
  onDeactivate(viewer: RVViewer): void {
    this.onModeDeactivate(null, viewer);
  }

  /** Back into DES — but only while the DES workspace is actually active. */
  onActivate(viewer: RVViewer): void {
    if (viewer.modes.activeMode !== 'des') return;
    this._syncKernelToDes(viewer);
  }

  private _syncKernelToDes(viewer: RVViewer): void {
    const kernel = viewer.simulationKernel;
    if (!kernel) return;
    if (kernel.hasDesRunner()) { kernel.setMode('des'); return; }
    // Fallback: a viewer whose DES feature has not handed the runner factory over
    // yet (a test viewer without FeatureLoader activation). The on-demand DES
    // feature normally set it before this mode was entered.
    void viewer.loadDesRunnerFactory?.().then((ok) => {
      if (ok && viewer.modes.activeMode === 'des') viewer.simulationKernel?.setMode('des');
    });
  }
}
