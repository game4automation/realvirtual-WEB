// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.8 — moving a GLB in the project tree rewrites its PATH and keeps its ID
 * (plan-703 Phase 5, F12).
 *
 * The whole of the repair is that one sentence, because a reference resolves by
 * `assetId` first (`rv-glb-reference-resolver.ts`: "the stable identity — a file
 * renamed or moved inside a library still resolves"). So the test that matters
 * is not "the path changed" but "the referencing file still finds the bytes
 * afterwards", which is asserted here by resolving the reference the way the
 * production resolver does: id first, path second.
 *
 * **The second half arrived with Phase 6** (plan-703 run 7): a NON-GLB move
 * rewrites `docs-index.json`, and it may only rewrite rows that already exist.
 * That rule is what keeps the app from becoming a second AUTHOR of a file the
 * build generates — it is only allowed to keep the pointers honest (§2.6.5,
 * §5.4, decision 23).
 *
 * Browser-mode on purpose, not `.node.test.ts` (§9.8's own category correction
 * in review round 2): a move is client code, and the six existing move/manifest
 * tests all run here.
 */

import { describe, it, expect } from 'vitest';
import {
  findDocumentById,
  findDocumentByPath,
  moveDocumentPath,
  previewAssetId,
} from '../src/core/project/rv-asset-identity';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import {
  countDocsIndexReferences,
  docsIndexPaths,
  parseDocsIndex,
  rewriteDocsIndexPath,
  rewriteDocsIndexPaths,
  type DocsIndex,
} from '../src/core/project/rv-docs-index';
import {
  buildProjectTree,
  canMoveInTree,
  canRenameInTree,
  planTreeMove,
} from '../src/core/project/rv-project-tree';
import { applyTreeMove, treeMoveSteps } from '../src/core/project/rv-project-tree-move';

function project(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 2,
    id: 'proj_test',
    name: 'Test project',
    documents,
  } as unknown as RvProject;
}

const ROLL_PATH = 'library/parts/Roll2m.glb';
const ROLL_ID = previewAssetId(ROLL_PATH);

/** A manifest with one referenced part and one plant that references it. */
function plantWithPart(partPath = ROLL_PATH): RvProject {
  return project([
    { id: ROLL_ID, path: partPath, name: 'Roll2m', section: 'library' },
    { id: 'doc_plant', path: 'scenes/Plant.scene.glb', name: 'Plant', section: 'scenes' },
  ]);
}

/**
 * The resolution order the production resolver uses, in miniature: `assetId`
 * through the manifest, then `path` relative to the containing file.
 */
function resolve(
  manifest: RvProject,
  reference: { assetId: string; path?: string },
): RvDocumentEntry | null {
  return findDocumentById(manifest, reference.assetId)
    ?? (reference.path ? findDocumentByPath(manifest, reference.path) : null);
}

