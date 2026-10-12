// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SelectionManager — Central selection state for the WebViewer.
 *
 * Selection identity is the `Object3D` (plan-754 D10). Paths are DERIVED:
 * the registry is the document's address book, and a node it does not know
 * (a chunk mesh, a hover overlay, the floor) is still perfectly selectable —
 * it just has no path. Every path-shaped API below therefore keeps working
 * unchanged, and `selectedPaths` / `primaryPath` simply omit what has no path.
 *
 * Selection is deliberately NOT persisted: the old `rv-extras-editor-selected`
 * key was global across documents and restored a path into whatever model
 * happened to load next.
 *
 * Plugins subscribe via the 'selection-changed' viewer event or the
 * React-compatible subscribe/getSnapshot API (useSyncExternalStore).
 *
 * Selection highlights (cyan) are managed through RVHighlightManager's
 * selection channel — independent from the hover channel.
 */

import type { Object3D } from 'three';
import type { ViewerHost } from './rv-viewer-host';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SelectionSnapshot {
  /** All selected objects, ordered by selection time (plan-754 D10). */
  readonly nodes: ReadonlyArray<Object3D>;
  /** The most recently selected object (last in the list), or null. */
  readonly primaryNode: Object3D | null;
  /** Paths of the selected entries that HAVE one, ordered by selection time. */
  readonly selectedPaths: ReadonlyArray<string>;
  /** The most recently selected path, or null when the primary has no path. */
  readonly primaryPath: string | null;
}

/**
 * One selected thing.
 *
 * `path` is set only when the entry was selected THROUGH a path API. Keeping it
 * is what makes `select('Some/Path')` survive a registry that cannot resolve it
 * (an op that selects before registration, a test double) — the pre-754
 * behaviour, unchanged. Entries selected as objects derive their path from the
 * registry on every snapshot, so a rename or reparent is reflected at once.
 */
interface SelectionEntry {
  readonly node: Object3D | null;
  readonly path: string | null;
}

/** The "nothing selected" snapshot. Exported so the handful of components that
 *  render without a viewer share one shape instead of hand-rolling it. */
export const EMPTY_SNAPSHOT: SelectionSnapshot = Object.freeze({
  nodes: Object.freeze([]) as ReadonlyArray<Object3D>,
  primaryNode: null,
  selectedPaths: Object.freeze([]) as ReadonlyArray<string>,
  primaryPath: null,
});

// ─── Keyboard scopes (plan-515 R3-2) ────────────────────────────────────

/** Every viewer container that owns its keys (main viewer, embeds). Refcounted. */
const _keyboardScopes = new Map<HTMLElement, number>();

/** Register a viewer container as a keyboard scope. */
export function registerKeyboardScope(el: HTMLElement): void {
  _keyboardScopes.set(el, (_keyboardScopes.get(el) ?? 0) + 1);
}

/** Undo one {@link registerKeyboardScope}. */
export function unregisterKeyboardScope(el: HTMLElement): void {
  const n = (_keyboardScopes.get(el) ?? 0) - 1;
  if (n > 0) _keyboardScopes.set(el, n); else _keyboardScopes.delete(el);
}

/**
 * True when the event passed through `scope`. Reads `composedPath()` — at the
 * document a key event from inside an embed's SHADOW tree is retargeted to the
 * shadow host, which `contains()` on a scope inside that tree cannot see
 * (plan-515 Phase 1b). Falls back to `contains(target)` for synthetic events
 * without a path.
 */
function eventPassedThrough(e: Event, scope: HTMLElement): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
  if (path.length > 0) return path.includes(scope);
  const t = e.target as Node | null;
  return !!t && !!t.nodeType && scope.contains(t);
}

/** True when the event passed through ANY registered viewer keyboard scope. */
export function isEventInsideKeyboardScope(e: Event): boolean {
  for (const el of _keyboardScopes.keys()) {
    if (eventPassedThrough(e, el)) return true;
  }
  return false;
}

/**
 * Does this key event belong to the viewer with keyboard scope `scope`
 * (plan-515 R3-2)? Yes when it passed through the scope, or — for the PRIMARY
 * viewer only — when it lies outside every registered viewer scope (HMI,
 * body). No scope (test hosts without DOM) = every event, as before.
 */
export function keyEventBelongsToViewer(e: Event, scope: HTMLElement | null | undefined, isPrimary: boolean): boolean {
  if (!scope) return true;
  if (eventPassedThrough(e, scope)) return true;
  return isPrimary && !isEventInsideKeyboardScope(e);
}

