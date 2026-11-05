// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-780 9.3 / 9.4 — the writers write ids only (contract documents-projects 4,
 * node-identity 1 / 11), the copy keeps what a document means, and the open
 * paths read a reference in its referrer's scope (9.2).
 *
 *  - R4: every writer goes through ONE rule (`referenceForWrite`): no `path` beside
 *    a document id, no `global`, a qualifier only across projects, no
 *    self-qualifier (A2); the planner bake (`placementExtras`), the structural /
 *    parametric writers and the splat meta use it.
 *  - D1 / R4a: an old library reference is upgraded when its source is READY,
 *    otherwise written byte-identical with a Problems row.
 *  - A1: a document of the open project placed into a library document is
 *    qualified into the open project and warned about when the library does not
 *    list it.
 *  - A3: Copy into project / a transfer rewrites unqualified references to the
 *    source's qualifier — JSON chunk only, tail byte-identical, nothing to rewrite
 *    = the same bytes; a transfer without the library edge is refused.
 *  - 9.2: `openDocumentScoped` in a library scope never returns an open-project row.
 *  - R5: `layout.place` resolves `project:<path>` as a lookup shim only.
 *  - R7: the preparing key is qualified.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { placementExtras } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { referenceForWrite, REFERENCE_NOT_UPGRADED_CODE } from '../src/core/library/library-reference-write';
