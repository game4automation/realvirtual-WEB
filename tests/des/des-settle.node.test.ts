// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ceilEventTimeFor, nextUp, SETTLE_MAX_BATCHES, SETTLE_MAX_ROUNDS, type EventParticipant } from '../../src/core/sim-event-facade';
import { getDriveSpeedOverride, isSpeedOverrideNeutral, scaleSimDt, setDriveSpeedOverride, withSpeedOverrideNeutral } from '../../src/core/engine/rv-speed-override';
import { DESManager } from '../../src/plugins/des/rv-des-manager';
import { SettleController, settleSnapshotParticipant, SETTLE_PRIORITY } from '../../src/plugins/des/rv-des-settle';
import { ACTION_INDEX, registerAction } from '../../src/plugins/des/rv-des-named-actions';
import { DESEventQueue } from '../../src/plugins/des/rv-des-event-queue';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession, fromSnapshotData, toSnapshotData, type SnapshotJson } from '../../src/plugins/des/rv-snapshot-contract';
import type { SnapshotProviderFrame } from '../../src/core/sdk/rv-snapshot-contract-types';
import { cycleRunnerFixture } from './cycle-runner-fixture';
import { Object3D } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { wireNumberSignal } from '../../src/core/engine/rv-signal-wiring';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).reverse().forEach(off => off()); setDriveSpeedOverride(1); });
function world() {
  const manager = new DESManager();
  const store = new SignalStore();
  const report = vi.fn();
  const controller = new SettleController(manager, store, report);
  cleanups.push(() => controller.dispose());
  return { manager, store, controller, report };
}
function participant(extra: Partial<EventParticipant> = {}): EventParticipant {
  return { readSet: () => [], settle: () => false, dueTime: () => null, ...extra };
}
function encoded(controller: SettleController): SnapshotJson {
  const registry = new SnapshotRegistry();
  registry.register(settleSnapshotParticipant(controller));
  return registry.captureAll(createCaptureSession())[0].state;
}
function frame(manager: DESManager): SnapshotProviderFrame {
  return { simTime: manager.currentTime, parts: [],
    eventQueue: manager.exportQueue(() => '', data => toSnapshotData(data, { participant: 'queue' })) };
}
function installQueue(manager: DESManager, raw: SnapshotProviderFrame, nextId: number): void {
  const queue = new DESEventQueue();
  queue.restoreWithIds(raw.eventQueue.map(e => ({ ...e, actionIndex: ACTION_INDEX.get(e.action)!, entityId: -1 })), nextId);
  manager.swapPreparedQueue(queue, new Map(raw.eventQueue.filter(e => e.data !== undefined).map(e => [e.id, e.data])));
  manager.applyRunState(manager.exportRunState(), raw.simTime);
}

describe('signal batch boundary', () => {
  it('observes only effective writes after listeners, including force and path writes', () => {
    const store = new SignalStore();
    store.register('a', 'Signals/a', false, 'PLCOutputBool');
    const log: unknown[] = [];
    store.subscribe('a', value => log.push(['listener', value]));
    const off = store.observeWrites(batch => log.push([...batch]));
    store.setByPath('Signals/a', true, 0);
    store.set('a', true, 0);
    store.forceSignal('a', false);
    expect(log).toEqual([['listener', true], [['a', true]], ['listener', false], [['a', false]]]);
    off(); store.forceSignal('a', true);
    expect(log.at(-1)).toEqual(['listener', true]);
  });

  it('delivers re-entrant writes in completion order and keeps setMany atomic', () => {
    const store = new SignalStore();
    const log: unknown[] = [];
    store.subscribe('a', () => { expect(store.get('b')).toBe(true); store.setMany({ c: true, d: true }, 0); });
    store.observeWrites(batch => log.push([...batch]));
    store.setMany({ a: true, b: true }, 0);
    store.setMany({ a: true, b: true }, 0);
    expect(log).toEqual([[['c', true], ['d', true]], [['a', true], ['b', true]]]);
  });

  it('restores silently, deletes absent names, bumps version once and refreshes baselines', () => {
    const store = new SignalStore();
    store.setMany({ a: false, removed: 1 }, 0);
    const listener = vi.fn(), observer = vi.fn(), baseline = vi.fn(() => expect(store.get('a')).toBe(true));
    store.subscribe('a', listener); store.observeWrites(observer);
    const off = store.onValuesRestored(baseline);
    const version = store.version;
    store.restoreValuesSilently(new Map([['a', true]]));
    expect(store.get('removed')).toBeUndefined(); expect(store.version).toBe(version + 1);
    expect(listener).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled(); expect(baseline).toHaveBeenCalledOnce();
    off(); store.restoreValuesSilently(new Map([['a', false]])); expect(baseline).toHaveBeenCalledOnce();
  });
});

