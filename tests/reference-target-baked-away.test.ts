// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 4 (§ 9.8, F7 / F8) — the editor is honest about placed content.
 *
 * A placed reference is baked like in the HMI: only nodes with a component (and
 * the Group partition objects) survive its bake. The OPEN document may still
 * point into it — and when it points at a part the bake merged away, that is a
 * Problems entry, exactly as at runtime:
 *
 *  - parent → plain mesh part of the child: `reference-target-baked-away`
 *    (not the generic `reference-unresolved`), naming the referencing node, the
 *    field and the target address;
 *  - parent → Drive node of the child: resolves — no entry;
 *  - a Kinematic of the parent integrating a group the parent assigned a node
 *    of the child to: `kinematic-member-in-placed-content` (a group the child
 *    declares itself under the same name is a name collision, no entry);
 *  - a recorded edit (old draft / recompose replay) on a path into the child
 *    that does not exist any more: `replay-op-skipped` (path + op kind), the
 *    op neither applied nor kept; an own-content op is untouched.
 *
 * Real `RVViewer`, real GLTFLoader over `data:` urls (the editor-document
 * harness), the production authoring load (`loadAuthoringModel`). Nodes are
 * found by identity, never by a path string.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { setNodeId } from '../src/core/engine/rv-node-id';
import {
  getProblems, resetProblemsForTests,
  REFERENCE_TARGET_BAKED_AWAY_CODE, KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE, REPLAY_OP_SKIPPED_CODE,
} from '../src/core/hmi/problems-store';
import { replayOntoTreeLocked } from '../src/core/ops/rv-document-projection';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import { assetOpHeader } from '../src/core/editor/rv-asset-ops';
import { bootRealLoaderViewer, dataUrlOf, referenceNode, type Booted } from './helpers/nested-placement-fixture';
import { openEditorDocumentBytes, type EditorDocumentHarness } from './helpers/editor-document-harness';
import { withComponent, group } from './fixtures/bake-fixture';
import { identityIdOf } from '../src/core/engine/rv-decode-identity';

const CELL_ID = 'nid-cell';
const BODY_ID = 'nid-body';
const SLIDE_ID = 'nid-slide';

let h: EditorDocumentHarness | null = null;
let booted: Booted | null = null;
afterEach(() => {
  h?.dispose();
  h = null;
  booted?.h.dispose();
  booted = null;
  resetProblemsForTests();
});

/** The placed asset: a plain `Body` mesh (merged away by its bake), a `Slide` Drive (survives), a `Guard` in group `Moving`. */
function makeCell(): Group {
  const root = group('Cell');
  const body = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshStandardMaterial({ color: 0x336699 }));
  body.name = 'Body';
  body.position.set(2, 0.25, 0);
  setNodeId(body, BODY_ID);
  root.add(body);
  const slide = withComponent(group('Slide'), 'Drive', { Direction: 'LinearX', TargetSpeed: 200 });
  setNodeId(slide, SLIDE_ID);
  slide.position.set(2, 0.5, 0);
  const tool = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial({ color: 0x99cc33 }));
  tool.name = 'Tool';
  slide.add(tool);
  root.add(slide);
  const guard = withComponent(new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial({ color: 0xcc3333 })), 'Group', { GroupName: 'Moving' });
  guard.name = 'Guard';
  guard.position.set(1, 0.2, 1);
  root.add(guard);
  return root;
}

const driveRef = (address: string) => ({ type: 'ComponentReference', address, componentType: 'realvirtual.Drive' });

/** One `LogicStep_DriveTo` holding `drive` — a stored reference of the parent document. */
function step(name: string, drive: unknown): Object3D {
  return withComponent(group(name), 'LogicStep_DriveTo', { drive, Destination: 10, Relative: false });
}

