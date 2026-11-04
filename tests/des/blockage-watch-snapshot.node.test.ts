// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { BlockageWatch } from '../../src/core/diagnostics/rv-blockage-watch';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';
import { WaitRegistry } from '../../src/core/diagnostics/rv-wait-registry';
import { BudgetResolver } from '../../src/core/diagnostics/rv-blockage-budget';
import { clearAllProblems, getProblems } from '../../src/core/hmi/problems-store';
import { lineFixture } from './runner-fixture';

afterEach(() => clearAllProblems());
function fixture() {
  const f = lineFixture();
  const node = new Object3D(); node.name = 'Budget';
  node.userData.realvirtual = { BlockageBudget: { MaxIdleSec: 5, WarmupSec: 0, SignalBlockageFound: 'found' } };
  const ledger = new ProgressLedger({ clock: { now: () => f.manager.currentTime } });
  ledger.addPopulation({ id: 'test', kind: 'vehicle', expected: () => ['stalled'] });
  ledger.register('stalled', 'vehicle', 'test'); ledger.arm('stalled');
  const registry = new WaitRegistry();
  const budgets = new BudgetResolver({ nodeForUnit: () => node, budgetNodes: () => [node],
    writeSignal: (_ref, _node, value) => f.signalStore.set('found', value) });
  const watch = new BlockageWatch(() => ({ ledger, registry, budgets, now: f.manager.currentTime }));
  Object.assign(f.host, { blockageWatch: watch });
  watch.setOn(true);
  return { ...f, ledger, watch, budgets };
}
const published = () => getProblems().filter(p => p.code.startsWith('blockage-'))
  .map(p => ({ id: p.id, code: p.code, title: p.title, detail: p.detail, severity: p.severity }));
it.each(['same', 'fresh'])('restores an open finding and budgets on a %s runner', kind => {
  const reference = fixture(); reference.runUntil(20); reference.watch.sample();
  expect(reference.watch.lastReport!.findings.length).toBeGreaterThan(0);
  const saved = reference.snapshot();
  const savedState = reference.watch.snapshotState();
  const savedPublished = published();
  reference.runUntil(40); reference.watch.sample();
  const expectedState = reference.watch.snapshotState(), expectedPublished = published();
  const target = kind === 'same' ? reference : fixture();
  target.ledger.bump('stalled', 'vehicle'); target.watch.setOn(false);
  target.restore(saved);
  expect(target.watch.snapshotState()).toEqual(savedState);
  expect(published()).toEqual(savedPublished);
  expect(target.signalStore.get('found')).toBe(true);
  target.runUntil(40); target.watch.sample();
  expect(target.watch.snapshotState()).toEqual(expectedState);
  expect(published()).toEqual(expectedPublished);
  expect(target.signalStore.get('found')).toBe(true);
});
