// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.2 — moving a REFERENCED file repoints the rows that name it
 * (plan-718 §2.4, R3).
 *
 * The existing move tests all ask the forward question: a document's own row
 * follows its own bytes. This asks the backward one, which is structurally
 * different and therefore its own file: a `connect/*.connect.json` or a
 * `scripts/*.ts` has **no row of its own**. Nothing in the manifest describes
 * it. The only trace it leaves is the rows that point at it — so if this search
 * is forgotten, a move leaves dead references behind and nothing anywhere
 * notices.
 *
 * The IO fake is the same one `project-tree-move.test.ts` uses, on purpose: the
 * claim is about which writes happen, and a fake that IS the surfaces states it
 * directly.
 */

import { describe, it, expect } from 'vitest';
import { applyTreeMove } from '../src/core/project/rv-project-tree-move';
import type { TreeMovePlan } from '../src/core/project/rv-project-tree';
import type { DocsIndex } from '../src/core/project/rv-docs-index';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

function project(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 2,
    id: 'proj_test',
    name: 'Test project',
    documents,
  } as unknown as RvProject;
}

/** Two documents bound to ONE connect file and ONE script — the N:1 case. */
function sharedRefs(): RvProject {
  return project([
    {
      id: 'ast_m8x', path: 'models/linie1.glb', name: 'Linie 1', section: 'models',
      connectRef: 'connect/linie-1.connect.json',
      scriptRef: 'scripts/linie1/index.ts',
      knowledgeRef: 'knowledge/linie-1.json',
    },
    {
      id: 'ast_p4q', path: 'models/linie1-detail.glb', name: 'Detail', section: 'models',
      connectRef: 'connect/linie-1.connect.json',
      scriptRef: 'scripts/linie1/index.ts',
    },
    {
      id: 'ast_z12', path: 'models/versand.glb', name: 'Versand', section: 'models',
      connectRef: 'connect/versand.connect.json',
    },
  ]);
}

function fakeIO(files: Record<string, string>, manifest: RvProject | null) {
  const bytes = new Map<string, string>(Object.entries(files));
  const state = { bytes, manifest, manifestWrites: 0, docsIndex: null as DocsIndex | null };
  const io = {
    readBytes: async (p: string) => (bytes.has(p) ? new Blob([bytes.get(p)!]) : null),
    writeBytes: async (p: string, blob: Blob) => { bytes.set(p, await blob.text()); },
    deleteBytes: async (p: string) => { bytes.delete(p); },
    readManifest: async () => state.manifest,
    writeManifest: async (next: RvProject) => { state.manifest = next; state.manifestWrites++; },
    readDocsIndex: async () => state.docsIndex as unknown,
    writeDocsIndex: async (index: DocsIndex) => { state.docsIndex = index; },
  };
  return { io, state };
}

/**
 * A plan for one file, written directly.
 *
 * `planTreeMove` needs a tree, and a tree needs a backend listing. The plan is a
 * plain record and the thing under test is what `applyTreeMove` does WITH one,
 * so building it by hand states the case instead of staging it.
 */
function filePlan(from: string, to: string, documentId?: string): TreeMovePlan {
  return {
    from, to, rootId: 'proj',
    ...(documentId ? { documentId } : {}),
    rewritesDocsIndex: false,
    folder: false,
    descendants: [],
  };
}

function folderPlan(
  from: string, to: string,
  descendants: Array<{ from: string; to: string; documentId?: string }>,
): TreeMovePlan {
  return {
    from, to, rootId: 'proj',
    rewritesDocsIndex: false,
    folder: true,
    descendants: descendants.map(d => ({ ...d, rewritesDocsIndex: false })),
  };
}

const rowOf = (m: RvProject | null, id: string) => m!.documents!.find(d => d.id === id)!;

