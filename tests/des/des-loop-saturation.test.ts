// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { containedTargetOf } from '../../src/plugins/des/des-scene-binding';
import { sourceFixture } from './phase4-source-fixture';

function line() {
  const f = sourceFixture('fastforward', 10, false, true);
  expect(containedTargetOf(f.part('Source'))).toBe(f.part('Conveyor0'));
  const readiness = vi.spyOn(f.part('Source').self, 'poseReadiness');
  f.connect('Source', 'Conveyor0');
  for (let i = 0; i < 9; i++) f.connect(`Conveyor${i}`, `Conveyor${i + 1}`);
  return {
    ...f,
    start() {
      f.start();
      // Exercise production onGenerate -> poseReadiness -> pose hand-over,
      // not a silently falling-back standard source or a manually injected MU.
      expect(readiness.mock.results.some(r => r.type === 'return' && r.value.state === 'ready')).toBe(true);
    },
  };
}

it('9.11 open line fills Storage beyond the global cap and hand-over allowance', () => {
  const f = line();
  f.connect('Conveyor9', 'Storage');
  f.start(); f.advance(300);
  // The old cap is seven, but pendingTransferCommits discounts the MU being
  // handed over during an upstream wake: eight stored MUs is NOT a regression.
  expect(f.part('Storage').currentLoad).toBeGreaterThanOrEqual(12);
});

it('9.11 sinkless closed loop retains free conveyor zones', () => {
  const f = line();
  f.connect('Conveyor9', 'Conveyor0');
  f.start(); f.advance(150);
  const load = () => f.components.filter(c => c.def.kind === 'conveyor').reduce((n, c) => n + c.currentLoad, 0);
  const outputs = () => f.components.filter(c => c.def.kind === 'conveyor').reduce((n, c) => n + c.totalProcessed, 0);
  const before = outputs();
  f.advance(300);
  expect(load()).toBeGreaterThan(0);
  expect(load()).toBeLessThan(10);
  expect(outputs()).toBeGreaterThan(before);
});

it('9.11 loop with a branch to a slow sink is not globally throttled', () => {
  const f = line();
  // First-fit switch: take the storage/sink branch while it has capacity,
  // otherwise circulate. Reachability must include BOTH successors.
  f.connect('Conveyor9', 'Storage'); f.connect('Conveyor9', 'Conveyor0');
  f.connect('Storage', 'SlowConsumer'); f.connect('SlowConsumer', 'Sink');
  f.start(); f.advance(300);
  expect(f.part('Storage').currentLoad).toBeGreaterThanOrEqual(12);
});
