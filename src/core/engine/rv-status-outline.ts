// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-status-outline — the shared BLINKING OUTLINE for status/severity
 * highlighting, rendered by the OutlinePass status channel
 * (RVOutlineManager). This is the same visual as the CAD-import showcase model motor-alarm
 * pulse: a GPU silhouette with `pulsePeriod` breathing.
 *
 * Why proxies: the OutlinePass can only outline meshes the camera actually
 * renders. Statically batched source meshes keep `visible = true` with
 * `layers.mask = 0` (contract-bake-picking.md §1.2) — the camera never draws
 * them, so passing them to the OutlinePass shows nothing. For such nodes
 * this module builds invisible proxy meshes (shared geometry, colorWrite
 * and depthWrite off, on NO_AO_LAYER so they live inside the composer but
 * never reach the AO gbuffer) that the OutlinePass CAN render into its
 * selection mask. The base render pipeline is untouched: proxies draw no
 * pixels, write no depth, cast no shadows, and are excluded from picking.
 *
 * Ownership: the OutlinePass channel has a single style/color, but it may be
 * CLAIMED by several persistent owners at once (runtime-instruction step
 * highlight, collision, drop detection). Claims asking for the same style are
 * UNIONED; a claim asking for a different style is hidden by the youngest one
 * and says so once (plan-2022 Phase 0 — before that register, a second owner
 * silently erased the first). On top sits a transient interrupt (severity
 * pulse) which restores the claim union when it ends.
 */

import { Mesh, MeshBasicMaterial, Group } from 'three';
import type { Object3D, Scene } from 'three';
import type { OutlineStyle, RVOutlineManager } from './rv-outline-manager';
import { ATTENTION_OUTLINE_GEOMETRY } from './rv-outline-manager';
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

/** The standard alarm-outline style: the crisp selection-outline geometry
 *  (ATTENTION_OUTLINE_GEOMETRY) in the status color, distinguished from a
 *  selection by color and pulse alone. `pulsePeriod` in seconds; 0 = static
 *  outline. */
