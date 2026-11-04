// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-774 Phase 2 (§ 9.6, F5) — the editor's SAVE does not depend on how the
 * references were loaded.
 *
 * Under the graft (the pre-Phase-2 editor load, kept reachable through the
 * test seam) the export cloned the whole composed tree and pruned everything
 * under a reference node; under the deferred load (production since Phase 2)
 * the export's clone walk never copies placed content at all (`cloneOwnContent`),
 * and the prune stays as the guard. The same edits — an own-content field and
 * an instance override inside the placement — must write SEMANTICALLY equal
 * files: re-parsed node tree, extras, overrides. And the export must not touch
 * the live placement: its shared chunk geometry is never disposed.
 *
 * `asset-export-keeps-references.test.ts` stays the prune's own guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene, type BufferGeometry, type Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { group } from './fixtures/bake-fixture';
import { cloneOwnContent, exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import {
  CELL_REF_NODE_ID, OUTER_URL, SLIDE_NODE_ID, dataUrlOf, findByName, referenceNode, toArrayBuffer,
} from './helpers/nested-placement-fixture';
import {
  MACHINE_REF_NODE_ID, NESTED_DOC_URL, openEditorDocument, openEditorDocumentBytes, type EditorDocumentHarness, type EditorLoadMode,
} from './helpers/editor-document-harness';

vi.mock('../src/core/engine/rv-glb-compose', async (importOriginal) =>
  (await import('./helpers/editor-defer-seam')).deferringComposeModule(importOriginal as never));

interface GlbNode {
  name?: string;
  children?: number[];
  mesh?: number;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}

/** The written file as a name tree with extras and transforms — everything but buffer indices. */
interface SemanticNode {
  name: string;
  hasMesh: boolean;
  t: number[];
  r: number[];
  s: number[];
  extras: unknown;
  children: SemanticNode[];
}

const round = (v: number[] | undefined, d: number[]): number[] => (v ?? d).map((n) => Math.round(n * 1e5) / 1e5);

function semanticTree(bytes: ArrayBuffer): SemanticNode[] {
  const json = parseGlbChunks(toArrayBuffer(bytes)).json as { nodes?: GlbNode[]; scenes?: Array<{ nodes?: number[]; extras?: unknown }>; scene?: number };
  const nodes = json.nodes ?? [];
  const build = (i: number): SemanticNode => {
    const n = nodes[i];
    return {
      name: n.name ?? '',
      hasMesh: n.mesh !== undefined,
      t: round(n.translation, [0, 0, 0]),
      r: round(n.rotation, [0, 0, 0, 1]),
      s: round(n.scale, [1, 1, 1]),
      extras: n.extras ?? null,
      children: (n.children ?? []).map(build),
    };
  };
  const scene = json.scenes?.[json.scene ?? 0];
  return (scene?.nodes ?? []).map(build);
}

function sceneExtras(bytes: ArrayBuffer): unknown {
  const json = parseGlbChunks(toArrayBuffer(bytes)).json as { scenes?: Array<{ extras?: unknown }>; scene?: number };
  return json.scenes?.[json.scene ?? 0]?.extras ?? null;
}

function findSemantic(tree: SemanticNode[], id: string): SemanticNode | null {
  for (const n of tree) {
    const rv = (n.extras as { realvirtual?: { NodeId?: string } } | null)?.realvirtual;
    if (rv?.NodeId === id) return n;
    const hit = findSemantic(n.children, id);
    if (hit) return hit;
  }
  return null;
}

/** The same edits in both modes: an own-content field and an instance override. */
async function editAndSave(h: EditorDocumentHarness, slideValue: number): Promise<ArrayBuffer> {
  const frame = findByName(h.root, 'Frame')!;
  frame.userData.realvirtual = { ...(frame.userData.realvirtual ?? {}), Note: { Text: 'own' } };
  await h.doc.setFieldAwaited(h.pathOf(frame), 'Note', 'Text', 'edited', 'own');
  const slide = h.nodeById(SLIDE_NODE_ID);
  await h.doc.setFieldAwaited(h.pathOf(slide), 'Drive', 'TargetSpeed', slideValue, 200);
  return exportAssetGlb(h.viewer.currentModelRoot!, 'm');
}

const opened: EditorDocumentHarness[] = [];
async function open(url: string, mode: EditorLoadMode): Promise<EditorDocumentHarness> {
  const h = await openEditorDocument(url, { mode });
  opened.push(h);
  return h;
}
afterEach(() => { while (opened.length) opened.pop()!.dispose(); });

describe('plan-774 F5 — semantic parity of the editor save: graft vs deferred', () => {
  it('OUTER: same own-content edit + same instance override → equal re-parsed tree, extras and overrides', async () => {
    const graft = await editAndSave(await open(OUTER_URL, 'graft'), 250);
    const deferred = await editAndSave(await open(OUTER_URL, 'deferred'), 250);

    const a = semanticTree(graft);
    const b = semanticTree(deferred);
    expect(b).toEqual(a);
    expect(sceneExtras(deferred)).toEqual(sceneExtras(graft));

    // And the content is what it should be: the override on the reference node, no children under it.
    const ref = findSemantic(b, CELL_REF_NODE_ID)!;
    expect(ref).not.toBeNull();
    expect(ref.children).toEqual([]);
    const overrides = (ref.extras as { realvirtual: { AssetOverrides?: { byAddress?: Record<string, { Drive?: { TargetSpeed?: number } }> } } })
      .realvirtual.AssetOverrides;
    expect(overrides?.byAddress?.[`#${SLIDE_NODE_ID}`]?.Drive?.TargetSpeed).toBe(250);
  });

  it('nested (Layout → Machine_1 → Cell_1): the override lands on the OUTERMOST reference in both modes, files equal', async () => {
    const graft = await editNested(await open(NESTED_DOC_URL, 'graft'));
    const deferred = await editNested(await open(NESTED_DOC_URL, 'deferred'));
    expect(semanticTree(deferred)).toEqual(semanticTree(graft));
    const ref = findSemantic(semanticTree(deferred), MACHINE_REF_NODE_ID)!;
    expect(ref.children).toEqual([]);
    const byAddress = (ref.extras as { realvirtual: { AssetOverrides?: { byAddress?: Record<string, unknown> } } }).realvirtual.AssetOverrides?.byAddress;
    expect(Object.keys(byAddress ?? {})).toEqual([`${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`]);
  });

  it('a LayoutObject the FILE wrote on the reference survives verbatim; the runtime stamp never reaches a file', async () => {
    const h = await open(OUTER_URL, 'deferred');
    const cell = h.nodeById(CELL_REF_NODE_ID);
    // The live node carries the instancer's stamp…
    expect((cell.userData.realvirtual as { LayoutObject?: unknown }).LayoutObject).toBeDefined();
    // …the file had none, so the save writes none.
    const raw = await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    const written = findSemantic(semanticTree(raw), CELL_REF_NODE_ID)!;
    expect((written.extras as { realvirtual: Record<string, unknown> }).realvirtual.LayoutObject).toBeUndefined();

    // A file that DID carry one (say, Locked) gets exactly that back after a reopen.
    const authored = { Label: 'Station A', CatalogId: 'cat:cell', Locked: true };
    const chunks = parseGlbChunks(toArrayBuffer(raw));
    const json = chunks.json as { nodes: GlbNode[] };
    const node = json.nodes.find((n) => (n.extras as { realvirtual?: { NodeId?: string } } | undefined)?.realvirtual?.NodeId === CELL_REF_NODE_ID)!;
    (node.extras as { realvirtual: Record<string, unknown> }).realvirtual.LayoutObject = authored;
    const reopened = await openEditorDocumentBytes('p774-authored-lo.glb', toArrayBuffer(rebuildGlbWithJson(chunks)), { mode: 'deferred' });
    opened.push(reopened);
    const liveCell = reopened.nodeById(CELL_REF_NODE_ID);
    expect(reopened.viewer.bakeRegistry.instanceOf(liveCell)).not.toBeNull();
    const roundTrip = findSemantic(semanticTree(await exportAssetGlb(reopened.viewer.currentModelRoot!, 'm')), CELL_REF_NODE_ID)!;
    expect((roundTrip.extras as { realvirtual: Record<string, unknown> }).realvirtual.LayoutObject).toEqual(authored);
  });

  it('the export never disposes or copies the live placement (shared chunk geometry stays alive)', async () => {
    const h = await open(OUTER_URL, 'deferred');
    const cell = h.nodeById(CELL_REF_NODE_ID);
    const instance = h.viewer.bakeRegistry.instanceOf(cell);
    expect(instance).not.toBeNull();
    const chunks: Mesh[] = [];
    cell.traverse((n) => { if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) chunks.push(n as Mesh); });
    expect(chunks.length).toBeGreaterThan(0);
    const disposed: BufferGeometry[] = [];
    for (const c of chunks) c.geometry.addEventListener('dispose', () => disposed.push(c.geometry));

    // The clone walk itself: the reference node is copied, its placed content is not.
    const clone = cloneOwnContent(h.root);
    let cloneCell: Object3D | null = null;
    clone.traverse((n) => { if (n.name === 'Cell_1') cloneCell = n; });
    expect(cloneCell).not.toBeNull();
    expect(cloneCell!.children).toHaveLength(0);
    let clonedChunks = 0;
    clone.traverse((n) => { if (n.userData?.[RV_BAKE_CHUNK_KEY] === true) clonedChunks++; });
    expect(clonedChunks).toBe(0);

    await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    expect(disposed).toEqual([]);
    expect(instance!.baked.disposed).toBe(false);
    for (const c of chunks) {
      expect(c.parent, `${c.name} still in the scene`).not.toBeNull();
      expect(c.geometry.getAttribute('position')?.count ?? 0).toBeGreaterThan(0);
    }
    // The live placement is still the same instance and still pickable through the registry.
    expect(h.viewer.bakeRegistry.instanceOf(cell)).toBe(instance);
  });
});

