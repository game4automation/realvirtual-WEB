// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TooltipStore — Central state for the generic tooltip system.
 *
 * Supports multiple simultaneous tooltips with hover/pin lifecycle:
 * - Hover tooltips: ephemeral, max 1 at a time (highest priority wins)
 * - Pinned tooltips: persistent (one per selected object), stay until explicitly hidden
 * - Entries sharing the same targetPath are merged into a single visible bubble
 *   with vertically stacked content providers.
 *
 * Uses the useSyncExternalStore pattern (subscribe/getSnapshot/notify)
 * so React components can subscribe efficiently without cascading re-renders.
 *
 * Key design decisions:
 * - Data-only store: holds typed data objects, not ReactNodes (avoids re-render storm)
 * - Shallow-compare guard: show() only notifies when data fields actually changed
 * - Cursor position updates are ref-based (getCursorPos), not store-based
 * - Hover/pin lifecycle: hover is ephemeral (1 winner), pinned persists per selection
 * - Merge by targetPath: entries targeting the same node produce one bubble with stacked content
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../rv-viewer';

// ─── Public Types ───────────────────────────────────────────────────────

/** Positioning mode for a tooltip. */
export type TooltipMode = 'cursor' | 'world' | 'fixed';

/** Content type identifier for registry lookup (e.g. 'drive', 'sensor', 'mu'). */
export type TooltipContentType = string;

/** Lifecycle: hover tooltips are ephemeral; pinned tooltips persist until hidden. */
export type TooltipLifecycle = 'hover' | 'pinned';

/** Typed tooltip data — NOT a ReactNode. Content providers receive this as props. */
export interface TooltipData {
  /** Content type for registry lookup (e.g. 'drive', 'sensor'). */
  type: TooltipContentType;
  /** Additional typed fields for the content provider. */
  [key: string]: unknown;
}

/** Configuration for an active tooltip. */
export interface TooltipEntry {
  /** Unique ID (e.g. 'drive-hover', 'drive-pin:/Scene/Robot/Axis1'). */
  id: string;
  /** Typed data — avoids re-render storm from ReactNode references. */
  data: TooltipData;
  /** Positioning mode. */
  mode: TooltipMode;
  /** Lifecycle: 'hover' (ephemeral, max 1) or 'pinned' (persistent). Default: 'hover'. */
  lifecycle?: TooltipLifecycle;
  /** Node path this tooltip targets. Entries sharing a targetPath are merged into one bubble. */
  targetPath?: string;
  /** Cursor position for mode='cursor'. Updated via ref, not store. */
  cursorPos?: { x: number; y: number };
  /** 3D object for world-to-screen projection (mode='world'). */
  worldTarget?: Object3D;
  /** Fixed 3D point for world-to-screen projection (mode='world'). Takes precedence over worldTarget. */
  worldAnchor?: [number, number, number];
  /** Fixed screen position (mode='fixed'). */
  fixedPos?: { x: number; y: number };
  /** Pixel offset from computed position (default: { x: 16, y: -12 }). */
  offset?: { x: number; y: number };
  /** Higher priority wins when multiple tooltips are active (default: 0). */
  priority?: number;
}

/** A single visible tooltip bubble, possibly with multiple stacked content sections. */
export interface VisibleTooltip {
  /** Primary entry (determines position, mode, lifecycle). */
  primary: TooltipEntry;
  /** All content sections to render (may come from multiple store entries). */
  contentEntries: TooltipEntry[];
  /** Stable React key (= targetPath or primary.id). */
  key: string;
}

/** Snapshot for React consumers via useSyncExternalStore. */
export interface TooltipState {
  /** All currently visible tooltip bubbles. */
  visible: VisibleTooltip[];
}

// ─── Store Implementation ───────────────────────────────────────────────

/**
 * TooltipStore — Singleton store managing tooltip lifecycle.
 *
 * Follows the useSyncExternalStore contract:
 * - subscribe(listener) returns an unsubscribe function
 * - getSnapshot() returns a referentially stable object
 * - notify() creates a new snapshot object and fires listeners
 */
export class TooltipStore {
  /** All registered tooltips, keyed by ID. */
  private entries = new Map<string, TooltipEntry>();

  /** Cursor positions for each tooltip (ref-based, not in snapshot). */
  private cursorPositions = new Map<string, { x: number; y: number }>();

  // ── useSyncExternalStore interface ──

  private _listeners = new Set<() => void>();

  /** Cached snapshot — MUST be a stable reference between notifications. */
  private _snapshot: TooltipState = { visible: [] };

  /** Subscribe for React useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Snapshot getter for React useSyncExternalStore. Returns stable reference. */
  getSnapshot = (): TooltipState => this._snapshot;

  private notify(): void {
    this._snapshot = { visible: this.resolveVisible() };
    for (const listener of this._listeners) listener();
  }

  // ── Public API ──

  /**
   * Show or update a tooltip.
   *
   * If the tooltip with this ID already exists and only cursorPos changed,
   * the position is updated via ref without triggering a React re-render.
   * A re-render is only triggered when data fields actually change.
   */
  show(entry: TooltipEntry): void {
    const existing = this.entries.get(entry.id);

    // Always update cursor position (ref-based, no re-render)
    if (entry.cursorPos) {
      this.cursorPositions.set(entry.id, entry.cursorPos);
    }

    // Shallow-compare guard: skip notify if data hasn't changed
    if (existing && this.shallowEqual(existing, entry)) {
      // Update mutable fields without notification
      existing.worldTarget = entry.worldTarget;
      existing.fixedPos = entry.fixedPos;
      existing.offset = entry.offset;
      return;
    }

    this.entries.set(entry.id, { ...entry });
    this.notify();
  }

