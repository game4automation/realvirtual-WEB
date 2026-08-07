// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * popover-store.ts — Generic 3D-anchored context popover.
 *
 * A reusable concept: ANY component/plugin can pop a small panel that floats next
 * to a world-space point and follows it during orbit/drag. Content is supplied by
 * a registered React component (keyed by id), so the engine layer stays generic and
 * each feature ships its own panel (IK pathpoint, future: drive jog, sensor config…).
 *
 *   popoverContentRegistry.register('ik-target', IKTargetQuickEdit);
 *   popoverStore.show({ id: 'ik-target', getWorld: () => myWorldXYZ, onClose });
 *
 * A single <AnchoredPopover/> (mounted in App.tsx) renders the active request.
 */

import type { ComponentType } from 'react';

export interface PopoverRequest {
  /** Selects the registered content component + identifies the request. */
  id: string;
  /** Live world anchor, polled every frame (no React churn). */
  getWorld: () => [number, number, number];
  /** Screen-space offset from the projected anchor (px). Default { x: 20, y: -10 }. */
  offset?: { x: number; y: number };
  /** Optional title — when set, the drag titlebar shows it + a close button
   *  (compact window), so the content can omit its own header. */
  title?: string;
  /** Called when the popover is dismissed (Escape / close / replaced). */
  onClose?: () => void;
}

// ── Content registry (feature panels self-register) ──

class PopoverContentRegistry {
  private readonly map = new Map<string, ComponentType>();
  register(id: string, component: ComponentType): void { this.map.set(id, component); }
  get(id: string): ComponentType | null { return this.map.get(id) ?? null; }
}
export const popoverContentRegistry = new PopoverContentRegistry();

// ── Active request store ──

class PopoverStore {
  private _req: PopoverRequest | null = null;
  private readonly _listeners = new Set<() => void>();

  subscribe = (l: () => void): (() => void) => { this._listeners.add(l); return () => { this._listeners.delete(l); }; };
  getSnapshot = (): PopoverRequest | null => this._req;

  show(req: PopoverRequest): void {
    const prev = this._req;
    this._req = req;
    this._notify();
    // Replacing a different popover dismisses the old one (same id = in-place update).
    if (prev && prev.id !== req.id) prev.onClose?.();
  }

  /** Hide the active popover (optionally only if it matches `id`). */
  hide(id?: string): void {
    if (!this._req) return;
    if (id && this._req.id !== id) return;
    const prev = this._req;
    this._req = null;
    this._notify();
    prev.onClose?.();
  }

  private _notify(): void { for (const l of this._listeners) l(); }
}

export const popoverStore = new PopoverStore();
