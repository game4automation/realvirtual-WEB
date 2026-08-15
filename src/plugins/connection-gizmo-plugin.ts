// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ConnectionGizmoPlugin — optional "cable" visualization for typed
 * connections (plan-259 Stufe 3).
 *
 * One `link-line` gizmo per resolvable connection edge, colored by type.
 * Endpoints track the live world positions of both nodes per frame via
 * `GizmoOverlayManager.updateLinkLine` (BufferGeometry position writes —
 * never a rebuild/dispose per frame, no GC in the render loop). The whole
 * layer is toggleable through the overlay-visibility category `connections`
 * (Display panel); unresolved edges (missing node) draw no cable.
 */

import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { GizmoHandle } from '../core/engine/rv-gizmo-manager';
import { getConnectionSystem, STOP_ON_EXIT_TYPE, type RvConnection } from '../core/engine/rv-connection-registry';

/** Fixed palette for well-known types; user types hash into it. */
const TYPE_COLORS: Record<string, number> = {
  [STOP_ON_EXIT_TYPE]: 0x29b6f6, // light blue — the built-in station link
};
const PALETTE = [0xffb74d, 0xab47bc, 0x66bb6a, 0xef5350, 0x26a69a, 0xec407a, 0x9ccc65, 0x5c6bc0];

/** Deterministic per-type cable color (stable across sessions). */
export function connectionTypeColor(type: string): number {
  const fixed = TYPE_COLORS[type];
  if (fixed !== undefined) return fixed;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (Math.imul(h, 31) + type.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}

export class ConnectionGizmoPlugin implements RVViewerPlugin {
  readonly id = 'connection-gizmo';

  private viewer: RVViewer | null = null;
  private readonly handles = new Map<string, GizmoHandle>();
  private unsubscribe: (() => void) | null = null;
  private rebuildQueued = false;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.attachRuntime();
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.rebuild();
  }

  onModelCleared(): void {
    this.clear();
  }

  /**
   * User switched the plugin off (plan-436). Drops the cables AND the registry
   * subscription that `init()` installed — without it the plugin would keep
   * queueing rebuilds for a layer nobody renders.
   */
  onDeactivate(): void {
    this.detachRuntime();
  }

  /**
   * User switched the plugin back on (plan-436). No selection replay is needed
   * here: `rebuild()` reads `getConnectionSystem().all()`, a PULL store — the
   * cables are a function of the edge set, not of an event that may never fire
   * again for an unchanged model (plan-436 §2.2).
   */
  onActivate(viewer: RVViewer): void {
    this.viewer = viewer;
    this.attachRuntime();
    this.rebuild();
  }

  onRender(): void {
    if (this.rebuildQueued) {
      this.rebuildQueued = false;
      this.rebuild();
    }
    // Per-frame endpoint sync — position writes only (see link-line shape).
    const mgr = this.viewer?.gizmoManager;
    if (!mgr) return;
    for (const handle of this.handles.values()) {
      mgr.updateLinkLine(handle.id);
    }
  }

  dispose(): void {
    this.detachRuntime();
    this.viewer = null;
  }

  // ── Attach / detach (ONE path, shared by init/dispose and the toggle) ──

  /**
   * Install the runtime subscription. Idempotent: an existing subscription is
   * dropped first, so `init()` → `onDeactivate()` → `onActivate()` can never
   * end up with two listeners (plan-436 F5).
   */
  private attachRuntime(): void {
    this.unsubscribe?.();
    this.unsubscribe = getConnectionSystem().subscribe(() => {
      // Edge/type changes can burst (model load) — coalesce to one rebuild.
      this.rebuildQueued = true;
    });
  }

  /**
   * Release everything the plugin runs on. Shared by `dispose()` and the user
   * toggle — the plugin owns no permanent resources beyond this (the `handles`
   * are GizmoManager-owned and released by `clear()`).
   */
  private detachRuntime(): void {
    this.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    // A rebuild queued just before the switch-off must not survive it.
    this.rebuildQueued = false;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private clear(): void {
    for (const handle of this.handles.values()) handle.dispose();
    this.handles.clear();
  }

  private rebuild(): void {
    const viewer = this.viewer;
    const mgr = viewer?.gizmoManager;
    const registry = viewer?.registry;
    if (!viewer || !mgr || !registry) return;

    const edges = getConnectionSystem().all();
    const wanted = new Set<string>();

    for (const edge of edges) {
      wanted.add(edge.id);
      if (this.handles.has(edge.id)) continue;
      const handle = this.buildCable(edge);
      if (handle) this.handles.set(edge.id, handle);
    }
    // Drop cables of removed edges.
    for (const [id, handle] of [...this.handles]) {
      if (!wanted.has(id)) {
        handle.dispose();
        this.handles.delete(id);
      }
    }
    viewer.markRenderDirty?.();
  }

  private buildCable(edge: RvConnection): GizmoHandle | null {
    const viewer = this.viewer!;
    const registry = viewer.registry!;
    const from = registry.getNode(edge.source);
    const to = registry.getNode(edge.target);
    if (!from || !to) return null; // unresolved edge — inactive, no cable
    return viewer.gizmoManager!.create(from, {
      shape: 'link-line',
      color: connectionTypeColor(edge.type),
      opacity: 0.9,
      linkTo: to,
      category: 'connections',
      userDataMarker: '_rvConnectionCable',
    });
  }
}