  /** Hide (remove) a tooltip by ID. */
  hide(id: string): void {
    if (!this.entries.has(id)) return;
    this.entries.delete(id);
    this.cursorPositions.delete(id);
    this.notify();
  }

  /** Hide all tooltips (used on model-cleared to release stale Object3D refs). */
  hideAll(): void {
    if (this.entries.size === 0) return;
    this.entries.clear();
    this.cursorPositions.clear();
    this.notify();
  }

  /**
   * Register a model-cleared handler on the viewer to auto-clear all tooltips.
   * Prevents stale Object3D references after scene reload.
   */
  connectViewer(viewer: RVViewer): void {
    viewer.on('model-cleared', () => {
      this.hideAll();
    });
  }

  /**
   * Get the current cursor position for a tooltip (ref-based, no re-render).
   * Used by TooltipLayer for smooth cursor-following without React state.
   */
  getCursorPos(id: string): { x: number; y: number } | undefined {
    return this.cursorPositions.get(id);
  }

  // ── Internal ──

  /**
   * Resolve all visible tooltips with merge-by-targetPath logic.
   *
   * 1. Separate entries into hover and pinned buckets.
   * 2. Group hover entries by targetPath. Pick the winning group (highest max-priority).
   *    All entries in the winning group survive — they'll be merged into one bubble.
   * 3. All pinned entries pass through.
   * 4. If hover winner group shares targetPath with any pinned entry, suppress hover.
   * 5. Group all surviving entries by targetPath for final merge.
   * 6. Each group becomes one VisibleTooltip with stacked contentEntries.
   */
  private resolveVisible(): VisibleTooltip[] {
    if (this.entries.size === 0) return [];

    // 1. Bucket by lifecycle
    const hovers: TooltipEntry[] = [];
    const pinned: TooltipEntry[] = [];
    for (const entry of this.entries.values()) {
      if ((entry.lifecycle ?? 'hover') === 'pinned') {
        pinned.push(entry);
      } else {
        hovers.push(entry);
      }
    }

    // 2. Group hovers by targetPath, then pick the winning group
    let hoverWinners: TooltipEntry[] = [];
    if (hovers.length === 1) {
      hoverWinners = [hovers[0]];
    } else if (hovers.length > 1) {
      // Group by targetPath (entries without targetPath are each their own group)
      const hoverGroups = new Map<string, TooltipEntry[]>();
      let ungroupedIdx = 0;
      for (const h of hovers) {
        const key = h.targetPath ?? `__hover_ungrouped_${ungroupedIdx++}`;
        const group = hoverGroups.get(key);
        if (group) {
          group.push(h);
        } else {
          hoverGroups.set(key, [h]);
        }
      }

      // Pick the group with the highest max-priority
      let bestGroupPriority = -Infinity;
      for (const group of hoverGroups.values()) {
        const maxP = Math.max(...group.map(e => e.priority ?? 0));
        if (maxP > bestGroupPriority) {
          bestGroupPriority = maxP;
          hoverWinners = group;
        }
      }
    }

    // 3. Collect pinned targetPaths for suppression check
    const pinnedPaths = new Set<string>();
    for (const p of pinned) {
      if (p.targetPath) pinnedPaths.add(p.targetPath);
    }

    // 4. Suppress hover group if it shares targetPath with a pinned entry
    const hoverTargetPath = hoverWinners[0]?.targetPath;
    if (hoverTargetPath && pinnedPaths.has(hoverTargetPath)) {
      hoverWinners = [];
    }

    // 5. Collect all surviving entries
    const surviving: TooltipEntry[] = [...pinned, ...hoverWinners];

    if (surviving.length === 0) return [];

    // 6. Group by targetPath for final merge
    const groups = new Map<string, TooltipEntry[]>();
    let ungroupedIdx = 0;
    for (const entry of surviving) {
      const key = entry.targetPath ?? `__ungrouped_${ungroupedIdx++}`;
      const group = groups.get(key);
      if (group) {
        group.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    // 7. Build VisibleTooltip array
    const result: VisibleTooltip[] = [];
    for (const [key, entries] of groups) {
      // Sort by priority descending (highest first = primary)
      entries.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
      result.push({
        primary: entries[0],
        contentEntries: entries,
        key,
      });
    }

    return result;
  }

  /**
   * Shallow-compare two entries, ignoring cursorPos/fixedPos/offset/worldTarget.
   * Only compares data fields, mode, lifecycle, and targetPath to determine if a re-render is needed.
   */
  private shallowEqual(a: TooltipEntry, b: TooltipEntry): boolean {
    if (a.id !== b.id || a.mode !== b.mode) return false;
    if ((a.priority ?? 0) !== (b.priority ?? 0)) return false;
    if ((a.lifecycle ?? 'hover') !== (b.lifecycle ?? 'hover')) return false;
    if ((a.targetPath ?? '') !== (b.targetPath ?? '')) return false;

    // Compare data fields
    const aData = a.data;
    const bData = b.data;
    const aKeys = Object.keys(aData);
    const bKeys = Object.keys(bData);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (aData[key] !== bData[key]) return false;
    }
    return true;
  }
}

/** Singleton tooltip store instance. */
export const tooltipStore = new TooltipStore();