// ─── SelectionManager ───────────────────────────────────────────────────

export class SelectionManager {
  private _selected: SelectionEntry[] = [];
  private _viewer: ViewerHost | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: SelectionSnapshot = EMPTY_SNAPSHOT;
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Primary viewer only: document listener for keys outside every viewer scope. */
  private _outsideScopeHandler: ((e: KeyboardEvent) => void) | null = null;
  /** Element the key handler is attached to (the viewer's scope, or document). */
  private _keyTarget: EventTarget | null = null;
  private _scope: HTMLElement | null = null;

  /** Last click hit point in world coordinates (set by select/toggle). */
  lastHitPoint: [number, number, number] | null = null;

  // ─── React External Store API ─────────────────────────────────────

  /** Subscribe for React (useSyncExternalStore compatible). Returns unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Get snapshot for React (useSyncExternalStore compatible). */
  getSnapshot = (): SelectionSnapshot => {
    return this._snapshot;
  };

  // ─── Public API (paths) ───────────────────────────────────────────

  /** Replace selection with a single path. */
  select(path: string, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    if (this._selected.length === 1 && this._selected[0].path === path) return;
    this._selected = [this._entryForPath(path)];
    this._apply();
  }

  /** Toggle a path in/out of the selection (for Shift+click). */
  toggle(path: string, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    const idx = this._indexOfPath(path);
    if (idx >= 0) {
      this._selected.splice(idx, 1);
    } else {
      this._selected.push(this._entryForPath(path));
    }
    this._apply();
  }

  /**
   * Toggle a path and all its descendant paths in/out of the selection.
   * If the path is not selected, adds it and all children.
   * If the path is already selected, removes it and all children.
   */
  toggleWithChildren(path: string): void {
    const childPaths = this._collectDescendantPaths(path);
    const allPaths = [path, ...childPaths];
    const isCurrentlySelected = this._indexOfPath(path) >= 0;

    if (isCurrentlySelected) {
      // Remove all
      const removeSet = new Set(allPaths);
      this._selected = this._selected.filter(e => !(e.path !== null && removeSet.has(e.path)));
    } else {
      // Add all (avoid duplicates)
      for (const p of allPaths) {
        if (this._indexOfPath(p) < 0) this._selected.push(this._entryForPath(p));
      }
    }
    this._apply();
  }

  /** Replace selection with multiple paths at once. */
  selectPaths(paths: string[]): void {
    this._selected = paths.map(p => this._entryForPath(p));
    this._apply();
  }

  /** Remove a single path from selection. */
  deselect(path: string): void {
    const idx = this._indexOfPath(path);
    if (idx < 0) return;
    this._selected.splice(idx, 1);
    this._apply();
  }

  /** Check if a path is currently selected. */
  isSelected(path: string): boolean {
    return this._indexOfPath(path) >= 0;
  }

  /** The most recently selected path, or null (also null for a path-less node). */
  get primaryPath(): string | null {
    return this._snapshot.primaryPath;
  }

  /** All selected paths (read-only copy). Entries without a path are omitted. */
  get selectedPaths(): ReadonlyArray<string> {
    return this._snapshot.selectedPaths;
  }

  // ─── Public API (objects, plan-754 D10) ───────────────────────────

  /** Replace selection with a single object — registered or not. */
  selectNode(node: Object3D, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    if (this._selected.length === 1 && this._selected[0].node === node) return;
    this._selected = [{ node, path: null }];
    this._apply();
  }

  /** Replace selection with several objects at once. */
  selectNodes(nodes: readonly Object3D[]): void {
    this._selected = nodes.map(node => ({ node, path: null }));
    this._apply();
  }

  /** Toggle one object in/out of the selection (Ctrl/Cmd+click). */
  toggleNode(node: Object3D, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    const idx = this._selected.findIndex(e => e.node === node);
    if (idx >= 0) this._selected.splice(idx, 1);
    else this._selected.push({ node, path: null });
    this._apply();
  }

  /** Is this object part of the current selection? */
  isNodeSelected(node: Object3D): boolean {
    return this._selected.some(e => e.node === node);
  }

  /** All selected objects, ordered by selection time. */
  get nodes(): ReadonlyArray<Object3D> {
    return this._snapshot.nodes;
  }

