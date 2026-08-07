// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-status-outline — the shared BLINKING OUTLINE for status/severity
 * highlighting, rendered by the OutlinePass status channel
 * (RVOutlineManager). This is the same visual as the Toray motor-alarm
 * pulse: a GPU silhouette with `pulsePeriod` breathing.
 *
 * Why proxies: the OutlinePass can only outline meshes the camera actually
 * renders. Statically batched source meshes keep `visible = true` with
 * `layers.mask = 0` (doc-render-picking.md §1.2) — the camera never draws
 * them, so passing them to the OutlinePass shows nothing. For such nodes
 * this module builds invisible proxy meshes (shared geometry, colorWrite
 * and depthWrite off, on NO_AO_LAYER so they live inside the composer but
 * never reach the AO gbuffer) that the OutlinePass CAN render into its
 * selection mask. The base render pipeline is untouched: proxies draw no
 * pixels, write no depth, cast no shadows, and are excluded from picking.
 *
 * Ownership: there is ONE status outline at a time (the OutlinePass channel
 * has a single style/color). `showStatusOutline` supports a persistent
 * owner (runtime-instruction step highlight) plus a transient interrupt
 * (severity pulse) that restores the persistent outline when it ends.
 */

import { Mesh, MeshBasicMaterial, Group } from 'three';
import type { Object3D, Scene } from 'three';
import type { OutlineStyle, RVOutlineManager } from './rv-outline-manager';
import { NO_AO_LAYER } from './rv-constants';

// ─── Host surface ────────────────────────────────────────────────────────

/** Minimal viewer surface needed (RVViewer satisfies it). */
export interface StatusOutlineHost {
  readonly scene: Scene;
  readonly outlineManager: RVOutlineManager;
}

// ─── Rendered-mesh probe ─────────────────────────────────────────────────

/** True when the subtree contains at least one mesh the camera actually
 *  renders — the OutlinePass precondition (mirrors isRenderedMesh in
 *  rv-highlight-manager.ts). Batched source meshes (layers.mask = 0) don't
 *  count. */
export function hasRenderedMesh(node: Object3D): boolean {
  let found = false;
  node.traverse((obj) => {
    if (found) return;
    if ((obj as Mesh).isMesh && obj.visible && obj.layers.mask !== 0) found = true;
  });
  return found;
}

// ─── Outline proxies for batched geometry ────────────────────────────────

/** One fully invisible material shared by every proxy mesh: draws no color,
 *  writes no depth — its only job is to exist for the OutlinePass mask pass
 *  (which replaces it with an override material anyway). */
const PROXY_MATERIAL = new MeshBasicMaterial({ colorWrite: false, depthWrite: false });

/** Defensive cap — instruction targets are single parts; anything beyond this
 *  is a mis-authored target on a huge assembly. */
const MAX_PROXY_MESHES = 1000;

/** Resolve OutlinePass-compatible targets for `nodes`: rendered subtrees pass
 *  through unchanged; batched subtrees get an invisible proxy group added to
 *  the scene. Call `dispose()` to remove all proxies (shared geometry and the
 *  shared material are never disposed). */
export function resolveOutlineTargets(
  scene: Scene,
  nodes: readonly Object3D[],
): { targets: Object3D[]; dispose: () => void } {
  const targets: Object3D[] = [];
  const proxyGroups: Group[] = [];

  for (const node of nodes) {
    if (hasRenderedMesh(node)) {
      targets.push(node);
      continue;
    }
    const group = new Group();
    group.name = `__statusOutlineProxy_${node.name}`;
    let count = 0;
    node.traverse((obj) => {
      if (count >= MAX_PROXY_MESHES) return;
      const src = obj as Mesh;
      if (!src.isMesh || !src.geometry) return;
      src.updateWorldMatrix(true, false);
      const proxy = new Mesh(src.geometry, PROXY_MATERIAL);
      proxy.matrixAutoUpdate = false;
      proxy.matrix.copy(src.matrixWorld);
      proxy.layers.set(NO_AO_LAYER);
      proxy.castShadow = false;
      proxy.receiveShadow = false;
      proxy.raycast = () => {};
      proxy.userData._highlightOverlay = true;
      group.add(proxy);
      count++;
    });
    if (group.children.length === 0) continue; // nothing outlineable
    scene.add(group);
    proxyGroups.push(group);
    targets.push(group);
  }

  return {
    targets,
    dispose: () => {
      for (const g of proxyGroups) g.parent?.remove(g);
      proxyGroups.length = 0;
    },
  };
}

