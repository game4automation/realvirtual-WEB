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
import type { PluginContext } from './rv-plugin-context';
import type { ModeId } from './rv-mode-manager';

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
   *
   * This concerns PARTICIPATION only — whether the plugin runs. It does NOT make
   * the plugin's UI visible: the visibility of its slot entries is compiled from
   * `modes` by `UIPluginRegistry.register` (rv-ui-registry.ts), which never looks
   * at `core`. So `core: true` + `modes: ['hmi']` means "runtime runs in every
   * mode, UI appears only in hmi". See doc-ui-visibility.md.
   */
  readonly core?: boolean;

  /** UI slot entries this plugin provides (KPI cards, buttons, messages, etc.). */
  readonly slots?: UISlotEntry[];

  /**
   * Workspace modes this plugin participates in (plan-198). `undefined` (the
   * default) means the plugin is SHARED — active in every mode (backward
   * compatible: existing plugins behave exactly as before). `core: true`
   * plugins are always active regardless of this field.
   *
   * When set, the plugin is enabled only while one of the listed modes is
   * active; its UI slot entries are auto-gated to those modes' contexts.
   * Example: `modes: ['planner']`, `modes: ['des', 'hmi']`.
   */
  readonly modes?: ModeId[];

  /**
   * Called once when the plugin is registered via `viewer.use(plugin)`.
   *
   * Both `viewer` and `context` are passed. New plugins should prefer `context`
   * (a narrow capability bundle) over the full `viewer` pointer — see plan-182.
   *
   * Note: `context` is optional in the signature for backward compatibility, but
   * Phase 4 of plan-182 guarantees that it is always provided when the plugin is
   * loaded via `viewer.use()`. Plugins running against older viewer versions
   * (pre-Phase-4) won't receive a context — guard with `if (context)` if needed.
   */
  init?(viewer: RVViewer, context?: PluginContext): void;

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

  // ── Workspace mode hooks (plan-198) ──

  /**
   * Called when entering a mode this plugin participates in (after the plugin
   * has been (re-)enabled and any missed `onModelLoaded` replayed). Install
   * scene overlays, interaction handlers, raycast filters, gizmos here.
   *
   * CONTRACT: anything created here (Three.js objects, event listeners, DOM,
   * raycast filters, OutlinePass selections) MUST be fully released in
   * {@link onModeDeactivate} — the plugin instance persists across mode
   * switches, so undisposed resources leak.
   *
   * NOTE: do NOT create hover/selection highlights from this hook. The mode's
   * HighlightProfile is applied by RVHighlightPolicy on `mode-changed`, which
   * fires AFTER activate hooks — a highlight created here would render in the
   * PREVIOUS mode's profile and is unsupported. React to `mode-changed` (or
   * user interaction) instead.
   */
  onModeActivate?(mode: ModeId, viewer: RVViewer): void;

  /**
   * Called when leaving a mode this plugin participates in, BEFORE the plugin
   * is disabled (scene/model references are still valid). Tear down everything
   * created in {@link onModeActivate}. `from` is the mode being left (null only
   * in unusual boot edge cases).
   */
  onModeDeactivate?(mode: ModeId | null, viewer: RVViewer): void;

  /**
   * Called when the active 3D render backend changes (plan-256), e.g. Three.js
   * → Omniverse RTX stream. Interactive 3D plugins (raycast/gizmo/camera) have
   * no meaningful Three interaction under a non-Three backend and should no-op
   * / tear down open gizmos and drag handlers here. The viewer also neutralises
   * them centrally (skips per-frame `onRender` dispatch and hides the WebGL
   * canvas) — this hook is the explicit per-plugin signal on top of that.
   */
  onRenderBackendChanged?(backend: 'three' | 'omniverse', viewer: RVViewer): void;

  /** Viewer is being destroyed — clean up global listeners, DOM elements, etc. */
  dispose?(): void;
}