describe('§9.8 — a GLB move keeps the id and rewrites the path', () => {
  it('rewrites the path of the moved row', () => {
    const moved = moveDocumentPath(plantWithPart(), ROLL_ID, 'library/rollers/Roll2m.glb');
    const row = findDocumentById(moved, ROLL_ID);
    expect(row?.path).toBe('library/rollers/Roll2m.glb');
  });

  it('leaves the id unchanged — including where the derivation would not', () => {
    const moved = moveDocumentPath(plantWithPart(), ROLL_ID, 'library/rollers/Roll2m.glb');
    const row = findDocumentById(moved, ROLL_ID);
    expect(row?.id).toBe(ROLL_ID);
    // The derived id of the NEW path is a different string. The stored one wins,
    // and that divergence is exactly what makes the move survivable.
    expect(previewAssetId('library/rollers/Roll2m.glb')).not.toBe(ROLL_ID);
  });

  it('the referencing file still resolves after the move', () => {
    const reference = { assetId: ROLL_ID, path: 'parts/Roll2m.glb' };
    const before = plantWithPart();
    expect(resolve(before, reference)?.path).toBe(ROLL_PATH);

    const moved = moveDocumentPath(before, ROLL_ID, 'library/rollers/Roll2m.glb');
    const hit = resolve(moved, reference);
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe(ROLL_ID);
    expect(hit?.path).toBe('library/rollers/Roll2m.glb');
  });

  it('touches nothing else on the row, and no other row', () => {
    const before = plantWithPart();
    const original = findDocumentById(before, ROLL_ID)!;
    const moved = moveDocumentPath(before, ROLL_ID, 'models/Roll2m.glb');
    const row = findDocumentById(moved, ROLL_ID)!;

    expect(row).toEqual({ ...original, path: 'models/Roll2m.glb' });
    expect(findDocumentById(moved, 'doc_plant'))
      .toEqual(findDocumentById(before, 'doc_plant'));
    // The input manifest is not mutated — the caller decides when to persist.
    expect(findDocumentById(before, ROLL_ID)?.path).toBe(ROLL_PATH);
  });

  it('a move to where the row already is is a no-op, object identity included', () => {
    const before = plantWithPart();
    expect(moveDocumentPath(before, ROLL_ID, ROLL_PATH)).toBe(before);
    // Normalisation makes "the same path spelled differently" the same no-op.
    expect(moveDocumentPath(before, ROLL_ID, './library/parts/Roll2m.glb')).toBe(before);
  });

  it('refuses to move onto an occupied path instead of shadowing it', () => {
    const crowded = project([
      { id: ROLL_ID, path: ROLL_PATH, name: 'Roll2m', section: 'library' },
      { id: 'doc_other', path: 'models/Roll2m.glb', name: 'Other roll', section: 'models' },
    ]);
    expect(() => moveDocumentPath(crowded, ROLL_ID, 'models/Roll2m.glb'))
      .toThrow(/already taken by "Other roll"/);
  });

  it('refuses a move of an unknown id rather than silently doing nothing', () => {
    expect(() => moveDocumentPath(plantWithPart(), 'doc_nope', 'models/X.glb'))
      .toThrow(/No document with id "doc_nope"/);
  });

  it('rejects an empty destination', () => {
    expect(() => moveDocumentPath(plantWithPart(), ROLL_ID, '   ')).toThrow();
  });
});

// ─── The second half: a non-GLB move rewrites docs-index.json ────────────

/**
 * The tree both the planning and the write-path sections move things around in.
 *
 * Module scope, not inside a `describe`: the write-path section below plans
 * against the same fixture, and two copies of it could drift apart while both
 * kept passing.
 */
const TREE = () => buildProjectTree([{
  id: 'proj',
  name: 'MyPlant',
  kind: 'project',
  writable: true,
  files: [
    { path: 'library/parts/Roll2m.glb', documentId: ROLL_ID },
    { path: 'docs/Module_A/4112630_E_BOM.pdf' },
    { path: 'docs/Module_A/4112630_E_HTC.pdf' },
    { path: 'archive/.keep' },
  ],
}]);

/** The shape the build writes: part number → its document links. */
function docsIndex(): DocsIndex {
  return {
    '4112630': [
      { title: 'E BOM', path: 'docs/Module_A/4112630_E_BOM.pdf' },
      { title: 'E HTC-BZ-001.1', path: 'docs/Module_A/4112630_E_HTC.pdf' },
    ],
    '4112567': [
      { title: 'PNEUMATIC CYLINDER', path: 'docs/Module_B/4112567_CYL.pdf' },
    ],
  };
}

