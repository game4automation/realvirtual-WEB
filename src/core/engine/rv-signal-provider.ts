// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Stable identity of an interface-provided signal. */
export interface SignalSourceRef {
  interfaceId: string;
  topic?: string;
  signal: string;
}

/** Provider identity without the signal name (one interface can expose several MQTT topics). */
export function signalProviderKey(source: Pick<SignalSourceRef, 'interfaceId' | 'topic'>): string {
  return `${source.interfaceId}\u0000${source.topic ?? ''}`;
}

/** Full provider + signal key used for liveness and feedback fan-in. */
export function signalSourceKey(source: SignalSourceRef): string {
  return `${signalProviderKey(source)}\u0000${source.signal}`;
}

