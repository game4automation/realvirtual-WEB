// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVViewer — Public facade for the realvirtual Web Viewer core.
 *
 * Single entry point that owns the Three.js scene, simulation loop, and all
 * core subsystems. Framework-agnostic: no React, no MUI. Custom UIs bind
 * to this class via events and direct property access.
 *
 * Usage:
 *   const viewer = new RVViewer(document.getElementById('app'));
 *   await viewer.loadModel('./models/demo.glb');
 *   viewer.signalStore?.subscribe('ConveyorStart', console.log);
 *   viewer.on('drive-hover', ({ drive }) => console.log(drive?.name));
 */

import {
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  WebGLRenderer,
  AmbientLight,
  DirectionalLight,
  Color,
  Vector3,
  Vector2,
  Box3,
  Object3D,
  MOUSE,
  TOUCH,
  PlaneGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  ShaderMaterial,
  WebGLRenderTarget,
  DoubleSide,
  NoToneMapping,
  CanvasTexture,
  RepeatWrapping,
  NearestFilter,
  SRGBColorSpace,
  Spherical,
  BufferGeometry,
  Texture,
  Matrix4,
  Frustum,
} from 'three';
import type { Renderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { ToneMappingType, ShadowQuality, ProjectionType, VisualSettings } from './hmi/visual-settings-store';
import { loadVisualSettings } from './hmi/visual-settings-store';
import { CameraManager, type ViewportOffset } from './rv-camera-manager';
import { VisualSettingsManager } from './rv-visual-settings-manager';
import Stats from 'stats-gl';

import { EventEmitter } from './rv-events';
import { debug, logInfo } from './engine/rv-debug';
import { loadModelSettingsConfig } from './hmi/rv-settings-bundle';
import { DRAG_THRESHOLD_PX, DEFAULT_DPR_CAP } from './engine/rv-constants';
import { loadGLB, type LoadResult } from './engine/rv-scene-loader';
import {
  loadModelJsonConfig,
  extractGlbPluginConfig,
  mergeModelConfig,
  type ModelConfig,
} from './engine/rv-model-config';
import { loadExternalPlugin } from './engine/rv-plugin-loader';
import type { ModelPluginManager } from './rv-model-plugin-manager';
import { SimulationLoop } from './engine/rv-simulation-loop';
import { RVHighlightManager } from './engine/rv-highlight-manager';
import { RaycastManager, type ObjectHoverData, type ObjectUnhoverData, type ObjectClickData, type HoverableType } from './engine/rv-raycast-manager';
import type { RVDrive } from './engine/rv-drive';
import type { RVTransportManager } from './engine/rv-transport-manager';
import type { SignalStore } from './engine/rv-signal-store';
import type { RVDrivesPlayback } from './engine/rv-drives-playback';
import type { RVReplayRecording } from './engine/rv-replay-recording';
import type { RVLogicEngine } from './engine/rv-logic-engine';
import type { NodeRegistry, NodeSearchResult } from './engine/rv-node-registry';
import { TankFillManager } from './engine/rv-tank-fill';
import { PipeFlowManager } from './engine/rv-pipe-flow';
import { GizmoOverlayManager } from './engine/rv-gizmo-manager';
import { ComponentEventDispatcher } from './engine/rv-component-event-dispatcher';
import type { GroupRegistry } from './engine/rv-group-registry';
import { AutoFilterRegistry } from './engine/rv-auto-filter-registry';
import { ISOLATE_FOCUS_LAYER, HIGHLIGHT_OVERLAY_LAYER } from './engine/rv-group-registry';
import { registerFilterSubscriber, loadSearchSettings, isTypeEnabled } from './hmi/search-settings-store';
import { getTypesWithCapability, getRegisteredCapabilities } from './engine/rv-component-registry';
import type { RVViewerPlugin } from './rv-plugin';
import { UIPluginRegistry } from './rv-ui-registry';
import { isActiveForState } from './engine/rv-active-only';
import { LeftPanelManager } from './hmi/left-panel-manager';
import { SelectionManager } from './engine/rv-selection-manager';
import { ContextMenuStore } from './hmi/context-menu-store';
import type { ContextMenuTarget } from './hmi/context-menu-store';
import type { SelectionSnapshot } from './engine/rv-selection-manager';
import { isMobileDevice } from '../hooks/use-mobile-layout';
import { resetDynamicContexts } from './hmi/ui-context-store';
import { getAppConfig } from './rv-app-config';

// Base scene-background grayscale (0x9a9a9a / 255 ≈ 0.604). Multiplied by
// backgroundBrightness so brightness=1 reproduces the original default color.
const BG_BASE_SCALAR = 0x9a / 255;

// ─── Plugin Error Isolation ──────────────────────────────────────────────

/**
 * Call a plugin method with error isolation. If the method doesn't exist
 * or throws, the error is logged with the plugin's ID and swallowed.
 * Exported for unit testing — only used internally by RVViewer.
 */
export function callPlugin(
  plugin: RVViewerPlugin,
  method: string,
  ...args: unknown[]
): void {
  const fn = (plugin as unknown as Record<string, unknown>)[method];
  if (typeof fn !== 'function') return;
  try {
    fn.apply(plugin, args);
  } catch (e) {
    console.error(`[RVViewer] Plugin '${plugin.id}' ${method} error:`, e);
  }
}

// ─── Public Types ───────────────────────────────────────────────────────

// Re-export ViewportOffset from CameraManager (public API backward compat)
export type { ViewportOffset } from './rv-camera-manager';

export interface RVViewerOptions {
  /** Use WebGPU renderer (falls back to WebGL if unavailable). Default: false */
  useWebGPU?: boolean;
  /** Show checkerboard ground plane. Default: true */
  ground?: boolean;
  /** Auto-resize on window resize. Default: true */
  autoResize?: boolean;
  /** Enable native MSAA antialiasing (constructor-only, requires page reload to change). Default: false */
  antialias?: boolean;
}

export interface ViewerEvents {
  // ── Existing events (unchanged) ──
  'model-loaded': { result: LoadResult };
  'model-cleared': void;
  'drive-hover': { drive: RVDrive | null; clientX: number; clientY: number };
  'drive-focus': { drive: RVDrive | null; node: Object3D | null };
  'drive-chart-toggle': { open: boolean };
  'drive-filter': { filter: string; filteredDrives: RVDrive[] };
  'node-filter': { filter: string; filteredNodes: NodeSearchResult[]; tooMany: boolean };
  'sensor-chart-toggle': { open: boolean };
  'groups-overlay-toggle': { open: boolean };
  'exclusive-hover-mode': { mode: HoverableType | null };

  // ── Connection state ──
  'connection-state-changed': { state: 'Connected' | 'Disconnected'; previous: 'Connected' | 'Disconnected' };

  // ── Simulation events (emitted by plugins) ──
  'sensor-changed': { sensorPath: string; occupied: boolean };
  'mu-spawned': { totalSpawned: number };
  'mu-consumed': { totalConsumed: number };
  'drive-at-target': { drivePath: string; position: number };

  // ── Interface events (emitted by interface plugins) ──
  'interface-connected': { interfaceId: string; type: string };
  'interface-disconnected': { interfaceId: string; reason?: string };
  'interface-error': { interfaceId: string; error: string };
  'interface-data': { interfaceId: string; signals: Record<string, unknown> };

  // ── Generic raycast events (emitted by RaycastManager) ──
  'object-hover': ObjectHoverData | null;
  'object-unhover': ObjectUnhoverData;
  'object-click': ObjectClickData;

  // ── UI events (emitted by UI plugins) ──
  'camera-animation-done': { targetPath?: string };
  'object-clicked': { path: string; node: Object3D };
  'selection-changed': SelectionSnapshot;
  'object-focus': { path: string; node: Object3D };
  'panel-opened': { panelId: string };
  'panel-closed': { panelId: string };

  // ── Safety door events (engine listens, UI emits) ──
  /** Show or hide all safety-door gizmos at once.
   *  UI plugins emit this to toggle visibility from a warning tile etc. */
  'safety-door:show-all': { show: boolean };

  // ── XR events ──
  'xr-session-start': void;
  'xr-session-end': void;
  'xr-hit-test': { position: Float32Array; matrix: Float32Array };
  'xr-controller-select': { hand: 'left' | 'right'; position: { x: number; y: number; z: number } };

  // ── FPV events ──
  'fpv-enter': void;
  'fpv-exit': void;

  // ── Context Menu events ──
  'context-menu-request': { pos: { x: number; y: number }; path: string; node: Object3D };

  // ── Layout events ──
  'layout-transform-update': { path: string; position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number } };

  // ── Simulation pause events ──
  /** Fired when the overall simulation pause state transitions (idle ↔ paused).
   *  Plugins can subscribe to stop/resume external PLC I/O, freeze animations,
   *  disable cursor interactions, etc. Not fired when reasons are added/removed
   *  while already paused — only on the idle/paused transition. */
  'simulation-pause-changed': {
    /** New overall pause state. */
    paused: boolean;
    /** All currently active pause reasons (snapshot). */
    reasons: readonly string[];
    /** The specific reason that triggered this transition. */
    reason: string;
  };
}

// ─── Navigation Helper ──────────────────────────────────────────────────

/**
 * Apply navigation-sensitivity settings (rotate/pan/zoom speed + damping) to an
 * OrbitControls-compatible object. Extracted as a free function so it can be
 * unit-tested against a plain mock object without WebGL/Three.js setup.
 */
export function applyNavigationSettingsToControls(
  controls: {
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    dampingFactor: number;
  },
  s: Pick<VisualSettings, 'orbitRotateSpeed' | 'orbitPanSpeed' | 'orbitZoomSpeed' | 'orbitDampingFactor'>,
): void {
  controls.rotateSpeed = s.orbitRotateSpeed;
  controls.panSpeed = s.orbitPanSpeed;
  controls.zoomSpeed = s.orbitZoomSpeed;
  controls.dampingFactor = s.orbitDampingFactor;
}

// ─── RVViewer ───────────────────────────────────────────────────────────

export class RVViewer extends EventEmitter<ViewerEvents> {
  // --- Three.js context (read-only for custom UIs) ---
  readonly scene: Scene;
  private perspCamera!: PerspectiveCamera;
  private orthoCamera!: OrthographicCamera;
  private _activeCamera!: PerspectiveCamera | OrthographicCamera;
  /** The active camera (perspective or orthographic). */
  get camera(): PerspectiveCamera | OrthographicCamera { return this._activeCamera; }
  readonly renderer: Renderer;
  readonly controls: OrbitControls;
  readonly loop: SimulationLoop;
  private stats!: Stats;
  private statsReady = false;
  readonly isWebGPU: boolean;

  /** Whether native MSAA antialiasing is active (set at renderer creation, cannot change at runtime). */
  private _antialiasActive = false;
  /** Whether native MSAA antialiasing is active on the current renderer. */
  get antialiasActive(): boolean { return this._antialiasActive; }

  // --- Delegated Managers (internal implementation detail) ---
  /** @internal Camera projection, animation, and viewport offset logic. */
  private _cameraManager!: CameraManager;
  /** @internal Lighting, tone mapping, shadows, DPR settings. */
  private _visualSettings!: VisualSettingsManager;

  // --- Highlight system (always available) ---
  readonly highlighter: RVHighlightManager;

  // --- Generic gizmo overlay system (always available) ---
  /** Central 3D-overlay/gizmo system. Used by WebSensor and other components. */
  readonly gizmoManager: GizmoOverlayManager;

  // --- Component event dispatcher (routes viewer events → per-component callbacks) ---
  /** Dispatches object-hover/clicked/selection-changed to RVComponent.onHover/onClick/onSelect. */
  componentEventDispatcher: ComponentEventDispatcher | null = null;

  // --- Connection State ---
  /** Global connection state — controls which subsystems run based on their ActiveOnly mode. */
  private _connectionState: 'Connected' | 'Disconnected' = 'Connected';

  /** Current connection state ('Connected' or 'Disconnected'). */
  get connectionState(): 'Connected' | 'Disconnected' { return this._connectionState; }

  /**
   * Set the global connection state. Notifies all plugins and emits
   * 'connection-state-changed' event. Subsystems are guarded in fixedUpdate().
   */
  setConnectionState(state: 'Connected' | 'Disconnected'): void {
    if (state === this._connectionState) return;
    const previous = this._connectionState;
    this._connectionState = state;

    // Notify plugins (skip disabled)
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onConnectionStateChanged', state, this);
    }

