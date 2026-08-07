// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LeftPanelManager — Centralized coordination for docked side panels.
 *
 * Tracks two independent slots: one anchored to the left edge of the
 * viewport, one to the right. Mutual exclusion is **per-side** — a left
 * panel and a right panel can be open at the same time. Within a side,
 * opening a new panel closes the previous one ("last one wins").
 *
 * Lives on `viewer.leftPanelManager` — created in RVViewer constructor,
 * available to all plugins and components.
 *
 * Backward compatibility:
 *   `open(id, width)` defaults to the left slot.
 *   `activePanel` / `activePanelWidth` getters and snapshot fields keep
 *   pointing at the LEFT slot, so consumers like ButtonPanel and the
 *   camera-fit logic that compute "where the left panel ends" stay valid.
 *   Use `getActive(side)` / `snapshot.right` for the right slot.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type PanelId = string; // 'hierarchy' | 'settings' | 'layout-planner' | ...

export type AnchorSide = 'left' | 'right';

export interface PanelSlotState {
  activePanel: PanelId | null;
  activePanelWidth: number;
}

export interface LeftPanelSnapshot {
  /** Currently open LEFT panel id, or null. (Backward-compat alias for `left.activePanel`.) */
  activePanel: PanelId | null;
  /** Width of the LEFT panel (0 when none). (Backward-compat alias for `left.activePanelWidth`.) */
  activePanelWidth: number;
  /** Left-side slot state. */
  left: PanelSlotState;
  /** Right-side slot state. */
  right: PanelSlotState;
  /**
   * Side whose panel was opened most recently, or null when nothing is open.
   * Both sides can hold a panel at once, so "the active panel" is ambiguous —
   * consumers that need ONE window (context-sensitive help, plan-370) read this
   * to break the tie.
   *
   * Session state, deliberately NOT persisted: after a reload the restore order
   * determines it (left first, right last).
   */
  lastOpenedSide: AnchorSide | null;
}

const LS_KEY_ACTIVE_PANEL = 'rv-left-panel-active';

/**
 * Peek the persisted active-panel state without instantiating a manager.
 * Returns the set of panel ids that will be opened on the next `restore()`
 * call. Used by the model-plugin manager during model load to predict
 * whether the planner will activate in the post-load plugin loop, so that
 * it can skip registering model plugins from the start (instead of
 * registering and immediately unregistering when the planner sets its
 * context). Treat this as a hint — it's only correct for the *initial*
 * boot restore.
 */
export function peekPersistedActivePanels(): Set<string> {
  const out = new Set<string>();
  try {
    const saved = localStorage.getItem(LS_KEY_ACTIVE_PANEL);
    if (!saved) return out;
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === 'object') {
      if ('id' in parsed && typeof parsed.id === 'string' && parsed.id) {
        out.add(parsed.id);
      }
      if (parsed.left?.id) out.add(parsed.left.id);
      if (parsed.right?.id) out.add(parsed.right.id);
    }
  } catch { /* ignore corrupt data */ }
  return out;
}

const EMPTY_SLOT: PanelSlotState = { activePanel: null, activePanelWidth: 0 };

// ─── Manager ────────────────────────────────────────────────────────────

export class LeftPanelManager {
  private _left: PanelSlotState = { ...EMPTY_SLOT };
  private _right: PanelSlotState = { ...EMPTY_SLOT };
  /** Side of the most recent `open()` — see LeftPanelSnapshot.lastOpenedSide. */
  private _lastOpenedSide: AnchorSide | null = null;
  private _listeners = new Set<() => void>();
  private _snapshot: LeftPanelSnapshot = this._buildSnapshot();
  /** Panel widths registered via open() — used to restore width on reload. */
  private _panelWidths = new Map<PanelId, number>();

  // ─── Backward-compat (left slot) ────────────────────────────────

  /** Currently open LEFT panel id, or null. */
  get activePanel(): PanelId | null { return this._left.activePanel; }

  /** Width of the LEFT panel (for ButtonPanel offset, camera fit). */
  get activePanelWidth(): number { return this._left.activePanelWidth; }

  // ─── Side-aware accessors ───────────────────────────────────────

  /** Currently open panel id for the given side. */
  getActive(side: AnchorSide): PanelId | null {
    return (side === 'right' ? this._right : this._left).activePanel;
  }

  /** Width of the panel currently open on the given side (0 when none). */
  getActiveWidth(side: AnchorSide): number {
    return (side === 'right' ? this._right : this._left).activePanelWidth;
  }

