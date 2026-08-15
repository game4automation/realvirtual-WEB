// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutStore — State management for the Layout Planner plugin.
 *
 * Uses useSyncExternalStore pattern for React integration.
 * Manages catalog tabs, placed components, selection, grid settings,
 * and localStorage persistence.
 */

import {
  getSignalLinkModeSnapshot,
  setSignalLinkModeExplicit,
  subscribeSignalLinkMode,
} from '../signal-bind/signal-link-mode-store';
import type { RvReferenceBounds } from '../../core/engine/rv-asset-reference';

// ─── Re-exports: the library layer moved to core/library (plan-372 §2.6.1) ──
//
// `rv-layout-store` has ~60 importers across core, plugins, tests and the
// private repo. Every name the library extraction took away is re-exported
// from here, so the move stayed invisible to all of them.

export type {
  LibraryCatalog,
  LibraryCatalogEntry,
  LibraryOrigin,
  LibrarySnapshot,
} from '../../core/library/library-types';
export {
  LibraryStore,
  resolveUrl,
  normalizeCatalogEntry,
  parseGitHubRepoUrl,
  isGitHubRepoScanUrl,
  isGitHubCatalogUrl,
  buildCatalogFromGitHub,
} from '../../core/library/library-store';

// ─── Types ──────────────────────────────────────────────────────────────

/** Direction semantics of a signal mapping (PLC convention). */
export type SignalLinkDirection = 'plcOutput' | 'plcInput';

/**
 * A single link between a Planner-component standard-signal SLOT and a live
 * realvirtual CONNECT signal. Persisted per {@link PlacedComponent} so it
 * survives reload. Optional on PlacedComponent → legacy scenes load unchanged.
 */
export interface SignalMapping {
  /** Binding sink. Missing on legacy mappings and interpreted as mapped-signal. */
  kind?: 'mapped-signal' | 'direct-property' | 'direct-feedback';
  /** Root-relative component-node path. Missing only on legacy mappings. */
  componentPath?: string;
  /** Component standard-signal slot, e.g. "Forward", "Flow.Run", "IsOccupied". */
  slot: string;
  /**
   * Source of the assignment (plan-325). Missing on legacy mappings and
   * interpreted as 'connect' at EVERY read site (use {@link mappingSourceKind}).
   *  - 'connect'  — `signal` is a CONNECT signal name at the provider.
   *  - 'internal' — `signal` is the SignalStore NAME of a model signal.
   */
  sourceKind?: 'connect' | 'internal';
  /** connect: CONNECT signal name (WITHOUT `__iface__/` prefix), e.g.
   *  "ConveyorMotor.Run". internal: SignalStore NAME of the model signal. */
  signal: string;
  /** Stable supplying interface id. Missing only on legacy mappings pending migration. */
  interfaceId?: string;
  /** MQTT topic when the provider exposes the signal through a topic. */
  topic?: string;
  /** PLC direction — read-only (plcOutput) vs. writable (plcInput). */
  direction: SignalLinkDirection;
  /** Binding temporarily disable-able without deleting it. */
  enabled: boolean;
  /**
   * Case A anchor (plan-425 F2): the unique SignalStore NAME of the node that
   * CARRIES this mapping, recorded at bind time.
   *
   * A node mapping is addressed by the path of its carrier, and a path is the
   * one thing a Unity re-parent changes. The signal name does not change — and
   * since plan-418 a duplicate name is fail-closed, so it identifies the carrier
   * as well as the path did. Written ONLY when the name was unambiguous at bind
   * time; a mapping without it keeps exactly today's behaviour (orphan).
   */
  carrierSignalName?: string;
  /**
   * Case B anchor (plan-425 F3): rv_extras component key of the slot this
   * mapping resolved to at bind time.
   *
   * The resolver has always known the type and has never persisted it
   * ("never persisted", rv-binding-slot-resolver), which left a re-parented
   * slot mapping with an under-determined key — component path plus slot name,
   * where the path is the broken half. With the type stored, a lost slot can be
   * looked for by type + slot + leaf name. Legacy mappings without it do NOT
   * take part in that search: guessing from two thirds of a key is the failure
   * mode this anchor exists to avoid.
   */
  componentType?: string;
}