describe('§9.8 — a non-GLB move rewrites docs-index.json', () => {
  it('repoints every row naming the moved file', () => {
    const { index, rewritten } = rewriteDocsIndexPath(
      docsIndex(),
      'docs/Module_A/4112630_E_BOM.pdf',
      'docs/Archive/4112630_E_BOM.pdf',
    );
    expect(rewritten).toBe(1);
    expect(index['4112630'][0].path).toBe('docs/Archive/4112630_E_BOM.pdf');
    // …and nothing else moved.
    expect(index['4112630'][1].path).toBe('docs/Module_A/4112630_E_HTC.pdf');
    expect(index['4112567'][0].path).toBe('docs/Module_B/4112567_CYL.pdf');
  });

  it('keeps the title and every unknown key the build may have added', () => {
    const before: DocsIndex = {
      '1': [{ title: 'BOM', path: 'docs/a.pdf', lang: 'de', pages: 12 }],
    };
    const { index } = rewriteDocsIndexPath(before, 'docs/a.pdf', 'docs/b/a.pdf');
    expect(index['1'][0]).toEqual({ title: 'BOM', path: 'docs/b/a.pdf', lang: 'de', pages: 12 });
  });

  it('**creates no entry** for a file the build never indexed', () => {
    // The whole mitigation of §5.4 in one assertion: two writers are only safe
    // while the app is not one of the AUTHORS. A move of an unindexed file is a
    // no-op, object identity included, so the caller skips its write entirely.
    const before = docsIndex();
    const result = rewriteDocsIndexPath(before, 'docs/never-indexed.pdf', 'parts/never-indexed.pdf');
    expect(result.rewritten).toBe(0);
    expect(result.index).toBe(before);
    expect(docsIndexPaths(result.index)).toHaveLength(3);
  });

  it('deletes nothing, and adds no part number', () => {
    const before = docsIndex();
    const { index } = rewriteDocsIndexPaths(before, [
      { from: 'docs/Module_A/4112630_E_BOM.pdf', to: 'x/BOM.pdf' },
      { from: 'docs/Module_B/4112567_CYL.pdf', to: 'x/CYL.pdf' },
    ]);
    expect(Object.keys(index).sort()).toEqual(Object.keys(before).sort());
    expect(index['4112630']).toHaveLength(2);
    expect(index['4112567']).toHaveLength(1);
  });

  it('repoints all of them when several rows share one file', () => {
    const shared: DocsIndex = {
      '1': [{ title: 'Shared', path: 'docs/shared.pdf' }],
      '2': [{ title: 'Shared', path: 'docs/shared.pdf' }],
    };
    expect(countDocsIndexReferences(shared, 'docs/shared.pdf')).toBe(2);
    const { index, rewritten } = rewriteDocsIndexPath(shared, 'docs/shared.pdf', 'docs/x/shared.pdf');
    expect(rewritten).toBe(2);
    expect(index['1'][0].path).toBe('docs/x/shared.pdf');
    expect(index['2'][0].path).toBe('docs/x/shared.pdf');
  });

  it('does not confuse a folder with one whose name it prefixes', () => {
    // `docs/Module_A` must not match `docs/Module_A_old`. The move list is
    // per FILE precisely so no prefix comparison exists to get this wrong.
    const index: DocsIndex = {
      '1': [{ title: 'A', path: 'docs/Module_A/x.pdf' }],
      '2': [{ title: 'Old', path: 'docs/Module_A_old/x.pdf' }],
    };
    const result = rewriteDocsIndexPaths(index, [
      { from: 'docs/Module_A/x.pdf', to: 'archive/Module_A/x.pdf' },
    ]);
    expect(result.index['1'][0].path).toBe('archive/Module_A/x.pdf');
    expect(result.index['2'][0].path).toBe('docs/Module_A_old/x.pdf');
  });

  it('matches through the spellings a path can arrive in', () => {
    const index: DocsIndex = { '1': [{ title: 'A', path: './docs/a.pdf' }] };
    expect(rewriteDocsIndexPath(index, 'docs/a.pdf', 'x/a.pdf').rewritten).toBe(1);
    expect(rewriteDocsIndexPath(index, 'docs\\a.pdf', 'x/a.pdf').rewritten).toBe(1);
    // A move to where it already is is not a move.
    expect(rewriteDocsIndexPath(index, 'docs/a.pdf', './docs/a.pdf').rewritten).toBe(0);
  });

  it('survives a malformed index by losing only the malformed row', () => {
    const parsed = parseDocsIndex({
      '1': [{ title: 'Good', path: 'docs/a.pdf' }, { title: 'No path' }, 42],
      '2': 'not an array',
      '3': [],
    });
    expect(Object.keys(parsed)).toEqual(['1']);
    expect(parsed['1']).toHaveLength(1);
    expect(parseDocsIndex(null)).toEqual({});
    expect(parseDocsIndex([])).toEqual({});
  });

  // ── The tree move that triggers it ──

  it('a GLB move plans a manifest rewrite, never a docs-index one', () => {
    const roots = TREE();
    const from = 'proj/library/parts/Roll2m.glb';
    const verdict = canMoveInTree(roots, from, 'proj/archive');
    expect(verdict.ok).toBe(true);
    const plan = planTreeMove(roots, from, verdict);
    expect(plan.documentId).toBe(ROLL_ID);
    expect(plan.rewritesDocsIndex).toBe(false);
  });

  it('a PDF move plans a docs-index rewrite, never a manifest one', () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A/4112630_E_BOM.pdf';
    const verdict = canMoveInTree(roots, from, 'proj/archive');
    expect(verdict.ok).toBe(true);
    const plan = planTreeMove(roots, from, verdict);
    expect(plan.documentId).toBeUndefined();
    expect(plan.rewritesDocsIndex).toBe(true);

    const { index, rewritten } = rewriteDocsIndexPath(docsIndex(), plan.from, plan.to);
    expect(rewritten).toBe(1);
    expect(index['4112630'][0].path).toBe('archive/4112630_E_BOM.pdf');
  });

  it('a FOLDER of PDFs moves as one plan, and every row follows', () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A';
    const verdict = canMoveInTree(roots, from, 'proj/archive');
    expect(verdict.ok).toBe(true);
    const plan = planTreeMove(roots, from, verdict);

    const { index, rewritten } = rewriteDocsIndexPaths(docsIndex(), plan.descendants);
    expect(rewritten).toBe(2);
    expect(index['4112630'].map(e => e.path)).toEqual([
      'archive/Module_A/4112630_E_BOM.pdf',
      'archive/Module_A/4112630_E_HTC.pdf',
    ]);
    // The PDF of another module was not in the moved folder and did not move.
    expect(index['4112567'][0].path).toBe('docs/Module_B/4112567_CYL.pdf');
  });
});

