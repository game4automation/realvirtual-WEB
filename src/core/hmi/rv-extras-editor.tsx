// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RvExtrasEditorPlugin — Hierarchy browser and extras editor plugin.
 *
 * Manages the hierarchy browser state, node selection, and overlay mutations.
 * The UI button lives in TopBar (system menu) alongside VR and Settings.
 * Clicking a node updates the selectedNodePath state; the PropertyInspector
 * reads and mutates overlay data via the methods here.
 */

import type { RVViewerPlugin } from '../rv-plugin';
import type { LoadResult } from '../engine/rv-scene-loader';
import { NodeRegistry } from '../engine/rv-node-registry';
import type { RVViewer } from '../rv-viewer';
import { RvReferenceDrill } from '../engine/rv-reference-scope';
import type { ContextMenuTarget } from './context-menu-store';
import { loadOverlay, saveOverlay, saveOriginals, loadOriginals, removeOriginals, type RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import { materialise as materialiseEdits } from './scene/rv-scene-edits';
import { getSceneStore } from './scene/scene-store-singleton';
import { getActiveEditTarget } from './rv-edit-target';
import { isHiddenComponentType, baseComponentType } from './rv-inspector-helpers';
import { isEphemeralField } from './rv-value-resolver';
import { getFieldDescriptor, isFieldDisplayReadonly } from '../engine/rv-component-registry';
import { openSetPositionDialog } from './SetPositionDialog';
import { INSPECTOR_PANEL_WIDTH, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH } from './layout-constants';
import { isCompactWidth } from '../../hooks/use-mobile-layout';

// ─── Layout Object Helpers (for context menu) ──────────────────────────

/** Check if a context menu target has a LayoutObject component. */
function hasLayoutObject(target: ContextMenuTarget): boolean {
  return !!(target.extras as Record<string, unknown>)?.LayoutObject;
}

/** Check if a node at the given path is locked. */
function isNodeLocked(viewer: RVViewer, path: string): boolean {
  const node = viewer.registry?.getNode(path);
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return !!(rv?.LayoutObject?.Locked);
}

/**
 * Get the effective list of layout object paths for a context menu action.
 * If multiple objects are selected, returns all selected paths that have LayoutObject.
 * Otherwise returns just the target path.
 */
function getLayoutPaths(viewer: RVViewer, target: ContextMenuTarget): string[] {
  const sel = viewer.selectionManager;
  if (sel.count > 1) {
    const paths = [...sel.selectedPaths].filter(p => {
      const node = viewer.registry?.getNode(p);
      const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
      return !!rv?.LayoutObject;
    });
    if (paths.length > 0) return paths;
  }
  return [target.path];
}

/** Get count of layout objects that will be affected. */
function getLayoutCount(viewer: RVViewer, target: ContextMenuTarget): number {
  return getLayoutPaths(viewer, target).length;
}

// ─── Editable Node Info ──────────────────────────────────────────────────

export interface EditableNodeInfo {
  /** Full hierarchy path (e.g. 'DemoCell/Conveyor1'). */
  path: string;
  /** Component types present on this node (e.g. ['Drive', 'TransportSurface']). */
  types: string[];
}

/**
 * Source of a selectNode() call.
 * - 'tree'     — explicit selection from the hierarchy panel; sub-node paths
 *                under a LayoutObject must remain unchanged
 * - 'viewport' — 3D-viewport pick; resolves up to the LayoutObject root so
 *                clicking any sub-mesh selects the whole placed object
 * - 'api'      — programmatic call from plugins/tests; no resolution applied
 */
export type SelectionSource = 'tree' | 'viewport' | 'api';

// ─── Plugin State (external store for React) ─────────────────────────────

/** Default and min/max width for the hierarchy panel. */
export const HIERARCHY_MIN_WIDTH = 200;
export const HIERARCHY_MAX_WIDTH = 600;
export const HIERARCHY_DEFAULT_WIDTH = 280;

const LS_KEY_PANEL_WIDTH = 'rv-extras-editor-width';
const LS_KEY_INSPECTOR_WIDTH = 'rv-inspector-width';
const LS_KEY_PANEL_OPEN = 'rv-extras-editor-open';
const LS_KEY_SELECTED_NODE = 'rv-extras-editor-selected';

/** Snapshot of plugin state for React consumption. */
export interface ExtrasEditorState {
  panelOpen: boolean;
  panelWidth: number;
  /** Live width of the property inspector panel (resizable, persisted). */
  inspectorWidth: number;
  overlay: RVExtrasOverlay | null;
  editableNodes: EditableNodeInfo[];
  selectedNodePath: string | null;
  /** Set by selectAndReveal(), consumed by HierarchyBrowser to expand ancestors and scroll-to. */
  revealPath: string | null;
  /** Set by selectAndRevealExclusive(): the hierarchy collapses every branch
   *  not on the revealed path when consuming the reveal. */
  revealCollapseOthers: boolean;
  /** Whether the property inspector should be shown (true when selected from hierarchy, false from 3D click). */
  showInspector: boolean;
  /** Whether the settings panel is open (shared so ButtonPanel can shift). */
  settingsOpen: boolean;
}

// ─── Plugin ──────────────────────────────────────────────────────────────

export class RvExtrasEditorPlugin implements RVViewerPlugin {
  readonly id = 'rv-extras-editor';
  readonly core = true;

  // ── State ──
  private _panelOpen = false;
  private _panelWidth: number;
  private _inspectorWidth: number;
  private _overlay: RVExtrasOverlay | null = null;
  private _editableNodes: EditableNodeInfo[] = [];
  private _selectedNodePath: string | null = null;
  private _revealPath: string | null = null;
  /** While true, selection-changed selects without revealing (see
   *  {@link RvExtrasEditorPlugin.setRevealSuppressed}). */
  private _revealSuppressed = false;
  private _revealCollapseOthers = false;
  private _showInspector = false;
  private _settingsOpen = false;
  private _viewer: RVViewer | null = null;
  private _glbName: string | null = null;

  /** Snapshot of original GLB values before any override was applied.
   *  Key: `${nodePath}/${componentType}/${fieldName}` → original value */
  private _originals = new Map<string, unknown>();

  constructor() {
    const storedWidth = localStorage.getItem(LS_KEY_PANEL_WIDTH);
    this._panelWidth = storedWidth ? Math.max(HIERARCHY_MIN_WIDTH, Math.min(HIERARCHY_MAX_WIDTH, Number(storedWidth))) : HIERARCHY_DEFAULT_WIDTH;
    const storedInspectorWidth = localStorage.getItem(LS_KEY_INSPECTOR_WIDTH);
    this._inspectorWidth = storedInspectorWidth ? Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, Number(storedInspectorWidth))) : INSPECTOR_PANEL_WIDTH;
    this._panelOpen = localStorage.getItem(LS_KEY_PANEL_OPEN) === 'true';
    this._selectedNodePath = localStorage.getItem(LS_KEY_SELECTED_NODE) || null;
    this._snapshot = {
      panelOpen: this._panelOpen,
      panelWidth: this._panelWidth,
      inspectorWidth: this._inspectorWidth,
      overlay: null,
      editableNodes: [],
      selectedNodePath: this._selectedNodePath,
      revealPath: null,
      revealCollapseOthers: false,
      showInspector: false,
      settingsOpen: false,
    };
  }

  // ── External store subscription (React) ──
  private _listeners = new Set<() => void>();

  /** Cached snapshot — MUST be a stable reference between notifications.
   *  Creating a new object in getSnapshot causes infinite React re-renders. */
  private _snapshot: ExtrasEditorState = {
    panelOpen: false,
    panelWidth: HIERARCHY_DEFAULT_WIDTH,
    inspectorWidth: INSPECTOR_PANEL_WIDTH,
    overlay: null,
    editableNodes: [],
    selectedNodePath: null,
    revealPath: null,
    revealCollapseOthers: false,
    showInspector: false,
    settingsOpen: false,
  };

  /** Subscribe for React useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Snapshot getter for React useSyncExternalStore. Returns stable reference. */
  getSnapshot = (): ExtrasEditorState => this._snapshot;

  private notify(): void {
    this._snapshot = {
      panelOpen: this._panelOpen,
      panelWidth: this._panelWidth,
      inspectorWidth: this._inspectorWidth,
      overlay: this._overlay,
      editableNodes: this._editableNodes,
      selectedNodePath: this._selectedNodePath,
      revealPath: this._revealPath,
      revealCollapseOthers: this._revealCollapseOthers,
      showInspector: this._showInspector,
      settingsOpen: this._settingsOpen,
    };
    for (const listener of this._listeners) listener();
  }

  // ── Public API ──

  get panelOpen(): boolean { return this._panelOpen; }

  togglePanel(): void {
    this._panelOpen = !this._panelOpen;
    localStorage.setItem(LS_KEY_PANEL_OPEN, String(this._panelOpen));
    // Coordinate with LeftPanelManager for mutual exclusion
    if (this._viewer) {
      if (this._panelOpen) {
        this._viewer.leftPanelManager.open('hierarchy', this._panelWidth);
      } else {
        this._viewer.leftPanelManager.close('hierarchy');
      }
    }
    // Scans skipped while closed land now (notify() below publishes the result).
    if (this._panelOpen) this._flushStaleEditableNodes();
    this.notify();
  }

  setSettingsOpen(open: boolean): void {
    this._settingsOpen = open;
    this.notify();
  }

  setPanelWidth(width: number): void {
    this._panelWidth = Math.max(HIERARCHY_MIN_WIDTH, Math.min(HIERARCHY_MAX_WIDTH, width));
    localStorage.setItem(LS_KEY_PANEL_WIDTH, String(this._panelWidth));
    this.notify();
  }

  setInspectorWidth(width: number): void {
    this._inspectorWidth = Math.max(INSPECTOR_MIN_WIDTH, Math.min(INSPECTOR_MAX_WIDTH, width));
    localStorage.setItem(LS_KEY_INSPECTOR_WIDTH, String(this._inspectorWidth));
    this.notify();
  }

  /**
   * Update the selected node path and snapshot it to localStorage.
   *
   * `source` differentiates click origins: viewport picks resolve up to the
   * enclosing LayoutObject (matches the whole-object hover/click highlight),
   * tree/api selections stay on the explicit path.
   */
  selectNode(path: string, showInspector?: boolean): void;
  selectNode(path: string, source: SelectionSource): void;
  selectNode(path: string, showInspector: boolean, source: SelectionSource): void;
  selectNode(
    path: string,
    showInspectorOrSource: boolean | SelectionSource = false,
    sourceArg: SelectionSource = 'api',
  ): void {
    const show = typeof showInspectorOrSource === 'boolean' ? showInspectorOrSource : false;
    const source: SelectionSource = typeof showInspectorOrSource === 'string'
      ? showInspectorOrSource
      : sourceArg;
    if (source === 'viewport') {
      // Reference wins over LayoutObject: decision 22 says the unit of selection
      // is the OUTERMOST reference, and a reference always encloses whatever
      // LayoutObject markers sit inside the file it points at. Resolving to the
      // inner marker first would select a part of another asset — the very thing
      // the rule exists to prevent.
      const reference = this.findOutermostReferenceAncestor(path);
      if (reference) path = reference;
      else {
        const resolved = this.findLayoutObjectAncestor(path);
        if (resolved) path = resolved;
      }
    }
    this._selectedNodePath = path;
    this._showInspector = show;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
  }

  /** Cache for ancestor lookups; invalidated whenever editableNodes refresh. */
  private _ancestorCache = new Map<string, string | null>();

  /**
   * Walk up the registered hierarchy from `path` and return the path of the
   * nearest ancestor (inclusive) whose Three.js node carries a
   * `userData.realvirtual.LayoutObject` marker. Returns null if no such
   * ancestor exists. Cached per-path; cleared on `refreshEditableNodes`.
   */
  findLayoutObjectAncestor(path: string): string | null {
    if (this._ancestorCache.has(path)) return this._ancestorCache.get(path)!;
    if (!this._viewer?.registry) return null;
    const node = this._viewer.registry.getNode(path);
    if (!node) return null;
    let current: import('three').Object3D | null = node;
    while (current) {
      const rv = current.userData?.realvirtual as Record<string, unknown> | undefined;
      if (rv?.LayoutObject) {
        const ancestor = this._viewer.registry.getPathForNode(current);
        this._ancestorCache.set(path, ancestor);
        return ancestor;
      }
      current = current.parent;
    }
    this._ancestorCache.set(path, null);
    return null;
  }

  /** Drill state for the reference selection rule (plan-703 §2.4.1). */
  private readonly _referenceDrill = new RvReferenceDrill();
  /** Same shape of cache as `_ancestorCache`, cleared with it. */
  private _referenceCache = new Map<string, string | null>();

  /**
   * The OUTERMOST enclosing `AssetReference` of `path` (inclusive), or null.
   *
   * The sibling of {@link findLayoutObjectAncestor}: same walk, same cache
   * discipline, different marker — and outermost rather than nearest, because a
   * nested reference belongs to a file the open document cannot restructure
   * either (F8). Honours the current drill level, so a double-click that went
   * one level in keeps selecting at that level until the anchor changes.
   *
   * Cheap and OUTSIDE the picking path: this runs on the already-resolved hit,
   * at the same place the LayoutObject resolution has always run
   * (`doc-render-picking.md` §2.4 rule 1).
   */
  findOutermostReferenceAncestor(path: string): string | null {
    const cached = this._referenceCache.get(path);
    if (cached !== undefined && this._referenceDrill.drillLevel === 0) return cached;
    if (!this._viewer?.registry) return null;
    const node = this._viewer.registry.getNode(path);
    if (!node) return null;

    const result = this._referenceDrill.select(
      node, 'viewport', this._viewer.currentModelRoot ?? null,
    );
    if (!result.resolved) {
      if (this._referenceDrill.drillLevel === 0) this._referenceCache.set(path, null);
      return null;
    }
    const resolved = this._viewer.registry.getPathForNode(result.node);
    if (this._referenceDrill.drillLevel === 0) this._referenceCache.set(path, resolved);
    return resolved;
  }

  /**
   * Double-click in the viewport: one reference level in (decision 22).
   *
   * Returns the newly selected path, or null when the hit is not inside a
   * reference at all — the caller then keeps its ordinary double-click meaning.
   */
  drillIntoReference(path: string): string | null {
    if (!this._viewer?.registry) return null;
    const node = this._viewer.registry.getNode(path);
    if (!node) return null;
    const result = this._referenceDrill.drillIn(node, this._viewer.currentModelRoot ?? null);
    const next = this._viewer.registry.getPathForNode(result.node);
    if (!next) return null;
    this.selectNode(next, 'api');
    return next;
  }

  /** Escape: one reference level back out. */
  drillOutOfReference(path: string): string | null {
    if (!this._viewer?.registry) return null;
    const node = this._viewer.registry.getNode(path);
    if (!node) return null;
    const result = this._referenceDrill.drillOut(node, this._viewer.currentModelRoot ?? null);
    const next = this._viewer.registry.getPathForNode(result.node);
    if (!next) return null;
    this.selectNode(next, 'api');
    return next;
  }

  /** Forget the drill level — a fresh gesture starts at the outermost again. */
  resetReferenceDrill(): void {
    this._referenceDrill.reset();
  }

  /** Convenience: read the currently selected node path. */
  getSelectedPath(): string | null {
    return this._selectedNodePath;
  }

  /** Convenience: snapshot of editable nodes (matches `state.editableNodes`).
   *  Imperative readers (MCP tools, tests) may ask while the panel is closed, so
   *  a scan deferred by `_scheduleEditableNodesRefresh` is settled here first.
   *  React components read `state.editableNodes` instead — never this. */
  getEditableNodes(): EditableNodeInfo[] {
    this._flushStaleEditableNodes();
    return this._editableNodes;
  }

  clearSelection(): void {
    this._selectedNodePath = null;
    this._showInspector = false;
    localStorage.removeItem(LS_KEY_SELECTED_NODE);
    this.notify();
  }

  /**
   * Select a node and request the hierarchy browser to reveal it
   * by expanding all ancestor tree nodes and scrolling to it.
   * Opens the panel if currently closed.
   */
  selectAndReveal(path: string, showInspector = true): void {
    if (!this._panelOpen) {
      this._panelOpen = true;
      localStorage.setItem(LS_KEY_PANEL_OPEN, 'true');
      // Coordinate with LeftPanelManager for mutual exclusion
      if (this._viewer) {
        this._viewer.leftPanelManager.open('hierarchy', this._panelWidth);
      }
    }
    // The tree is about to render — a scan deferred while the panel was closed
    // must land first, or the revealed path is not in `editableNodes` yet.
    this._flushStaleEditableNodes();
    this._selectedNodePath = path;
    this._revealPath = path;
    this._showInspector = showInspector;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
  }

  /**
   * Like selectAndReveal, but asks the hierarchy browser to collapse every
   * branch that is not on the revealed path — the revealed node ends up as
   * the only open line of the tree. Used when a freshly created node should
   * get full focus (e.g. the auto-created Kinematic node on group assignment).
   * Preserves the current inspector visibility instead of forcing it open.
   */
  selectAndRevealExclusive(path: string): void {
    this._revealCollapseOthers = true;
    this.selectAndReveal(path, this._showInspector);
  }

  /**
   * Request the hierarchy browser to reveal an already-selected node (expand
   * ancestors + scroll into view) WITHOUT changing the selection or opening the
   * inspector. Used to keep the focused node visible across hierarchy view
   * changes (e.g. toggling a type filter on/off).
   */
  requestReveal(path: string): void {
    this._revealPath = path;
    this.notify();
  }

  /**
   * Suppress/restore hierarchy reveal on scene selection changes. While
   * suppressed, `selection-changed` still moves the hierarchy's selected node
   * (so the tree stays in sync) but does NOT expand ancestors or scroll to it.
   *
   * Used by the Kinematics window's Auto Assign mode: collecting parts fires a
   * rapid select → assign → re-select cycle per click, and revealing each one
   * would keep expanding and scroll-jumping the tree under the user.
   */
  setRevealSuppressed(suppressed: boolean): void {
    this._revealSuppressed = suppressed;
  }

  /** Clear the revealPath after the hierarchy browser has consumed it. */
  clearReveal(): void {
    if (this._revealPath) {
      this._revealPath = null;
      this._revealCollapseOthers = false;
      this.notify();
    }
  }

  /** Unsubscribe functions for viewer events. */
  private _eventUnsubs: (() => void)[] = [];
  /** Ancestor override for LayoutObject hover resolution. */
  private _layoutAncestorOverride: ((mesh: import('three').Object3D) => import('three').Object3D | null) | null = null;
  /** Cleanup handle for the SceneStore subscription (keeps `_overlay` cache fresh). */
  private _sceneStoreUnsub: (() => void) | null = null;

  /** The RVViewer instance (available after onModelLoaded). */
  get viewer(): RVViewer | null { return this._viewer; }

  /** The GLB file name derived from the model URL (available after onModelLoaded). */
  get glbName(): string | null { return this._glbName; }

  // ── Overlay Mutation ──

  /** Ensure an overlay object exists, creating one if needed. */
  private ensureOverlay(): RVExtrasOverlay {
    if (!this._overlay) {
      this._overlay = {
        $schema: 'rv-extras-overlay/1.0',
        $source: 'property-inspector',
        nodes: {},
      };
    }
    return this._overlay;
  }

  /** Key for the originals map. */
  private origKey(nodePath: string, componentType: string, fieldName: string): string {
    return `${nodePath}/${componentType}/${fieldName}`;
  }

  /** Snapshot the current (original) value before first override.
   *  Persists to localStorage sidecar for reset-after-reload support. */
  private snapshotOriginal(nodePath: string, componentType: string, fieldName: string): void {
    const key = this.origKey(nodePath, componentType, fieldName);
    if (this._originals.has(key)) return; // already captured
    const rv = this.readSceneField(nodePath, componentType, fieldName);
    this._originals.set(key, rv);
    // Persist originals sidecar to LS
    if (this._glbName) saveOriginals(this._glbName, this._originals);
  }

  /** Read a field value from the live scene node. */
  private readSceneField(nodePath: string, componentType: string, fieldName: string): unknown {
    if (!this._viewer?.registry) return undefined;
    const node = this._viewer.registry.getNode(nodePath);
    if (!node) return undefined;
    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    return rv?.[componentType]?.[fieldName];
  }

  /**
   * Update a single field. Routes through SceneStore.applyOp so the change
   * enters the unified op log and participates in undo/redo. The legacy
   * localStorage write is kept ONLY for the boot path (no SceneStore yet);
   * SceneStore-driven sessions persist via the per-base draft autosave.
   */
  updateOverlayField(nodePath: string, componentType: string, fieldName: string, value: unknown): boolean {
    // Never write a field its schema marks read-only for display (readonly:true
    // OR scope:'des') — defense in depth in case the inspector UI (which already
    // hides the editor) is bypassed.
    if (isFieldDisplayReadonly(getFieldDescriptor(baseComponentType(componentType), fieldName))) {
      console.warn(`[rvExtrasEditor] Refusing to edit readonly field ${componentType}.${fieldName}`);
      return false;
    }

    // Block edits on sub-paths of locked LayoutObjects. The LayoutObject root
    // itself remains editable so the user can unlock it without first
    // un-editing every nested field.
    const ancestor = this.findLayoutObjectAncestor(nodePath);
    if (ancestor && ancestor !== nodePath) {
      const obj = this._viewer?.registry?.getNode(ancestor);
      const rv = obj?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv?.LayoutObject?.Locked === true) {
        console.warn(`[rvExtrasEditor] Cannot edit ${nodePath}: LayoutObject ${ancestor} is locked`);
        return false;
      }
    }

    // Never persist ephemeral runtime state (e.g. a drive's CurrentPosition, a
    // sensor's Occupied) as an override. Only config fields can become overrides
    // and be saved — otherwise drafts/layouts accumulate meaningless runtime
    // snapshots that mis-seed the simulation on reload.
    if (this._viewer && isEphemeralField(this._viewer, nodePath, componentType, fieldName)) {
      console.warn(`[rvExtrasEditor] Refusing to persist runtime field ${componentType}.${fieldName}`);
      return false;
    }

    // No-op guard: drag handlers fire continuously with the same value;
    // bail out before allocating ops or touching localStorage.
    const prev = this.readSceneField(nodePath, componentType, fieldName);
    if (Object.is(prev, value)) return true;

    // Snapshot original before first override (for the legacy reset path).
    this.snapshotOriginal(nodePath, componentType, fieldName);

    const target = getActiveEditTarget();
    if (target.available) {
      // Optimistically reflect the override in the cached overlay and notify
      // NOW, so the inspector marks the field as overridden the moment it
      // changes. The op runs asynchronously through the target's op queue;
      // without this the override dot only appears after the queue flushes (or,
      // in some scene states, not until a reload re-materialises the ops). The
      // SceneStore subscription later re-materialises the overlay to the same
      // value (idempotent — it no-ops when structurally equal).
      const ov = this.ensureOverlay();
      if (!ov.nodes[nodePath]) ov.nodes[nodePath] = {};
      if (!ov.nodes[nodePath][componentType]) ov.nodes[nodePath][componentType] = {};
      ov.nodes[nodePath][componentType][fieldName] = value;
      // Also write userData synchronously NOW (mirrors the legacy fallback
      // below). The op below is deferred through the target's op queue, so
      // without this the inspector's optimistic re-render reads the OLD value
      // from userData; and the store's later subscription no-ops (the overlay
      // is already equal), so no second re-render ever corrects it. Writing
      // userData here makes the re-render read the new value immediately.
      this.applyFieldToScene(nodePath, componentType, fieldName, value);
      this.notify();

      // Op-based path — the target pushes a `setField` op into its document
      // (SceneStore outside the editor, AssetDocument inside); the executor
      // writes userData + reapplies schema.
      target.setField(nodePath, componentType, fieldName, value, prev);
      return true;
    }

    // Legacy fallback — pre-SceneStore boot or test environments.
    const overlay = this.ensureOverlay();
    if (!overlay.nodes[nodePath]) overlay.nodes[nodePath] = {};
    if (!overlay.nodes[nodePath][componentType]) overlay.nodes[nodePath][componentType] = {};
    overlay.nodes[nodePath][componentType][fieldName] = value;
    this.applyFieldToScene(nodePath, componentType, fieldName, value);
    if (this._glbName) saveOverlay(this._glbName, overlay);
    this.notify();
    return true;
  }

  /**
   * Drop an overlay entry optimistically — the erase half of the optimistic
   * write in {@link updateOverlayField}.
   *
   * Without it the cache only ever GROWS on the op-based path: `unsetField` is
   * deferred through the target's queue, and the SceneStore subscription that
   * would re-materialise the truth only runs where SceneStore IS the target.
   * Inside the asset editor the document is an `AssetDocument`, nothing
   * re-materialises, and a reverted field stayed marked as overridden until the
   * next model load — in the badge and, since Lauf 12, in the descend hint's
   * count. Same idempotence argument as the write: where the subscription does
   * run it recomputes the identical (absent) entry and no-ops.
   *
   * `componentType`/`fieldName` narrow the scope; omitting `fieldName` drops the
   * whole component, omitting both drops the node.
   */
  private pruneOverlayEntry(nodePath: string, componentType?: string, fieldName?: string): void {
    const nodeOverrides = this._overlay?.nodes[nodePath];
    if (!nodeOverrides) return;
    if (componentType === undefined) {
      delete this._overlay!.nodes[nodePath];
      return;
    }
    const fields = nodeOverrides[componentType];
    if (!fields) return;
    if (fieldName === undefined) delete nodeOverrides[componentType];
    else delete fields[fieldName];
    if (fields && Object.keys(fields).length === 0) delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay!.nodes[nodePath];
  }

  /**
   * Reset a single field override. Op-based path emits an `unsetField` op;
   * the executor restores the prev value from the inverse path.
   */
  resetField(nodePath: string, componentType: string, fieldName: string): void {
    const prev = this.readSceneField(nodePath, componentType, fieldName);
    const target = getActiveEditTarget();
    if (target.available) {
      target.unsetField(nodePath, componentType, fieldName, prev);
      this.pruneOverlayEntry(nodePath, componentType, fieldName);
      this.notify();
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;
    delete nodeOverrides[componentType][fieldName];
    const key = this.origKey(nodePath, componentType, fieldName);
    if (this._originals.has(key)) {
      this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
      this._originals.delete(key);
    }
    if (Object.keys(nodeOverrides[componentType]).length === 0) delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      removeOriginals(this._glbName, [key]);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a component. Wrapped in a transaction so the
   * batch is one undo step.
   */
  resetComponent(nodePath: string, componentType: string): void {
    const target = getActiveEditTarget();
    if (target.available && this._overlay?.nodes[nodePath]?.[componentType]) {
      const fields = Object.keys(this._overlay.nodes[nodePath][componentType]);
      void target.withTransaction(`Reset ${componentType}`, async () => {
        for (const fieldName of fields) {
          const prev = this.readSceneField(nodePath, componentType, fieldName);
          target.unsetField(nodePath, componentType, fieldName, prev);
        }
      });
      this.pruneOverlayEntry(nodePath, componentType);
      this.notify();
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;
    const removedKeys: string[] = [];
    for (const fieldName of Object.keys(nodeOverrides[componentType])) {
      const key = this.origKey(nodePath, componentType, fieldName);
      if (this._originals.has(key)) {
        this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
        this._originals.delete(key);
        removedKeys.push(key);
      }
    }
    delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a node — emits one transaction wrapping all
   * unsetField primitives so undo restores the entire node in one step.
   */
  resetNode(nodePath: string): void {
    const target = getActiveEditTarget();
    if (target.available && this._overlay?.nodes[nodePath]) {
      const nodeOv = this._overlay.nodes[nodePath];
      const work: Array<{ componentType: string; fieldName: string; prev: unknown }> = [];
      for (const [componentType, fields] of Object.entries(nodeOv)) {
        for (const fieldName of Object.keys(fields)) {
          work.push({ componentType, fieldName, prev: this.readSceneField(nodePath, componentType, fieldName) });
        }
      }
      if (work.length === 0) return;
      void target.withTransaction(`Reset node`, async () => {
        for (const w of work) {
          target.unsetField(nodePath, w.componentType, w.fieldName, w.prev);
        }
      });
      this.pruneOverlayEntry(nodePath);
      this.notify();
      return;
    }

    // Legacy fallback
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    const removedKeys: string[] = [];
    if (nodeOverrides) {
      for (const [componentType, fields] of Object.entries(nodeOverrides)) {
        for (const fieldName of Object.keys(fields)) {
          const key = this.origKey(nodePath, componentType, fieldName);
          if (this._originals.has(key)) {
            this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
            this._originals.delete(key);
            removedKeys.push(key);
          }
        }
      }
    }
    delete this._overlay.nodes[nodePath];
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    this.notify();
  }

  /**
   * Apply a single field value to the live scene node's userData.realvirtual.
   */
  private applyFieldToScene(nodePath: string, componentType: string, fieldName: string, value: unknown): void {
    if (!this._viewer?.registry) return;
    const node = this._viewer.registry.getNode(nodePath);
    if (!node) return;

    const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (!rv?.[componentType]) return;
    // Replace the component object with a shallow clone (new identity) rather
    // than mutating in place. The inspector's ComponentSection memoises its
    // field rows on the `data` object reference, so an in-place mutation is
    // invisible until the panel remounts. A fresh object lets React's memos
    // recompute and the displayed value update immediately.
    rv[componentType] = { ...rv[componentType], [fieldName]: value };
  }

  // ── Layout Context Menu ──

  /** Register context menu items for LayoutObject nodes (lock, delete, edit, set position). */
  private _registerLayoutContextMenu(viewer: RVViewer): void {
    const plugin = this;

    viewer.contextMenu.register({
      pluginId: 'layout-objects',
      items: [
        // ── Edit (open hierarchy + inspector) ──
        {
          id: 'layout.edit',
          label: 'Edit',
          order: 10,
          condition: hasLayoutObject,
          action: (target) => {
            plugin.selectAndReveal(target.path, true);
          },
        },
        // ── Lock / Unlock ──
        {
          id: 'layout.lock',
          label: (target) => {
            const paths = getLayoutPaths(viewer, target);
            const allLocked = paths.every(p => isNodeLocked(viewer, p));
            const count = paths.length;
            const verb = allLocked ? 'Unlock' : 'Lock';
            return count > 1 ? `${verb} (${count})` : verb;
          },
          order: 20,
          condition: hasLayoutObject,
          action: (target) => {
            const paths = getLayoutPaths(viewer, target);
            const allLocked = paths.every(p => isNodeLocked(viewer, p));
            const newLocked = !allLocked;
            for (const p of paths) {
              plugin.updateOverlayField(p, 'LayoutObject', 'Locked', newLocked);
            }
          },
        },
        // ── Set Transform ──
        {
          id: 'layout.settransform',
          label: (target) => {
            const count = getLayoutCount(viewer, target);
            return count > 1 ? `Set Transform (${count})` : 'Set Transform';
          },
          order: 30,
          condition: (target) => {
            if (!hasLayoutObject(target)) return false;
            // Hide if all are locked
            return getLayoutPaths(viewer, target).some(p => !isNodeLocked(viewer, p));
          },
          action: (target) => {
            const paths = getLayoutPaths(viewer, target).filter(p => !isNodeLocked(viewer, p));
            if (paths.length > 0) openSetPositionDialog(viewer, paths);
          },
        },
        // ── Delete ──
        {
          id: 'layout.delete',
          label: (target) => {
            const count = getLayoutCount(viewer, target);
            return count > 1 ? `Delete (${count})` : 'Delete';
          },
          order: 200,
          danger: true,
          dividerBefore: true,
          condition: (target) => {
            if (!hasLayoutObject(target)) return false;
            return getLayoutPaths(viewer, target).some(p => !isNodeLocked(viewer, p));
          },
          action: (target) => {
            const paths = getLayoutPaths(viewer, target).filter(p => !isNodeLocked(viewer, p));
            if (paths.length === 0) return;
            // The layout-planner plugin owns the actual scene/store/SceneStore
            // mutation — it listens for `layout-objects-deleted` and routes
            // through its own removal pipeline (undo-safe). Don't mutate
            // visibility here; the planner clears the selection itself.
            viewer.emit('layout-objects-deleted', { paths });
          },
        },
      ],
    });
  }

  // ── Lifecycle ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;

    // Collect all editable nodes (rv_extras components, editor-created empties,
    // and the raw-geometry fallback). Shared with refreshEditableNodes.
    this._scanEditableNodes(result.registry);

    // Load overlay state. Priority:
    //   1) Materialise the active unified Scene's edit log into an overlay —
    //      wins when the load came through the new SceneStore (op-based).
    //   2) Legacy localStorage (rv-extras-overlay:<glbName>) — kept for the
    //      boot path that loads a GLB directly without going through the
    //      Scene panel (e.g. ?model=). The originals sidecar is loaded the
    //      same way for reset-after-reload support.
    const modelUrl = viewer.currentModelUrl;
    if (modelUrl) {
      this._glbName = modelUrl.split('/').pop() ?? modelUrl;
      const scene = viewer.currentScene;
      if (scene) {
        // Materialise the scene's op log into an overlay snapshot — read-only
        // CACHE for the inspector's "is this field overridden?" rendering.
        // Inspector mutations now flow through SceneStore.applyOp (see
        // updateOverlayField above); the SceneStore subscription below keeps
        // this cache fresh after undo/redo or external edits.
        this._overlay = materialiseEdits(scene.edits.ops).overlay;
      } else {
        this._overlay = loadOverlay(this._glbName);
      }

      // Originals sidecar: legacy-only. Future PR may capture originals
      // during loadGLB traversal so this side store can be retired.
      this._originals = loadOriginals(this._glbName);

      // Subscribe to SceneStore so _overlay stays in sync with the op log
      // (e.g. after undo / redo or external applyOp calls). The
      // subscription is torn down in dispose().
      const sceneStore = getSceneStore();
      if (sceneStore && !this._sceneStoreUnsub) {
        this._sceneStoreUnsub = sceneStore.subscribe(() => {
          // Materialise from the store's LIVE op log (its draft snapshot), not
          // viewer.currentScene.edits.ops — the latter is a stale copy that is
          // only refreshed on load/save, so it never reflects in-progress edits.
          // Reading it here was why a freshly-edited field's override mark was
          // wiped right after it appeared (and only showed up again on reload).
          const ops = sceneStore.getSnapshot().draft?.edits.ops
            ?? viewer.currentScene?.edits.ops;
          if (!ops) return;
          const next = materialiseEdits(ops).overlay;
          // Only notify if the overlay actually changed structurally.
          if (JSON.stringify(this._overlay) !== JSON.stringify(next)) {
            this._overlay = next;
            this.notify();
          }
        });
      }
    }

    // Register layout object context menu items
    this._registerLayoutContextMenu(viewer);

    // Register ancestor override so hovering any child of a LayoutObject
    // resolves to the LayoutObject root (full subtree hover highlight)
    if (viewer.raycastManager) {
      this._layoutAncestorOverride = (mesh: import('three').Object3D) => {
        let current: import('three').Object3D | null = mesh;
        while (current) {
          const rv = current.userData?.realvirtual as Record<string, unknown> | undefined;
          if (rv?.LayoutObject) return current;
          current = current.parent;
        }
        return null;
      };
      viewer.raycastManager.addAncestorOverride(this._layoutAncestorOverride);
    }

    // Subscribe to selection-changed for loose-coupled scene interaction.
    // Preserve the current inspector visibility — switching the selected
    // object in the 3D scene should follow the inspector to the new node
    // when it's open, NOT close it (the prior `false` literal closed the
    // inspector on every scene selection change).
    this._eventUnsubs.push(
      viewer.on('selection-changed', (snapshot) => {
        const path = snapshot.primaryPath;
        if (!path) {
          this.clearSelection();
        } else if (this._panelOpen && !this._revealSuppressed) {
          this.selectAndReveal(path, this._showInspector);
        } else {
          this.selectNode(path, this._showInspector);
        }
      }),
    );

    // Subscribe to object-focus (canvas double-click + F key) — opens the
    // Property Inspector alongside the camera-zoom that the viewer's built-in
    // handler already performs. We accept any path the registry knows; the
    // inspector itself decides what to render (empty state for nodes without
    // rv_extras components).
    this._eventUnsubs.push(
      viewer.on('object-focus', ({ path, openInspector }) => {
        if (!path) return;
        // F-key "frame selected" sets openInspector=false — frame the camera but
        // do NOT open/reveal the hierarchy (the node is already selected).
        if (openInspector === false) return;
        // Compact (mobile) layout: don't open the fullscreen hierarchy/inspector.
        // Select silently — the mobile selection sheet renders the inspector and
        // its own breadcrumb/children navigation.
        if (isCompactWidth(window.innerWidth)) {
          this.selectNode(path, true);
          return;
        }
        this.selectAndReveal(path, true);
      }),
    );

    // Asset-editor structural ops (STEP import, delete, rename, add/remove
    // component — incl. undo/redo and draft replay) mutate the scene without a
    // model reload; re-scan the editable-node cache so the hierarchy follows.
    this._eventUnsubs.push(
      viewer.on('editor-structure-changed', () => this._scheduleEditableNodesRefresh()),
    );

    // Subscribe to LeftPanelManager: close hierarchy when another panel opens
    this._eventUnsubs.push(
      viewer.leftPanelManager.subscribe(() => {
        const snap = viewer.leftPanelManager.getSnapshot();
        if (snap.activePanel !== null && snap.activePanel !== 'hierarchy' && this._panelOpen) {
          this._panelOpen = false;
          localStorage.setItem(LS_KEY_PANEL_OPEN, 'false');
          this.notify();
        }
      }),
    );

    // If panel was persisted as open, register with LPM so it knows about us
    if (this._panelOpen) {
      viewer.leftPanelManager.open('hierarchy', this._panelWidth);
    }

    this.notify();
  }

  /**
   * Remove all overlay entries whose path falls under the given prefix
   * (i.e. the prefix itself OR `${prefix}/...`).
   *
   * Called when a LayoutObject is deleted so re-placing a catalog item
   * with the same root name doesn't inherit the previous instance's
   * sub-overlay state. Returns the number of paths purged (legacy path
   * only — SceneStore op-log entries are not retroactively rewritten;
   * they unwind via the standard undo/redo replay).
   */
  purgeOverlaysForSubtree(prefix: string): number {
    if (!this._overlay) return 0;
    const toDelete: string[] = [];
    for (const path of Object.keys(this._overlay.nodes)) {
      if (path === prefix || path.startsWith(prefix + '/')) toDelete.push(path);
    }
    for (const path of toDelete) delete this._overlay.nodes[path];
    // Also clear originals snapshot entries for the subtree
    const removedKeys: string[] = [];
    for (const key of this._originals.keys()) {
      if (key === prefix || key.startsWith(prefix + '/')) {
        removedKeys.push(key);
      }
    }
    for (const key of removedKeys) this._originals.delete(key);
    if (this._glbName && toDelete.length > 0) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    if (toDelete.length > 0) this.notify();
    return toDelete.length;
  }

  /**
   * Coalesced `refreshEditableNodes` — safe to call once per structural op.
   *
   * A refresh is a FULL `scene.traverse` (see {@link _scanEditableNodes}), so on a
   * bulk edit its cost is `ops × sceneSize`. Two guards keep that off the hot path:
   *
   * - **Closed panel = no scan.** Only `HierarchyBrowser` reads `editableNodes`,
   *   and it is unmounted while the panel is closed (`TopBar.tsx:226`). The scan
   *   is deferred to whenever the panel opens (`togglePanel`, `selectAndReveal`).
   *   Measured on a 4493-node assembly with 434 moves: 158 ms of traversing
   *   nobody was looking at — 73% of the whole operation (plan-359 Phase 2).
   * - **Macrotask, not microtask.** A transaction `await`s its ops, and a
   *   microtask fires BETWEEN those awaits — which turned "once per transaction"
   *   back into "once per op". `setTimeout(0)` collapses the whole transaction
   *   into one scan, exactly as `RVViewer.rebuildGroupedBvh` already does for the
   *   BVH (`rv-viewer.ts:4272-4276`).
   */
  private _refreshScheduled = false;
  /** A structural change arrived while the panel was closed — scan on open. */
  private _editableNodesStale = false;
  private _scheduleEditableNodesRefresh(): void {
    // The root override (plan-301 "Runtime view") drives a preview subtree that
    // is not the hierarchy panel — keep it eager.
    if (!this._panelOpen && !this._hierarchyRootOverride) {
      this._editableNodesStale = true;
      return;
    }
    if (this._refreshScheduled) return;
    this._refreshScheduled = true;
    setTimeout(() => {
      this._refreshScheduled = false;
      this.refreshEditableNodes();
    }, 0);
  }

  /** Run the scan that was skipped while the panel was closed. Called from every
   *  path that opens the panel — the tree must never render a stale scene. */
  private _flushStaleEditableNodes(): void {
    if (!this._editableNodesStale) return;
    this._editableNodesStale = false;
    this.refreshEditableNodes();
  }

  /** Re-scan the scene for editable nodes. Call after adding/removing nodes with userData.realvirtual. */
  refreshEditableNodes(): void {
    if (!this._viewer) return;
    this._editableNodesStale = false;
    this._ancestorCache.clear();
    // Same lifetime, same reason: both cache a parent walk over a tree that has
    // just changed. The drill level goes with them — the anchor it referred to
    // may not exist any more.
    this._referenceCache.clear();
    this._referenceDrill.reset();
    if (this._hierarchyRootOverride) {
      this._scanOverrideNodes(this._hierarchyRootOverride);
      this.notify();
      return;
    }
    const registry = this._viewer.registry;
    if (!registry) { this._editableNodes = []; return; }
    this._scanEditableNodes(registry);
    this.notify();
  }

  // ── Hierarchy root override (plan-301 §2.9 — asset editor "Runtime view") ──

  /** While set, the hierarchy panel lists THIS subtree instead of the
   *  registry-backed scene scan (see {@link setHierarchyRootOverride}). */
  private _hierarchyRootOverride: import('three').Object3D | null = null;

  /**
   * Additive, optional root override for the hierarchy panel. A caller can
   * point the tree at a preview subtree while every other
   * `currentModelRoot` consumer keeps pointing at the (hidden, untouched)
   * editor root. Pass null to restore the normal scan.
   */
  setHierarchyRootOverride(root: import('three').Object3D | null): void {
    this._hierarchyRootOverride = root;
    this.refreshEditableNodes();
  }

  /** The active hierarchy root override, or null. */
  get hierarchyRootOverride(): import('three').Object3D | null {
    return this._hierarchyRootOverride;
  }

  /**
   * Override-scan: list the override subtree WITHOUT registry lookups — the
   * preview nodes are intentionally never registered (read-only, no ops).
   * Paths come from `NodeRegistry.computeNodePath` (the preview root lives in
   * the scene). Nodes with component extras carry their types; bare named
   * meshes get the synthetic 'Geometry' type so the tree is browsable.
   */
  private _scanOverrideNodes(root: import('three').Object3D): void {
    this._editableNodes = [];
    root.traverse((node) => {
      const ud = node.userData as Record<string, unknown> | undefined;
      const rv = ud?.realvirtual as Record<string, unknown> | undefined;
      const types: string[] = [];
      if (rv) {
        for (const [key, value] of Object.entries(rv)) {
          if (isHiddenComponentType(key)) continue;
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            types.push(key);
          }
        }
      }
      if (types.length === 0) {
        if (node.type !== 'Mesh' || !node.name) return;
        types.push('Geometry');
      }
      const path = NodeRegistry.computeNodePath(node);
      if (!path) return;
      this._editableNodes.push({ path, types });
    });
  }

  /**
   * Populate `_editableNodes` from the current scene (sorted by path). Shared
   * by onModelLoaded (initial) and refreshEditableNodes (after edits) so the
   * two never drift. Lists every node that either carries rv_extras component
   * data OR is an editor-created empty (tagged `__rvAdded` — a structural node
   * from the Create section's "Empty at Root" / "Empty Child" that has no
   * components yet). Without the `__rvAdded` clause a freshly created empty is
   * invisible in the hierarchy until a component or child is added to it.
   */
  private _scanEditableNodes(registry: LoadResult['registry']): void {
    if (!this._viewer) return;
    this._editableNodes = [];
    this._viewer.scene.traverse((node) => {
      const ud = node.userData as Record<string, unknown> | undefined;
      const rv = ud?.realvirtual as Record<string, unknown> | undefined;
      const types: string[] = [];
      if (rv) {
        for (const [key, value] of Object.entries(rv)) {
          if (isHiddenComponentType(key)) continue;
          if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
            types.push(key);
          }
        }
      }
      if (types.length === 0 && !ud?.['__rvAdded']) return;
      const path = registry.getPathForNode(node);
      if (!path) return;
      this._editableNodes.push({ path, types });
    });
    this._appendGeometryFallback();
    // NB: intentionally NOT sorted alphabetically. `scene.traverse` visits
    // pre-order in real `Object3D.children` order, and `buildStructureTree`
    // inserts children first-seen — so leaving this list in traversal order
    // makes the hierarchy panel mirror actual scene order. This is what lets
    // Unity-style drag-reorder be visible; an alphabetical sort here would hide
    // any sibling-index change made by a reparent/reorder op.
  }

  /**
   * Fallback for raw geometry (e.g. STEP import): when the component scan found
   * NO editable nodes, list the named mesh nodes so the assembly hierarchy is
   * still browsable/selectable (buildTree reconstructs the group tree from the
   * paths). These carry a synthetic 'Geometry' type, visible under the "All"
   * filter. No-op once any rv_extras component exists.
   */
  private _appendGeometryFallback(): void {
    if (this._editableNodes.length > 0 || !this._viewer) return;
    const registry = this._viewer.registry;
    if (!registry) return;
    this._viewer.scene.traverse((node) => {
      if (node.type !== 'Mesh' || !node.name) return;
      const path = registry.getPathForNode(node);
      if (path) this._editableNodes.push({ path, types: ['Geometry'] });
    });
  }

  onModelCleared(): void {
    // Unsubscribe viewer events
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs.length = 0;

    // Unsubscribe from SceneStore
    if (this._sceneStoreUnsub) {
      this._sceneStoreUnsub();
      this._sceneStoreUnsub = null;
    }

    // Remove ancestor override
    if (this._layoutAncestorOverride && this._viewer?.raycastManager) {
      this._viewer.raycastManager.removeAncestorOverride(this._layoutAncestorOverride);
      this._layoutAncestorOverride = null;
    }

    this._editableNodes = [];
    this._overlay = null;
    this._selectedNodePath = null;
    this._hierarchyRootOverride = null;
    this._viewer = null;
    this._glbName = null;
    this.notify();
  }

  dispose(): void {
    this.onModelCleared();
    this._listeners.clear();
  }
}
