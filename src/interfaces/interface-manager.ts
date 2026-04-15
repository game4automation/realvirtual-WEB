// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InterfaceManager — Coordinates industrial interface plugins.
 *
 * Enforces the mutex constraint: only one interface may be active at a time.
 * Provides a registry of available interface implementations and handles
 * activation/deactivation with proper state transitions.
 *
 * Usage:
 *   const manager = new InterfaceManager();
 *   manager.register(new WebSocketRealtimeInterface());
 *   manager.register(new MQTTInterface());
 *   viewer.use(manager);
 *   await manager.activate('websocket-realtime', settings);
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { BaseIndustrialInterface } from './base-industrial-interface';
import type { InterfaceSettings, InterfaceType } from './interface-settings-store';
import { loadInterfaceSettings } from './interface-settings-store';

export class InterfaceManager implements RVViewerPlugin {
  readonly id = 'interface-manager';
  readonly core = true;
  readonly order = 5; // Run before interface plugins

  private viewer: RVViewer | null = null;
  private registry = new Map<string, BaseIndustrialInterface>();
  private _activeId: string | null = null;
  private _activating = false; // Fix 2: mutex guard against concurrent activate

  /** Register an interface implementation. Does NOT activate it. */
  register(iface: BaseIndustrialInterface): this {
    this.registry.set(iface.id, iface);
    return this;
  }

  /** Get all registered interface implementations. */
  getRegistered(): ReadonlyMap<string, BaseIndustrialInterface> {
    return this.registry;
  }

  /** Get the currently active interface (or null). */
  getActive(): BaseIndustrialInterface | null {
    return this._activeId ? (this.registry.get(this._activeId) ?? null) : null;
  }

  /** Get the active interface ID. */
  get activeId(): string | null {
    return this._activeId;
  }

  /**
   * Activate an interface by its ID.
   * Disconnects any previously active interface first (mutex).
   */
  async activate(interfaceId: string, settings: InterfaceSettings): Promise<void> {
    // Fix 2: Guard against concurrent activate calls
    if (this._activating) return;
    this._activating = true;

    try {
      // Deactivate current (same or different ID) to reset state
      if (this._activeId) {
        this.deactivate();
      }

      const iface = this.registry.get(interfaceId);
      if (!iface) {
        throw new Error(`Interface '${interfaceId}' not registered`);
      }

      this._activeId = interfaceId;

      // Pass viewer reference and connect
      if (this.viewer) {
        iface.onModelLoaded?.(
          { drives: [], sensors: [], sources: [], extras: {} } as unknown as LoadResult,
          this.viewer,
        );
      }

      await iface.connect(settings);
    } finally {
      this._activating = false;
    }
  }

  /** Deactivate the current interface (disconnect + cleanup). */
  deactivate(): void {
    if (!this._activeId) return;

    const iface = this.registry.get(this._activeId);
    if (iface) {
      iface.disconnect();
    }

    this._activeId = null;
  }

  // ── RVViewerPlugin Lifecycle ──

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;

    // Forward to active interface
    const active = this.getActive();
    if (active) {
      active.onModelLoaded?.(result, viewer);
    } else {
      // Fix 8: Use activate() which properly sets _settings and calls connect()
      const settings = loadInterfaceSettings();
      if (settings.activeType !== 'none' && settings.autoConnect) {
        const iface = this.registry.get(settings.activeType);
        if (iface) {
          this.activate(settings.activeType, settings).catch((err) => {
            console.warn(`[interface-manager] Auto-connect failed:`, err);
          });
        }
      }
    }
  }

  onModelCleared(): void {
    // Interface connections are independent of model — don't disconnect
  }

  onConnectionStateChanged(state: 'Connected' | 'Disconnected', viewer: RVViewer): void {
    const active = this.getActive();
    if (active && 'onConnectionStateChanged' in active) {
      (active as RVViewerPlugin).onConnectionStateChanged?.(state, viewer);
    }
  }

  onFixedUpdatePre(dt: number): void {
    const active = this.getActive();
    active?.onFixedUpdatePre?.(dt);
  }

  onFixedUpdatePost(dt: number): void {
    const active = this.getActive();
    active?.onFixedUpdatePost?.(dt);
  }

  dispose(): void {
    this.deactivate();
    // Fix 9: Dispose all registered interfaces, not just the active one
    for (const iface of this.registry.values()) {
      iface.dispose?.();
    }
    this.registry.clear();
    this.viewer = null;
  }
}
