// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { preflightSnapshot, type PreflightContext } from '@rv/plugins/des/rv-des-preflight';
import { isV4Envelope, type DESSnapshotV4 } from '@rv/plugins/des/rv-des-snapshot-v4';
import { registerAction, getActionSchema, type ActionSchema } from '@rv/plugins/des/rv-des-named-actions';

const action = 'Snapshot.Preflight.C.Tick';
const schema: ActionSchema = { owner: 'component', targetType: 'Conveyor', payload: 'none' };
registerAction(action, () => {}, schema);
const payloadSchema: ActionSchema = {
  owner: 'component', targetType: 'Conveyor',
  payload: data => data !== null && typeof data === 'object' && !Array.isArray(data)
    && typeof data.count === 'number' && data.count > 0 ? [] : ['count must be positive'],
};
const fingerprint = {
  schemaVersion: 4 as const, rngVersion: 2, modelHash: 'same-model', runConfigHash: 'run',
  components: [{ id: 'belt', type: 'Conveyor' }],
};
function snapshot(): DESSnapshotV4 {
  return {
    version: 4, fingerprint: structuredClone(fingerprint), simTime: 5, nextEventId: 2,
    eventQueue: [{ id: 1, time: 6, action, componentId: 'belt', muId: 7, priority: 0, data: null }],
    muIds: [7], parts: [{ key: 'belt', version: 1, state: { handle: 1 } }],
  };
}
function context(extra: Partial<PreflightContext> = {}): PreflightContext {
  return {
    fingerprint, participants: new Map([['belt', { version: 1, validate: () => [] }]]),
    componentTypeOf: id => id === 'belt' ? 'Conveyor' : undefined,
    getActionSchema,
    handleRefs: parts => [{ participant: 'belt', path: 'handle',
      eventId: (parts.find(p => p.key === 'belt')?.state as { handle?: number })?.handle ?? -1,
      action, owner: 'belt' }],
    ...extra,
  };
}
function reasons(raw: unknown, ctx = context()): string[] {
  const result = preflightSnapshot(raw, ctx);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.problems.map(p => `${p.path}: ${p.reason}`);
}