// ─── The write path (plan-703 Phase 5 rest, run 9) ───────────────────────

/**
 * `applyTreeMove` is the half of the move that actually writes. Everything
 * above proves the RULES; this proves that a caller following them ends up
 * with bytes, a manifest and a `docs-index.json` that agree.
 *
 * The IO is a fake in-memory store rather than a mocked backend: the claim
 * under test is "these three writes happen, in this order, and no others", and
 * a fake that IS the three surfaces states it directly.
 */
function fakeIO(files: Record<string, string>, opts: {
  manifest?: RvProject | null;
  docsIndex?: DocsIndex | null;
} = {}) {
  const bytes = new Map<string, string>(Object.entries(files));
  const state = {
    bytes,
    manifest: opts.manifest ?? null,
    docsIndex: opts.docsIndex ?? null,
    manifestWrites: 0,
    docsIndexWrites: 0,
  };
  const io = {
    readBytes: async (p: string) =>
      (bytes.has(p) ? new Blob([bytes.get(p)!]) : null),
    writeBytes: async (p: string, blob: Blob) => { bytes.set(p, await blob.text()); },
    deleteBytes: async (p: string) => { bytes.delete(p); },
    readManifest: async () => state.manifest,
    writeManifest: async (next: RvProject) => {
      state.manifest = next;
      state.manifestWrites++;
    },
    readDocsIndex: async () => state.docsIndex as unknown,
    writeDocsIndex: async (index: DocsIndex) => {
      state.docsIndex = index;
      state.docsIndexWrites++;
    },
  };
  return { io, state };
}

