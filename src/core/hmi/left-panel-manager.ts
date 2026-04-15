// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LeftPanelManager — Centralized coordination for left-side panels.
 *
 * Manages mutual exclusion: only one left panel can be open at a time.
 * When a new panel opens, the previously open panel closes automatically
 * ("last one wins"). Provides useSyncExternalStore-compatible subscription
 * so React components can reactively read the active panel and its width.
 *
 * Lives on `viewer.leftPanelManager` — created in RVViewer constructor,
 * available to all plugins and components.
 */

// ─── Types ──────────────────────────────────────────────────────────────

export type PanelId = string; // 'hierarchy' | 'settings' | 'machine-control' | ...

export interface LeftPanelSnapshot {
  /** Currently open panel id, or null if no panel is open. */
  activePanel: PanelId | null;
  /** Width in pixels of the currently open panel (0 when closed). */
  activePanelWidth: number;
}

const LS_KEY_ACTIVE_PANEL = 'rv-left-panel-active';

// ─── Manager ────────────────────────────────────────────────────────────

export class LeftPanelManager {
  private _activePanel: PanelId | null = null;
  private _activePanelWidth = 0;
  private _listeners = new Set<() => void>();
  private _snapshot: LeftPanelSnapshot = { activePanel: null, activePanelWidth: 0 };
  /** Panel widths registered via open() — used to restore width on reload. */
  private _panelWidths = new Map<PanelId, number>();

  /** Currently open panel id, or null. */
  get activePanel(): PanelId | null { return this._activePanel; }

  /** Width of the currently open panel (for ButtonPanel offset). */
  get activePanelWidth(): number { return this._activePanelWidth; }

  /**
   * Open a panel — automatically closes any other open panel ("last one wins").
   * @param id    Panel identifier (e.g. 'hierarchy', 'settings', 'machine-control')
   * @param width Width in pixels for the panel
   */
  open(id: PanelId, width: number): void {
    this._panelWidths.set(id, width);
    if (this._activePanel === id && this._activePanelWidth === width) return;
    this._activePanel = id;
    this._activePanelWidth = width;
    this._persist();
    this._notify();
  }

  /** Close a specific panel (no-op if not the active one). */
  close(id: PanelId): void {
    if (this._activePanel !== id) return;
    this._activePanel = null;
    this._activePanelWidth = 0;
    this._persist();
    this._notify();
  }

  /**
   * Restore the previously active panel from localStorage.
   * Must be called after all plugins have registered their panel widths
   * via at least one `open()` call, or pass a width map.
   */
  restore(defaultWidths?: Record<string, number>): void {
    try {
      const saved = localStorage.getItem(LS_KEY_ACTIVE_PANEL);
      if (!saved) return;
      const { id, width } = JSON.parse(saved) as { id: string; width: number };
      const w = this._panelWidths.get(id) ?? defaultWidths?.[id] ?? width;
      if (id && w > 0) this.open(id, w);
    } catch { /* ignore corrupt data */ }
  }

  /** Toggle a panel open/closed. */
  toggle(id: PanelId, width: number): void {
    if (this._activePanel === id) {
      this.close(id);
    } else {
      this.open(id, width);
    }
  }

  /** Check if a specific panel is open. */
  isOpen(id: PanelId): boolean {
    return this._activePanel === id;
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

  private _persist(): void {
    try {
      if (this._activePanel) {
        localStorage.setItem(LS_KEY_ACTIVE_PANEL, JSON.stringify({
          id: this._activePanel,
          width: this._activePanelWidth,
        }));
      } else {
        localStorage.removeItem(LS_KEY_ACTIVE_PANEL);
      }
    } catch { /* ignore */ }
  }

  private _notify(): void {
    // Create new snapshot object so React detects the change
    this._snapshot = {
      activePanel: this._activePanel,
      activePanelWidth: this._activePanelWidth,
    };
    for (const listener of this._listeners) {
      listener();
    }
  }
}
