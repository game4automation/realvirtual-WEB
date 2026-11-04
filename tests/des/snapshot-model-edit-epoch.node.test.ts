// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { Object3D } from 'three';
import { readFileSync } from 'node:fs';
import { MODEL_EDIT_PATHS, bumpModelEditEpoch, modelEditEpoch, type ModelEditPath } from '../../src/core/engine/rv-model-edit-epoch';
import { writeComponentField, unsetComponentField } from '../../src/core/params/rv-param-field';

// This inventory gate prevents adding a declared path with no production caller.
const callers: Record<ModelEditPath, string> = {
  'component-field': 'core/params/rv-param-field.ts',
  'model-command': 'core/hmi/rv-command-registry.ts',
  'document-edit': 'core/ops/rv-document.ts',
  'transform-commit': 'core/engine/rv-transform-gizmo.ts',
  'placement-instance': 'core/engine/rv-placement-instancer.ts',
  'placement-removal': 'core/engine/rv-placement-instancer.ts',
};
it('every inventoried authored path has a caller and bumps through the epoch helper', () => {
  const start = modelEditEpoch();
  for (const path of MODEL_EDIT_PATHS) {
    const source = readFileSync(new URL('../../src/' + callers[path], import.meta.url), 'utf8');
    expect(source).toContain("bumpModelEditEpoch('" + path + "')");
    const before = modelEditEpoch();
    bumpModelEditEpoch(path);
    expect(modelEditEpoch()).toBe(before + 1);
  }
  expect(modelEditEpoch() - start).toBe(MODEL_EDIT_PATHS.length);
});
it('parameter writes and removal bump; unchanged writes do not', () => {
  const node = new Object3D(), start = modelEditEpoch();
  writeComponentField(node, 'Conveyor', 'Speed', 5);
  expect(modelEditEpoch()).toBe(start + 1);
  writeComponentField(node, 'Conveyor', 'Speed', 5);
  expect(modelEditEpoch()).toBe(start + 1);
  unsetComponentField(node, 'Conveyor', 'Speed');
  expect(modelEditEpoch()).toBe(start + 2);
});
it('simulation motion and view state do not bump', () => {
  const node = new Object3D(), start = modelEditEpoch();
  node.position.x = 42; node.quaternion.setFromAxisAngle(node.up, 1);
  node.updateMatrix(); node.visible = false;
  expect(modelEditEpoch()).toBe(start);
});

it('model commands bump once and view commands do not bump', async () => {
  const { CommandRegistry } = await import('../../src/core/hmi/rv-command-registry');
  const registry = new CommandRegistry();
  for (const [id, undoLabel] of [['model', 'Edit model'], ['view', undefined]] as const) {
    registry.register({ id, undoLabel, label: id, readOnly: false, scope: 'none',
      available: true, unavailableReason: '', argsSchema: {},
      impl: async () => ({ enabled: () => true, run: () => undefined }) });
  }
  const viewer = { modes: { activeMode: 'planner' } } as unknown as import('../../src/core/rv-viewer').RVViewer;
  const start = modelEditEpoch();
  expect(await registry.execute('model', {}, { origin: 'ui', viewer })).toMatchObject({ ok: true });
  expect(modelEditEpoch()).toBe(start + 1);
  expect(await registry.execute('view', {}, { origin: 'ui', viewer })).toMatchObject({ ok: true });
  expect(modelEditEpoch()).toBe(start + 1);
});
it('editor and planner document edits, undo and redo invalidate the epoch', async () => {
  const { RvDocument } = await import('../../src/core/ops/rv-document');
  for (const mode of ['scene', 'asset'] as const) {
    const doc = new RvDocument({ id: mode, name: '', mode,
      executor: { applyForward: async () => {}, applyInverse: async () => {} } });
    const start = modelEditEpoch();
    await doc.applyOp({ id: 'edit', ts: 1, schemaV: 1, kind: 'renameNode', nodePath: 'N', name: 'new', prevName: 'old' });
    expect(modelEditEpoch()).toBeGreaterThan(start);
    const edited = modelEditEpoch();
    await doc.undo(); expect(modelEditEpoch()).toBeGreaterThan(edited);
    const undone = modelEditEpoch();
    await doc.redo(); expect(modelEditEpoch()).toBeGreaterThan(undone);
  }
});

it('camera document operations and their undo/redo remain view state', async () => {
  const { RvDocument } = await import('../../src/core/ops/rv-document');
  const doc = new RvDocument({ id: 'camera', name: '', mode: 'scene',
    executor: { applyForward: async () => {}, applyInverse: async () => {} } });
  const start = modelEditEpoch();
  await doc.applyOp({ id: 'camera', ts: 1, schemaV: 1, kind: 'setCamera', preset: null, prev: null });
  await doc.undo(); await doc.redo();
  expect(modelEditEpoch()).toBe(start);
});
