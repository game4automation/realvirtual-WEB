// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-616 Teil 1 — entering the DES mode does not edit the document; the
 * `Simulation` node is created by the first toolbar EDIT (LOP #196).
 *
 * Until plan-616 `DESWorkspacePlugin.onModeActivate` called
 * `ensureDesManagerNode`, which queued an `addNode` op on every DES entry: the
 * scene became dirty without a user edit, and the editor's next entry forked
 * the document out of the resulting draft.
 *
 * - 9.3  `onModeActivate` → no op, document clean, settings = live default
 * - 9.5  the toolbar's edit sequence (`persistDes*(ensureDesManagerNode(v))`)
 *        records `addNode` THEN `setField` on the same node, through the REAL
 *        `RvDocument` single-flight queue; the bake (`materialise`) folds the
 *        value into the created node — also when the edit target is an
 *        override writing into the same document (a bound editor).
 *
 * Template: `plc-persistence.test.ts` (ensure fixture with a registered
 * top-level parent and an `applyOp` spy).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';

const sceneStoreHolder = vi.hoisted(() => ({ store: null as unknown }));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneStoreHolder.store,
}));

import { RvDocument } from '../src/core/ops/rv-document';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { freshOpId, materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import {
  DES_END_TIME_FIELD,
  DES_MANAGER_COMPONENT,
  DES_MANAGER_NODE,
  DES_STAT_RESET_FIELD,
  ensureDesManagerNode,
  findDesManager,
  persistDesEndTime,
  persistDesStatReset,
  readDesManagerSettings,
} from '../src/core/material-flow/des-manager-node';
import { DESWorkspacePlugin } from '../src/plugins/des/des-workspace-plugin';
import type { RVViewer } from '../src/core/rv-viewer';

const NODE_PATH = `Cell/${DES_MANAGER_NODE}`;

/**
 * A scene with a registered top-level `Cell`, a REAL `RvDocument` behind a fake
 * scene store, and an executor that materialises `addNode` / `setField` into
 * the scene the way the runtime executor does (so `findDesManager` sees them).
 */
function makeFixture() {
  const root = new Object3D();
  root.name = 'Scene';
  const cell = new Object3D();
  cell.name = 'Cell';
  root.add(cell);

  const applied: string[] = [];
  const nodes = new Map<string, Object3D>();
  const executor = {
    async applyForward(op: RvOp): Promise<void> {
      applied.push(op.kind);
      if (op.kind === 'addNode') {
        const spec = (op as { spec: { name: string; components: Record<string, Record<string, unknown>> } }).spec;
        const node = new Object3D();
        node.name = spec.name;
        node.userData.realvirtual = JSON.parse(JSON.stringify(spec.components));
        cell.add(node);
        nodes.set((op as { nodePath: string }).nodePath, node);
      } else if (op.kind === 'setField') {
        const f = op as { nodePath: string; componentType: string; fieldName: string; value: unknown };
        const node = nodes.get(f.nodePath);
        // An executor that cannot find its target fails the op — exactly the
        // `setField`-before-`addNode` failure 9.5 guards against.
        if (!node) throw new Error(`setField on a missing node: ${f.nodePath}`);
        (node.userData.realvirtual[f.componentType] ??= {})[f.fieldName] = f.value;
      }
    },
    async applyInverse(): Promise<void> {},
  };
  const doc = new RvDocument({ id: 'scene', name: '', mode: 'scene', executor });

  const applyOp = vi.fn((op: RvOp) => doc.applyOp(op));
  sceneStoreHolder.store = { applyOp, isTransient: () => false };

  const viewer = {
    scene: root,
    registry: { getPathForNode: (n: Object3D) => (n === cell ? 'Cell' : null) },
    simulationKernel: null,
  };
  return { viewer, doc, applyOp, applied, root };
}

beforeEach(() => {
  setActiveEditTarget(null);
});

afterEach(() => {
  setActiveEditTarget(null);
  sceneStoreHolder.store = null;
});

// ─── 9.3 — mode entry only reads ─────────────────────────────────────────

describe('plan-616 9.3 — entering DES leaves the document clean', () => {
  it('the fixture CAN observe a creation (non-vacuity of the cases below)', async () => {
    const { viewer, applyOp, doc } = makeFixture();
    ensureDesManagerNode(viewer);
    await doc.whenIdle();
    expect(applyOp).toHaveBeenCalledTimes(1);
    expect(doc.dirty).toBe(true);
  });

  it('onModeActivate queues no op, the document stays clean', async () => {
    const { viewer, applyOp, doc, root } = makeFixture();

    new DESWorkspacePlugin().onModeActivate!('des', viewer as unknown as RVViewer);
    await doc.whenIdle();

    expect(applyOp).not.toHaveBeenCalled();
    expect(doc.opCount).toBe(0);
    expect(doc.dirty).toBe(false);
    expect(findDesManager(root)).toBeNull();
  });

  it('the settings read on entry are the live default — the values of a fresh node', () => {
    const { viewer, applyOp } = makeFixture();
    const settings = readDesManagerSettings(viewer);
    expect(settings.endTime).toBe(86400);
    expect(settings.statResetTime).toBe(0);
    expect(settings.masterSeed).toBe(0);
    expect(settings.rawEndTime).toBe(86400);
    expect(applyOp).not.toHaveBeenCalled();
  });

  it('an existing node is read as it is, still without an op', () => {
    const { viewer, applyOp, root } = makeFixture();
    const node = new Object3D();
    node.name = DES_MANAGER_NODE;
    node.userData.realvirtual = { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 7200, [DES_STAT_RESET_FIELD]: 60 } };
    root.children[0].add(node);

    const settings = readDesManagerSettings(viewer);
    expect(settings.endTime).toBe(7200);
    expect(settings.statResetTime).toBe(60);
    expect(applyOp).not.toHaveBeenCalled();
  });
});

