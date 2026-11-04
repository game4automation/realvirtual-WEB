// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { robotRunHarness } from './helpers/robot-run-harness';
import { Object3D } from 'three';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVGrip } from '../src/core/engine/rv-grip';
import { runPath } from '../src/plugins/mcp-bridge/rv-mcp-robot-run';
import type { IKPathRunEvent } from '../src/core/engine/rv-ik-path';

let h: Awaited<ReturnType<typeof robotRunHarness>>;
afterEach(() => h?.dispose());
describe('runtime observation preserves replay', () => {
  it('orders events, separates skipped targets, retains actions and unsubscribes', async () => {
    h = await robotRunHarness();
    const p = h.path;
    const skipped = p.targets[1];
    skipped.AxisPos = [];
    const action = vi.spyOn(skipped, 'onAtTarget');
    h.result.signalStore.register('skippedAction', 'PLC/skippedAction', false, 'PLCInputBool');
    skipped.setSignalAddr = 'PLC/skippedAction';
    skipped.SetSignalDuration = 0;
    const pick = vi.fn();
    skipped.PickAndPlace = true;
    skipped.Pick = true;
    skipped.gripTarget = { pick } as unknown as RVGrip;
    const events: IKPathRunEvent[] = [];
    const off = p.addRunListener(e => events.push(e));
    p.startPath(); h.tick(20000);
    expect(events[0].type).toBe('started');
    expect(events.at(-1)?.type).toBe('finished');
    expect(new Set(events.map(e => e.runSeq))).toEqual(new Set([1]));
    expect(events.filter(e => e.type === 'target-skipped').map(e => e.index)).toContain(1);
    expect(events.filter(e => e.type === 'target-reached').map(e => e.index)).not.toContain(1);
    expect(action).toHaveBeenCalledOnce();
    expect(pick).toHaveBeenCalledOnce();
    expect(h.result.signalStore.getBoolByPath('PLC/skippedAction')).toBe(true);
    off(); const count = events.length;
    p.startPath(); h.tick(20000);
    expect(events).toHaveLength(count);
    expect(p.PathIsFinished).toBe(true);
  }, 180000);
  it('reports the first completion before loop restart', async () => {
    h = await robotRunHarness();
    h.path.LoopPath = true;
    const events: IKPathRunEvent[] = [];
    h.path.addRunListener(e => events.push(e));
    h.path.startPath();
    for (let n = 0; n < 20000 && h.path.runSeq === 1; n++) h.tick();
    const done = events.findIndex(e => e.type === 'finished');
    expect(done).toBeGreaterThan(0);
    expect(events[done + 1]).toMatchObject({ type: 'started', runSeq: 2 });
    expect(h.path.PathIsActive).toBe(true);
  }, 180000);
  it('reports cancellation on reset and a fresh identity on restart', async () => {
    h = await robotRunHarness();
    const events: IKPathRunEvent[] = [];
    h.path.addRunListener(e => events.push(e));
    h.path.startPath(); h.path.reset(); h.path.startPath();
    expect(events.filter(e => ['started', 'cancelled'].includes(e.type)).map(e => [e.type, e.runSeq]))
      .toEqual([['started', 1], ['cancelled', 1], ['started', 2]]);
  }, 180000);
  it('finishes the observed pass before starting the chained path', async () => {
    h = await robotRunHarness();
    const p = h.path;
    const node = new Object3D(); node.name = 'After';
    p.node.parent!.add(node);
    const raw = p.node.userData.realvirtual.IKPath;
    node.userData.realvirtual = { IKPath: { Path: raw.Path } };
    const next = new RVIKPath(node);
    const nextPath = `${h.result.registry.getPathForNode(p.node.parent!)}/After`;
    h.result.registry.register('IKPath', nextPath, next);
    const ctx = { registry: h.result.registry, signalStore: h.result.signalStore,
      transportManager: h.result.transportManager } as ComponentContext;
    next.init(ctx);
    raw.StartNextPath = { type: 'ComponentReference', path: nextPath, componentType: 'realvirtual.IKPath' };
    p.init(ctx);
    const pending = runPath(h.viewer, p);
    h.tick(20000);
    expect(await pending).toMatchObject({ finished: true, continues: 'next-path' });
    expect(p.PathIsFinished).toBe(true);
    expect(next.PathIsActive).toBe(true);
    next.cancel(); next.dispose();
    expect(h.listenerCount()).toBe(0);
  }, 180000);

  it('releases run listeners on disposal', async () => {
    h = await robotRunHarness();
    let calls = 0;
    h.path.addRunListener(() => calls++);
    h.path.dispose();
    h.path.startPath();
    expect(calls).toBe(0);
  });

});