/**
 * Effective source kind of a mapping — THE legacy default (`?? 'connect'`).
 * Every read site (bind, liveness, picker, popover, persistence read) goes
 * through this helper so mappings persisted before plan-325 keep loading as
 * CONNECT mappings unchanged.
 */
export function mappingSourceKind(mapping: Pick<SignalMapping, 'sourceKind'>): 'connect' | 'internal' {
  return mapping.sourceKind ?? 'connect';
}

export interface PlacedComponent {
  id: string;
  catalogId: string;
  glbUrl: string;
  label: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  /** If set, this placement is a Gaussian Splat (not a GLB). */
  splatUrl?: string;
  /** Visibility toggle. Missing/undefined = visible (legacy default). */
  visible?: boolean;
  /** Live-signal links to realvirtual CONNECT. Optional → legacy scenes load
   *  unchanged. Serialized as-is by {@link serializeLayout}. */
  signalMappings?: SignalMapping[];
  /**
   * Local extents of the placed asset, measured once at placement time
   * (plan-703 §2.8). Written into `AssetReference.bounds` by the bake.
   *
   * Optional in every direction, and read by exactly one consumer: the
   * wireframe placeholder shown when the asset can no longer be resolved. It is
   * recorded HERE, at the one moment the geometry is provably in hand — later
   * the file may be gone, which is the case the field exists for.
   */
  bounds?: RvReferenceBounds;
}

export interface LayoutFile {
  version: '1.0';
  name: string;
  createdAt: string;
  catalogUrls: string[];
  gridSizeMm: number;
  components: PlacedComponent[];
}

export type TransformMode = 'select' | 'translate' | 'rotate';

export interface LayoutSnapshot {
  catalogs: Map<string, LibraryCatalog>;
  catalogUrls: string[];
  catalogErrors: Map<string, string>;
  activeTabUrl: string | null;
  placed: PlacedComponent[];
  selectedId: string | null;
  mode: TransformMode;
  gridEnabled: boolean;
  /** Translation snap step in millimetres. Used by the snap grid AND the
   *  TransformControls translation snap when `gridEnabled` is true. */
  gridSizeMm: number;
  /** Rotation snap step in degrees. Used by TransformControls rotation snap
   *  when `gridEnabled` is true. */
  rotationSnapDeg: number;
  dropToSurface: boolean;
  /** Magnetic snap to other layout objects' bounding-box edges/centers.
   *  Independent of `gridEnabled`. When both are on, bbox snap takes
   *  priority within its tolerance; grid is the fallback quantizer. */
  bboxSnapEnabled: boolean;
  /** Snap tolerance in millimetres (world space). */
  bboxSnapToleranceMm: number;
  /** Include bbox centres as snap references (centre-to-centre / centre-to-edge). */
  bboxSnapMid: boolean;
  /** Include bbox edges (min/max) as snap references (edge-to-edge / edge-to-centre). */
  bboxSnapSide: boolean;
  /** Show 4-direction neighbor-distance overlay while dragging (independent of snap firing). */
  showNeighborDistances: boolean;
  /** Maximum distance (mm) at which neighbor-distance lines are still drawn.
   *  Farther neighbors are ignored — keeps the overlay relevant to the
   *  immediate surroundings instead of spanning the whole layout. */
  neighborDistanceMaxMm: number;
  /** Magnetic snap between matching snap points during drag. When off, the
   *  snap-point system still highlights markers and the picker works — only
   *  the drag-time pull to a matching snap is disabled. */
  snapPointMagnetEnabled: boolean;
  /** Chain mode: when an asset connected to others via snap pairs is moved,
   *  all transitively connected assets follow rigidly. Disable to drag each
   *  element solo (connections persist until detached/over-stretched). */
  chainModeEnabled: boolean;
  /** Documentation mode: when on, component datasheets (AAS drive docs) are
   *  shown on hover/selection in the planner. When off, the planner stays clean.
   *  Only gates docs while the planner is active — other viewing modes always
   *  show them. */
  docMode: boolean;
  /** Signal-linking mode (plan-226): when on, every placed element with bindable
   *  standard-signal slots shows a 3D status badge, and clicking it opens the
   *  CONNECT signal picker. When off, no badges and no picker — pure layout. Only
   *  meaningful while `plannerSignalLinking` is enabled on the viewer. */
  signalLinkMode: boolean;
  placementMode: string | null; // catalogEntry id for tap-to-place
  /** Entry ids whose preview thumbnail is currently being auto-generated.
   *  Cards render a spinner while their id is present. */
  thumbnailPending: ReadonlySet<string>;
  /** Placements whose geometry is still loading or has failed (plan-371).
   *  Drives the HMI status line. RUNTIME ONLY — never serialized: a pending
   *  placement's `PlacedComponent` already carries its `glbUrl` and is
   *  byte-identical to a finished one. */
  pendingPlacements: readonly PendingPlacementInfo[];
}