/** The parent `Machine`: own Frame, reference `Cell_1` → Cell, and its references into it. */
async function machineBytes(opts: { kinematic?: boolean; kinematicDisabled?: boolean } = {}): Promise<ArrayBuffer> {
  const root = group('Machine');
  const frame = new Mesh(new BoxGeometry(3, 0.2, 3), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  root.add(referenceNode('Cell_1', CELL_ID, dataUrlOf(await objectToGlb(makeCell())), true, [3, 0, 0], 'cat:cell'));
  root.add(step('ToBody', driveRef(`${CELL_ID}#${BODY_ID}`)));
  root.add(step('ToSlide', driveRef(`${CELL_ID}#${SLIDE_ID}`)));
  root.add(step('ToNowhere', driveRef('#nid-nowhere')));
  if (opts.kinematic || opts.kinematicDisabled) {
    root.add(withComponent(group('Axis'), 'Kinematic', {
      IntegrateGroupEnable: true, GroupName: 'Moving', ...(opts.kinematicDisabled ? { _enabled: false } : {}),
    }));
  }
  return objectToGlb(root);
}

function byIdentity(root: Object3D, id: string): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
  return hit;
}

function problemsOf(code: string) {
  return getProblems().filter((p) => p.code === code);
}

describe('plan-774 F7 — a reference into placed content whose target was baked away', () => {
  it('parent → plain mesh part of the child: reference-target-baked-away (path, field, target address)', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    expect(h.join).toMatchObject({ ok: true, placementsReady: true });
    const cell = h.nodeById(CELL_ID);
    expect(byIdentity(cell, BODY_ID), 'the plain Body was baked away').toBeNull();
    expect(byIdentity(cell, SLIDE_ID), 'the Drive survives').not.toBeNull();

    const baked = problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE);
    expect(baked).toHaveLength(1);
    const toBody = h.pathOf(h.root.getObjectByName('ToBody')!);
    expect(baked[0]!.nodePath).toBe(toBody);
    expect(baked[0]!.title).toContain(`${CELL_ID}#${BODY_ID}`);
    expect(baked[0]!.detail).toContain('LogicStep_DriveTo.drive');
    expect(baked[0]!.detail).toContain(h.pathOf(cell));
    // Not ALSO the generic unresolved entry for the same reference.
    expect(getProblems().some((p) => p.code === 'reference-unresolved' && p.nodePath === toBody)).toBe(false);
  });

  it('parent → Drive node of the child: resolves, no entry; an own-content miss stays reference-unresolved', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    const toSlide = h.pathOf(h.root.getObjectByName('ToSlide')!);
    const toNowhere = h.pathOf(h.root.getObjectByName('ToNowhere')!);
    expect(getProblems().filter((p) => p.nodePath === toSlide)).toEqual([]);
    expect(problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE).map((p) => p.nodePath)).not.toContain(toNowhere);
    expect(problemsOf('reference-unresolved').map((p) => p.nodePath)).toContain(toNowhere);
  });

  it('re-evaluated per materialisation and cleared per document', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    expect(problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE)).toHaveLength(1);
    // A re-audit (what every settle and structural edit runs) reports the same ONE entry.
    h.viewer.auditReferences();
    expect(problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE)).toHaveLength(1);
    // The next document clears it (clearModel → clearReferenceAuditProblems).
    const plain = group('Plain');
    plain.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    await h.viewer.loadModel('plain.glb', { data: await objectToGlb(plain), preserveHierarchy: true, preserveAuthoringHierarchy: true });
    await h.viewer.whenSceneReady();
    expect(problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE)).toEqual([]);
  });

  it('the same entry on a RUNTIME load of the document (same as the HMI)', async () => {
    booted = await bootRealLoaderViewer();
    const v = booted.h.viewer;
    await v.loadModel('machine.glb', { data: await machineBytes() });
    await v.whenSceneReady();
    const baked = problemsOf(REFERENCE_TARGET_BAKED_AWAY_CODE);
    expect(baked).toHaveLength(1);
    expect(baked[0]!.title).toContain(`${CELL_ID}#${BODY_ID}`);
  });

  it('review fix R1: a group the CHILD declares itself under the same name is a name collision → no entry', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes({ kinematic: true }), { mode: 'deferred' });
    const moving = h.viewer.groups?.get('Moving');
    expect(moving?.nodes.length ?? 0, 'the placement merged its group in by name').toBeGreaterThan(0);
    expect(problemsOf(KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE)).toEqual([]);
  });

  it('a placed node the DOCUMENT assigns to the Kinematic group: kinematic-member-in-placed-content', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes({ kinematic: true }), { mode: 'deferred' });
    const slide = h.nodeById(SLIDE_ID);
    await h.doc.applyOp({
      ...assetOpHeader(), kind: 'setField', nodePath: h.pathOf(slide),
      componentType: 'Group', fieldName: 'GroupName', value: 'Moving',
    } as never);
    expect(h.viewer.groups?.get('Moving')?.nodes, 'the override registered the Slide').toContain(slide);
    h.viewer.auditReferences();
    const kin = problemsOf(KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE);
    expect(kin).toHaveLength(1);
    expect(kin[0]!.nodePath).toBe(h.pathOf(h.root.getObjectByName('Axis')!));
    expect(kin[0]!.detail).toContain('"Moving"');
    expect(kin[0]!.detail).toContain(h.pathOf(h.nodeById(CELL_ID)));
  });

  it('no kinematic entry without such a group', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    expect(problemsOf(KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE)).toEqual([]);
  });

  it('review fix E9: a DISABLED Kinematic integrates nothing → no entry (resolveGroupName)', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes({ kinematicDisabled: true }), { mode: 'deferred' });
    expect(h.viewer.groups?.get('Moving')?.nodes.length ?? 0, 'the group itself is there').toBeGreaterThan(0);
    expect(problemsOf(KINEMATIC_MEMBER_IN_PLACED_CONTENT_CODE)).toEqual([]);
  });
});