export function makeStatusOutlineStyle(color: number, pulsePeriod: number): OutlineStyle {
  return {
    visibleEdgeColor: color,
    hiddenEdgeColor: darkenColor(color, 0.55),
    ...ATTENTION_OUTLINE_GEOMETRY,
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

/**
 * The CLAIM REGISTER of the persistent status channel (plan-2022 Phase 0).
 *
 * Before this there was a single `_persistent` slot, and a second persistent
 * caller silently THREW AWAY the first one: a runtime-instruction step
 * highlight erased a standing collision outline, and vice versa. Both of them
 * ask for the very same thing — "look here, something is wrong" — so the fix is
 * a register whose entries are UNIONED when they want the same style.
 *
 * Insertion order is age (a `Map.set` on an existing key keeps its position, so
 * a re-show by the same owner does not make it the youngest — a collision that
 * re-publishes its root set every tick must not keep stealing the style).
 */
const _claims = new Map<string, OutlineRequest>();
/** A transient interrupt (severity pulse) shown on top of / instead of the
 *  claims; the claims are re-applied when it clears. */
let _transient: OutlineRequest | null = null;
/** Warn-once keys (`loser>winner`) for the style-conflict message. */
const _warnedConflicts = new Set<string>();

/** Apply ONE request alone (the transient pulse). */
function apply(host: StatusOutlineHost, req: OutlineRequest): void {
  req.disposeProxies?.();
  const { targets, dispose } = resolveOutlineTargets(host.scene, req.nodes);
  req.disposeProxies = dispose;
  host.outlineManager.setStatusStyle(makeStatusOutlineStyle(req.color, req.pulsePeriod));
  host.outlineManager.setStatusOutlined(targets);
}

/**
 * Apply the claim register: the youngest claim defines the style, and every
 * claim with the SAME `(color, pulsePeriod)` contributes its nodes to one
 * union. A claim with a different style loses — the OutlinePass status channel
 * has exactly one style (`rv-outline-manager.ts`), so there is nothing to mix —
 * but it loses LOUDLY: one `console.warn` per pairing instead of the silent
 * eviction this register replaces. Its proxies are dropped while it is out and
 * rebuilt if it becomes the youngest later.
 */
function applyClaims(host: StatusOutlineHost): void {
  if (_claims.size === 0) {
    host.outlineManager.clearStatus();
    return;
  }
  const list = [..._claims.values()];
  const style = list[list.length - 1];
  const union: Object3D[] = [];
  for (const claim of list) {
    if (claim !== style && (claim.color !== style.color || claim.pulsePeriod !== style.pulsePeriod)) {
      const key = `${claim.ownerKey}>${style.ownerKey}`;
      if (!_warnedConflicts.has(key)) {
        _warnedConflicts.add(key);
        console.warn(
          `[status-outline] claim "${claim.ownerKey}" is hidden by "${style.ownerKey}": the status channel `
          + 'carries one style and these two ask for different ones '
          + `(0x${claim.color.toString(16)}/${claim.pulsePeriod}s vs 0x${style.color.toString(16)}/${style.pulsePeriod}s).`,
        );
      }
      claim.disposeProxies?.();
      claim.disposeProxies = null;
      continue;
    }
    claim.disposeProxies?.();
    const { targets, dispose } = resolveOutlineTargets(host.scene, claim.nodes);
    claim.disposeProxies = dispose;
    for (const t of targets) if (!union.includes(t)) union.push(t);
  }
  host.outlineManager.setStatusStyle(makeStatusOutlineStyle(style.color, style.pulsePeriod));
  host.outlineManager.setStatusOutlined(union);
}

/**
 * Show the status outline (OutlinePass status channel) on `nodes` in `color`.
 * `pulsePeriod` seconds per blink cycle (0 = static).
 *
 * Re-invoking with the same ownerKey replaces that owner's claim. SEVERAL
 * persistent owners may hold the channel at once: claims asking for the same
 * style are unioned, a claim asking for a different style is hidden by the
 * youngest one (with a warning). `transient: true` marks a short-lived
 * interrupt (severity pulse) — the claim union is restored by hideStatusOutline.
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
    apply(host, req);
    return;
  }
  // Hand the previous claim's proxies over: the new request rebuilds them.
  _claims.get(req.ownerKey)?.disposeProxies?.();
  _claims.set(req.ownerKey, req);
  if (_transient) return; // transient pulse stays on top; applied on its hide
  applyClaims(host);
}

/**
 * Hide the status outline owned by `ownerKey`. When a transient pulse ends the
 * remaining claims are re-applied (fresh proxies — node transforms may have
 * changed); taking one claim out of three disposes exactly that claim's proxies
 * and leaves the others standing. Unknown owners are a no-op, so stale timeouts
 * can't clear a newer outline.
 */
export function hideStatusOutline(host: StatusOutlineHost, ownerKey: string): void {
  if (_transient?.ownerKey === ownerKey) {
    _transient.disposeProxies?.();
    _transient = null;
    applyClaims(host);
    return;
  }
  const claim = _claims.get(ownerKey);
  if (!claim) return;
  claim.disposeProxies?.();
  _claims.delete(ownerKey);
  if (!_transient) applyClaims(host);
}

/** Owner keys currently holding a persistent claim, oldest first (diagnostics/tests). */
export function statusOutlineClaimOwners(): readonly string[] {
  return [..._claims.keys()];
}

/** Full reset (model unload) — drops every claim, the pulse and all proxies. */
export function clearAllStatusOutlines(host: StatusOutlineHost): void {
  _transient?.disposeProxies?.();
  _transient = null;
  for (const claim of _claims.values()) claim.disposeProxies?.();
  _claims.clear();
  _warnedConflicts.clear();
  host.outlineManager.clearStatus();
}
