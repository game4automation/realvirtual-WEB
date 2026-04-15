// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVViewerPlugin — Interface for viewer plugins.
 *
 * Plugins register via viewer.use(plugin) and receive callbacks at key
 * lifecycle points. Each callback is isolated with try/catch so a
 * faulty plugin cannot freeze the simulation.
 *
 * Plugins can also provide UI by declaring a `slots` array. Slot entries
 * are automatically registered into the HMI layout (kpi-bar, button-group,
 * messages, etc.) when viewer.use() is called.
 */

import type { LoadResult } from './engine/rv-scene-loader';
import type { RVViewer } from './rv-viewer';
import type { UISlotEntry } from './rv-ui-plugin';

export interface RVViewerPlugin {
  /** Unique plugin ID (e.g. 'drive-recorder', 'sensor-monitor'). */
  readonly id: string;

  /** Sort order in Pre/Post/Render lists (lower = earlier). Default: 100. */
  readonly order?: number;

  /** When true: plugin handles transport (transportManager.update is skipped). */
  readonly handlesTransport?: boolean;

  /**
   * When true: plugin always activates, even in selective mode (rv_plugins declared).
   * Core plugins provide essential infrastructure (drive sorting, physics, etc.)
   * and cannot be skipped. Default: false (plugin is optional/skippable).
   */
  readonly core?: boolean;

  /** UI slot entries this plugin provides (KPI cards, buttons, messages, etc.). */
  readonly slots?: UISlotEntry[];

  // ── Lifecycle Callbacks ──

  /**
   * Called after loadGLB + state assignment, before 'model-loaded' event.
   * Also called retroactively when a plugin is registered after model load.
   */
  onModelLoaded?(result: LoadResult, viewer: RVViewer): void;

  /** Called at the start of clearModel, BEFORE state reset. */
  onModelCleared?(viewer: RVViewer): void;

  /** Called when the viewer's global connection state changes (Connected ↔ Disconnected). */
  onConnectionStateChanged?(state: 'Connected' | 'Disconnected', viewer: RVViewer): void;

  /** 60Hz tick BEFORE drive physics (set drive targets: ErraticDriver, Replay, CAM). */
  onFixedUpdatePre?(dt: number): void;

  /** 60Hz tick AFTER drive physics + transport (read results: DriveRecorder, SensorMonitor). */
  onFixedUpdatePost?(dt: number): void;

  /** Per render frame, after renderer.render(). */
  onRender?(frameDt: number): void;

  /** Viewer is being destroyed — clean up global listeners, DOM elements, etc. */
  dispose?(): void;
}
