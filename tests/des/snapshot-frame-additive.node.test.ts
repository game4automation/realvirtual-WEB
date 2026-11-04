// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import type { DESEventQueue } from '@rv/plugins/des/rv-des-event-queue';
import { ACTION_BY_INDEX, getActionSchema, registerAction } from '@rv/plugins/des/rv-des-named-actions';
import { captureDetached } from '@rv/plugins/des/rv-snapshot-capture';
import { restoreTransaction } from '@rv/plugins/des/rv-snapshot-restore';
import { snapshotFrame } from '../helpers/snapshot-frame';

describe('additive Phase 2 snapshot frame', () => {
  it('round-trips test participants with the real manager as queue carrier', () => {
    const manager = new DESManager();
    // Test-only access: queue is a TS-private readonly field, not a JS #field.
    // This deliberately does not add a production setter or migrate the manager.
    const carrier = manager as unknown as { queue: DESEventQueue };
    const f = snapshotFrame(carrier);
    const originalManager = manager;
    const originalQueue = carrier.queue;
    const originalOwner = f.owner;
    const captured = captureDetached(f.registry, {
      version: f.raw.version, fingerprint: f.raw.fingerprint, simTime: f.raw.simTime,
      nextEventId: f.raw.nextEventId, eventQueue: f.raw.eventQueue, muIds: f.raw.muIds,
    });
    manager.cancelEvent(7);
    f.owner.state.nested.values.push(99);
    expect(restoreTransaction(JSON.parse(JSON.stringify(captured)), f.ctx)).toEqual({ ok: true });
    expect(manager).toBe(originalManager);
    expect(f.owner).toBe(originalOwner);
    expect(carrier.queue).not.toBe(originalQueue);
    expect(f.owner.state.nested.values).toEqual([1, 2]);
    expect(manager.getEventQueueSnapshot().map(e => e.id)).toEqual([3, 7, 12]);
    expect(manager.cancelEvent(f.owner.state.handle)).toBe(true);
    expect(carrier.queue.snapshot().map(e => e.id)).toEqual([3, 12]);
    expect(manager.processEvents(10)).toBe(2);
    expect(manager.currentTime).toBe(6);
    expect(f.onCorrupt).not.toHaveBeenCalled();
  });

  it('retains two-argument action registration and normal manager dispatch', () => {
    const action = 'Snapshot.Frame.D.LegacyTwoArgument';
    const dispatch = vi.fn();
    const index = registerAction(action, dispatch);
    expect(ACTION_BY_INDEX[index]).toBe(dispatch);
    expect(getActionSchema(action)).toBeUndefined();
    const manager = new DESManager();
    manager.scheduleEvent(1, action, -1);
    expect(manager.processEvents(10)).toBe(1);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  // The Phase-2 'runner independent of the frame' check ended with the Phase-3a activation.
});
