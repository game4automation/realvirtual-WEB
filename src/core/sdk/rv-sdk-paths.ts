// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-paths.ts — path-graph PATHS backend + routing registration backend
 * for script components (plan-268 Phase 6, the by-id analogue of the ports
 * backend in rv-sdk-ports.ts).
 *
 * `createPathNetworkPathsBackend()` value-types the SAME graph the native TS
 * behaviors ride (`RVPathNetwork` + `ZoneRegistry`): every query builds fresh
 * plain-JSON descriptors ({@link SdkPathDesc}) — no `RVPath` host object ever
 * crosses the QuickJS boundary (plan-268 §2.4 S1). Descriptor lengths are in
 * MILLIMETERS (drive parity — the same unit as `Agv.Position`/`TargetSpeed`);
 * the engine-internal meters never leak into the script surface.
 *
 * Zone claim/release go straight to the shared `ZoneRegistry` — the EXACT
 * calls the Agv's traffic control uses (a script reserving a station/charging
 * bay participates in the same mutual exclusion). Holder-id defaulting (own
 * component path) happens in the bridge, not here.
 *
 * `createPathNetworkRoutingBackend()` is the registration seam the
 * web-component registry uses when a script declares `routing.*` handlers:
 * it installs the host-side router (built from synchronous `callHandler`
 * dispatches) as the network's project router. Per-traveler TS hooks keep
 * precedence; without any router the default stays `successors[0]` —
 * allocation-free, existing behavior untouched.
 */

import { getDefaultPathNetwork, type RVPathNetwork } from '../engine/rv-path-network';
import { getDefaultZoneRegistry, type ZoneRegistry } from '../engine/rv-zone-registry';
import type { SdkPathDesc, SdkPathsBackend, SdkRoutingBackend } from './rv-sdk-self';
import type { RVPath } from '../engine/rv-path';

/** Meters (engine) → millimeters (script surface, drive parity). */
const M_TO_MM = 1000;

function toDesc(p: RVPath): SdkPathDesc {
  return {
    id: p.id,
    length: p.length * M_TO_MM,
    closed: p.closed,
    successorIds: p.successors.map((s) => s.id),
    predecessorIds: p.predecessors.map((s) => s.id),
    zone: p.zoneId,
    zoneCapacity: p.zoneCapacity,
  };
}

export interface PathNetworkPathsBackendOptions {
  /** Path graph to expose (default: the shared engine network). */
  network?: RVPathNetwork;
  /** Zone registry for claim/release (default: the shared engine registry). */
  zones?: ZoneRegistry;
}

/**
 * Build the `SdkEnvironment.paths` backend over a path network + zone
 * registry. Queries resolve the graph lazily (idempotent) and build fresh
 * descriptors per call — the graph mutates as models load/unload.
 */
export function createPathNetworkPathsBackend(
  opts: PathNetworkPathsBackendOptions = {},
): SdkPathsBackend {
  const network = opts.network ?? getDefaultPathNetwork();
  const zones = opts.zones ?? getDefaultZoneRegistry();
  return {
    list(): SdkPathDesc[] {
      network.resolveGraph();
      return network.all().map(toDesc);
    },
    get(id: string): SdkPathDesc | null {
      network.resolveGraph();
      const p = network.get(id);
      return p ? toDesc(p) : null;
    },
    successors(id: string): string[] {
      network.resolveGraph();
      const p = network.get(id);
      return p ? p.successors.map((s) => s.id) : [];
    },
    claimZone: (zoneId, holderId) => zones.claim(zoneId, holderId),
    releaseZone: (zoneId, holderId) => zones.release(zoneId, holderId),
    isZoneHolder: (zoneId, holderId) => zones.isHolder(zoneId, holderId),
    releaseAllZones: (holderId) => zones.releaseAll(holderId),
  };
}

/**
 * Build the `SdkEnvironment.routing` backend: registrations become the
 * network's project router (one at a time — see `RVPathNetwork.setRouter`).
 * `owner` labels the registration for the replace warning and should be the
 * component's node path.
 */
export function createPathNetworkRoutingBackend(
  owner: string,
  network: RVPathNetwork = getDefaultPathNetwork(),
): SdkRoutingBackend {
  return {
    register: (router) => network.setRouter(router, owner),
  };
}
