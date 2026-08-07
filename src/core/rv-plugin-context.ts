// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PluginContext — Schmaler Capability-Cluster den Plugins über `BaseViewerPlugin.context`
 * statt vollem `RVViewer`-Pointer erhalten.
 *
 * Plan-182 Phase 3: nur die Type-Definitionen. Die `PluginContextImpl`-Klasse
 * und alle Sub-Facade-`Impl`-Klassen entstehen erst in Phase 4 — bis dahin
 * bleibt `BaseViewerPlugin.context` ungefüllt (Phase 4 fühlt es via `init()`).
 *
 * Open-Core-Grenze: Plugins greifen nur über dieses Capability-Bundle zu, nicht
 * mehr auf die volle `RVViewer`-Klasse.
 */

import type { Object3D, Vector2, Vector3, Quaternion } from 'three';
import type { EventEmitter } from './rv-events';
import type { ViewerEvents } from './rv-viewer-events';
import type {
  SignalStore,
  SignalWriter,
  SignalWriterKind,
} from './engine/rv-signal-store';
import type { NodeRegistry } from './engine/rv-node-registry';
import type { RVDrive } from './engine/rv-drive';
import type { RVTransportSurface } from './engine/rv-transport-surface';
import type { ModeId } from './rv-mode-manager';

// TickStage wird in Phase 0 bereits in rv-tick-stages.ts definiert — Re-Export hier
// damit Plugin-Autoren `import { TickStage } from '@rv/core/rv-plugin-context'` nutzen können.
export { TickStage } from './rv-tick-stages';
import type { TickStage } from './rv-tick-stages';

// ─── Sub-Facade Interfaces ────────────────────────────────────────────────

/** Read-only Scene-API für Plugins. */
export interface SceneFacade {
  eachNode(fn: (node: Object3D, path: string) => void): void;
  projectToScreen(node: Object3D, out?: Vector2): Vector2 | null;
  projectPoint(worldPoint: Vector3, out?: Vector2): Vector2 | null;
  highlightByPath(path: string, tracked?: boolean): void;
  clearHighlight(): void;
}

/** Camera-API für Plugins. `getCameraState` unterstützt Out-Param zur GC-Vermeidung. */
export interface CameraFacade {
  getCameraState(out?: { position: Vector3; target: Vector3 }): {
    position: Vector3;
    target: Vector3;
    quaternion: Quaternion;
  };
  animateCameraTo(pos: Vector3, target: Vector3, durationMs?: number): Promise<void>;
  fitToNodes(nodes: Object3D[], offsetFactor?: number): void;
  focusByPath(path: string, offsetFactor?: number): void;
  clearFocus(): void;
}

/** OrbitControls-Schreibzugriff für Plugins/Settings-UIs. */
export interface ControlsFacade {
  setRotateSpeed(value: number): void;
  setPanSpeed(value: number): void;
  setZoomSpeed(value: number): void;
  setDampingFactor(value: number): void;
  setEnabled(enabled: boolean): void;
  setTarget(target: Vector3): void;
  setConfig(cfg: Partial<{
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    dampingFactor: number;
    enabled: boolean;
  }>): void;
}

/** Read-only Transport-Manager-Subset für Plugins (Stats, Monitor). */
export interface TransportFacade {
  forEachSurface(fn: (surface: RVTransportSurface, path: string) => void): void;
  getSurfaceByPath(path: string): RVTransportSurface | null;
}

/** Narrow workspace-mode API for plugins (plan-198). Read the active mode and
 *  request a switch; registration of modes stays a host/bootstrap concern. */
export interface ModeFacade {
  /** Active workspace mode id, or null before the first switch. */
  readonly active: ModeId | null;
  /** Switch to a mode (no-op if already active / unknown / switching). */
  set(id: ModeId): void;
}

