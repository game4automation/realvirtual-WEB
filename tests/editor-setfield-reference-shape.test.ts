// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.24 (Phase 6, D22) — `editor.setField` on a REFERENCE field takes
 * the object form only.
 *
 *  - a bare string on `LogicStep_DriveTo.drive` is refused at the document, before
 *    anything is applied or recorded, with a message naming the expected form
 *    (`web_editor_set_field` answers with exactly this message);
 *  - the object form `{ type: 'ComponentReference', path, componentType }` is stored
 *    as the target's ADDRESS (Phase 3b writer) — the logic steps are reference-typed
 *    in rv-ODT, so they take the same writer as every other reference field;
 *  - `null` clears, a value field and a path field (`LogicStep_Enable.Target`) keep
 *    accepting strings.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../src/core/rv-viewer';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';
import { bareStringReferenceRefusal, referenceFieldShape } from '../src/core/hmi/rv-reference-field';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

/** Cell → Axis {Drive}, Step {LogicStep_DriveTo without a drive}. */
async function loadCell(): Promise<{ scene: Scene; root: Object3D; registry: NodeRegistry }> {
  const src = new Scene();
  src.name = 'Cell';
  child(src, 'Axis', { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
  child(src, 'Step', { LogicStep_DriveTo: { Destination: 100, Relative: false } });
  const data = (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
  const scene = new Scene();
  const result = await loadGLB('setfield-reference-shape.glb', scene, { data, preserveHierarchy: true });
  return { scene, root: result.root, registry: result.registry };
}

/** A renderer-free asset-editor viewer over a loaded tree (pattern of `editor-save-authored-names`). */
function editorViewer(scene: Scene, root: Object3D, registry: NodeRegistry): RVViewer {
  return {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return root; },
    drives: [],
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
    rebuildIKPaths() {},
    getPlugin: () => undefined,
    instancePickIndex: undefined,
    buildMeshBvhsAsync() {},
    selectionManager: { select() {} },
  } as unknown as RVViewer;
}

const driveOf = (step: Object3D): unknown =>
  (step.userData.realvirtual as Record<string, Record<string, unknown>>).LogicStep_DriveTo.drive;

describe('9.24 reference field shape (D22)', () => {
  it('a bare string on LogicStep_DriveTo.drive is refused: error names the object form, no op, field untouched', async () => {
    const { scene, root, registry } = await loadCell();
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const step = registry.getNode('Cell/Step')!;
    const opsBefore = doc.ops.length;

    let error: unknown = null;
    await doc.setFieldAwaited('Cell/Step', 'LogicStep_DriveTo', 'drive', 'Axis', undefined).catch((e: unknown) => { error = e; });

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('LogicStep_DriveTo.drive');
    expect(message).toContain('bare string');
    expect(message).toContain('"type":"ComponentReference"');
    expect(message).toContain('"path"');
    expect(message).toContain('"componentType"');
    expect(doc.ops.length).toBe(opsBefore);
    expect(driveOf(step)).toBeUndefined();
    doc.dispose();
  });

  it('the object form with a path is stored as the target address; null clears', async () => {
    const { scene, root, registry } = await loadCell();
    const doc = scratchAssetDocument(editorViewer(scene, root, registry));
    const step = registry.getNode('Cell/Step')!;
    const axisId = identityIdOf(registry.getNode('Cell/Axis')!);
    expect(axisId).toBeTruthy();

    await doc.setFieldAwaited('Cell/Step', 'LogicStep_DriveTo', 'drive',
      { type: 'ComponentReference', path: 'Axis', componentType: 'realvirtual.Drive' }, undefined);
    expect(driveOf(step)).toEqual({ type: 'ComponentReference', address: `#${axisId}`, componentType: 'realvirtual.Drive' });
    expect(doc.ops.length).toBe(1);

    await doc.setFieldAwaited('Cell/Step', 'LogicStep_DriveTo', 'drive', null, driveOf(step));
    expect(driveOf(step)).toBeNull(); // (consecutive edits of one field may coalesce into one history entry)
    doc.dispose();
  });

  it('the field list: rv-ODT references (logic-step drive/signal/sensor/grip, arrays) refuse strings; value and path fields do not', () => {
    for (const [type, field] of [
      ['LogicStep_DriveTo', 'drive'], ['LogicStep_DriveToPosition', 'drive'], ['LogicStep_SetDriveSpeed', 'drive'],
      ['LogicStep_SetSignalBool', 'Signal'], ['LogicStep_WaitForSignalBool', 'Signal'], ['LogicStep_SetSignalFloat', 'Signal'],
      ['LogicStep_WaitForSensor', 'Sensor'], ['LogicStep_GripPick', 'Grip'],
    ] as const) {
      expect(referenceFieldShape(type, field), `${type}.${field}`).toBe('single');
      expect(bareStringReferenceRefusal(type, field, 'Some/Path'), `${type}.${field}`).not.toBeNull();
      expect(bareStringReferenceRefusal(type, field, ''), `${type}.${field} (empty)`).not.toBeNull();
      expect(bareStringReferenceRefusal(type, field, null)).toBeNull();
      expect(bareStringReferenceRefusal(type, field, { type: 'ComponentReference', path: 'Some/Path', componentType: '' })).toBeNull();
    }
    // A concrete key reads as its base type.
    expect(referenceFieldShape('LogicStep_DriveTo_1', 'drive')).toBe('single');
    // Value fields and the declared PATH field stay strings.
    expect(bareStringReferenceRefusal('LogicStep_DriveTo', 'Destination', '100')).toBeNull();
    expect(bareStringReferenceRefusal('LogicStep_Enable', 'Target', 'Cell/Lamp')).toBeNull();
    expect(bareStringReferenceRefusal('Drive', 'Direction', 'LinearX')).toBeNull();
    // Unknown component / field: no opinion.
    expect(bareStringReferenceRefusal('NoSuchComponent', 'drive', 'x')).toBeNull();
  });
});