describe('SettleController', () => {
  it('reorders rounds without changing the image, queued batches or due handle/time', () => {
    const { manager, store, controller } = world();
    store.set('pulse', false, 0);
    const seen: [string, boolean | number | undefined][] = [];
    controller.registerEventParticipant('A', 1, participant({ settle: () => { seen.push(['A', undefined]); return false; } }));
    controller.registerEventParticipant('B', 2, participant({ readSet: () => ['pulse'], dueTime: () => 10,
      settle: (_, image) => { seen.push(['B', image.get('pulse')]); return false; } }));
    controller.wake('A'); controller.wake('B');
    store.set('pulse', true, 0); store.set('pulse', false, 0);
    const image = controller.run.image.get('B'), batches = controller.run.batches.get('B');
    const due = controller.run.dues.get('B'), handle = controller.run.handle, nextId = manager.nextEventId;
    const queue = manager.getEventQueueSnapshot();

    controller.reorderEventParticipant('B', 0);
    expect(controller.run.dirty).toEqual(['B', 'A']);
    const dirty = controller.run.dirty;
    controller.reorderEventParticipant('B', 0);
    expect(controller.run.dirty).toBe(dirty);
    expect(controller.run.image.get('B')).toBe(image);
    expect(image!.get('pulse')).toBe(false);
    expect(controller.run.batches.get('B')).toBe(batches);
    expect(batches!.map(batch => [...batch])).toEqual([[['pulse', true]], [['pulse', false]]]);
    expect(controller.run.dues.get('B')).toBe(due);
    expect(controller.run.handle).toBe(handle);
    expect(manager.nextEventId).toBe(nextId);
    expect(manager.getEventQueueSnapshot()).toEqual(queue);
    manager.processAnimated(0);
    expect(seen).toEqual([['B', true], ['A', undefined], ['B', false]]);
    expect(controller.run.dues.get('B')).toBe(due);
  });

  it('exposes the current participant only during its scan, including when the scan throws', () => {
    const { manager, controller } = world();
    expect(controller.currentParticipant).toBeNull();
    controller.registerEventParticipant('plc:P', 0, participant({ settle: () => {
      expect(controller.currentParticipant).toBe('plc:P'); return false;
    } }));
    controller.wake('plc:P'); manager.processAnimated(0);
    expect(controller.currentParticipant).toBeNull();
    controller.refreshEventParticipant('plc:P', participant({ settle: () => {
      expect(controller.currentParticipant).toBe('plc:P'); throw new Error('scan failed');
    } }));
    expect(() => manager.processAnimated(0)).toThrow('scan failed');
    expect(controller.currentParticipant).toBeNull();
  });

  it('refreshes readers while preserving their image, ordered batches and unregister handle', () => {
    const { manager, store, controller } = world();
    store.setMany({ a: false, removed: false, added: 7 }, 0);
    const original = vi.fn(() => false);
    const off = controller.registerEventParticipant('reader', 0,
      participant({ readSet: () => ['a', 'removed'], settle: original, dueTime: () => 10 }));
    store.setMany({ a: true, removed: true }, 0);
    store.set('removed', false, 0);
    store.set('a', false, 0);
    const seen: unknown[] = [];
    controller.refreshEventParticipant('reader', participant({ readSet: () => ['a', 'added'],
      settle: (_t, image) => { seen.push([...image]); return false; }, dueTime: () => 20 }));
    expect([...controller.run.image.get('reader')!]).toEqual([['a', false], ['added', 7]]);
    expect(controller.run.batches.get('reader')!.map(batch => [...batch])).toEqual([[['a', true]], [['a', false]]]);
    expect(controller.run.dues.get('reader')!.t).toBe(20);
    manager.processAnimated(0);
    expect(original).not.toHaveBeenCalled();
    expect(seen).toEqual([[['a', true], ['added', 7]], [['a', false], ['added', 7]]]);
    off();
    expect(controller.run.image.has('reader')).toBe(false);
    expect(controller.run.dues.has('reader')).toBe(false);
  });

  it('does not consume event IDs without participants or interested readers', () => {
    const { manager, store, controller } = world();
    const next = manager.nextEventId;
    controller.requestSettle(); controller.reset(); store.set('unread', true, 0);
    expect(manager.nextEventId).toBe(next);
    controller.registerEventParticipant('reader', 0, participant({ readSet: () => ['a'] }));
    store.set('unread', false, 0); expect(manager.nextEventId).toBe(next);
  });

  it('coalesces wakes and sorts each round by order then id', () => {
    const { manager, controller } = world();
    const log: string[] = [], calls = new Map<string, number>();
    for (const [id, order] of [['z', 2], ['b', 1], ['a', 1]] as const) {
      controller.registerEventParticipant(id, order, participant({ settle: () => {
        log.push(id); const n = (calls.get(id) ?? 0) + 1; calls.set(id, n); return n < 2;
      } }));
      controller.wake(id); controller.wake(id);
    }
    expect(manager.getEventQueueSnapshot().filter(e => !e.cancelled)).toHaveLength(1);
    expect(controller.run.dirty).toEqual(['a', 'b', 'z']);
    expect(manager.getEventQueueSnapshot()[0].priority).toBe(SETTLE_PRIORITY);
    manager.processStep(); expect(log).toEqual(['a', 'b', 'z', 'a', 'b', 'z']);
    expect(controller.run.handle).toBe(-1); expect(manager.nextEventId).toBe(1);
  });

  it('converges a two-participant feedback chain without extra settle events', () => {
    const { manager, store, controller } = world();
    store.setMany({ a: 0, b: 0 }, 0);
    const log: string[] = [];
    controller.registerEventParticipant('A', 0, participant({ readSet: () => ['b'], settle: (_, image) => {
      log.push('A'); store.set('a', Math.min(3, Number(image.get('b')) + 1), 0); return false;
    } }));
    controller.registerEventParticipant('B', 1, participant({ readSet: () => ['a'], settle: (_, image) => {
      log.push('B'); store.set('b', image.get('a')!, 0); return false;
    } }));
    controller.wake('A'); manager.processStep();
    expect(store.get('a')).toBe(3); expect(store.get('b')).toBe(3);
    expect(log).toEqual(['A', 'B', 'A', 'B', 'A', 'B', 'A']);
    expect(manager.nextEventId).toBe(1);
  });

  it('initializes the complete image and preserves pulses without mixing signal states', () => {
    const { manager, store, controller } = world();
    store.setMany({ a: false, b: false }, 0);
    const seen: unknown[] = []; let prev = false, pulses = 0;
    controller.registerEventParticipant('R', 0, participant({ readSet: () => ['a', 'b', 'missing'], settle: (_, image) => {
      expect(image.has('missing')).toBe(false);
      const a = image.get('a') === true;
      if (a && !prev) pulses++; prev = a;
      seen.push([a, image.get('b')]); return false;
    } }));
    store.set('a', true, 0); store.set('a', false, 0); store.set('b', true, 0);
    manager.processStep();
    expect(seen).toEqual([[true, false], [false, false], [false, true]]); expect(pulses).toBe(1);
    expect(manager.nextEventId).toBe(1);
  });

  it('applies setMany as one batch and incorporates own read-signal writes immediately', () => {
    const { manager, store, controller } = world();
    store.setMany({ a: false, b: false }, 0);
    const seen: unknown[] = [];
    controller.registerEventParticipant('R', 0, participant({ readSet: () => ['a', 'b'], settle: (_, image) => {
      seen.push([...image.values()]);
      if (image.get('a')) {
        store.set('a', false, 0); expect(image.get('a')).toBe(false);
        expect(controller.run.batches.get('R')).toHaveLength(0);
      }
      return false;
    } }));
    store.setMany({ a: true, b: true }, 0); manager.processStep();
    expect(seen).toEqual([[true, true], [false, true]]);
  });

  it('reports oscillation at exactly 64 rounds with participant and last change', () => {
    const { manager, store, controller, report } = world();
    store.set('a', false, 0);
    const error = vi.fn(), scan = vi.fn((_: number, image: ReadonlyMap<string, boolean | number>) => {
      store.set('a', !image.get('a'), 0); return false;
    });
    controller.registerEventParticipant('oscillator', 0, participant({ readSet: () => ['a'], settle: scan, onSettleOverflow: error }));
    controller.wake('oscillator'); manager.processStep();
    expect(scan).toHaveBeenCalledTimes(SETTLE_MAX_ROUNDS);
    expect(error).toHaveBeenCalledWith('DES settle did not converge after 64 rounds at t=0 (last change: a)');
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ code: 'des-settle-overflow', nodePath: 'oscillator' }));
    expect(controller.run.dirty).toEqual([]); expect(controller.run.batches.get('oscillator')).toEqual([]);
    expect(manager.nextEventId).toBe(1);
  });

  it('reports batch overflow and clears queued work', () => {
    const { store, controller, report, manager } = world();
    const error = vi.fn();
    controller.registerEventParticipant('R', 0, participant({ readSet: () => ['a'], onSettleOverflow: error }));
    for (let i = 0; i <= SETTLE_MAX_BATCHES; i++) store.set('a', i, 0);
    expect(error).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
    expect(controller.run.batches.get('R')).toEqual([]);
    expect(manager.processStep()).toBe(false);
    expect(() => encoded(controller)).not.toThrow();
  });

  it.each([[0.1 + 0.2, 100], [1 / 3, 100], [0.1 + 0.2, 1000 / 3]])(
    'fires an awkward deadline once, after the exact timer comparison at start=%s, PT=%s ms', (start, pt) => {
    const { manager, controller } = world();
    manager.processAnimated(start);
    const startMs = start * 1000;
    let done = false;
    const deadline = ceilEventTimeFor(startMs + pt, ms => ms - startMs >= pt);
    const scan = vi.fn((t: number) => { expect(t * 1000 - startMs).toBeGreaterThanOrEqual(pt); done = true; return false; });
    controller.registerEventParticipant('timer', 0, participant({ settle: scan, dueTime: () => done ? null : deadline }));
    expect(manager.processStep()).toBe(true); expect(scan).not.toHaveBeenCalled();
    manager.processStep(); expect(scan).toHaveBeenCalledOnce(); expect(manager.currentTime).toBe(deadline);
    expect(manager.processStep()).toBe(false); expect(controller.run.dues.size).toBe(0);
  });

  it('allows an overflow callback to unregister its failed participant', () => {
    const { manager, controller, report } = world(); let off = () => {};
    off = controller.registerEventParticipant('R', 0, participant({ settle: () => true, onSettleOverflow: () => off() }));
    controller.wake('R'); expect(() => manager.processStep()).not.toThrow();
    expect(report).toHaveBeenCalledOnce(); expect(controller.run.dirty).toEqual([]);
    expect(controller.run.image.has('R')).toBe(false);
  });

  it('cancels changed, elapsed and removed deadlines', () => {
    const { manager, controller } = world(); let t: number | null = 2;
    const off = controller.registerEventParticipant('timer', 0, participant({ dueTime: () => t }));
    const first = controller.run.dues.get('timer')!.handle;
    t = 3; controller.wake('timer'); manager.processStep();
    expect(controller.run.dues.get('timer')!.t).toBe(3);
    expect(manager.getEventQueueSnapshot().find(e => e.id === first)?.cancelled ?? true).toBe(true);
    t = 0; controller.wake('timer'); manager.processStep(); expect(controller.run.dues.size).toBe(0);
    t = 4; controller.wake('timer'); manager.processStep(); off();
    expect(controller.run.dues.size).toBe(0); expect(controller.run.image.has('timer')).toBe(false);
    expect(manager.processStep()).toBe(false);
  });

  it('allows a second settle after a later event at the same time', () => {
    const { manager, controller } = world(); const scan = vi.fn(() => false);
    controller.registerEventParticipant('R', 0, participant({ settle: scan }));
    const action = 'Test.Settle.Later';
    const index = ACTION_INDEX.get(action) ?? registerAction(action, ctx => (ctx.data as () => void)(), 'non-persistent');
    controller.wake('R');
    manager.scheduleEventByIndex(0, index, -1, -1, SETTLE_PRIORITY - 1, () => controller.wake('R'));
    manager.processStep(); manager.processStep(); manager.processStep();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('ignores writes and wakes during restore; reset refills and wakes all explicitly', () => {
    const { manager, store, controller } = world(); const scan = vi.fn(() => false);
    controller.registerEventParticipant('A', 0, participant({ readSet: () => ['a'], settle: scan, holdsRun: () => true }));
    controller.registerEventParticipant('B', 1, participant({ settle: scan }));
    controller.beginRestore(); store.set('a', true, 0); controller.wake('A'); controller.endRestore();
    expect(manager.nextEventId).toBe(0); expect(controller.run.batches.get('A')).toEqual([]);
    expect(controller.isResting()).toBe(true);
    controller.reset(); expect(controller.run.image.get('A')!.get('a')).toBe(true);
    manager.processStep(); expect(scan).toHaveBeenCalledTimes(2);
    controller.reset(); manager.processStep(); expect(scan).toHaveBeenCalledTimes(4);
  });

  it('neutralizes speed during scans and restores nested scope after exceptions', () => {
    const { manager, controller } = world(); setDriveSpeedOverride(7);
    controller.registerEventParticipant('R', 0, participant({ settle: () => {
      expect(getDriveSpeedOverride()).toBe(1); expect(scaleSimDt(0.1)).toBe(0.1); return false;
    } }));
    controller.wake('R'); manager.processStep(); expect(getDriveSpeedOverride()).toBe(7);
    expect(() => withSpeedOverrideNeutral(() => {
      withSpeedOverrideNeutral(() => expect(isSpeedOverrideNeutral()).toBe(true)); throw new Error('test');
    })).toThrow('test');
    expect(isSpeedOverrideNeutral()).toBe(false); expect(scaleSimDt(2)).toBe(14);
  });
});