/** Simulation-Loop-API: Pause + Tick-Subscription. */
export interface SimLoopFacade {
  setPaused(reason: string, paused: boolean): void;
  clearPauseReasons(reason?: string): void;
  isPaused(): boolean;
  /**
   * Tick-Callback in einer bestimmten Stage registrieren.
   * Reihenfolge innerhalb einer Stage: aufsteigend nach `order` (default 100).
   * Stabile Sortierung — bei gleichem `order` gilt Registrierungs-Reihenfolge.
   * Returns ein Disposer.
   */
  onTick(stage: TickStage, callback: (dt: number) => void, order?: number): () => void;
  /** Iteration über aktive Drives — ersetzt direkten `viewer.drives`-Zugriff. */
  eachDrive(fn: (drive: RVDrive, index: number) => void): void;
  /** Read-only Drive-Count für HMI/Inspector. */
  readonly driveCount: number;
}

// ─── Hauptinterface: PluginContext ────────────────────────────────────────

/**
 * PluginContext — Capability-Bundle den Plugins via `BaseViewerPlugin.context`
 * erhalten. Schmaler als der volle `RVViewer`-Pointer; technisch durchsetzbar
 * via ESLint-Boundaries (Phase 6).
 *
 * WICHTIG für Plugin-Autoren:
 * - `signals` und `nodes` sind LIVE-Getter — Wert kann `null` sein vor `loadModel()`
 *   und ändert sich bei `clearModel()`/`loadModel()`. NIE in `init()` cachen.
 * - Subscriptions immer via `BaseViewerPlugin.sub(off)` registrieren, damit
 *   `flushSubs()` bei `onModelCleared` automatisch aufräumt.
 */
export type PluginSignalFacade =
  Pick<SignalStore, 'get' | 'subscribe'>
  & Pick<SignalWriter, 'set' | 'setMany'>;

export interface PluginContext {
  /** Live-Getter: Subset von SignalStore. Null vor loadModel(). */
  readonly signals: PluginSignalFacade | null;

  /** Live-Getter: Subset von NodeRegistry. Null vor loadModel(). */
  readonly nodes: Pick<NodeRegistry, 'getNode' | 'getPathForNode' | 'forEachNode'> | null;

  /** Typisierter Event-Emitter. RVViewer extends EventEmitter<ViewerEvents>, also kein Cast nötig. */
  readonly events: EventEmitter<ViewerEvents>;

  /** Aktueller Connection-State (Live oder Standalone). */
  readonly connectionState: 'Connected' | 'Disconnected';

  loadModel(url: string, opts?: { signalMap?: string }): Promise<void>;
  clearModel(): void;

  /**
   * Emit a typed viewer event. Mirrors `EventEmitter<ViewerEvents>.emit` exactly —
   * no `any` cast required because RVViewer extends EventEmitter<ViewerEvents>.
   */
  emit: EventEmitter<ViewerEvents>['emit'];

  /** Sub-Facaden. Lazy-instantiated in Phase 4. */
  readonly scene: SceneFacade;
  readonly camera: CameraFacade;
  readonly controls: ControlsFacade;
  readonly simLoop: SimLoopFacade;
  /** Null wenn kein Model geladen ODER kein TransportManager initialisiert. */
  readonly transport: TransportFacade | null;
  /** Workspace mode (plan-198) — read active mode + request a switch. */
  readonly modes: ModeFacade;
}

// ─── PluginContextImpl (Phase 4a of plan-182) ────────────────────────────

import { SceneFacadeImpl } from './facades/scene-facade';
import { CameraFacadeImpl } from './facades/camera-facade';
import { ControlsFacadeImpl } from './facades/controls-facade';
import { SimLoopFacadeImpl } from './facades/sim-loop-facade';
import { TransportFacadeImpl } from './facades/transport-facade';
import type { RVViewer } from './rv-viewer';

/**
 * Concrete PluginContext implementation. Holds eager-instantiated sub-facades
 * for scene/camera/controls/simLoop, and lazy-cached TransportFacade
 * (invalidated when the underlying TransportManager pointer changes).
 *
 * Created exactly once per RVViewer instance and shared by all plugins.
 *
 * Cast-free design: RVViewer extends EventEmitter<ViewerEvents>, so the
 * `events` getter returns the viewer directly with the correct type.
 */
export class PluginContextImpl implements PluginContext {
  readonly scene: SceneFacade;
  readonly camera: CameraFacade;
  readonly controls: ControlsFacade;
  readonly simLoop: SimLoopFacade;