/** One row of the pending-load status line. */
export interface PendingPlacementInfo {
  /** Placement id — the same id the store and the object map use. */
  id: string;
  /** Catalog entry name, shown to the user. */
  name: string;
  status: 'loading' | 'error';
  /** Failure detail; only meaningful with `status: 'error'`. */
  error?: string;
}

// ─── localStorage keys ──────────────────────────────────────────────────

// LS_KEY_URLS / LS_KEY_ACTIVE_TAB moved to core/library/library-types.
const LS_KEY_AUTOSAVE = 'rv-layout-autosave';
const LS_KEY_GRID_ENABLED = 'rv-layout-grid-enabled';
const LS_KEY_GRID_SIZE = 'rv-layout-grid-size';
const LS_KEY_ROTATION_SNAP = 'rv-layout-rotation-snap';
const LS_KEY_DROP_TO_SURFACE = 'rv-layout-drop-to-surface';
const LS_KEY_BBOX_SNAP = 'rv-layout-bbox-snap-enabled';
const LS_KEY_BBOX_SNAP_MID = 'rv-layout-bbox-snap-mid';
const LS_KEY_BBOX_SNAP_SIDE = 'rv-layout-bbox-snap-side';
const LS_KEY_BBOX_SNAP_TOL = 'rv-layout-bbox-snap-tolerance';
const LS_KEY_SHOW_NEIGHBOR_DIST = 'rv-layout-show-neighbor-distances';
const LS_KEY_NEIGHBOR_DIST_MAX = 'rv-layout-neighbor-distance-max';
const LS_KEY_SNAPPOINT_MAGNET = 'rv-layout-snappoint-magnet-enabled';
const LS_KEY_CHAIN_MODE = 'rv-layout-chain-mode-enabled';
const LS_KEY_DOC_MODE = 'rv-layout-doc-mode';

/** Default magnetic-snap tolerance in millimetres (world space). */
const DEFAULT_BBOX_SNAP_TOLERANCE_MM = 30;
const MIN_BBOX_SNAP_TOLERANCE_MM = 1;
const MAX_BBOX_SNAP_TOLERANCE_MM = 1000;
const DEFAULT_NEIGHBOR_DIST_MAX_MM = 5000;
const MIN_NEIGHBOR_DIST_MAX_MM = 100;
const MAX_NEIGHBOR_DIST_MAX_MM = 100_000;

// ─── Serialization helpers ──────────────────────────────────────────────

