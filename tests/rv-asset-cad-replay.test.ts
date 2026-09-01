// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-asset-cad-replay.test.ts — draft replay of an `importCad` op.
 *
 * The point of the GLB-first pipeline: the op carries only `{Sha256, Quality}`,
 * and the geometry comes back by parsing the CACHED GLB BYTES. So replay is a
 * byte read plus a GLTFLoader parse —
 *
 *   - it needs NO CadGeometryProvider, which means a PUBLIC build (where
 *     `getCadProvider()` is null) can reopen a draft containing STEP imports.
 *     Previously this silently lost the geometry.
 *   - it produces the SAME tree as the original import, because both parse the
 *     same bytes. That is what keeps the op log's name-paths valid across F5.
 *   - when the cache is gone it falls back to `provider.retessellate`, and when
 *     that fails too the failure is COLLECTED and surfaced (re-import prompt)
 *     instead of being swallowed into a console warning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
 import { scratchAssetDocument } from './helpers/scratch-asset-document';
import { Scene, Group, Object3D, Mesh, BoxGeometry, MeshStandardMaterial } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { registerCadProvider } from '../src/core/editor/rv-cad-provider';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { clearCadGlbCache, getCadGlb, putCadGlb } from '../src/core/import/rv-cad-glb-cache';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { loadDocumentDraft } from '../src/core/ops/rv-document-drafts';
import type { CADLinkExtras } from '../src/core/editor/rv-asset-ops';

function makeMockViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const registry = new NodeRegistry();
  registry.registerNode(NodeRegistry.computeNodePath(model), model);

  const viewer = {
    scene,
    registry,
    signalStore: null,
    transportManager: null,
    get currentModelRoot() { return model; },
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    rebuildGroupedBvh() {},
  } as unknown as RVViewer;

  return { viewer, model, registry };
}

/** A small CAD-ish tree: a named root holding one mesh body. */
function cadTree(): Object3D {
  const root = new Group();
  root.name = 'Gearbox';
  const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
  body.name = 'Housing';
  root.add(body);
  return root;
}

const CADLINK: CADLinkExtras = {
  File: 'gearbox.step',
  Sha256: 'cafebabe',
  Quality: 'standard',
  ImportScaleFactor: 0.001,
  ZIsUpVector: true,
};

/** `importCad` returns a full node path (`Asset/Gearbox`); the child carries the leaf. */
const leaf = (nodePath: string) => nodePath.split('/').pop()!;

/** Every node name in the imported subtree, or [] when it is not attached. */
function subtreeNames(model: Object3D, rootPath: string): string[] {
  const root = model.children.find((c) => c.name === leaf(rootPath));
  if (!root) return [];
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out;
}

/** Is the imported subtree currently attached under the asset root? */
const isAttached = (model: Object3D, rootPath: string) =>
  model.children.some((c) => c.name === leaf(rootPath));

let glb: ArrayBuffer;

beforeEach(async () => {
  registerCadProvider('step', null); // simulate a PUBLIC build
  await __clearDraftStoresForTests();
  await clearCadGlbCache();
  glb = await objectToGlb(cadTree());
});

afterEach(() => registerCadProvider('step', null));

