// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import { RVIKPath } from '../../src/core/engine/rv-ik-path';
import { ikSolverRegistry, type IKTier, type JointChainParams, type OpwParams } from '../../src/core/engine/rv-ik-solver';
import { CoreSubsystems, type CoreSubsystemsHost } from '../../src/core/engine/rv-core-subsystems';
import { DesSnapshotBlockers } from '../../src/core/material-flow/des-snapshot-blockers';
import { ikPathKeyTable, ikSnapshotParticipant, ikSnapshotBlockerReason } from '../../src/plugins/des/rv-des-ik-snapshot';
import { SnapshotRegistry } from '../../src/plugins/des/rv-snapshot-registry';
import { createCaptureSession, toSnapshotData } from '../../src/plugins/des/rv-snapshot-contract';
import type { SnapshotJson } from '../../src/core/sdk/rv-snapshot-contract-types';
import { cycleRunnerFixture } from './cycle-runner-fixture';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVLogicEngine } from '../../src/core/engine/rv-logic-engine';
import { RVSerialContainer, RVSetSignalBool, StepState } from '../../src/core/engine/rv-logic-step';
import { RVIKPathStep } from '../../src/core/engine/rv-ik-path-step';
import { DESRunner } from '../../src/plugins/des/des-runner';

type Fields = Record<string, unknown>;
type Document = { paths: { address: string; pathLength: number; axisCount: number; liveSolve: boolean; state: Fields }[] };
const fields = (owner: object) => owner as Fields;
const node = (name: string) => { const n = new Object3D(); n.name = name; return n; };
const targets = (p: RVIKPath) => fields(p)._path as { node: Object3D; waitForSignalAddr: string; setSignalAddr: string }[];
const axes = (p: RVIKPath) => fields(p)._axisDrives as { currentPosition: number; dynamicAxis: object | null }[];

function world() {
  const robotNode = node('Robot'), addresses = new Map<Object3D, string>();
  const paths = ['A', 'B'].map(name => {
    const p = new RVIKPath(node(name)); addresses.set(p.node, `#${name}`);
    fields(p).Path = []; // Authoring property injected by the real loader's schema mapper.
    fields(p)._path = Array.from({ length: 3 }, (_, i) => ({ node: node(`${name}${i}`),
      waitForSignalAddr: `IO/${name}/wait${i}`, setSignalAddr: `IO/${name}/set${i}` }));
    fields(p)._axisDrives = Array.from({ length: 6 }, (_, i) => ({ currentPosition: i * 17.5, dynamicAxis: null }));
    return p;
  });
  const robot = { node: robotNode, getAxisDrives: () => axes(paths[0]),
    WristType: 'Spherical' as 'Spherical' | 'NonSpherical',
    getOpwParams: (): OpwParams | null => ({ a1: 0, a2: 0, b: 0, c1: 1, c2: 1, c3: 1, c4: 0,
      elbowInUnityX: false, toolOffset: [0, 0, 0] }),
    getJointChain: (): JointChainParams | null => ({ axisHomePos: new Float64Array(18),
      axisHomeRot: new Float64Array(24), axisDir: new Float64Array(18),
      tcpLocalOffset: [0, 0, 0], tcpLocalRot: [0, 0, 0, 1] }),
  };
  for (const p of paths) fields(p)._robot = robot;
  const addressOf = (n: Object3D) => addresses.get(n) ?? null;
  const participant = ikSnapshotParticipant({ paths: () => paths }, addressOf);
  return { paths, robot, addresses, addressOf, participant };
}

function withSolver(run: () => void, maxRobots = Infinity) {
  ikSolverRegistry.register({ tier: 'pro', maxRobots, canBlend: false, solvePieper: () => [] });
  try { run(); } finally { ikSolverRegistry.resetLiveSolveClaims(); ikSolverRegistry.register(null); }
}

