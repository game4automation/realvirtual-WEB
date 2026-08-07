// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SceneFacadeImpl — read-only scene queries + screen projection for plugins.
 *
 * Delegates to RVViewer internals. The facade lives below the public RVViewer
 * API and is not part of the plugin-facing contract directly; plugins reach it
 * via PluginContext.scene.
 *
 * Phase 4a of plan-182.
 *
 * NOTE on forEachNode parameter order: NodeRegistry.forEachNode() uses
 * (path, node) order, but SceneFacade.eachNode() exposes (node, path)
 * order (matching Three.js traverse conventions). The adapter swaps them.
 */

import { Vector2, Vector3, Object3D } from 'three';
import type { SceneFacade } from '../rv-plugin-context';
import type { RVViewer } from '../rv-viewer';
import { ndcToScreen, type ScreenRect } from '../engine/rv-ndc';

export class SceneFacadeImpl implements SceneFacade {
  // Pre-allocated temp vectors — GC-free hot path.
  private _tmpScreen = new Vector2();
  private _tmpV3 = new Vector3();
  private _tmpRect: ScreenRect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(private readonly _viewer: RVViewer) {}

  eachNode(fn: (node: Object3D, path: string) => void): void {
    const reg = this._viewer.registry;
    if (!reg) return;
    // NodeRegistry.forEachNode uses (path, node) order — adapt to our (node, path) signature.
    reg.forEachNode((path, node) => fn(node, path));
  }

  projectToScreen(node: Object3D, out?: Vector2): Vector2 | null {
    if (!node) return null;
    // Use node world position
    node.getWorldPosition(this._tmpV3);
    return this.projectPoint(this._tmpV3, out);
  }

  projectPoint(worldPoint: Vector3, out?: Vector2): Vector2 | null {
    const cam = this._viewer.camera;
    const renderer = this._viewer.renderer;
    if (!cam || !renderer) return null;
    const target = out ?? this._tmpScreen;
    const dom = (renderer as { domElement?: HTMLCanvasElement }).domElement;
    if (!dom) return null;
    // Project: world -> NDC
    const ndc = this._tmpV3.copy(worldPoint).project(cam);
    if (ndc.z < -1 || ndc.z > 1) return null;  // behind camera or beyond far plane
    this._tmpRect.width = dom.clientWidth;
    this._tmpRect.height = dom.clientHeight;
    ndcToScreen(ndc.x, ndc.y, this._tmpRect, target);
    return target;
  }

  highlightByPath(path: string, tracked = false): void {
    this._viewer.highlightByPath(path, tracked);
  }

  clearHighlight(): void {
    this._viewer.clearHighlight();
  }
}
