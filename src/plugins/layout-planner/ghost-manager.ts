// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GhostManager — async BUILDER for the node a library drag instantiates.
 *
 * It builds a single node (a real ModelCache clone, or a virtual-DES gizmo) for
 * the current catalog entry, guarding entry-switch races. It does NOT prep,
 * register, parent, or position the node — the planner `adopt()`s the built
 * node on drag-enter and runs the full `addPlacedToScene` (prep + register) so
 * the dragged object is a real, selectable, gizmo-bearing placement from the
 * start (only the store/undo commit is deferred to drop).
 */

import { Group, Object3D, BoxGeometry, EdgesGeometry, LineSegments, LineBasicMaterial } from 'three';

import type { ModelCache } from './model-cache';
import type { LibraryCatalogEntry } from './rv-layout-store';

export class GhostManager {
  private _ghost: Object3D | null = null;
  private _entryId: string | null = null;
  private _loading = false;
  private _readyPromise: Promise<void> | null = null;
  private _modelCache: ModelCache;

  /**
   * Optional callback invoked whenever the built node is replaced or adopted.
   * The planner uses this to refresh the outline channel.
   */
  onGhostStateChange: (() => void) | null = null;

  constructor(modelCache: ModelCache) {
    this._modelCache = modelCache;
  }

  /** Whether a preview is currently visible. */
  get visible(): boolean {
    return this._ghost?.visible ?? false;
  }

  /** The current preview root (or null). Used by the planner to outline it. */
  get ghost(): Object3D | null {
    return this._ghost;
  }

  /** The entry ID the current preview was built for. */
  get entryId(): string | null {
    return this._entryId;
  }

  /** Whether an async build is currently in flight. */
  get loading(): boolean {
    return this._loading;
  }

  /**
   * Ensure the preview matches the given catalog entry. Builds the model
   * asynchronously if needed (non-blocking). Returns the in-flight build
   * promise so callers (e.g. a drop that arrives before the clone is ready)
   * can `await whenReady()`.
   */
  async ensureForEntry(entry: LibraryCatalogEntry): Promise<void> {
    // Already have the right preview
    if (this._entryId === entry.id && this._ghost) return;
    // Already building this one — return the in-flight promise
    if (this._loading && this._entryId === entry.id) return this._readyPromise ?? undefined;

    this._loading = true;
    this._entryId = entry.id;
    this._readyPromise = this._build(entry);
    return this._readyPromise;
  }

  /** Resolves when the current (or most recent) build has settled. */
  whenReady(): Promise<void> {
    return this._readyPromise ?? Promise.resolve();
  }

  private async _build(entry: LibraryCatalogEntry): Promise<void> {
    try {
      // Remove the old preview (don't deep-dispose — it's a ModelCache clone)
      this._removeFromScene();

      let node: Object3D;
      if (entry.virtual && entry.gizmoSize) {
        // Virtual DES component — build the SAME node a real placement builds
        // (component createGizmo() with a wireframe fallback), so the dragged
        // preview is byte-identical to the committed object.
        node = await buildVirtualNode(entry);
      } else {
        const clone = await this._modelCache.getOrLoad(entry.glbUrl ?? '');
        // The user may have switched entries while the GLB was decoding.
        if (this._entryId !== entry.id) return;
        node = clone;
      }

      // Builder-only: hand the raw node to the planner, which adopts + registers
      // it (prep, processExtras, snaps, selection) on drag-enter.
      this._ghost = node;
      this.onGhostStateChange?.();
    } catch (err) {
      console.warn('[LayoutPlanner] Failed to build drag preview:', err);
    } finally {
      this._loading = false;
    }
  }

  /** Position the preview at the given floor coordinates and make it visible. */
  setPosition(x: number, z: number): void {
    if (!this._ghost) return;
    this._ghost.position.x = x;
    this._ghost.position.z = z;
    const wasVisible = this._ghost.visible;
    this._ghost.visible = true;
    if (!wasVisible) this.onGhostStateChange?.();
  }

  /** Hide the preview without disposing it (keeps it ready for the next move). */
  hide(): void {
    if (this._ghost && this._ghost.visible) {
      this._ghost.visible = false;
      this.onGhostStateChange?.();
    }
  }

