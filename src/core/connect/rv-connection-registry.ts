// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-registry.ts — the ONE way to reach the snap connection graph
 * (plan-633 Gate R1 #3).
 *
 * Every consumer of snap connections — the DES binding, `material-flow-self`,
 * `rv-sdk-ports`, `snap-graph-helpers`, the Turntable — asks
 * {@link getConnectionRegistry}`(host)`:
 *
 *   - snap-point plugin present → its LIVE registry, unchanged (the planner owns
 *     scanning, pairing and occupancy there);
 *   - no plugin (headless DES, tests, embed) → the registry a binding attached
 *     with {@link attachHeadlessConnectionRegistry}, built PER COMPONENT OWNER
 *     (each instance root owns its snaps, so snaps of different instances can
 *     pair — a scan of the scene root would give every snap the same owner and
 *     pair nothing) and paired in the drives' HOME pose, exactly like the
 *     planner's `rebuildPairings`. It lives as long as the binding
 *     ({@link detachHeadlessConnectionRegistry}).
 *
 * Since Phase 2 every consumer reads through here; a binding obtains its
 * registry with {@link acquireBindingConnectionRegistry} and gives it back with
 * {@link detachHeadlessConnectionRegistry}.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import { SnapPointRegistry, type PlacedComponentId } from '../engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from './snap-scanner';
import { computeProximityPairings, SNAP_PAIR_EPS_M, type RebuildSnapInput } from './snap-pairing';

/** The slice of a viewer/bind host the registry access needs. */
export interface ConnectionRegistryHost {
  getPlugin?(id: string): unknown;
}

/** A drive whose node may carry ports (e.g. a turntable platform): the home
 *  pose is where its snaps were mated, so pairing samples there. */
export interface HomePoseDrive {
  readonly node: Object3D;
  getHomeLocalPosition(out: Vector3): unknown;
  getHomeLocalQuaternion(out: Quaternion): unknown;
}

export interface ProximityPairingOptions {
  /** Max world distance (m) for two snaps to count as mated. Default {@link SNAP_PAIR_EPS_M}. */
  readonly epsilon?: number;
  /** Drives sampled in their home pose (snapshot → home → sample → restore). */
  readonly drives?: readonly HomePoseDrive[];
  /** Roots whose world matrices must be refreshed after moving drives. */
  readonly roots?: readonly Object3D[];
  /** Maps an owner root to the placement id written into `occupiedBy`. */
  readonly placedIdOf?: (root: Object3D) => string | null;
}

const headless = new WeakMap<object, SnapPointRegistry>();

/**
 * The connection registry for `host`: the snap-point plugin's live registry
 * when the plugin exists (even while that registry is still null), otherwise
 * the headless registry attached for the host's binding, otherwise null.
 */
export function getConnectionRegistry(host: ConnectionRegistryHost | null | undefined): SnapPointRegistry | null {
  if (!host) return null;
  const plugin = host.getPlugin?.('snap-point') as { getRegistry?(): SnapPointRegistry | null } | undefined;
  if (plugin) return plugin.getRegistry?.() ?? null;
  return headless.get(host) ?? null;
}

/**
 * Pair every unoccupied, compatible, coincident snap of `registry` — the
 * planner's `rebuildPairings` without a viewer. Ports riding a drive are
 * sampled in the drive's HOME pose (snapshot, move home, sample, restore).
 * Established pairs are never disturbed (occupied snaps do not take part).
 * Returns the number of pairs created.
 */
export function pairRegistryByProximity(
  registry: SnapPointRegistry,
  opts: ProximityPairingOptions = {},
): number {
  const drives = opts.drives ?? [];
  const roots = opts.roots ?? [];
  const restore: { node: Object3D; pos: Vector3; quat: Quaternion }[] = [];
  for (const d of drives) {
    restore.push({ node: d.node, pos: d.node.position.clone(), quat: d.node.quaternion.clone() });
    d.getHomeLocalPosition(d.node.position);
    d.getHomeLocalQuaternion(d.node.quaternion);
  }
  // ONE world-matrix refresh per root before sampling (plan-644 Phase 2.4): a
  // snap under a refreshed root reads its fresh `matrixWorld` directly. Only a
  // snap outside every root (e.g. a detached subtree still registered) keeps
  // its own parent-chain update — so every sampled position is bit-identical
  // to the former per-snap `updateWorldMatrix(true, false)`.
  for (const r of roots) r.updateWorldMatrix(true, true);
  const refreshed = roots.length > 0 ? new Set<Object3D>(roots) : null;

  const wp = new Vector3();
  const inputs: RebuildSnapInput[] = [];
  for (const sp of registry.getAll()) {
    if (sp.occupied) continue;
    if (refreshed && isUnderAny(sp.object3D, refreshed)) {
      wp.setFromMatrixPosition(sp.object3D.matrixWorld);
    } else {
      sp.object3D.updateWorldMatrix(true, false);
      sp.object3D.getWorldPosition(wp);
    }
    inputs.push({ id: sp.id, typeId: sp.typeId, flow: sp.flow, owner: sp.ownerRoot, x: wp.x, y: wp.y, z: wp.z });
  }

  for (const r of restore) {
    r.node.position.copy(r.pos);
    r.node.quaternion.copy(r.quat);
  }
  if (restore.length > 0) for (const r of roots) r.updateWorldMatrix(true, true);

  if (inputs.length < 2) return 0;
  const pairs = computeProximityPairings(inputs, opts.epsilon ?? SNAP_PAIR_EPS_M);
  for (const { aId, bId } of pairs) {
    const a = registry.getById(aId);
    const b = registry.getById(bId);
    if (!a || !b) continue;
    // Each snap is occupied BY the asset on the OPPOSITE side (planner convention).
    const aPlaced = (opts.placedIdOf?.(a.ownerRoot) ?? `snap:${a.id}`) as PlacedComponentId;
    const bPlaced = (opts.placedIdOf?.(b.ownerRoot) ?? `snap:${b.id}`) as PlacedComponentId;
    registry.markOccupied(a.id, bPlaced);
    registry.markOccupied(b.id, aPlaced);
    registry.pair(a.id, b.id);
  }
  return pairs.length;
}

/** `node` is one of `roots` or lies below one of them (parent walk, no matrix work). */
function isUnderAny(node: Object3D, roots: ReadonlySet<Object3D>): boolean {
  for (let n: Object3D | null = node; n; n = n.parent) if (roots.has(n)) return true;
  return false;
}

/**
 * Build a connection registry for a set of component owners: one scan per
 * owner (the owner root becomes `ownerRoot` of its snaps), then the proximity
 * pairing in the drives' home pose. Owners are scanned in the given order —
 * the greedy pairing is order-stable, so a stable owner order gives a stable
 * graph.
 */
export function buildConnectionRegistry(
  owners: readonly Object3D[],
  opts: Omit<ProximityPairingOptions, 'roots'> = {},
): SnapPointRegistry {
  const registry = new SnapPointRegistry();
  for (const owner of owners) scanAndRegisterSnaps(owner, registry, owner);
  pairRegistryByProximity(registry, { ...opts, roots: owners });
  return registry;
}

/**
 * Build the headless registry for `host`'s binding and make it the answer of
 * {@link getConnectionRegistry} while no snap-point plugin exists. Replaces a
 * previously attached one. Returns the built registry.
 */
export function attachHeadlessConnectionRegistry(
  host: ConnectionRegistryHost,
  owners: readonly Object3D[],
  opts: Omit<ProximityPairingOptions, 'roots'> = {},
): SnapPointRegistry {
  const registry = buildConnectionRegistry(owners, opts);
  headless.set(host, registry);
  return registry;
}

/** True when `host` carries the snap-point plugin (planner): its registry is
 *  authoritative and no headless registry may be built for it. */
export function hasSnapPointPlugin(host: ConnectionRegistryHost | null | undefined): boolean {
  return !!host?.getPlugin?.('snap-point');
}

/** What a binding got from {@link acquireBindingConnectionRegistry}. */
export interface BindingConnectionRegistry {
  /** The registry to resolve against (null: plugin present, registry not built yet). */
  readonly registry: SnapPointRegistry | null;
  /** True when the binding built (and owns) a headless registry. */
  readonly headless: boolean;
}

/**
 * The registry a binding resolves its topology against (plan-633 F4):
 *
 *   - snap-point plugin present → its live registry, untouched (planner — no
 *     behaviour change);
 *   - no plugin → a headless registry built PER COMPONENT OWNER (`owners`, the
 *     instance roots) and paired in the drives' home pose, attached to `host`
 *     so `material-flow-self`, `rv-sdk-ports`, the snap-graph helpers and the
 *     Turntable read the SAME graph. It replaces a previously attached one and
 *     lives until {@link detachHeadlessConnectionRegistry}.
 *
 * Owners are scanned deepest-first (stable): a snap inside a nested owner
 * belongs to that owner, never to an enclosing one (registration is idempotent
 * per snap id, so the first scan wins).
 */
export function acquireBindingConnectionRegistry(
  host: ConnectionRegistryHost,
  owners: readonly Object3D[],
  opts: Omit<ProximityPairingOptions, 'roots'> = {},
): BindingConnectionRegistry {
  if (hasSnapPointPlugin(host)) return { registry: getConnectionRegistry(host), headless: false };
  const unique: Object3D[] = [];
  const seen = new Set<Object3D>();
  for (const o of owners) if (!seen.has(o)) { seen.add(o); unique.push(o); }
  const depth = new Map<Object3D, number>();
  for (const o of unique) {
    let d = 0;
    for (let p = o.parent; p; p = p.parent) d++;
    depth.set(o, d);
  }
  const ordered = unique
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (depth.get(b.o)! - depth.get(a.o)!) || (a.i - b.i))
    .map((e) => e.o);
  return { registry: attachHeadlessConnectionRegistry(host, ordered, opts), headless: true };
}

/**
 * Drop the headless registry of `host`'s binding (binding disposed). With
 * `registry` given, only that registry is dropped — a newer binding that
 * attached its own in the meantime keeps it.
 */
export function detachHeadlessConnectionRegistry(
  host: ConnectionRegistryHost,
  registry?: SnapPointRegistry | null,
): void {
  if (registry && headless.get(host) !== registry) return;
  headless.delete(host);
}
