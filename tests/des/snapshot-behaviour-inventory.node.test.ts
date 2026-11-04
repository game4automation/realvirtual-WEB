// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, it } from 'vitest';
import { getMaterialFlow } from '../../src/core/material-flow/registry';
import { Object3D, Scene } from 'three';
import { runnerFixture } from './runner-fixture';
import { clearShared } from '../helpers/agv-harness';
afterEach(() => clearShared());
import '../../src/behaviors/Turntable';
import { turntableRunState, turntableServices, turntableDerived, turntableScratch } from '../../src/behaviors/_shared/turntable-snapshot';
it('Turntable: classifies every local field exactly once', () => {
 const def = getMaterialFlow('Turntable')!;
 const keys = [...turntableRunState, ...turntableServices, ...turntableDerived, ...turntableScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/Conveyor';
import { conveyorRunState, conveyorServices, conveyorDerived, conveyorScratch } from '../../src/behaviors/_shared/conveyor-snapshot';
it('Conveyor: classifies every local field exactly once', () => {
 const def = getMaterialFlow('Conveyor')!;
 const keys = [...conveyorRunState, ...conveyorServices, ...conveyorDerived, ...conveyorScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/Source';
import { sourceRunState, sourceServices, sourceDerived, sourceScratch } from '../../src/behaviors/_shared/source-snapshot';
it('Source: classifies every local field exactly once', () => {
 const def = getMaterialFlow('Source')!;
 const keys = [...sourceRunState, ...sourceServices, ...sourceDerived, ...sourceScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/Sink';
import { sinkRunState, sinkServices, sinkDerived, sinkScratch } from '../../src/behaviors/_shared/sink-snapshot';
it('Sink: classifies every local field exactly once', () => {
 const def = getMaterialFlow('Sink')!;
 const keys = [...sinkRunState, ...sinkServices, ...sinkDerived, ...sinkScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/ChainTransfer';
import { chainTransferRunState, chainTransferServices, chainTransferDerived, chainTransferScratch } from '../../src/behaviors/_shared/chain-transfer-snapshot';
it('ChainTransfer: classifies every local field exactly once', () => {
 const def = getMaterialFlow('ChainTransfer')!;
 const keys = [...chainTransferRunState, ...chainTransferServices, ...chainTransferDerived, ...chainTransferScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/OverheadConveyor';
import { overheadRunState, overheadServices, overheadDerived, overheadScratch } from '../../src/behaviors/_shared/overhead-conveyor-snapshot';
it('OverheadConveyor: classifies every local field exactly once', () => {
 const def = getMaterialFlow('OverheadConveyor')!;
 const keys = [...overheadRunState, ...overheadServices, ...overheadDerived, ...overheadScratch];
 expect(new Set(keys).size).toBe(keys.length);
 expect([...keys].sort()).toEqual(Object.keys(def.state?.() ?? {}).sort());
});
import '../../src/behaviors/Agv';
import { agvStateKeys, agvServices, agvScratch } from '../../src/behaviors/_shared/agv-state';
it('Agv classifies every local field and allows full snapshots', () => {
  const keys = [...agvStateKeys, ...agvServices, ...agvScratch];
  expect(new Set(keys).size).toBe(keys.length);
  expect([...keys].sort()).toEqual(Object.keys(getMaterialFlow('Agv')!.state!()).sort());
  expect(Object.keys(getMaterialFlow('Agv')!.state!()).length).toBeGreaterThan(0);
  const scene = new Scene(), node = new Object3D(); node.name = 'Agv';
  node.userData.realvirtual = { Agv: { Active: false } };
  const path = new Object3D(); path.name = 'Path';
  path.userData.realvirtual = { Path: { type: 'Path', id: 'SnapshotProbePath',
    segments: [{ kind: 'line', from: [0, 0, 0], to: [0, 0, 3] }] } };
  node.add(path); scene.add(node);
  const f = runnerFixture(scene);
  f.runner.start([], { root: scene, host: f.host });
  expect(() => f.runner.fullSnapshot()).not.toThrow();
});