// ─── Style ───────────────────────────────────────────────────────────────

/** Darkened variant used for the through-geometry (hidden) edge. */
export function darkenColor(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** The standard alarm-outline style (identical parameters to the Toray
 *  severity pulse). `pulsePeriod` in seconds; 0 = static outline. */
export function makeStatusOutlineStyle(color: number, pulsePeriod: number): OutlineStyle {
  return {
    visibleEdgeColor: color,
    hiddenEdgeColor: darkenColor(color, 0.55),
    edgeStrength: 20,
    edgeThickness: 10,
    edgeGlow: 1.5,
    pulsePeriod,
  };
}

// ─── Show / hide with owner tracking ─────────────────────────────────────

interface OutlineRequest {
  ownerKey: string;
  nodes: Object3D[];
  color: number;
  pulsePeriod: number;
  disposeProxies: (() => void) | null;
}

/** The persistent outline (runtime-instruction step highlight). */
let _persistent: OutlineRequest | null = null;
/** A transient interrupt (severity pulse) shown on top of / instead of the
 *  persistent outline; the persistent one is re-applied when it clears. */
let _transient: OutlineRequest | null = null;

function apply(host: StatusOutlineHost, req: OutlineRequest): void {
  req.disposeProxies?.();
  const { targets, dispose } = resolveOutlineTargets(host.scene, req.nodes);
  req.disposeProxies = dispose;
  host.outlineManager.setStatusStyle(makeStatusOutlineStyle(req.color, req.pulsePeriod));
  host.outlineManager.setStatusOutlined(targets);
}

/**
 * Show the status outline (OutlinePass status channel) on `nodes` in `color`.
 * `pulsePeriod` seconds per blink cycle (0 = static). Re-invoking with the
 * same ownerKey replaces the outline; a different persistent owner takes the
 * channel over. `transient: true` marks a short-lived interrupt (severity
 * pulse) — the previous persistent outline is restored by hideStatusOutline.
 */
export function showStatusOutline(
  host: StatusOutlineHost,
  nodes: readonly Object3D[],
  color: number,
  opts: { ownerKey: string; pulsePeriod?: number; transient?: boolean },
): void {
  if (nodes.length === 0) return;
  const req: OutlineRequest = {
    ownerKey: opts.ownerKey,
    nodes: [...nodes],
    color,
    pulsePeriod: opts.pulsePeriod ?? 0,
    disposeProxies: null,
  };
  if (opts.transient) {
    _transient?.disposeProxies?.();
    _transient = req;
  } else {
    if (_persistent && _persistent.ownerKey !== req.ownerKey) _persistent.disposeProxies?.();
    else _persistent?.disposeProxies?.();
    _persistent = req;
    if (_transient) return; // transient pulse stays on top; applied on its hide
  }
  apply(host, req);
}

/**
 * Hide the status outline owned by `ownerKey`. When a transient pulse ends
 * and a persistent outline is still registered, the persistent outline is
 * re-applied (fresh proxies — node transforms may have changed). Unknown
 * owners are a no-op, so stale timeouts can't clear a newer outline.
 */
export function hideStatusOutline(host: StatusOutlineHost, ownerKey: string): void {
  if (_transient?.ownerKey === ownerKey) {
    _transient.disposeProxies?.();
    _transient = null;
    if (_persistent) {
      apply(host, _persistent);
    } else {
      host.outlineManager.clearStatus();
    }
    return;
  }
  if (_persistent?.ownerKey === ownerKey) {
    _persistent.disposeProxies?.();
    _persistent = null;
    if (!_transient) host.outlineManager.clearStatus();
  }
}

/** Full reset (model unload) — drops both outlines and all proxies. */
export function clearAllStatusOutlines(host: StatusOutlineHost): void {
  _transient?.disposeProxies?.();
  _transient = null;
  _persistent?.disposeProxies?.();
  _persistent = null;
  host.outlineManager.clearStatus();
}
