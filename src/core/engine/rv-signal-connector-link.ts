// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Eager registry of the `ConnectSignal` relays per SignalStore (plan-2227). The
 * SignalConnector network loads on demand and reads them from here, so a model
 * without SignalConnector loads none of the connector code.
 */

import type { SignalStore } from './rv-signal-store';

/** A `ConnectSignal` as the network sees it: one more writer on its target. */
export interface LegacyRelayEdge {
  sourcePath: string;
  targetPath: string;
}

const _relays = new WeakMap<SignalStore, { edges: Set<LegacyRelayEdge>; listeners: Set<() => void> }>();

function relaySet(store: SignalStore) {
  let set = _relays.get(store);
  if (!set) { set = { edges: new Set(), listeners: new Set() }; _relays.set(store, set); }
  return set;
}

export function addConnectSignalRelay(store: SignalStore, edge: LegacyRelayEdge): void {
  const set = relaySet(store);
  set.edges.add(edge);
  for (const cb of [...set.listeners]) cb();
}

export function removeConnectSignalRelay(store: SignalStore, edge: LegacyRelayEdge): void {
  const set = _relays.get(store);
  if (!set?.edges.delete(edge)) return;
  for (const cb of [...set.listeners]) cb();
}

export function connectSignalRelays(store: SignalStore): ReadonlySet<LegacyRelayEdge> {
  return relaySet(store).edges;
}

/** Observe relay changes of a store; returns the unsubscribe. */
export function subscribeConnectSignalRelays(store: SignalStore, cb: () => void): () => void {
  const set = relaySet(store);
  set.listeners.add(cb);
  return () => { set.listeners.delete(cb); };
}
