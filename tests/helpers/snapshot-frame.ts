// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { vi } from 'vitest';
import { DESEventQueue } from '@rv/plugins/des/rv-des-event-queue';
import { registerAction, getActionSchema } from '@rv/plugins/des/rv-des-named-actions';
import { SnapshotRegistry, type Snapshottable } from '@rv/plugins/des/rv-snapshot-registry';
import { createCaptureSession, type SnapshotJson } from '@rv/plugins/des/rv-snapshot-contract';
import { createDeferredReactions, type RestoreContext } from '@rv/plugins/des/rv-snapshot-restore';
import type { DESSnapshotV4 } from '@rv/plugins/des/rv-des-snapshot-v4';

export const FRAME_ACTION = 'Snapshot.Frame.D.Tick';
export const FRAME_ACTION_INDEX = registerAction(FRAME_ACTION, () => {}, { owner: 'queue', payload: 'none' });

type QueueState = { events: ReturnType<DESEventQueue['snapshot']>; nextId: number };
type State = { nested: { values: number[] }; handle: number };

/** Test-only participant adapter, also usable with the real manager's private queue.
 * Production manager integration (clock/data/refcounts/etc.) belongs to Phase 3.
 */
export function snapshotFrame(carrier = { queue: new DESEventQueue() }) {
  const registry = new SnapshotRegistry();
  const trace: string[] = [];
  const owner = { state: { nested: { values: [1, 2] }, handle: 7 } };
  carrier.queue.restoreWithIds([
    { id: 7, time: 5, actionIndex: FRAME_ACTION_INDEX, entityId: -1, muId: -1, priority: 0 },
    { id: 3, time: 5, actionIndex: FRAME_ACTION_INDEX, entityId: -1, muId: -1, priority: 0 },
    { id: 12, time: 6, actionIndex: FRAME_ACTION_INDEX, entityId: -1, muId: -1, priority: 0 },
  ], 20);
  const queue: Snapshottable = {
    key: 'queue', version: 1,
    capture: () => ({ events: carrier.queue.snapshot(), nextId: 20 }), validate: () => [],
    prepare: vi.fn((json: SnapshotJson) => {
      trace.push('prepare:queue');
      const state = json as QueueState;
      const next = new DESEventQueue();
      next.restoreWithIds(state.events, state.nextId);
      return next;
    }),
    commit: vi.fn((prepared: unknown) => { trace.push('commit:queue'); carrier.queue = prepared as DESEventQueue; }),
    onRestore: vi.fn(() => { trace.push('restore:queue'); }),
  };
  const late: Snapshottable = {
    key: 'late', version: 1, dependencies: ['queue'], owner, stateKeys: ['state'],
    capture: () => owner.state, validate: () => [],
    prepare: vi.fn((json: SnapshotJson) => { trace.push('prepare:late'); return structuredClone(json); }),
    commit: vi.fn((prepared: unknown) => { trace.push('commit:late'); owner.state = prepared as State; }),
    onRestore: vi.fn(() => { trace.push('restore:late'); }),
  };
  // Register out of dependency order to exercise the coordinator's ordering.
  registry.register(late); registry.register(queue);
  const fingerprint = { schemaVersion: 4 as const, rngVersion: 2, modelHash: 'frame-model', runConfigHash: 'run', components: [] };
  const raw: DESSnapshotV4 = {
    version: 4, fingerprint: structuredClone(fingerprint), simTime: 0, nextEventId: 20, muIds: [],
    eventQueue: carrier.queue.snapshot().map(e => ({
      id: e.id, time: e.time, action: FRAME_ACTION, componentId: null, muId: e.muId, priority: e.priority,
    })),
    parts: registry.captureAll(createCaptureSession()),
  };
  const onCorrupt = vi.fn();
  const ctx: RestoreContext = {
    registry, preflight: { fingerprint, componentTypeOf: () => undefined, getActionSchema,
      handleRefs: parts => [{ participant: 'late', path: 'handle',
        eventId: (parts.find(p => p.key === 'late')!.state as State).handle,
        action: FRAME_ACTION, owner: 'queue' }],
    },
    deferred: createDeferredReactions(), onCorrupt,
    detach: vi.fn(() => { trace.push('detach'); }),
  };
  return { registry, carrier, owner, queue, late, raw, ctx, trace, onCorrupt };
}