/** NESTED: an override on the nested Slide (address `<cell>#<slide>` on Machine_1). */
async function editNested(h: EditorDocumentHarness): Promise<ArrayBuffer> {
  const slide = h.nodeById(SLIDE_NODE_ID);
  await h.doc.setFieldAwaited(h.pathOf(slide), 'Drive', 'TargetSpeed', 260, 200);
  return exportAssetGlb(h.viewer.currentModelRoot!, 'layout');
}

// ─── Review round 1 (plan-774 release unit B) ────────────────────────────

const ROBOT_REF_ID = 'nid-robot-ref';
const ROBOT_RIG = { WristType: 'NonSpherical', ElbowInUnityX: true, DrawGizmos: false };

/** The placed asset: a robot whose rig (`RobotIK`, `carriesToPlacementRoot`) sits on its ASSET ROOT. */
async function robotAssetBytes(): Promise<ArrayBuffer> {
  const robot = new Scene();
  robot.name = 'Robot';
  robot.userData.realvirtual = { RobotIK: { ...ROBOT_RIG } };
  const link = new Mesh(new BoxGeometry(0.4, 0.4, 0.4), new MeshStandardMaterial({ color: 0x5577aa }));
  link.name = 'Link';
  robot.add(link);
  return objectToGlb(robot);
}

