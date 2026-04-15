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
import type { RVViewer } from '../rv-viewer';
import type { ContextMenuTarget } from './context-menu-store';
import { loadOverlay, saveOverlay, saveOriginals, loadOriginals, removeOriginals, type RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import { isHiddenComponentType } from './rv-inspector-helpers';
import { openSetPositionDialog } from './SetPositionDialog';

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

// ─── Plugin State (external store for React) ─────────────────────────────

/** Default and min/max width for the hierarchy panel. */
export const HIERARCHY_MIN_WIDTH = 200;
export const HIERARCHY_MAX_WIDTH = 600;
export const HIERARCHY_DEFAULT_WIDTH = 280;

const LS_KEY_PANEL_WIDTH = 'rv-extras-editor-width';
const LS_KEY_PANEL_OPEN = 'rv-extras-editor-open';
const LS_KEY_SELECTED_NODE = 'rv-extras-editor-selected';

/** Snapshot of plugin state for React consumption. */
export interface ExtrasEditorState {
  panelOpen: boolean;
  panelWidth: number;
  overlay: RVExtrasOverlay | null;
  editableNodes: EditableNodeInfo[];
  selectedNodePath: string | null;
  /** Set by selectAndReveal(), consumed by HierarchyBrowser to expand ancestors and scroll-to. */
  revealPath: string | null;
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
  private _overlay: RVExtrasOverlay | null = null;
  private _editableNodes: EditableNodeInfo[] = [];
  private _selectedNodePath: string | null = null;
  private _revealPath: string | null = null;
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
    this._panelOpen = localStorage.getItem(LS_KEY_PANEL_OPEN) === 'true';
    this._selectedNodePath = localStorage.getItem(LS_KEY_SELECTED_NODE) || null;
    this._snapshot = {
      panelOpen: this._panelOpen,
      panelWidth: this._panelWidth,
      overlay: null,
      editableNodes: [],
      selectedNodePath: this._selectedNodePath,
      revealPath: null,
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
    overlay: null,
    editableNodes: [],
    selectedNodePath: null,
    revealPath: null,
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
      overlay: this._overlay,
      editableNodes: this._editableNodes,
      selectedNodePath: this._selectedNodePath,
      revealPath: this._revealPath,
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

  selectNode(path: string, showInspector = false): void {
    this._selectedNodePath = path;
    this._showInspector = showInspector;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
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
    this._selectedNodePath = path;
    this._revealPath = path;
    this._showInspector = showInspector;
    localStorage.setItem(LS_KEY_SELECTED_NODE, path);
    this.notify();
  }

  /** Clear the revealPath after the hierarchy browser has consumed it. */
  clearReveal(): void {
    if (this._revealPath) {
      this._revealPath = null;
      this.notify();
    }
  }

  /** Unsubscribe functions for viewer events. */
  private _eventUnsubs: (() => void)[] = [];
  /** Ancestor override for LayoutObject hover resolution. */
  private _layoutAncestorOverride: ((mesh: import('three').Object3D) => import('three').Object3D | null) | null = null;

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
   * Update a single field in the overlay and persist to localStorage.
   * Also applies the value to the live scene node's userData.
   */
  updateOverlayField(nodePath: string, componentType: string, fieldName: string, value: unknown): void {
    // Snapshot original before first override
    this.snapshotOriginal(nodePath, componentType, fieldName);

    const overlay = this.ensureOverlay();

    if (!overlay.nodes[nodePath]) overlay.nodes[nodePath] = {};
    if (!overlay.nodes[nodePath][componentType]) overlay.nodes[nodePath][componentType] = {};
    overlay.nodes[nodePath][componentType][fieldName] = value;

    // Apply to live scene node
    this.applyFieldToScene(nodePath, componentType, fieldName, value);

    // Persist
    if (this._glbName) saveOverlay(this._glbName, overlay);
    this.notify();
  }

  /**
   * Reset a single field override — remove it from the overlay and
   * restore the GLB default value on the live scene node.
   */
  resetField(nodePath: string, componentType: string, fieldName: string): void {
    if (!this._overlay) return;

    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;
    delete nodeOverrides[componentType][fieldName];

    // Restore original value to scene
    const key = this.origKey(nodePath, componentType, fieldName);
    if (this._originals.has(key)) {
      this.applyFieldToScene(nodePath, componentType, fieldName, this._originals.get(key));
      this._originals.delete(key);
    }

    // Clean up empty containers
    if (Object.keys(nodeOverrides[componentType]).length === 0) delete nodeOverrides[componentType];
    if (Object.keys(nodeOverrides).length === 0) delete this._overlay.nodes[nodePath];

    // Persist overlay and originals sidecar
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      removeOriginals(this._glbName, [key]);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a specific component on a node.
   */
  resetComponent(nodePath: string, componentType: string): void {
    if (!this._overlay) return;
    const nodeOverrides = this._overlay.nodes[nodePath];
    if (!nodeOverrides?.[componentType]) return;

    // Restore all original values for this component
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

    // Persist overlay and originals sidecar
    if (this._glbName) {
      saveOverlay(this._glbName, this._overlay);
      if (removedKeys.length > 0) removeOriginals(this._glbName, removedKeys);
    }
    this.notify();
  }

  /**
   * Reset all overrides for a node — remove the entire node entry from the overlay.
   */
  resetNode(nodePath: string): void {
    if (!this._overlay) return;

    // Restore all original values for this node
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

    // Persist overlay and originals sidecar
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
    rv[componentType][fieldName] = value;
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
            for (const p of paths) {
              const node = viewer.registry?.getNode(p);
              if (node) node.visible = false;
              viewer.selectionManager.deselect(p);
            }
            viewer.markRenderDirty();
            viewer.emit('layout-objects-deleted', { paths });
            plugin.refreshEditableNodes();
          },
        },
      ],
    });
  }

  // ── Lifecycle ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._editableNodes = [];

    // Collect all nodes that have userData.realvirtual with component data
    const registry = result.registry;
    const scene = viewer.scene;

    scene.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;

      // Get types: keys that map to objects (component data), excluding metadata and hidden types
      const types: string[] = [];
      for (const [key, value] of Object.entries(rv)) {
        if (isHiddenComponentType(key)) continue;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          types.push(key);
        }
      }

      if (types.length === 0) return;

      // Compute path using registry or fallback
      const path = registry.getPathForNode(node);
      if (!path) return;

      this._editableNodes.push({ path, types });
    });

    // Sort by path for consistent display
    this._editableNodes.sort((a, b) => a.path.localeCompare(b.path));

    // Load overlay from localStorage (derive GLB name from URL)
    const modelUrl = viewer.currentModelUrl;
    if (modelUrl) {
      this._glbName = modelUrl.split('/').pop() ?? modelUrl;
      this._overlay = loadOverlay(this._glbName);

      // Load persisted originals sidecar (for reset-after-reload support)
      this._originals = loadOriginals(this._glbName);

      // Snapshot original values for overlay fields BEFORE they were applied
      // (the scene loader applies overlays during traversal, so by this point
      // userData already has overlay values. The persisted sidecar from a
      // previous session provides the true originals. For new overrides made
      // in this session, snapshotOriginal() captures them on first edit.)
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

    // Subscribe to selection-changed for loose-coupled scene interaction
    this._eventUnsubs.push(
      viewer.on('selection-changed', (snapshot) => {
        const path = snapshot.primaryPath;
        if (!path) {
          this.clearSelection();
        } else if (this._panelOpen) {
          this.selectAndReveal(path, false);
        } else {
          this.selectNode(path, false);
        }
      }),
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

  /** Re-scan the scene for editable nodes. Call after adding/removing nodes with userData.realvirtual. */
  refreshEditableNodes(): void {
    if (!this._viewer) return;
    this._editableNodes = [];
    const registry = this._viewer.registry;
    if (!registry) return;
    this._viewer.scene.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      const types: string[] = [];
      for (const [key, value] of Object.entries(rv)) {
        if (isHiddenComponentType(key)) continue;
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          types.push(key);
        }
      }
      if (types.length === 0) return;
      const path = registry.getPathForNode(node);
      if (!path) return;
      this._editableNodes.push({ path, types });
    });
    this._editableNodes.sort((a, b) => a.path.localeCompare(b.path));
    this.notify();
  }

  onModelCleared(): void {
    // Unsubscribe viewer events
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs.length = 0;

    // Remove ancestor override
    if (this._layoutAncestorOverride && this._viewer?.raycastManager) {
      this._viewer.raycastManager.removeAncestorOverride(this._layoutAncestorOverride);
      this._layoutAncestorOverride = null;
    }

    this._editableNodes = [];
    this._overlay = null;
    this._selectedNodePath = null;
    this._viewer = null;
    this._glbName = null;
    this.notify();
  }

  dispose(): void {
    this.onModelCleared();
    this._listeners.clear();
  }
}
