// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PLUGIN_ORDER — named constants for plugin.order and SimLoopFacade.onTick.
 *
 * Convention for the magic numbers that currently appear as literals in many
 * plugin files (e.g. `readonly order = 10`). New plugins should import these
 * constants instead of writing literals.
 *
 * Plan-182 Phase 5.
 *
 * Range convention:
 *
 *   0-9    Topological / dependency-sort hooks (drive-order, etc.)
 *   10-19  Industrial interface adapters (signal flush from PLC to SignalStore)
 *   15-49  Adjacent infrastructure (multiuser sync, etc.)
 *   50-99  UI-critical plugins (annotation, sim-controller, connect)
 *   100    Default (no order specified)
 *   150-249 Demo / process-specific plugins
 *   250-499 UI overlays (drive-gizmo, layout-planner, kiosk)
 *   500-989 Reserved
 *   990-999 Debug & telemetry (mcp-bridge, debug-endpoint)
 *   1000+  Test / perf plugins
 */

export const PLUGIN_ORDER = {
  /** Topological / dependency-sort hooks. */
  CORE_PRE: 0,
  /** Industrial interface manager (lifecycle coordination across adapters). */
  INTERFACE_MANAGER: 5,
  /** Live PLC signal flush from adapter to SignalStore. */
  INTERFACE_ADAPTER: 10,
  /** Multiuser session sync (remote drive states, camera). */
  MULTIUSER: 15,
  /** UI-critical: annotation overlays, sim-controller HMI. */
  UI_CRITICAL: 50,
  /** Virtual PLC scan cycle (plan-242). Runs in TickStage.PRE AFTER the
   *  signalBindingManager flush (order 50) so every scan reads the freshest
   *  live signal values, and before the drive physics consume the outputs. */
  PLC_RUNTIME: 60,
  /** Default order if not specified. */
  SIM_DEFAULT: 100,
  /** Demo / process-specific (process-industry, machine-control). */
  DEMO: 150,
  /** UI overlays (drive-gizmo, layout-planner, kiosk). */
  UI_OVERLAY: 250,
  /** Debug / telemetry endpoints (mcp-bridge, debug-endpoint). */
  DEBUG: 990,
  /** Test / perf plugins. */
  TEST: 9999,
} as const;

export type PluginOrderKey = keyof typeof PLUGIN_ORDER;