/** The document: own Frame + reference `Robot_1` → the robot asset; optionally authored extras on the reference node. */
async function robotDocBytes(onRef?: (ref: Object3D) => void): Promise<ArrayBuffer> {
  const root = group('Cell');
  const frame = new Mesh(new BoxGeometry(2, 0.1, 2), new MeshStandardMaterial({ color: 0x777777 }));
  frame.name = 'Frame';
  root.add(frame);
  const ref = referenceNode('Robot_1', ROBOT_REF_ID, dataUrlOf(await robotAssetBytes()), true, [1, 0, 0], 'cat:robot');
  onRef?.(ref);
  root.add(ref);
  return objectToGlb(root);
}

function writtenExtras(bytes: ArrayBuffer, id: string): Record<string, unknown> {
  const node = findSemantic(semanticTree(bytes), id);
  expect(node, `node ${id} written`).not.toBeNull();
  return (node!.extras as { realvirtual: Record<string, unknown> }).realvirtual;
}

async function reopen(bytes: ArrayBuffer, name: string): Promise<EditorDocumentHarness> {
  const h = await openEditorDocumentBytes(name, bytes, { mode: 'deferred' });
  opened.push(h);
  return h;
}

describe('plan-774 review fix E1 — components carried from the asset root never reach the parent file', () => {
  it('RobotIK on the asset root: live on the placement root, NOT in the save; reopen → the rig of the asset again', async () => {
    const h = await reopen(await robotDocBytes(), 'p774-robot-doc.glb');
    const ref = h.nodeById(ROBOT_REF_ID);
    expect(h.viewer.bakeRegistry.instanceOf(ref), 'the reference is a placement').not.toBeNull();
    // Precondition: the bake registry carried the rig onto the placement root.
    expect((ref.userData.realvirtual as { RobotIK?: unknown }).RobotIK).toEqual(ROBOT_RIG);

    const saved = await exportAssetGlb(h.viewer.currentModelRoot!, 'Cell');
    const written = writtenExtras(saved, ROBOT_REF_ID);
    expect(written.RobotIK, 'the carried rig is not file content').toBeUndefined();
    expect(written.AssetReference, 'the reference itself is').toBeDefined();
    // The live placement keeps its rig (only the clone was corrected).
    expect((ref.userData.realvirtual as { RobotIK?: unknown }).RobotIK).toEqual(ROBOT_RIG);

    const again = await reopen(saved, 'p774-robot-doc-saved.glb');
    const ref2 = again.nodeById(ROBOT_REF_ID);
    expect((ref2.userData.realvirtual as { RobotIK?: unknown }).RobotIK).toEqual(ROBOT_RIG);
    // …and a second save is still clean (a fixed point, no copy accumulates).
    expect(writtenExtras(await exportAssetGlb(again.viewer.currentModelRoot!, 'Cell'), ROBOT_REF_ID).RobotIK).toBeUndefined();
  });

  it('a RobotIK the FILE authored on the reference node wins over the asset and is written back as authored', async () => {
    const own = { WristType: 'Spherical', ElbowInUnityX: false, DrawGizmos: true };
    const h = await reopen(await robotDocBytes((ref) => {
      ref.userData.realvirtual = { ...(ref.userData.realvirtual ?? {}), RobotIK: { ...own } };
    }), 'p774-robot-doc-own.glb');
    const ref = h.nodeById(ROBOT_REF_ID);
    expect((ref.userData.realvirtual as { RobotIK?: unknown }).RobotIK).toEqual(own);
    expect(writtenExtras(await exportAssetGlb(h.viewer.currentModelRoot!, 'Cell'), ROBOT_REF_ID).RobotIK).toEqual(own);
  });
});