describe('§9.8 — applyTreeMove performs exactly what the plan said', () => {
  function glbPlan() {
    const roots = TREE();
    const from = 'proj/library/parts/Roll2m.glb';
    return planTreeMove(roots, from, canMoveInTree(roots, from, 'proj/archive'));
  }

  it('moves the bytes and repoints the manifest row, id untouched', async () => {
    const { io, state } = fakeIO(
      { 'library/parts/Roll2m.glb': 'GLB' },
      { manifest: plantWithPart() },
    );
    const outcome = await applyTreeMove(io, glbPlan());

    expect(outcome.moved).toEqual([
      { from: 'library/parts/Roll2m.glb', to: 'archive/Roll2m.glb' },
    ]);
    expect(state.bytes.has('library/parts/Roll2m.glb')).toBe(false);
    expect(state.bytes.get('archive/Roll2m.glb')).toBe('GLB');

    expect(outcome.manifestRows).toBe(1);
    const row = findDocumentById(state.manifest!, ROLL_ID);
    expect(row?.path).toBe('archive/Roll2m.glb');
    expect(row?.id).toBe(ROLL_ID);
    // The whole promise, restated the way the resolver asks it.
    expect(resolve(state.manifest!, { assetId: ROLL_ID })?.path).toBe('archive/Roll2m.glb');
  });

  it('never touches docs-index.json for a GLB', async () => {
    const { io, state } = fakeIO(
      { 'library/parts/Roll2m.glb': 'GLB' },
      { manifest: plantWithPart(), docsIndex: docsIndex() },
    );
    const outcome = await applyTreeMove(io, glbPlan());
    expect(outcome.docsIndexRows).toBe(0);
    expect(state.docsIndexWrites).toBe(0);
  });

  it('repoints docs-index.json for a PDF, and writes no manifest', async () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A/4112630_E_BOM.pdf';
    const plan = planTreeMove(roots, from, canMoveInTree(roots, from, 'proj/archive'));
    const { io, state } = fakeIO(
      { 'docs/Module_A/4112630_E_BOM.pdf': 'PDF' },
      { manifest: plantWithPart(), docsIndex: docsIndex() },
    );

    const outcome = await applyTreeMove(io, plan);
    expect(outcome.docsIndexRows).toBe(1);
    expect(outcome.manifestRows).toBe(0);
    expect(state.manifestWrites).toBe(0);
    expect(state.docsIndex!['4112630'][0].path).toBe('archive/4112630_E_BOM.pdf');
    expect(state.bytes.get('archive/4112630_E_BOM.pdf')).toBe('PDF');
  });

  it('creates no docs-index.json for a project that has none', async () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A/4112630_E_BOM.pdf';
    const plan = planTreeMove(roots, from, canMoveInTree(roots, from, 'proj/archive'));
    const { io, state } = fakeIO(
      { 'docs/Module_A/4112630_E_BOM.pdf': 'PDF' },
      { manifest: plantWithPart(), docsIndex: null },
    );

    const outcome = await applyTreeMove(io, plan);
    // The bytes still moved — the index is a pointer file, not a precondition.
    expect(state.bytes.get('archive/4112630_E_BOM.pdf')).toBe('PDF');
    expect(outcome.docsIndexRows).toBe(0);
    expect(state.docsIndexWrites).toBe(0);
    expect(state.docsIndex).toBeNull();
  });

  it('carries a folder as one write per descendant, folder itself excluded', async () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A';
    const plan = planTreeMove(roots, from, canMoveInTree(roots, from, 'proj/archive'));
    const { io, state } = fakeIO({
      'docs/Module_A/4112630_E_BOM.pdf': 'A',
      'docs/Module_A/4112630_E_HTC.pdf': 'B',
    }, { manifest: plantWithPart(), docsIndex: docsIndex() });

    const outcome = await applyTreeMove(io, plan);
    expect(outcome.moved.map(m => m.to)).toEqual([
      'archive/Module_A/4112630_E_BOM.pdf',
      'archive/Module_A/4112630_E_HTC.pdf',
    ]);
    expect(outcome.docsIndexRows).toBe(2);
    // …and one write, not two: the rewrite is batched over the descendants.
    expect(state.docsIndexWrites).toBe(1);
    expect(state.docsIndex!['4112567'][0].path).toBe('docs/Module_B/4112567_CYL.pdf');
  });

  it('refuses before writing anything when the destination is occupied', async () => {
    const { io, state } = fakeIO(
      { 'library/parts/Roll2m.glb': 'GLB', 'archive/Roll2m.glb': 'SOMETHING ELSE' },
      { manifest: plantWithPart() },
    );
    await expect(applyTreeMove(io, glbPlan())).rejects.toThrow(/already exists/);
    // The source is still there and the occupant is untouched.
    expect(state.bytes.get('library/parts/Roll2m.glb')).toBe('GLB');
    expect(state.bytes.get('archive/Roll2m.glb')).toBe('SOMETHING ELSE');
    expect(state.manifestWrites).toBe(0);
  });

  it('refuses a move whose bytes cannot be read', async () => {
    const { io } = fakeIO({}, { manifest: plantWithPart() });
    await expect(applyTreeMove(io, glbPlan())).rejects.toThrow(/could not be read/);
  });

  it('refuses BEFORE moving bytes when there is no manifest to update', async () => {
    // The one genuinely bad state used to be reachable here: the file moved,
    // then the manifest step threw, and nothing pointed at the new location.
    // The manifest is now computed before any byte write, so the refusal
    // leaves the file exactly where it was.
    const { io, state } = fakeIO({ 'library/parts/Roll2m.glb': 'GLB' }, { manifest: null });
    await expect(applyTreeMove(io, glbPlan()))
      .rejects.toThrow(/no manifest to update/);
    expect(state.bytes.get('library/parts/Roll2m.glb')).toBe('GLB');
    expect(state.bytes.has('archive/Roll2m.glb')).toBe(false);
  });

  it('RE-PINNED in plan-717 Phase 4: refuses a scan-derived id with no row', async () => {
    // This case has been through three states, and the sequence is the point.
    //
    //  1. Originally: the bytes moved and the manifest step THEN threw `No
    //     document with id …` — file somewhere the manifest does not point.
    //  2. plan-703: the manifest moved first, and a missing row was MINTED at
    //     the old path, because `documents: []` shipped in real projects and a
    //     move was a "first meaningful operation" (decision 5).
    //  3. plan-717 Phase 4: `adoptDiscoveredDocuments` gives every file of a
    //     writable project a row before the tree can offer it, so premise (2) is
    //     gone. A gap is now a broken guarantee, and the move says so instead of
    //     minting a row it has no scan result to fill in.
    //
    // What survives all three: nothing moves before the manifest agrees.
    const { io, state } = fakeIO(
      { 'library/parts/Roll2m.glb': 'GLB' },
      { manifest: project([]) },
    );

    await expect(applyTreeMove(io, glbPlan()))
      .rejects.toThrow(/unregistered file reached tree-move/);
    // The message names the file and tells the user what repairs it.
    await expect(applyTreeMove(io, glbPlan()))
      .rejects.toThrow(/library\/parts\/Roll2m\.glb/);

    expect(state.bytes.get('library/parts/Roll2m.glb')).toBe('GLB');
    expect(state.bytes.has('archive/Roll2m.glb')).toBe(false);
    expect(state.manifestWrites).toBe(0);
  });

  it('still moves the row, and only the row, when the document IS registered', async () => {
    // The other half of the flip: adoption is what makes the refusal above safe,
    // so the registered path has to stay exactly as it was — id untouched, which
    // is what keeps a reference written before the move resolving after it.
    const { io, state } = fakeIO(
      { 'library/parts/Roll2m.glb': 'GLB' },
      { manifest: plantWithPart() },
    );
    const outcome = await applyTreeMove(io, glbPlan());

    expect(state.bytes.get('archive/Roll2m.glb')).toBe('GLB');
    expect(outcome.manifestRows).toBe(1);
    expect(findDocumentById(state.manifest!, ROLL_ID)?.path).toBe('archive/Roll2m.glb');
    expect(resolve(state.manifest!, { assetId: ROLL_ID })?.path).toBe('archive/Roll2m.glb');
  });
});