describe('v4 snapshot preflight', () => {
  it('accepts a valid snapshot and does not mutate it', () => {
    const raw = snapshot();
    const before = structuredClone(raw);
    expect(isV4Envelope(raw)).toBe(true);
    expect(preflightSnapshot(raw, context())).toEqual({ ok: true });
    expect(raw).toEqual(before);
  });

  const invalid: Array<{ label: string; change: (s: DESSnapshotV4) => void; reason: string }> = [
    { label: 'missing queue', change: s => { Reflect.deleteProperty(s, 'eventQueue'); }, reason: 'eventQueue' },
    { label: 'past event', change: s => { s.eventQueue[0].time = 4; }, reason: 'simTime' },
    { label: 'unknown action', change: s => { s.eventQueue[0].action = 'not-registered'; }, reason: 'schema' },
    { label: 'wrong payload', change: s => { s.eventQueue[0].data = { count: -1 }; }, reason: 'no payload' },
    { label: 'unknown component', change: s => { s.eventQueue[0].componentId = 'missing'; }, reason: 'unknown component' },
    { label: 'unknown MU', change: s => { s.eventQueue[0].muId = 8; }, reason: 'unknown MU' },
    { label: 'duplicate MU', change: s => { s.muIds.push(7); }, reason: 'duplicate MU' },
    { label: 'invalid MU', change: s => { s.muIds.push(-1, 0.5); }, reason: 'non-negative' },
    { label: 'missing participant', change: s => { s.parts = []; }, reason: 'missing participant' },
    { label: 'unknown participant', change: s => { s.parts.push({ key: 'other', version: 1, state: null }); }, reason: 'unknown participant' },
    { label: 'duplicate participant', change: s => { s.parts.push(structuredClone(s.parts[0])); }, reason: 'duplicate participant' },
    { label: 'participant version', change: s => { s.parts[0].version = 2; }, reason: 'version mismatch' },
    { label: 'missing handle event', change: s => { s.parts[0].state = { handle: 99 }; }, reason: 'event handle' },
    { label: 'duplicate event', change: s => { s.eventQueue.push({ ...s.eventQueue[0] }); }, reason: 'duplicate event' },
    { label: 'ID at counter', change: s => { s.nextEventId = 1; }, reason: 'nextEventId' },
    { label: 'negative clock', change: s => { s.simTime = -1; }, reason: 'simTime' },
  ];
  it.each(invalid)('rejects $label without mutation', ({ change, reason }) => {
    const raw = snapshot();
    change(raw);
    const before = structuredClone(raw);
    expect(reasons(raw).join('; ')).toContain(reason);
    expect(raw).toEqual(before);
  });

  it('collects independent problems despite a valid fingerprint', () => {
    const raw = snapshot();
    raw.eventQueue[0].time = 0;
    raw.eventQueue[0].action = 'unknown';
    raw.eventQueue[0].muId = 99;
    raw.parts = [];
    const all = reasons(raw).join('; ');
    for (const reason of ['simTime', 'schema', 'unknown MU', 'missing participant']) expect(all).toContain(reason);
  });

  it('honors injected payload schemas and participant validators', () => {
    const raw = snapshot();
    raw.eventQueue[0].data = { count: -1 };
    expect(reasons(raw, context({ getActionSchema: () => payloadSchema })).join('; ')).toContain('count must be positive');
    raw.eventQueue[0].data = { count: 1 };
    expect(preflightSnapshot(raw, context({ getActionSchema: () => payloadSchema }))).toEqual({ ok: true });
    expect(reasons(snapshot(), context({ participants: new Map([
      ['belt', { version: 1, validate: () => ['invalid participant state'] }],
    ]) })).join('; ')).toContain('invalid participant state');
  });

  it('checks injected target, owner and non-persistent schemas', () => {
    for (const [injected, reason] of [
      [{ ...schema, targetType: 'Source' }, 'target type'],
      [{ ...schema, owner: 'missing-system' }, 'not registered'],
      ['non-persistent', 'non-persistent'],
    ] as const) expect(reasons(snapshot(), context({ getActionSchema: () => injected })).join('; ')).toContain(reason);
    expect(reasons(snapshot(), context({ getActionSchema: () => undefined })).join('; ')).toContain('schema');
  });

  it('rejects handles for a foreign owner or different action', () => {
    for (const ref of [{ action, owner: 'other' }, { action: 'other', owner: 'belt' }])
      expect(reasons(snapshot(), context({ handleRefs: () => [
        { participant: 'belt', path: 'handle', eventId: 1, ...ref },
      ] })).join('; ')).toContain('event handle');
  });

  it('resolves a system event owner through its action schema', () => {
    const raw = snapshot();
    raw.eventQueue[0].componentId = null;
    expect(preflightSnapshot(raw, context({
      getActionSchema: () => ({ owner: 'belt', payload: 'none' }),
    }))).toEqual({ ok: true });
  });

  it('accepts empty queues and the -1 handle and MU sentinels', () => {
    const raw = snapshot();
    raw.eventQueue = []; raw.nextEventId = 0; raw.muIds = []; raw.parts[0].state = { handle: -1 };
    expect(preflightSnapshot(raw, context())).toEqual({ ok: true });
    raw.eventQueue = [{ id: 0, time: 5, action, componentId: 'belt', muId: -1, priority: 0 }];
    raw.nextEventId = 1;
    expect(preflightSnapshot(raw, context())).toEqual({ ok: true });
  });

  it('rejects malformed structures and reports validator exceptions', () => {
    for (const raw of [null, [], false, 42, {}, { version: 4 }, { ...snapshot(), parts: null },
      { ...snapshot(), eventQueue: [null] }, { ...snapshot(), muIds: null }])
      expect(preflightSnapshot(raw, context()).ok).toBe(false);
    expect(reasons(snapshot(), context({ participants: new Map([
      ['belt', { version: 1, validate: () => { throw new Error('broken validator'); } }],
    ]) })).join('; ')).toContain('broken validator');
  });

  it.each([
    { components: [], reason: 'missing ID' },
    { components: [{ id: 'belt', type: 'Source' }], reason: 'type changed' },
    { components: [...fingerprint.components, { id: 'unknown', type: 'Source' }], reason: 'unknown ID' },
    { components: fingerprint.components, reason: 'model changed (modelHash)' },
  ])('diagnoses fingerprint mismatch: $reason', ({ components, reason }) => {
    const raw = snapshot();
    raw.fingerprint = { ...raw.fingerprint, components, modelHash: 'changed' };
    const result = preflightSnapshot(raw, context());
    expect(result).toMatchObject({ ok: false, problems: [
      { code: 'des-snapshot-fingerprint', reason: expect.stringContaining(reason) },
    ] });
  });

  it('strictly compares schemaVersion and rngVersion even with identical hashes', () => {
    for (const field of ['schemaVersion', 'rngVersion']) {
      const raw = { ...snapshot(), fingerprint: { ...fingerprint, [field]: 99 } };
      expect(preflightSnapshot(raw, context())).toMatchObject({ ok: false, problems: [
        { code: 'des-snapshot-fingerprint', reason: expect.stringContaining(field) },
      ] });
    }
  });
});
