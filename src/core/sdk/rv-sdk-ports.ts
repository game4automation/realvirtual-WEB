// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-ports.ts — snap-graph PORTS backend for script components
 * (plan-210 §9 phase 1b).
 *
 * `createSnapGraphPortsBackend()` resolves the SAME topology the native TS
 * behaviors see: direction-classified connections via `classifyConnections`
 * (routers / bidi ports) folded with the single-successor `findOutputPairings`
 * (plain conveyors) — a 1:1 mirror of `resolvePorts()` in
 * material-flow-self.ts, but value-typed against an `SdkSignalAccess` slice
 * instead of an `RVBindContext`.
 *
 * The interlock reads/writes carry the shared per-port-then-root
 * `Flow.Occupied` convention (transport-links.ts SSOT helpers):
 *   - `occupied()`   — partner per-port `<root>.Flow.Occupied@<partnerSnapId>`
 *                      when declared, else the partner root signal. Exactly the
 *                      read the Turntable's `freeOutputs` does (essential
 *                      against a downstream router that is root-busy but opens
 *                      one port).
 *   - `upstreamWaiting()` — partner ROOT occupied (a part waits upstream).
 *   - `setOccupied(v)`    — MY per-port `Flow.Occupied@<mySnapId>`.
 *
 * Signal names: `flowOccupiedRootSignal()` returns the `/`-prefixed
 * already-qualified symbol; the scoped behavior store strips that prefix. The
 * SDK signal slice is the UNSCOPED store surface, so the leading `/` is
 * stripped here before reading/writing.
 */

import type { Object3D } from 'three';
import {
  classifyConnections,
  findOutputPairings,
} from '../../behaviors/_shared/snap-graph-helpers';
import {
  FLOW_OCCUPIED,
  flowOccupiedRootSignal,
} from '../../behaviors/_shared/transport-links';
import type { SdkPortTarget, SdkSignalAccess } from './rv-sdk-self';

export interface SnapGraphPortsOptions {
  /** The snap host (RVViewer or any `getPlugin('snap-point')` provider). */
  viewer: unknown;
  /** This component's LayoutObject root. */
  root: Object3D;
  /** Signal slice carrying the `Flow.Occupied` interlock convention. */
  signals: SdkSignalAccess;
}

/** Strip the leading `/` "already-qualified" marker for the unscoped store. */
function unscoped(name: string): string {
  return name.startsWith('/') ? name.slice(1) : name;
}

interface SnapHostShape {
  getPlugin?(id: string): unknown;
  registry?: unknown;
}

/**
 * Build the `SdkEnvironment.ports` backend: every call re-resolves the
 * current snap-graph (the graph mutates as assets are placed — same laziness
 * as `MaterialFlowSelf.ports`). Returns `[]` when the snap-point plugin is
 * unavailable (headless / minimal hosts).
 */
export function createSnapGraphPortsBackend(opts: SnapGraphPortsOptions): () => SdkPortTarget[] {
  const host = opts.viewer as SnapHostShape;
  const { root, signals } = opts;

  const makeTarget = (
    id: string,
    role: 'input' | 'output',
    mySnapId: string,
    snapNode: Object3D | null,
    partnerRoot: Object3D,
  ): SdkPortTarget => {
    const partnerRootSig = unscoped(flowOccupiedRootSignal(partnerRoot.name));
    return {
      id,
      role,
      node: snapNode,
      partnerNode: partnerRoot,
      occupied(): boolean {
        // Per-port-then-root (transport-links convention — see module doc).
        const perPort = `${partnerRootSig}@${id}`;
        const name = signals.get(perPort) !== undefined ? perPort : partnerRootSig;
        return signals.get(name) === true;
      },
      upstreamWaiting(): boolean {
        return signals.get(partnerRootSig) === true;
      },
      setOccupied(v: boolean): void {
        signals.set(`${FLOW_OCCUPIED}@${mySnapId}`, v);
      },
    };
  };

  return (): SdkPortTarget[] => {
    const out: SdkPortTarget[] = [];
    const seen = new Set<string>();

    // 1. Direction-classified connections (routers + bidirectional ports).
    for (const c of classifyConnections(host, root)) {
      if (seen.has(c.pairedSnap.id)) continue;
      seen.add(c.pairedSnap.id);
      out.push(makeTarget(c.pairedSnap.id, c.role, c.snap.id, c.snap.object3D, c.ownerRoot));
    }

    // 2. Single-successor output pairings not already covered (plain conveyors).
    for (const pr of findOutputPairings(host, root)) {
      if (seen.has(pr.pairedSnap.id)) continue;
      seen.add(pr.pairedSnap.id);
      out.push(makeTarget(pr.pairedSnap.id, 'output', pr.snap.id, pr.snap.object3D, pr.ownerRoot));
    }

    return out;
  };
}
