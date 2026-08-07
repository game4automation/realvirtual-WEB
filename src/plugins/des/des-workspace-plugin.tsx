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

import { Box, Paper, Typography } from '@mui/material';
import { AccountTree } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { ModeId } from '../../core/rv-mode-manager';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import { DESControllerToolbar } from '../sim-controller/DESControllerToolbar';
import { setEventQueueWindowOpen } from '../sim-controller/event-queue-window-store';
import { ensureDesManagerNode } from '../../core/material-flow/des-manager-node';
// The Event Queue window is a PRIVATE feature (filter/category/footer). Imported
// via @rv-private — the public build resolves the no-op stub in src/private-stubs.
import { EventQueueOverlay } from '@rv-private/plugins/des/hmi/event-queue-overlay';

/**
 * Honest stub shown only when the private DES runner is absent (public build).
 * When the runner is present the toolbar controls are self-explanatory, so no
 * overlay is rendered.
 */
function DESWorkspacePanel({ viewer }: UISlotProps) {
  const hasRunner = viewer.simulationKernel?.hasDesRunner() ?? false;
  if (hasRunner) return null;
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
          DES runner not available in this build.
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
    // Private window (filter/category/footer) via @rv-private; stub renders null.
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
    // Auto-singleton (like the Unity DESManager): ensure a 'Simulation' node with
    // a DESManager component exists so the sim END / statistics-reset settings live
    // in the scene (GLB-first) and round-trip through save / load. No-op if present.
    ensureDesManagerNode(viewer);
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

  private _syncKernelToDes(viewer: RVViewer): void {
    const kernel = viewer.simulationKernel;
    if (kernel?.hasDesRunner()) kernel.setMode('des');
  }
}