describe('settle snapshots', () => {
  it('continues queued pulses in a fresh world without waking on commit', () => {
    const a = world(); a.store.setMany({ a: false, b: false }, 0);
    a.controller.registerEventParticipant('R', 0, participant({ readSet: () => ['a', 'b'] }));
    a.store.set('a', true, 0); a.store.set('a', false, 0); a.store.set('b', true, 0);
    const saved = encoded(a.controller), raw = frame(a.manager), nextId = a.manager.nextEventId;
    const b = world(), seen: unknown[] = [];
    b.controller.registerEventParticipant('R', 0, participant({ readSet: () => ['a', 'b'], settle: (_, image) => {
      seen.push([...image.values()]); return false;
    } }));
    const target = settleSnapshotParticipant(b.controller, raw);
    expect(target.validate(saved)).toEqual([]);
    const prepared = target.prepare(saved);
    b.controller.beginRestore();
    b.store.restoreValuesSilently(new Map([['a', false], ['b', true]]));
    target.commit(prepared); installQueue(b.manager, raw, nextId); b.controller.endRestore();
    expect(b.manager.nextEventId).toBe(nextId);
    expect(encoded(b.controller)).toEqual(saved);
    b.manager.processStep(); expect(seen).toEqual([[true, false], [false, false], [false, true]]);
    expect(b.report).not.toHaveBeenCalled();
  });

  it('roundtrips all signal number tags with fresh containers', () => {
    const { store, controller } = world();
    store.setMany({ nan: NaN, inf: Infinity, neg: -Infinity, zero: -0 }, 0);
    controller.registerEventParticipant('R', 0, participant({ readSet: () => ['nan', 'inf', 'neg', 'zero'] }));
    store.set('nan', Infinity, 0);
    const p = settleSnapshotParticipant(controller), state = encoded(controller);
    const prepared = p.prepare(JSON.parse(JSON.stringify(state))) as typeof controller.run;
    expect(prepared).not.toBe(controller.run); expect(prepared.image.get('R')).not.toBe(controller.run.image.get('R'));
    expect(Number.isNaN(prepared.image.get('R')!.get('nan'))).toBe(true);
    expect(Object.is(prepared.image.get('R')!.get('zero'), -0)).toBe(true);
    expect(prepared.batches.get('R')![0].get('nan')).toBe(Infinity);
  });

  it.each(['swapped', 'time', 'orphan', 'dirty', 'image', 'batches', 'dues'])('rejects corrupt %s before committing', kind => {
    const { controller, manager } = world();
    for (const id of ['A', 'B']) controller.registerEventParticipant(id, 0, participant({ dueTime: () => 5 }));
    const saved = encoded(controller), raw = frame(manager), p = settleSnapshotParticipant(controller, raw);
    const run = fromSnapshotData(saved, { participant: p.key, ...p.schema }) as typeof controller.run;
    if (kind === 'swapped') {
      const a = run.dues.get('A')!, b = run.dues.get('B')!; [a.handle, b.handle] = [b.handle, a.handle];
    } else if (kind === 'time') run.dues.get('A')!.t = 6;
    else if (kind === 'orphan') run.dues.delete('A');
    else if (kind === 'dirty') run.dirty.push('foreign');
    else if (kind === 'image') run.image.set('foreign', new Map());
    else if (kind === 'batches') run.batches.set('foreign', []);
    else run.dues.set('foreign', { t: 5, handle: 999 });
    const corrupt = toSnapshotData(run, { participant: p.key, ...p.schema });
    expect(p.validate(corrupt).length).toBeGreaterThan(0);
    const registry = new SnapshotRegistry(); registry.register({ ...p, capture: () => run });
    expect(() => registry.captureAll(createCaptureSession())).toThrow('des-snapshot-contract');
    expect(controller.run.dues.get('A')!.t).toBe(5);
  });
});

