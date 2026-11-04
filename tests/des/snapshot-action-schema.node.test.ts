// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import type { SnapshotJson } from '@rv/plugins/des/rv-snapshot-contract';
import {
  ACTION_BY_INDEX, ACTION_INDEX, ACTION_NAME, ACTION_SCHEMA,
  getActionSchema, registerAction, type ActionSchema,
} from '@rv/plugins/des/rv-des-named-actions';
import {
  assertPersistableQueue, assertPersistableQueueOrThrow,
  type PersistableQueueContext, type PersistableQueueEvent,
} from '@rv/plugins/des/rv-des-action-schema';

const prefix = 'Snapshot.Schema.B.';
const noSchema = prefix + 'Legacy';
const component = prefix + 'Component';
const payload = prefix + 'Payload';
const system = prefix + 'System';
const global = prefix + 'Global';
const transient = prefix + 'Transient';
const anyComponent = prefix + 'AnyComponent';
const schema: ActionSchema = {
  owner: 'component', targetType: 'Conveyor', payload: 'none', handleFields: ['pendingEvent', 'legs[].event'],
};
const handler = vi.fn();
const legacyIndex = registerAction(noSchema, handler);
registerAction(component, () => {}, schema);
registerAction(payload, () => {}, {
  owner: 'component', targetType: 'Conveyor',
  payload: data => typeof data === 'object' && data !== null && !Array.isArray(data)
    && typeof data.count === 'number' && data.count > 0 ? [] : ['count must be positive', 'invalid payload'],
});
registerAction(system, () => {}, { owner: 'fleet.orders', payload: 'none' });
registerAction(global, () => {}, { owner: 'global', payload: 'none' });
registerAction(transient, () => {}, 'non-persistent');
registerAction(anyComponent, () => {}, { owner: 'component', payload: 'none' });

const ctx: PersistableQueueContext = {
  participants: new Set(['belt', 'source', 'fleet.orders', 'global']),
  componentTypeOf: id => id === 'belt' ? 'Conveyor' : id === 'source' ? 'Source' : undefined,
};
function event(action: string, extra: Partial<PersistableQueueEvent> = {}): PersistableQueueEvent {
  return { id: 12, time: 5, action, componentId: 'belt', muId: -1, priority: 0, data: null, ...extra };
}

describe('snapshot action schemas', () => {
  it('keeps two-argument registration and index dispatch intact without adding a schema', () => {
    expect(ACTION_SCHEMA.has(noSchema)).toBe(false);
    expect(getActionSchema(noSchema)).toBeUndefined();
    expect(ACTION_INDEX.get(noSchema)).toBe(legacyIndex);
    expect(ACTION_NAME.get(legacyIndex)).toBe(noSchema);
    expect(ACTION_BY_INDEX[legacyIndex]).toBe(handler);
    expect(getActionSchema(component)).toBe(schema);
    expect(getActionSchema(component)).toMatchObject({ handleFields: ['pendingEvent', 'legs[].event'] });
    expect(getActionSchema(transient)).toBe('non-persistent');
    expect(() => registerAction(component, () => {}, 'non-persistent')).toThrow('duplicate');
    expect(getActionSchema(component)).toBe(schema);
  });

  it('reports unknown and registered actions without schemas', () => {
    const errors = assertPersistableQueue([event(noSchema), event(prefix + 'Unknown', { id: 13 })], ctx);
    expect(errors).toEqual([
      { code: 'des-snapshot-contract', eventId: 12, action: noSchema, reason: 'action has no persistence schema' },
      { code: 'des-snapshot-contract', eventId: 13, action: prefix + 'Unknown', reason: 'action has no persistence schema' },
    ]);
  });

  it('rejects wrong target types and unknown or missing component owners', () => {
    expect(assertPersistableQueue([event(component, { componentId: 'source' })], ctx)[0].reason)
      .toContain('target type');
    for (const componentId of ['unknown', null]) {
      const errors = assertPersistableQueue([event(component, { componentId })], ctx);
      expect(errors.some(e => e.reason.includes('unknown component'))).toBe(true);
    }
    expect(assertPersistableQueue([event(component)], { ...ctx, participants: new Set() })[0].reason)
      .toContain('owner participant');
  });

  it('preserves every payload validator diagnostic', () => {
    const errors = assertPersistableQueue([event(payload, { data: { count: -1 } })], ctx);
    expect(errors.map(e => e.reason)).toEqual(['count must be positive', 'invalid payload']);
    expect(errors.every(e => e.eventId === 12 && e.action === payload && e.code === 'des-snapshot-contract')).toBe(true);
    expect(assertPersistableQueue([event(payload)], ctx)).toHaveLength(2);
  });

  it.each(([0, false, '', [], { count: 1 }] as SnapshotJson[]).map(data => ({ data })))(
    'rejects data $data for a none-payload action', ({ data }) => {
      expect(assertPersistableQueue([event(component, { data })], ctx)[0].reason).toBe('action declares no payload');
    });

  it('requires registered system and global owner participants', () => {
    for (const action of [system, global]) {
      expect(assertPersistableQueue([event(action, { componentId: null })], {
        ...ctx, participants: new Set(),
      })[0].reason).toContain('not registered');
    }
  });

  it('rejects non-persistent actions for explicit DES owners, known components and system participants', () => {
    for (const componentId of ['belt', 'fleet.orders']) {
      expect(assertPersistableQueue([event(transient, { componentId })], ctx)[0].reason)
        .toContain('non-persistent');
    }
    expect(assertPersistableQueue([event(transient, { componentId: 'custom' })], {
      ...ctx, desOwners: new Set(['custom']),
    })[0].reason).toContain("DES owner 'custom'");
  });

  it('accepts valid component, payload, global, system and UI cases without mutating events', () => {
    const events = [
      event(component), event(component, { data: undefined }),
      event(anyComponent, { componentId: 'source' }), event(payload, { data: { count: 2 } }),
      event(system, { componentId: null }), event(global, { componentId: null }),
      event(transient, { componentId: 'ui' }), event(transient, { componentId: null }),
    ];
    const before = events.map(e => ({ ...e }));
    expect(assertPersistableQueue(events, ctx)).toEqual([]);
    expect(() => assertPersistableQueueOrThrow(events, ctx)).not.toThrow();
    expect(events).toEqual(before);
    expect(assertPersistableQueue([], ctx)).toEqual([]);
  });

  it('exposes the complete structured error list on the throwing variant', () => {
    const events = [event(noSchema), event(payload, { id: 13, data: false })];
    const errors = assertPersistableQueue(events, ctx);
    expect(() => assertPersistableQueueOrThrow(events, ctx)).toThrow('des-snapshot-contract');
    try {
      assertPersistableQueueOrThrow(events, ctx);
    } catch (error) {
      expect(error).toMatchObject({ ...errors[0], errors });
    }
  });
});
