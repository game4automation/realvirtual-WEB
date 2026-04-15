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

import type { RVViewer } from '../rv-viewer';

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
  private _viewer: RVViewer | null = null;
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

  /** Bind to viewer: Escape key listener, etc. */
  init(viewer: RVViewer): void {
    this._viewer = viewer;
    this._escapeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't steal Escape from focused inputs
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (this._selected.length > 0) {
        this.clear();
      }
    };
    document.addEventListener('keydown', this._escapeHandler);
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

  private _apply(): void {
    const viewer = this._viewer;
    if (!viewer) return;

    // Update highlights
    if (this._selected.length === 0) {
      viewer.highlighter.clearSelection();
    } else {
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
