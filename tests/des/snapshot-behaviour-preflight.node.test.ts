// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, Object3D, Scene } from 'three';
import '../../src/behaviors/Conveyor';
import '../../src/behaviors/ChainTransfer';
import '../../src/behaviors/Turntable';
import { runnerFixture } from './runner-fixture';
import { freezeWorld } from './continuation-freeze-world';
import { rejectSnapshotWithoutMutation } from './snapshot-preflight-helpers';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

function world(type: 'Conveyor' | 'ChainTransfer' | 'Turntable') {
  const scene = new Scene();
  const add = (name: string, kind: string, props = {}) => {
    const node = new Object3D(); node.name = name;
    node.userData.realvirtual = { [kind]: props }; scene.add(node); return node;
  };
  add('Source', 'Source', { AutomaticGeneration: false, Interval: 10000 });
  const root = add('Subject', type);
  for (const name of type === 'ChainTransfer' ? ['Transport-X', 'Transport-Z'] : ['Transport-X']) {
    const mesh = new Mesh(new BoxGeometry(1, 0.1, 1)); mesh.name = name; root.add(mesh);
  }
  for (const name of ['Sensor', ...(type === 'ChainTransfer' ? ['Drive-Lin-Y'] : type === 'Turntable' ? ['Drive-Rot-Y'] : [])]) {
    const node = new Object3D(); node.name = name; root.add(node);
  }
  const gateRoot = add('Gate', 'Station', { ProcessingTime: 10000 }); gateRoot.position.z = 1;
  for (const [owner, name, z] of [[root, 'Snap-ZP-convroll', 0.5], [gateRoot, 'Snap-ZN-convroll', -0.5]] as const) {
    const snap = new Object3D(); snap.name = name; snap.position.z = z; owner.add(snap);
  }
  const f = runnerFixture(scene);
  const [source, subject, gate] = ['Source', 'Subject', 'Gate'].map(n => f.components.find(c => c.node.name === n)!);
  source.nextComponents = [subject]; subject.previousComponents = [source];
  subject.nextComponents = [gate]; gate.previousComponents = [subject];
  f.runner.start([], { root: scene, host: f.host });
  subject.MaxCapacity = 3;
  expect(gate.acceptMU(f.runner.createMU())).toBe(true);
  expect(subject.acceptMU(f.runner.createMU())).toBe(true);
  return { ...f, subject };
}

type Transit = { muRef: { id: number; gen: number } };
type SavedState = { transit?: Transit[]; transitMUs?: Transit[]; blocked?: Transit[]; blockedMUs?: Transit[]; [key: string]: unknown };
function behaviour(snapshot: DESSnapshotV4): SavedState {
  const part = snapshot.parts.find(p => p.state && typeof p.state === 'object' && 'behaviourState' in p.state);
  expect(part).toBeDefined();
  return (part!.state as { behaviourState: SavedState }).behaviourState;
}

function rejectWithoutMutation(type: Parameters<typeof world>[0], mutate: (snapshot: DESSnapshotV4, state: SavedState) => void, error?: RegExp) {
  const f = world(type);
  const before = f.runner.fullSnapshot();
  const snapshot: DESSnapshotV4 = JSON.parse(JSON.stringify(before));
  const held = f.components.map(c => [...c.heldMUs]);
  const reset = vi.spyOn(f.runner, 'reset');
  const time = f.manager.currentTime, count = f.manager.muCount;
  mutate(snapshot, behaviour(snapshot));
  expect(() => f.runner.restoreFull(snapshot)).toThrow(error);
  expect(reset).not.toHaveBeenCalled();
  expect(f.runner.fullSnapshot()).toEqual(before);
  expect(f.manager.currentTime).toBe(time);
  expect(f.manager.muCount).toBe(count);
  f.components.forEach((c, i) => {
    expect(c.heldMUs).toEqual(held[i]);
    held[i].forEach((mu, j) => {
      expect(c.heldMUs[j]).toBe(mu);
      expect(f.manager.getMU(mu.id)).toBe(mu);
    });
  });
}