export function serializeLayout(
  name: string,
  components: PlacedComponent[],
  catalogUrls: string[],
  gridSizeMm: number,
): LayoutFile {
  return {
    version: '1.0',
    name,
    createdAt: new Date().toISOString(),
    catalogUrls,
    gridSizeMm,
    components,
  };
}

/** Field-wise comparison of two pending-placement lists (order-sensitive —
 *  the registry preserves insertion order, so a reorder IS a change). */
export function samePendingPlacements(
  a: readonly PendingPlacementInfo[],
  b: readonly PendingPlacementInfo[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
    if (a[i].name !== b[i].name) return false;
    if (a[i].status !== b[i].status) return false;
    if (a[i].error !== b[i].error) return false;
  }
  return true;
}

export function deserializeLayout(json: string): LayoutFile {
  const data = JSON.parse(json);
  return data as LayoutFile;
}

// ─── Grid snap helper ───────────────────────────────────────────────────

export function snapToGrid(
  pos: { x: number; y: number; z: number },
  gridSize: number,
): { x: number; y: number; z: number } {
  if (gridSize <= 0) return { ...pos };
  return {
    x: Math.round(pos.x / gridSize) * gridSize,
    y: pos.y,
    z: Math.round(pos.z / gridSize) * gridSize,
  };
}

// alignToFloor() moved to model-cache.ts — single source of truth.

import { LibraryStore as LibraryStoreImpl } from '../../core/library/library-store';
import type { LibraryStore as LibraryStoreClass } from '../../core/library/library-store';
import type {
  LibraryCatalog,
  LibraryCatalogEntry,
  LibraryOrigin,
} from '../../core/library/library-types';

// ─── Store ──────────────────────────────────────────────────────────────

/**
 * Planner state — and, since plan-372 Phase 4, an ADAPTER over the shared
 * {@link LibraryStoreClass} (§2.6.2).
 *
 * The catalog fields left this class; what stayed is the full public surface.
 * Four things make the split invisible to the ~60 modules that read this store:
 *
 *  1. **Getters and mutators both delegate.** A partial adapter would have left
 *     the 11 mutating call sites in `layout-planner/index.ts` writing into a
 *     dead copy.
 *  2. **A notification bridge.** The constructor subscribes to the library
 *     store and rebuilds the COMBINED snapshot on every library mutation —
 *     without it no React consumer would ever see a library change, because
 *     they all read `LayoutSnapshot`, not `LibrarySnapshot`.
 *  3. **Exactly one notification per mutation.** Delegating mutators must not
 *     call `_notify()` themselves; the bridge already does it.
 *  4. **{@link dispose}** unsubscribes both the bridge and the signal-link-mode
 *     subscription — the plugin can be torn down and rebuilt.
 */
export class LayoutStore {
  /** Shared catalog state. Injected so tests can isolate; the planner passes
   *  the process-wide singleton (`getLibraryStore()`). */
  private readonly _library: LibraryStoreClass;
  private _unsubLibrary: (() => void) | null = null;
  private _unsubSignalLinkMode: (() => void) | null = null;
  private _placed: PlacedComponent[] = [];
  private _selectedId: string | null = null;
  private _mode: TransformMode = 'select';
  private _gridEnabled = true;
  private _gridSizeMm = 500;
  private _rotationSnapDeg = 15;
  private _dropToSurface = true;
  private _bboxSnapEnabled = false;
  private _bboxSnapToleranceMm = DEFAULT_BBOX_SNAP_TOLERANCE_MM;
  private _bboxSnapMid = true;
  private _bboxSnapSide = true;
  private _showNeighborDistances = true;
  private _neighborDistanceMaxMm = DEFAULT_NEIGHBOR_DIST_MAX_MM;
  private _snapPointMagnetEnabled = true;
  private _chainModeEnabled = true;
  private _docMode = false;
  private _placementMode: string | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: LayoutSnapshot;
  /** plan-371 pending placements. Runtime only — see `setPendingPlacements`. */
  private _pendingPlacements: PendingPlacementInfo[] = [];