describe('importCad → draft replay', () => {
  it('caches the GLB under (Sha256, Quality) before recording the op', async () => {
    const { viewer } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);

    await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();

    expect(await getCadGlb(CADLINK.Sha256, CADLINK.Quality)).not.toBeNull();
    doc.dispose();
  });

  it('replays in a PUBLIC build (no CAD provider) and rebuilds the same tree', async () => {
    const first = makeMockViewer();
    const doc = scratchAssetDocument(first.viewer);
    const rootPath = await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();

    const importedNames = subtreeNames(first.model, rootPath);
    expect(importedNames).toContain('Housing');
    const ops = doc.toDraft().ops;
    doc.dispose();

    // Fresh session: new viewer, new document, ONLY the op log — and crucially
    // no CadGeometryProvider at all. Geometry must still come back.
    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { id: 'a', name: 'A', base: { kind: 'document', documentId: 'doc_scratch', path: 'scratch.glb', name: 'Scratch' } });
    await restored.replayOps(ops);
    await restored.whenIdle();

    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    // Same names, in the same order, as the original import.
    expect(subtreeNames(second.model, rootPath)).toEqual(importedNames);
    restored.dispose();
  });

  it('falls back to provider.retessellate when the GLB cache was evicted', async () => {
    const { viewer, model } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    const rootPath = await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    const ops = doc.toDraft().ops;
    doc.dispose();

    await clearCadGlbCache(); // the cap/eviction / storage-pressure case

    const retessellate = vi.fn(async (cadlink: CADLinkExtras) => {
      await putCadGlb(cadlink.Sha256, cadlink.Quality, glb); // re-populates the cache
      return glb;
    });
    registerCadProvider('step', { importFile: async () => ({ glb, cadlink: CADLINK }), retessellate });

    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { id: 'b', name: 'B', base: { kind: 'document', documentId: 'doc_scratch', path: 'scratch.glb', name: 'Scratch' } });
    await restored.replayOps(ops);
    await restored.whenIdle();

    expect(retessellate).toHaveBeenCalledTimes(1);
    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    expect(subtreeNames(second.model, rootPath)).toContain('Housing');
    // And the cache is warm again, so the NEXT replay is a plain byte read.
    expect(await getCadGlb(CADLINK.Sha256, CADLINK.Quality)).not.toBeNull();
    restored.dispose();
    void model;
  });

  it('is deterministic: replay reproduces the ORIGINAL import tree exactly', async () => {
    const first = makeMockViewer();
    const doc = scratchAssetDocument(first.viewer);
    const rootPath = await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    const before = subtreeNames(first.model, rootPath);
    const ops = doc.toDraft().ops;
    doc.dispose();

    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { id: 'd', name: 'D', base: { kind: 'document', documentId: 'doc_scratch', path: 'scratch.glb', name: 'Scratch' } });
    await restored.replayOps(ops);
    await restored.whenIdle();

    // Same bytes in, same tree out — this is what keeps name-path ops valid.
    expect(subtreeNames(second.model, rootPath)).toEqual(before);
    restored.dispose();
  });

  it('surfaces unrecoverable geometry instead of silently dropping it', async () => {
    const { viewer } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    const ops = doc.toDraft().ops;
    doc.dispose();

    await clearCadGlbCache();
    // Public build: no provider, so no retessellate fallback either.
    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, { id: 'c', name: 'C', base: { kind: 'document', documentId: 'doc_scratch', path: 'scratch.glb', name: 'Scratch' } });
    await restored.replayOps(ops);
    await restored.whenIdle();

    const missing = restored.executor.takeMissingCadGeometry();
    expect(missing).toHaveLength(1);
    expect(missing[0].File).toBe('gearbox.step');
    // Draining is destructive — the plugin prompts once, not on every op.
    expect(restored.executor.takeMissingCadGeometry()).toEqual([]);
    restored.dispose();
  });

  // ─── plan-442 §9.3 / F5: what a DOUBLE replay does ──────────────────────
  //
  // The duplicate-scene bug had two overlapping editor activations replaying
  // the same draft into one session. The SCENE half of that is fixed in the
  // load path (tests/load-model-race.test.ts). These two measure the DOCUMENT
  // half, so the fix cannot quietly move the duplication one layer down — and
  // they measure it rather than assume it: the plan made this a verification
  // step with a fixed oracle precisely because the answer was not known.

  it('two documents replaying one draft leave the persisted draft unchanged (F5 oracle)', async () => {
    // The shape plan-442 actually produces: each activation builds its OWN
    // AssetDocument from the same draft, and both address the same frame key.
    // The oracle is the plan's: op COUNT and op IDS unchanged.
    const BASE = {
      kind: 'document' as const,
      documentId: 'doc_f5',
      path: 'f5.glb',
      name: 'F5',
    };
    const origin = makeMockViewer();
    const doc = new AssetDocument(origin.viewer, { id: 'f5_origin', name: 'F5', base: BASE });
    await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    const ops = doc.toDraft().ops;
    await doc.flushDraft();
    const before = await loadDocumentDraft(doc.draftFrame);
    doc.dispose();

    const runA = makeMockViewer();
    const a = new AssetDocument(runA.viewer, { id: 'f5_a', name: 'F5', base: BASE });
    await a.replayOps(ops);
    await a.whenIdle();
    await a.flushDraft();

    const runB = makeMockViewer();
    const b = new AssetDocument(runB.viewer, { id: 'f5_b', name: 'F5', base: BASE });
    await b.replayOps(ops);
    await b.whenIdle();
    await b.flushDraft();

    const after = await loadDocumentDraft(b.draftFrame);
    expect(after?.ops.length).toBe(before?.ops.length);
    expect(after?.ops.map((o) => o.id)).toEqual(before?.ops.map((o) => o.id));
    expect(after?.ops.length).toBe(ops.length);
    a.dispose();
    b.dispose();
  });

  it('KNOWN GAP: replaying one op log twice into the SAME document appends it twice', async () => {
    // Measured, not desired. This is NOT the activation race — that one builds
    // a second document (test above) — but it is a real second way to double a
    // document, and the plan is explicit that a positive finding here becomes
    // its own follow-up plan rather than a fix smuggled into 442.
    //
    // The test asserts the CURRENT behaviour so the follow-up has a starting
    // point and this file fails loudly when someone changes it: if you are here
    // because this test broke, the fix landed — flip the expectations.
    const { viewer } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    const rootPath = await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    const ops = doc.toDraft().ops;
    doc.dispose();

    const second = makeMockViewer();
    const restored = new AssetDocument(second.viewer, {
      id: 'dbl', name: 'Dbl',
      base: { kind: 'document', documentId: 'doc_dbl', path: 'dbl.glb', name: 'Dbl' },
    });
    await restored.replayOps(ops);
    await restored.whenIdle();
    await restored.flushDraft();
    const afterOne = await loadDocumentDraft(restored.draftFrame);

    await restored.replayOps(ops);
    await restored.whenIdle();
    await restored.flushDraft();
    const afterTwo = await loadDocumentDraft(restored.draftFrame);

    // The tree gains a second copy of the imported subtree …
    expect(second.model.children.filter((c) => c.name === leaf(rootPath))).toHaveLength(2);
    // … and the persisted draft gains a second copy of the op log, which the
    // next crash recovery would replay as-is.
    expect(afterOne?.ops.length).toBe(ops.length);
    expect(afterTwo?.ops.length).toBe(ops.length * 2);
    restored.dispose();
  });

  it('undo parks the subtree; redo re-attaches it without touching the cache', async () => {
    const { viewer, model } = makeMockViewer();
    const doc = scratchAssetDocument(viewer);
    const rootPath = await doc.importCad({ glb, cadlink: CADLINK });
    await doc.whenIdle();
    expect(isAttached(model, rootPath)).toBe(true);

    await doc.undo();
    expect(isAttached(model, rootPath)).toBe(false);

    await clearCadGlbCache(); // redo must NOT need the cache — trash holds the tree
    await doc.redo();
    expect(isAttached(model, rootPath)).toBe(true);
    expect(doc.executor.takeMissingCadGeometry()).toEqual([]);
    doc.dispose();
  });
});