function running(w: ReturnType<typeof world>) {
  const [lin, wait] = w.paths;
  Object.assign(fields(lin), {
    PathIsActive: true, PathIsFinished: false, NumTarget: 2, CurrentTarget: targets(lin)[1],
    LastTarget: targets(lin)[0], _linTarget: targets(lin)[1], _runSeq: 7,
    _startSignalValue: true, _startBefore: true, _activeMoving: true, _linActive: true,
    _simTime: 12.375, _waitForStartTimer: -0, _checkNextTargetTimer: -0.125,
    _linDist: 1.234, _linPos: 0.456, _linSpeed: 0.789, _linDecel: true, _observedTarget: 'moved',
  });
  (fields(lin)._linStartPos as Vector3).set(-0, 1.2, -3.4);
  (fields(lin)._linEndPos as Vector3).set(5.6, -7.8, 9.1);
  (fields(lin)._linStartQuat as Quaternion).set(0.1, -0, 0.3, 0.9);
  (fields(lin)._linEndQuat as Quaternion).set(-0.2, 0.4, 0.5, 0.7);
  Object.assign(fields(wait), {
    PathIsActive: true, NumTarget: 3, WaitForSignal: true, CurrentTarget: targets(wait)[2],
    LastTarget: targets(wait)[1], _runSeq: 12, _observedTarget: 'skipped-no-angles',
    _simTime: 12.375, _waitForStartTimer: -0.25, _checkNextTargetTimer: -0,
    _waitSignalAddr: targets(wait)[2].waitForSignalAddr,
    _pendingReset: { addr: targets(wait)[1].setSignalAddr, at: 12.5 },
    _ptpDest: [-0, 20, -30, 40, -50, 60], _ptpRampSpeed: [1, 2, 3, 4, 5, -0],
  });
  expect(ikSolverRegistry.claimLiveSolve(w.robot.node.uuid)).toBe(true);
}

function snapshot(w: ReturnType<typeof world>): Document {
  return JSON.parse(JSON.stringify(toSnapshotData(w.participant.capture(), {
    participant: w.participant.key, ...w.participant.schema,
  }))) as Document;
}
const json = (doc: Document) => doc as unknown as SnapshotJson;
function declared(owner: object, state: readonly string[], services: readonly string[]) {
  const all = [...state, ...services];
  expect(new Set(all).size, 'duplicate classification').toBe(all.length);
  expect(all.slice().sort()).toEqual(Reflect.ownKeys(owner).sort());
}
function sameNumbers(actual: unknown, expected: unknown, label: string): void {
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), label).toBe(true);
    expect((actual as unknown[]).length, label).toBe(expected.length);
    expected.forEach((v, i) => sameNumbers((actual as unknown[])[i], v, `${label}[${i}]`));
  } else if (expected && typeof expected === 'object') {
    for (const [key, value] of Object.entries(expected)) sameNumbers((actual as Fields)[key], value, `${label}.${key}`);
  } else expect(Object.is(actual, expected), label).toBe(true);
}