describe('§9.2 — moving a referenced file repoints every row that names it', () => {
  it('repoints both rows of an N:1 binding, and counts them separately', async () => {
    const { io, state } = fakeIO(
      { 'connect/linie-1.connect.json': '{}' },
      sharedRefs(),
    );
    const outcome = await applyTreeMove(
      io, filePlan('connect/linie-1.connect.json', 'connect/lines/linie-1.connect.json'),
    );

    expect(outcome.refRows).toBe(2);
    // The one counter that must NOT move: no document row followed its own bytes.
    expect(outcome.manifestRows).toBe(0);
    expect(rowOf(state.manifest, 'ast_m8x').connectRef)
      .toBe('connect/lines/linie-1.connect.json');
    expect(rowOf(state.manifest, 'ast_p4q').connectRef)
      .toBe('connect/lines/linie-1.connect.json');
    expect(state.manifestWrites).toBe(1);
    expect(state.bytes.get('connect/lines/linie-1.connect.json')).toBe('{}');
  });

  it('leaves an unreferenced neighbour untouched', async () => {
    const { io, state } = fakeIO(
      { 'connect/spare.connect.json': '{}' },
      sharedRefs(),
    );
    const before = JSON.stringify(state.manifest);
    const outcome = await applyTreeMove(
      io, filePlan('connect/spare.connect.json', 'archive/spare.connect.json'),
    );
    expect(outcome.refRows).toBe(0);
    // Nothing pointed at it, so the manifest is not written at all.
    expect(state.manifestWrites).toBe(0);
    expect(JSON.stringify(state.manifest)).toBe(before);
  });

  it('repoints all three fields when a whole folder moves', async () => {
    const { io, state } = fakeIO(
      {
        'scripts/linie1/index.ts': 'export {}',
        'scripts/conveyor.ts': 'export {}',
      },
      sharedRefs(),
    );
    const outcome = await applyTreeMove(io, folderPlan('scripts', 'code', [
      { from: 'scripts/linie1/index.ts', to: 'code/linie1/index.ts' },
      { from: 'scripts/conveyor.ts', to: 'code/conveyor.ts' },
    ]));

    expect(outcome.refRows).toBe(2);
    expect(rowOf(state.manifest, 'ast_m8x').scriptRef).toBe('code/linie1/index.ts');
    expect(rowOf(state.manifest, 'ast_p4q').scriptRef).toBe('code/linie1/index.ts');
    // The other two fields on the same row are untouched.
    expect(rowOf(state.manifest, 'ast_m8x').knowledgeRef).toBe('knowledge/linie-1.json');
  });

  it('a rename of a knowledge file follows too', async () => {
    const { io, state } = fakeIO({ 'knowledge/linie-1.json': '{}' }, sharedRefs());
    const outcome = await applyTreeMove(
      io, filePlan('knowledge/linie-1.json', 'knowledge/linie-eins.json'),
    );
    expect(outcome.refRows).toBe(1);
    expect(rowOf(state.manifest, 'ast_m8x').knowledgeRef).toBe('knowledge/linie-eins.json');
  });

  it('a document move does BOTH halves in one manifest write', async () => {
    // Somebody bound linie1.glb's own row to a script, and now the GLB moves.
    // Its `path` follows its bytes (forward) and its refs are untouched — while
    // a SECOND step in the same plan moves the script itself (backward).
    const { io, state } = fakeIO(
      { 'models/linie1.glb': 'GLB', 'scripts/linie1/index.ts': 'export {}' },
      sharedRefs(),
    );
    const outcome = await applyTreeMove(io, folderPlan('.', '.', [
      { from: 'models/linie1.glb', to: 'models/archive/linie1.glb', documentId: 'ast_m8x' },
      { from: 'scripts/linie1/index.ts', to: 'scripts/v2/index.ts' },
    ]));

    expect(outcome.manifestRows).toBe(1);
    expect(outcome.refRows).toBe(2);
    expect(state.manifestWrites).toBe(1);
    const row = rowOf(state.manifest, 'ast_m8x');
    expect(row.path).toBe('models/archive/linie1.glb');
    expect(row.id).toBe('ast_m8x');
    expect(row.scriptRef).toBe('scripts/v2/index.ts');
  });
});

describe('§9.2 — the refusal guarantee survives the new step', () => {
  it('refuses before ANY byte moves when the destination is taken', async () => {
    const { io, state } = fakeIO(
      { 'connect/linie-1.connect.json': '{}', 'connect/lines/linie-1.connect.json': 'OTHER' },
      sharedRefs(),
    );
    await expect(applyTreeMove(
      io, filePlan('connect/linie-1.connect.json', 'connect/lines/linie-1.connect.json'),
    )).rejects.toThrow(/already exists/);
    expect(state.manifestWrites).toBe(0);
    expect(state.bytes.get('connect/linie-1.connect.json')).toBe('{}');
    expect(rowOf(state.manifest, 'ast_m8x').connectRef).toBe('connect/linie-1.connect.json');
  });

  it('still refuses an unregistered document, with nothing written', async () => {
    const { io, state } = fakeIO({ 'models/ghost.glb': 'GLB' }, sharedRefs());
    await expect(applyTreeMove(
      io, filePlan('models/ghost.glb', 'archive/ghost.glb', 'doc_ghost'),
    )).rejects.toThrow(/adoption guarantee is broken/);
    expect(state.manifestWrites).toBe(0);
    expect(state.bytes.has('models/ghost.glb')).toBe(true);
  });

  it('a project with no manifest moves an unreferenced file without complaint', async () => {
    // The backward repoint must not turn "this project has no manifest" into a
    // new refusal for a move that never needed one.
    const { io, state } = fakeIO({ 'connect/a.json': '{}' }, null);
    const outcome = await applyTreeMove(io, filePlan('connect/a.json', 'archive/a.json'));
    expect(outcome.refRows).toBe(0);
    expect(state.bytes.get('archive/a.json')).toBe('{}');
  });
});