  // Lazy-cached transport facade, invalidated when transportManager changes.
  private _transportCache: TransportFacade | null = null;
  private _transportCacheKey: object | null = null;
  private _signalFacadeCache: PluginSignalFacade | null = null;
  private _signalFacadeCacheKey: SignalStore | null = null;

  constructor(
    private readonly _viewer: RVViewer,
    private readonly _writerId = 'plugin-context',
    private readonly _writerKind: SignalWriterKind = 'plugin',
  ) {
    this.scene    = new SceneFacadeImpl(_viewer);
    this.camera   = new CameraFacadeImpl(_viewer);
    this.controls = new ControlsFacadeImpl(_viewer);
    this.simLoop  = new SimLoopFacadeImpl(_viewer);
  }

  // ── Live getters: null vor loadModel(), neuer Pointer nach clearModel/loadModel ──

  get signals(): PluginSignalFacade | null {
    const store = this._viewer.signalStore;
    if (!store) {
      this._signalFacadeCache = null;
      this._signalFacadeCacheKey = null;
      return null;
    }
    if (this._signalFacadeCacheKey !== store) {
      const createWriter = store.createWriter?.bind(store);
      const writer = createWriter
        ? createWriter(this._writerId, this._writerKind)
        : store;
      this._signalFacadeCache = {
        get: store.get.bind(store),
        set: writer.set.bind(writer),
        setMany: writer.setMany.bind(writer),
        subscribe: store.subscribe.bind(store),
      };
      this._signalFacadeCacheKey = store;
    }
    return this._signalFacadeCache;
  }

  /** Create the capability bundle passed to one registered plugin. */
  forPlugin(pluginId: string): PluginContextImpl {
    return new PluginContextImpl(this._viewer, pluginId, pluginSignalWriterKind(pluginId));
  }

  get nodes(): Pick<NodeRegistry, 'getNode' | 'getPathForNode' | 'forEachNode'> | null {
    return this._viewer.registry;
  }

  get transport(): TransportFacade | null {
    const mgr = this._viewer.transportManager;
    if (!mgr) {
      this._transportCache = null;
      this._transportCacheKey = null;
      return null;
    }
    if (this._transportCacheKey !== mgr) {
      // Pass registry for path resolution (surfaces array → path via getPathForNode)
      this._transportCache = new TransportFacadeImpl(mgr, this._viewer.registry);
      this._transportCacheKey = mgr;
    }
    return this._transportCache;
  }

  get events(): EventEmitter<ViewerEvents> {
    // RVViewer extends EventEmitter<ViewerEvents> — return-as-is, kein Cast nötig.
    return this._viewer;
  }

  get connectionState(): 'Connected' | 'Disconnected' {
    return this._viewer.connectionState;
  }

  get modes(): ModeFacade {
    const mgr = this._viewer.modes;
    return {
      get active() { return mgr.activeMode; },
      set: (id: ModeId) => mgr.setMode(id),
    };
  }

  loadModel = (url: string, opts?: { signalMap?: string }): Promise<void> => {
    // RVViewer.loadModel returns Promise<LoadResult>; we discard the result (void contract).
    // The PluginContext.loadModel opts ({ signalMap? }) differ from RVViewer's ({ overlay? });
    // for Phase 4a we forward URL only — overlay support can be added in Phase 4b if needed.
    return this._viewer.loadModel(url).then(() => undefined);
  };

  clearModel = (): void => {
    this._viewer.clearModel();
  };

  emit: PluginContext['emit'] = (event: string, data?: unknown) => {
    // RVViewer.emit has full EventEmitter<ViewerEvents> signature — forward via cast.
    // PluginContext['emit'] is EventEmitter<ViewerEvents>['emit'] which is an overloaded
    // function; the cast routes through the untyped overload.
    (this._viewer.emit as (event: string, data?: unknown) => void)(event, data);
  };
}

/** Taxonomy overrides for built-in plugins with a more specific write origin. */
export function pluginSignalWriterKind(pluginId: string): SignalWriterKind {
  if (pluginId === 'multiuser') return 'remote';
  if (pluginId === 'mcp-bridge') return 'mcp';
  if (pluginId === 'debug-endpoint') return 'debug';
  return 'plugin';
}
