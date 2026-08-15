// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SelectionManager — Central selection state for the WebViewer.
 *
 * Maintains an ordered list of selected node paths. Plugins subscribe
 * via the 'selection-changed' viewer event or the React-compatible
 * subscribe/getSnapshot API (useSyncExternalStore).
 *
 * Selection highlights (cyan) are managed through RVHighlightManager's
 * selection channel — independent from the hover channel.
 */

import type { ViewerHost } from './rv-viewer-host';

// ─── Types ──────────────────────────────────────────────────────────────

export interface SelectionSnapshot {
  /** All selected paths, ordered by selection time. */
  readonly selectedPaths: ReadonlyArray<string>;
  /** The most recently selected path (last in the list), or null. */
  readonly primaryPath: string | null;
}

const EMPTY_SNAPSHOT: SelectionSnapshot = Object.freeze({
  selectedPaths: Object.freeze([]) as ReadonlyArray<string>,
  primaryPath: null,
});

// ─── SelectionManager ───────────────────────────────────────────────────

export class SelectionManager {
  private _selected: string[] = [];
  private _viewer: ViewerHost | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: SelectionSnapshot = EMPTY_SNAPSHOT;
  private _escapeHandler: ((e: KeyboardEvent) => void) | null = null;

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

  // ─── Public API ───────────────────────────────────────────────────

  /** Replace selection with a single path. */
  select(path: string, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    if (this._selected.length === 1 && this._selected[0] === path) return;
    this._selected = [path];
    this._apply();
  }

  /** Toggle a path in/out of the selection (for Shift+click). */
  toggle(path: string, hitPoint?: [number, number, number]): void {
    this.lastHitPoint = hitPoint ?? null;
    const idx = this._selected.indexOf(path);
    if (idx >= 0) {
      this._selected.splice(idx, 1);
    } else {
      this._selected.push(path);
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
    const isCurrentlySelected = this._selected.indexOf(path) >= 0;

    if (isCurrentlySelected) {
      // Remove all
      const removeSet = new Set(allPaths);
      this._selected = this._selected.filter(p => !removeSet.has(p));
    } else {
      // Add all (avoid duplicates)
      const existing = new Set(this._selected);
      for (const p of allPaths) {
        if (!existing.has(p)) {
          this._selected.push(p);
        }
      }
    }
    this._apply();
  }

  /** Replace selection with multiple paths at once. */
  selectPaths(paths: string[]): void {
    this._selected = [...paths];
    this._apply();
  }

  /** Remove a single path from selection. */
  deselect(path: string): void {
    const idx = this._selected.indexOf(path);
    if (idx < 0) return;
    this._selected.splice(idx, 1);
    this._apply();
  }

  /** Clear all selection. */
  clear(): void {
    if (this._selected.length === 0) return;
    this._selected = [];
    this._apply();
  }

  /** Check if a path is currently selected. */
  isSelected(path: string): boolean {
    return this._selected.indexOf(path) >= 0;
  }

  /** The most recently selected path, or null. */
  get primaryPath(): string | null {
    return this._selected.length > 0
      ? this._selected[this._selected.length - 1]
      : null;
  }

  /** All selected paths (read-only copy). */
  get selectedPaths(): ReadonlyArray<string> {
    return this._snapshot.selectedPaths;
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
   *  selected. Shift+F always frames everything. It is deliberately a global
   *  binding rather than a toolbar button — the moment you need it is the
   *  moment the camera is somewhere you cannot navigate back from. */
  init(viewer: ViewerHost): void {
    this._viewer = viewer;
    this._escapeHandler = (e: KeyboardEvent) => {
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
        this.frameSelectionOrScene(e.shiftKey);
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', this._escapeHandler);
  }

  /**
   * Frame the current selection, falling back to the whole scene.
   *
   * `all` (Shift+F) skips the selection entirely. Both paths are no-ops when
   * the host does not implement the optional focus API.
   */
  frameSelectionOrScene(all = false): void {
    const viewer = this._viewer;
    if (!viewer) return;

    if (!all && this._selected.length > 0 && viewer.registry && viewer.fitToNodes) {
      const nodes: import('three').Object3D[] = [];
      for (const path of this._selected) {
        const node = viewer.registry.getNode(path);
        if (node) nodes.push(node);
      }
      if (nodes.length > 0) {
        viewer.fitToNodes(nodes);
        return;
      }
    }
    viewer.frameSceneContent?.(true);
  }

  /** Unbind everything. */
  dispose(): void {
    if (this._escapeHandler) {
      document.removeEventListener('keydown', this._escapeHandler);
      this._escapeHandler = null;
    }
    this._selected = [];
    this._snapshot = EMPTY_SNAPSHOT;
    this._viewer = null;
  }

  // ─── Internal ─────────────────────────────────────────────────────

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
    const nodes = this._selected
      .map(p => viewer.registry?.getNode(p))
      .filter((n): n is NonNullable<typeof n> => n != null);
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

    // Create new snapshot
    const paths = Object.freeze([...this._selected]) as ReadonlyArray<string>;
    this._snapshot = Object.freeze({
      selectedPaths: paths,
      primaryPath: paths.length > 0 ? paths[paths.length - 1] : null,
    });

    // Emit viewer event
    viewer.emit('selection-changed', this._snapshot);

    // Notify React listeners
    for (const listener of this._listeners) {
      listener();
    }
  }
}
