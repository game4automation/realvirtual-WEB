// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { StatsRegistry } from '../src/core/stats/rv-stats-registry';
import { getScriptStatsCollector } from '../src/core/stats/script-stats-collector';
import { SdkBridge, type SdkEnvironment } from '../src/core/sdk/rv-sdk-self';

it('polls latest rows, scopes keys by owner and only notifies on section changes', () => {
  const registry = new StatsRegistry();
  const collector = getScriptStatsCollector(registry);
  expect(getScriptStatsCollector(registry)).toBe(collector);
  const a = collector.forOwner('A'), b = collector.forOwner('B');
  expect(registry.list()).toEqual([]);
  a.set('Parts', 3); b.set('Parts', null, 'pcs', 'Cell');
  const version = registry.getSnapshot();
  a.set('Parts', 'done');
  expect(registry.getSnapshot()).toBe(version);
  const rows = registry.list()[0].rows!();
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ label: 'Parts', value: 'done', group: 'A', owner: 'A' });
  expect(rows[1]).toMatchObject({ value: null, unit: 'pcs', group: 'Cell', owner: 'B' });
  expect(rows[0].key).not.toBe(rows[1].key);
  a.clear(); expect(registry.list()[0].rows!()).toHaveLength(1);
  b.clear(); b.clear(); expect(registry.list()).toEqual([]);
  a.set('Parts', 5); expect(registry.list()).toHaveLength(1);
  a.clear();
});

it('rejects invalid host values and clears rows on bridge disposal', () => {
  const registry = new StatsRegistry();
  const bridge = new SdkBridge({ path: 'A', statRows: getScriptStatsCollector(registry).forOwner('A') } as SdkEnvironment);
  for (const value of [undefined, true, {}, []]) {
    expect(() => bridge.hostCall('stat.row', 'Bad', value)).toThrow('number, string or null');
  }
  expect(registry.list()).toEqual([]);
  bridge.hostCall('stat.row', 'Good', 3);
  expect(registry.list()).toHaveLength(1);
  bridge.dispose(); expect(registry.list()).toEqual([]);
});
