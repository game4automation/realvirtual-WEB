// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ComponentEventDispatcher — routes RVViewer-level raycast/selection events to
 * per-component callbacks (onHover/onClick/onSelect).
 *
 * Event-name mapping (verified against rv-viewer.ts):
 * - Subscribes to 'object-clicked' (NOT 'object-click' — declared but never emitted).
 * - SelectionSnapshot uses `selectedPaths: string[]` + `primaryPath` — we resolve
 *   paths via NodeRegistry to obtain Object3D instances.
 * - All viewer listeners return unsubscribe functions; stored for dispose().
 * - All callback invocations wrapped in try/catch to isolate faulty components.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../rv-viewer';
import type { SelectionSnapshot } from './rv-selection-manager';
import type { NodeRegistry } from './rv-node-registry';
import type { ObjectHoverData, ObjectUnhoverData } from './rv-raycast-manager';
import type { RVComponent } from './rv-component-registry';

const MAX_PARENT_DEPTH = 32;

export class ComponentEventDispatcher {
  private _lastHoveredNode: Object3D | null = null;
  /** Nodes currently in selection — used to detect deselection. */
  private _selectedNodes = new Set<Object3D>();
  private _unsubs: Array<() => void> = [];

  constructor(private viewer: RVViewer, private registry: NodeRegistry) {
    this._unsubs.push(
      viewer.on('object-hover', (data) => this._dispatchHover((data as ObjectHoverData | null)?.node ?? null, data as ObjectHoverData | null)),
      viewer.on('object-unhover', (data) => this._dispatchHover(null, null, data as ObjectUnhoverData | undefined)),
      viewer.on('object-clicked', (data) => this._dispatchClick((data as { path: string; node: Object3D }).node, data as { path: string; node: Object3D })),
      viewer.on('selection-changed', (snap) => this._dispatchSelect(snap as SelectionSnapshot)),
    );
  }

  private _dispatchHover(
    node: Object3D | null,
    data: ObjectHoverData | null,
    _unhoverData?: ObjectUnhoverData,
  ): void {
    // If new hover target equals last → no-op (avoids double-fires from
    // object-hover:null + object-unhover).
    if (node === this._lastHoveredNode) return;

    if (this._lastHoveredNode) {
      const prev = this._findComponent(this._lastHoveredNode);
      this._safeCall(() => prev?.onHover?.(false));
    }
    if (node) {
      const comp = this._findComponent(node);
      this._safeCall(() => comp?.onHover?.(true, data ?? undefined));
    }
    this._lastHoveredNode = node;
  }

  private _dispatchClick(node: Object3D, data: { path: string; node: Object3D }): void {
    const comp = this._findComponent(node);
    this._safeCall(() => comp?.onClick?.(data));
  }

  private _dispatchSelect(snap: SelectionSnapshot): void {
    const newSelected = new Set<Object3D>();
    const paths = snap?.selectedPaths ?? [];
    for (const path of paths) {
      const n = this.registry.getNode(path);
      if (n) newSelected.add(n);
    }

    // Newly selected
    for (const node of newSelected) {
      if (!this._selectedNodes.has(node)) {
        const comp = this._findComponent(node);
        this._safeCall(() => comp?.onSelect?.(true));
      }
    }
    // Deselected
    for (const node of this._selectedNodes) {
      if (!newSelected.has(node)) {
        const comp = this._findComponent(node);
        this._safeCall(() => comp?.onSelect?.(false));
      }
    }
    this._selectedNodes = newSelected;
  }

  private _findComponent(node: Object3D): RVComponent | null {
    let n: Object3D | null = node;
    let depth = 0;
    while (n && depth < MAX_PARENT_DEPTH) {
      const inst = n.userData?._rvComponentInstance as RVComponent | undefined;
      if (inst) return inst;
      n = n.parent;
      depth++;
    }
    return null;
  }

  private _safeCall(fn: () => void): void {
    try { fn(); } catch (e) { console.error('[ComponentEventDispatcher] callback threw:', e); }
  }

  dispose(): void {
    for (const u of this._unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    this._selectedNodes.clear();
    this._lastHoveredNode = null;
  }
}
