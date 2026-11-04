// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { scriptParticipants, scriptTimerHandleRefs, scriptTimerQueueProblems } from '../../src/plugins/des/rv-des-script-participant';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { preflightSnapshot, type PreflightContext } from '../../src/plugins/des/rv-des-preflight';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

function fixture() {
  const timers = { next: 3, items: [-1, -2].map((pid, i) => ({
    pid, interval: 1, hook: 'beat', data: null, current: i + 1,
  })) };
  const fingerprint = { schemaVersion: 4 as const, rngVersion: 2, modelHash: 'same', runConfigHash: 'run',
    components: [{id: 's', type: 'Script'}, {id: 'other', type: 'Script'}] };
  const raw: DESSnapshotV4 = { version: 4, fingerprint, simTime: 0, nextEventId: 3,
    muIds: [], parts: [{key: 's', version: 1, state: {rng: 1, timers}},
      {key: 'other', version: 1, state: {rng: 1, timers: {next: 1, items: []}}}],
    eventQueue: timers.items.map(t => ({id: t.current, time: 1, priority: 0, muId: -1,
      componentId: 's', action: 'Script.Hook',
      data: {hook: '__rv.every', desId: 's', mu: null, data: {pid: t.pid}}})),
  };
  const registry = new SnapshotRegistry();
  const calls: string[] = [];
  scriptParticipants(registry, ['s', 'other'].map(desId => ({desId, path: desId, adapter: {
    captureScriptState: () => ({rng: 1, timers: {next: 1, items: []}}),
    restoreScriptState: () => { calls.push(desId); },
  }})));
  const ctx: PreflightContext = {fingerprint,
    participants: new Map(registry.order().map(p => [p.key, p])),
    componentTypeOf: id => fingerprint.components.find(c => c.id === id)?.type,
    getActionSchema: () => ({owner: 'component', payload: () => []}),
    handleRefs: parts => scriptTimerHandleRefs(parts, new Set(['s', 'other'])),
    queueChecks: (events, parts) => scriptTimerQueueProblems(events, parts, new Set(['s', 'other'])),
  };
  return {raw, ctx, calls};
}
it('enumerates every timer and accepts valid slices without mutation', () => {
  const {raw, ctx, calls} = fixture();
  const before = structuredClone(raw);
  expect(ctx.handleRefs!(raw.parts).map(r => r.eventId)).toEqual([1, 2]);
  expect(preflightSnapshot(raw, ctx)).toEqual({ok: true});
  expect(raw).toEqual(before);
  expect(calls).toEqual([]);
});
it.each(['swapped', 'missing', 'foreign', 'pid', 'hook', 'action'])('refuses %s before mutation', kind => {
  const {raw, ctx, calls} = fixture();
  if (kind === 'swapped') [raw.eventQueue[0].id, raw.eventQueue[1].id] = [2, 1];
  if (kind === 'missing') raw.eventQueue.shift();
  if (kind === 'foreign') raw.eventQueue[0].componentId = 'other';
  if (kind === 'pid') raw.eventQueue[0].data = {hook: '__rv.every', desId: 's', mu: null, data: {pid: -99}};
  if (kind === 'hook') raw.eventQueue[0].data = {hook: 'beat', desId: 's', mu: null, data: {pid: -1}};
  if (kind === 'action') raw.eventQueue[0].action = 'Other';
  const before = structuredClone(raw);
  expect(preflightSnapshot(raw, ctx)).toMatchObject({ok: false,
    problems: expect.arrayContaining([expect.objectContaining({reason: expect.stringContaining('event handle')})])});
  expect(raw).toEqual(before);
  expect(calls).toEqual([]);
});

it.each(['duplicate', 'orphan'])('refuses a %s timer slice before mutation (review: reverse ownership)', kind => {
  const {raw, ctx, calls} = fixture();
  raw.eventQueue.push({...raw.eventQueue[0], id: 9, data: {hook: '__rv.every', desId: 's', mu: null,
    data: {pid: kind === 'duplicate' ? -1 : -77}}});
  raw.nextEventId = 10;
  const before = structuredClone(raw);
  expect(preflightSnapshot(raw, ctx)).toMatchObject({ok: false,
    problems: expect.arrayContaining([expect.objectContaining({reason: expect.stringContaining('not owned by exactly one timer')})])});
  expect(raw).toEqual(before);
  expect(calls).toEqual([]);
});

it.each([
  {next: 0, items: []},
  {next: 2, items: [{pid: -2, interval: 1, hook: 'beat', data: null, current: 1}]},
  {next: 2, items: [{pid: -1, interval: 1, hook: 'beat', data: null, current: -1}]},
])('rejects malformed timer tables in prepare', timers => {
  const registry = new SnapshotRegistry();
  scriptParticipants(registry, [{desId: 's', path: 's', adapter: {
    captureScriptState: () => ({rng: 1, timers: {next: 1, items: []}}),
    restoreScriptState: () => { throw new Error('must not apply'); },
  }}]);
  expect(() => registry.order()[0].prepare({rng: 1, timers})).toThrow('invalid script timer');
});
