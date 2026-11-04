// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { lineFixture } from './c2a-fixture';

it('round trips queue ids and addresses through a fresh world', () => {
  const a = lineFixture(); a.runUntil(23);
  const saved = a.runner.fullSnapshot();
  expect(saved.eventQueue.every(e => e.componentId === null || e.componentId.includes('@'))).toBe(true);
  const b = lineFixture({ reverse: true });
  b.runner.restoreJson(JSON.stringify(saved));
  expect(b.runner.fullSnapshot()).toEqual(saved);
  a.runUntil(53); b.runUntil(53);
  expect(b.runner.fullSnapshot()).toEqual(a.runner.fullSnapshot());
});
it('refuses an unknown queue DES id before changing the world', () => {
  const a = lineFixture(); a.runUntil(13);
  const before = a.runner.snapshotJson();
  const bad = JSON.parse(before); bad.eventQueue[0].componentId = '#missing@Source';
  expect(() => a.runner.restoreFull(bad)).toThrow('des-snapshot-contract');
  expect(a.runner.snapshotJson()).toBe(before);
});

it('stores display statistics by DES id and ignores them on restore', () => {
  const a = lineFixture(); a.runUntil(23);
  const saved = a.runner.fullSnapshot();
  expect(Object.keys(saved.statisticsCurrent!).sort()).toEqual(saved.fingerprint.components.map(c => c.id).sort());
  const before = a.station.getStatistics();
  saved.statisticsCurrent = {};
  a.runUntil(33); a.runner.restoreFull(saved);
  expect(a.station.getStatistics()).toEqual(before);
  expect(Object.keys(a.runner.fullSnapshot().statisticsCurrent!)).toHaveLength(3);
});