it('nextUp handles signed zero, infinities, negative numbers and NaN', () => {
  expect(nextUp(0)).toBe(Number.MIN_VALUE); expect(nextUp(-0)).toBe(Number.MIN_VALUE);
  expect(nextUp(-Infinity)).toBe(-Number.MAX_VALUE); expect(nextUp(Infinity)).toBe(Infinity);
  expect(nextUp(-1)).toBeGreaterThan(-1); expect(nextUp(1)).toBeGreaterThan(1); expect(nextUp(NaN)).toBeNaN();
});

describe('DESRunner resting event participants', () => {
  function restingRunner(end: number) {
    const w = cycleRunnerFixture({ core: false, end });
    w.runner.simEvents.registerEventParticipant('waiting', 0, participant({ holdsRun: () => true }));
    w.runner.simEvents.wake('waiting');
    w.start();
    return w;
  }

  it('keeps an interactive infinite run open when the queue drains at rest', async () => {
    const w = restingRunner(Infinity);
    expect(w.pending('Core.Settle')).toHaveLength(1);
    expect(w.runner.step()).toBe(true);
    expect(w.manager.nextModelEventTime).toBe(Infinity);
    expect(w.manager.isComplete).toBe(false); expect(w.runner.runComplete).toBeNull();
    const now = w.manager.currentTime;
    expect(await w.runner.runFastForward()).toBe(false);
    expect(w.runner.ffProgress).toBeUndefined();
    expect(w.manager.currentTime).toBe(now); expect(w.runner.runComplete).toBeNull();
    expect(w.manager.isPaused).toBe(false);
    w.runner.simEvents.wake('waiting');
    expect(w.pending('Core.Settle')).toHaveLength(1);
  });

  it('jumps to a finite end when a participant rests with no model events', async () => {
    const w = restingRunner(12.5);
    expect(await w.runner.runFastForward()).toBe(true);
    expect(w.manager.currentTime).toBe(12.5); expect(w.manager.isComplete).toBe(true);
    expect(w.runner.runComplete?.simTime).toBe(12.5);
  });

  it('completes and pauses at an explicit target in an infinite resting run', async () => {
    const w = restingRunner(Infinity);
    expect(await w.runner.fastForwardUntil(10)).toBe(true);
    expect(w.manager.currentTime).toBe(10); expect(w.manager.isPaused).toBe(true);
    expect(w.runner.subMode).toBe('step'); expect(w.runner.runComplete).toBeNull();
    expect(w.manager.isComplete).toBe(false);
    w.runner.tick(0.01); expect(w.manager.isPaused).toBe(false);
    expect(await w.runner.runFastForward()).toBe(false);
    expect(w.manager.currentTime).toBe(10); expect(w.manager.isPaused).toBe(false);
  });

  it('finishes a finite resting run even before any event has been processed', async () => {
    const w = cycleRunnerFixture({ core: false, end: 12.5 });
    w.runner.simEvents.registerEventParticipant('waiting', 0, participant({ holdsRun: () => true }));
    w.start();
    expect(await w.runner.runFastForward()).toBe(true);
    expect(w.manager.totalEventsProcessed).toBe(1);
    expect(w.runner.runComplete?.simTime).toBe(12.5);
  });

  it('drains due system events before jumping across the finite rest interval', () => {
    const w = restingRunner(12.5);
    w.manager.statResetTime = 2;
    expect(w.manager.runBatch(1).done).toBe(false);
    expect(w.manager.currentTime).toBe(0);
    expect(w.manager.runBatch(1).done).toBe(true);
    expect(w.manager.currentTime).toBe(12.5);
    expect(w.manager.getEventQueueSnapshot().filter(e => !e.cancelled)).toEqual([]);
  });
});

