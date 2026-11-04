// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { captureDetached } from '@rv/plugins/des/rv-snapshot-capture';
import { snapshotFrame } from '../helpers/snapshot-frame';

describe('detached synchronous snapshot capture', () => {
  it('preserves nested state and envelope metadata through mutations and an awaited tick', async () => {
    const f = snapshotFrame();
    const extra = { simTime: 5, metadata: { labels: ['captured'], point: { x: 2 } } };
    const saved = captureDetached(f.registry, extra);
    const expected = structuredClone(saved);
    expect(saved).not.toBeInstanceOf(Promise);
    f.owner.state.nested.values[0] = 100;
    f.carrier.queue.clear();
    extra.metadata.labels.push('later');
    extra.metadata.point.x = 99;
    extra.simTime = 9;
    expect(saved).toEqual(expected);
    await Promise.resolve();
    f.owner.state.handle = -1;
    f.owner.state.nested.values.push(200);
    extra.metadata.labels[0] = 'after tick';
    // Represents an asynchronous checkpoint writer seeing the captured instant.
    expect(JSON.parse(JSON.stringify(saved))).toEqual(expected);
    expect(saved.parts[1].state).not.toBe(f.owner.state);
    expect(f.queue.prepare).not.toHaveBeenCalled();
    expect(f.queue.commit).not.toHaveBeenCalled();
    expect(f.late.onRestore).not.toHaveBeenCalled();
  });

  it('uses one identity session for metadata and all participants', () => {
    const f = snapshotFrame();
    expect(() => captureDetached(f.registry, { shared: f.owner.state.nested })).toThrow(/alias/);
    f.queue.capture = () => ({ shared: f.owner.state.nested });
    expect(() => captureDetached(f.registry)).toThrow(/alias/);
  });

  it('rejects invalid metadata before collecting participants', () => {
    const f = snapshotFrame();
    f.queue.capture = vi.fn(f.queue.capture);
    expect(() => captureDetached(f.registry, { callback() {} })).toThrow(/function/);
    expect(f.queue.capture).not.toHaveBeenCalled();
  });
});
