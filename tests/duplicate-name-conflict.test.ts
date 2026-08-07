// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { collectConnectSignals } from '../src/plugins/signal-bind/SignalBindPopover';
import type { ConnectInterface, ConnectInterfaceSignal } from '../src/core/hmi/connect-store';

const signal = (name: string): ConnectInterfaceSignal => ({
  name, protocolAddress: name, type: 'PLCInputBool', record: false,
});

const mqtt = (id: string, topics: Array<{ topic: string; names: string[] }>): ConnectInterface => ({
  id, type: 'MQTT', enabled: true, signals: [],
  topics: topics.map((entry) => ({
    topic: entry.topic,
    mode: 'Single',
    signals: entry.names.map(signal),
  })),
});

describe('v1 duplicate signal-name contract', () => {
  it('marks the same name from two interfaces as conflicted without deduplicating it', () => {
    const found = collectConnectSignals([
      mqtt('provider-a', [{ topic: 'line/a', names: ['Run'] }]),
      mqtt('provider-b', [{ topic: 'line/b', names: ['Run'] }]),
    ]);

    expect(found).toHaveLength(2);
    expect(found.every((entry) => entry.conflict)).toBe(true);
    expect(new Set(found.map((entry) => `${entry.interfaceId}/${entry.topic}`))).toEqual(
      new Set(['provider-a/line/a', 'provider-b/line/b']),
    );
  });

  it('also detects two provider topics on one interface and clears after one disappears', () => {
    const conflicted = collectConnectSignals([
      mqtt('provider-a', [
        { topic: 'line/a', names: ['Run'] },
        { topic: 'line/b', names: ['Run'] },
      ]),
    ]);
    expect(conflicted.every((entry) => entry.conflict)).toBe(true);

    const unique = collectConnectSignals([mqtt('provider-a', [{ topic: 'line/a', names: ['Run'] }])]);
    expect(unique).toEqual([expect.objectContaining({
      name: 'Run', interfaceId: 'provider-a', topic: 'line/a', conflict: false,
    })]);
  });
});
