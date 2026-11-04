// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { expectNoBlockage } from '../helpers/expect-no-blockage';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { edge } from './blockage-test-data';

function context(deadlock = false) {
  const ledger = new ProgressLedger({ clock: { now: () => 0 } });
  ledger.addPopulation({ id: 'fleet', kind: 'vehicle', expected: () => ['A', 'B', 'C'] });
  for (const id of ['A', 'B', 'C']) { ledger.register(id, 'vehicle', 'test'); ledger.arm(id); }
  const registry = new WaitRegistry();
  registry.addSource({ id: 'test', edges: () => deadlock
    ? [edge('A', 'Zone 1', ['B']), edge('B', 'Zone 2', ['A'])] : [edge('A', 'Dock', ['B'])] });
  return { ledger, registry, budgets: new BudgetResolver(), now: 200 };
}

it('lists every deadlock and stall with readable chains, idle budget and checks', () => {
  const ctx = context(true);
  let message = '';
  try { expectNoBlockage(ctx); } catch (error) {
    expect(error).toBeInstanceOf(Error); message = (error as Error).message;
  }
  expect(message).toContain('deadlock: A -> Zone 1 -> B -> Zone 2 -> A');
  expect(message).toContain('stall: C');
  expect(message).toContain('vs budget 120 s (default)');
  expect(message).toContain('idle 200 s');
  expect(message).toContain('cycle-length: ok');
  expect(message).toContain('no-wait-edge: ok');
  expect(message).toContain('budget-exceeded: ok');
});

it('throws with a readable stall chain', () => {
  expect(() => expectNoBlockage(context())).toThrow('stall: A -> Dock -> B');
});

it('passes a clean context and the viewer-shaped target using its simulation time', () => {
  const ctx = context();
  ctx.now = 10;
  expectNoBlockage(ctx, { requireCoverage: true });
  const viewer = { progressLedger: ctx.ledger, waitRegistry: ctx.registry, blockageBudgets: ctx.budgets, simTime: 10 };
  expectNoBlockage(viewer, { requireCoverage: true });
  viewer.simTime = 200;
  expect(() => expectNoBlockage(viewer)).toThrow('stall: A -> Dock -> B');
});

it('allows only the selected findings and retains the others', () => {
  const ctx = context(true);
  expect(() => expectNoBlockage(ctx, { allow: f => f.cls === 'deadlock' })).toThrow('stall: C');
  expectNoBlockage(ctx, { allow: () => true });
});

it('requires missing coverage independently of allowed findings', () => {
  const ctx = context();
  ctx.ledger.unregister('B');
  expectNoBlockage(ctx, { allow: () => true });
  expect(() => expectNoBlockage(ctx, { allow: () => true, requireCoverage: true })).toThrow('coverage missing: B');
});

it('forwards the context sampling floor and permits an option override', () => {
  const ctx = { ...context(), idleSec: 300 };
  expectNoBlockage(ctx);
  expect(() => expectNoBlockage(ctx, { idleSec: 0 })).toThrow('stall: A');
});

it('fails explicitly if viewer instrumentation is unavailable', () => {
  expect(() => expectNoBlockage({ progressLedger: null, waitRegistry: null, blockageBudgets: null, simTime: 0 }))
    .toThrow('instrumentation is not initialized');
});