  /**
   * Hand off the preview node to the caller as a placed object: clear the
   * manager's reference WITHOUT removing the node from the scene. The caller
   * then runs the registration half on it. Returns the node (or null).
   */
  adopt(): Object3D | null {
    const node = this._ghost;
    this._ghost = null;
    this._entryId = null;
    this._readyPromise = null;
    this.onGhostStateChange?.(); // drops the preview outline
    return node;
  }

  /** Cancel the preview: remove the (unregistered) node and reset state. */
  cancel(): void {
    this.dispose();
  }

  /** Fully dispose the preview and reset state. */
  dispose(): void {
    if (this._ghost) {
      // The preview's mesh geometries belong to the ModelCache and must NOT
      // be disposed here.
      this._removeFromScene();
    }
    this._ghost = null;
    this._entryId = null;
    this._readyPromise = null;
    this.onGhostStateChange?.();
  }

  // ── Internal ──

  private _removeFromScene(): void {
    if (this._ghost?.parent) this._ghost.parent.remove(this._ghost);
    this._ghost = null;
  }
}

// ── Virtual component helpers ──

const DES_COLORS: Record<string, number> = {
  DESSource: 0x4caf50,     // green
  DESSink: 0xf44336,       // red
  DESConveyor: 0x2196f3,   // blue
  DESStation: 0xff9800,    // orange
  DESStorage: 0x9c27b0,    // purple
};

/**
 * Build the node for a virtual/DES catalog entry — the component class's own
 * `createGizmo()` when registered, else a generic wireframe placeholder — and
 * stamp its name + `realvirtual` config. Shared by the planner's placement path
 * and the drag-preview build so both produce an identical node.
 */
export async function buildVirtualNode(entry: LibraryCatalogEntry): Promise<Object3D> {
  const gizmoSize = entry.gizmoSize ?? [500, 500, 500] as [number, number, number];
  let node: Object3D | null = null;

  // Prefer the component's own createGizmo() if registered.
  try {
    const { getRegisteredFactories } = await import('../../core/engine/rv-component-registry');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const factory = getRegisteredFactories().get(entry.desType ?? '') as any;
    if (factory && typeof factory.ctor?.createGizmo === 'function') {
      node = factory.ctor.createGizmo(gizmoSize) as Object3D;
    }
  } catch { /* ignore — use fallback */ }

  if (!node) node = createVirtualPlaceholder(gizmoSize, entry.desType);

  node.name = entry.name;
  if (entry.desType) {
    node.userData.realvirtual = { [entry.desType]: entry.desConfig ?? {} };
  }
  addVirtualConventionNodes(node, entry);
  return node;
}

/** Add catalog-declared snap, carrier, and path convention nodes to a virtual root. */
function addVirtualConventionNodes(root: Object3D, entry: LibraryCatalogEntry): void {
  const MM_TO_M = 0.001;
  for (const port of entry.virtualPorts ?? []) {
    const node = new Object3D();
    node.name = `Snap-${port.name}`;
    node.position.fromArray(port.position).multiplyScalar(MM_TO_M);
    root.add(node);
  }

  for (const child of entry.virtualChildren ?? []) {
    const node = new Object3D();
    node.name = child.name;
    node.position.fromArray(child.position).multiplyScalar(MM_TO_M);
    if (child.kind === 'path') {
      const endpoint = child.size ?? [1000, 0, 0];
      node.userData.realvirtual = {
        Path: {
          type: 'Path',
          version: 1,
          segments: [{
            kind: 'line',
            from: [0, 0, 0],
            to: endpoint.map(value => value * MM_TO_M),
          }],
          closed: false,
        },
      };
    }
    root.add(node);
  }
}

/**
 * Create a visible wireframe placeholder for a virtual DES component.
 * The component class can override createGizmo() for custom visuals.
 */
export function createVirtualPlaceholder(gizmoSize: [number, number, number], desType?: string): Group {
  const MM_TO_M = 0.001;
  const [w, h, d] = gizmoSize.map(v => v * MM_TO_M);
  const color = DES_COLORS[desType ?? ''] ?? 0x4fc3f7;

  const group = new Group();
  const geo = new BoxGeometry(w, h, d);
  const edges = new EdgesGeometry(geo);
  const line = new LineSegments(edges, new LineBasicMaterial({ color, linewidth: 1 }));
  line.position.y = h / 2;
  line.frustumCulled = false;
  group.add(line);
  geo.dispose();
  return group;
}