describe('plan-774 F8 — replayed edits on a now-baked path: replay-op-skipped', () => {
  function setFieldOp(id: string, nodePath: string, value: number): RvOp {
    return {
      id, ts: Date.now(), origin: 'asset', kind: 'setField',
      nodePath, componentType: 'Drive', fieldName: 'TargetSpeed', value, prev: 200,
    } as unknown as RvOp;
  }

  it('draft replay: the op on the baked-away (old graft) path is skipped + reported, the Drive op lands', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    const cellPath = h.pathOf(h.nodeById(CELL_ID));
    const slide = h.nodeById(SLIDE_ID);
    const goneGraft = `${cellPath}/Cell/Body`;   // the path an old (graft-era) draft recorded
    const gone = `${cellPath}/Body`;
    await h.doc.replayOps([
      setFieldOp('op-a', goneGraft, 1),
      setFieldOp('op-b', gone, 2),
      setFieldOp('op-c', h.pathOf(slide), 250),
    ]);
    // Only the op that found its node is in the history and applied.
    expect(h.doc.document.opCount).toBe(1);
    expect((slide.userData.realvirtual as { Drive: { TargetSpeed: number } }).Drive.TargetSpeed).toBe(250);
    const skipped = problemsOf(REPLAY_OP_SKIPPED_CODE);
    expect(skipped.map((p) => p.nodePath).sort()).toEqual([gone, goneGraft].sort());
    for (const p of skipped) expect(p.title).toContain('setField');
  });

  it('recompose replay (replayOntoTreeLocked): skipped with placed:true, reported; an own-content op is not flagged', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    const cellPath = h.pathOf(h.nodeById(CELL_ID));
    const gone = `${cellPath}/Body`;
    const r = await replayOntoTreeLocked(h.doc.document, [setFieldOp('op-x', gone, 3)], 'Machine');
    expect(r).toEqual({ applied: 0, skipped: [{ kind: 'setField', nodePath: gone, placed: true, reason: 'baked-away' }] });
    expect(problemsOf(REPLAY_OP_SKIPPED_CODE).map((p) => p.nodePath)).toEqual([gone]);
    // The next load clears it (per document).
    const plain = group('Plain');
    await h.viewer.loadModel('plain.glb', { data: await objectToGlb(plain), preserveHierarchy: true, preserveAuthoringHierarchy: true });
    expect(problemsOf(REPLAY_OP_SKIPPED_CODE)).toEqual([]);
  });

  it('a replay without placed targets reports nothing', async () => {
    h = await openEditorDocumentBytes('machine.glb', await machineBytes(), { mode: 'deferred' });
    const slidePath = h.pathOf(h.nodeById(SLIDE_ID));
    const r = await replayOntoTreeLocked(h.doc.document, [setFieldOp('op-y', slidePath, 260)], 'Machine');
    expect(r).toEqual({ applied: 1, skipped: [] });
    expect(problemsOf(REPLAY_OP_SKIPPED_CODE)).toEqual([]);
  });
});
