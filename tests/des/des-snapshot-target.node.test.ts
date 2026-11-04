// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { liveSnapshotIndex } from '../../src/core/material-flow/des-snapshot-target';

it('H4 uses live run identity and never chooses a completed archived run', () => {
  const live = { runId: 'live', seed: 42, rngVersion: 2 as const, configKey: 'current' };
  const runs = [
    { ...live, index: 0, status: 'completed' },
    { ...live, runId: 'foreign', index: 1 },
    { ...live, index: 2 },
  ];
  expect(liveSnapshotIndex(runs, live)).toBe(2);
  expect(liveSnapshotIndex(runs.slice(0, 2), live)).toBe(2);
});

it('H4 without a run id requires seed, RNG version and configuration on an in-progress replication', () => {
  const live = { seed: 42, rngVersion: 2 as const, configKey: 'current' };
  const runs = [
    { ...live, index: 0, status: 'completed' },
    { ...live, index: 1, configKey: 'foreign' },
    { ...live, index: 2, rngVersion: 1 as const },
    { ...live, index: 3, seed: 43 },
    { ...live, index: 4 },
  ];
  expect(liveSnapshotIndex(runs, live)).toBe(4);
  expect(liveSnapshotIndex(runs.slice(0, 4), live)).toBe(4);
  expect(liveSnapshotIndex(runs, { seed: 42 })).toBe(5);
});
