// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';

function setup() {
  const clock = new ContinuousSimClock();
  const registry = createPlanningRegistry({ simTime: () => clock.now() });
  const order: number[] = [];
  const handle = registry.declare({ owner: 'yard', title: 'Yard', params: [
    { key: 'rate', label: 'Rate', type: 'number', default: 0, group: 'g', apply: 'live' },
    { key: 'size', label: 'Size', type: 'number', default: 0, group: 'g', apply: 'reset' },
  ], onLive(change, applied, valid, opts) {
    const apply = () => { if (valid?.() === false) return; order.push(change.to as number); applied(clock.now()); };
    if (opts?.alreadyScheduled) apply(); else clock.schedule(clock.now(), apply);
  } });
  const schedule = vi.fn((at: number, apply: () => void, opts: { afterModelEvents: boolean }) => {
    clock.schedule(at, apply, opts);
  });
  return { clock, registry, order, handle, schedule };
}

function record() {
  const h = setup();
  for (const [time, value] of [[2, 10], [4, 20], [4, 30], [7, 40]]) {
    h.clock.advanceTo(time);
    h.registry.set('yard.rate', value, 'ui');
    h.clock.advanceTo(time);
  }
  return { log: h.registry.changeLog(), order: h.order };
}

describe('recorded planning protocol', () => {
  it('replays shuffled rows at their times, including same-key same-time seq order, with one event per row', () => {
    const original = record();
    const h = setup();
    h.registry.replayChanges([...original.log].reverse(), h.schedule);
    expect(h.schedule.mock.calls.map(c => [c[0], c[2]])).toEqual(
      [2, 4, 4, 7].map(t => [t, { afterModelEvents: true }]));
    h.clock.advanceTo(3);
    expect(h.order).toEqual([10]);
    h.clock.advanceTo(10);
    expect(h.order).toEqual(original.order);
    expect(h.registry.changeLog()).toEqual(original.log);
    expect(h.clock.firedCount).toBe(4);
    h.registry.set('yard.rate', 50, 'ui');
    h.clock.advanceTo(10);
    expect(h.registry.changeLog().at(-1)?.seq).toBe(4);
  });

  it('reset drops pending rows even if the scheduler still fires them', () => {
    const h = setup();
    h.registry.replayChanges(record().log, h.schedule);
    h.registry.notifySimulationReset();
    h.clock.advanceTo(10);
    expect(h.order).toEqual([]);
    expect(h.registry.changeLog()).toEqual([]);
  });

  it('warns for missing and non-live keys and owners removed before firing', () => {
    const h = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const row = record().log[0];
      h.registry.replayChanges([{ ...row, key: 'missing.rate' }, { ...row, key: 'yard.size' }, row], h.schedule);
      expect(h.schedule).toHaveBeenCalledTimes(1);
      h.handle.dispose();
      h.clock.advanceTo(10);
      expect(warn).toHaveBeenCalledTimes(3);
      expect(h.order).toEqual([]);
      expect(h.registry.changeLog()).toEqual([]);
    } finally { warn.mockRestore(); }
  });
});
