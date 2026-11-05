// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// The DESManager node des.setEnd / the clock window create in a scene that has none carries only
// run configuration: adding it is no model edit, so a running DES keeps its snapshot fingerprint
// (checkpoints after a first des.setEnd used to be refused as "model changed since run start").
import { expect, it } from 'vitest';
import { modelEditEpoch } from '../../src/core/engine/rv-model-edit-epoch';
import {
  DES_CYCLE_TIME_FIELD, DES_DEFAULT_CYCLE_TIME, DES_END_TIME_FIELD, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD,
  DES_STAT_RESET_FIELD, isRunConfigOnlyComponents,
} from '../../src/core/material-flow/des-manager-settings';
import { RV_NODE_ID_KEY } from '../../src/core/engine/rv-node-id';

const created = { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 28800, [DES_STAT_RESET_FIELD]: 0, [DES_MASTER_SEED_FIELD]: 0, [DES_CYCLE_TIME_FIELD]: DES_DEFAULT_CYCLE_TIME } };

it('a DESManager with only end / warm-up / seed and the default CycleTime is run configuration only', () => {
  expect(isRunConfigOnlyComponents(created)).toBe(true);
  expect(isRunConfigOnlyComponents({ [DES_MANAGER_COMPONENT]: {} })).toBe(true);
  expect(isRunConfigOnlyComponents({ [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 3600 } })).toBe(true);
  // A non-default CycleTime, another field or another component is model content.
  expect(isRunConfigOnlyComponents({ [DES_MANAGER_COMPONENT]: { [DES_CYCLE_TIME_FIELD]: 0.05 } })).toBe(false);
  expect(isRunConfigOnlyComponents({ [DES_MANAGER_COMPONENT]: { Other: 1 } })).toBe(false);
  expect(isRunConfigOnlyComponents({ ...created, Drive: { Speed: 1 } })).toBe(false);
  expect(isRunConfigOnlyComponents({ Drive: { Speed: 1 } })).toBe(false);
  expect(isRunConfigOnlyComponents({})).toBe(false);
  expect(isRunConfigOnlyComponents(null)).toBe(false);
});

it('a saved holder NodeId (written on save, identity only) does not make it model content; anything else does', () => {
  expect(isRunConfigOnlyComponents({ ...created, NodeId: '0b7e5c1a-7a51-5c2e-9a0e-3f1d2c4b5a69' })).toBe(true);
  expect(isRunConfigOnlyComponents({ NodeId: 'x' })).toBe(false);
  expect(isRunConfigOnlyComponents({ ...created, NodeId: 'x', Drive: { Speed: 1 } })).toBe(false);
  expect(isRunConfigOnlyComponents({ ...created, AssetReference: { path: 'a.glb' } })).toBe(false);
});

// The literal 'NodeId' in isRunConfigOnlyComponents saves an eager import; this keeps it equal to the key.
it('the identity key the run-config check ignores is RV_NODE_ID_KEY', () => {
  expect(RV_NODE_ID_KEY).toBe('NodeId');
  expect(isRunConfigOnlyComponents({ ...created, [RV_NODE_ID_KEY]: 'x' })).toBe(true);
  expect(isRunConfigOnlyComponents({ [RV_NODE_ID_KEY]: 'x' })).toBe(false);
});

it('adding the run-configuration DESManager node does not bump the model edit epoch; any other node does', async () => {
  const { RvDocument } = await import('../../src/core/ops/rv-document');
  const doc = new RvDocument({ id: 'scene', name: '', mode: 'scene',
    executor: { applyForward: async () => {}, applyInverse: async () => {} } });
  const spec = (components: Record<string, Record<string, unknown>>) => ({ parentPath: 'Model', name: 'Simulation',
    position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number], components });
  const start = modelEditEpoch();
  await doc.applyOp({ id: 'a', ts: 1, schemaV: 1, kind: 'addNode', nodePath: 'Model/Simulation', spec: spec(created) } as never);
  expect(modelEditEpoch()).toBe(start);
  await doc.applyOp({ id: 'b', ts: 2, schemaV: 1, kind: 'addNode', nodePath: 'Model/Box', spec: spec({ Drive: { Speed: 1 } }) } as never);
  expect(modelEditEpoch()).toBeGreaterThan(start);
});

it('the fingerprint drops only the run-configuration holder leaf; an authored manager node with children or a pose stays', async () => {
  const { Object3D } = await import('three');
  const { collectFingerprintInput } = await import('../../src/plugins/des/rv-des-model-input');
  const { buildDesFingerprint } = await import('../../src/plugins/des/rv-des-fingerprint');
  const hash = (setup: (root: InstanceType<typeof Object3D>) => void): string => {
    const root = new Object3D(); root.userData.realvirtual = { Conveyor: { Speed: 500 } };
    setup(root);
    const addresses = new Map<InstanceType<typeof Object3D>, string>();
    root.traverse(n => addresses.set(n, n === root ? '#root' : `#${n.name}`));
    const host = { registry: {
      forEachNode: (cb: (path: string, node: InstanceType<typeof Object3D>) => void) => { for (const [n, a] of addresses) cb(a, n); },
      getAddressForNode: (n: InstanceType<typeof Object3D>) => addresses.get(n) ?? null,
    } } as never;
    const runner = { liveInstances: [], rngVersion: 2, fingerprintRunConfig: () => null, fingerprintScripts: () => [] } as never;
    const result = buildDesFingerprint(collectFingerprintInput(host, runner, { mainDocumentKey: null }));
    if (!result.ok) throw new Error(result.reasons.join('; '));
    return result.fingerprint.modelHash;
  };
  const holder = (root: InstanceType<typeof Object3D>) => {
    const n = new Object3D(); n.name = 'Simulation'; n.userData.realvirtual = structuredClone(created); root.add(n); return n;
  };
  const absent = hash(() => {});
  expect(hash(holder), 'the holder des.setEnd creates').toBe(absent);
  // Moving an authored manager node, or one that groups model children, is a model change.
  const moved = (y: number) => hash(root => { holder(root).position.y = y; });
  expect(moved(100)).not.toBe(moved(0));
  const grouped = (y: number) => hash(root => {
    const child = new Object3D(); child.name = 'Box'; child.userData.realvirtual = { Drive: {} }; child.position.y = y;
    holder(root).add(child);
  });
  expect(grouped(5)).not.toBe(grouped(0));
  expect(grouped(0)).not.toBe(absent);
});
