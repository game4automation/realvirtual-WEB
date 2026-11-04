// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * editor-document-harness — plan-774 Phase 0: a document opened the way the
 * ASSET EDITOR opens it, on a real `RVViewer`, with an `AssetDocument` bound
 * to it, in one of two load modes:
 *
 *  - `'deferred'` the production editor load since plan-774 Phase 2:
 *                 `loadModel(…, { preserveHierarchy, preserveAuthoringHierarchy })`;
 *                 every non-embedded reference is DEFERRED and materialised by
 *                 `viewer.placements` through the session `ModelCache` (the HMI
 *                 path), joined by `whenSceneReady()`.
 *  - `'graft'`    the pre-Phase-2 authoring load (how an older build opens a
 *                 file): the same flags, but `compose()` fetches every
 *                 referenced GLB and GRAFTS its unbaked tree under the
 *                 reference node. Produced by the test seam
 *                 `editor-defer-seam.ts`, which the TEST FILE must install with
 *                 `vi.mock` (see there); without the seam this mode throws
 *                 instead of silently deferring.
 *
 * The world is the real-loader half of `nested-placement-fixture.ts`: assets
 * are `data:` urls (compose's resolver fetches them natively, the ModelCache
 * decodes them with the real GLTFLoader), so both modes read the SAME bytes.
 * `url` names the fixture document by its fake-loader key (`OUTER_URL`,
 * `OUTER_DEEP_URL`, `OUTER_HAND_URL`, or the harness's own `NESTED_DOC_URL`) —
 * the harness builds the equivalent `data:` world for it.
 * `openEditorDocumentBytes` opens saved bytes instead (the reopen of a save).
 *
 * Nodes are found by identity (`nodeById`), never by a path string: the path
 * of the Slide differs between the modes (graft: `Machine/Cell_1/Cell/Slide`).
 */
import { Group, type Object3D } from 'three';
import { objectToGlb } from '../../src/core/import/rv-import-object';
import { identityIdOf } from '../../src/core/engine/rv-decode-identity';
import type { AssetDocument } from '../../src/core/editor/rv-asset-document';
import type { RVViewer } from '../../src/core/rv-viewer';
import {
  CELL_REF_NODE_ID, OUTER_DEEP_URL, OUTER_HAND_URL, OUTER_URL,
  SLIDE_NODE_ID, bootRealLoaderViewer, dataUrlOf, findByName, innerDataUrl, makeOuter, outerDataUrl, referenceNode,
  type Booted,
} from './nested-placement-fixture';
import { writeOverride } from '../../src/core/ops/rv-reference-guard';
import { scratchAssetDocument } from './scratch-asset-document';
import { deferSeamInstalled, withForcedAuthoringGraft } from './editor-defer-seam';
import { loadAuthoringModel, type AuthoringLoadResult } from '../../src/core/editor/rv-authoring-load';

export type EditorLoadMode = 'graft' | 'deferred';

/**
 * plan-774 Phase 1: a layout document `Layout` whose reference `Machine_1`
 * ({@link MACHINE_REF_NODE_ID}) places the OUTER Machine, which itself places
 * the Cell — the Slide is NESTED content there, and its override address on the
 * outermost reference is `nid-cell#nid-slide` (`<b>#<id>`).
 */
export const NESTED_DOC_URL = 'p774:layout-nested';
export const MACHINE_REF_NODE_ID = 'nid-machine';

/**
 * plan-774 review fix #10a: {@link NESTED_DOC_URL}, but the placed Machine file
 * ITSELF overrides its Cell's Slide (`Cell_1` carries
 * `byAddress['#nid-slide'].Drive.TargetSpeed` = {@link INNER_OVERRIDE_SPEED}) —
 * the asset's own value of the Slide, seen from the Layout, is that inner
 * override, not the Cell's raw 200.
 */
export const NESTED_INNER_OVERRIDE_DOC_URL = 'p774:layout-nested-inner-override';
export const INNER_OVERRIDE_SPEED = 222;

export interface EditorDocumentHarness {
  readonly mode: EditorLoadMode;
  readonly viewer: RVViewer;
  readonly doc: AssetDocument;
  readonly booted: Booted;
  /** The loaded document root (`viewer.currentModelRoot`). */
  readonly root: Object3D;
  /** The first node in the live document tree whose identity (`NodeId` / seeded id) is `id`; throws if none. */
  nodeById(id: string): Object3D;
  /** Like {@link nodeById} but null when absent. */
  findById(id: string): Object3D | null;
  /** The registry path of `node` — what an op's `nodePath` carries. */
  pathOf(node: Object3D): string;
  /** Load wall time in ms (loadModel → whenSceneReady). */
  readonly loadMs: number;
  dispose(): void;
  /** `'deferred'` only: what `loadAuthoringModel` answered. */
  readonly join: AuthoringLoadResult | null;
}

/** The outer document bytes for a fixture key, its references pointing at `innerUrl`. */
async function documentBytesFor(url: string, innerUrl: string): Promise<{ name: string; bytes: ArrayBuffer }> {
  switch (url) {
    case OUTER_URL:
      return { name: 'p774-outer.glb', bytes: await objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true, assetId: 'cat:cell' }])) };
    case OUTER_DEEP_URL:
      return { name: 'p774-outer-deep.glb', bytes: await objectToGlb(makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true, assetId: 'cat:cell' }], { under: 'Mount' })) };
    case OUTER_HAND_URL:
      return { name: 'p774-outer-hand.glb', bytes: await objectToGlb(makeOuter('Machine', [{ name: 'CellRef', id: 'nid-cellref', url: innerUrl, planner: false, assetId: 'cat:cell' }])) };
    case NESTED_DOC_URL: {
      const layout = new Group();
      layout.name = 'Layout';
      layout.add(referenceNode('Machine_1', MACHINE_REF_NODE_ID, await outerDataUrl(innerUrl), true, [5, 0, 0], 'cat:machine'));
      return { name: 'p774-layout-nested.glb', bytes: await objectToGlb(layout) };
    }
    case NESTED_INNER_OVERRIDE_DOC_URL: {
      const machine = makeOuter('Machine', [{ name: 'Cell_1', id: CELL_REF_NODE_ID, url: innerUrl, planner: true, assetId: 'cat:cell' }]);
      writeOverride(findByName(machine, 'Cell_1')!, SLIDE_NODE_ID, 'Drive', 'TargetSpeed', INNER_OVERRIDE_SPEED);
      const layout = new Group();
      layout.name = 'Layout';
      layout.add(referenceNode('Machine_1', MACHINE_REF_NODE_ID, dataUrlOf(await objectToGlb(machine)), true, [5, 0, 0], 'cat:machine'));
      return { name: 'p774-layout-nested-inner-ov.glb', bytes: await objectToGlb(layout) };
    }
  }
  throw new Error(`editor-document-harness: no data: world for ${url} (supported: OUTER_URL, OUTER_DEEP_URL, OUTER_HAND_URL, NESTED_DOC_URL, NESTED_INNER_OVERRIDE_DOC_URL)`);
}

