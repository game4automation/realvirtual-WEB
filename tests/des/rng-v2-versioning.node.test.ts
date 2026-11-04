// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESManager } from '../../src/plugins/des/rv-des-manager';
import { RngStreamHandle } from '../../src/core/rv-rng-streams';
import { captureStreamsDoc, validateStreamsDoc, type RngStreamsDoc } from '../../src/plugins/des/rv-des-rng-state';
import { runnerFixture } from './runner-fixture';
import type { SnapshotJson } from '../../src/plugins/des/rv-snapshot-contract';
import { partState } from './snapshot-test-utils';

function manager(version: 1 | 2) {
  const m = new DESManager();
  m.setRngVersion(version);
  return m;
}
function world(version: 1 | 2) {
  const root = new Object3D(); root.name = 'Plant';
  const node = new Object3D(); node.name = 'Station';
  node.userData.realvirtual = { Station: { ProcessingTime: 1 } }; root.add(node);
  const f = runnerFixture(root);
  f.manager.setRngVersion(version);
  f.runner.start([], { root, host: f.host });
  return f;
}
const observe = (m: DESManager) => ({ snapshot: m.snapshot(), queue: m.getEventQueueSnapshot(),
  streamCount: m.streamEntries().length, streamStates: m.streamEntries().map(h => h.getState()) });