import { requalifyCopiedReferences } from '../src/core/library/library-reference-requalify';
import { copyDocumentAcrossSources } from '../src/core/library/library-asset-ops';
import { parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import {
  registerLibrarySourceProvider,
  resetLibrarySourceRegistryForTests,
  type LibrarySource,
} from '../src/core/library/library-source-registry';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import {
  entryKeyOf,
  LIBRARY_PROJECTS_PROVIDER_ID,
  OPEN_PROJECT_PROVIDER_ID,
  originInScope,
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  resetLegacyPathMigrationsForTests,
  type DocumentScope,
} from '../src/core/library/library-origin';
import { openDocumentScoped, planReferencedAssetOpen } from '../src/core/project/rv-referenced-asset-open';
import { mintableReferences } from '../src/core/project/rv-asset-identity';
import { resolvePlaceEntry, legacyCatalogIdHint } from '../src/plugins/layout-planner/planner-commands';
import type { LayoutPlannerPlugin } from '../src/plugins/layout-planner/index';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';
import type { DocumentTransferSession, DocumentTransferSide } from '../src/core/project/rv-document-transfer';
import type { RvProject } from '../src/core/project/rv-project-types';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

const LIB_B: DocumentScope = { providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' };

interface Doc { id: string; path: string; aliases?: string[] }

function source(id: string, docs: Doc[], opts: { loaded?: boolean; label?: string } = {}): LibrarySource {
  const entries = docs.map((d) => ({
    id: d.id, name: d.id, category: 'custom', glbUrl: '', localPath: d.path, documentId: d.id,
    ...(d.aliases ? { aliases: d.aliases } : {}),
  }) as LibraryCatalogEntry);
  return {
    id, label: opts.label ?? id, kind: 'project', writable: false, loaded: opts.loaded ?? true, error: null,
    listEntries: () => entries,
    getEntry: (a) => entries.find((e) => e.id === a || `project:${e.localPath}` === a) ?? null,
    getAliasEntry: (a) => entries.find((e) => (e.aliases ?? []).includes(a)) ?? null,
    resolveAsset: async () => { throw new Error('not used'); },
  };
}

function provider(providerId: string, sources: LibrarySource[]): void {
  registerLibrarySourceProvider({ id: providerId, listSources: () => sources, subscribe: () => () => {} });
}

/** Open project A (doc_pump, doc_own), libraries B (doc_pump, doc_belt) and realvirtual. */
function world(opts: { rvLoaded?: boolean } = {}): void {
  provider(OPEN_PROJECT_PROVIDER_ID, [source('prj_a', [{ id: 'doc_pump', path: 'models/pump.glb' }, { id: 'doc_own', path: 'models/own.glb' }])]);
  provider(LIBRARY_PROJECTS_PROVIDER_ID, [
    source('prj_b', [{ id: 'doc_pump', path: 'models/pump.glb' }, { id: 'doc_belt', path: 'library/Belt.glb' }], { label: 'Shared' }),
    source(REALVIRTUAL_LIBRARY_PROJECT_ID, [{ id: 'doc_rv_conv', path: 'PalletHandling/Conveyor.glb', aliases: ['realvirtual-conveyor-glb'] }], { loaded: opts.rvLoaded ?? true }),
  ]);
}

function placement(p: Partial<PlacedComponent> & { catalogId: string }): PlacedComponent {
  return { id: 'pl1', glbUrl: '', label: 'P', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ...p } as PlacedComponent;
}

function writtenRef(p: PlacedComponent, scope: DocumentScope): Record<string, unknown> {
  return placementExtras(p, scope).AssetReference as Record<string, unknown>;
}

afterEach(() => {
  resetLibrarySourceRegistryForTests();
  resetLegacyPathMigrationsForTests();
  resetProblemsForTests();
});

// ─── R4 / A2 / D1 / R4a ─────────────────────────────────────────────────

describe('plan-780 R4 — writers write document ids only', () => {
  it('parametrised over the writer forms: no path beside an id, no global, qualifier only across projects, no self-qualifier', () => {
    world();
    const cases: Array<[string, PlacedComponent, DocumentScope, Record<string, unknown>]> = [
      ['open project, legacy project:<path> → its document id, no path',
        placement({ catalogId: 'project:models/pump.glb', glbUrl: 'models/pump.glb' }), null, { assetId: 'doc_pump' }],
      ['open project, by id → no path', placement({ catalogId: 'doc_own', glbUrl: 'models/own.glb' }), null, { assetId: 'doc_own' }],
      ['library B document inside B (A2) → unqualified, no self-qualifier',
        placement({ catalogId: 'doc_belt', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }), LIB_B, { assetId: 'doc_belt' }],
      ['unqualified record inside B → B\'s document, unqualified', placement({ catalogId: 'doc_pump' }), LIB_B, { assetId: 'doc_pump' }],
      ['library B document inside the open project → qualified',
        placement({ catalogId: 'doc_belt', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }), null,
        { assetId: 'doc_belt', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }],
      ['D1: global + realvirtual catalog URL → the realvirtual library, canonical id, qualified',
        placement({ catalogId: 'realvirtual-conveyor-glb', providerId: 'global', sourceId: 'library/catalog.json', glbUrl: '/library/PalletHandling/Conveyor.glb' }), null,
        { assetId: 'doc_rv_conv', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: REALVIRTUAL_LIBRARY_PROJECT_ID }],
      ['D1: legacy project:<path> inside B → B\'s id (unqualified there)', placement({ catalogId: 'project:library/Belt.glb' }), LIB_B, { assetId: 'doc_belt' }],
    ];
    for (const [label, p, scope, expected] of cases) {
      expect(writtenRef(p, scope), label).toEqual(expected);
    }
    expect(getProblems().filter((p) => p.code === REFERENCE_NOT_UPGRADED_CODE)).toEqual([]);
  });

  it('R4a: an old reference whose library is not ready is written byte-identical, with a Problems row', () => {
    world({ rvLoaded: false });
    const old = placement({ catalogId: 'realvirtual-conveyor-glb', providerId: 'global', sourceId: 'library/catalog.json', glbUrl: '/library/PalletHandling/Conveyor.glb' });
    expect(writtenRef(old, null)).toEqual({
      assetId: 'realvirtual-conveyor-glb', providerId: 'global', sourceId: 'library/catalog.json', path: '/library/PalletHandling/Conveyor.glb',
    });
    const row = getProblems().find((p) => p.code === REFERENCE_NOT_UPGRADED_CODE);
    expect(row?.title).toBe('Reference not upgraded: realvirtual-conveyor-glb');
  });

  it('a qualified reference never gains a path; an id-less path reference keeps its path; blob: is never written', () => {
    world();
    expect(referenceForWrite({ catalogId: 'doc_gone', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b', glbUrl: 'x.glb' }, null))
      .toEqual({ assetId: 'doc_gone', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' });
    expect(referenceForWrite({ catalogId: '', glbUrl: 'parts/a.glb' }, null)).toEqual({ assetId: '', path: 'parts/a.glb' });
    expect(referenceForWrite({ catalogId: 'doc_own', glbUrl: 'blob:http://x/1' }, null)).toEqual({ assetId: 'doc_own' });
  });

  it('a splat placement\'s meta names the document id too', () => {
    world();
    const extras = placementExtras(placement({ catalogId: 'project:models/own.glb', splatUrl: 'blob:s' }), null);
    expect((extras.PlacementMeta as Record<string, unknown>).catalogId).toBe('doc_own');
  });

  it('the mint takes the id the written bytes already carry (no second identity for one reference)', () => {
    const project = { schemaVersion: 3, id: 'p', name: 'p', documents: [] } as unknown as RvProject;
    const due = mintableReferences(project, [{ assetId: '', path: 'parts/a.glb' }]);
    expect(due).toEqual([{ path: 'parts/a.glb' }]);
  });
});

// ─── A1 ─────────────────────────────────────────────────────────────────

describe('plan-780 A1 / A2 — a new placement written into a library document', () => {
  const pump = (o?: LibraryCatalogEntry['libraryOrigin']): LibraryCatalogEntry =>
    ({ id: 'doc_pump', name: 'Pump', category: 'custom', glbUrl: '', ...(o ? { libraryOrigin: o } : {}) }) as LibraryCatalogEntry;

  it('the library\'s own document → unqualified; the open project\'s → qualified into A, warned when B does not list A', () => {
    world();
    expect(originInScope(pump({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' }), LIB_B)).toEqual({ assetId: 'doc_pump' });
    const fromA = originInScope(pump(), LIB_B, { openProjectId: 'prj_a', libraryLists: () => false });
    expect(fromA.providerId).toBe(LIBRARY_PROJECTS_PROVIDER_ID);
    expect(fromA.sourceId).toBe('prj_a');
    expect(fromA.warning).toMatch(/open project 'prj_a', which library 'prj_b' does not list/);
    expect(originInScope(pump(), LIB_B, { openProjectId: 'prj_a', libraryLists: () => true }).warning).toBeUndefined();
    // The open project's own document — unchanged.
    expect(originInScope(pump(), null)).toEqual({ assetId: 'doc_pump' });
  });

  it('R7: the preparing key of two libraries\' equal id differs', () => {
    expect(entryKeyOf(pump({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' })))
      .not.toBe(entryKeyOf(pump({ providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' })));
  });
});

// ─── 9.2 open paths ─────────────────────────────────────────────────────

describe('plan-780 2.3 — openDocumentScoped', () => {
  const project = { schemaVersion: 3, id: 'prj_a', name: 'A', documents: [{ id: 'doc_pump', path: 'models/pump.glb', name: 'A pump' }] } as unknown as RvProject;
  const libraryBaseOf = (libraryProjectId: string, documentId: string) =>
    ({ kind: 'libraryDocument', libraryProjectId, documentId, path: 'models/pump.glb', name: 'B pump' }) as const;

  it('a reference written in library B opens B\'s document — never the open project\'s row of the same id', () => {
    world();
    const r = openDocumentScoped({ assetId: 'doc_pump' }, { scope: LIB_B, project, ownerPath: null }, libraryBaseOf);
    expect(r.ok && r.base).toEqual(libraryBaseOf('prj_b', 'doc_pump'));
    const missing = openDocumentScoped({ assetId: 'doc_own' }, { scope: LIB_B, project, ownerPath: null }, libraryBaseOf);
    expect(missing.ok).toBe(false);
    expect(planReferencedAssetOpen({ assetId: 'project:models/pump.glb' }, project, null, LIB_B))
      .toEqual({ via: 'library', libraryProjectId: 'prj_b', documentId: 'doc_pump' });
  });

  it('in the open project the same reference opens the open project\'s document', () => {
    world();
    const r = openDocumentScoped({ assetId: 'doc_pump' }, { scope: null, project, ownerPath: null }, libraryBaseOf);
    expect(r.ok && r.base).toEqual({ kind: 'document', documentId: 'doc_pump', path: 'models/pump.glb', name: 'A pump' });
  });
});

// ─── R5 ─────────────────────────────────────────────────────────────────

describe('plan-780 R5 — layout.place lookups', () => {
  const planner = { store: { getSnapshot: () => ({ catalogs: new Map() }) } } as unknown as LayoutPlannerPlugin;
  it('the document id and, as a shim, project:<path> both hit; a miss is undefined', () => {
    world();
    expect(resolvePlaceEntry(planner, 'doc_own')?.id).toBe('doc_own');
    const viaPath = resolvePlaceEntry(planner, 'project:models/own.glb');
    expect(viaPath?.id).toBe('doc_own');
    expect(legacyCatalogIdHint('project:models/own.glb', viaPath)).toMatch(/deprecated — address the document by its id "doc_own"/);
    expect(resolvePlaceEntry(planner, 'project:models/nope.glb')).toBeUndefined();
  });
});

// ─── A3 ─────────────────────────────────────────────────────────────────

/** A GLB whose nodes carry the given AssetReferences, plus a BIN tail to check byte identity. */
function glbWith(refs: Array<Record<string, unknown>>): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: refs.map((_, i) => i) }],
    nodes: refs.map((r, i) => ({ name: `n${i}`, extras: { realvirtual: { AssetReference: r } } })),
    buffers: [{ byteLength: 8 }],
  }));
  const jsonPad = (json.byteLength + 3) & ~3;
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const total = 12 + 8 + jsonPad + 8 + bin.byteLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonPad, true); view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonPad); out.set(json, 20);
  view.setUint32(20 + jsonPad, bin.byteLength, true); view.setUint32(24 + jsonPad, 0x004e4942, true);
  out.set(bin, 28 + jsonPad);
  return out;
}

function tail(bytes: Uint8Array): number[] {
  const chunks = parseGlbChunks(bytes);
  return [...bytes.subarray(chunks.restOffset)];
}

describe('plan-780 A3 — the copy keeps what its references mean', () => {
  it('unqualified references get the source library\'s qualifier; the path goes; the tail is byte-identical', () => {
    world();
    const before = glbWith([
      { assetId: 'doc_belt', path: 'library/Belt.glb' },                        // B's document
      { assetId: 'project:models/pump.glb' },                                   // B's legacy path → its id
      { assetId: 'doc_x', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' }, // qualified: untouched
      { path: 'parts/only-a-path.glb' },                                        // no id: untouched
    ]);
    const { bytes, rewritten } = requalifyCopiedReferences(before, 'prj_b');
    expect(rewritten).toBe(2);
    const nodes = parseGlbChunks(bytes).json.nodes as Array<{ extras: { realvirtual: { AssetReference: unknown } } }>;
    expect(nodes.map((n) => n.extras.realvirtual.AssetReference)).toEqual([
      { assetId: 'doc_belt', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
      { assetId: 'doc_pump', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_b' },
      { assetId: 'doc_x', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' },
      { path: 'parts/only-a-path.glb' },
    ]);
    expect(tail(bytes)).toEqual(tail(before));
    expect(bytes.byteLength % 4).toBe(0);
  });

  it('nothing to rewrite → the SAME bytes (round trip outside changed fields is byte-identical)', () => {
    world();
    const before = glbWith([{ assetId: 'doc_x', providerId: LIBRARY_PROJECTS_PROVIDER_ID, sourceId: 'prj_c' }]);
    const r = requalifyCopiedReferences(before, 'prj_b');
    expect(r.rewritten).toBe(0);
    expect(r.bytes).toBe(before);
    expect([...rebuildGlbWithJson(parseGlbChunks(before))]).toEqual([...before]);
  });

  it('a library-to-library transfer that needs the rewrite is refused without the library edge — nothing written', async () => {
    world();
    const bytes = glbWith([{ assetId: 'doc_belt' }]);
    const writes: string[] = [];
    const side = (projectId: string, libraryIds: string[], writable: boolean): DocumentTransferSide => ({
      label: projectId, backendId: `b:${projectId}`, writable,
      readDocumentUrl: async () => {
        const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
        return { url, release: () => URL.revokeObjectURL(url) } as never;
      },
      writeDocument: async (p) => { writes.push(p); return { revision: 'r' }; },
      deleteDocument: async () => {},
      listDocuments: async () => [],
      updateManifestEntry: async () => false,
      readProjectInfo: async () => ({ projectId, libraryIds }),
    });
    const session = { source: side('prj_b', [], false), target: side('prj_d', [], true), close: async () => {} } as DocumentTransferSession;
    const r = await copyDocumentAcrossSources(session, { id: 'doc_cell', path: 'models/cell.glb', name: 'Cell' } as never);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toMatch(/does not list as a library/);
    expect(writes).toEqual([]);
  });
});