describe('plan-774 review fix E2 — an authored LayoutObject is merged, not replaced; editor toggles persist', () => {
  const AUTHORED = { Label: 'Station A', CatalogId: 'cat:cell', Locked: true, Visible: false };

  /** OUTER saved once, with `lo` written as the reference node's LayoutObject. */
  async function docWithLayoutObject(lo: Record<string, unknown> | null): Promise<ArrayBuffer> {
    const h = await open(OUTER_URL, 'deferred');
    const raw = await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    if (!lo) return raw;
    const chunks = parseGlbChunks(toArrayBuffer(raw));
    const json = chunks.json as { nodes: GlbNode[] };
    const node = json.nodes.find((n) => (n.extras as { realvirtual?: { NodeId?: string } } | undefined)?.realvirtual?.NodeId === CELL_REF_NODE_ID)!;
    (node.extras as { realvirtual: Record<string, unknown> }).realvirtual.LayoutObject = lo;
    return toArrayBuffer(rebuildGlbWithJson(chunks));
  }

  const liveLo = (n: Object3D) => (n.userData.realvirtual as { LayoutObject: Record<string, unknown> }).LayoutObject;

  it('authored Locked / Visible survive the materialisation (the stamp only adds what the file lacks)', async () => {
    const h = await reopen(await docWithLayoutObject({ Locked: true, Visible: false }), 'p774-lo-partial.glb');
    const cell = h.nodeById(CELL_REF_NODE_ID);
    expect(h.viewer.bakeRegistry.instanceOf(cell)).not.toBeNull();
    const lo = liveLo(cell);
    expect(lo.Locked, 'authored lock wins over the stamp').toBe(true);
    expect(lo.Visible).toBe(false);
    expect(typeof lo.Label).toBe('string');
    expect(lo.CatalogId).toBe('cat:cell');
    // Untouched round trip: exactly what the file wrote — no stamp field added.
    expect(writtenExtras(await exportAssetGlb(h.viewer.currentModelRoot!, 'm'), CELL_REF_NODE_ID).LayoutObject)
      .toEqual({ Locked: true, Visible: false });
  });

  it('toggling Locked / Visible in the editor → save → reopen: the toggled values persist', async () => {
    const h = await reopen(await docWithLayoutObject({ ...AUTHORED }), 'p774-lo-full.glb');
    const cell = h.nodeById(CELL_REF_NODE_ID);
    expect(liveLo(cell)).toEqual(AUTHORED);
    liveLo(cell).Locked = false;
    liveLo(cell).Visible = true;
    const saved = await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    expect(writtenExtras(saved, CELL_REF_NODE_ID).LayoutObject).toEqual({ ...AUTHORED, Locked: false, Visible: true });
    const again = await reopen(saved, 'p774-lo-full-saved.glb');
    expect(liveLo(again.nodeById(CELL_REF_NODE_ID))).toMatchObject({ Locked: false, Visible: true, Label: 'Station A' });
  });

  it('no authored record: the pure stamp is dropped, a field the user changed is kept', async () => {
    const h = await reopen(await docWithLayoutObject(null), 'p774-lo-none.glb');
    const cell = h.nodeById(CELL_REF_NODE_ID);
    expect(liveLo(cell).Locked).toBe(false);
    // Untouched: no LayoutObject in the file (as before).
    expect(writtenExtras(await exportAssetGlb(h.viewer.currentModelRoot!, 'm'), CELL_REF_NODE_ID).LayoutObject).toBeUndefined();
    // The user locks it: that field is content now, the untouched stamp fields are not.
    liveLo(cell).Locked = true;
    const saved = await exportAssetGlb(h.viewer.currentModelRoot!, 'm');
    expect(writtenExtras(saved, CELL_REF_NODE_ID).LayoutObject).toEqual({ Locked: true });
    const again = await reopen(saved, 'p774-lo-none-saved.glb');
    expect(liveLo(again.nodeById(CELL_REF_NODE_ID)).Locked).toBe(true);
  });
});