    this.emit('connection-state-changed', { state, previous });
  }

  // --- Simulation state (populated after loadModel) ---
  signalStore: SignalStore | null = null;
  registry: NodeRegistry | null = null;
  drives: RVDrive[] = [];
  /** Unified raycast manager (replaces the old driveHover). */
  raycastManager: RaycastManager | null = null;
  transportManager: RVTransportManager | null = null;
  logicEngine: RVLogicEngine | null = null;
  tankFillManager: TankFillManager | null = null;
  pipeFlowManager: PipeFlowManager | null = null;
  playback: RVDrivesPlayback | null = null;
  groups: GroupRegistry | null = null;
  autoFilters: AutoFilterRegistry | null = null;

  /**
   * @deprecated Use `viewer.raycastManager` instead. This getter returns
   * an adapter that delegates to RaycastManager for backward compatibility.
   */
  get driveHover(): {
    enabled: boolean;
    hoveredDrive: RVDrive | null;
    pointerClientX: number;
    pointerClientY: number;
    lastRayOrigin: Vector3 | null;
    lastRayDirection: Vector3 | null;
    setDriveTargets(drives: RVDrive[]): void;
    updateFromXRController(origin: Vector3, direction: Vector3): void;
    dispose(): void;
  } | null {
    if (!this.raycastManager) return null;
    const rm = this.raycastManager;
    const self = this;
    return {
      get enabled() { return rm.enabled; },
      set enabled(v: boolean) { rm.setEnabled(v); },
      get hoveredDrive() {
        if (!rm.hoveredNode || rm.hoveredNodeType !== 'Drive') return null;
        return self.registry?.findInParent<RVDrive>(rm.hoveredNode, 'Drive') ?? null;
      },
      get pointerClientX() { return rm.pointerClientX; },
      get pointerClientY() { return rm.pointerClientY; },
      get lastRayOrigin() { return rm.lastRayOrigin; },
      get lastRayDirection() { return rm.lastRayDirection; },
      setDriveTargets(_drives: RVDrive[]) {
        // No-op: grouped BVH raycast geometry replaces per-target registration
      },
      updateFromXRController(origin: Vector3, direction: Vector3) {
        rm.updateFromXRController(origin, direction);
      },
      dispose() {
        rm.dispose();
      },
    };
  }

  // --- Plugin System ---

  /** All registered core plugins. */
  private _plugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onFixedUpdatePre, sorted by order. */
  private _prePlugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onFixedUpdatePost, sorted by order. */
  private _postPlugins: RVViewerPlugin[] = [];
  /** Cached: only plugins with onRender, sorted by order. */
  private _renderPlugins: RVViewerPlugin[] = [];
  /** Flag: a plugin handles transport (kinematic transportManager.update is skipped). */
  private _physicsPluginActive = false;
  /** IDs of plugins that have been disabled via disablePlugin(). */
  private _disabledIds = new Set<string>();
  /** Last successful load result (for retroactive onModelLoaded). */
  private _lastLoadResult: LoadResult | null = null;
  /** Lazy plugin factories: ID → async import factory (code-split by Vite). */
  private _lazyFactories = new Map<string, () => Promise<{ default: unknown }>>();
  /** URL of the currently loaded model (for reloadModel). */
  private _currentModelUrl: string | null = null;
  /** Original model URL set by main.ts before loadModel (survives blob URL override). */
  pendingModelUrl: string | null = null;
  /** True while OrbitControls is actively rotating/panning/pinching. */
  private _isOrbiting = false;
  /** Pointer position at pointerdown — used for drag-distance threshold. */
  private _pointerDownPos: { x: number; y: number } | null = null;
  /** Right-button pointer position at pointerdown — used for context menu drag guard. */
  private _rightDownPos: { x: number; y: number } | null = null;
  /** Long-press timer ID for touch context menu. */
  private _longPressTimer: ReturnType<typeof setTimeout> | null = null;
  /** Stored position at touch start for long-press context menu. */
  private _longPressPos: { x: number; y: number } | null = null;

  /** Available model entries for the model selector UI. */
  availableModels: Array<{ url: string; label: string }> = [];

  /** UI plugin registry for React slot rendering. */
  readonly uiRegistry = new UIPluginRegistry();

  /** Centralized left-panel coordination (mutual exclusion, ButtonPanel offset). */
  readonly leftPanelManager = new LeftPanelManager();

  /** Central selection state (multi-select, Escape-to-deselect, selection highlights). */
  readonly selectionManager = new SelectionManager();

  /** Plugin-extensible context menu (right-click / long-press). */
  readonly contextMenu = new ContextMenuStore();

  /**
   * Register a plugin. Sorted into cached lifecycle lists.
   * If the plugin has `slots`, its UI entries are auto-registered into the HMI.
   * Duplicate IDs are rejected with a warning. Chainable.
   */
  use(plugin: RVViewerPlugin): this {
    if (this._plugins.some((p) => p.id === plugin.id)) {
      console.warn(`[RVViewer] Plugin '${plugin.id}' already registered`);
      return this;
    }
    this._plugins.push(plugin);

    // Insert into cached lists sorted by order
    const insertSorted = (list: RVViewerPlugin[], p: RVViewerPlugin) => {
      list.push(p);
      list.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    };
    if (plugin.onFixedUpdatePre) insertSorted(this._prePlugins, plugin);
    if (plugin.onFixedUpdatePost) insertSorted(this._postPlugins, plugin);
    if (plugin.onRender) insertSorted(this._renderPlugins, plugin);

    if (plugin.handlesTransport) this._physicsPluginActive = true;

    // Auto-register UI slot entries if the plugin provides them
    if (plugin.slots && plugin.slots.length > 0) {
      this.uiRegistry.register(plugin);
    }

    // Retroactive: if model already loaded, call onModelLoaded immediately (skip disabled)
    if (this.drives.length > 0 && this._lastLoadResult && plugin.onModelLoaded && !this._disabledIds.has(plugin.id)) {
      try {
        plugin.onModelLoaded(this._lastLoadResult, this);
      } catch (e) {
        console.error(`[RVViewer] Plugin '${plugin.id}' onModelLoaded error:`, e);
      }
    }
    return this;
  }

  /** Type-safe plugin lookup by ID. */
  getPlugin<T extends RVViewerPlugin>(id: string): T | undefined {
    return this._plugins.find((p) => p.id === id) as T | undefined;
  }

  /**
   * Disable a plugin by ID. The plugin is removed from the cached pre/post/render
   * arrays and skipped in onModelLoaded, onModelCleared, and onConnectionStateChanged.
   * The plugin remains in _plugins so dispose() still runs (prevents memory leaks).
   */
  disablePlugin(id: string): void {
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._disabledIds.add(id);
  }

  /**
   * Fully remove a non-core plugin: dispose, remove from all arrays,
   * unregister UI slots and context menu entries.
   * Core plugins (core: true) cannot be removed — use disablePlugin() instead.
   */
  removePlugin(id: string): boolean {
    const idx = this._plugins.findIndex(p => p.id === id);
    if (idx < 0) return false;
    const plugin = this._plugins[idx];
    if (plugin.core) {
      console.warn(`[RVViewer] Cannot remove core plugin '${id}' — use disablePlugin() instead`);
      return false;
    }
    if (plugin.dispose) {
      try { plugin.dispose(); } catch (e) {
        console.error(`[RVViewer] Plugin '${id}' dispose error:`, e);
      }
    }
    this._plugins.splice(idx, 1);
    this._prePlugins = this._prePlugins.filter(p => p.id !== id);
    this._postPlugins = this._postPlugins.filter(p => p.id !== id);
    this._renderPlugins = this._renderPlugins.filter(p => p.id !== id);
    this._disabledIds.delete(id);
    this.uiRegistry.unregister(id);
    this.contextMenu.unregister(id);
    // Re-evaluate physics plugin state
    this._physicsPluginActive = this._plugins.some(p => p.handlesTransport);
    return true;
  }

  /** Model plugin manager — handles per-model plugin loading/unloading. */
  modelPluginManager: ModelPluginManager | null = null;

  /**
   * Register a lazy plugin factory. The factory is only called when a model
   * actually requests the plugin (via rv_plugins / modelname.json).
   * Vite automatically code-splits lazy factories into separate chunks.
   */
  registerLazy(id: string, factory: () => Promise<{ default: unknown }>): this {
    this._lazyFactories.set(id, factory);
    return this;
  }

  /**
   * Resolve a plugin by ID through the three-level resolution chain:
   *   1. Already registered (via `use()`)  → return existing
   *   2. Lazy built-in (via `registerLazy()`) → import chunk, instantiate, register
   *   3. External plugin (`models/plugins/{id}.js`) → dynamic import, register
   *   4. Not found → return null (no crash)
   */
  async resolvePlugin(id: string): Promise<RVViewerPlugin | null> {
    // 1. Already registered?
    const existing = this._plugins.find(p => p.id === id);
    if (existing) return existing;

    // 2. Lazy built-in?
    const factory = this._lazyFactories.get(id);
    if (factory) {
      try {
        const mod = await factory();
        const PluginOrInstance = mod.default;
        const plugin = typeof PluginOrInstance === 'function'
          ? new (PluginOrInstance as new () => RVViewerPlugin)()
          : PluginOrInstance as RVViewerPlugin;
        if (plugin && plugin.id) {
          this.use(plugin);
          return plugin;
        }
      } catch (e) {
        console.warn(`[RVViewer] Failed to load lazy plugin '${id}':`, e);
      }
      return null;
    }

    // 3. External plugin?
    const baseUrl = this._currentModelUrl
      ? this._currentModelUrl.substring(0, this._currentModelUrl.lastIndexOf('/'))
      : '.';
    const plugin = await loadExternalPlugin(id, baseUrl);
    if (plugin) {
      this.use(plugin);
      return plugin;
    }

    // 4. Not found
    console.warn(`[RVViewer] Plugin '${id}' not found (not registered, no lazy factory, no external)`);
    return null;
  }

  // ─── Exclusive Hover Mode ──────────────────────────────────────────

  /** The currently active exclusive hover mode (only this type is hoverable). null = all types. */
  private _exclusiveHoverMode: HoverableType | null = null;
  get exclusiveHoverMode(): HoverableType | null { return this._exclusiveHoverMode; }

  /**
   * Set an exclusive hover mode — only the specified type will be hoverable.
   * Pass null to restore default behavior (all registered types hoverable).
   * Any existing exclusive mode is automatically deactivated.
   */
  setExclusiveHoverMode(mode: HoverableType | null): void {
    if (mode === this._exclusiveHoverMode) return;
    this._exclusiveHoverMode = mode;

    if (!this.raycastManager) return;
    if (mode) {
      // Enable only the requested type, disable all others in the exclusive group
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, type === mode);
      }
    } else {
      // Default: all exclusive-group types hoverable
      for (const type of getTypesWithCapability('exclusiveHoverGroup')) {
        this.raycastManager.enableHoverType(type, true);
      }
    }
    this.emit('exclusive-hover-mode', { mode });
  }

  // ─── Drive Chart ──────────────────────────────────────────────────

  /** Whether the drive chart overlay is open. */
  private _driveChartOpen = false;
  get driveChartOpen(): boolean { return this._driveChartOpen; }

  /** Toggle the drive chart overlay. Exclusive with other chart modes. */
  toggleDriveChart(forceOpen?: boolean): void {
    this._driveChartOpen = forceOpen ?? !this._driveChartOpen;
    if (this._driveChartOpen) {
      // Close other exclusive modes
      if (this._sensorChartOpen) {
        this._sensorChartOpen = false;
        this.emit('sensor-chart-toggle', { open: false });
      }
      this.setExclusiveHoverMode('Drive');
      // Isolate drives — dims non-drive geometry
      this.autoFilters?.isolate('Drive', { dimOpacity: 0.55, dimDesaturate: true });
      this.markShadowsDirty();
    } else {
      this.setExclusiveHoverMode(null);
      this.autoFilters?.showAll();
      this.markShadowsDirty();
    }
    this.emit('drive-chart-toggle', { open: this._driveChartOpen });
  }

  // ─── Sensor Chart ─────────────────────────────────────────────────

  /** Whether the sensor chart overlay is open. */
  private _sensorChartOpen = false;
  get sensorChartOpen(): boolean { return this._sensorChartOpen; }

  /** Toggle the sensor chart overlay. Exclusive with other chart modes. */
  toggleSensorChart(forceOpen?: boolean): void {
    this._sensorChartOpen = forceOpen ?? !this._sensorChartOpen;
    if (this._sensorChartOpen) {
      // Close other exclusive modes
      if (this._driveChartOpen) {
        this._driveChartOpen = false;
        this.emit('drive-chart-toggle', { open: false });
      }
      this.setExclusiveHoverMode('Sensor');
      const sensors = this.transportManager?.sensors ?? [];
      const nodes = sensors.map((s) => s.node);
      if (nodes.length > 0) {
        this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
        this.fitToNodes(nodes);
      }
    } else {
      this.setExclusiveHoverMode(null);
      this.highlighter.clear();
    }
    this.emit('sensor-chart-toggle', { open: this._sensorChartOpen });
  }

  /** Whether the groups overlay is open. */
  private _groupsOverlayOpen = false;
  get groupsOverlayOpen(): boolean { return this._groupsOverlayOpen; }

  /** Toggle the groups overlay panel. */
  toggleGroupsOverlay(forceOpen?: boolean): void {
    this._groupsOverlayOpen = forceOpen ?? !this._groupsOverlayOpen;
    this.emit('groups-overlay-toggle', { open: this._groupsOverlayOpen });
  }

  /**
   * Mark shadows as dirty — call after visibility changes (e.g. group toggle)
   * so the shadow map is re-rendered on the next frame.
   */
  markShadowsDirty(): void {
    this._shadowsDirty = true;
    this._renderDirty = true;
  }

  /**
   * Mark the render pass as dirty so the next frame renders.
   * Call from plugins that need continuous rendering (e.g. FPV movement).
   */
  markRenderDirty(): void {
    this._renderDirty = true;
  }

  /** The ground plane mesh, or null if ground was disabled. */
  get groundMesh(): Mesh | null {
    return this._groundMesh;
  }

  /** Whether the ground/floor plane is visible. No-op if ground was disabled at construction. */
  get groundEnabled(): boolean {
    return this._groundMesh?.visible ?? false;
  }
  set groundEnabled(v: boolean) {
    if (!this._groundMesh) return;
    if (this._groundMesh.visible === v) return;
    this._groundMesh.visible = v;
    this._renderDirty = true;
  }

  /**
   * Floor brightness multiplier (0 = black, 1 = default, 2 = double).
   * Scales the ground material's base color — the checker texture is
   * multiplied by this color in the fragment shader, so brightness 0.5
   * gives a half-bright floor and brightness 2 gives a double-bright one.
   */
  get groundBrightness(): number {
    if (!this._groundMesh) return 1.0;
    const mat = this._groundMesh.material as MeshStandardMaterial;
    // Color is set uniformly (r==g==b), read back from r
    return mat.color?.r ?? 1.0;
  }
  set groundBrightness(v: number) {
    if (!this._groundMesh) return;
    const clamped = Math.max(0, Math.min(2, v));
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (!mat.color) return;
    if (mat.color.r === clamped && mat.color.g === clamped && mat.color.b === clamped) return;
    mat.color.setScalar(clamped);
    this._renderDirty = true;
  }

  /**
   * Scene background brightness multiplier (0 = black, 1 = default gray, 2 = white).
   * Scales the base 0x9a9a9a gray uniformly so brightness=1 reproduces the original look.
   */
  get backgroundBrightness(): number {
    return this._backgroundBrightness;
  }
  set backgroundBrightness(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._backgroundBrightness === clamped) return;
    this._backgroundBrightness = clamped;
    const bg = this.scene.background;
    if (bg && (bg as Color).isColor) {
      (bg as Color).setScalar(Math.min(1, BG_BASE_SCALAR * clamped));
      this._renderDirty = true;
    }
  }

  /**
   * Floor checker pattern contrast multiplier (0 = flat midgray, 1 = default, 2 = doubled spread).
   * Regenerates the checker CanvasTexture in place.
   */
  get checkerContrast(): number {
    return this._checkerContrast;
  }
  set checkerContrast(v: number) {
    const clamped = Math.max(0, Math.min(2, v));
    if (this._checkerContrast === clamped) return;
    this._checkerContrast = clamped;
    if (!this._groundMesh || !this._checkerCanvas) return;
    this.drawCheckerPattern(this._checkerCanvas, clamped);
    const mat = this._groundMesh.material as MeshStandardMaterial;
    if (mat.map) {
      (mat.map as CanvasTexture).needsUpdate = true;
      this._renderDirty = true;
    }
  }


  /**
   * Cancel any in-progress camera animation immediately.
   * Used by FPV to prevent the animation overwriting the camera position.
   */
  cancelCameraAnimation(): void {
    this._cameraManager.cancelCameraAnimation();
  }

  // ─── Shared View Mode ────────────────────────────────────────────

  /** Whether shared view mode is active (camera controlled by remote operator). */
  private _sharedViewActive = false;
  get sharedViewActive(): boolean { return this._sharedViewActive; }

  /**
   * Enable or disable shared view mode — used by multiuser shared view.
   * When active: controls disabled, raycast disabled, _isOrbiting cleared.
   * When inactive: controls and raycast re-enabled.
   *
   * Rejects toggle if FPV or XR is active (returns false).
   * ALWAYS use this method instead of writing controls.enabled directly.
   *
   * @returns true if the toggle was applied, false if rejected.
   */
  setSharedViewMode(active: boolean): boolean {
    // Check FPV conflict
    const fpv = this.getPlugin<{ id: string; toggle(): void }>('fpv');
    if (active && fpv && (this as unknown as { _fpvActive?: boolean })._fpvActive) return false;

    // Check XR conflict
    const xr = this.getPlugin('webxr') as { isPresenting?: boolean } | undefined;
    if (active && xr?.isPresenting) return false;

    this._sharedViewActive = active;
    this.controls.enabled = !active;
    this._isOrbiting = false;
    this.raycastManager?.setEnabled(!active);
    this.controls.update();
    this._renderDirty = true;
    return true;
  }

  // ─── Simulation Pause ────────────────────────────────────────────

  /**
   * Pause or resume the fixed-timestep simulation with a named reason.
   *
   * Multiple reasons can hold a pause simultaneously (AR placement, layout edit,
   * shared-view session, user-initiated pause button, layout-planner drag, etc.).
   * The simulation resumes only after every reason has released its hold.
   *
   * Rendering is unaffected — onRender still fires each frame, so the 3D view,
   * highlights, gizmos, and camera passthrough stay live. Only `onFixedUpdate`
   * is skipped, which freezes drives, transport surfaces, sensors, logic steps,
   * physics, sources, and sinks.
   *
   * Plugins can subscribe to `'simulation-pause-changed'` to react to transitions
   * (e.g. disconnect WebSocket commands, stop signal polling, dim the scene).
   *
   * @param reason  Short, stable identifier per caller — e.g. `'ar-placement'`,
   *                `'layout-edit'`, `'user'`, `'shared-view'`. Same reason can be
   *                set/cleared multiple times; only the set state matters.
   * @param paused  `true` to request pause, `false` to release this reason.
   */
  setSimulationPaused(reason: string, paused: boolean): void {
    const changed = this.loop.setPaused(reason, paused);
    if (changed) {
      this.emit('simulation-pause-changed', {
        paused: this.loop.isPaused,
        reasons: this.loop.pauseReasons,
        reason,
      });
    }
  }

  /** True if any reason is currently holding the simulation paused. */
  get isSimulationPaused(): boolean { return this.loop.isPaused; }

  /** Snapshot of active pause reasons (for diagnostics / UI badges). */
  get simulationPauseReasons(): readonly string[] { return this.loop.pauseReasons; }

  // ─── Unified Node Filter ──────────────────────────────────────────

  private static readonly MAX_HIGHLIGHT_RESULTS = 20;

  /** Current drive search filter string (derived from node filter). */
  private _driveFilter = '';
  get driveFilter(): string { return this._driveFilter; }

  /** Drives matching the current filter (all drives if filter is empty). */
  private _filteredDrives: RVDrive[] = [];
  get filteredDrives(): RVDrive[] { return this._filteredDrives.length > 0 || this._driveFilter ? this._filteredDrives : this.drives; }

  /** Current node search filter string. */
  private _nodeFilter = '';
  get nodeFilter(): string { return this._nodeFilter; }

  /** Nodes matching the current filter. */
  private _filteredNodes: NodeSearchResult[] = [];
  get filteredNodes(): NodeSearchResult[] { return this._filteredNodes; }

  /** Unified search: filters ALL registered nodes. Subscribers extract their subset via events. */
  filterNodes(term: string): void {
    this._nodeFilter = term;
    this._driveFilter = term;

    if (!term.trim()) {
      this._filteredNodes = [];
      this._filteredDrives = [];
      // Restore chart-specific highlights if chart is open
      if (this._driveChartOpen) {
        const nodes = this.drives.map((d) => d.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes);
      } else if (this._sensorChartOpen) {
        const sensors = this.transportManager?.sensors ?? [];
        const nodes = sensors.map((s) => s.node);
        if (nodes.length > 0) this.highlighter.highlightMultiple(nodes, { includeSensorViz: true });
      } else {
        this.highlighter.clear();
      }
      this.emit('node-filter', { filter: '', filteredNodes: [], tooMany: false });
      this.emit('drive-filter', { filter: '', filteredDrives: [] });
      return;
    }

    const allResults = this.registry?.search(term) ?? [];
    // Apply subscriber type filter from settings
    const settings = loadSearchSettings();
    const results = allResults.filter(r => isTypeEnabled(settings, r.types));
    this._filteredNodes = results;
    const tooMany = results.length >= RVViewer.MAX_HIGHLIGHT_RESULTS;

    // Highlight matching nodes (only if below threshold and highlight enabled)
    if (settings.highlightEnabled && !tooMany && results.length > 0) {
      const nodes = results.map(r => r.node);
      this.highlighter.highlightMultiple(nodes);
    } else {
      this.highlighter.clear();
    }

    // Derive drive-filter from node-filter (backwards compat)
    this._filteredDrives = this.drives.filter((d) =>
      results.some((r) => r.node === d.node)
    );

    this.emit('node-filter', { filter: term, filteredNodes: results, tooMany });
    this.emit('drive-filter', { filter: term, filteredDrives: this._filteredDrives });
  }

  /** Backwards-compatible wrapper. Delegates to filterNodes(). */
  filterDrives(term: string): void {
    this.filterNodes(term);
  }

  /** Drive pinned by a card click (shown in tooltip until cleared). */
  focusedDrive: RVDrive | null = null;
  focusedNode: Object3D | null = null;

  // --- Dev Tools stats (polled by React DevToolsTab) ---
  /** Current FPS (updated every 500ms). */
  currentFps = 0;
  /** Current frame time in ms (updated every 500ms). */
  currentFrameTime = 0;
  /** Info from the last GLB load. */
  lastLoadInfo: { glbSize: string; loadTime: string } | null = null;

  /** Load model with progress overlay (set by main.ts bootstrap). */
  loadModelWithProgress: ((url: string) => Promise<void>) | null = null;

  /**
   * Optional gate promise that must resolve before model loading begins.
   * Set by plugins like LoginGatePlugin to defer heavy loading until the
   * user has authenticated — avoids main-thread contention that causes
   * laggy login UI.
   */
  loadGate: Promise<void> | null = null;

  // --- XR state ---
  private _savedBackground: Color | null = null;
  private _savedShadowState = true;

  // --- Internal ---
  private replayRecordings: RVReplayRecording[] = [];
  private currentModel: Object3D | null = null;
  private sceneFixtures = new Set<Object3D>();
  private resizeHandler: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private simTickCount = 0;
  private fpsFrameCount = 0;
  private fpsAccumTime = 0;
  private rendererInfoFrameCount = 0;
  private _lastGeoCount = 0;
  private _lastTexCount = 0;
  private ambientLight!: AmbientLight;
  private dirLight!: DirectionalLight;

  // --- Post-processing (WebGL only) ---
  private _composer: EffectComposer | null = null;
  private _gtaoPass: GTAOPass | null = null;
  private _bloomPass: UnrealBloomPass | null = null;
  private _ssaoEnabled = false;
  private _bloomEnabled = false;

  private constructor(
    container: HTMLElement,
    renderer: Renderer,
    options: RVViewerOptions = {},
  ) {
    super();

    const showGround = options.ground ?? true;
    const autoResize = options.autoResize ?? true;

    // --- Renderer (already configured by create/_configureAndCreate) ---
    this.renderer = renderer;
    this.isWebGPU = this._detectWebGPU(renderer);
    this._antialiasActive = options.antialias ?? false;

    // --- Scene ---
    this.scene = new Scene();
    // Default background = 0x9a9a9a gray (scalar 0.604) scaled by backgroundBrightness.
    this.scene.background = new Color().setScalar(BG_BASE_SCALAR * this._backgroundBrightness);
    this.highlighter = new RVHighlightManager(this.scene);
    // Lazy getter for raycastManager: it's created later (loadGLB time), so a closure
    // is needed instead of passing the value directly. Once available, every gizmo
    // automatically participates in raycasting (hover/click resolves to owner node).
    this.gizmoManager = new GizmoOverlayManager(this.scene, () => this.raycastManager);

    // --- Camera ---
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const aspect = w / h;
    this.perspCamera = new PerspectiveCamera(45, aspect, 0.01, 1000);
    this.perspCamera.position.set(3, 2.5, 4);
    this.perspCamera.lookAt(0, 0.5, 0);
    // Enable highlight-overlay layer so hover/select wireframes render in
    // normal mode. The 3-pass isolate renderer manages this layer per-pass.
    this.perspCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);

    const frustumHalf = 5;
    this.orthoCamera = new OrthographicCamera(
      -frustumHalf * aspect, frustumHalf * aspect, frustumHalf, -frustumHalf, 0.01, 1000,
    );
    this.orthoCamera.position.set(3, 2.5, 4);
    this.orthoCamera.lookAt(0, 0.5, 0);
    this.orthoCamera.layers.enable(HIGHLIGHT_OVERLAY_LAYER);

    this._activeCamera = this.perspCamera;

    // --- Lighting ---
    this.ambientLight = new AmbientLight(0xffffff, 1.8);
    this.scene.add(this.ambientLight);
    this.sceneFixtures.add(this.ambientLight);

    this.dirLight = new DirectionalLight(0xffffff, 1.5);
    // Match Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    this.dirLight.position.set(1.45, 9.55, -2.57);
    this.dirLight.castShadow = false;
    this.dirLight.shadow.mapSize.set(1024, 1024);
    this.dirLight.shadow.camera.near = 0.1;
    this.dirLight.shadow.camera.far = 50;
    this.dirLight.shadow.camera.left = -15;
    this.dirLight.shadow.camera.right = 15;
    this.dirLight.shadow.camera.top = 15;
    this.dirLight.shadow.camera.bottom = -15;
    this.dirLight.shadow.bias = -0.0005;
    this.dirLight.shadow.normalBias = 0.02;
    this.dirLight.shadow.intensity = 0.5;
    this.dirLight.shadow.radius = 2;

    // --- Delegated Managers ---
    // VisualSettingsManager reads/writes shared state on `this` (the facade).
    // We pass a thin object whose property accessors proxy back to the viewer.
    const self = this;
    this._visualSettings = new VisualSettingsManager({
      scene: this.scene,
      renderer: this.renderer,
      ambientLight: this.ambientLight,
      dirLight: this.dirLight,
      sceneFixtures: this.sceneFixtures,
      get _shadowsDirty() { return self._shadowsDirty; },
      set _shadowsDirty(v: boolean) { self._shadowsDirty = v; },
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
    });

    // --- Ground ---
    if (showGround) {
      const ground = this.createGroundFade();
      ground.visible = true;
      this.scene.add(ground);
      this.sceneFixtures.add(ground);
      this._groundMesh = ground;
    }

    // --- Renderer-dependent init ---
    renderer.domElement.style.touchAction = 'none';
    container.appendChild(renderer.domElement);

    // --- Controls ---
    this.controls = new OrbitControls(this._activeCamera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.5, 0);
    this.controls.mouseButtons = {
      LEFT: -1 as MOUSE,
      MIDDLE: MOUSE.PAN,
      RIGHT: MOUSE.ROTATE,
    };
    this.controls.touches = {
      ONE: TOUCH.ROTATE,
      TWO: TOUCH.DOLLY_PAN,
    };
    // Apply navigation-sensitivity settings (rotate/pan/zoom/damping) from store.
    const navSettings = loadVisualSettings();
    applyNavigationSettingsToControls(this.controls, navSettings);
    this.controls.update();

    // Track orbit/pan/pinch gesture state to suppress selection & hover highlighting
    this.controls.addEventListener('start', () => {
      this._isOrbiting = true;
      if (this.raycastManager) this.raycastManager.setEnabled(false);
      this._cancelLongPress();
    });
    this.controls.addEventListener('end', () => {
      this._isOrbiting = false;
      if (this.raycastManager) this.raycastManager.setEnabled(true);
      // Keep rendering long enough for damping decay to fall below 1% velocity.
      // Budget adapts to current dampingFactor; capped at 300 frames (~5 s @ 60 fps).
      this._dampingFramesRemaining = Math.min(
        Math.ceil(Math.log(0.01) / Math.log(1 - this.controls.dampingFactor)),
        300,
      );
    });
    // Mark render dirty on any controls change (orbit, pan, zoom). Shadow
    // dirty is more nuanced: in the legacy tight-fit mode the shadow camera
    // adapts to the view frustum so every camera change needs a re-fit, but
    // once the uber-merge creates a static shadow caster we switch to a
    // full-scene shadow camera (see `_fitShadowToView`). That camera is
    // fixed at scene center with `_shadowPadMax` bounds and is completely
    // independent of where the user is currently looking, so rotation /
    // pan / zoom produce an identical shadow map — re-rendering it every
    // frame during interaction would literally double triangle throughput.
    this.controls.addEventListener('change', () => {
      this._renderDirty = true;
      const hasStaticUberCaster = (this._lastLoadResult?.uberMergeResult?.mergedCount ?? 0) > 0;
      if (!hasStaticUberCaster) {
        this._shadowsDirty = true;
      }
    });

    // CameraManager — uses proxy state to read/write shared fields on the facade.
    this._cameraManager = new CameraManager({
      perspCamera: this.perspCamera,
      orthoCamera: this.orthoCamera,
      get _activeCamera() { return self._activeCamera; },
      set _activeCamera(v) { self._activeCamera = v; },
      controls: this.controls,
      renderer: this.renderer,
      get _renderDirty() { return self._renderDirty; },
      set _renderDirty(v: boolean) { self._renderDirty = v; },
      leftPanelManager: this.leftPanelManager,
      getPlugin: <T>(id: string) => this.getPlugin(id) as T | undefined,
    });

    // --- Canvas events ---
    this._bindCanvasEvents(renderer.domElement);

    // --- XR (only for WebGL backend) ---
    this._setupXR(renderer, container);

    // --- Stats-gl ---
    this._setupStats(renderer);

    // --- Simulation Loop ---
    this.loop = new SimulationLoop(renderer);
    this.loop.onFixedUpdate = (dt: number) => this.fixedUpdate(dt);
    this.loop.onRender = () => this.render();
    this.loop.start();

    // --- Resize (ResizeObserver on container — handles soft keyboard, orientation) ---
    if (autoResize) {
      let resizeRafId = 0;
      this.resizeHandler = () => {
        const w = container.clientWidth || window.innerWidth;
        const h = container.clientHeight || window.innerHeight;
        const aspect = w / h;
        this.perspCamera.aspect = aspect;
        this.perspCamera.updateProjectionMatrix();
        // Keep ortho frustum in sync
        const dist = this.orthoCamera.position.distanceTo(this.controls.target);
        const halfH = dist * Math.tan((this.perspCamera.fov * Math.PI / 180) / 2);
        this.orthoCamera.left = -halfH * aspect;
        this.orthoCamera.right = halfH * aspect;
        this.orthoCamera.top = halfH;
        this.orthoCamera.bottom = -halfH;
        this.orthoCamera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        if (this._composer) {
          this._composer.setSize(w, h);
          this._applyHalfResPostProcessing();
        }
        this._renderDirty = true;
      };
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => this.resizeHandler!());
      });
      this.resizeObserver.observe(container);
      // Fallback for browsers without ResizeObserver on window events
      window.addEventListener('resize', this.resizeHandler);
    }

    logInfo(`realvirtual WEB — Ready (${this.isWebGPU ? 'WebGPU' : 'WebGL'})`);
  }

  // ─── Post-Processing Pipeline (WebGL only) ─────────────────────────

  /** Whether any post-processing effect is active (determines composer vs direct render).
   *
   * Always false while a WebXR session is presenting — the EffectComposer renders to its
   * own offscreen render targets, but WebXR requires the scene be rendered directly into
   * the XR session's framebuffer each frame. Routing through composer in XR shows only
   * the camera passthrough (no 3D content). In XR we always go through the direct path.
   */
  private get _useComposer(): boolean {
    if (this.isWebGPU) return false;
    const xr = (this.renderer as unknown as WebGLRenderer).xr;
    if (xr?.isPresenting) return false;
    return !!this._composer && (this._ssaoEnabled || this._bloomEnabled);
  }

  /** Internal buffers for GTAO and Bloom run at half resolution for performance. */
  private static readonly PP_SCALE = 0.5;

  /** Lazily create the EffectComposer with all post-processing passes. */
  private _ensureComposer(): void {
    if (this._composer || this.isWebGPU) return;
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    const hw = Math.max(1, Math.floor(w * RVViewer.PP_SCALE));
    const hh = Math.max(1, Math.floor(h * RVViewer.PP_SCALE));
    const composer = new EffectComposer(this.renderer as unknown as WebGLRenderer);

    // Enable MSAA on composer render targets to match renderer antialias setting
    if (this._antialiasActive) {
      composer.renderTarget1.samples = 4;
      composer.renderTarget2.samples = 4;
    }

    // Pass 1: Scene render (full resolution)
    composer.addPass(new RenderPass(this.scene, this.camera));

    // Pass 2: GTAO (ambient occlusion) — half-res internal buffers
    const gtaoPass = new GTAOPass(this.scene, this.camera, hw, hh);
    gtaoPass.output = GTAOPass.OUTPUT.Default;
    gtaoPass.blendIntensity = 1.0;
    gtaoPass.updateGtaoMaterial({ radius: 0.15, scale: 1.0, thickness: 0.5 });
    gtaoPass.enabled = this._ssaoEnabled;
    composer.addPass(gtaoPass);

    // Pass 3: Bloom (glow on bright areas) — half-res internal buffers
    const bloomPass = new UnrealBloomPass(new Vector2(hw, hh), 0.5, 0.4, 0.85);
    bloomPass.enabled = this._bloomEnabled;
    composer.addPass(bloomPass);

    // Pass 4: Output (tone mapping + color space)
    composer.addPass(new OutputPass());

    this._composer = composer;
    this._gtaoPass = gtaoPass;
    this._bloomPass = bloomPass;

    // composer.addPass() sets all passes to full-res — override to half-res
    this._applyHalfResPostProcessing();
  }

  /** Re-apply half-res to GTAO/Bloom internal buffers. */
  private _applyHalfResPostProcessing(): void {
    if (!this._composer) return;
    // EffectComposer stores CSS dims in _width/_height and scales by pixelRatio
    const c = this._composer as unknown as { _width: number; _height: number; _pixelRatio: number };
    const pw = c._width * c._pixelRatio;
    const ph = c._height * c._pixelRatio;
    const hw = Math.max(1, Math.floor(pw * RVViewer.PP_SCALE));
    const hh = Math.max(1, Math.floor(ph * RVViewer.PP_SCALE));
    if (this._gtaoPass) this._gtaoPass.setSize(hw, hh);
    if (this._bloomPass) this._bloomPass.setSize(hw, hh);
  }

  // ─── Isolate Overlay (group isolate visualization) ────────────────────

  /** Lazily build the semi-transparent fullscreen overlay resources. */
  private _ensureIsolateOverlay(): void {
    if (this._isolateOverlayScene) return;
    const scene = new Scene();
    // Must stay null — `scene.background = Color` triggers Three.js's
    // forceClear path (Background.js:44) which bypasses autoClear and
    // would wipe the dim backdrop drawn in pass 1.
    scene.background = null;
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new MeshBasicMaterial({
      color: 0xffffff, // refreshed from scene background each frame in _renderIsolateMode
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    const mesh = new Mesh(new PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this._isolateOverlayScene = scene;
    this._isolateOverlayCam = cam;
    this._isolateOverlayMat = mat;
  }

  /** Lazily build the fullscreen desaturation resources. */
  private _ensureDesatPass(): void {
    if (this._desatScene) return;
    const w = this.renderer.domElement.width || 1;
    const h = this.renderer.domElement.height || 1;
    this._desatRT = new WebGLRenderTarget(w, h, { samples: this._antialiasActive ? 4 : 0 });
    const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this._desatRT.texture },
        saturation: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform float saturation;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
          gl_FragColor = vec4(mix(vec3(lum), c.rgb, saturation), c.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(new PlaneGeometry(2, 2), mat);
    mesh.frustumCulled = false;
    const scene = new Scene();
    scene.background = null;
    scene.add(mesh);
    this._desatScene = scene;
    this._desatCam = cam;
    this._desatMat = mat;
  }

  /**
   * Three-pass render used when GroupRegistry.isIsolateActive is true:
   *   1. Dim backdrop — everything except the focus layer, through composer if enabled.
   *   2. Semi-transparent white overlay drawn over the dim frame.
   *   3. Focus group drawn crisply on top of the overlay.
   *
   * Caller (render()) saves and restores camera.layers.mask / renderer.autoClear
   * in a try/finally so exceptions can't corrupt global state.
   */
  private _renderIsolateMode(): void {
    this._ensureIsolateOverlay();
    // Re-tag isolated subtrees so dynamically added descendants (spawned MUs,
    // gripper pickups, async-loaded geometry, etc.) inherit ISOLATE_FOCUS_LAYER
    // and render in pass 3 instead of being washed by the dim overlay.
    this.groups?.refreshIsolateLayer();
    this.autoFilters?.refreshIsolateLayer();
    const camera = this.camera;
    // Cast to WebGLRenderer for autoClear / clearDepth typings. The running
    // instance is actually three/webgpu Renderer in forceWebGL mode — see
    // Background.js in the three/webgpu source for the clear gate.
    const gl = this.renderer as unknown as WebGLRenderer;

    // Check if desaturation is requested by any active isolate caller.
    const desaturate =
      this.autoFilters?.dimDesaturate ||
      !!(this.groups as { dimDesaturate?: boolean } | null)?.dimDesaturate;

    // Restrict shadow map to focus-layer objects only so dimmed objects
    // don't cast shadows onto the ground plane.
    const savedShadowLayers = this.dirLight.shadow.camera.layers.mask;
    this.dirLight.shadow.camera.layers.set(ISOLATE_FOCUS_LAYER);

    // ── Pass 1: Dim backdrop ──
    // enableAll + disable focus = "everything but focus", mutation-safe for
    // dynamically spawned nodes (MUs, tank fills, pipe-flow rings) which
    // default to layer 0 only. Also exclude the highlight layer so hover/
    // select wireframes don't render dim here — they're rendered crisply in
    // pass 4.
    camera.layers.enableAll();
    camera.layers.disable(ISOLATE_FOCUS_LAYER);
    camera.layers.disable(HIGHLIGHT_OVERLAY_LAYER);

    if (desaturate) {
      // Render backdrop to offscreen RT, then blit desaturated to screen.
      this._ensureDesatPass();
      const rt = this._desatRT!;
      const w = gl.domElement.width;
      const h = gl.domElement.height;
      if (rt.width !== w || rt.height !== h) rt.setSize(w, h);

      // Remove environment map during backdrop render so metallic surfaces
      // don't show specular reflections (they'd appear as bright white spots
      // even after desaturation). Restored before Pass 3 (focus group).
      const savedEnv = this.scene.environment;
      this.scene.environment = null;

      // Render the full-color backdrop (everything except focus layer) into the RT.
      gl.setRenderTarget(rt);
      gl.clear(true, true, false);
      gl.render(this.scene, camera);
      gl.setRenderTarget(null);

      // Restore environment map for the focus group render (Pass 3).
      this.scene.environment = savedEnv;

      // Blit the RT to the default framebuffer through a desaturation shader.
      // saturation=0 → full grayscale; the focus group (Pass 3) renders in
      // full color on top afterwards.
      this._desatMat!.uniforms.tDiffuse.value = rt.texture;
      this._desatMat!.uniforms.saturation.value = 0.0;
      gl.clear(true, true, false);
      gl.render(this._desatScene!, this._desatCam!);
    } else if (this._useComposer) {
      if (this._gtaoPass) this._gtaoPass.camera = camera;
      const renderPass = this._composer!.passes[0] as RenderPass;
      if (renderPass) renderPass.camera = camera;
      this._composer!.render();
    } else {
      gl.render(this.scene, camera);
    }

    // CRITICAL: three/webgpu Background.js:44 sets `forceClear = true` when
    // `scene.background` is a Color, which BYPASSES `autoClear` and wipes
    // the framebuffer on every render call. For the remaining passes we
    // must disable both autoClear AND temporarily null the scene background,
    // then restore both afterwards.
    gl.autoClear = false;
    const savedBackground = this.scene.background;
    this.scene.background = null;
    // Sync overlay tint to the scene background color (Color → use as-is,
    // Texture/CubeTexture/null → fall back to the renderer clear color so
    // the fade still matches the visible sky).
    if (this._isolateOverlayMat) {
      if (savedBackground && (savedBackground as Color).isColor) {
        this._isolateOverlayMat.color.copy(savedBackground as Color);
      } else {
        gl.getClearColor(this._isolateOverlayMat.color);
      }
      // Allow the active isolate caller to override the dim-opacity.
      // autoFilters takes precedence over groups; both fall back to the default 0.9.
      const override =
        this.autoFilters?.dimOpacity ??
        (this.groups as { dimOpacity?: number | null } | null)?.dimOpacity ??
        null;
      this._isolateOverlayMat.opacity = override ?? 0.9;
    }
    try {
      // ── Pass 2: Semi-transparent fullscreen overlay ──
      // Direct render — do NOT route through composer, the composer already
      // wrote its final color to the default framebuffer.
      gl.clearDepth();
      gl.render(this._isolateOverlayScene!, this._isolateOverlayCam!);

      // ── Pass 3: Focus group on top ──
      gl.clearDepth();
      camera.layers.set(ISOLATE_FOCUS_LAYER);
      gl.render(this.scene, camera);

      // ── Pass 4: Hover/select wireframes on top of everything ──
      // Overlay materials already have depthTest:false, depthWrite:false; the
      // depth clear keeps them visible regardless of pass-3 z-state. Only the
      // overlay layer is enabled, so the pass renders just the highlight pairs.
      gl.clearDepth();
      camera.layers.set(HIGHLIGHT_OVERLAY_LAYER);
      gl.render(this.scene, camera);
    } finally {
      this.scene.background = savedBackground;
      this.dirLight.shadow.camera.layers.mask = savedShadowLayers;
    }
  }

  // ─── Static Factory ──────────────────────────────────────────────────

  /**
   * Create a viewer instance. Always use this instead of `new RVViewer()`.
   * Uses WebGPURenderer with forceWebGL as the universal renderer.
   * When `options.useWebGPU` is true and the browser supports it,
   * the real WebGPU backend is used instead.
   */
  static async create(
    container: HTMLElement,
    options?: RVViewerOptions,
  ): Promise<RVViewer> {
    const isTouchDevice = isMobileDevice();

    let useWebGPU = !!options?.useWebGPU;
    if (useWebGPU && !navigator.gpu) {
      console.warn('[RVViewer] WebGPU not available, falling back to WebGL');
      useWebGPU = false;
    }

    let renderer: Renderer;

    if (useWebGPU) {
      // Real WebGPU: use WebGPURenderer with async init
      const { WebGPURenderer } = await import('three/webgpu');
      const gpuRenderer = new WebGPURenderer({ antialias: options?.antialias ?? false, alpha: true, stencil: true } as any);
      try {
        await gpuRenderer.init();
      } catch (err) {
        console.warn('[RVViewer] WebGPU init() failed, falling back to WebGL:', err);
        gpuRenderer.dispose();
        useWebGPU = false;
        // fall through to WebGL path below
      }
      if (useWebGPU) renderer = gpuRenderer;
    }

    if (!useWebGPU) {
      // Standard WebGL: use the proven WebGLRenderer (no init needed)
      renderer = new WebGLRenderer({ antialias: options?.antialias ?? false, alpha: true, stencil: true, powerPreference: 'high-performance' }) as unknown as Renderer;
    }

    return RVViewer._configureAndCreate(renderer!, container, isTouchDevice, useWebGPU, options);
  }

  /** Shared renderer config — called by create() and fallback path. */
  private static _configureAndCreate(
    renderer: Renderer,
    container: HTMLElement,
    isTouchDevice: boolean,
    isWebGPU: boolean,
    options?: RVViewerOptions,
  ): RVViewer {
    renderer.setSize(
      container.clientWidth || window.innerWidth,
      container.clientHeight || window.innerHeight,
    );
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, DEFAULT_DPR_CAP));
    renderer.shadowMap.enabled = false;
    (renderer.shadowMap as unknown as { autoUpdate: boolean }).autoUpdate = false;
    renderer.toneMapping = NoToneMapping;
    // Disable the auto-reset of renderer.info.render so we can accumulate
    // stats across multiple passes in a single frame (composer passes,
    // shadow map, etc.). Without this, the stats we read in getRendererInfo()
    // reflect only the LAST pass — typically a 1-triangle fullscreen
    // post-processing blit — and look completely wrong.
    (renderer.info as unknown as { autoReset: boolean }).autoReset = false;

    return new RVViewer(container, renderer, options ?? {});
  }

  // ─── Model Management ─────────────────────────────────────────────────

  /** Load a GLB model and start all simulation systems. */
  async loadModel(url: string): Promise<LoadResult> {
    this.clearModel();
    this._currentModelUrl = url;

    // --- Pre-load phase: load model plugins BEFORE GLB so they can register capabilities ---
    // Capabilities must be registered before buildRaycastGeometries() in loadGLB().
    // External plugin bundles (./project-plugin.js, ./models/<name>/model-plugin.js) are
    // an opt-in feature for deploys that ship standalone plugin bundles alongside the viewer.
    // Gated on appConfig.externalPlugins to avoid two 404s per model load on every other deploy
    // where no such bundle exists. The Vite-bundled ModelPluginManager below is the default path.
    if (getAppConfig().externalPlugins) {
      const modelBaseName = url.replace(/^.*\//, '').replace(/\.glb$/i, '');
      const tryPreloadPlugin = async (pluginUrl: string): Promise<void> => {
        try {
          const resp = await fetch(pluginUrl, { method: 'HEAD' });
          if (!resp.ok) return;
          const mod = await import(/* @vite-ignore */ pluginUrl);
          if (typeof mod.default === 'function') mod.default(this);
        } catch { /* skip silently */ }
      };
      await tryPreloadPlugin('./project-plugin.js');
      await tryPreloadPlugin(`./models/${modelBaseName}/model-plugin.js`);
    }
    if (this.modelPluginManager) {
      await this.modelPluginManager.onModelLoading(url, this);
    }

    // Wait for any load gate (e.g. login) before heavy GLB parsing
    if (this.loadGate) await this.loadGate;

    const result = await loadGLB(url, this.scene, { isWebGPU: this.isWebGPU, gizmoManager: this.gizmoManager, events: this });

    // Pre-compile shaders to avoid first-frame stutter (available on WebGPURenderer)
    if ('compileAsync' in this.renderer) {
      try {
        await this.renderer.compileAsync(this.scene, this.camera, this.scene);
      } catch { /* non-critical */ }
    }

    this.currentModel = this.scene.children.find((c) => !this.sceneFixtures.has(c)) ?? null;
    this.drives = result.drives;
    this.transportManager = result.transportManager;
    this.signalStore = result.signalStore;
    this.playback = result.playback;
    this.replayRecordings = result.replayRecordings;
    this.logicEngine = result.logicEngine;
    this.registry = result.registry;
    this.groups = result.groups;

    // Component event dispatcher — routes viewer events (object-hover, object-clicked,
    // selection-changed) to per-component onHover/onClick/onSelect callbacks.
    // Must be created after registry is available.
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
    }
    this.componentEventDispatcher = new ComponentEventDispatcher(this, result.registry);

    // Build auto-filter groups from component capabilities
    this.autoFilters = new AutoFilterRegistry();
    this.autoFilters.build(result.registry);

    // Selection manager — init after registry is available
    this.selectionManager.init(this);

    // Register core "Focus" context menu item (available for all nodes)
    this.contextMenu.register({
      pluginId: '_core',
      items: [{
        id: '_core.focus',
        label: 'Focus',
        order: 1,
        action: (target) => {
          this.fitToNodes([target.node]);
          this.selectionManager.select(target.path);
        },
      }],
    });

    // Register filter subscribers from capabilities registry
    for (const [type, caps] of getRegisteredCapabilities()) {
      if (caps.filterLabel) {
        registerFilterSubscriber({ id: type, label: caps.filterLabel, componentType: type });
      }
    }

    // Unified raycast manager with grouped BVH
    this.raycastManager = new RaycastManager(
      this.renderer, this.camera, this.scene,
      result.registry, this.highlighter, this,
    );

    // Install central isolation gate — single invariant across all isolate
    // providers (GroupRegistry, AutoFilterRegistry, external/plugin isolates).
    // Stacks atop any plugin-specific allow filter.
    this.raycastManager.setIsolationGate((node) => {
      if (this.groups?.isIsolateActive && !this.groups.isInIsolatedSubtree(node)) return false;
      if (this.autoFilters?.isIsolateActive && !this.autoFilters.isInIsolatedSubtree(node)) return false;
      return true;
    });

    // Provide grouped raycast geometry (built during scene loading)
    if (result.raycastGeometrySet) {
      const muMeshes = this._collectInstancedMeshes();
      this.raycastManager.setRaycastGeometry(result.raycastGeometrySet, muMeshes);
    }

    // Gizmos created during loadGLB (e.g. WebSensor outlines) were instantiated
    // before raycastManager existed. Register them AFTER setRaycastGeometry so
    // they survive the rebuild that setRaycastGeometry triggers.
    this.gizmoManager.refreshAuxRaycastTargets();

    // Enable hover types based on capabilities registry (hoverEnabledByDefault)
    const hoverDefaults = getTypesWithCapability('hoverEnabledByDefault');
    for (const type of hoverDefaults) {
      this.raycastManager.enableHoverType(type, true);
    }
    const pl = result.pipelineNodes;

    // Tank fill visualization (3D liquid level)
    if (pl.tanks.length > 0) {
      this.tankFillManager = new TankFillManager(pl.tanks, this.renderer as unknown as { localClippingEnabled?: boolean });
      if (this.tankFillManager.update()) {
        this._renderDirty = true;
      }
    }

    // Pipe flow visualization (animated rings)
    if (pl.pipes.length > 0) {
      this.pipeFlowManager = new PipeFlowManager(pl.pipes);
    }

    // LogicEngine
    if (this.logicEngine) {
      this.logicEngine.start();
    }

    // Recording playback
    if (this.playback) {
      const shouldAutoPlay = result.recorderSettings?.playOnStart ?? false;
      if (shouldAutoPlay) {
        this.playback.play();
      }
    }

    // Resize ground plane to fit model bounds + margin
    const center = new Vector3();
    const size = new Vector3();
    result.boundingBox.getCenter(center);
    result.boundingBox.getSize(size);

    if (this._groundMesh) {
      // Ground is a 200×200 fade plane; always square, sized to cover the
      // longer of the model's X/Z extents so elongated models still fit.
      const groundSize = Math.max(size.x, size.z) * 1.1 * 2;
      this._groundMesh.scale.set(groundSize / 200, groundSize / 200, 1);
      this._groundMesh.position.set(center.x, 0, center.z);

      // Update checker texture repeat so each square is always 0.5m
      const SQUARE_SIZE = 0.5; // meters per checker square
      const TILES_PER_REPEAT = 8; // tiles baked into the checker texture
      const metersPerRepeat = TILES_PER_REPEAT * SQUARE_SIZE; // 4m
      const checkerMap = ((this._groundMesh as Mesh).material as MeshStandardMaterial).map;
      if (checkerMap) {
        checkerMap.repeat.set(groundSize / metersPerRepeat, groundSize / metersPerRepeat);
      }
    }

    // Fit camera to model

    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.perspCamera.fov * (Math.PI / 180);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 1.5;

    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.5, center.z + dist * 0.7);
    this.controls.target.copy(center);
    this.controls.update();

    // Fit directional light shadow camera to model
    // Light direction matches Unity realvirtual Sun prefab: euler (72.82, -150.577, -106.188)
    // Light FROM direction in Three.js: (0.145, 0.955, -0.257)
    {
      this._shadowPadMax = Math.max(maxDim * 1.2, 5);
      const sunDist = maxDim * 2;
      this.dirLight.position.set(
        center.x + 0.145 * sunDist,
        center.y + 0.955 * sunDist,
        center.z + -0.257 * sunDist,
      );
      this.dirLight.target.position.copy(center);
      this.dirLight.shadow.camera.left = -this._shadowPadMax;
      this.dirLight.shadow.camera.right = this._shadowPadMax;
      this.dirLight.shadow.camera.top = this._shadowPadMax;
      this.dirLight.shadow.camera.bottom = -this._shadowPadMax;
      this.dirLight.shadow.camera.near = 0.1;
      this.dirLight.shadow.camera.far = Math.max(maxDim * 4, 50);
      this.dirLight.shadow.camera.updateProjectionMatrix();
    }

    // --- Auto-load model sidecar settings (first visit only) ---
    // --- Load and merge model-specific plugin configuration ---
    const [modelJsonConfig, glbConfig] = await Promise.all([
      loadModelJsonConfig(url).catch(() => ({} as ModelConfig)),
      Promise.resolve(extractGlbPluginConfig(this.scene)),
      loadModelSettingsConfig(url),
    ]);
    const settingsConfig: ModelConfig = {};
    const appConfig = getAppConfig();
    if (appConfig.plugins) settingsConfig.plugins = appConfig.plugins;
    if (appConfig.pluginConfig) settingsConfig.pluginConfig = appConfig.pluginConfig;

    result.modelConfig = mergeModelConfig(modelJsonConfig, glbConfig, settingsConfig);

    // Note: Project/model plugin loading (tryPreloadPlugin, modelPluginManager.onModelLoading)
    // was moved to the pre-load phase BEFORE loadGLB() so plugins can register capabilities
    // before BVH construction. See top of loadModel().

    // Plugin lifecycle: onModelLoaded (before event, with error isolation)
    // Activation mode depends on whether rv_plugins is declared anywhere.
    this._lastLoadResult = result;
    const declared = result.modelConfig.plugins; // string[] | undefined

    if (declared === undefined) {
      // ALL-MODE: no rv_plugins declared — activate ALL registered plugins (backward compatible)
      for (const p of this._plugins) {
        if (this._disabledIds.has(p.id)) continue;
        callPlugin(p, 'onModelLoaded', result, this);
      }
    } else {
      // SELECTIVE-MODE: only declared plugins + core plugins activate
      for (const p of this._plugins) {
        if (this._disabledIds.has(p.id)) continue;
        if (p.core || declared.includes(p.id)) {
          callPlugin(p, 'onModelLoaded', result, this);
        }
      }
      // Resolve any declared plugins not yet registered (lazy built-in or external)
      for (const id of declared) {
        if (!this._plugins.find(p => p.id === id)) {
          const plugin = await this.resolvePlugin(id);
          if (plugin) callPlugin(plugin, 'onModelLoaded', result, this);
        }
      }
    }

    // Re-evaluate _physicsPluginActive — plugins may have changed handlesTransport in onModelLoaded
    // Re-evaluate _physicsPluginActive — plugins may have changed handlesTransport in onModelLoaded
    this._physicsPluginActive = this._plugins.some(p => p.handlesTransport);

    // Ensure first frame renders fully (shadows + scene)
    this._shadowsDirty = true;
    this._renderDirty = true;

    // Build reverse-reference index for O(1) lookup in PropertyInspector
    result.registry.buildReverseRefIndex();

    logInfo(`Model loaded: ${this.drives.length} drives, ${this.signalStore?.size ?? 0} signals`);
    this.emit('model-loaded', { result });
    return result;
  }

  /** Remove the current model and reset all simulation state. */
  clearModel(): void {
    // Plugin lifecycle: onModelCleared (before state reset, skip disabled)
    for (const p of this._plugins) {
      if (this._disabledIds.has(p.id)) continue;
      callPlugin(p, 'onModelCleared', this);
    }

    // Close context menu to prevent stale target references
    this.contextMenu.close();

    // Safety net: clear all dynamic UI contexts, preserve initial ones from config
    const initialCtxs = getAppConfig().ui?.initialContexts;
    resetDynamicContexts(Array.isArray(initialCtxs) ? initialCtxs : undefined);

    this._lastLoadResult = null;

    this.selectionManager.clear();
    this.selectionManager.dispose();

    if (this.raycastManager) {
      this.raycastManager.dispose();
      this.raycastManager = null;
    }

    // IMPORTANT: Reset transport manager BEFORE scene traverse to remove
    // active MU nodes from scene tree. MU clones share geometry by reference
    // with templates — disposing geometry during traverse would corrupt shared buffers.
    if (this.transportManager) {
      this.transportManager.reset();
      this.transportManager = null;
    }

    if (this.currentModel) {
      this.scene.remove(this.currentModel);
      // After material deduplication, multiple meshes share the same material
      // instance. Use a Set to avoid disposing the same material/texture twice.
      const disposedMaterials = new Set<MeshStandardMaterial>();
      this.currentModel.traverse((node) => {
        const mesh = node as {
          geometry?: { dispose(): void };
          material?: (MeshStandardMaterial & { dispose(): void }) | (MeshStandardMaterial & { dispose(): void })[];
        };
        if (mesh.geometry) mesh.geometry.dispose();
        if (mesh.material) {
          const disposeMat = (m: MeshStandardMaterial & { dispose(): void }) => {
            if (disposedMaterials.has(m)) return;
            disposedMaterials.add(m);
            // Shared fixtures (e.g. RVUberMaterial singleton) survive clearModel —
            // they outlive individual model loads and are reused on the next load.
            if (m.userData?._rvShared) return;
            m.map?.dispose();
            m.normalMap?.dispose();
            m.roughnessMap?.dispose();
            m.aoMap?.dispose();
            m.emissiveMap?.dispose();
            m.metalnessMap?.dispose();
            m.alphaMap?.dispose();
            m.envMap?.dispose();
            m.dispose();
          };
          if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMat);
          else disposeMat(mesh.material);
        }
      });
      this.currentModel = null;
    }
    this.drives = [];
    if (this.playback) {
      this.playback.stop();
      this.playback = null;
    }
    this.replayRecordings = [];
    if (this.logicEngine) {
      this.logicEngine.reset();
      this.logicEngine = null;
    }
    if (this.tankFillManager) {
      this.tankFillManager.dispose();
      this.tankFillManager = null;
    }
    if (this.pipeFlowManager) {
      this.pipeFlowManager.dispose();
      this.pipeFlowManager = null;
    }
    // Dispose gizmo entries & dispatcher before registry is cleared
    this.gizmoManager.dispose();
    if (this.componentEventDispatcher) {
      this.componentEventDispatcher.dispose();
      this.componentEventDispatcher = null;
    }
    this.signalStore = null;
    this.registry = null;
    if (this.groups) {
      this.groups.clear();
      this.groups = null;
    }
    if (this.autoFilters) {
      this.autoFilters.clear();
      this.autoFilters = null;
    }
    // Reset dirty flags for next model load
    this._shadowsDirty = true;
    this._renderDirty = true;
    this.emit('model-cleared');
  }

  /** URL of the currently loaded model (null if no model loaded). */
  get currentModelUrl(): string | null {
    return this._currentModelUrl;
  }

  /** Override the stored model URL (e.g. to replace blob: URL with original for display). */
  set currentModelUrl(url: string | null) {
    this._currentModelUrl = url;
  }

  /** Explicit override for projectAssetsPath (set by ModelPluginManager in dev mode). */
  private _projectAssetsPath: string | null = null;

  /** Base URL for project-specific assets (docs, AASX, logos, branding). Ends with '/'.
   *  Priority: explicit override > settings.json `projectAssetsPath` > BASE_URL. */
  get projectAssetsPath(): string {
    if (this._projectAssetsPath) return this._projectAssetsPath;
    const cfg = getAppConfig().projectAssetsPath;
    if (!cfg) return import.meta.env.BASE_URL;
    // Relative paths resolve against BASE_URL
    if (!cfg.startsWith('http') && !cfg.startsWith('/'))
      return `${import.meta.env.BASE_URL}${cfg}`;
    return cfg;
  }

  set projectAssetsPath(path: string | null) {
    this._projectAssetsPath = path;
  }

  /**
   * Reload the current model. Useful when physics settings change and
   * the world needs to be rebuilt from scratch.
   * Returns the LoadResult, or null if no model was loaded.
   */
  async reloadModel(): Promise<LoadResult | null> {
    if (!this._currentModelUrl) return null;
    const url = this._currentModelUrl;
    return this.loadModel(url);
  }

  /** Clean up all resources. */
  dispose(): void {
    // Plugin lifecycle: dispose (before everything else)
    for (const p of this._plugins) {
      callPlugin(p, 'dispose');
    }
    this.loop.stop();
    this.clearModel();
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    this.controls.dispose();
    this.renderer.dispose();
    if (this.statsReady) {
      this.stats.dispose();
      this.stats.dom.remove();
    }
    this.removeAllListeners();
  }

  // ─── Highlight & Focus ───────────────────────────────────────────────

  /**
   * Highlight a component by its hierarchy path (orange overlay).
   * @param tracked  If true, overlays follow moving parts each frame.
   */
  highlightByPath(path: string, tracked = false): void {
    const node = this.registry?.getNode(path);
    if (!node) return;
    // Detect if target is a sensor (include sensor viz in highlight)
    const isSensor = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.['Sensor'];
    this.highlighter.highlight(node, tracked, { includeSensorViz: isSensor });
  }

  /** Remove the current highlight. */
  clearHighlight(): void {
    this.highlighter.clear();
  }

  /** Smoothly orbit camera to focus on a component by hierarchy path. Also pins the drive tooltip if the target is a drive.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (shifts orbit target). */
  focusByPath(path: string, offset?: ViewportOffset): void {
    const node = this.registry?.getNode(path);
    if (!node) return;

    // Pin drive tooltip if the focused node is (or belongs to) a drive
    const drive = this.registry!.findInParent<RVDrive>(node, 'Drive')
      ?? (this.registry!.getByPath<RVDrive>('Drive', path) || null);
    this.focusedDrive = drive;
    this.focusedNode = node;
    this.emit('drive-focus', { drive, node });

    const box = this._cameraManager.computeNodeBounds([node]);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const fov = this.perspCamera.fov * (Math.PI / 180);
    const dist = (maxDim / (2 * Math.tan(fov / 2))) * 2.5;

    // Keep current viewing direction — just move along it to frame the target
    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const effectiveOffset = offset ?? this.getCurrentViewportOffset();
    const adjustedCenter = this._cameraManager.applyViewportOffset(center, dist, effectiveOffset);
    const endPos = adjustedCenter.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, adjustedCenter);
  }

  /** Smoothly animate camera to frame all given nodes.
   *  @param offset  Optional pixel offsets for panels obscuring the viewport (shifts orbit target). */
  fitToNodes(nodes: Object3D[], offset?: ViewportOffset): void {
    if (nodes.length === 0) return;
    const box = this._cameraManager.computeNodeBounds(nodes);
    if (box.isEmpty()) return;

    const center = new Vector3();
    const size = new Vector3();
    box.getCenter(center);
    box.getSize(size);

    const effectiveOffset = offset ?? this.getCurrentViewportOffset();

    // Compute distance so the bounding box fits in the *visible* viewport
    // (the area not covered by panels).
    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const fovRad = this.perspCamera.fov * (Math.PI / 180);
    const halfTanFov = Math.tan(fovRad / 2);
    const margin = 1.8;

    const canvas = this.renderer.domElement;
    const canvasW = canvas.clientWidth || 1;
    const canvasH = canvas.clientHeight || 1;
    const leftPx = effectiveOffset?.left ?? 0;
    const rightPx = effectiveOffset?.right ?? 0;
    const visibleW = Math.max(canvasW - leftPx - rightPx, 1);
    const visibleAspect = visibleW / canvasH;

    // Distance to fit vertically (full height available)
    const distV = maxDim / (2 * halfTanFov);
    // Distance to fit horizontally within visible area
    const distH = maxDim / (2 * halfTanFov * visibleAspect);
    const dist = Math.max(distV, distH) * margin;

    const dir = new Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const adjustedCenter = this._cameraManager.applyViewportOffset(center, dist, effectiveOffset);
    const endPos = adjustedCenter.clone().add(dir.multiplyScalar(dist));
    this.animateCameraTo(endPos, adjustedCenter);
  }

  /** Clear pinned drive focus (e.g., user clicked canvas). */
  clearFocus(): void {
    if (this.focusedDrive || this.focusedNode) {
      this.focusedDrive = null;
      this.focusedNode = null;
      this.emit('drive-focus', { drive: null, node: null });
    }
  }

  // ─── Scene Click → Hierarchy Selection ────────────────────────────────

  /**
   * Raycast from a mouse/pointer event using the grouped BVH system.
   * Returns the registry path or null.
   */
  private _raycastForRVNode(e: MouseEvent): string | null {
    return this.raycastManager?.raycastForRVNode(e) ?? null;
  }

  /**
   * Collect all InstancedMesh objects that serve as MU pools.
   * These are included in the raycast target list alongside the BVH meshes.
   */
  private _collectInstancedMeshes(): import('three').InstancedMesh[] {
    const result: import('three').InstancedMesh[] = [];
    this.scene.traverse((node) => {
      if (node.userData?._muPool && (node as import('three').InstancedMesh).isInstancedMesh) {
        result.push(node as import('three').InstancedMesh);
      }
    });
    return result;
  }

  // ─── Camera Settings (delegated to CameraManager) ───────────────────

  /** Field of view in degrees (perspective camera). */
  get fov(): number { return this._cameraManager.fov; }
  set fov(v: number) { this._cameraManager.fov = v; }

  /** Camera projection type. */
  get projection(): ProjectionType { return this._cameraManager.projection; }
  set projection(v: ProjectionType) { this._cameraManager.projection = v; }

  // ─── Visual Settings (delegated to VisualSettingsManager) ────────────

  /**
   * Fit the directional light shadow camera.
   *
   * Two modes:
   *   - **Tight-fit** (legacy): clip the shadow camera to the currently
   *     visible area around the orbit target for the best shadow map
   *     resolution. Safe only when every shadow caster is a moving drive
   *     child near the orbit target. Re-runs on every camera change.
   *   - **Full-scene** (used whenever a static uber-merged caster exists):
   *     the shadow camera was already set up at load time in `loadModel`
   *     — centered at the scene bbox center, with `_shadowPadMax` bounds
   *     big enough to cover the whole scene from any orbit target the
   *     user can reach. Rotation/pan/zoom do NOT change it, so this
   *     function is a no-op in full-scene mode. The controls-change
   *     handler skips `_shadowsDirty = true` for the same reason.
   */
  private _fitShadowToView(): void {
    if (!this.dirLight.parent || !this.renderer.shadowMap.enabled) return;

    const hasStaticUberCaster = (this._lastLoadResult?.uberMergeResult?.mergedCount ?? 0) > 0;
    if (hasStaticUberCaster) {
      // Full-scene mode: shadow camera was set up once in loadModel and
      // never needs to move. Don't touch `dirLight.target` here — doing so
      // would shift the shadow frustum when the orbit target moves, and
      // the shadow map would need a rebuild on every pan. Just flag the
      // map dirty (the caller only invokes us when _shadowsDirty was set,
      // i.e. on load / drive movement / MU spawn / shadow toggle).
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
      return;
    }

    // Legacy tight-fit path: clip to the visible area at orbit distance
    const cam = this._activeCamera;
    const target = this.controls.target;
    const dist = cam.position.distanceTo(target);
    let visibleRadius: number;
    if ((cam as PerspectiveCamera).isPerspectiveCamera) {
      const fov = (cam as PerspectiveCamera).fov * Math.PI / 180;
      const halfH = dist * Math.tan(fov / 2);
      const aspect = (cam as PerspectiveCamera).aspect;
      visibleRadius = Math.sqrt(halfH * halfH + (halfH * aspect) * (halfH * aspect));
    } else {
      const oc = cam as OrthographicCamera;
      visibleRadius = Math.sqrt(
        Math.max(Math.abs(oc.left), Math.abs(oc.right)) ** 2 +
        Math.max(Math.abs(oc.top), Math.abs(oc.bottom)) ** 2,
      );
    }
    const pad = Math.min(visibleRadius * 1.3, this._shadowPadMax);

    const sc = this.dirLight.shadow.camera;
    sc.left = -pad;
    sc.right = pad;
    sc.top = pad;
    sc.bottom = -pad;

    // Re-center shadow camera target on orbit target
    this.dirLight.target.position.copy(target);
    this.dirLight.target.updateMatrixWorld();
    sc.updateProjectionMatrix();

    // Force shadow map re-render
    (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = true;
  }

  private syncOrthoFrustum(): void {
    const dist = this.orthoCamera.position.distanceTo(this.controls.target);
    const halfH = dist * Math.tan((this.perspCamera.fov * Math.PI / 180) / 2);
    const aspect = this.perspCamera.aspect;
    this.orthoCamera.left = -halfH * aspect;
    this.orthoCamera.right = halfH * aspect;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  // ─── Visual Settings ─────────────────────────────────────────────────

  /** Active lighting mode. */
  get lightingMode() { return this._visualSettings.lightingMode; }
  set lightingMode(mode: import('./hmi/visual-settings-store').LightingMode) { this._visualSettings.lightingMode = mode; }

  /** Tone mapping algorithm (applied only in default mode). */
  get toneMapping(): ToneMappingType { return this._visualSettings.toneMapping; }
  set toneMapping(v: ToneMappingType) { this._visualSettings.toneMapping = v; }

  /** Tone mapping exposure (only effective when tone mapping != none). */
  get toneMappingExposure(): number { return this._visualSettings.toneMappingExposure; }
  set toneMappingExposure(v: number) { this._visualSettings.toneMappingExposure = v; }

  /** Ambient light color as hex string (e.g. '#ffffff'). */
  get ambientColor(): string { return this._visualSettings.ambientColor; }
  set ambientColor(hex: string) { this._visualSettings.ambientColor = hex; }

  /** Ambient light intensity. */
  get ambientIntensity(): number { return this._visualSettings.ambientIntensity; }
  set ambientIntensity(v: number) { this._visualSettings.ambientIntensity = v; }

  /** Directional light on/off. */
  get dirLightEnabled(): boolean { return this._visualSettings.dirLightEnabled; }
  set dirLightEnabled(v: boolean) { this._visualSettings.dirLightEnabled = v; }

  /** Directional light color as hex string. */
  get dirLightColor(): string { return this._visualSettings.dirLightColor; }
  set dirLightColor(hex: string) { this._visualSettings.dirLightColor = hex; }

  /** Directional light intensity. */
  get dirLightIntensity(): number { return this._visualSettings.dirLightIntensity; }
  set dirLightIntensity(v: number) { this._visualSettings.dirLightIntensity = v; }

  /** Shadow casting on/off. */
  get shadowEnabled(): boolean { return this._visualSettings.shadowEnabled; }
  set shadowEnabled(v: boolean) { this._visualSettings.shadowEnabled = v; }

  /** Shadow darkness (0 = invisible, 1 = full black). */
  get shadowIntensity(): number { return this._visualSettings.shadowIntensity; }
  set shadowIntensity(v: number) { this._visualSettings.shadowIntensity = v; }

  /** Shadow map resolution. */
  get shadowQuality(): ShadowQuality { return this._visualSettings.shadowQuality; }
  set shadowQuality(v: ShadowQuality) { this._visualSettings.shadowQuality = v; }

  /** Environment intensity (default mode) or ambient intensity (simple mode). */
  get lightIntensity(): number { return this._visualSettings.lightIntensity; }
  set lightIntensity(v: number) { this._visualSettings.lightIntensity = v; }

  // ─── Individual Rendering Settings (delegated to VisualSettingsManager) ──

  /**
   * Apply a full set of visual settings in one batch.
   * Delegates to individual setters on VisualSettingsManager.
   */
  applyVisualSettings(settings: import('./hmi/visual-settings-store').VisualSettings): void {
    const ms = settings.modeSettings[settings.lightingMode];

    // 1. Direct properties
    this.toneMappingExposure = ms.toneMappingExposure;
    this.ambientColor = ms.ambientColor;
    this.dirLightColor = ms.dirLightColor;
    this.dirLightIntensity = ms.dirLightIntensity;
    this.shadowIntensity = ms.shadowIntensity;
    this.shadowRadius = settings.shadowRadius ?? 2;

    // 2. Shadow map size (before enabling shadows)
    this.shadowMapSize = settings.shadowMapSize ?? 1024;

    // 3. DirLight on/off (before shadows, since shadowEnabled checks dirLight.parent)
    this.dirLightEnabled = ms.dirLightEnabled;

    // 4. Shadows
    this.shadowEnabled = ms.shadowEnabled;

    // 5. Tone mapping + lighting mode
    this.toneMapping = ms.toneMapping;
    this.lightingMode = settings.lightingMode;

    // 6. Light intensity (depends on lightingMode being set)
    this.lightIntensity = ms.lightIntensity;

    // 7. Camera
    this.fov = settings.fov;
    this.projection = settings.projection;

    // 8. SSAO (WebGL only)
    this.ssaoEnabled = settings.ssaoEnabled ?? false;
    this.ssaoIntensity = settings.ssaoIntensity ?? 1.0;
    this.ssaoRadius = settings.ssaoRadius ?? 0.15;

    // 9. Bloom (WebGL only)
    this.bloomEnabled = settings.bloomEnabled ?? true;
    this.bloomIntensity = settings.bloomIntensity ?? 0.2;
    this.bloomThreshold = settings.bloomThreshold ?? 0.85;
    this.bloomRadius = settings.bloomRadius ?? 0.4;

    // 10. Ground / Floor
    this.groundEnabled = settings.groundEnabled ?? true;
    this.groundBrightness = settings.groundBrightness ?? 1.0;
    this.backgroundBrightness = settings.backgroundBrightness ?? 1.0;
    this.checkerContrast = settings.checkerContrast ?? 1.0;

    // 11. Navigation sensitivity (OrbitControls)
    if (this.controls) {
      applyNavigationSettingsToControls(this.controls, settings);
    }
  }

  // ─── Individual Rendering Settings ──────────────────────────────────

  /** Get current effective DPR. */
  get effectiveDpr(): number { return this._visualSettings.effectiveDpr; }

  /** Set maximum device pixel ratio. Values >= 2 use native DPR. Applies immediately (no reload). */
  set maxDpr(cap: number) { this._visualSettings.maxDpr = cap; }

  /** Set shadow map resolution (e.g. 512, 1024, 2048). Disposes old map. */
  set shadowMapSize(size: number) { this._visualSettings.shadowMapSize = size; }

  /** Set shadow softness radius (1-5). Also switches shadow map type. */
  set shadowRadius(radius: number) { this._visualSettings.shadowRadius = radius; }

  /** Whether Screen Space Ambient Occlusion (GTAO) is enabled. WebGL only — no-op on WebGPU. */
  get ssaoEnabled(): boolean { return this._ssaoEnabled; }
  set ssaoEnabled(v: boolean) {
    if (v === this._ssaoEnabled) return;
    this._ssaoEnabled = v;
    if (v && !this.isWebGPU) this._ensureComposer();
    if (this._gtaoPass) this._gtaoPass.enabled = v;
    this._renderDirty = true;
  }

  /** SSAO blend intensity (0 = invisible, 1 = full). */
  get ssaoIntensity(): number { return this._gtaoPass?.blendIntensity ?? 1.0; }
  set ssaoIntensity(v: number) {
    if (this._gtaoPass) this._gtaoPass.blendIntensity = v;
    this._renderDirty = true;
  }

  /** SSAO sampling radius in world units. */
  get ssaoRadius(): number { return this._gtaoPass?.gtaoMaterial?.uniforms?.radius?.value ?? 0.15; }
  set ssaoRadius(v: number) {
    if (this._gtaoPass) this._gtaoPass.updateGtaoMaterial({ radius: v });
    this._renderDirty = true;
  }

  /** Whether bloom (glow on bright areas) is enabled. WebGL only. */
  get bloomEnabled(): boolean { return this._bloomEnabled; }
  set bloomEnabled(v: boolean) {
    if (v === this._bloomEnabled) return;
    this._bloomEnabled = v;
    if (v && !this.isWebGPU) this._ensureComposer();
    if (this._bloomPass) this._bloomPass.enabled = v;
    this._renderDirty = true;
  }

  /** Bloom glow intensity (0–2). */
  get bloomIntensity(): number { return this._bloomPass?.strength ?? 0.5; }
  set bloomIntensity(v: number) {
    if (this._bloomPass) this._bloomPass.strength = v;
    this._renderDirty = true;
  }

  /** Brightness threshold for bloom (0–1). */
  get bloomThreshold(): number { return this._bloomPass?.threshold ?? 0.85; }
  set bloomThreshold(v: number) {
    if (this._bloomPass) this._bloomPass.threshold = v;
    this._renderDirty = true;
  }

  /** Bloom spread radius (0–1). */
  get bloomRadius(): number { return this._bloomPass?.radius ?? 0.4; }
  set bloomRadius(v: number) {
    if (this._bloomPass) this._bloomPass.radius = v;
    this._renderDirty = true;
  }

  // ─── Profiler Overlay ────────────────────────────────────────────────

  /** Show/hide the stats-gl FPS/CPU/GPU overlay. */
  get showStats(): boolean { return this.statsReady && this.stats.dom.style.display !== 'none'; }
  set showStats(v: boolean) { if (this.statsReady) this.stats.dom.style.display = v ? '' : 'none'; }

  /** Enable/disable periodic renderer.info console logging. */
  rendererInfoLogging = false;

  // ─── Renderer Info (for dev tools) ────────────────────────────────────

  /** Get renderer performance info (triangles, draw calls, etc.). */
  getRendererInfo(): {
    triangles: number;
    drawCalls: number;
    geometries: number;
    textures: number;
    programs: number;
    /** Materials before dedup (from GLB) */
    materialsOriginal: number;
    /** Materials after dedup + uber-material pass (unique references still on meshes) */
    materialsUnique: number;
    /** Meshes baked onto the RVUberMaterial singleton (0 if uber pass was a no-op) */
    uberBakedMeshCount: number;
    /** Meshes that shared an already-baked BufferGeometry instead of cloning (plan-153) */
    uberSharedGeometryReuses: number;
    /** Meshes that had to clone their geometry because of a material conflict (plan-153) */
    uberClonedGeometryCount: number;
    /** Orphaned source BufferGeometries that Pass 3 disposed (plan-153) */
    uberDisposedSourceGeometries: number;
    /** Number of uber-baked static meshes that fed into the uber static merge */
    uberMergeOriginal: number;
    /** Number of merged meshes created by the uber static batching pass (0 or 1) */
    uberMergeCreated: number;
    /** Kinematic Drive groups that were merged */
    kinGroupsMerged: number;
    /** Total source meshes collapsed by kinematic merge */
    kinSourceMeshes: number;
    /** Merged chunks created by kinematic merge */
    kinChunksCreated: number;
    /** Static meshes before merge */
    staticMeshesOriginal: number;
    /** Merged meshes created */
    staticMeshesMerged: number;
  } {
    const info = this.renderer.info;
    const dedup = this._lastLoadResult?.dedupResult;
    const uber = this._lastLoadResult?.uberResult;
    const uberMerge = this._lastLoadResult?.uberMergeResult;
    const kinMerge = this._lastLoadResult?.kinematicMergeResult;
    const merge = this._lastLoadResult?.mergeResult;
    return {
      // triangles / drawCalls come from the snapshot taken right after
      // renderer.render() — see _lastFrameStats. Reading info.render
      // directly would race with post-processing passes or per-plugin
      // renders that mutate the counter.
      triangles: this._lastFrameStats.triangles,
      drawCalls: this._lastFrameStats.drawCalls,
      geometries: (info as unknown as { memory?: { geometries?: number } }).memory?.geometries ?? 0,
      textures: (info as unknown as { memory?: { textures?: number } }).memory?.textures ?? 0,
      programs: (info as unknown as { programs?: unknown[] }).programs?.length ?? 0,
      materialsOriginal: dedup?.originalCount ?? 0,
      materialsUnique: dedup?.uniqueCount ?? 0,
      uberBakedMeshCount: uber?.bakedMeshCount ?? 0,
      uberSharedGeometryReuses: uber?.sharedGeometryReuses ?? 0,
      uberClonedGeometryCount: uber?.clonedGeometryCount ?? 0,
      uberDisposedSourceGeometries: uber?.disposedSourceGeometries ?? 0,
      uberMergeOriginal: uberMerge?.originalCount ?? 0,
      uberMergeCreated: uberMerge?.mergedCount ?? 0,
      kinGroupsMerged: kinMerge?.groupsMerged ?? 0,
      kinSourceMeshes: kinMerge?.sourceMeshCount ?? 0,
      kinChunksCreated: kinMerge?.chunksCreated ?? 0,
      staticMeshesOriginal: merge?.originalCount ?? 0,
      staticMeshesMerged: merge?.mergedCount ?? 0,
    };
  }

  /**
   * Run a quick GPU benchmark: render N frames in a tight loop (no vsync),
   * return uncapped FPS and average frame time.
   */
  async runBenchmark(frames = 120): Promise<{ uncappedFps: number; avgFrameMs: number; headroom: number }> {
    // Force a GPU flush before starting
    this.renderer.render(this.scene, this.camera);
    const ctx = this.renderer.getContext();
    const isWebGL = 'finish' in ctx;
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();

    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      this.renderer.render(this.scene, this.camera);
    }
    if (isWebGL) (ctx as WebGL2RenderingContext).finish();
    const elapsed = performance.now() - start;

    const avgFrameMs = elapsed / frames;
    const uncappedFps = Math.round(1000 / avgFrameMs);
    // Headroom: how much faster than 60fps are we? e.g., 180fps = 3x headroom
    const headroom = Math.round((1000 / avgFrameMs) / 60 * 100);

    return { uncappedFps, avgFrameMs: +avgFrameMs.toFixed(2), headroom };
  }

  // ─── Viewport Offset (delegated to CameraManager) ──────────────────

  /** Compute current viewport offset from open panels (hierarchy, inspector, left panels).
   *  Returns undefined when no panels obscure the viewport.
   *  NOTE: Uses INSPECTOR_PANEL_WIDTH from layout-constants internally. */
  getCurrentViewportOffset(): ViewportOffset | undefined {
    return this._cameraManager.getCurrentViewportOffset();
  }

  // ─── Camera Animation (delegated to CameraManager) ─────────────────

  /**
   * Smoothly animate the camera to a new position and orbit target.
   * @param position  Target camera position.
   * @param target    Target orbit center.
   * @param duration  Animation duration in seconds (default 0.6).
   */
  animateCameraTo(position: Vector3, target: Vector3, duration = 0.6): void {
    this._cameraManager.animateCameraTo(position, target, duration);
  }

  /** Whether a camera animation is currently in progress. */
  get isCameraAnimating(): boolean { return this._cameraManager.isCameraAnimating; }

  // ─── Private ──────────────────────────────────────────────────────────

  private lastHoveredDrive: RVDrive | null = null;
  private lastHoverClientX = 0;
  private lastHoverClientY = 0;
  private lastRenderTime = 0;
  /** Shadow map dirty flag — when false, shadow pass is skipped entirely. */
  private _shadowsDirty = true;
  /** Max shadow padding from model load (scene-wide coverage). */
  private _shadowPadMax = 100;
  /** Render dirty flag — when false, renderer.render() is skipped (Phase 4: render-on-demand). */
  private _renderDirty = true;
  /**
   * Snapshot of the most recent main-scene render's draw-call and triangle
   * counts. Captured immediately after `renderer.render()` / `composer.render()`
   * inside the dirty-flag block, so the 200ms DevTools polling read sees a
   * stable value rather than racing with post-render plugin passes or the
   * next frame's reset.
   */
  private _lastFrameStats = { drawCalls: 0, triangles: 0 };
  /** Frames remaining for damping after last user input (Phase 4). */
  private _dampingFramesRemaining = 0;
  /** Previous MU count — used to detect spawn/despawn for shadow dirty flag. */
  private _prevMuCount = 0;
  /** Reference to the ground plane mesh (if created). */
  private _groundMesh: Mesh | null = null;
  /** Canvas backing the checker CanvasTexture — re-drawn when checkerContrast changes. */
  private _checkerCanvas: HTMLCanvasElement | null = null;
  /** Floor checker pattern contrast (0 = flat midgray, 1 = default, 2 = doubled). */
  private _checkerContrast = 1.0;
  /** Scene background brightness multiplier (0 = black, 1 = default, 2 = white). */
  private _backgroundBrightness = 1.0;

  /** Lazy overlay scene used for the semi-transparent wash during group isolate. */
  private _isolateOverlayScene: Scene | null = null;
  /** Orthographic camera for the isolate overlay pass (NDC -1..1). */
  private _isolateOverlayCam: OrthographicCamera | null = null;
  /** Overlay material — color is refreshed to match scene background each frame. */
  private _isolateOverlayMat: MeshBasicMaterial | null = null;

  // --- Isolate desaturation pass (framebuffer-level grayscale) ---
  private _desatRT: WebGLRenderTarget | null = null;
  private _desatScene: Scene | null = null;
  private _desatCam: OrthographicCamera | null = null;
  private _desatMat: ShaderMaterial | null = null;

  private fixedUpdate(dt: number): void {
    this.simTickCount++;
    const isConnected = this._connectionState === 'Connected';

    // Recording playback — guarded by DrivesRecorder.Active
    if (this.playback && this.playback.isPlaying && isActiveForState(this.playback.activeOnly, isConnected)) {
      this.playback.update(dt);
    }

    // LogicStep engine — guarded by Active
    if (this.logicEngine && isActiveForState(this.logicEngine.activeOnly, isConnected)) {
      this.logicEngine.fixedUpdate(dt);
    }

    // ReplayRecording signal-triggered sequences — each has its own Active
    for (const rr of this.replayRecordings) {
      if (isActiveForState(rr.activeOnly, isConnected)) {
        rr.fixedUpdate(dt);
      }
    }

    // ── Plugins Pre (interface signals, replay, CAM) ──
    for (const p of this._prePlugins) {
      callPlugin(p, 'onFixedUpdatePre', dt);
    }

    // ── Core Drive Physics (behaviors + motion, drives[] may be topologically sorted) ──
    for (const drive of this.drives) {
      drive.update(dt);
      if (drive.isRunning || drive.positionOverwrite) {
        this._renderDirty = true;
        // Conveyor drives (jogForward/jogBackward) don't move geometry — only belt speed
        // changes. No shadow recompute needed for them.
        if (!drive.jogForward && !drive.jogBackward) {
          this._shadowsDirty = true;
        }
      }
    }

    // Mark shadows + render dirty only when MU count changes (spawn/despawn),
    // not when MUs merely exist. MU position changes already trigger render via
    // drive.isRunning on the transport surface drive.
    const muCount = this.transportManager ? this.transportManager.mus.length : 0;
    if (muCount !== this._prevMuCount) {
      this._shadowsDirty = true;
      this._renderDirty = true;
    }
    this._prevMuCount = muCount;

    // ── Core Transport (kinematic — skipped when physics plugin is active) ──
    if (this.transportManager && !this._physicsPluginActive) {
      this.transportManager.update(dt);
    }

    // ── Texture animation (always runs, even when physics plugin handles transport) ──
    if (this.transportManager) {
      this.transportManager.updateTextureAnimations(dt);
      // Mark render dirty when any surface is actively animating its belt texture
      for (const surface of this.transportManager.surfaces) {
        if (surface.isActive) {
          this._renderDirty = true;
          break;
        }
      }
    }

    // ── Tank fill visualization (clip plane updates) ──
    if (this.tankFillManager && this.tankFillManager.update()) {
      this._renderDirty = true;
    }

    // ── Gizmo overlay blink loop (early-returns when no entries) ──
    this.gizmoManager.tick(dt * 1000);

    // ── Pipe flow visualization (animated rings) ──
    if (this.pipeFlowManager && this.pipeFlowManager.update(dt)) {
      this._renderDirty = true;
    }

    // ── Plugins Post (recorder, sensor monitor, interface readback) ──
    for (const p of this._postPlugins) {
      callPlugin(p, 'onFixedUpdatePost', dt);
    }

  }

  private render(): void {
    if (this.statsReady) this.stats.begin();
    const now = performance.now() / 1000;
    const frameDt = this.lastRenderTime > 0 ? Math.min(now - this.lastRenderTime, 0.1) : 0.016;
    this.lastRenderTime = now;

    // FPS counter (updated every 500ms)
    this.fpsFrameCount++;
    this.fpsAccumTime += frameDt;
    if (this.fpsAccumTime >= 0.5) {
      this.currentFps = Math.round(this.fpsFrameCount / this.fpsAccumTime);
      this.currentFrameTime = +(this.fpsAccumTime / this.fpsFrameCount * 1000).toFixed(1);
      this.fpsFrameCount = 0;
      this.fpsAccumTime = 0;
    }

    this._cameraManager.tickCameraAnimation(frameDt);
    // Camera animation keeps render dirty
    if (this._cameraManager.isCameraAnimating) this._renderDirty = true;
    // Damping: keep rendering for N frames after last user input
    if (this._dampingFramesRemaining > 0) {
      this._dampingFramesRemaining--;
      this._renderDirty = true;
    }
    if (this.controls.enabled) this.controls.update();
    // Highlight tracked mode needs rendering when overlays move
    if (this.highlighter.isActive || this.highlighter.isSelectionActive) this._renderDirty = true;
    this.highlighter.update();

    // A pending shadow-dirty flag MUST trigger a render, otherwise the
    // flag would be consumed below without the shadow map ever being
    // regenerated (shadowMap.render only runs inside renderer.render).
    if (this._shadowsDirty) this._renderDirty = true;

    // XR sessions MUST render every frame — the compositor needs a submitted
    // frame each animation tick or the passthrough/scene will freeze.
    const glXR = (this.renderer as unknown as WebGLRenderer).xr;
    if (glXR?.isPresenting) this._renderDirty = true;

    // Render-on-demand: skip expensive GPU render when scene is static
    if (this._renderDirty) {
      // Shadow dirty flag handling lives INSIDE the render block so a
      // pending shadow update isn't silently cleared on a skipped frame.
      if (this._shadowsDirty) {
        this._fitShadowToView();
      }
      (this.renderer.shadowMap as unknown as { needsUpdate: boolean }).needsUpdate = this._shadowsDirty;
      this._shadowsDirty = false;

      // Manually reset per-frame counters (autoReset was disabled during
      // renderer setup) so the snapshot below reflects the total cost of
      // this frame's render path, summed across all passes.
      (this.renderer.info as unknown as { reset(): void }).reset();
      // Save and restore camera layer mask / autoClear across the render
      // branch so an exception in any pass can't corrupt global renderer
      // state for subsequent frames. autoClear is WebGL-specific, so cast
      // for the getter/setter.
      const prevLayerMask = this.camera.layers.mask;
      const glForClearState = this.renderer as unknown as WebGLRenderer;
      const prevAutoClear = glForClearState.autoClear;
      try {
        // XR sessions must always go through the direct renderer path —
        // EffectComposer renders to its own offscreen render targets, and
        // the multi-pass isolate mode clears/overlays in ways that break
        // the XR compositor. Passthrough camera would still show, but no
        // 3D content lands in the XR framebuffer → invisible scene.
        const xrPresenting = (this.renderer as unknown as WebGLRenderer).xr?.isPresenting;
        if (xrPresenting) {
          this.renderer.render(this.scene, this.camera);
        } else if (this.groups?.isIsolateActive || this.autoFilters?.isIsolateActive) {
          this._renderIsolateMode();
        } else if (this._useComposer) {
          // Update camera references (may have switched persp/ortho)
          if (this._gtaoPass) this._gtaoPass.camera = this.camera;
          const renderPass = this._composer!.passes[0] as RenderPass;
          if (renderPass) renderPass.camera = this.camera;
          this._composer!.render();
        } else {
          this.renderer.render(this.scene, this.camera);
        }
      } finally {
        this.camera.layers.mask = prevLayerMask;
        glForClearState.autoClear = prevAutoClear;
      }
      // Snapshot draw-call / triangle counts into a stable field so the
      // DevTools poller (200ms) sees the last complete frame's totals and
      // not whatever stale or partial values renderer.info holds later.
      const r = (this.renderer.info.render ?? { calls: 0, triangles: 0 }) as {
        calls: number; triangles: number;
      };
      this._lastFrameStats.drawCalls = r.calls;
      this._lastFrameStats.triangles = r.triangles;
      this._renderDirty = false;
    }

    // ── Plugins Render ──
    for (const p of this._renderPlugins) {
      callPlugin(p, 'onRender', frameDt);
    }

    // Emit object-hover + backward-compatible drive-hover events
    if (this.raycastManager) {
      const rm = this.raycastManager;
      const hoveredNode = rm.hoveredNode;
      const hoveredType = rm.hoveredNodeType;
      const hoveredPath = rm.hoveredNodePath;
      const cx = rm.pointerClientX;
      const cy = rm.pointerClientY;

      // Resolve drive for compat layer
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;

      const driveChanged = hoveredDrive !== this.lastHoveredDrive;
      const dx = cx - this.lastHoverClientX;
      const dy = cy - this.lastHoverClientY;
      const movedEnough = dx * dx + dy * dy > 16; // 4px threshold squared
      if (driveChanged || movedEnough) {
        this.lastHoveredDrive = hoveredDrive;
        this.lastHoverClientX = cx;
        this.lastHoverClientY = cy;

        // Emit generic object-hover
        if (hoveredNode && hoveredType && hoveredPath) {
          this.emit('object-hover', {
            node: hoveredNode,
            nodeType: hoveredType,
            nodePath: hoveredPath,
            pointer: { x: cx, y: cy },
            hitPoint: rm.hoveredHitPoint,
            mesh: hoveredNode,
          });
        } else {
          this.emit('object-hover', null);
        }

        // Backward-compat: drive-hover with EXACT existing signature
        this.emit('drive-hover', { drive: hoveredDrive, clientX: cx, clientY: cy });
      }
    }

    if (this.statsReady) { this.stats.end(); this.stats.update(); }

    // --- Renderer.info periodic logging (every 5s at 60fps) ---
    if (this.rendererInfoLogging) {
      this.rendererInfoFrameCount++;
      if (this.rendererInfoFrameCount >= 300) {
        this.rendererInfoFrameCount = 0;
        const info = this.renderer.info;
        const mem = info.memory;
        const rnd = info.render;
        if (!mem || !rnd) return;
        const dedup = this._lastLoadResult?.dedupResult;
        const merge = this._lastLoadResult?.mergeResult;
        debug('render',
          `DC: ${rnd.calls ?? 0} | Tris: ${rnd.triangles ?? 0} | ` +
          `Geo: ${mem.geometries ?? 0} | Tex: ${mem.textures ?? 0}` +
          (dedup ? ` | Mat: ${dedup.uniqueCount}/${dedup.originalCount}` : '') +
          (merge && merge.mergedCount > 0 ? ` | Merge: ${merge.originalCount}→${merge.mergedCount}` : '')
        );
        if (this._lastGeoCount > 0 && (mem.geometries ?? 0) > this._lastGeoCount + 10) {
          console.warn(`[Perf] Geometry count growing: ${this._lastGeoCount} → ${mem.geometries}`);
        }
        if (this._lastTexCount > 0 && (mem.textures ?? 0) > this._lastTexCount + 5) {
          console.warn(`[Perf] Texture count growing: ${this._lastTexCount} → ${mem.textures}`);
        }
        this._lastGeoCount = mem.geometries ?? 0;
        this._lastTexCount = mem.textures ?? 0;
      }
    }
  }

  // ─── Extracted Helper Methods ────────────────────────────────────────

  /** Detect whether the real WebGPU backend is active (not forceWebGL). */
  private _detectWebGPU(renderer: Renderer): boolean {
    if (!('isWebGPURenderer' in renderer)) return false;
    const backend = (renderer as unknown as { backend?: { isWebGPUBackend?: boolean } }).backend;
    return !!backend?.isWebGPUBackend;
  }

  /** Bind all canvas event listeners. Called ONCE in the constructor. */
  private _bindCanvasEvents(canvas: HTMLCanvasElement): void {
    // Trackpad: two-finger drag rotates when no modifier, pinch (ctrl+wheel) zooms.
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return;
      if (e.deltaMode !== 0) return;
      const absDY = Math.abs(e.deltaY);
      if (absDY >= 50 && e.deltaX === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const azimuth = e.deltaX * 0.003;
      const polar = e.deltaY * 0.003;
      const spherical = new Spherical().setFromVector3(
        this.camera.position.clone().sub(this.controls.target),
      );
      spherical.theta += azimuth;
      spherical.phi = Math.max(0.01, Math.min(Math.PI - 0.01, spherical.phi + polar));
      const offset = new Vector3().setFromSpherical(spherical);
      this.camera.position.copy(this.controls.target).add(offset);
      this.camera.lookAt(this.controls.target);
      this.controls.update();
    }, { passive: false });

    // Canvas click: record pointer start, then select on pointerup only if
    // the pointer didn't move (drag threshold).
    const DRAG_THRESHOLD = DRAG_THRESHOLD_PX;
    canvas.addEventListener('pointerdown', (e) => {
      // Left button: track for click selection
      if (e.button === 0) {
        this._pointerDownPos = { x: e.clientX, y: e.clientY };
      }
      // Right button: track for context menu drag guard
      if (e.button === 2) {
        this._rightDownPos = { x: e.clientX, y: e.clientY };
      }
      // Touch long-press: start timer for context menu
      if (e.pointerType !== 'mouse' && e.button === 0) {
        this._cancelLongPress();
        this._longPressPos = { x: e.clientX, y: e.clientY };
        this._longPressTimer = setTimeout(() => {
          this._handleLongPress(e);
        }, 500);
      }
    });
    canvas.addEventListener('pointerup', (e) => {
      if (e.button !== 0 || !this._pointerDownPos) return;
      const dx = e.clientX - this._pointerDownPos.x;
      const dy = e.clientY - this._pointerDownPos.y;
      this._pointerDownPos = null;
      if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) return;
      // Note: _isOrbiting is NOT checked here — OrbitControls dispatches 'start'
      // on every pointerdown (setting _isOrbiting=true), but its 'end' event only
      // fires in its own pointerup handler which is registered AFTER ours.  The
      // drag-threshold check above is sufficient to distinguish taps from orbits.

      const hoveredNode = this.raycastManager?.hoveredNode ?? null;
      const hoveredType = this.raycastManager?.hoveredNodeType ?? null;
      const hoveredDrive = (hoveredNode && hoveredType === 'Drive')
        ? this.registry?.findInParent<RVDrive>(hoveredNode, 'Drive') ?? null
        : null;

      // Drive chart special mode: filter drives on click
      if (hoveredDrive && this._driveChartOpen) {
        this.filterDrives(hoveredDrive.name);
        return;
      }

      // Sensor chart special mode: filter sensors on click
      if (hoveredNode && hoveredType === 'Sensor' && this._sensorChartOpen) {
        const path = this.registry?.getPathForNode(hoveredNode);
        if (path) {
          this.filterNodes(hoveredNode.name);
          this.emit('object-clicked', { path, node: hoveredNode });
        }
        return;
      }

      // Normal selection: route through SelectionManager
      let hitPath: string | null = null;
      let hitNode: Object3D | null = null;
      let hitPoint: [number, number, number] | undefined;

      if (hoveredDrive) {
        hitPath = this.registry?.getPathForNode(hoveredDrive.node) ?? null;
        hitNode = hoveredDrive.node;
        // Get hit point from detailed raycast
        const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
        hitPoint = detailed?.hitPoint;
      } else {
        const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
        hitPath = detailed?.path ?? this._raycastForRVNode(e);
        hitPoint = detailed?.hitPoint;
        hitNode = hitPath && this.registry ? this.registry.getNode(hitPath) ?? null : null;
      }

      if (hitPath && hitNode) {
        if (e.shiftKey) {
          this.selectionManager.toggle(hitPath, hitPoint);
        } else {
          this.selectionManager.select(hitPath, hitPoint);
        }
        // Backward compat: emit object-clicked for existing listeners
        this.emit('object-clicked', { path: hitPath, node: hitNode });
      } else {
        // Clicked empty space
        this.selectionManager.clear();
        this.clearFocus();
      }
    });

    // Double-click: emit object-focus for camera zoom
    canvas.addEventListener('dblclick', (e) => {
      const hitPath = this.raycastManager?.raycastForRVNode(e) ?? this._raycastForRVNode(e);
      if (hitPath && this.registry) {
        const node = this.registry.getNode(hitPath);
        if (node) {
          this.emit('object-focus', { path: hitPath, node });
          this.fitToNodes([node]);
        }
      }
    });

    // ── Context Menu (right-click) ───────────────────────────────────
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault(); // Always suppress browser context menu on canvas

      // Drag-distance guard: if user right-dragged (orbit rotation), skip
      if (this._rightDownPos) {
        const dx = e.clientX - this._rightDownPos.x;
        const dy = e.clientY - this._rightDownPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._rightDownPos = null;
          return;
        }
      }
      this._rightDownPos = null;

      // FPV guard: don't open context menu when FPV plugin is active
      const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
      if (fpvPlugin?.active) return;

      this._openContextMenuFromEvent(e);
    });

    // ── Long-press cancellation ──────────────────────────────────────
    canvas.addEventListener('pointermove', (e) => {
      if (this._longPressTimer && this._longPressPos) {
        const dx = e.clientX - this._longPressPos.x;
        const dy = e.clientY - this._longPressPos.y;
        if (dx * dx + dy * dy > DRAG_THRESHOLD * DRAG_THRESHOLD) {
          this._cancelLongPress();
        }
      }
    });
    canvas.addEventListener('pointerup', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('pointercancel', () => {
      this._cancelLongPress();
    });
    canvas.addEventListener('touchcancel', () => {
      this._cancelLongPress();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._cancelLongPress();
    });
  }

  // ─── Context Menu Helpers ───────────────────────────────────────────

  /** Cancel the long-press timer (touch context menu). */
  private _cancelLongPress(): void {
    if (this._longPressTimer) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
    this._longPressPos = null;
  }

  /** Handle long-press firing: raycast and open context menu. */
  private _handleLongPress(e: PointerEvent): void {
    this._longPressTimer = null;
    // _isOrbiting not checked: long-press timer is already cancelled by
    // pointermove beyond drag threshold (see listener above).

    // FPV guard
    const fpvPlugin = this.getPlugin('fpv') as { active?: boolean } | undefined;
    if (fpvPlugin?.active) return;

    // Use stored position for the raycast (finger may have moved slightly)
    const pos = this._longPressPos;
    if (!pos) return;

    // Create a synthetic mouse event at the stored position for raycast
    const syntheticEvent = { clientX: pos.x, clientY: pos.y } as MouseEvent;
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(syntheticEvent);
    const path = detailed?.path ?? this._raycastForRVNode(syntheticEvent);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: pos.x, y: pos.y }, target);
    navigator.vibrate?.(50);
    this._longPressPos = null;
  }

  /**
   * Raycast from a mouse event and open the context menu on the hit node.
   * Shared by the `contextmenu` event handler and long-press handler.
   */
  private _openContextMenuFromEvent(e: MouseEvent): void {
    const detailed = this.raycastManager?.raycastForRVNodeDetailed(e);
    const path = detailed?.path ?? this._raycastForRVNode(e);
    if (!path) return;

    const node = this.registry?.getNode(path);
    if (!node) return;

    const target: ContextMenuTarget = {
      path,
      node,
      types: this.registry!.getComponentTypes(path),
      extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      hitPoint: detailed?.hitPoint,
      hitNormal: detailed?.hitNormal,
    };

    // Hold hover highlight while context menu is open.
    // OrbitControls fires 'start' on pointerdown (before contextmenu) which
    // disables the raycast manager and clears hover. Re-apply the highlight
    // here so the object stays highlighted while the menu is open.
    if (this.raycastManager) {
      this.raycastManager.holdHover = true;
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      this.highlighter.highlight(node, false, { includeChildDrives: isLayout });
    }
    this.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
    this.emit('context-menu-request', { pos: { x: e.clientX, y: e.clientY }, path, node });
  }

  /** Set up XR if available (WebGPU real backend has no XR support). */
  private _setupXR(renderer: Renderer, container: HTMLElement): void {
    if (this.isWebGPU) return;
    const xr = (renderer as unknown as Record<string, unknown>).xr as Record<string, unknown> | undefined;
    if (!xr || typeof xr.addEventListener !== 'function') return;
    const glRenderer = renderer as unknown as WebGLRenderer;
    glRenderer.xr.enabled = true;

    glRenderer.xr.addEventListener('sessionstart', () => {
      this._savedBackground = this.scene.background as Color | null;
      this._savedShadowState = this.renderer.shadowMap.enabled;
      this.renderer.shadowMap.enabled = false;
      this.controls.enabled = false;
      if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.emit('xr-session-start', undefined as void);
    });
    glRenderer.xr.addEventListener('sessionend', () => {
      this.scene.background = this._savedBackground;
      this.renderer.shadowMap.enabled = this._savedShadowState;
      this.controls.reset();
      this.controls.enabled = true;
      if (this.resizeHandler) {
        window.addEventListener('resize', this.resizeHandler);
        this.resizeHandler();
      }
      if (this.resizeObserver) this.resizeObserver.observe(container);
      this.emit('xr-session-end', undefined as void);
    });
  }

  /** Initialize stats-gl with fallback for WebGPU incompatibility. */
  private _setupStats(renderer: Renderer): void {
    this.stats = new Stats({
      trackGPU: true,
      trackHz: true,
      trackCPT: false,
      logsPerSecond: 4,
      graphsPerSecond: 30,
      samplesLog: 40,
      samplesGraph: 10,
      precision: 2,
      minimal: false,
      horizontal: true,
    });
    this.stats.dom.style.position = 'absolute';
    this.stats.dom.style.bottom = '12px';
    this.stats.dom.style.left = '12px';
    this.stats.dom.style.display = 'none';
    document.body.appendChild(this.stats.dom);
    try {
      this.stats.init(renderer as unknown as WebGLRenderer);
      this.statsReady = true;
    } catch {
      console.warn('[RVViewer] stats-gl init failed — GPU profiling disabled');
      this.statsReady = false;
    }
  }

  /**
   * Draw the 8×8 checker pattern into `canvas`. The darker tile always equals
   * the scene-background base color, so at contrast=0 (and when floor/bg
   * brightness are equal) the floor and background render to the same color.
   * The lighter tile brightens above the base by CHECKER_HIGHLIGHT_DELTA × contrast,
   * so contrast=1 reproduces the original `#b0b0b0` / `#9a9a9a` pair.
   */
  private drawCheckerPattern(canvas: HTMLCanvasElement, contrast: number): void {
    const tileCount = 8;
    const ctx = canvas.getContext('2d')!;
    const tilePixels = canvas.width / tileCount;
    const CHECKER_HIGHLIGHT_DELTA = 0x16 / 255; // 0x9a → 0xb0 spread ≈ 0.086
    const a = Math.max(0, Math.min(1, BG_BASE_SCALAR + CHECKER_HIGHLIGHT_DELTA * contrast));
    const b = BG_BASE_SCALAR;
    const toCss = (x: number) => {
      const v = Math.round(x * 255);
      return `rgb(${v},${v},${v})`;
    };
    const colorA = toCss(a);
    const colorB = toCss(b);
    for (let y = 0; y < tileCount; y++) {
      for (let x = 0; x < tileCount; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? colorA : colorB;
        ctx.fillRect(x * tilePixels, y * tilePixels, tilePixels, tilePixels);
      }
    }
  }

  /**
   * Create ground plane with checker pattern that fades to transparent at edges.
   * Inner 50% is opaque, outer 50% fades to transparent via alphaMap.
   */
  private createGroundFade(): Mesh {
    const checkerSize = 512;
    const canvas = document.createElement('canvas');
    canvas.width = checkerSize;
    canvas.height = checkerSize;
    this.drawCheckerPattern(canvas, this._checkerContrast);
    this._checkerCanvas = canvas;
    const checkerTex = new CanvasTexture(canvas);
    checkerTex.wrapS = RepeatWrapping;
    checkerTex.wrapT = RepeatWrapping;
    checkerTex.colorSpace = SRGBColorSpace;
    checkerTex.magFilter = NearestFilter;

    // Create alpha map: rectangular fade from center (opaque) to edges (transparent)
    const alphaSize = 256;
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = alphaSize;
    alphaCanvas.height = alphaSize;
    const alphaCtx = alphaCanvas.getContext('2d')!;
    const imageData = alphaCtx.createImageData(alphaSize, alphaSize);
    for (let py = 0; py < alphaSize; py++) {
      for (let px = 0; px < alphaSize; px++) {
        const dx = Math.abs(px / alphaSize - 0.5) * 2; // 0..1
        const dy = Math.abs(py / alphaSize - 0.5) * 2; // 0..1
        // Inner half = opaque, outer half fades out
        const fadeX = dx > 0.5 ? (dx - 0.5) / 0.5 : 0;
        const fadeY = dy > 0.5 ? (dy - 0.5) / 0.5 : 0;
        const alpha = 1 - Math.max(fadeX, fadeY);
        const idx = (py * alphaSize + px) * 4;
        const v = Math.max(0, Math.round(alpha * 255));
        imageData.data[idx] = v;
        imageData.data[idx + 1] = v;
        imageData.data[idx + 2] = v;
        imageData.data[idx + 3] = 255;
      }
    }
    alphaCtx.putImageData(imageData, 0, 0);
    const alphaTex = new CanvasTexture(alphaCanvas);

    let geo: PlaneGeometry | BufferGeometry = new PlaneGeometry(200, 200);
    if (this.isWebGPU && geo.index) {
      const nonIndexed = geo.toNonIndexed();
      geo.dispose();
      geo = nonIndexed;
    }

    const mat = new MeshStandardMaterial({
      map: checkerTex,
      alphaMap: alphaTex,
      transparent: true,
      side: DoubleSide,
      depthWrite: false,
      roughness: 1.0,
      metalness: 0.0,
    });

    const mesh = new Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = -1;
    mesh.receiveShadow = true;
    mesh.visible = false;
    return mesh;
  }
}