  /**
   * Open a panel — closes any previously open panel on the SAME side.
   * Panels on the opposite side are unaffected.
   */
  open(id: PanelId, width: number, anchor: AnchorSide = 'left'): void {
    this._panelWidths.set(id, width);
    const slot = anchor === 'right' ? this._right : this._left;
    const slotUnchanged = slot.activePanel === id && slot.activePanelWidth === width;
    // Re-opening the SAME window is only a full no-op when it also does not
    // move the focus to the other side. Bailing out before `_lastOpenedSide`
    // was updated would leave "which window is the user working in" wrong.
    if (slotUnchanged && this._lastOpenedSide === anchor) return;
    this._lastOpenedSide = anchor;
    if (slotUnchanged) {
      // Nothing persistable changed — only the session-local focus side did.
      this._notify();
      return;
    }
    slot.activePanel = id;
    slot.activePanelWidth = width;
    this._persist();
    this._notify();
  }

  /** Close a panel by id (works regardless of which side it's on). */
  close(id: PanelId): void {
    let changed = false;
    if (this._left.activePanel === id) {
      this._left = { ...EMPTY_SLOT };
      changed = true;
    }
    if (this._right.activePanel === id) {
      this._right = { ...EMPTY_SLOT };
      changed = true;
    }
    if (!changed) return;
    // Focus falls back to whatever is still open; null when nothing is.
    this._lastOpenedSide = this._left.activePanel ? 'left'
      : this._right.activePanel ? 'right'
        : null;
    this._persist();
    this._notify();
  }

  /**
   * Restore the previously active panels from localStorage.
   * Handles both the new per-side payload and the legacy single-panel format.
   * `defaultWidths` lets a plugin supply its width if it hasn't called
   * `open()` yet by the time `restore()` runs.
   */
  restore(defaultWidths?: Record<string, number>): void {
    try {
      const saved = localStorage.getItem(LS_KEY_ACTIVE_PANEL);
      if (!saved) return;
      const parsed = JSON.parse(saved) as
        | { id?: string; width?: number }                                          // legacy
        | { left?: { id: string; width: number }; right?: { id: string; width: number } };

      // Legacy format → restore on left
      if ('id' in parsed && typeof parsed.id === 'string' && parsed.id) {
        const w = this._panelWidths.get(parsed.id) ?? defaultWidths?.[parsed.id] ?? (parsed.width ?? 0);
        if (w > 0) this.open(parsed.id, w, 'left');
        return;
      }

      const newFmt = parsed as { left?: { id: string; width: number }; right?: { id: string; width: number } };
      if (newFmt.left?.id) {
        const w = this._panelWidths.get(newFmt.left.id) ?? defaultWidths?.[newFmt.left.id] ?? newFmt.left.width;
        if (w > 0) this.open(newFmt.left.id, w, 'left');
      }
      if (newFmt.right?.id) {
        const w = this._panelWidths.get(newFmt.right.id) ?? defaultWidths?.[newFmt.right.id] ?? newFmt.right.width;
        if (w > 0) this.open(newFmt.right.id, w, 'right');
      }
    } catch { /* ignore corrupt data */ }
  }

  /** Toggle a panel open/closed on the given side. */
  toggle(id: PanelId, width: number, anchor: AnchorSide = 'left'): void {
    if (this.isOpen(id)) {
      this.close(id);
    } else {
      this.open(id, width, anchor);
    }
  }

  /** True if the given panel id is currently open on EITHER side. */
  isOpen(id: PanelId): boolean {
    return this._left.activePanel === id || this._right.activePanel === id;
  }

  /** Subscribe for React (useSyncExternalStore compatible). Returns unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Get snapshot for React (useSyncExternalStore compatible). */
  getSnapshot = (): LeftPanelSnapshot => {
    return this._snapshot;
  };

  // ─── Internal ─────────────────────────────────────────────────────

  private _buildSnapshot(): LeftPanelSnapshot {
    return {
      activePanel: this._left.activePanel,
      activePanelWidth: this._left.activePanelWidth,
      left: { ...this._left },
      right: { ...this._right },
      lastOpenedSide: this._lastOpenedSide,
    };
  }

  private _persist(): void {
    try {
      const payload: { left?: { id: string; width: number }; right?: { id: string; width: number } } = {};
      if (this._left.activePanel) {
        payload.left = { id: this._left.activePanel, width: this._left.activePanelWidth };
      }
      if (this._right.activePanel) {
        payload.right = { id: this._right.activePanel, width: this._right.activePanelWidth };
      }
      if (payload.left || payload.right) {
        localStorage.setItem(LS_KEY_ACTIVE_PANEL, JSON.stringify(payload));
      } else {
        localStorage.removeItem(LS_KEY_ACTIVE_PANEL);
      }
    } catch { /* ignore */ }
  }

  private _notify(): void {
    // Fresh snapshot object so React detects the change
    this._snapshot = this._buildSnapshot();
    for (const listener of this._listeners) {
      listener();
    }
  }
}
