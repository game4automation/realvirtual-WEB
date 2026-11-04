// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logical-connections.ts (PRIVATE) -- typed automatic neighbour connections for
 * the DES runner (plan-225), since plan-633 Phase 2 a THIN ADAPTER over the
 * public connection core (`src/core/connect/rv-connection-resolver.ts`).
 *
 * The algorithm (typed compatibility, emitter → acceptor, source centre → world
 * AABB, nearest within radius, uuid tie-break) lives in the core resolver's
 * distance stage; `autoConnectByDistance` only maps DES instances onto the
 * structural `Connectable` facade and APPLIES the returned links to the native
 * `nextComponents` / `previousComponents` (additive, bidirectional). It has NO
 * production caller today: the DES scene binding resolves its whole topology
 * through the core (`wireTopology` in `des-scene-binding.ts`). It stays as a
 * public API for project code and tests (plan-644 D2 — kept although unused).
 *
 * `breakTwoCycles` stays here as the binding's GUARD: the resolver settles snap
 * 2-cycles at classification (Gate R2-3), so on a resolved graph it must break 0
 * links. `detectCycles` is unchanged (warning-only cycle report, F8).
 *
 * PRIVATE: imports the private `DESComponent` type.
 */

import type { Object3D } from 'three';
import { stableNodeOrderKey } from '../../core/engine/rv-decode-identity';
import type { DESComponent } from './rv-des-component';
import {
  resolveConnectionsDetailed,
  type Connectable,
} from '../../core/connect/rv-connection-resolver';

/** Port role on a typed connection (mirrors snap flow N/P/B). */
export type ConnectionRole = 'out' | 'in' | 'bidi';

/**
 * One connectable instance the resolver reasons about. `kind` is the material-
 * flow kind (source/conveyor/sink/router/…); `connectionType` (+ optional
 * `subType`) gate compatibility.
 */
export interface ConnectableInstance {
  readonly root: Object3D;
  readonly adapter: DESComponent;
  readonly kind: string;
  readonly connectionType: string;
  readonly subType?: string;
}

export interface AutoConnectOptions {
  /**
   * Max source-centre→candidate-box distance in metres. When omitted/0, each
   * source's own `adapter.autoConnect.maxDistance` is used (falling back to 1.0).
   */
  maxDistance?: number;
}

/** Stable order by uuid for deterministic matching. */
function byUuid(a: ConnectableInstance, b: ConnectableInstance): number {
  // Occurrence-qualified identity chain first: uuid is random per load (plan-2059 O3).
  const ka = stableNodeOrderKey(a.root), kb = stableNodeOrderKey(b.root);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.root.uuid < b.root.uuid ? -1 : a.root.uuid > b.root.uuid ? 1 : 0;
}

/**
 * Auto-connect typed neighbours by world distance, for instances that have NO
 * downstream yet. Bidirectional + additive (snap/manual links preserved). For
 * each emitting instance picks the single nearest type-compatible accepting
 * instance within range (source-centre → candidate world-AABB) — no self-loop,
 * no fan-out (one source → one target; merges are allowed). Returns the number
 * of links created.
 *
 * Thin adapter: the decision is the core resolver's distance stage (no snap
 * registry). The geometry is read from `adapter.node` (as before plan-633).
 */
export function autoConnectByDistance(
  instances: ConnectableInstance[],
  opts?: AutoConnectOptions,
): number {
  const byNode = new Map<Object3D, ConnectableInstance>();
  const connectables: Connectable[] = instances.map(i => {
    byNode.set(i.adapter.node, i);
    return {
      root: i.adapter.node,
      kind: i.kind,
      connectionType: i.connectionType,
      subType: i.subType,
      autoConnect: i.adapter.autoConnect,
      existingNext: i.adapter.nextComponents.length > 0
        ? i.adapter.nextComponents.map(c => c.node)
        : undefined,
    };
  });
  const { links } = resolveConnectionsDetailed(connectables, {
    registry: null,
    maxDistance: opts?.maxDistance,
  });
  let created = 0;
  for (const link of links) {
    const from = byNode.get(link.from);
    const to = byNode.get(link.to);
    if (!from || !to) continue;
    from.adapter.nextComponents.push(to.adapter);
    if (!to.adapter.previousComponents.includes(from.adapter)) {
      to.adapter.previousComponents.push(from.adapter);
    }
    created++;
  }
  return created;
}

