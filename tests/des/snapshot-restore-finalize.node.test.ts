// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { restoreTransaction } from '@rv/plugins/des/rv-snapshot-restore';
import { snapshotFrame, FRAME_ACTION_INDEX } from '../helpers/snapshot-frame';

describe('snapshot restore transaction and finalization', () => {
  it('rejects preflight before preparing or committing', () => {
    const f = snapshotFrame();
    f.raw.nextEventId = 0;
    expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, stage: 'preflight', status: 'unchanged',
      problems: expect.arrayContaining([expect.objectContaining({ code: 'des-snapshot-contract' })]) });
    expect(f.trace).toEqual(['detach']);
    expect(f.queue.prepare).not.toHaveBeenCalled();
    expect(f.queue.commit).not.toHaveBeenCalled();
    expect(f.onCorrupt).not.toHaveBeenCalled();
  });

  it('discards earlier prepares after a late failure without changing any live container', () => {
    const f = snapshotFrame();
    const state = f.owner.state;
    const queue = f.carrier.queue;
    const content = structuredClone(state);
    const events = queue.snapshot();
    const cause = new Error('late prepare');
    f.late.prepare = vi.fn(() => { throw cause; });
    expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, stage: 'prepare', status: 'unchanged',
      participant: 'late', cause });
    expect(f.queue.prepare).toHaveBeenCalledOnce();
    expect(f.queue.commit).not.toHaveBeenCalled();
    expect(f.late.commit).not.toHaveBeenCalled();
    expect(f.queue.onRestore).not.toHaveBeenCalled();
    expect(f.owner.state).toBe(state);
    expect(f.owner.state).toEqual(content);
    expect(f.carrier.queue).toBe(queue);
    expect(queue.snapshot()).toEqual(events);
    expect(events.map(e => e.id)).toEqual([3, 7, 12]);
    expect(f.onCorrupt).not.toHaveBeenCalled();
  });

  it.each(['commit', 'onRestore', 'hook-failure', 'hook-throw'] as const)('reports %s as corrupt', where => {
    const f = snapshotFrame();
    const cause = new Error(where);
    const hookAfter = vi.fn();
    if (where === 'commit') f.late.commit = () => { throw cause; };
    if (where === 'onRestore') f.late.onRestore = () => { throw cause; };
    f.ctx.hooks = [{ label: 'hook', run: () => {
      if (where === 'hook-throw') throw cause;
      if (where === 'hook-failure') return { ok: false, reason: cause };
    } }, { label: 'after', run: hookAfter }];
    const result = restoreTransaction(f.raw, f.ctx);
    expect(result).toMatchObject({ ok: false, status: 'corrupt', cause,
      stage: where === 'commit' ? 'commit' : 'finalize',
      ...(where.startsWith('hook') ? { hook: 'hook' } : { participant: 'late' }),
    });
    expect(f.onCorrupt).toHaveBeenCalledExactlyOnceWith(result);
    expect(hookAfter).not.toHaveBeenCalled();
    if (where === 'commit') expect(f.queue.onRestore).not.toHaveBeenCalled();
  });

  it('marks even the first commit attempt corrupt and preserves reporting errors separately', () => {
    const f = snapshotFrame();
    const cause = new Error('first commit');
    const reporting = new Error('reporting');
    f.queue.commit = () => { throw cause; };
    f.ctx.onCorrupt = () => { throw reporting; };
    expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, status: 'corrupt', stage: 'commit',
      participant: 'queue', cause, onCorruptCause: reporting });
    expect(f.late.commit).not.toHaveBeenCalled();
  });

  it.each(['commit', 'onRestore'] as const)('honors explicit failure returns from %s', where => {
    const f = snapshotFrame();
    const cause = 'reported failure';
    // A JS participant may report failure despite the existing void signature.
    const report = () => ({ ok: false as const, reason: cause });
    if (where === 'commit') f.late.commit = report;
    else f.late.onRestore = report;
    const result = restoreTransaction(f.raw, f.ctx);
    expect(result).toMatchObject({ ok: false, status: 'corrupt', participant: 'late', cause,
      stage: where === 'commit' ? 'commit' : 'finalize' });
    expect(f.onCorrupt).toHaveBeenCalledExactlyOnceWith(result);
  });

  it('reports detach and registry ordering failures before any prepare', () => {
    for (const where of ['detach', 'order']) {
      const f = snapshotFrame();
      if (where === 'detach') f.ctx.detach = () => { throw new Error('detach'); };
      else f.registry.unregister('queue');
      expect(restoreTransaction(f.raw, f.ctx)).toMatchObject({ ok: false, stage: 'preflight', status: 'unchanged',
        cause: expect.any(Error) });
      expect(f.late.prepare).not.toHaveBeenCalled();
      expect(f.late.commit).not.toHaveBeenCalled();
      expect(f.onCorrupt).not.toHaveBeenCalled();
    }
  });

  it('keeps owners, swaps fresh containers, restores IDs and supports original cancel handles', () => {
    const f = snapshotFrame();
    const owner = f.owner;
    const state = owner.state;
    const queue = f.carrier.queue;
    owner.state.nested.values.push(99);
    queue.enqueue(50, FRAME_ACTION_INDEX, -1, -1);
    f.ctx.hooks = [{ label: 'hook', run: () => { f.trace.push('hook'); return { ok: true }; } }];
    f.ctx.deferred.defer(() => { f.trace.push('deferred'); });
    expect(restoreTransaction(f.raw, f.ctx)).toEqual({ ok: true });
    expect(f.trace).toEqual(['detach', 'prepare:queue', 'prepare:late', 'commit:queue', 'commit:late',
      'restore:queue', 'restore:late', 'hook', 'deferred']);
    expect(f.owner).toBe(owner);
    expect(owner.state).not.toBe(state);
    expect(owner.state.nested.values).toEqual([1, 2]);
    expect(f.carrier.queue).not.toBe(queue);
    expect(f.carrier.queue.snapshot().map(e => e.id)).toEqual([3, 7, 12]);
    expect(f.carrier.queue.cancel(owner.state.handle)).toBe(true);
    expect(f.carrier.queue.dequeue()?.id).toBe(3);
    expect(f.carrier.queue.dequeue()?.id).toBe(12);
    expect(f.carrier.queue.dequeue()).toBeNull();
    expect(f.carrier.queue.enqueue(9, FRAME_ACTION_INDEX, -1, -1)).toBe(20);
    expect(f.onCorrupt).not.toHaveBeenCalled();
  });
});
