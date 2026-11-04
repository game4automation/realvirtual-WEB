// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { createBatteryModel } from '@rv/core/fleet/core/battery';
import { FleetDispatcher } from '@rv/core/fleet/core/dispatcher';
import type { FleetStation } from '@rv/core/fleet/core/orders';
import { forkliftConsumption, RETRIEVAL_RULES, type RetrievalRule } from '@rv/core/fleet/core/strategies';
import type { PalletYardConfig } from './layout';

export function fleetStationsOf(cfg: PalletYardConfig): FleetStation[] {
  return cfg.stations.map((s) => ({
    id: s.id, role: s.kind === 'buffer' ? 'storage' : s.kind, pathId: s.pathId,
    storageGroup: s.kind === 'buffer' || s.kind === 'pick' ? 'Buffer' : undefined,
    approachM: s.stichLengthM, handlingHeightMm: s.handlingHeightMm,
  }));
}

export { RETRIEVAL_RULES } from '@rv/core/fleet/core/strategies';
export type RetrievalRuleName = keyof typeof RETRIEVAL_RULES;

export function createYardDispatcher(cfg: PalletYardConfig, retrieval?: RetrievalRule): FleetDispatcher {
  const stationOrder = new Map(cfg.stations.map((s, i) => [s.id, i]));
  const params = {
    get travelSpeedMmS() { return cfg.vehicle.travelSpeedMmS; },
    get reverseSpeedMmS() { return cfg.vehicle.reverseSpeedMmS; },
    get liftSpeedLoadedMmS() { return cfg.vehicle.liftSpeedLoadedMmS; },
    get liftSpeedEmptyMmS() { return cfg.vehicle.liftSpeedEmptyMmS; },
    get travelHeightMm() { return cfg.vehicle.travelHeightMm; },
    get handlingDeltaMm() { return cfg.vehicle.handlingDeltaMm; },
    get travelSlack() { return cfg.battery.travelSlack; },
    get idleReserveSec() { return cfg.shippingPauses.durationSec; },
  };
  return new FleetDispatcher({
    stations: fleetStationsOf(cfg), battery: createBatteryModel(cfg.battery),
    consumption: forkliftConsumption(() => params),
    retrieval: retrieval ?? RETRIEVAL_RULES[cfg.retrieval ?? 'legacy-fifo'],
    orderTieBreak: (a, b) => stationOrder.get(a.source)! - stationOrder.get(b.source)!,
  });
}
