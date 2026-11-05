// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { ProgressWiring } from '../../src/core/diagnostics/rv-progress-wiring';
import type { AgvHandle } from '../../src/core/engine/rv-agv-fleet';
import type { RVTransportSurface } from '../../src/core/engine/rv-transport-surface';
import type { RVSink } from '../../src/core/engine/rv-sink';
import type { RVMovingUnit } from '../../src/core/engine/rv-mu';

// plan-2241a F13: a ledger reset right before a batch (no frame in between) must leave every
// core unit registered, with the state the first sample would give it.
function world() {
  const root = new Object3D();
  const node = (name: string) => { const o = new Object3D(); o.name = name; root.add(o); return o; };
  const busy = { node: node('Belt1') } as unknown as RVTransportSurface;
  const idle = { node: node('Belt2') } as unknown as RVTransportSurface;
  const consumed: (() => void)[] = [];
  const sink = { node: node('Sink'), DeleteMus: true,
    subscribeConsumed: (fn: () => void) => { consumed.push(fn); return () => { consumed.splice(consumed.indexOf(fn), 1); }; },
  } as unknown as RVSink;
  const mu = { aabb: { center: new Vector3() }, currentSurface: busy } as unknown as RVMovingUnit;
  const driving = { id: 'A', node: new Object3D(), task: { destination: 't' }, phase: 'driving' as AgvHandle['phase'] };
  const parked = { id: 'B', node: new Object3D(), task: null, phase: 'idle' as AgvHandle['phase'] };
  const units = { surfaces: [busy, idle] as RVTransportSurface[] };
  const wiring = new ProgressWiring({ fleet: { all: () => [driving, parked] as unknown as AgvHandle[] },
    transport: { mus: [mu], get surfaces() { return units.surfaces; }, sinks: [sink] },
    expectFlow: () => true, clock: { now: () => 5 }, running: () => true });
  return { wiring, consumed, units, idle };
}

const states = (w: ProgressWiring) => Object.fromEntries(w.ledger.snapshotState().entries
  .map(([id, e]) => [id, [e.state, e.count]]));

it('ledger reset without a following frame keeps the core population registered and seeded', () => {
  const { wiring, consumed } = world();
  try {
    const before = states(wiring);
    wiring.reset();
    const coverage = wiring.ledger.sample(120, 5, true).coverage;
    expect(coverage.missing).toEqual([]);
    expect(coverage).toMatchObject({ expected: 5, registered: 5, coverageComplete: true });
    expect(states(wiring)).toEqual(before);
    expect(states(wiring)).toEqual({ 'A': ['armed', 0], 'B': ['inactive', 0],
      'Belt1:surface': ['armed', 0], 'Belt2:surface': ['inactive', 0], 'Sink:sink': ['armed', 0] });
    consumed.forEach(fn => fn());
    expect(wiring.ledger.entry('Sink:sink')?.count).toBe(1);
    const seeded = wiring.ledger.snapshotState().entries;
    wiring.sample();
    expect(consumed).toHaveLength(1);
    expect(wiring.ledger.snapshotState().entries).toEqual(seeded);
    wiring.dispose();
    expect(consumed).toHaveLength(0);
  } finally { wiring.dispose(); }
});

it('still reports a genuinely missing unit after a seeded reset', () => {
  const { wiring, units, idle } = world();
  try {
    wiring.reset();
    wiring.ledger.unregister('Belt2:surface');
    expect(wiring.ledger.sample(120, 5, true).coverage).toMatchObject({ missing: ['Belt2:surface'], coverageComplete: false });
    units.surfaces = [idle];
    expect(wiring.ledger.sample(120, 5, true).coverage.missing).toEqual(['Belt2:surface']);
  } finally { wiring.dispose(); }
});