  /** The most recently selected object, or null. */
  get primaryNode(): Object3D | null {
    return this._snapshot.primaryNode;
  }

  /** Clear all selection. */
  clear(): void {
    if (this._selected.length === 0) return;
    this._selected = [];
    this._apply();
  }

  /** Number of selected items. */
  get count(): number {
    return this._selected.length;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  /** Bind to viewer: Escape and F key listeners.
   *
   *  F follows the Blender convention every CAD and DCC user already has in
   *  their fingers: frame the selection, or the whole scene when nothing is
   *  selected. Shift+F always frames everything — even with a selection.
   *
   *  Keyboard scope (plan-515 R3-2): the keys are handled on the viewer's own
   *  container (`viewer.keyboardScope`), so with several viewers on one page
   *  only the focused one reacts. The primary (main) viewer also handles keys
   *  whose target is outside EVERY viewer scope (HMI panels, body), which keeps
   *  "select in the hierarchy, press F" working. A host without a DOM scope
   *  (tests) keeps the historical document-wide listener. */
  init(viewer: ViewerHost): void {
    this._viewer = viewer;
    const handler = (e: KeyboardEvent): void => this._onKeyDown(e);
    this._keyHandler = handler;
    const scope = viewer.keyboardScope ?? null;
    if (scope) {
      this._scope = scope;
      registerKeyboardScope(scope);
      scope.addEventListener('keydown', handler);
      this._keyTarget = scope;
      if (viewer.keyboardScopeIsPrimary) {
        this._outsideScopeHandler = (e: KeyboardEvent): void => {
          if (isEventInsideKeyboardScope(e)) return;
          handler(e);
        };
        document.addEventListener('keydown', this._outsideScopeHandler);
      }
    } else {
      document.addEventListener('keydown', handler);
      this._keyTarget = document;
    }
  }

  private _onKeyDown(e: KeyboardEvent): void {
    // Don't steal keys from focused inputs
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.target as HTMLElement)?.isContentEditable) return;

    if (e.key === 'Escape') {
      if (this._selected.length > 0) this.clear();
      return;
    }

