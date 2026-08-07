// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { ConnectState } from './connect-store';

/** Compact "3s" / "2m 10s" age string shared by CONNECT status displays. */
export function statusAge(lastUpdate: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - lastUpdate) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface StaleDataState {
  state: ConnectState;
  gatewayUnreachable: boolean;
  lastStatusUpdate: number;
}

/**
 * True while CONNECT live data can no longer be trusted (gateway unreachable
 * or errored). Surfaced as the amber status dot on the CONNECT activity-bar
 * icon — there is intentionally no global banner/chip for this state.
 */
export function isConnectDataStale(snapshot: StaleDataState, _connectionConfigured: boolean): boolean {
  return snapshot.gatewayUnreachable || snapshot.state === 'error';
}
