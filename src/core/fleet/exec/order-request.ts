// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { FleetStation, StationId } from '../core/orders';

export interface OrderSignalStore {
  subscribe(name: string, cb: (value: boolean | number) => void): () => void;
}

/** Bind pick requests once; synchronous subscription snapshots only seed edge state. */
export function bindOrderRequests(
  store: OrderSignalStore, api: { request(station: StationId): boolean }, stations: readonly FleetStation[],
): () => void {
  const disposers = stations.filter((s) => s.role === 'pick').map((s) => {
    let previous = false;
    let subscribing = true;
    const dispose = store.subscribe(`${s.id}.Order.Request`, (value) => {
      const current = Boolean(value);
      const rising = current && !previous;
      previous = current;
      if (!subscribing && rising) api.request(s.id);
    });
    subscribing = false;
    return dispose;
  });
  return () => { for (const dispose of disposers) dispose(); };
}