  constructor(library?: LibraryStoreClass) {
    // Lazily required so `rv-layout-store` stays importable in tests that never
    // touch the library layer; a caller that wants the shared state passes it.
    this._library = library ?? new LibraryStoreImpl();

    // Restore grid settings from localStorage
    try {
      const ge = localStorage.getItem(LS_KEY_GRID_ENABLED);
      if (ge !== null) this._gridEnabled = ge === 'true';
      const gs = localStorage.getItem(LS_KEY_GRID_SIZE);
      if (gs !== null) {
        const n = Number(gs);
        if (!Number.isNaN(n) && n >= 0) this._gridSizeMm = n; // 0 = translation snap off
      }
      const rs = localStorage.getItem(LS_KEY_ROTATION_SNAP);
      if (rs !== null) {
        const n = Number(rs);
        if (!Number.isNaN(n) && n > 0) this._rotationSnapDeg = n;
      }
      const dts = localStorage.getItem(LS_KEY_DROP_TO_SURFACE);
      if (dts !== null) this._dropToSurface = dts === 'true';
      const bs = localStorage.getItem(LS_KEY_BBOX_SNAP);
      if (bs !== null) this._bboxSnapEnabled = bs === 'true';
      const bsm = localStorage.getItem(LS_KEY_BBOX_SNAP_MID);
      if (bsm !== null) this._bboxSnapMid = bsm === 'true';
      const bss = localStorage.getItem(LS_KEY_BBOX_SNAP_SIDE);
      if (bss !== null) this._bboxSnapSide = bss === 'true';
      const bst = localStorage.getItem(LS_KEY_BBOX_SNAP_TOL);
      if (bst !== null) {
        const n = Number(bst);
        if (Number.isFinite(n) && n >= MIN_BBOX_SNAP_TOLERANCE_MM && n <= MAX_BBOX_SNAP_TOLERANCE_MM) {
          this._bboxSnapToleranceMm = n;
        }
      }
      const snd = localStorage.getItem(LS_KEY_SHOW_NEIGHBOR_DIST);
      if (snd !== null) this._showNeighborDistances = snd === 'true';
      const ndm = localStorage.getItem(LS_KEY_NEIGHBOR_DIST_MAX);
      if (ndm !== null) {
        const n = Number(ndm);
        if (Number.isFinite(n) && n >= MIN_NEIGHBOR_DIST_MAX_MM && n <= MAX_NEIGHBOR_DIST_MAX_MM) {
          this._neighborDistanceMaxMm = n;
        }
      }
      const spm = localStorage.getItem(LS_KEY_SNAPPOINT_MAGNET);
      if (spm !== null) this._snapPointMagnetEnabled = spm === 'true';
      const cm = localStorage.getItem(LS_KEY_CHAIN_MODE);
      if (cm !== null) this._chainModeEnabled = cm === 'true';
      const dm = localStorage.getItem(LS_KEY_DOC_MODE);
      if (dm !== null) this._docMode = dm === 'true';
    } catch { /* ignore */ }

    this._snapshot = this._createSnapshot();
    // Notification bridge (§2.6.2 point 2) — a DIRECT library mutation must
    // reach every LayoutSnapshot consumer, and must do so exactly once.
    this._unsubLibrary = this._library.subscribe(() => this._notify());
    this._unsubSignalLinkMode = subscribeSignalLinkMode(() => this._notify());
  }

  /** Detach both subscriptions. Called from the plugin's `dispose()`. */
  dispose(): void {
    this._unsubLibrary?.();
    this._unsubLibrary = null;
    this._unsubSignalLinkMode?.();
    this._unsubSignalLinkMode = null;
    this._listeners.clear();
  }

  /** The shared library state behind this adapter. */
  get library(): LibraryStoreClass { return this._library; }

