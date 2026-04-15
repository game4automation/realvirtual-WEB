// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ContextMenuStore — Generic plugin-extensible context menu system.
 *
 * Class-based store (not module singleton) so tests can create independent
 * instances. Follows the subscribe/getSnapshot pattern used by
 * LeftPanelManager and SelectionManager for useSyncExternalStore compat.
 *
 * Plugins register menu items via register(). Items are filtered by
 * condition callbacks at open() time. Errors in conditions are caught
 * and treated as false. Labels can be static strings or functions
 * evaluated eagerly at open() time.
 */

import { useSyncExternalStore } from 'react';
import type { Object3D } from 'three';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ContextMenuTarget {
  path: string;
  node: Object3D;
  types: string[];
  extras: Record<string, unknown>;
  /** World-space hit point from the raycast (if available). */
  hitPoint?: [number, number, number];
  /** Surface normal at the hit point (if available). */
  hitNormal?: [number, number, number];
}

export interface ContextMenuItem {
  id: string;
  label: string | ((target: ContextMenuTarget) => string);
  icon?: string;
  action: (target: ContextMenuTarget) => void;
  condition?: (target: ContextMenuTarget) => boolean;
  order?: number;
  danger?: boolean;
  dividerBefore?: boolean;
}

/** Resolved item in snapshot — labels pre-resolved to strings. */
export interface ResolvedContextMenuItem {
  id: string;
  resolvedLabel: string;
  action: (target: ContextMenuTarget) => void;
  order: number;
  danger?: boolean;
  dividerBefore?: boolean;
}

export interface ContextMenuRegistration {
  pluginId: string;
  items: ContextMenuItem[];
}

export interface ContextMenuSnapshot {
  open: boolean;
  pos: { x: number; y: number } | null;
  target: ContextMenuTarget | null;
  items: ResolvedContextMenuItem[];
}

// ─── Store ──────────────────────────────────────────────────────────────

const CLOSED_SNAPSHOT: ContextMenuSnapshot = Object.freeze({
  open: false,
  pos: null,
  target: null,
  items: Object.freeze([]) as unknown as ResolvedContextMenuItem[],
});

export class ContextMenuStore {
  /** pluginId -> ContextMenuItem[] */
  private _registrations = new Map<string, ContextMenuItem[]>();
  private _listeners = new Set<() => void>();
  private _snapshot: ContextMenuSnapshot = CLOSED_SNAPSHOT;

  // ─── Registration API ──────────────────────────────────────────────

  /** Register menu items for a plugin. Replaces existing items for same pluginId. */
  register(reg: ContextMenuRegistration): void {
    this._registrations.set(reg.pluginId, reg.items);
  }

  /** Remove all items for a plugin. Closes menu if items from that plugin are showing. */
  unregister(pluginId: string): void {
    const had = this._registrations.has(pluginId);
    this._registrations.delete(pluginId);

    // If menu is open and had items from this plugin, close it
    if (had && this._snapshot.open) {
      if (this._snapshot.items.some(item => {
        // We don't track pluginId on resolved items, so check if any remaining
        // registrations can still produce items for the current target.
        return true; // conservative: just close
      })) {
        this._snapshot = CLOSED_SNAPSHOT;
        this._notify();
      }
    }
  }

  // ─── Open / Close ──────────────────────────────────────────────────

  /**
   * Open the context menu at the given position for the given target.
   * Filters items by condition (try/catch), resolves function labels,
   * sorts by order. If zero items pass, menu stays closed.
   */
  open(pos: { x: number; y: number }, target: ContextMenuTarget): void {
    const resolved: ResolvedContextMenuItem[] = [];

    for (const items of this._registrations.values()) {
      for (const item of items) {
        // Evaluate condition with error isolation
        if (item.condition) {
          try {
            if (!item.condition(target)) continue;
          } catch {
            continue; // Errors treated as false
          }
        }

        // Resolve label eagerly
        let resolvedLabel: string;
        if (typeof item.label === 'function') {
          try {
            resolvedLabel = item.label(target);
          } catch {
            resolvedLabel = '(error)';
          }
        } else {
          resolvedLabel = item.label;
        }

        resolved.push({
          id: item.id,
          resolvedLabel,
          action: item.action,
          order: item.order ?? 100,
          danger: item.danger,
          dividerBefore: item.dividerBefore,
        });
      }
    }

    // Don't open if no items matched
    if (resolved.length === 0) return;

    // Sort by order (stable sort)
    resolved.sort((a, b) => a.order - b.order);

    this._snapshot = {
      open: true,
      pos,
      target,
      items: resolved,
    };
    this._notify();
  }

  /** Close the context menu. Idempotent — double close does not notify twice. */
  close(): void {
    if (!this._snapshot.open) return;
    this._snapshot = CLOSED_SNAPSHOT;
    this._notify();
  }

  // ─── React External Store API ──────────────────────────────────────

  /** Subscribe for React (useSyncExternalStore compatible). Returns unsubscribe. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Get snapshot for React (useSyncExternalStore compatible). */
  getSnapshot = (): ContextMenuSnapshot => {
    return this._snapshot;
  };

  // ─── Internal ──────────────────────────────────────────────────────

  private _notify(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }
}

// ─── Module-level Default Instance ───────────────────────────────────────

/** Default context menu store instance used by RVViewer and React hooks. */
export const contextMenuStore = new ContextMenuStore();

// ─── React Hook ──────────────────────────────────────────────────────────

/** React hook for consuming context menu state via useSyncExternalStore. */
export function useContextMenu(store: ContextMenuStore = contextMenuStore): ContextMenuSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