// ─── 9.5 — the first edit creates the node, in order ─────────────────────

describe('plan-616 9.5 — the first toolbar edit creates Simulation, then sets the field', () => {
  it('addNode then setField on the same node; the bake folds the value in', async () => {
    const { viewer, doc, applied, root } = makeFixture();

    // Exactly the toolbar's sequence (DESControllerToolbar setEndValue).
    persistDesEndTime(ensureDesManagerNode(viewer), 3600);
    await doc.whenIdle();

    expect(applied).toEqual(['addNode', 'setField']);
    expect(doc.ops.map((o) => o.kind)).toEqual(['addNode', 'setField']);
    expect((doc.ops[0] as { nodePath: string }).nodePath).toBe(NODE_PATH);
    expect((doc.ops[1] as { nodePath: string }).nodePath).toBe(NODE_PATH);
    expect(doc.dirty).toBe(true);

    // Live: the node exists and carries the value.
    expect(findDesManager(root)?.endTime).toBe(3600);

    // Bake / replay of the log against the base: the created node carries it.
    const baked = materialise(doc.ops);
    const added = baked.addedNodes.find((n) => n.nodePath === NODE_PATH);
    expect(added).toBeDefined();
    expect(added!.spec.components[DES_MANAGER_COMPONENT][DES_END_TIME_FIELD]).toBe(3600);
  });

  it('a first warmup edit preserves the one-day end time', async () => {
    const { viewer, doc, root } = makeFixture();
    persistDesStatReset(ensureDesManagerNode(viewer), 120);
    await doc.whenIdle();
    expect(findDesManager(root)?.endTime).toBe(86400);
    const baked = materialise(doc.ops).addedNodes.find((n) => n.nodePath === NODE_PATH)!;
    expect(baked.spec.components[DES_MANAGER_COMPONENT][DES_END_TIME_FIELD]).toBe(86400);
  });

  it('a second edit reuses the node — no second addNode', async () => {
    const { viewer, doc } = makeFixture();
    persistDesEndTime(ensureDesManagerNode(viewer), 3600);
    await doc.whenIdle();
    persistDesStatReset(ensureDesManagerNode(viewer), 120);
    await doc.whenIdle();

    expect(doc.ops.filter((o) => o.kind === 'addNode')).toHaveLength(1);
    const baked = materialise(doc.ops).addedNodes.find((n) => n.nodePath === NODE_PATH)!;
    expect(baked.spec.components[DES_MANAGER_COMPONENT][DES_STAT_RESET_FIELD]).toBe(120);
  });

  it('with an override edit target writing into the same document, the order holds', async () => {
    const { viewer, doc } = makeFixture();
    // A bound editor's target: a different object, the same document queue.
    const editorTarget: EditTarget = {
      available: true,
      persistsTo: 'scene',
      setField(nodePath, componentType, fieldName, value, prev) {
        void doc.applyOp({
          id: freshOpId(), ts: Date.now(), schemaV: 1,
          kind: 'setField', nodePath, componentType, fieldName, value, prev,
        } as RvOp);
      },
      unsetField() {},
      async withTransaction(_label, fn) { await fn(); },
    };
    setActiveEditTarget(editorTarget);

    persistDesEndTime(ensureDesManagerNode(viewer), 900);
    await doc.whenIdle();

    expect(doc.ops.map((o) => o.kind)).toEqual(['addNode', 'setField']);
    const baked = materialise(doc.ops).addedNodes.find((n) => n.nodePath === NODE_PATH)!;
    expect(baked.spec.components[DES_MANAGER_COMPONENT][DES_END_TIME_FIELD]).toBe(900);
  });
});