describe('runner settle restore and reset contract', () => {
  it('reorders facade owners before start and during a run without replacing their pending state', () => {
    const w = cycleRunnerFixture({ core: false });
    const seen: string[] = [];
    w.signalStore.register('pulse', 'Signals/pulse', false, 'PLCOutputBool');
    for (const [id, order] of [['A', 1], ['B', 2]] as const)
      w.runner.simEvents.registerEventParticipant(id, order, participant({ readSet: () => ['pulse'], dueTime: () => 10,
        settle: () => { seen.push(id); return false; } }));
    w.runner.simEvents.reorderEventParticipant!('B', 0);
    w.start(); w.manager.processAnimated(0);
    expect(seen).toEqual(['B', 'A']); seen.length = 0;
    w.signalStore.set('pulse', true); w.signalStore.set('pulse', false);
    const before = w.runner.fullSnapshot(), dues = w.pending('Core.Due').sort((a, b) => a.id - b.id);
    w.runner.simEvents.reorderEventParticipant!('A', -1);
    expect(w.runner.fullSnapshot()).toEqual(before);
    w.manager.processAnimated(0);
    expect(seen).toEqual(['A', 'B', 'A', 'B']);
    expect(w.pending('Core.Due').sort((a, b) => a.id - b.id)).toEqual(dues);
    seen.length = 0; w.runner.reset(); w.manager.processAnimated(0);
    expect(seen).toEqual(['A', 'B']);
  });

  it('coalesces the start pass for every owner at the current simulation time', () => {
    const w = cycleRunnerFixture({ core: false });
    const seen: string[] = [];
    for (const [id, order] of [['late', 2], ['early', 1]] as const)
      w.runner.simEvents.registerEventParticipant(id, order, participant({ settle: () => { seen.push(id); return false; } }));
    w.manager.processAnimated(2.5); w.start();
    expect(w.pending('Core.Settle')).toHaveLength(1); expect(w.pending('Core.Settle')[0].time).toBe(2.5);
    w.runner.step(); expect(seen).toEqual(['early', 'late']);
  });

  function runnerWorld() {
    const w = cycleRunnerFixture({ core: false });
    const scans: unknown[] = [];
    w.signalStore.register('a', 'Signals/a', false, 'PLCOutputBool');
    w.signalStore.register('b', 'Signals/b', false, 'PLCOutputBool');
    w.runner.simEvents.registerEventParticipant('R', 0, participant({ readSet: () => ['a', 'b'], holdsRun: () => true,
      settle: (_, image) => { scans.push([...image.values()]); return false; } }));
    w.start();
    return { ...w, scans };
  }

  it('wakes every registered owner once on start and reset, at the current time', () => {
    const w = runnerWorld(), second = vi.fn(() => false);
    w.runner.simEvents.registerEventParticipant('second', 1, participant({ settle: second }));
    w.runner.reset();
    expect(w.pending('Core.Settle')).toHaveLength(1);
    expect(w.pending('Core.Settle')[0].time).toBe(0);
    w.runner.step();
    expect(w.scans).toEqual([[false, false]]); expect(second).toHaveBeenCalledOnce();
    w.runner.reset(); w.runner.step();
    expect(w.scans).toEqual([[false, false], [false, false]]); expect(second).toHaveBeenCalledTimes(2);
  });

  it('restore wakes nothing and queues no batches, including writes in onRestore', () => {
    const w = runnerWorld(); w.runner.step();
    w.runner.simEvents.registerSnapshotProvider('test.restore', () => [{ key: 'test.restore', version: 1,
      capture: () => null, validate: () => [], prepare: () => null, commit: () => {},
      onRestore: () => { w.signalStore.set('a', true, 0); w.runner.simEvents.wake('R'); },
    }]);
    w.runner.onLifecycle(event => {
      if (event.type === 'restored') { w.signalStore.set('b', true, 0); w.runner.simEvents.wake('R'); }
    });
    const saved = w.runner.fullSnapshot();
    w.runner.restoreFull(saved);
    expect(w.pending('Core.Settle')).toEqual([]);
    expect(w.manager.nextEventId).toBe(saved.nextEventId);
    expect(w.runner.fullSnapshot().parts.find(p => p.key === 'core.settle')).toEqual(saved.parts.find(p => p.key === 'core.settle'));
    expect(w.scans).toHaveLength(1);
    // The restore window closes: later operator writes wake normally.
    w.signalStore.set('a', true, 0); expect(w.pending('Core.Settle')).toHaveLength(1);
  });

  it('continues pending batches in the same order after restoreFull into a fresh runner', () => {
    const a = runnerWorld(); a.runner.step();
    a.signalStore.set('a', true, 0); a.signalStore.set('a', false, 0); a.signalStore.set('b', true, 0);
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = runnerWorld(); b.runner.restoreFull(saved);
    expect(b.runner.fullSnapshot()).toEqual(saved);
    b.runner.step();
    expect(b.scans).toEqual([[true, false], [false, false], [false, true]]);
    a.scans.length = 0; a.runner.step(); expect(b.scans).toEqual(a.scans);
  });

  it.each(['swapped', 'time', 'dirty', 'batches', 'dues', 'payload'])('rejects %s due/owner corruption before mutation', kind => {
    const w = cycleRunnerFixture({ core: false });
    for (const id of ['A', 'B']) w.runner.simEvents.registerEventParticipant(id, 0, participant({ dueTime: () => 5 }));
    w.start(); w.runner.step();
    const saved = w.runner.fullSnapshot(), corrupt = structuredClone(saved);
    const part = corrupt.parts.find(p => p.key === 'core.settle')!;
    const p = settleSnapshotParticipant(world().controller);
    const run = fromSnapshotData(part.state, { participant: p.key, ...p.schema }) as SettleController['run'];
    if (kind === 'swapped') {
      const a = run.dues.get('A')!, b = run.dues.get('B')!; [a.handle, b.handle] = [b.handle, a.handle];
    } else if (kind === 'time') run.dues.get('A')!.t++;
    else if (kind === 'dirty') run.dirty.push('unknown');
    else if (kind === 'batches') run.batches.set('unknown', []);
    else if (kind === 'dues') run.dues.set('unknown', { t: 5, handle: 999 });
    else corrupt.eventQueue.find(e => e.id === run.dues.get('A')!.handle)!.data = { participant: 'B' };
    part.state = toSnapshotData(run, { participant: p.key, ...p.schema });
    expect(() => w.runner.restoreFull(corrupt)).toThrow(/des-snapshot-contract/);
    expect(w.runner.fullSnapshot()).toEqual(saved);
  });

  it('restores valid due handles, payload owners and queue times into a fresh runner', () => {
    const make = () => {
      const w = cycleRunnerFixture({ core: false });
      const seen: string[] = [];
      for (const id of ['A', 'B']) w.runner.simEvents.registerEventParticipant(id, 0, participant({
        settle: t => { if (t > 0) seen.push(id); return false; }, dueTime: () => 5,
      }));
      w.start(); return { ...w, seen };
    };
    const a = make(); a.runner.step();
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = make(); b.runner.restoreFull(saved);
    expect(b.runner.fullSnapshot()).toEqual(saved);
    while (b.runner.step()) { /* Drain both deadlines and their settle. */ }
    expect(b.seen).toEqual(['A', 'B']); expect(b.manager.currentTime).toBe(5);
  });

  it('B-immediate keeps drive speed 100 when numeric start value 0 was never delivered', () => {
    function driveWorld() {
      const w = cycleRunnerFixture({ core: false });
      const node = new Object3D(); node.name = 'Axis'; w.scene.add(node);
      const drive = new RVDrive(node); drive.initDrive(); drive.TargetSpeed = 100;
      w.signalStore.register('speed', 'Signals/speed', 0, 'PLCOutputFloat');
      const setter = vi.fn((v: number) => { drive.TargetSpeed = v; });
      const wire = wireNumberSignal(w.signalStore, 'Signals/speed', setter);
      cleanups.push(wire.unsubscribe);
      vi.spyOn(w.runner as unknown as { collectDrives(): RVDrive[] }, 'collectDrives').mockReturnValue([drive]);
      w.start(); return { ...w, drive, setter };
    }
    const a = driveWorld(); expect(a.setter).not.toHaveBeenCalled();
    const saved = JSON.parse(JSON.stringify(a.runner.fullSnapshot()));
    const b = driveWorld(); b.runner.restoreFull(saved);
    expect(b.setter).not.toHaveBeenCalled(); expect(b.drive.TargetSpeed).toBe(100);
    expect(b.runner.fullSnapshot()).toEqual(saved);
  });
});