describe('RNG snapshot versioning', () => {
  it.each([1, 2] as const)('manager v%s continues exactly and preserves handles', version => {
    const m = manager(version);
    try {
      m.rng.next();
      const saved = m.snapshot();
      const expected = [m.rng.next(), m.rng.next()];
      const late = version === 2 ? m.stream('late', 'repair') : undefined;
      late?.next();
      m.restore(saved);
      expect([m.rng.next(), m.rng.next()]).toEqual(expected);
      if (late) {
        expect(m.stream('late', 'repair')).toBe(late);
        const pristine = new RngStreamHandle(saved.masterSeed, 'late', 'repair');
        expect([late.next(), late.next()]).toEqual([pristine.next(), pristine.next()]);
      }
    } finally { m.dispose(); }
  });

  it.each([1, 2] as const)('rejects invalid and mismatched versions without mutation in v%s', version => {
    const m = manager(version), other = manager(version === 1 ? 2 : 1);
    try {
      const saved = m.snapshot();
      const { rngVersion: _version, ...missing } = saved;
      const before = observe(m);
      for (const bad of [missing, { ...saved, rngVersion: 99 }, { ...saved, rngVersion: 1.5 }, other.snapshot()]) {
        expect(() => m.restore(bad as typeof saved)).toThrow(/rng-version-/);
        expect(observe(m)).toEqual(before);
      }
    } finally { m.dispose(); other.dispose(); }
  });

  it('rejects corrupt stream documents before manager mutation', () => {
    const m = manager(2);
    try {
      m.stream('a|b', 'c').next(); m.stream('a', 'b|c').next();
      const saved = m.snapshot();
      expect(validateStreamsDoc(saved.rngStreams, { knownId: () => true }).streams).toHaveLength(2);
      const mutations: Array<(doc: RngStreamsDoc) => void> = [
        d => { d.streams[0].seedKey64 = '0000000000000000'; },
        d => { d.streams.push(d.streams[0]); },
        ...[-1, 2 ** 32, 0.5].map(v => (d: RngStreamsDoc) => { d.streams[0].state.a = v; }),
      ];
      const before = observe(m);
      for (const mutate of mutations) {
        const bad = structuredClone(saved); mutate(bad.rngStreams!);
        expect(() => m.restore(bad)).toThrow();
        expect(observe(m)).toEqual(before);
      }
    } finally { m.dispose(); }
  });

  it('rejects conflicting manager seeds, including empty stream documents, unchanged', () => {
    const m = manager(2);
    try {
      m.rng.next(); m.stream('retained', 'probe').next();
      m.scheduleEventByIndex(25, 0, -1);
      const saved = m.snapshot();
      const before = observe(m);
      for (const empty of [false, true]) {
        const bad = structuredClone(saved);
        bad.currentTime = 10;
        bad.masterSeed += 1;
        if (empty) bad.rngStreams!.streams = [];
        expect(() => m.restore(bad)).toThrow('RNG masterSeed differs from the des.manager masterSeed');
        expect(observe(m)).toEqual(before);
      }
    } finally { m.dispose(); }
  });

  it('rejects a non-finite manager seed before adding missing streams or mutating state', () => {
    const m = manager(2), source = manager(2);
    try {
      m.rng.next(); m.stream('retained', 'probe').next();
      m.scheduleEventByIndex(25, 0, -1);
      source.stream('missing', 'repair').next();
      const bad = source.snapshot();
      bad.currentTime = 10; bad.masterSeed = NaN;
      const before = observe(m);
      expect(() => m.restore(bad)).toThrow();
      expect(observe(m)).toEqual(before);
    } finally { m.dispose(); source.dispose(); }
  });

  it.each([1, 2] as const)('rejects malformed legacy RNG state unchanged in v%s', version => {
    const m = manager(version);
    try {
      m.rng.next(); m.scheduleEventByIndex(25, 0, -1);
      const saved = m.snapshot();
      const before = observe(m);
      const bad = { ...saved, currentTime: 10, rngState: [1, 2, 3] };
      expect(() => m.restore(bad as typeof saved)).toThrow('rng-state-invalid');
      expect(observe(m)).toEqual(before);
    } finally { m.dispose(); }
  });

  it('rejects a conflicting full-snapshot RNG seed before mutation and restores consistent seeds', () => {
    const f = world(2);
    const id = f.runner.liveInstances[0].desId!;
    const held = f.manager.stream(id, 'probe'); held.next();
    const saved = f.runner.fullSnapshot();
    const expected = held.next();
    f.manager.processAnimated(1);
    const before = observe(f.manager);
    const bad = structuredClone(saved);
    const doc = partState<RngStreamsDoc>(saved, 'des.rng');
    bad.parts.find(p => p.key === 'des.rng')!.state = {
      masterSeed: doc.masterSeed + 1, streams: [],
    };
    expect(() => f.runner.restoreFull(bad)).toThrow('RNG masterSeed differs from the des.manager masterSeed');
    expect(observe(f.manager)).toEqual(before);
    f.runner.restoreFull(saved);
    expect(f.manager.currentTime).toBe(saved.simTime);
    expect(f.manager.stream(id, 'probe')).toBe(held);
    expect(held.next()).toBe(expected);
  });

  it('restores full v2 snapshots into retained handles, including late purposes', () => {
    const f = world(2);
    const id = f.runner.liveInstances[0].desId!;
    const held = f.manager.stream(id, 'probe'); held.next();
    const others = ['failure', 'repair'].map(purpose => f.manager.stream(id, purpose));
    others.forEach(h => h.next());
    const states = others.map(h => h.getState());
    const saved = f.runner.fullSnapshot();
    const expected = held.next();
    others.forEach(h => h.next());
    const late = f.manager.stream(id, 'late'); late.next();
    f.runner.restoreFull(saved);
    expect(f.manager.stream(id, 'probe')).toBe(held);
    expect(held.next()).toBe(expected);
    expect(others.map(h => h.getState())).toEqual(states);
    expect(late.next()).toBe(new RngStreamHandle(f.manager.masterSeed, id, 'late').next());
  });

  it.each([1, 2] as const)('rejects foreign fingerprints before mutation in v%s', version => {
    const f = world(version), other = world(version === 1 ? 2 : 1);
    const before = observe(f.manager);
    const foreign = other.runner.fullSnapshot();
    const unknown = structuredClone(f.runner.fullSnapshot());
    Object.assign(unknown.fingerprint, { rngVersion: 99 });
    for (const bad of [foreign, unknown]) {
      expect(() => f.runner.restoreFull(bad)).toThrow(/fingerprint/);
      expect(observe(f.manager)).toEqual(before);
    }
  });

  // plan-2059 (Thomas 2026-11-01): runConfig (seed, warm-up, run length) is NOT compared on restore, but the RNG
  // version must still match: it is its own top-level fingerprint field (`fingerprint.rngVersion`), compared by
  // the preflight next to modelHash, and it is not part of runConfigHash. A restore under changed run
  // parameters therefore works, while the same restore under another RNG version is refused.
  it.each([1, 2] as const)('ignores run parameters but still enforces the RNG version on restore (v%s)', version => {
    const f = world(version), other = world(version === 1 ? 2 : 1);
    const saved = f.runner.fullSnapshot();
    const foreign = other.runner.fullSnapshot();
    expect(saved.fingerprint.rngVersion).toBe(version);
    f.manager.statResetTime = 7;
    f.manager.duration = 4321;
    f.manager.processAnimated(1);
    expect(() => f.runner.restoreFull(saved)).not.toThrow();
    expect(f.manager.currentTime).toBe(saved.simTime);
    f.manager.statResetTime = 9;
    const before = observe(f.manager);
    expect(() => f.runner.restoreFull(foreign)).toThrow(/rngVersion mismatch/);
    expect(observe(f.manager)).toEqual(before);
  });

  it('rejects v1-shaped and corrupt v2 participant states before mutation', () => {
    const f = world(2);
    f.manager.rng.next();
    const saved = f.runner.fullSnapshot();
    const before = observe(f.manager);
    for (const state of [{ rngStates: {} }, { ...partState<RngStreamsDoc>(saved, 'des.rng'),
      streams: [{ id: '__manager__', purpose: 'default', seedKey64: 'bad', state: {} }] }]) {
      const bad = structuredClone(saved);
      bad.parts.find(p => p.key === 'des.rng')!.state = state as unknown as SnapshotJson;
      expect(() => f.runner.restoreFull(bad)).toThrow();
      expect(observe(f.manager)).toEqual(before);
    }
  });

  it('sorts by code units and rejects unknown ids and malformed shapes', () => {
    const doc = captureStreamsDoc(42, [new RngStreamHandle(42, 'z', ''), new RngStreamHandle(42, 'A', '')]);
    expect(doc.streams.map(s => s.id)).toEqual(['A', 'z']);
    for (const raw of [null, [], {}, { rngStates: {} }, { ...doc, masterSeed: Infinity }]) {
      expect(() => validateStreamsDoc(raw, { knownId: () => true })).toThrow();
    }
    expect(() => validateStreamsDoc(doc, { knownId: () => false })).toThrow();
  });
});