/**
 * Rebuild `previousComponents` by inverting `nextComponents` across all
 * components (cleared first; array order). Moved here from the removed
 * `rv-des-connection.ts`.
 */
export function computePreviousComponents(components: DESComponent[]): void {
  for (const comp of components) comp.previousComponents = [];
  for (const comp of components) {
    for (const next of comp.nextComponents) {
      if (!next.previousComponents.includes(comp)) next.previousComponents.push(comp);
    }
  }
}

/**
 * Break BIDIRECTIONAL 2-cycles (A→B AND B→A) in the wired `nextComponents`
 * graph (plan-225). These are almost always a snap-classification artefact, NOT
 * a real reversing link: the snap-graph classifies a conveyor↔turntable link
 * statically (authored `Snap-ZP` flow = 'out') while the turntable classifies
 * the SAME link via its refined transport-direction. When the static side is
 * wrong, the conveyor ends up with the turntable as an OUTPUT as well — so the
 * conveyor has e.g. 2 outputs / 0 inputs and the turntable and conveyor point at
 * each other, deadlocking the DES loop the moment both fill (ZPA back-pressure).
 *
 * Resolution: for each unordered pair {A,B} that points both ways, drop the link
 * FROM the over-subscribed endpoint (more `nextComponents`) — a straight
 * conveyor has exactly one successor, so its extra output is the mis-classified
 * input. Ties (both 1) break by uuid for determinism and keep ONE direction
 * (a genuine 2-node reversing loop, rare, still resolves to a single sense).
 * Bidirectional bookkeeping is kept consistent (`previousComponents` updated).
 * Returns the number of links removed.
 */
export function breakTwoCycles(instances: ConnectableInstance[]): number {
  const sorted = [...instances].sort(byUuid);
  let removed = 0;

  const unlink = (from: ConnectableInstance, to: ConnectableInstance): void => {
    const ni = from.adapter.nextComponents.indexOf(to.adapter);
    if (ni >= 0) from.adapter.nextComponents.splice(ni, 1);
    const pi = to.adapter.previousComponents.indexOf(from.adapter);
    if (pi >= 0) to.adapter.previousComponents.splice(pi, 1);
  };

  const byAdapter = new Map<DESComponent, ConnectableInstance>();
  for (const i of sorted) byAdapter.set(i.adapter, i);

  for (const a of sorted) {
    // Snapshot — we mutate nextComponents while iterating pairs.
    for (const bAdapter of [...a.adapter.nextComponents]) {
      const b = byAdapter.get(bAdapter);
      if (!b) continue;
      // Process each unordered pair once.
      if (byUuid(b, a) <= 0) continue;
      const aToB = a.adapter.nextComponents.includes(b.adapter);
      const bToA = b.adapter.nextComponents.includes(a.adapter);
      if (!aToB || !bToA) continue; // not a 2-cycle

      // Drop from the over-subscribed endpoint; tie-break by uuid (a < b here).
      const aOut = a.adapter.nextComponents.length;
      const bOut = b.adapter.nextComponents.length;
      if (aOut > bOut) unlink(a, b);
      else if (bOut > aOut) unlink(b, a);
      else unlink(b, a); // tie → keep a→b (a has the smaller uuid)
      removed++;
    }
  }
  return removed;
}

/**
 * DFS cycle detection over the `nextComponents` graph (plan-225 F8). Returns the
 * roots that participate in at least one cycle (warning only — a closed conveyor
 * loop is a legitimate design, so callers log rather than abort).
 */
export function detectCycles(instances: ConnectableInstance[]): Object3D[] {
  const byAdapter = new Map<DESComponent, ConnectableInstance>();
  for (const i of instances) byAdapter.set(i.adapter, i);

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<DESComponent, number>();
  const inCycle = new Set<DESComponent>();

  const visit = (a: DESComponent, stack: DESComponent[]): void => {
    color.set(a, GRAY);
    stack.push(a);
    for (const next of a.nextComponents) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const idx = stack.indexOf(next);
        if (idx >= 0) for (let k = idx; k < stack.length; k++) inCycle.add(stack[k]);
      } else if (c === WHITE && byAdapter.has(next)) {
        visit(next, stack);
      }
    }
    stack.pop();
    color.set(a, BLACK);
  };

  for (const i of instances) {
    if ((color.get(i.adapter) ?? WHITE) === WHITE) visit(i.adapter, []);
  }

  const roots: Object3D[] = [];
  for (const i of instances) if (inCycle.has(i.adapter)) roots.push(i.root);
  return roots;
}
