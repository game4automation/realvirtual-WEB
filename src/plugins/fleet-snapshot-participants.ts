// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { ZoneRegistry, type PreparedZoneRegistry, type ZoneDeclarantCodec } from '../core/engine/rv-zone-registry';

import { OrderPool, type PreparedOrderPool } from '../core/fleet/core/orders';
import { RVPath } from '../core/engine/rv-path';
// Type-only: startup code must not value-import the DES body (des-public-boundary).
import type { SnapshotProvider } from './des/rv-des-snapshot-provider';

export interface FleetSnapshotWorld {
  orders: OrderPool;
  stationKnown(id: string): boolean;
  zones: ZoneRegistry;
  paths: { get(id: string): RVPath | null | undefined };
}

export function fleetSnapshotProvider(world: FleetSnapshotWorld): SnapshotProvider {
  const { orders, stationKnown } = world;
  return () => [{
    key: 'fleet.orders', version: 1, owner: orders,
    stateKeys: ['nextId', 'completed', 'open', 'bySource'], services: ['completionListeners'],
    capture: () => orders.exportState(),
    validate: json => OrderPool.validateState(json, { stationKnown }),
    prepare: json => orders.prepareState(json, { stationKnown }),
    commit: prepared => orders.swapState(prepared as PreparedOrderPool),
  }];
}

/** Shared movement state, also present without FleetPlugin. */
export function zoneSnapshotParticipant(world: Pick<FleetSnapshotWorld, 'zones' | 'paths'>): import('./des/rv-snapshot-registry').Snapshottable {
  const { zones } = world;
  const codec: ZoneDeclarantCodec = {
    idOf: d => d instanceof RVPath && world.paths.get(d.id) === d ? d.id : null,
    resolve: id => world.paths.get(id) ?? null,
  };
  return {
    key: 'fleet.zones', version: 1, owner: zones,
    stateKeys: ['zones', 'byHolder'], services: ['availabilityListeners'],
    capture: () => zones.exportState(codec),
    validate: json => ZoneRegistry.validateState(json, codec),
    prepare: json => zones.prepareState(json, codec),
    commit: prepared => zones.swapState(prepared as PreparedZoneRegistry),
  };
}
