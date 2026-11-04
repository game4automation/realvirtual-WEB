// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fleetDispatcherParticipant, snapshotOrderIds } from '../../src/plugins/fleet-job-participants';
import { dispatcherFixture, dispatchEnv, vehicles } from './fleet-dispatcher-fixture';

describe('FleetDispatcher state', () => {
  it('round trips all parts, resolves the swapped pool and continues silently', () => {
    let calls = 0;
    const d = dispatcherFixture(() => { calls++; });
    d.orders.add({ source: 's0', mu: 'mu', latest: 1 }, 0);
    d.dispatch(vehicles, dispatchEnv);
    d.storage('g').commitStore('s3', 'stored', 2);
    d.storage('g').reserveRetrieve('retriever');
    d.storage('g').reserveStore('storer');
    d.chargerQueue.push('queued');
    const state = d.exportState(), orders = d.orders.exportState();
    const old = d.jobOf('v');
    const prepared = d.prepareState(state);
    state.chargerQueue.push('alias');
    d.orders.swapState(d.orders.prepareState(orders));
    d.swapState(prepared);
    expect(calls).toBe(1);
    expect(d.chargerQueue).toEqual(['queued']);
    const job = d.jobOf('v');
    expect(job).not.toBe(old);
    if (job?.kind !== 'pick') throw new Error('expected pick');
    expect(job.order).toBe(d.orders.orderById(1));
    const twin = dispatcherFixture();
    twin.orders.swapState(twin.orders.prepareState(orders));
    twin.swapState(twin.prepareState(d.exportState()));
    d.picked('v', 6); twin.picked('v', 6);
    d.delivered('v', 7); twin.delivered('v', 7);
    expect(d.dispatch(vehicles, { ...dispatchEnv, t: 8 })).toEqual(twin.dispatch(vehicles, { ...dispatchEnv, t: 8 }));
    expect(d.exportState()).toEqual(twin.exportState());
    expect(calls).toBe(1);
  });
  it('rejects unknown orders, duplicate jobs and unknown stations', () => {
    const d = dispatcherFixture();
    d.orders.add({ source: 's0' }, 0); d.dispatch(vehicles, dispatchEnv);
    const s = d.exportState();
    const j = s.jobs[0];
    if (j.kind !== 'pick') throw new Error('expected pick');
    j.order = 999;
    expect(d.validateState(s).join()).toContain('unknown order');
    j.order = 1; s.jobs.push(structuredClone(j));
    expect(d.validateState(s).join()).toContain('duplicate');
    s.jobs.pop(); j.from = 'missing';
    expect(d.validateState(s).join()).toContain('unknown station');
  });
  it('participant refuses a pick job whose order is not in the snapshot fleet.orders part (in prepare, not at commit)', () => {
    const d = dispatcherFixture();
    d.orders.add({ source: 's0' }, 0); d.dispatch(vehicles, dispatchEnv);
    const state = JSON.parse(JSON.stringify(d.exportState()));
    const ok = fleetDispatcherParticipant(d, snapshotOrderIds({ parts: [{ key: 'fleet.orders', state: d.orders.exportState() }] }));
    expect(ok.validate(state)).toEqual([]);
    const bad = fleetDispatcherParticipant(d, snapshotOrderIds({ parts: [{ key: 'fleet.orders', state: { ...d.orders.exportState(), open: [] } }] }));
    expect(bad.validate(state).join()).toContain('not in fleet.orders');
    expect(() => bad.prepare(state)).toThrow('not in fleet.orders');
    expect(snapshotOrderIds(undefined)).toBeNull();
  });
});
