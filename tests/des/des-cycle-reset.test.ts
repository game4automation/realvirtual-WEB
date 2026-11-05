// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { compareFullSnapshots } from '../helpers/des-continuation-harness';
import { cycleBrowserWorld } from './cycle-browser-world';

it('resets cycle owners across replications and reproduces a seed after a different run', async () => {
  const fresh = await cycleBrowserWorld({ seed: 2207 });
  let reference: ReturnType<typeof fresh.projection>;
  try { await fresh.advance('batch'); reference = fresh.projection(); }
  finally { fresh.dispose(); }

  const world = await cycleBrowserWorld({ seed: 2207 });
  try {
    await world.advance('batch');
    expect(world.projection()).toEqual(reference!);
    world.runner.reset();
    await world.runner.whenCycleOwnersReady();
    expect(world.drive.currentPosition).toBe(0);
    expect(world.button.active).toBe(false);
    expect(world.samples).toEqual([]);
    await world.advance('batch');
    expect(world.projection()).toEqual(reference!);

    await world.beginRun(19); await world.advance('batch');
    expect(world.projection().participant.targets).not.toEqual(reference!.participant.targets);
    await world.beginRun(2207); await world.advance('batch');
    expect(world.projection()).toEqual(reference!);
  } finally { world.dispose(); }
}, 120_000);

it('matches fresh projections and full snapshots in a blocker-free cycle-only world', async () => {
  // MU generations intentionally survive reset; compare full envelopes in a world
  // without MUs, and compare explicit MU poses in the mixed-world test above.
  const fresh = await cycleBrowserWorld({ controls: false, flow: false, seed: 2207 });
  let reference: ReturnType<typeof fresh.runner.fullSnapshot>;
  let projection: ReturnType<typeof fresh.projection>;
  try {
    // A fresh batch replication enters through beginRun, just like subsequent slots.
    await fresh.beginRun(); await fresh.advance('batch');
    projection = fresh.projection(); reference = fresh.runner.fullSnapshot();
  }
  finally { fresh.dispose(); }
  const world = await cycleBrowserWorld({ controls: false, flow: false, seed: 2207 });
  try {
    for (const seed of [2207, 2207, 19, 2207]) {
      await world.beginRun(seed); await world.advance('batch');
      if (seed === 2207) {
        expect(world.projection()).toEqual(projection!);
        compareFullSnapshots(reference!, world.runner.fullSnapshot());
      }
    }
  } finally { world.dispose(); }
}, 120_000);