/** Open a fixture document in the asset editor's load shape and bind a scratch `AssetDocument` to it. */
export async function openEditorDocument(url: string, opts: { mode: EditorLoadMode; budgetMs?: number }): Promise<EditorDocumentHarness> {
  const { name, bytes } = await documentBytesFor(url, await innerDataUrl());
  return openEditorDocumentBytes(name, bytes, opts);
}

/**
 * Open GLB `bytes` — e.g. what `exportAssetGlb` wrote, i.e. the REOPEN of a
 * save — in the asset editor's load shape, on a fresh viewer, with a fresh
 * scratch document.
 */
export async function openEditorDocumentBytes(
  name: string, bytes: ArrayBuffer, opts: { mode: EditorLoadMode; budgetMs?: number },
): Promise<EditorDocumentHarness> {
  if (opts.mode === 'graft' && !deferSeamInstalled()) {
    throw new Error(
      "editor-document-harness: mode 'graft' needs the compose seam — add to the test file:\n"
      + "  vi.mock('../src/core/engine/rv-glb-compose', async (io) => (await import('./helpers/editor-defer-seam')).deferringComposeModule(io));",
    );
  }
  const booted = await bootRealLoaderViewer();
  const viewer = booted.h.viewer;

  const t0 = performance.now();
  let join: AuthoringLoadResult | null = null;
  if (opts.mode === 'graft') {
    await withForcedAuthoringGraft(() => viewer.loadModel(name, {
      data: bytes,
      preserveHierarchy: true,
      preserveAuthoringHierarchy: true,
    }));
    await viewer.whenSceneReady();
  } else {
    // The production editor load: `loadAuthoringModel` (load + bounded join +
    // identity check), exactly what the asset editor's load sites call.
    join = await loadAuthoringModel(viewer, name, { identity: { label: name }, keepBaked: false, data: bytes, budgetMs: opts.budgetMs });
    if (!join.ok) throw new Error('editor-document-harness: the authoring load was superseded');
  }
  const loadMs = performance.now() - t0;

  const root = viewer.currentModelRoot;
  if (!root) throw new Error('editor-document-harness: no model root after load');
  const doc = scratchAssetDocument(viewer, name.replace(/\.glb$/, ''));

  const findById = (id: string): Object3D | null => {
    let hit: Object3D | null = null;
    root.traverse((n) => { if (!hit && identityIdOf(n) === id) hit = n; });
    return hit;
  };

  return {
    mode: opts.mode,
    viewer,
    doc,
    join,
    booted,
    root,
    loadMs,
    findById,
    nodeById(id: string): Object3D {
      const n = findById(id);
      if (!n) throw new Error(`editor-document-harness (${opts.mode}): no node with identity ${id}`);
      return n;
    },
    pathOf(node: Object3D): string {
      const p = viewer.registry?.getPathForNode(node);
      if (!p) throw new Error(`editor-document-harness (${opts.mode}): node ${node.name} has no registry path`);
      return p;
    },
    dispose(): void {
      try { doc.dispose(); } catch { /* best effort */ }
      booted.h.dispose();
    },
  };
}
