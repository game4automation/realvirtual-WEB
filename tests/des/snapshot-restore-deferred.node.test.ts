// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { createDeferredReactions, restoreTransaction } from '@rv/plugins/des/rv-snapshot-restore';
import { snapshotFrame } from '../helpers/snapshot-frame';

describe('snapshot deferred reactions', () => {
  it('drains FIFO including newly deferred work and collects labeled errors', () => {
    const deferred = createDeferredReactions();
    const calls: string[] = [];
    const error = new Error('reaction');
    deferred.defer(() => { calls.push('a'); deferred.defer(() => { calls.push('c'); }); });
    deferred.defer(() => { calls.push('b'); throw error; }, 'broken');
    expect(deferred.size).toBe(2);
    expect(deferred.runAll()).toEqual([{ label: 'broken', error }]);
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(deferred.size).toBe(0);
    expect(deferred.runAll()).toEqual([]);
    deferred.defer(() => { calls.push('never'); });
    deferred.defer(() => { calls.push('never'); });
    expect(deferred.discard()).toBe(2);
    expect(deferred.discard()).toBe(0);
    expect(deferred.size).toBe(0);
    expect(deferred.runAll()).toEqual([]);
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('reports a deferred exception after successful commit, onRestore and hooks as corrupt', () => {
    const f = snapshotFrame();
    const cause = new Error('deferred');
    f.queue.onRestore = () => {
      f.trace.push('restore:queue');
      f.ctx.deferred.defer(() => { f.trace.push('reaction'); throw cause; }, 'wake');
    };
    f.ctx.hooks = [{ label: 'hook', run: () => { f.trace.push('hook'); } }];
    const result = restoreTransaction(f.raw, f.ctx);
    expect(result).toMatchObject({ ok: false, stage: 'finalize', status: 'corrupt', cause,
      deferredErrors: [{ label: 'wake', error: cause }], discarded: 0 });
    expect(f.trace.slice(-3)).toEqual(['restore:late', 'hook', 'reaction']);
    expect(f.onCorrupt).toHaveBeenCalledExactlyOnceWith(result);
    expect(f.ctx.deferred.size).toBe(0);
  });

  it.each(['commit', 'onRestore', 'hook-failure', 'hook-throw'] as const)(
    'discards every pending reaction when %s fails', where => {
      const f = snapshotFrame();
      const reaction = vi.fn();
      const discard = vi.spyOn(f.ctx.deferred, 'discard');
      const cause = new Error(where);
      const originalCommit = f.queue.commit;
      f.queue.commit = prepared => {
        originalCommit(prepared);
        f.ctx.deferred.defer(reaction, 'commit-wake');
      };
      f.queue.onRestore = () => { f.ctx.deferred.defer(reaction, 'restore-wake'); };
      if (where === 'commit') f.late.commit = () => { throw cause; };
      if (where === 'onRestore') f.late.onRestore = () => { throw cause; };
      if (where.startsWith('hook')) f.ctx.hooks = [{ label: 'failing', run: () => {
        f.ctx.deferred.defer(reaction, 'hook-wake');
        if (where === 'hook-throw') throw cause;
        return { ok: false, reason: cause };
      } }];
      const count = where === 'commit' ? 1 : where === 'onRestore' ? 2 : 3;
      const result = restoreTransaction(f.raw, f.ctx);
      expect(result).toMatchObject({ ok: false, status: 'corrupt', cause, discarded: count });
      expect(discard).toHaveReturnedWith(count);
      expect(discard).toHaveBeenCalledOnce();
      expect(f.onCorrupt).toHaveBeenCalledExactlyOnceWith(result);
      expect(f.ctx.deferred.size).toBe(0);
      expect(f.ctx.deferred.runAll()).toEqual([]);
      expect(reaction).not.toHaveBeenCalled();
    },
  );
});