describe('core.ik snapshots', () => {
  it('declares exactly every own key of real RVIKPath instances', () => {
    const w = world();
    for (const p of w.paths) declared(p, ikPathKeyTable.stateKeys, ikPathKeyTable.services);
    console.log('RVIKPath own keys:', JSON.stringify(Reflect.ownKeys(w.paths[0])));
    expect(w.participant.claimsDrives).toBeUndefined();
    expect(w.participant.dependencies).toEqual(['des.signals', 'des.drives']);
    expect(w.participant.onRestore).toBeUndefined();
  });

  it('round-trips mid-LIN and waiting paths through the real JSON codecs into fresh owners', () => withSolver(() => {
    const a = world(), b = world(); running(a);
    const saved = snapshot(a);
    const instances = b.paths.map(p => Object.fromEntries(Object.entries(ikPathKeyTable.fields)
      .filter(([, type]) => ['vec3', 'quat', 'axes'].includes(type)).map(([key]) => [key, fields(p)[key]])));
    const listener = vi.fn(); b.paths[0].addRunListener(listener);
    const listeners = fields(b.paths[0])._runListeners;
    const prepared = b.participant.prepare(json(saved));
    expect(b.paths[0].PathIsActive).toBe(false);
    expect(ikSolverRegistry.hasLiveSolveClaim(b.robot.node.uuid)).toBe(false);
    b.participant.commit(prepared);
    for (let i = 0; i < a.paths.length; i++) {
      const left = fields(a.paths[i]), right = fields(b.paths[i]);
      for (const [key, type] of Object.entries(ikPathKeyTable.fields)) {
        if (type === 'target') {
          const index = targets(a.paths[i]).indexOf(left[key] as ReturnType<typeof targets>[number]);
          expect(right[key], key).toBe(index < 0 ? null : targets(b.paths[i])[index]);
        } else if (type === 'vec3' || type === 'quat') {
          sameNumbers((right[key] as Vector3).toArray(), (left[key] as Vector3).toArray(), key);
        } else sameNumbers(right[key], left[key], key);
      }
      for (const [key, instance] of Object.entries(instances[i])) expect(right[key], key).toBe(instance);
    }
    expect(fields(b.paths[0])._runListeners).toBe(listeners); expect(listener).not.toHaveBeenCalled();
    expect(ikSolverRegistry.hasLiveSolveClaim(b.robot.node.uuid)).toBe(true);
    expect(snapshot(b)).toEqual(saved);
  }));

  const negatives: [string, (doc: Document) => void][] = [
    ['target index out of range', d => { d.paths[0].state.CurrentTarget = 3; }],
    ['negative target index', d => { d.paths[0].state.LastTarget = -1; }],
    ['NumTarget beyond path', d => { d.paths[0].state.NumTarget = 4; }],
    ['unsafe run sequence', d => { d.paths[0].state._runSeq = Number.MAX_SAFE_INTEGER + 1; }],
    ['path length differs', d => { d.paths[0].pathLength++; }],
    ['axis count differs', d => { d.paths[0].axisCount++; }],
    ['unknown address', d => { d.paths[0].address = '#Unknown'; }],
    ['missing address', d => { delete (d.paths[0] as Partial<Document['paths'][number]>).address; }],
    ['missing owner', d => { d.paths.pop(); }],
    ['unordered addresses', d => { d.paths.reverse(); }],
    ['wrong type', d => { d.paths[0].state.PathIsActive = 1; }],
    ['non-finite timer', d => { d.paths[0].state._simTime = { $num: 'Infinity' }; }],
    ['non-finite reset', d => { d.paths[0].state._pendingReset = { addr: 'IO/A/set0', at: { $num: 'NaN' } }; }],
    ['foreign wait address', d => { d.paths[0].state._waitSignalAddr = 'IO/B/wait0'; }],
    ['foreign reset address', d => { d.paths[0].state._pendingReset = { addr: 'IO/B/set0', at: 1 }; }],
    ['missing state field', d => { delete d.paths[0].state._linSpeed; }],
    ['extra state field', d => { d.paths[0].state.extra = 1; }],
    ['invalid observed target', d => { d.paths[0].state._observedTarget = 'waiting'; }],
    ['invalid vector', d => { d.paths[0].state._linEndPos = [1, 2]; }],
    ['non-finite quaternion', d => { d.paths[0].state._linStartQuat = [0, 0, 0, { $num: 'Infinity' }]; }],
    ['invalid axis array', d => { d.paths[0].state._ptpDest = [1]; }],
    ['LIN without live solve', d => { Object.assign(d.paths[0].state, {
      PathIsActive: true, _linActive: true, _linTarget: 0,
    }); }],
    ['wrong liveSolve type', d => { (d.paths[0] as Fields).liveSolve = 1; }],
  ];
  it.each(negatives)('rejects %s before writing any state', (_name, corrupt) => {
    const w = world(), before = snapshot(w), bad = structuredClone(before); corrupt(bad);
    expect(() => w.participant.prepare(json(bad))).toThrow(/des-snapshot-contract/);
    expect(w.participant.validate(json(bad)).join()).toMatch(/des-snapshot-contract/);
    expect(snapshot(w)).toEqual(before);
  });

  const invalidMotion: [string, Fields, RegExp][] = [
    ['LIN on inactive path', { _linActive: true, _linTarget: 0 }, /active LIN requires active path and target/],
    ['LIN without target', { PathIsActive: true, _linActive: true }, /active LIN requires active path and target/],
    ['inactive LIN with target', { _linTarget: 0 }, /inactive LIN must have no target/],
    ['PTP ramp without destinations', { _ptpRampActive: true }, /active PTP ramp requires axis destinations/],
  ];
  it.each(invalidMotion)('rejects %s before writing or claiming', (_name, state, reason) => withSolver(() => {
    const w = world(), before = snapshot(w), bad = structuredClone(before);
    bad.paths.forEach(p => { p.liveSolve = true; });
    Object.assign(bad.paths[0].state, state);
    expect(() => w.participant.prepare(json(bad))).toThrow(reason);
    expect(w.participant.validate(json(bad)).join()).toMatch(reason);
    expect(snapshot(w)).toEqual(before);
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual([]);
  }));

  it('allows waiting with no signal address and an active PTP ramp with all destinations', () => {
    const w = world(), saved = snapshot(w);
    Object.assign(saved.paths[0].state, { PathIsActive: true, WaitForSignal: true, _waitSignalAddr: null });
    Object.assign(saved.paths[1].state, { PathIsActive: true, _ptpRampActive: true, _ptpDest: [1, 2, 3, 4, 5, 6] });
    w.participant.commit(w.participant.prepare(json(saved)));
    expect(snapshot(w)).toEqual(saved);
  });

  it('detects live topology differences even when indices and PTP arrays are empty', () => {
    const a = world(), b = world(), saved = snapshot(a);
    targets(b.paths[0]).push({ ...targets(b.paths[0])[0] });
    expect(() => b.participant.prepare(json(saved))).toThrow(/path length differs/);
    targets(b.paths[0]).pop(); axes(b.paths[0]).pop();
    expect(() => b.participant.prepare(json(saved))).toThrow(/axis count differs/);
  });

  it('refuses unaddressable owners and foreign target references at capture', () => {
    const w = world(); w.addresses.delete(w.paths[1].node);
    expect(() => w.participant.capture()).toThrow(/des-snapshot-unaddressable/);
    w.addresses.set(w.paths[1].node, '#B');
    fields(w.paths[0]).CurrentTarget = targets(w.paths[1])[0];
    expect(() => w.participant.capture()).toThrow(/des-snapshot-contract.*target is not in path/);
    fields(w.paths[0]).CurrentTarget = null; w.addresses.set(w.paths[1].node, '#A');
    expect(() => w.participant.capture()).toThrow(/duplicate owner address/);
  });

  it('guards every path: a new field on the second owner names core.ik and its address', () => {
    const w = world(), registry = new SnapshotRegistry();
    for (const key of w.participant.dependencies!) registry.register({ key, version: 1, capture: () => ({}),
      validate: () => [], prepare: () => null, commit: () => {} });
    registry.register(w.participant); registry.captureAll(createCaptureSession());
    fields(w.paths[1]).extra = 1;
    expect(() => registry.captureAll(createCaptureSession())).toThrow('des-state-not-declared: core.ik.#B.extra');
    try { registry.captureAll(createCaptureSession()); } catch (error) {
      expect(error).toMatchObject({ code: 'des-state-not-declared', participant: 'core.ik', owner: '#B' });
    }
  });

  it('reports only active paused paths and active dynamic axes, in sorted order', () => {
    const w = world(); fields(w.paths[0])._ownershipPaused = true;
    axes(w.paths[1])[0].dynamicAxis = {};
    expect(ikSnapshotBlockerReason(w.paths, w.addressOf)).toBeNull();
    w.paths.forEach(p => { p.PathIsActive = true; });
    expect(ikSnapshotBlockerReason([...w.paths].reverse(), w.addressOf)).toBe(
      'IK path #A is paused by an axis owner; IK path #B drives dynamic axes');
  });

  it('CoreSubsystems uses the DES seam and retains the active IK fallback when detached', () => {
    const w = world(), blockers = new DesSnapshotBlockers(); w.paths[0].PathIsActive = true;
    const core = new CoreSubsystems({ logicEngine: null, ikPaths: w.paths, playback: null,
      replayRecordings: [], snapshotBlockers: blockers } as unknown as CoreSubsystemsHost);
    try {
      expect(blockers.reasons()).toEqual(['core: active IK path']);
      core.ikSnapshotReason = () => ikSnapshotBlockerReason(w.paths, w.addressOf);
      expect(blockers.reasons()).toEqual([]);
      fields(w.paths[0])._ownershipPaused = true;
      expect(blockers.reasons()).toEqual(['core: IK path #A is paused by an axis owner']);
      core.ikSnapshotReason = null;
      expect(blockers.reasons()).toEqual(['core: active IK path']);
      expect(blockers.batchHazards()).toEqual([{ system: 'IK path', nodes: ['A', 'B'] }]);
    } finally { core.dispose(); }
  });

  it('restores and releases each robot claim once, and rejects disagreement', () => withSolver(() => {
    const a = world(), b = world();
    ikSolverRegistry.claimLiveSolve(a.robot.node.uuid);
    const live = snapshot(a), off = snapshot(b);
    const claim = vi.spyOn(ikSolverRegistry, 'claimLiveSolve'), release = vi.spyOn(ikSolverRegistry, 'releaseLiveSolve');
    try {
      b.participant.commit(b.participant.prepare(json(live)));
      expect(claim).toHaveBeenCalledExactlyOnceWith(b.robot.node.uuid);
      expect(ikSolverRegistry.hasLiveSolveClaim(b.robot.node.uuid)).toBe(true);
      b.participant.commit(b.participant.prepare(json(off)));
      expect(release).toHaveBeenCalledExactlyOnceWith(b.robot.node.uuid);
      expect(ikSolverRegistry.hasLiveSolveClaim(b.robot.node.uuid)).toBe(false);
      live.paths[1].liveSolve = false;
      expect(() => b.participant.prepare(json(live))).toThrow(/robot paths disagree/);
    } finally { claim.mockRestore(); release.mockRestore(); }
  }));

  it('rejects unavailable live solve without claiming or writing', () => withSolver(() => {
    const w = world(), saved = snapshot(w); saved.paths.forEach(p => { p.liveSolve = true; });
    const otherRobot = { ...w.robot, node: node('AnotherRobot') };
    fields(w.paths[1])._robot = otherRobot;
    ikSolverRegistry.claimLiveSolve(otherRobot.node.uuid);
    expect(() => w.participant.prepare(json(saved))).toThrow(/des-snapshot-contract.*live IK solver unavailable/);
    expect(ikSolverRegistry.hasLiveSolveClaim(w.robot.node.uuid)).toBe(false);
    ikSolverRegistry.resetLiveSolveClaims(); ikSolverRegistry.register(null);
    expect(() => w.participant.prepare(json(saved))).toThrow(/live IK solver unavailable/);
  }, 1));

  it('returns a sorted copy of live-solve claim keys', () => withSolver(() => {
    ikSolverRegistry.claimLiveSolve('z'); ikSolverRegistry.claimLiveSolve('a');
    const keys = ikSolverRegistry.liveSolveClaimKeys();
    expect(keys).toEqual(['a', 'z']); keys.pop(); keys.push('foreign');
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual(['a', 'z']);
  }));

  it.each([false, true])('refuses foreign free-tier claims at capture and prepare (liveSolve %s)', liveSolve => withSolver(() => {
    ikSolverRegistry.register({ tier: 'free', maxRobots: 1, canBlend: false, solvePieper: () => [] });
    const source = world(), target = world(), saved = snapshot(source), before = snapshot(target);
    saved.paths.forEach(p => { p.liveSolve = liveSolve; });
    ikSolverRegistry.claimLiveSolve('foreign-robot');
    const reason = 'des-snapshot-contract: core.ik: live IK solve claimed by a robot without IK path';
    expect(() => target.participant.capture()).toThrow(reason);
    expect(() => target.participant.prepare(json(saved))).toThrow(reason);
    expect(target.participant.validate(json(saved))).toEqual([`Error: ${reason}`]);
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual(['foreign-robot']);
    ikSolverRegistry.releaseLiveSolve('foreign-robot');
    expect(snapshot(target)).toEqual(before);
  }));

  it('allows foreign claims at capture and prepare with an infinite budget', () => withSolver(() => {
    const source = world(), target = world(); running(source);
    ikSolverRegistry.claimLiveSolve('foreign-robot');
    const saved = snapshot(source);
    target.participant.commit(target.participant.prepare(json(saved)));
    expect(snapshot(target)).toEqual(saved);
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual(
      ['foreign-robot', source.robot.node.uuid, target.robot.node.uuid].sort());
  }));

  it.each(['pro', 'free'] as IKTier[])('refuses Cobot restore without Cobot capability at tier %s', tier => withSolver(() => {
    const source = world(), target = world(); running(source);
    const saved = snapshot(source), before = snapshot(target);
    target.robot.WristType = 'NonSpherical';
    ikSolverRegistry.resetLiveSolveClaims();
    ikSolverRegistry.register({ tier, maxRobots: tier === 'free' ? 1 : Infinity, canBlend: false, solvePieper: () => [] });
    expect(() => target.participant.prepare(json(saved))).toThrow(/des-snapshot-contract.*live IK solver unavailable/);
    expect(snapshot(target)).toEqual(before);
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual([]);
  }));

  it.each(['robot', 'OPW params', 'axis count', 'joint chain'])('refuses live restore with missing %s', missing => withSolver(() => {
    const source = world(); running(source);
    const lin = snapshot(source).paths[0].state;
    ikSolverRegistry.resetLiveSolveClaims();
    const w = world();
    if (missing === 'robot') fields(w.paths[0])._robot = null;
    if (missing === 'OPW params') vi.spyOn(w.robot, 'getOpwParams').mockReturnValue(null);
    if (missing === 'axis count') axes(w.paths[0]).pop();
    if (missing === 'joint chain') {
      w.robot.WristType = 'NonSpherical';
      ikSolverRegistry.register({ tier: 'pro', maxRobots: Infinity, canBlend: false, solvePieper: () => [], solveCobot: () => [] });
      vi.spyOn(w.robot, 'getJointChain').mockReturnValue(null);
    }
    const before = snapshot(w), saved = structuredClone(before);
    saved.paths.forEach(p => { p.liveSolve = true; });
    saved.paths[0].state = structuredClone(lin);
    expect(() => w.participant.prepare(json(saved))).toThrow(/live IK solver unavailable/);
    expect(snapshot(w)).toEqual(before);
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual([]);
  }));

  it('restores a passive claim (no running LIN) on a free-tier Cobot without Cobot capability', () => withSolver(() => {
    ikSolverRegistry.register({ tier: 'free', maxRobots: 1, canBlend: false, solvePieper: () => [] });
    const source = world(), target = world();
    source.robot.WristType = 'NonSpherical'; target.robot.WristType = 'NonSpherical';
    // The IK target editor claims the slot before it tries to solve; the path itself only replays PTP.
    ikSolverRegistry.claimLiveSolve(source.robot.node.uuid);
    const saved = snapshot(source);
    expect(saved.paths.every(p => p.liveSolve && !p.state._linActive)).toBe(true);
    ikSolverRegistry.resetLiveSolveClaims();
    target.participant.commit(target.participant.prepare(json(saved)));
    expect(ikSolverRegistry.liveSolveClaimKeys()).toEqual([target.robot.node.uuid]);
  }));

  it('keeps the first runner seam when an unbound second runner is disposed', () => {
    const w = world(), f = cycleRunnerFixture({ host: { ikPaths: w.paths } });
    f.scene.add(...w.paths.map(p => p.node)); f.start();
    const reason = f.core!.ikSnapshotReason;
    const second = new DESRunner({ core: f.core });
    second.dispose();
    expect(f.core!.ikSnapshotReason).toBe(reason);
  });

  it('reinstalls a cleared or replaced seam and preserves it when the second runner detaches', () => {
    const w = world(), f = cycleRunnerFixture({ host: { ikPaths: w.paths } });
    f.scene.add(...w.paths.map(p => p.node)); f.start();
    const reason = f.core!.ikSnapshotReason;
    f.core!.ikSnapshotReason = null; f.runner.setCycleTime(0.1);
    expect(f.core!.ikSnapshotReason).toBe(reason);
    const second = new DESRunner({ core: f.core, subMode: 'step' });
    try {
      second.start([], { root: f.scene, host: f.host });
      expect(f.core!.ikSnapshotReason).not.toBe(reason);
      f.runner.setCycleTime(0.2);
      expect(f.core!.ikSnapshotReason).toBe(reason);
    } finally { second.dispose(); }
    expect(f.core!.ikSnapshotReason).toBe(reason);
  });

  it('runner adds core.ik, narrows blockers, and cleans up on removal, clear and dispose', () => {
    const w = world(), f = cycleRunnerFixture({ host: { ikPaths: w.paths } });
    f.scene.add(...w.paths.map(p => p.node)); f.start();
    w.paths[0].PathIsActive = true;
    const saved = f.runner.fullSnapshot();
    expect(saved.parts.find(p => p.key === 'core.ik')?.version).toBe(1);
    expect(saved.parts.some(p => p.key === 'des.drives')).toBe(true);
    expect(saved.parts.some(p => p.key === 'des.signals')).toBe(true);
    fields(w.paths[0])._ownershipPaused = true;
    expect(() => f.runner.fullSnapshot()).toThrow(/IK path #A is paused by an axis owner/);
    expect(() => f.runner.restoreFull(saved)).toThrow(/IK path #A is paused by an axis owner/);
    fields(w.paths[0])._ownershipPaused = false;
    w.paths[0].PathIsActive = false; f.runner.restoreFull(saved);
    expect(w.paths[0].PathIsActive).toBe(true);
    Object.assign(f.host, { ikPaths: [] }); f.runner.setCycleTime(0.1);
    expect(f.core!.ikSnapshotReason).toBeNull();
    expect(f.runner.fullSnapshot().parts.some(p => p.key === 'core.ik')).toBe(false);
    Object.assign(f.host, { ikPaths: w.paths }); f.runner.setCycleTime(0.2);
    expect(f.core!.ikSnapshotReason).toBeTypeOf('function');
    f.runner.clearMUs(); expect(f.core!.ikSnapshotReason).toBeNull();
    f.start(); expect(f.core!.ikSnapshotReason).toBeTypeOf('function');
    f.runner.dispose(); expect(f.core!.ikSnapshotReason).toBeNull();
    w.paths[0].PathIsActive = true;
    expect(f.host.snapshotBlockers.reasons()).toContain('core: active IK path');
  });
});

describe('DES IK completion wakes LogicStep', () => {
  it('runs SetSignalBool at the path completion cycle time', () => {
    const cycleTime = 0.0625, k = 7, finishedAt = k * cycleTime;
    const ticks: number[] = [];
    // No shipped GLB has LogicStep_IKPath. Only the path completion is
    // synthetic; Core.Cycle, the engine, serial steps and signal writes are real.
    const path = {
      node: node('Path'), PathIsActive: false, PathIsFinished: false,
      startPath() { this.PathIsActive = true; this.PathIsFinished = false; },
      reset() { this.PathIsActive = false; this.PathIsFinished = false; },
      cancel() { this.PathIsActive = false; },
      fixedUpdate() {
        if (!this.PathIsActive) return;
        ticks.push(w.manager.currentTime);
        if (w.manager.currentTime === finishedAt) {
          this.PathIsFinished = true; this.PathIsActive = false;
        }
      },
    };
    const w = cycleRunnerFixture({ cycleTime, host: { ikPaths: [path] } });
    w.signalStore.register('done', 'Root/Done', false, 'PLCOutputBool');
    const rootNode = node('Sequence'); w.scene.add(rootNode, path.node);
    rootNode.userData.realvirtual = { LogicStep_SerialContainer: {} };
    const wait = node('RunPath'); rootNode.add(wait);
    wait.userData.realvirtual = { LogicStep_IKPath: {
      IKPath: { type: 'ComponentReference', path: 'Root/Path', componentType: 'IKPath' },
    } };
    const next = node('SetDone'); rootNode.add(next);
    next.userData.realvirtual = { LogicStep_SetSignalBool: {
      Signal: { type: 'ComponentReference', path: 'Root/Done', componentType: 'PLCOutputBool' }, SetToTrue: true,
    } };
    const registry = new NodeRegistry();
    w.scene.traverse(n => registry.registerNode(n === w.scene ? 'Root' : `Root/${NodeRegistry.computeNodePath(n)}`, n));
    registry.register('IKPath', 'Root/Path', path);
    const engine = RVLogicEngine.build(w.scene, registry, w.signalStore);
    const root = engine.roots[0] as RVSerialContainer; root.autoLoop = false;
    expect(root.children[0]).toBeInstanceOf(RVIKPathStep);
    expect(root.children[1]).toBeInstanceOf(RVSetSignalBool);
    w.host.logicEngine = engine;
    const writes: number[] = [];
    const off = w.signalStore.subscribe('done', value => { if (value) writes.push(w.manager.currentTime); });
    try {
      w.start(); engine.start(); w.manager.processAnimated(0);
      expect(root.children[0].state).toBe(StepState.Active);
      expect(writes).toEqual([]);
      w.manager.processAnimated(finishedAt - cycleTime);
      expect(path.PathIsActive).toBe(true); expect(writes).toEqual([]);
      w.manager.processAnimated(cycleTime);
      expect(ticks.at(-1)).toBe(finishedAt);
      expect(path.PathIsFinished).toBe(true);
      expect(root.state).toBe(StepState.Finished);
      expect(w.signalStore.get('done')).toBe(true);
      expect(writes).toEqual([k * cycleTime]);
    } finally { off(); }
  });
});