for (const type of ['Conveyor', 'ChainTransfer', 'Turntable'] as const) {
  it(`${type}: rejects malformed behaviour state before resetting the live run`, () => {
    rejectWithoutMutation(type, (_snapshot, s) => {
      if (type === 'Conveyor') s.partAtSensor = 'true';
      else if (type === 'ChainTransfer') s.transitMUs = 'bad' as unknown as Transit[];
      else s.beltCalibrated = 'false';
    });
  });
}
function arrival(s: DESSnapshotV4, t: Transit[]) {
  return s.eventQueue.find(e => e.muId === t[0].muRef.id && e.action.endsWith('.Arrival'))!;
}
for (const type of ['Conveyor', 'ChainTransfer'] as const) {
  for (const list of ['blocked', 'transit'] as const) {
    it(`${type}: rejects a foreign component's MU in ${list} before mutating the live run`, () => {
      rejectWithoutMutation(type, (snapshot, state) => {
        const gate = snapshot.parts.find(p => p.key === '#Gate@Station')!.state as { muIds: number[] };
        const mus = snapshot.parts.find(p => p.key === 'des.mus')!.state as { records: { id: number; generation: number }[] };
        const foreign = mus.records.find(mu => mu.id === gate.muIds[0])!;
        expect(foreign).toBeDefined();
        const ref = { muRef: { id: foreign.id, gen: foreign.generation } };
        const transit = (type === 'Conveyor' ? state.transit : state.transitMUs)!;
        const blocked = (type === 'Conveyor' ? state.blocked : state.blockedMUs)!;
        expect(transit).toHaveLength(1);
        if (list === 'blocked') blocked.push(ref);
        else {
          // Keep the Arrival anchor valid so only component ownership rejects the ref.
          arrival(snapshot, transit).muId = foreign.id;
          transit[0] = ref;
        }
      }, /Unknown or unowned/);
    });
  }
  const cases: Record<string, (snapshot: DESSnapshotV4, state: SavedState, transit: Transit[], blocked: Transit[]) => void> = {
    'missing Arrival in queue and frozen': (s, _b, t) => { s.eventQueue = s.eventQueue.filter(e => e.muId !== t[0].muRef.id); },
    'wrong component': (s, _b, t) => { const e = arrival(s, t); e.componentId = s.fingerprint.components.find(c => c.id !== e.componentId)!.id; },
    'wrong MU': (s, _b, t) => { arrival(s, t).muId = 999999; },
    'wrong action': (s, _b, t) => { arrival(s, t).action = 'MF.Conveyor.Accept'; },
    'duplicate transit MU': (_s, _b, t) => { t.push({ ...t[0] }); },
    'duplicate blocked MU': (s, _b, t, b) => { s.eventQueue = s.eventQueue.filter(e => e.muId !== t[0].muRef.id); b.push({ ...t[0] }, { ...t[0] }); t.length = 0; },
    'blocked/transit overlap': (_s, _b, t, b) => { b.push({ ...t[0] }); },
    'unknown MU': (_s, _b, t) => { t[0].muRef.id = 999999; },
    'unknown MU generation': (_s, _b, t) => { t[0].muRef.gen++; },
    'payload MU conflicting with the event MU': (s, _b, t) => {
      const gate = s.parts.find(p => p.key === '#Gate@Station')!.state as { muIds: number[] };
      const e = arrival(s, t);
      e.data = { ...(e.data as object), muId: gate.muIds[0] } as typeof e.data;
    },
    'Arrival without transit': (_s, _b, t) => { t.length = 0; },
    'duplicate queue Arrival with distinct ID': (s, _b, t) => { s.eventQueue.push({ ...arrival(s, t), id: s.nextEventId++ }); },

  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(`${type}: rejects ${name} without changing the live run`, () => {
      rejectWithoutMutation(type, (snapshot, state) => {
        const transit = (type === 'Conveyor' ? state.transit : state.transitMUs)!;
        const blocked = (type === 'Conveyor' ? state.blocked : state.blockedMUs)!;
        expect(transit).toHaveLength(1);
        mutate(snapshot, state, transit, blocked);
      });
    });
  }
}
for (const [key, value] of [['lastCommandedAngle', 'bad'], ['beltNeutralAngle', null], ['lastInputPort', -1], ['lastOutputPort', false]] as const) {
  it(`Turntable: rejects invalid ${key} without changing the live run`, () => {
    rejectWithoutMutation('Turntable', (_snapshot, state) => { state[key] = value; });
  });
}

for (const type of ['Conveyor', 'ChainTransfer', 'Turntable'] as const) {
  it(`${type}: accepts the unmodified live snapshot`, () => {
    const f = world(type);
    const snapshot = f.runner.fullSnapshot();
    expect(() => f.runner.restoreFull(JSON.parse(JSON.stringify(snapshot)))).not.toThrow();
    expect(f.runner.fullSnapshot()).toEqual(snapshot);
  });
}

for (const type of ['Conveyor', 'ChainTransfer'] as const) {
  type FrozenDescriptor = { action: string; muRef: { id: number; gen: number } | null };
  type FrozenState = { frozen: FrozenDescriptor[]; behaviourState: SavedState };
  const cases: Record<string, (s: DESSnapshotV4, state: FrozenState, transit: Transit[]) => void> = {
    'missing frozen Arrival': (_s, state) => { state.frozen = []; },
    'duplicate frozen Arrival': (_s, state) => { state.frozen.push(structuredClone(state.frozen[0])); },
    'foreign frozen action': (_s, state) => { state.frozen[0].action = type === 'Conveyor' ? 'MF.ChainTransfer.Arrival' : 'MF.Conveyor.Arrival'; },
    'foreign frozen MU generation': (_s, state) => { state.frozen[0].muRef!.gen++; },
    'null frozen Arrival MU': (_s, state) => { state.frozen[0].muRef = null; },
    'frozen Arrival without transit': (_s, _state, transit) => { transit.length = 0; },
    'frozen blocked/transit overlap': (_s, state, transit) => {
      (type === 'Conveyor' ? state.behaviourState.blocked! : state.behaviourState.blockedMUs!).push(structuredClone(transit[0]));
    },
    'Arrival in both queue and frozen': (s, state, transit) => {
      s.eventQueue.push({ id: s.nextEventId++, time: s.simTime + 1, priority: 0,
        action: state.frozen[0].action, componentId: `#Transfer@${type}`, muId: transit[0].muRef.id, data: null });
    },
    'frozen Arrival moved to foreign component': (s, state) => {
      const other = s.parts.find(p => p.key === '#Station@Station')!;
      (other.state as unknown as { frozen: FrozenDescriptor[] }).frozen = state.frozen;
      state.frozen = [];
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    it(`${type}: rejects ${name} before mutating frozen live state`, async () => {
      const w = freezeWorld(type);
      try {
        await w.step(10);
        const before = w.runner.fullSnapshot();
        const saved: DESSnapshotV4 = JSON.parse(JSON.stringify(before));
        const state = saved.parts.find(p => p.key === `#Transfer@${type}`)!.state as unknown as FrozenState;
        const transit = (type === 'Conveyor' ? state.behaviourState.transit : state.behaviourState.transitMUs)!;
        expect(state.frozen).toHaveLength(1);
        expect(transit).toHaveLength(1);
        mutate(saved, state, transit);
        rejectSnapshotWithoutMutation(w.runner, before, saved);
      } finally { w.dispose?.(); }
    });
  }
}
