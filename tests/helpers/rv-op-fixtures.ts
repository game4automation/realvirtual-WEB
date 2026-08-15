// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * One minimal, TYPE-CHECKED fixture per kind of the unified op union (plan-703).
 *
 * The map is exhaustive by construction: it is typed as
 * `Record<RvOpKind, RvOp>`, so adding a kind to the union without adding a
 * fixture is a compile error, and `rv-document-unified-ops.test.ts` additionally
 * asserts the coverage at runtime. That is the point — the "every kind" sweep
 * must not quietly shrink when the vocabulary grows.
 *
 * Payloads are deliberately the smallest thing the type accepts. These fixtures
 * exercise the DOCUMENT (queue, coalescing, undo/redo); live-scene behaviour is
 * pinned separately in `rv-op-semantics-pinning.test.ts`.
 */

import type { RvOp, RvOpKind } from '../../src/core/ops/rv-unified-ops';

const TRS = {
  position: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function head(kind: string) {
  return { id: 'op_fx_' + kind, ts: 1_000_000, schemaV: 1 as const };
}

const NODE_SPEC = {
  parentPath: 'Asset',
  name: 'Way',
  position: [0, 0, 0] as [number, number, number],
  quaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
  components: {} as Record<string, Record<string, unknown>>,
};

const PLACEMENT = {
  id: 'plc_1',
  catalogId: 'cat_1',
  glbUrl: 'models/roll.glb',
  label: 'Roll',
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0] as [number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

/** Every kind, exactly once. Exhaustiveness is enforced by the type. */
export const OP_FIXTURES: Readonly<Record<RvOpKind, RvOp>> = Object.freeze({
  // ── shared ────────────────────────────────────────────────────────
  setField: {
    ...head('setField'), kind: 'setField',
    nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed',
    value: 200, prev: 50,
  },
  unsetField: {
    ...head('unsetField'), kind: 'unsetField',
    nodePath: 'Asset/Box', componentType: 'Drive', fieldName: 'TargetSpeed', prev: 50,
  },
  // Merged kind (Phase-0 P1) — the fixture carries a scale, i.e. asset lineage.
  transformNode: {
    ...head('transformNode'), kind: 'transformNode',
    nodePath: 'Asset/Box',
    transform: { position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    prev: { ...TRS },
  },
  composite: {
    ...head('composite'), kind: 'composite', label: 'Bulk',
    ops: [{
      ...head('composite_child'), kind: 'setNodeVisible',
      nodePath: 'Asset/Box', visible: false, prev: true,
    }],
  },

  // ── scene lineage ─────────────────────────────────────────────────
  addPlacement: { ...head('addPlacement'), kind: 'addPlacement', placement: { ...PLACEMENT } },
  removePlacement: {
    ...head('removePlacement'), kind: 'removePlacement',
    placementId: PLACEMENT.id, placement: { ...PLACEMENT },
  },
  transformPlacement: {
    ...head('transformPlacement'), kind: 'transformPlacement',
    placementId: PLACEMENT.id,
    position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    prev: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  },
  setCamera: {
    ...head('setCamera'), kind: 'setCamera',
    preset: { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 }, prev: null,
  },
  setCode: {
    ...head('setCode'), kind: 'setCode',
    nodePath: 'Asset/Box', code: 'export function tick() {}', prev: undefined,
  },
  addNode: { ...head('addNode'), kind: 'addNode', nodePath: 'Asset/Way', spec: { ...NODE_SPEC } },
  removeNode: { ...head('removeNode'), kind: 'removeNode', nodePath: 'Asset/Way', spec: { ...NODE_SPEC } },
  addConnection: {
    ...head('addConnection'), kind: 'addConnection',
    connection: { id: 'c1', source: 'Asset/A', target: 'Asset/B', type: 'StopOnExit' },
  },
  removeConnection: {
    ...head('removeConnection'), kind: 'removeConnection', connectionId: 'c1',
    connection: { id: 'c1', source: 'Asset/A', target: 'Asset/B', type: 'StopOnExit' },
  },
  setConnectionType: {
    ...head('setConnectionType'), kind: 'setConnectionType',
    connectionType: { type: 'Handover' }, prev: undefined,
  },
  removeConnectionType: {
    ...head('removeConnectionType'), kind: 'removeConnectionType',
    connectionType: { type: 'Handover' },
  },

  // ── asset lineage ─────────────────────────────────────────────────
  importCad: {
    ...head('importCad'), kind: 'importCad', rootPath: 'Asset/Gearbox',
    cadlink: {
      File: 'gearbox.step', Sha256: 'deadbeef', Quality: 'standard',
      ImportScaleFactor: 0.001, ZIsUpVector: true,
    },
    transform: { ...TRS },
  },
  renameNode: {
    ...head('renameNode'), kind: 'renameNode',
    nodePath: 'Asset/Box', name: 'Crate', prevName: 'Box',
  },
  deleteNode: { ...head('deleteNode'), kind: 'deleteNode', nodePath: 'Asset/Box' },
  setNodeVisible: {
    ...head('setNodeVisible'), kind: 'setNodeVisible',
    nodePath: 'Asset/Box', visible: false, prev: true,
  },
  createNode: {
    ...head('createNode'), kind: 'createNode', nodePath: 'Asset/Empty', transform: { ...TRS },
  },
  reparentNode: {
    ...head('reparentNode'), kind: 'reparentNode',
    nodePath: 'Asset/Box', newParentPath: 'Asset/Frame', transform: { ...TRS },
    prevParentPath: 'Asset', prevIndex: 0, prevTransform: { ...TRS },
  },
  addComponent: {
    ...head('addComponent'), kind: 'addComponent',
    nodePath: 'Asset/Box', componentType: 'Drive', fields: { TargetSpeed: 100 },
  },
  removeComponent: {
    ...head('removeComponent'), kind: 'removeComponent',
    nodePath: 'Asset/Box', componentType: 'Drive', prevFields: { TargetSpeed: 100 },
  },
  setMaterial: {
    ...head('setMaterial'), kind: 'setMaterial', nodePaths: ['Asset/Box'],
    material: {
      name: 'Brushed Alu', color: '#c0c0c0', metalness: 0.8, roughness: 0.3,
      opacity: 1, transparent: false,
    },
    prev: [{ meshPath: 'Asset/Box', material: null }],
  },
  separateMesh: {
    ...head('separateMesh'), kind: 'separateMesh', sourcePath: 'Asset/Box',
    mode: 'islands', weldThreshold: 0.0001, childNames: ['Box_part0', 'Box_part1'],
  },
  mergeMesh: {
    ...head('mergeMesh'), kind: 'mergeMesh', rootPath: 'Asset/Frame',
    sourcePaths: ['Asset/Frame/A', 'Asset/Frame/B'],
    sourceSignatures: [
      { materialKey: 'm1', vertexCount: 8, triangleCount: 12 },
      { materialKey: 'm1', vertexCount: 8, triangleCount: 12 },
    ],
    outputs: [{ sourceIndices: [0, 1], role: 'root', ownerPath: 'Asset/Frame', name: 'Frame', groupNames: [] }],
    kept: [],
  },
});

/** All fixtures, in a stable order. */
export function allKindFixtures(): RvOp[] {
  return (Object.keys(OP_FIXTURES) as RvOpKind[]).slice().sort().map((k) => OP_FIXTURES[k]);
}

/** One fixture, with an overridden id/ts so a test can build a sequence. */
export function makeOpFixture(kind: RvOpKind, over?: { id?: string; ts?: number }): RvOp {
  const base = OP_FIXTURES[kind];
  return { ...base, ...(over?.id ? { id: over.id } : {}), ...(over?.ts ? { ts: over.ts } : {}) };
}