// ─── The empty-folder rename (field finding 2026-08-14) ──────────────────
//
// A folder carries no bytes; its steps are its descendants. An EMPTY folder
// has none — and the step flattening used to fall back to "one step for the
// node itself", read the folder as a file and throw `"<name>" could not be
// read` on every rename of a folder the user had just created. The rename of
// the folder ITSELF is the declared-folders remap the dashboard performs
// after `applyTreeMove`; the move machinery's whole part is to not object.

describe('an EMPTY folder renames without a byte move', () => {
  const emptyFolderTree = () => buildProjectTree([{
    id: 'proj',
    name: 'MyPlant',
    kind: 'project',
    writable: true,
    files: [{ path: 'RollingMill.glb' }],
    folders: ['New Folder'],
  }]);

  it('plans no step for the folder itself', () => {
    const roots = emptyFolderTree();
    const verdict = canRenameInTree(roots, 'proj/New Folder', 'Machines');
    expect(verdict.ok).toBe(true);
    const plan = planTreeMove(roots, 'proj/New Folder', verdict);
    expect(plan.folder).toBe(true);
    expect(treeMoveSteps(plan)).toEqual([]);
  });

  it('applies as a pure no-op on bytes — it used to throw "could not be read"', async () => {
    const roots = emptyFolderTree();
    const plan = planTreeMove(
      roots, 'proj/New Folder', canRenameInTree(roots, 'proj/New Folder', 'Machines'));
    const { io, state } = fakeIO({}, { manifest: plantWithPart() });

    const outcome = await applyTreeMove(io, plan);

    expect(outcome.moved).toEqual([]);
    expect(outcome.manifestRows).toBe(0);
    expect(state.manifestWrites).toBe(0);
    expect(state.bytes.size).toBe(0);
  });

  it('a folder WITH children still moves exactly its descendants', () => {
    const roots = TREE();
    const from = 'proj/docs/Module_A';
    const plan = planTreeMove(roots, from, canMoveInTree(roots, from, 'proj/archive'));
    expect(plan.folder).toBe(true);
    expect(treeMoveSteps(plan).map(s => s.from)).toEqual([
      'docs/Module_A/4112630_E_BOM.pdf',
      'docs/Module_A/4112630_E_HTC.pdf',
    ]);
  });
});