  // ─── useSyncExternalStore API ─────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): LayoutSnapshot => {
    return this._snapshot;
  };

  // ─── Catalog management — DELEGATED to the LibraryStore (§2.6.2) ──
  //
  // Every method below forwards and does NOT call `_notify()`: the library
  // store notifies, the bridge in the constructor turns that into exactly one
  // LayoutStore notification with a freshly combined snapshot.

  /** Add a library subscription. `origin` drives the persistence policy (§2.6.3). */
  async addCatalog(url: string, origin: LibraryOrigin = 'user'): Promise<void> {
    return this._library.addCatalog(url, origin);
  }

  /** Inject a pre-built catalog without fetching (e.g. bundled library). */
  addCatalogDirect(key: string, catalog: LibraryCatalog): void {
    this._library.addCatalogDirect(key, catalog);
  }

  /** Update the thumbnail URL for a specific catalog entry. */
  setEntryThumbnail(entryId: string, thumbnailUrl: string): void {
    this._library.setEntryThumbnail(entryId, thumbnailUrl);
  }

  /** Mark/unmark an entry as having its preview auto-generated. */
  setThumbnailPending(entryId: string, pending: boolean): void {
    this._library.setThumbnailPending(entryId, pending);
  }

  removeCatalog(url: string): void {
    this._library.removeCatalog(url);
  }

  setActiveTab(url: string): void {
    this._library.setActiveTab(url);
  }

  async restoreFromStorage(): Promise<void> {
    return this._library.restoreFromStorage();
  }

  /**
   * Replace the pending-placement list (plan-371). Pure in-memory state — it
   * never reaches `serializeLayout` and has no localStorage key.
   *
   * The equality guard matters: the registry notifies on every generation bump
   * and every cancel, and a `_notify()` per event would rerender the whole
   * planner UI for a list that did not actually change.
   */
  setPendingPlacements(list: readonly PendingPlacementInfo[]): void {
    if (samePendingPlacements(this._pendingPlacements, list)) return;
    this._pendingPlacements = list.map((p) => ({ ...p }));
    this._notify();
  }

  // ─── Component management ─────────────────────────────────────────

  addComponent(comp: PlacedComponent): void {
    this._placed = [...this._placed, comp];
    this._notify();
  }

  removeComponent(id: string): void {
    this._placed = this._placed.filter(c => c.id !== id);
    if (this._selectedId === id) this._selectedId = null;
    this._notify();
  }

  selectComponent(id: string | null): void {
    this._selectedId = id;
    this._notify();
  }

  updateTransform(id: string, position: [number, number, number], rotation: [number, number, number]): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, position, rotation } : c,
    );
    this._notify();
  }

  /** Replace the scale vector of a placed component. Used by splat axis
   *  inversion (sets components to ±1) — drag/translate paths do not touch
   *  scale, so this is the only writer aside from the loader. */
  updateScale(id: string, scale: [number, number, number]): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, scale } : c,
    );
    this._notify();
  }

  /** Toggle visibility of a placed component. Persisted so the
   *  hide-state survives reload (Three.js `object.visible` is not part
   *  of the GLB cache and would otherwise be lost). */
  updateVisibility(id: string, visible: boolean): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, visible } : c,
    );
    this._notify();
  }

  /** Replace the signal mappings of a placed component. An empty array is kept
   *  (not dropped) so an explicit "all unbound" state round-trips. */
  updateSignalMappings(id: string, signalMappings: SignalMapping[]): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, signalMappings } : c,
    );
    this._notify();
  }

  updateGlbUrl(id: string, glbUrl: string): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, glbUrl } : c,
    );
    this._notify();
  }

  updateLabel(id: string, label: string): void {
    this._placed = this._placed.map(c =>
      c.id === id ? { ...c, label } : c,
    );
    this._notify();
  }

  // ─── Mode & Grid ──────────────────────────────────────────────────

  setMode(mode: TransformMode): void {
    this._mode = mode;
    this._notify();
  }

  setGridEnabled(enabled: boolean): void {
    this._gridEnabled = enabled;
    try { localStorage.setItem(LS_KEY_GRID_ENABLED, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  setDropToSurface(enabled: boolean): void {
    this._dropToSurface = enabled;
    try { localStorage.setItem(LS_KEY_DROP_TO_SURFACE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle magnetic snap to other layout objects. Persisted to localStorage. */
  setBboxSnap(enabled: boolean): void {
    this._bboxSnapEnabled = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle whether bbox centres count as snap references. Persisted. */
  setBboxSnapMid(enabled: boolean): void {
    this._bboxSnapMid = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_MID, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle whether bbox edges (min/max) count as snap references. Persisted. */
  setBboxSnapSide(enabled: boolean): void {
    this._bboxSnapSide = enabled;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_SIDE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set magnetic-snap tolerance in millimetres. Persisted to localStorage. */
  setBboxSnapToleranceMm(mm: number): void {
    this._bboxSnapToleranceMm = mm;
    try { localStorage.setItem(LS_KEY_BBOX_SNAP_TOL, String(mm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle the 4-direction neighbor-distance overlay during drag. */
  setShowNeighborDistances(enabled: boolean): void {
    this._showNeighborDistances = enabled;
    try { localStorage.setItem(LS_KEY_SHOW_NEIGHBOR_DIST, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set the maximum auto-measure distance in millimetres. */
  setNeighborDistanceMaxMm(mm: number): void {
    this._neighborDistanceMaxMm = mm;
    try { localStorage.setItem(LS_KEY_NEIGHBOR_DIST_MAX, String(mm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle drag-time magnetic snap between matching snap points. */
  setSnapPointMagnet(enabled: boolean): void {
    this._snapPointMagnetEnabled = enabled;
    try { localStorage.setItem(LS_KEY_SNAPPOINT_MAGNET, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle chain mode: when on, connected assets follow during drag. */
  setChainMode(enabled: boolean): void {
    this._chainModeEnabled = enabled;
    try { localStorage.setItem(LS_KEY_CHAIN_MODE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle documentation mode: when on, component datasheets are shown on
   *  hover/selection while the planner is active. */
  setDocMode(enabled: boolean): void {
    this._docMode = enabled;
    try { localStorage.setItem(LS_KEY_DOC_MODE, String(enabled)); } catch { /* ignore */ }
    this._notify();
  }

  /** Toggle signal-linking mode (plan-226): when on, placed elements with
   *  bindable slots show a 3D status badge and clicking opens the signal picker. */
  setSignalLinkMode(enabled: boolean): void {
    setSignalLinkModeExplicit(enabled);
  }

  setGridSize(mm: number): void {
    this._gridSizeMm = Math.max(0, mm); // 0 = translation snap off (grid not drawn)
    try { localStorage.setItem(LS_KEY_GRID_SIZE, String(this._gridSizeMm)); } catch { /* ignore */ }
    this._notify();
  }

  /** Set the rotation snap step in degrees. Persisted to localStorage. */
  setRotationSnapDeg(deg: number): void {
    this._rotationSnapDeg = deg;
    try { localStorage.setItem(LS_KEY_ROTATION_SNAP, String(deg)); } catch { /* ignore */ }
    this._notify();
  }

  setPlacementMode(catalogEntryId: string | null): void {
    this._placementMode = catalogEntryId;
    this._notify();
  }

  // ─── Persistence ──────────────────────────────────────────────────

  autoSave(): void {
    try {
      const layout = serializeLayout(
        'autosave',
        this._placed,
        // §2.6.2 point 4 — read through the delegated getter, not a local copy.
        this._library.catalogUrls,
        this._gridSizeMm,
      );
      localStorage.setItem(LS_KEY_AUTOSAVE, JSON.stringify(layout));
    } catch {
      // QuotaExceededError — silently ignore
    }
  }

  loadAutoSave(): void {
    try {
      const json = localStorage.getItem(LS_KEY_AUTOSAVE);
      if (!json) return;
      const layout = deserializeLayout(json);
      this._placed = layout.components;
      this._gridSizeMm = layout.gridSizeMm;
      this._notify();
    } catch { /* ignore corrupt data */ }
  }

  /** Replace all placed components (used when loading a layout file). */
  setComponents(components: PlacedComponent[]): void {
    this._placed = [...components];
    this._selectedId = null;
    this._notify();
  }

  // ─── Getters (non-React) ──────────────────────────────────────────

  get placed(): PlacedComponent[] { return this._placed; }
  get selectedId(): string | null { return this._selectedId; }
  get gridEnabled(): boolean { return this._gridEnabled; }
  get gridSizeMm(): number { return this._gridSizeMm; }
  /** Translation grid is "on" only when enabled AND a non-zero step is set.
   *  A 0 mm step means translation snapping is off and the grid is not drawn
   *  (rotation snap stays governed by `gridEnabled` alone). */
  get gridActive(): boolean { return this._gridEnabled && this._gridSizeMm > 0; }
  get rotationSnapDeg(): number { return this._rotationSnapDeg; }
  get dropToSurface(): boolean { return this._dropToSurface; }
  get bboxSnapEnabled(): boolean { return this._bboxSnapEnabled; }
  get bboxSnapToleranceMm(): number { return this._bboxSnapToleranceMm; }
  get bboxSnapMid(): boolean { return this._bboxSnapMid; }
  get bboxSnapSide(): boolean { return this._bboxSnapSide; }
  get showNeighborDistances(): boolean { return this._showNeighborDistances; }
  get neighborDistanceMaxMm(): number { return this._neighborDistanceMaxMm; }
  get snapPointMagnetEnabled(): boolean { return this._snapPointMagnetEnabled; }
  get chainModeEnabled(): boolean { return this._chainModeEnabled; }
  get docMode(): boolean { return this._docMode; }
  get signalLinkMode(): boolean { return getSignalLinkModeSnapshot().explicit; }

  // ─── Internal ─────────────────────────────────────────────────────

  /**
   * The COMBINED snapshot (§2.6.2 point 2).
   *
   * The library half is spread in from the library store's own snapshot rather
   * than copied field by field, so a future library field reaches every planner
   * consumer without another edit here. Everything below it is planner-only.
   */
  private _createSnapshot(): LayoutSnapshot {
    const lib = this._library.getSnapshot();
    return {
      catalogs: lib.catalogs,
      catalogUrls: lib.catalogUrls,
      catalogErrors: lib.catalogErrors,
      activeTabUrl: lib.activeTabUrl,
      thumbnailPending: lib.thumbnailPending,
      placed: this._placed,
      selectedId: this._selectedId,
      mode: this._mode,
      gridEnabled: this._gridEnabled,
      gridSizeMm: this._gridSizeMm,
      rotationSnapDeg: this._rotationSnapDeg,
      dropToSurface: this._dropToSurface,
      bboxSnapEnabled: this._bboxSnapEnabled,
      bboxSnapToleranceMm: this._bboxSnapToleranceMm,
      bboxSnapMid: this._bboxSnapMid,
      bboxSnapSide: this._bboxSnapSide,
      showNeighborDistances: this._showNeighborDistances,
      neighborDistanceMaxMm: this._neighborDistanceMaxMm,
      snapPointMagnetEnabled: this._snapPointMagnetEnabled,
      chainModeEnabled: this._chainModeEnabled,
      docMode: this._docMode,
      signalLinkMode: getSignalLinkModeSnapshot().explicit,
      placementMode: this._placementMode,
      pendingPlacements: this._pendingPlacements,
    };
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const l of this._listeners) l();
  }
}