    if (e.key === 'f' || e.key === 'F') {
      // Never fight a browser/OS accelerator (Ctrl+F, Cmd+F, Alt+F).
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Double "FF" (second press within the window) frames the whole scene.
      const now = performance.now();
      const isDouble = !e.repeat && now - this._lastFPressMs < SelectionManager.DOUBLE_F_MS;
      this._lastFPressMs = isDouble ? -Infinity : now;
      this.frameSelectionOrScene(e.shiftKey || isDouble);
      e.preventDefault();
    }
  }

  private static readonly DOUBLE_F_MS = 350;
  private _lastFPressMs = -Infinity;

  /**
   * Frame the current selection, falling back to the whole scene.
   *
   * `all` (Shift+F) skips the selection entirely. A selected kinematic axis
   * (an empty without own geometry) frames its whole collected group. The
   * primary selected path is announced as `object-focus` with
   * `openInspector: false` (the node is already selected — consumers such as
   * the mobile sheet react, the hierarchy does not re-reveal). Both paths are
   * no-ops when the host does not implement the optional focus API.
   */
  frameSelectionOrScene(all = false): void {
    const viewer = this._viewer;
    if (!viewer) return;

    if (!all && this._selected.length > 0 && viewer.fitToNodes) {
      const nodes = this._framingNodes();
      if (nodes.length > 0) {
        const snap = this._snapshot;
        if (snap.primaryPath && snap.primaryNode) {
          viewer.emit('object-focus', { path: snap.primaryPath, node: snap.primaryNode, openInspector: false });
        }
        viewer.fitToNodes(nodes);
        return;
      }
    }
    viewer.frameSceneContent?.(true);
  }

  /** The selection's nodes plus, for a kinematic axis, its collected group. */
  private _framingNodes(): Object3D[] {
    const nodes = this._resolvedNodes();
    const groups = this._viewer?.groups;
    if (!groups) return nodes;
    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const rv = (nodes[i].userData as Record<string, unknown> | undefined)?.['realvirtual'] as
        Record<string, unknown> | undefined;
      if (!rv) continue;
      for (const key of Object.keys(rv)) {
        if (!/^Kinematic(_\d+)?$/.test(key)) continue;
        const groupName = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
        if (typeof groupName === 'string' && groupName) {
          const members = groups.get(groupName)?.nodes;
          if (members) for (const m of members) nodes.push(m);
        }
      }
    }
    return nodes;
  }

  /** Unbind everything. */
  dispose(): void {
    if (this._keyHandler && this._keyTarget) {
      this._keyTarget.removeEventListener('keydown', this._keyHandler as EventListener);
    }
    if (this._outsideScopeHandler) {
      document.removeEventListener('keydown', this._outsideScopeHandler);
      this._outsideScopeHandler = null;
    }
    if (this._scope) {
      unregisterKeyboardScope(this._scope);
      this._scope = null;
    }
    this._keyHandler = null;
    this._keyTarget = null;
    this._selected = [];
    this._snapshot = EMPTY_SNAPSHOT;
    this._viewer = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  /** Resolve a path into an entry, remembering the path either way. */
  private _entryForPath(path: string): SelectionEntry {
    return { node: this._viewer?.registry?.getNode(path) ?? null, path };
  }

  /** Index of the entry addressed by `path` — by node identity where the path
   *  resolves, by the remembered path otherwise. */
  private _indexOfPath(path: string): number {
    const node = this._viewer?.registry?.getNode(path) ?? null;
    return this._selected.findIndex(e => (node ? e.node === node : e.path === path));
  }

  /** The live objects behind the current selection, in order. */
  private _resolvedNodes(): Object3D[] {
    const nodes: Object3D[] = [];
    for (const entry of this._selected) {
      const node = entry.node ?? (entry.path ? this._viewer?.registry?.getNode(entry.path) ?? null : null);
      if (node) nodes.push(node);
    }
    return nodes;
  }

  /** The path of one entry: the one it was selected by, else the registry's. */
  private _pathOf(entry: SelectionEntry): string | null {
    if (entry.path !== null) return entry.path;
    if (!entry.node) return null;
    return this._viewer?.registry?.getPathForNode?.(entry.node) ?? null;
  }

  /** Collect all registered descendant paths by walking the Object3D tree. */
  private _collectDescendantPaths(path: string): string[] {
    const viewer = this._viewer;
    if (!viewer?.registry) return [];

    const root = viewer.registry.getNode(path);
    if (!root) return [];

    const paths: string[] = [];
    const visit = (node: import('three').Object3D) => {
      for (const child of node.children) {
        const childPath = viewer.registry!.getPathForNode(child);
        if (childPath) paths.push(childPath);
        visit(child);
      }
    };
    visit(root);
    return paths;
  }

  /**
   * Re-apply the selection highlight for the CURRENT selection without
   * changing the selection or emitting events. Called by RVHighlightPolicy
   * after a mode profile swap so the surviving selection re-renders in the
   * new mode's visual.
   */
  refreshHighlight(): void {
    this._applyHighlight();
  }

  private _applyHighlight(): void {
    const viewer = this._viewer;
    if (!viewer) return;
    if (this._selected.length === 0) {
      viewer.highlighter.clearSelection();
      return;
    }
    const nodes = this._resolvedNodes();
    if (nodes.length > 0) {
      // Include child drives in highlight when any selected node has LayoutObject
      const hasLayout = nodes.some(n => {
        const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
        return !!rv?.LayoutObject;
      });
      viewer.highlighter.highlightSelection(nodes, { includeChildDrives: hasLayout });
    } else {
      viewer.highlighter.clearSelection();
    }
  }

  private _apply(): void {
    const viewer = this._viewer;
    if (!viewer) return;

    this._applyHighlight();

    // Create new snapshot. Paths are derived here, so a node the registry does
    // not know simply contributes none — that is the `runtime` case (D2).
    const nodes = Object.freeze(this._resolvedNodes()) as ReadonlyArray<Object3D>;
    const paths: string[] = [];
    for (const entry of this._selected) {
      const path = this._pathOf(entry);
      if (path !== null) paths.push(path);
    }
    const last = this._selected.length > 0 ? this._selected[this._selected.length - 1] : null;
    this._snapshot = Object.freeze({
      nodes,
      primaryNode: nodes.length > 0 ? nodes[nodes.length - 1] : null,
      selectedPaths: Object.freeze(paths) as ReadonlyArray<string>,
      primaryPath: last ? this._pathOf(last) : null,
    });

    // Emit viewer event
    viewer.emit('selection-changed', this._snapshot);

    // Notify React listeners
    for (const listener of this._listeners) {
      listener();
    }
  }
}
