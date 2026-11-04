// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-610 Phase 3 (test 9.4) — stored node references in the Problems panel.
 *
 *  - a broken reference is `reference-unresolved` (error), one found only by a
 *    fallback lookup is `reference-rescued` (warning) naming the path it landed on;
 *  - an empty optional reference, the Unity root-prefixed spelling and a loader
 *    alias (sanitized node name) are no entry;
 *  - the entries follow rename / move and undo in the asset editor;
 *  - the viewer audits on `model-loaded` and clears on a model switch and on
 *    `clearModel()`;
 *  - save → reload after rename / move: no problems, no fallback hit.
 *
 * The pure audit rules are pinned without a browser in
 * `rv-reference-audit.node.test.ts`; the demo models in
 * `reference-audit-demo-models.node.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { auditReferences } from '../src/core/engine/rv-reference-audit';
import {
  REFERENCE_PROBLEM_CODES,
  clearReferenceAuditProblems,
  getProblems,
  referenceRescuedProblemId,
  referenceUnresolvedProblemId,
  reportReferenceAudit,
  resetProblemsForTests,
} from '../src/core/hmi/problems-store';
import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { makeSpikeViewer, ref, HOLDER } from './helpers/spike-610-ref-fixture';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';

const DRIVE_T = 'realvirtual.Drive';
const SIG_T = 'realvirtual.PLCOutputBool';

const refProblems = () => getProblems().filter(
  (p) => p.code === REFERENCE_PROBLEM_CODES.unresolved || p.code === REFERENCE_PROBLEM_CODES.rescued,
);

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

/** Binary GLB of `scene` (the scene's name becomes the model root's name on load). */
async function glbOf(scene: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

/**
 * Cell                                         (glTF scene → model root)
 *  ├─ Axis          Drive
 *  ├─ Group/Sub/Axis2  Drive
 *  ├─ Signals/"S 1"  PLCOutputBool             (loader sanitizes to S_1 + alias "S 1")
 *  ├─ Panel   Holder: DriveA → "Cell/Axis"      (Unity root-prefixed: no entry)
 *  │                  DriveB → ""               (empty optional: no entry)
 *  │                  Sig    → "Signals/S 1"     (loader alias: no entry)
 *  │                  Tools  → ["Gone/Axis9" (unresolved, [0]), "Axis" (relative: no entry)]
 *  └─ Panel2  Holder: DriveA → "Sub/Axis2"      (suffix only: rescued → Cell/Group/Sub/Axis2)
 */
function brokenCellScene(): Scene {
  const scene = new Scene();
  scene.name = 'Cell';
  child(scene, 'Axis', { Drive: { Direction: 'LinearX' } });
  child(child(child(scene, 'Group'), 'Sub'), 'Axis2', { Drive: { Direction: 'LinearX' } });
  child(child(scene, 'Signals'), 'S 1', { PLCOutputBool: { Status: { Value: false } } });
  child(scene, 'Panel', {
    [HOLDER]: {
      DriveA: ref('Cell/Axis', DRIVE_T),
      DriveB: ref('', DRIVE_T),
      Sig: ref('Signals/S 1', SIG_T),
      Tools: [ref('Gone/Axis9', DRIVE_T), ref('Axis', DRIVE_T)],
    },
  });
  child(scene, 'Panel2', { [HOLDER]: { DriveA: ref('Sub/Axis2', DRIVE_T) } });
  return scene;
}

function cleanScene(): Scene {
  const scene = new Scene();
  scene.name = 'Clean';
  child(scene, 'Axis', { Drive: { Direction: 'LinearX' } });
  child(scene, 'Panel', { [HOLDER]: { DriveA: ref('Clean/Axis', DRIVE_T) } });
  return scene;
}

beforeEach(() => { resetProblemsForTests(); });

// ─── Loader level: the audit over a REALLY loaded GLB ────────────────────

describe('reference audit over a loaded GLB', () => {
  it('reports both broken references — and nothing for the regular spellings', async () => {
    const result = await loadGLB('cell-610.glb', new Scene(), { data: await glbOf(brokenCellScene()) });
    const audit = auditReferences(result.registry);
    const root = result.root.name;
    expect(root).toBe('Cell');

    // plan-769 Phase 1b: "Sub/Axis2" is a reference the FILE carries, and its authored
    // index names no such node — it is unresolved (D7), no longer `rescued` by the
    // suffix stage. `reference-rescued` remains for references without a file verdict
    // (the asset-editor cases below: a runtime tree, paths written this session).
    expect(audit.findings).toHaveLength(2);
    expect(audit.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unresolved', referrerPath: 'Cell/Panel', componentType: HOLDER, field: 'Tools', index: 0, writtenPath: 'Gone/Axis9',
      }),
      expect.objectContaining({
        kind: 'unresolved', referrerPath: 'Cell/Panel2', componentType: HOLDER, field: 'DriveA', writtenPath: 'Sub/Axis2',
      }),
    ]));
    expect(audit.findings.some((f) => f.kind === 'rescued')).toBe(false);

    reportReferenceAudit(audit.findings);
    const unresolved = getProblems().find((p) => p.id === referenceUnresolvedProblemId('Cell/Panel', HOLDER, 'Tools', 0));
    expect(unresolved).toMatchObject({ severity: 'error', code: 'reference-unresolved', nodePath: 'Cell/Panel' });
    expect(unresolved!.title).toBe('Reference not found: Gone/Axis9');
    expect(unresolved!.detail).toContain(`${HOLDER}.Tools[0]`);
    const second = getProblems().find((p) => p.id === referenceUnresolvedProblemId('Cell/Panel2', HOLDER, 'DriveA'));
    expect(second).toMatchObject({ severity: 'error', code: 'reference-unresolved', nodePath: 'Cell/Panel2' });
    expect(getProblems().find((p) => p.id === referenceRescuedProblemId('Cell/Panel2', HOLDER, 'DriveA'))).toBeUndefined();
  });

  it('a re-audit with the same findings does not churn the store; a fixed reference leaves it', () => {
    const f = { kind: 'unresolved' as const, referrerPath: 'A/B', componentType: 'X', field: 'Ref', writtenPath: 'A/Gone' };
    reportReferenceAudit([f]);
    const snap = getProblems();
    reportReferenceAudit([f]);
    expect(getProblems()).toBe(snap);
    reportReferenceAudit([]);
    expect(refProblems()).toEqual([]);
  });

  it('caps each code and adds ONE summary entry for the rest', () => {
    const many = Array.from({ length: 205 }, (_, i) => ({
      kind: 'unresolved' as const, referrerPath: `A/N${i}`, componentType: 'X', field: 'Ref', writtenPath: 'A/Gone',
    }));
    reportReferenceAudit(many);
    const list = refProblems();
    expect(list).toHaveLength(201);
    expect(list.find((p) => p.id === 'reference-unresolved:+more')).toMatchObject({ severity: 'error', title: '5 more references not found' });
    clearReferenceAuditProblems();
    expect(refProblems()).toEqual([]);
  });
});

// ─── Asset editor: entries follow rename / move and undo ────────────────

describe('reference problems follow rename / move and undo', () => {
  /** What the viewer does on every `editor-structure-changed` (coalesced there). */
  const audit = (registry: Parameters<typeof auditReferences>[0]) => reportReferenceAudit(auditReferences(registry).findings);

  it('renaming a node to the name a broken reference expects resolves it; undo brings the entry back', async () => {
    const f = makeSpikeViewer();
    const other = f.add(f.model, 'Other');
    const panel = f.add(f.model, 'Panel');
    f.register();
    f.drive(other);
    f.component(panel, HOLDER, { DriveA: ref('Asset/Gone', DRIVE_T) });
    const doc = scratchAssetDocument(f.viewer);

    audit(f.registry);
    expect(refProblems().map((p) => p.id)).toEqual([referenceUnresolvedProblemId('Asset/Panel', HOLDER, 'DriveA')]);

    f.events.length = 0;
    await doc.renameNodeAwaited('Asset/Other', 'Gone');
    expect(f.events.some((e) => e.name === 'editor-structure-changed')).toBe(true);
    audit(f.registry);
    expect(refProblems()).toEqual([]);

    f.events.length = 0;
    await doc.undo();
    expect(f.events.some((e) => e.name === 'editor-structure-changed')).toBe(true);
    audit(f.registry);
    expect(refProblems().map((p) => p.code)).toEqual(['reference-unresolved']);

    await doc.redo();
    audit(f.registry);
    expect(refProblems()).toEqual([]);
    doc.dispose();
  });

  it('moving a node to where a rescued reference names it turns the warning off; undo turns it on again', async () => {
    const f = makeSpikeViewer();
    const cell = f.add(f.model, 'Cell');
    const part = f.add(f.model, 'Part');
    const user = f.add(f.model, 'User');
    f.register();
    f.drive(part);
    // Written for the node INSIDE Cell; today it binds only by name.
    f.component(user, HOLDER, { DriveA: ref('Asset/Cell/Part', DRIVE_T) });
    void cell;
    const doc = scratchAssetDocument(f.viewer);

    audit(f.registry);
    const before = refProblems();
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ code: 'reference-rescued', nodePath: 'Asset/User' });
    expect(before[0].title).toContain('→ Asset/Part');

    await doc.reparentNodes(['Asset/Part'], 'Asset/Cell');
    audit(f.registry);
    expect(refProblems()).toEqual([]);

    await doc.undo();
    audit(f.registry);
    expect(refProblems().map((p) => p.code)).toEqual(['reference-rescued']);
    doc.dispose();
  });
});

// ─── Save → reload after rename / move ───────────────────────────────────

describe('save → reload after rename / move', () => {
  it('the rewritten document reloads without problems and without a single fallback hit', async () => {
    const f = makeSpikeViewer();
    const cell = f.add(f.model, 'Cell');
    const axis = f.add(cell, 'Axis');
    // The saved file must carry the Drive the reloaded tree builds (f.drive is live-only).
    axis.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
    const outside = f.add(f.model, 'Outside');
    const panel = f.add(f.model, 'Panel');
    f.register();
    f.drive(axis);
    f.component(panel, HOLDER, {
      DriveA: ref('Asset/Cell/Axis', DRIVE_T),     // root-prefixed
      Tools: [ref('Cell/Axis', DRIVE_T)],           // asset-relative
    });
    const doc = scratchAssetDocument(f.viewer);
    await doc.renameNodeAwaited('Asset/Cell', 'Station');
    await doc.reparentNodes(['Asset/Station/Axis'], 'Asset/Outside');
    doc.dispose();

    // "Save": the edited tree as a GLB whose scene carries the asset root's name.
    const out = new Scene();
    out.name = 'Asset';
    for (const c of f.model.children) out.add(c.clone(true));
    const result = await loadGLB('saved-610.glb', new Scene(), { data: await glbOf(out) });
    const audit = auditReferences(result.registry);
    expect(audit.counts.references).toBe(2);
    expect(audit.findings).toEqual([]);
    // Every reference resolves EXACTLY (no alias, no fallback) in the reloaded tree.
    const stages = [
      result.registry.resolveWithStage({ path: 'Asset/Outside/Axis' }, DRIVE_T, result.registry.getNode('Asset/Panel')),
      result.registry.resolveWithStage({ path: 'Outside/Axis' }, DRIVE_T, result.registry.getNode('Asset/Panel')),
    ].map((h) => h?.stage);
    expect(stages).toEqual(['exact', 'exact']);
    void outside;
  });
});

// ─── Viewer wiring: model-loaded audits, a model switch clears ───────────

describe('viewer wiring (real RVViewer)', () => {
  let handle: TestViewerHandle | null = null;
  const urls: string[] = [];
  const urlOf = async (scene: Scene): Promise<string> => {
    const url = URL.createObjectURL(new Blob([await glbOf(scene)], { type: 'model/gltf-binary' }));
    urls.push(url);
    return url;
  };
  afterEach(() => {
    handle?.dispose();
    handle = null;
    for (const u of urls.splice(0)) URL.revokeObjectURL(u);
  });

  it('model-loaded audits; loading another model replaces the entries; clearModel drops them', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;

    await viewer.loadModel(await urlOf(brokenCellScene()));
    // plan-769 Phase 1b: both are file references without a node — two unresolved.
    expect(viewer.lastReferenceAudit?.counts).toMatchObject({ unresolved: 2, rescued: 0 });
    expect(refProblems().map((p) => p.code).sort()).toEqual(['reference-unresolved', 'reference-unresolved']);

    await viewer.loadModel(await urlOf(cleanScene()));
    expect(refProblems()).toEqual([]);
    expect(viewer.lastReferenceAudit?.findings).toEqual([]);

    await viewer.loadModel(await urlOf(brokenCellScene()));
    expect(refProblems()).toHaveLength(2);
    viewer.clearModel();
    expect(refProblems()).toEqual([]);
    expect(viewer.flushReferenceAudit()).toBeNull();
  }, 120000);

  it('editor-structure-changed schedules ONE coalesced audit', async () => {
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    await viewer.loadModel(await urlOf(cleanScene()));
    expect(refProblems()).toEqual([]);

    // Break the reference behind the viewer's back, then announce a structural change twice.
    const panel = viewer.registry!.getNode('Clean/Panel')!;
    (panel.userData.realvirtual as Record<string, Record<string, unknown>>)[HOLDER].DriveA = ref('Clean/Gone', DRIVE_T);
    viewer.emit('editor-structure-changed', { source: 'asset-editor' });
    viewer.emit('editor-structure-changed', { source: 'asset-editor' });
    expect(refProblems()).toEqual([]); // not yet — coalesced to the end of the task
    const result = viewer.flushReferenceAudit();
    expect(result?.counts.unresolved).toBe(1);
    expect(refProblems().map((p) => p.id)).toEqual([referenceUnresolvedProblemId('Clean/Panel', HOLDER, 'DriveA')]);
    expect(viewer.flushReferenceAudit()).toBeNull(); // nothing pending any more
  }, 120000);
});
