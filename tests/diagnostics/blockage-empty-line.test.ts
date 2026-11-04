// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { conveyorLineFixture } from '../helpers/conveyor-line-fixture';
import { progressNodeId } from '../../src/core/diagnostics/rv-population-sources';
import { runBlockageChecker } from '../../src/core/diagnostics/rv-blockage-checker';
import { enumerateCycles } from '../../src/core/diagnostics/rv-blockage-probes';

it('names the leading MU and surface in a real accumulation stall', () => {
  const fixture = conveyorLineFixture({ accumulation: true,
    lineBudget: { MaxWaitSec: 2, MaxIdleSec: 5, WarmupSec: 0 } });
  try {
    fixture.run(2.2); // Two actual source MUs, one on each belt.
    fixture.jamAccumulation();
    fixture.run(12);
    const ctx = fixture.checkerContext();
    const edges = ctx.registry.collect(ctx.now).filter(e => e.kind === 'surface');
    const id = progressNodeId(fixture.lines[0].surfaces[0].node, 'surface');
    expect(edges).toContainEqual(expect.objectContaining({ waiterId: id, kind: 'surface' }));
    expect(enumerateCycles(edges).cycles).toEqual([]);
    const report = runBlockageChecker(ctx);
    console.info('surface coverage', report.coverage);
    expect(report.coverage.missing).toEqual([]);
    const stall = report.findings.find(f => f.waiterId === id);
    expect(stall?.cls).toBe('stall');
    expect(stall?.checks.map(c => c.name)).toContain('wait-edge');
    fixture.lines[0].surfaces[1].drive = fixture.lines[0].surfaces[0].drive;
    fixture.run(4);
    expect(ctx.registry.collect(ctx.now).filter(e => e.kind === 'surface')).toEqual([]);
  } finally { fixture.dispose(); }
});

it('finds the expected sink after a jam although all blocked flags stay false', () => {
  const fixture = conveyorLineFixture({ lineBudget: { ExpectFlow: true, MaxWaitSec: 2, MaxIdleSec: 5, WarmupSec: 0 }, secondLine: true });
  try {
    fixture.run(12);
    const sinkId = progressNodeId(fixture.lines[0].sink.node, 'sink');
    expect(fixture.wiring.ledger.entry(sinkId)?.count).toBeGreaterThan(0);
    for (const line of fixture.lines) for (const surface of line.surfaces) {
      expect(fixture.wiring.ledger.entry(progressNodeId(surface.node, 'surface'))?.count).toBeGreaterThan(0);
    }
    expect(fixture.wiring.sample(5).candidates).toEqual([]);
    expect(runBlockageChecker(fixture.checkerContext()).findings).toEqual([]);
    fixture.jam(); fixture.run(8);
    expect(fixture.manager.mus.length).toBeGreaterThan(0);
    expect(fixture.manager.mus.every(mu => !mu.blocked)).toBe(true);
    const result = fixture.wiring.sample(5);
    expect(result.candidates.map(e => e.unitId)).toContain(sinkId);
    expect(result.candidates.some(e => e.unitId.startsWith('Line2/'))).toBe(false);
    expect(result.coverage.missing).toEqual([]);
    const findings = runBlockageChecker(fixture.checkerContext()).findings;
    const sinkFinding = findings.find(f => f.waiterId === sinkId);
    expect(sinkFinding).toMatchObject({ cls: 'stall', budgetSource: 'Line1' });
    expect(sinkFinding?.checks).toContainEqual(expect.objectContaining({ name: 'no-wait-edge' }));
    expect(findings.some(f => f.waiterId.startsWith('Line2/'))).toBe(false);
  } finally { fixture.dispose(); }
});

it('does not arm sinks without opt-in or with DeleteMus false', () => {
  for (const options of [{}, { expectFlow: () => true, DeleteMus: false }]) {
    const fixture = conveyorLineFixture(options);
    try {
      fixture.run(2);
      fixture.jam(); fixture.run(8);
      const result = fixture.wiring.sample(5);
      expect(result.coverage.bySource.sinks).toBe(0);
      expect(result.candidates.some(e => e.kind === 'sink')).toBe(false);
    } finally { fixture.dispose(); }
  }
});

it('accepts a signal-stopped source when its line declares expected waiting', () => {
  const fixture = conveyorLineFixture({ sourceSignal: true, lineBudget: {
    ExpectFlow: true, MaxWaitSec: 2, MaxIdleSec: 5, WarmupSec: 0,
    SignalSuppress: { type: 'ComponentReference', componentType: 'PLCOutputBool', path: 'Pause' },
  } });
  try {
    fixture.signalStore.register('Pause', 'Pause', true, 'PLCOutputBool');
    fixture.run(10);
    expect(fixture.manager.mus).toHaveLength(0);
    expect(runBlockageChecker(fixture.checkerContext()).findings).toEqual([]);
    fixture.signalStore.set('Pause', false);
    expect(runBlockageChecker(fixture.checkerContext()).findings).toContainEqual(expect.objectContaining({ cls: 'stall' }));
  } finally { fixture.dispose(); }
});

it('unsubscribes on reset/clear and rebinds after a simulation reset', () => {
  const fixture = conveyorLineFixture({ expectFlow: () => true });
  try {
    fixture.run(4);
    const sink = fixture.lines[0].sink;
    const id = progressNodeId(sink.node, 'sink');
    const mu = fixture.manager.mus[0];
    expect(mu).toBeDefined();
    fixture.wiring.reset();
    sink.notifyConsumed(mu);
    expect(fixture.wiring.ledger.sample(0).coverage.unknown).toEqual([]);
    fixture.wiring.sample();
    sink.notifyConsumed(mu);
    expect(fixture.wiring.ledger.entry(id)?.count).toBe(1);
    fixture.setRunning(false);
    fixture.wiring.sample();
    expect(fixture.wiring.ledger.entry(id)?.state).toBe('inactive');
    fixture.wiring.dispose();
    sink.notifyConsumed(mu);
    expect(fixture.wiring.ledger.sample(0).coverage.expected).toBe(0);
    expect(fixture.wiring.ledger.sample(0).coverage.unknown).toEqual([]);
  } finally { fixture.dispose(); }
});
