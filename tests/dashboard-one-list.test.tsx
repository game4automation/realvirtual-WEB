// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 §9.4 — ONE list, everywhere it is read (Phase 5, F8).
 *
 * Four surfaces used to answer "what does this project have?" out of two
 * different arrays, and the answers disagreed by exactly the documents that
 * were not in `scenes/`. This file pins that they now read the same one.
 *
 * ## Four blocks, four kinds of promise
 *
 *  1. **The source guard.** `project.scenes` must not appear in
 *     `ProjectsDashboardHost.tsx` at all. Asserted over the inlined source text
 *     (the `json-removal-guard` pattern) rather than over behaviour, because
 *     the failure mode is a FIFTH reader added later by someone copying the
 *     line above it — which no behavioural test would notice.
 *  2. **The readers themselves**, lifted into `dashboard-documents.ts` so they
 *     can be tested at all: the host is 2500 lines of React that no test can
 *     render cheaply, and a reader that is only reachable through a render is a
 *     reader with no test.
 *  3. **The role badge** — `section` rendered as a PLACE, beside "Sample"
 *     rather than instead of it.
 *  4. **The MCP document verbs.** `web_document_list` is the one list (asset =
 *     document = model since the 2026-08-19 rework), and the write verbs
 *     (`web_document_save` / `_new`) are wired onto document ops. That second
 *     half is the contract that lets Phase 6 delete `SceneStore.listScenes()`
 *     at all (risk 11), so it is asserted against a recording store rather
 *     than inferred from a description.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// ─── A recording SceneStore, for the MCP contract half ──────────────────
//
// The alias family calls the singleton at module level, so the seam is the
// module. A recording fake is the only way to assert WHICH verb an alias
// reaches — a real store would need the whole bake/OPFS stack to say the same
// thing, and would say it less clearly.

const h = vi.hoisted(() => ({
  calls: [] as { verb: string; arg?: string }[],
  createdId: 'doc_created',
}));

const sceneStoreFake = {
  /**
   * None of these three exists on `SceneStore` any more — `listScenes` and
   * `listBuiltins` went in plan-716 Phase 6, `listPublished` in plan-731 2e.
   * They are kept HERE, on the fake, so the assertions below can still say
   * "and the tool did not reach for them". A fake that simply dropped them
   * would make that check unfalsifiable — which is why `listPublished` now
   * RECORDS instead of silently answering `[]`.
   */
  listScenes: () => { h.calls.push({ verb: 'listScenes' }); return []; },
  listBuiltins: () => { h.calls.push({ verb: 'listBuiltins' }); return []; },
  listPublished: () => { h.calls.push({ verb: 'listPublished' }); return []; },
  openDocument: async (id: string) => { h.calls.push({ verb: 'openDocument', arg: id }); },
  openScene: async (id: string) => { h.calls.push({ verb: 'openScene', arg: id }); },
  createEmpty: async () => { h.calls.push({ verb: 'createEmpty' }); return h.createdId; },
  newEmpty: async () => { h.calls.push({ verb: 'newEmpty' }); },
  save: async () => { h.calls.push({ verb: 'save' }); return { status: 'saved' }; },
  saveAs: async (name: string) => { h.calls.push({ verb: 'saveAs', arg: name }); return 'doc_saved_as'; },
};

vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneStoreFake,
  initSceneStore: () => sceneStoreFake,
}));

import HOST_SOURCE from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';
import {
  documentById,
  documentPickOptions,
  documentRoleBadge,
  documentTypeBadge,
} from '../src/core/hmi/projects/dashboard-documents';
import { ProjectsDetailPane } from '../src/core/hmi/projects/ProjectsDetailPane';
import type { TieredDocumentEntry } from '../src/core/project/rv-project-tiers';
import type { RvDocumentEntry } from '../src/core/project/rv-project-types';
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject } from './helpers/fake-document-project';
import { McpProjectTools } from '../src/plugins/mcp-bridge/rv-mcp-project-tools';
// plan-713 Phase 1 — the webScene* aliases moved off the plugin into McpSceneTools.
import { McpSceneTools } from '../src/plugins/mcp-bridge/rv-mcp-scene-tools';

// ─── Fixtures ───────────────────────────────────────────────────────────

function doc(over: Partial<TieredDocumentEntry> & { id: string; path: string }): TieredDocumentEntry {
  return { name: over.id, tier: 'user', ...over } as TieredDocumentEntry;
}

/** One project holding a document in each of the three sections. */
const LINE = doc({ id: 'doc_line', path: 'scenes/Line.glb', name: 'Line', section: 'scenes' });
const BASE = doc({ id: 'doc_base', path: 'models/Base.glb', name: 'Base', section: 'models' });
const PART = doc({ id: 'doc_part', path: 'library/Part.glb', name: 'Part', section: 'library' });
const ALL = [LINE, BASE, PART];

// ─── 1. The source guard ────────────────────────────────────────────────

/**
 * The host's source with whole-line comments removed.
 *
 * Prose is allowed to name what was replaced — a comment saying "this used to
 * read `project.scenes`" is the record of the change, not the change. Only
 * full-line comments are stripped, never a trailing `//` on a code line: a URL
 * inside a string would take the rest of its line with it and could hide a real
 * reader.
 */
const HOST_CODE = HOST_SOURCE
  .split('\n')
  .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n');

describe('the dashboard has no second list left (F8)', () => {
  it('reads `project.scenes` nowhere', () => {
    // The snapshot field itself survives until Phase 6 — this is about the
    // dashboard, which is the surface the plan moves in Phase 5.
    expect(HOST_CODE).not.toContain('project.scenes');
  });

  it('reads `project.documents` instead, in more than one place', () => {
    const hits = HOST_CODE.split('project.documents').length - 1;
    expect(hits).toBeGreaterThan(4);
  });

  it('does not reach for the tier-merged scene projection either', () => {
    for (const gone of ['getProjectScenes(', 'sceneDocumentsOf(']) {
      expect(HOST_CODE).not.toContain(gone);
    }
  });

  it('reads no published-example catalogue either (plan-731 2d)', () => {
    // plan-716 left ONE list plus a merge branch: rows were appended from
    // `sceneSnap.published` whenever the backend was bundled, under a second
    // key shape (`published:<urlName>`). That was the second identity space
    // reaching the same surface the first one did, and plan-731 removed it.
    for (const gone of ['sceneSnap?.published', 'sceneSnap.published', 'publishedScenePath']) {
      expect(HOST_CODE, `${gone} is gone from the host`).not.toContain(gone);
    }
  });

  it('keys every row the one way — no published: prefix survives', () => {
    // The key shape IS the identity: two prefixes on one list meant two id
    // spaces, and the detail pane had to branch on which one it was holding.
    expect(HOST_CODE).not.toContain("'published:'");
    expect(HOST_CODE).not.toContain("startsWith('published:')");
    expect(HOST_CODE).toContain("'scene:' + doc.id");
  });

  it('opens a row through the one document verb, with no published fork', () => {
    expect(HOST_CODE).not.toContain('openPublishedExample');
  });
});

// ─── 2. The readers ─────────────────────────────────────────────────────

describe('documentById — the one lookup all four readers share', () => {
  it('finds a document in every section, not just scenes/', () => {
    expect(documentById(ALL, 'doc_line')?.name).toBe('Line');
    expect(documentById(ALL, 'doc_base')?.name).toBe('Base');
    expect(documentById(ALL, 'doc_part')?.name).toBe('Part');
  });

  it('answers undefined for an unknown or absent id instead of throwing', () => {
    expect(documentById(ALL, 'doc_gone')).toBeUndefined();
    expect(documentById(ALL, null)).toBeUndefined();
    expect(documentById(ALL, '')).toBeUndefined();
  });

  it('matches on id only — never on path', () => {
    // A path fallback would look tolerant and pick the wrong row of a fork
    // pair, which share a path across tiers.
    expect(documentById(ALL, 'scenes/Line.glb')).toBeUndefined();
  });
});

describe('documentPickOptions — the create-from picker', () => {
  it('offers every document the project owns, in manifest order', () => {
    expect(documentPickOptions(ALL)).toEqual([
      { id: 'doc_line', name: 'Line' },
      { id: 'doc_base', name: 'Base' },
      { id: 'doc_part', name: 'Part' },
    ]);
  });

  it('is empty for an empty project rather than undefined', () => {
    expect(documentPickOptions([])).toEqual([]);
  });
});

// ─── 3. The role badge ──────────────────────────────────────────────────

describe('documentRoleBadge — the place is the path’s real folder', () => {
  it('names the folder the path actually names', () => {
    expect(documentRoleBadge(LINE)).toBe('scenes/');
    expect(documentRoleBadge(BASE)).toBe('models/');
    expect(documentRoleBadge(PART)).toBe('library/');
  });

  it('coins no type nouns — the badge is a path, and the sweep still holds', () => {
    // Two rules meet here: this plan's ("scene" is not a storage type) and the
    // dashboard's standing label sweep (the word "Model" is gone from its
    // user-facing strings, pinned by projects-dashboard-tree). A folder name
    // satisfies both; "Base model" would break the second immediately.
    for (const row of ALL) {
      expect(documentRoleBadge(row)).toMatch(/^[a-z]+\/$/);
    }
  });

  it('never invents a section — an unknown folder is named, the root is silent', () => {
    // It used to answer `library/` for anything outside `scenes/`/`models/`,
    // which branded every root document with a folder it was not in (field
    // finding 2026-08-14).
    expect(documentRoleBadge({ path: 'somewhere/X.glb' })).toBe('somewhere/');
    expect(documentRoleBadge({ path: 'somewhere/deep/X.glb' })).toBe('somewhere/deep/');
    expect(documentRoleBadge({ path: 'X.glb' })).toBe('');
  });

  it('says nothing at all for a non-document', () => {
    expect(documentRoleBadge(null)).toBe('');
    expect(documentRoleBadge(undefined)).toBe('');
  });
});

describe('documentTypeBadge — WHAT the file is, as its extension', () => {
  it('spells the extension the way a user reads a file type', () => {
    expect(documentTypeBadge({ path: 'RollingMill.glb' })).toBe('GLB');
    expect(documentTypeBadge({ path: 'docs/Module_A/4112630_E_BOM.pdf' })).toBe('PDF');
    expect(documentTypeBadge({ path: 'imports/frame.step' })).toBe('STEP');
  });

  it('takes the LAST extension of a dotted name', () => {
    expect(documentTypeBadge({ path: 'scenes/Plant.scene.glb' })).toBe('GLB');
  });

  it('says nothing for a path without one, and for a non-document', () => {
    expect(documentTypeBadge({ path: 'no-extension' })).toBe('');
    expect(documentTypeBadge(null)).toBe('');
    expect(documentTypeBadge(undefined)).toBe('');
  });
});

describe('the detail pane shows the role badge', () => {
  beforeEach(() => cleanup());

  it('renders it beside "Sample" — two independent facts, two badges', () => {
    render(
      <ProjectsDetailPane title="Line" badge="Sample" badges={[documentRoleBadge(LINE)]} />,
    );
    expect(screen.getByTestId('projects-detail-badge-sample')).toBeTruthy();
    expect(screen.getByTestId('projects-detail-badge-scenes')).toBeTruthy();
  });

  it('renders the role badge on its own for a writable document', () => {
    render(
      <ProjectsDetailPane title="Part" badge={null} badges={[documentRoleBadge(PART)]} />,
    );
    expect(screen.queryByTestId('projects-detail-badge-sample')).toBeNull();
    expect(screen.getByTestId('projects-detail-badge-library')).toBeTruthy();
  });

  it('drops an empty badge instead of rendering a blank chip', () => {
    render(<ProjectsDetailPane title="Example" badge={null} badges={['']} />);
    expect(document.querySelectorAll('[data-testid^="projects-detail-badge-"]')).toHaveLength(0);
  });
});

// ─── 4. Both MCP families ───────────────────────────────────────────────

function manifestRows(): RvDocumentEntry[] {
  return ALL.map(({ tier: _tier, ...row }) => row as RvDocumentEntry);
}

describe('MCP — web_document_list is THE one list', () => {
  beforeEach(() => { resetProjectStore(); h.calls.length = 0; });

  it('returns every document with its section, not the scenes/ third', async () => {
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      const out = JSON.parse(await new McpProjectTools(() => undefined).webDocumentList()) as {
        documents: { id: string; name: string; path: string; section: string }[];
        builtins: unknown[];
      };
      // Section order is storage order, not identity: since the terminology
      // rework the rows are sorted by path, and asset = document = model.
      expect([...out.documents.map(d => d.id)].sort())
        .toEqual(['doc_base', 'doc_line', 'doc_part']);
      expect([...out.documents.map(d => d.section)].sort())
        .toEqual(['library', 'models', 'scenes']);
      // Every row carries the path, so an agent can build a reference without
      // a second call.
      expect(out.documents.every(d => typeof d.path === 'string' && d.path !== '')).toBe(true);
    } finally { fake.restore(); }
  });

  it('the deprecated `saved` alias array is gone', async () => {
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      const out = JSON.parse(await new McpProjectTools(() => undefined).webDocumentList()) as {
        documents: unknown[]; saved?: unknown[];
      };
      expect(out.saved, 'plan-716 promised to drop `saved` after one release').toBeUndefined();
      expect(out.documents.length).toBeGreaterThan(0);
    } finally { fake.restore(); }
  });

  it('does not build the list out of the scene catalogue any more', async () => {
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      await new McpProjectTools(() => undefined).webDocumentList();
      expect(h.calls.filter(c => c.verb === 'listScenes')).toEqual([]);
    } finally { fake.restore(); }
  });

  it('opens a LIBRARY document by name — a listed row must be an openable row', async () => {
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      const out = JSON.parse(
        await new McpProjectTools(() => undefined).webDocumentOpen('Part'),
      ) as { opened: boolean; kind: string; id: string; section: string };
      expect(out).toMatchObject({ opened: true, kind: 'document', id: 'doc_part', section: 'library' });
      expect(h.calls).toContainEqual({ verb: 'openDocument', arg: 'doc_part' });
    } finally { fake.restore(); }
  });
});

describe('MCP — the web_document_* verbs own the document ops (old names retired)', () => {
  beforeEach(() => { resetProjectStore(); h.calls.length = 0; });

  /**
   * The 2026-08-19 rework finished what plan-713 F8 started: ONE name per
   * capability. `webScene*` and `webModel*` are gone from both delegate
   * classes — asset = document = model, and the document verbs carry it all.
   */
  it('announces the document verbs on the scene delegate', () => {
    const plugin = new McpSceneTools(() => undefined);
    for (const verb of ['webDocumentSave', 'webDocumentNew', 'webLayoutExport'] as const) {
      expect(typeof plugin[verb]).toBe('function');
    }
  });

  it('the old names are RETIRED on both delegates, not merely deprecated', () => {
    const scene = new McpSceneTools(() => undefined) as unknown as Record<string, unknown>;
    const project = new McpProjectTools(() => undefined) as unknown as Record<string, unknown>;
    for (const gone of ['webSceneOpen', 'webSceneList', 'webSceneSave', 'webSceneNew',
      'webSceneExport', 'webLibraryAssets', 'webLibraryUpdate', 'webLibraryList',
      'webLibraryDescribe'] as const) {
      expect(scene[gone], `${gone} must be gone from McpSceneTools`).toBeUndefined();
    }
    for (const gone of ['webModelList', 'webModelOpen'] as const) {
      expect(project[gone], `${gone} must be gone from McpProjectTools`).toBeUndefined();
    }
  });

  it('web_document_list answers with the DOCUMENT list the retired names used to', async () => {
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      // The built-ins come from the model catalogue since Phase 6, so the tool
      // needs a viewer rather than a scene store to answer for them.
      const plugin = new McpProjectTools(() => ({
        availableModels: [{ url: '/models/Empty.glb', label: 'Empty' }],
      } as never));
      const out = JSON.parse(await plugin.webDocumentList()) as {
        documents: { id: string; section: string }[];
        builtins: { label: string }[];
      };
      expect([...out.documents.map(d => d.id)].sort())
        .toEqual(['doc_base', 'doc_line', 'doc_part']);
      // The built-in SOURCES stay beside it — they are not documents and are
      // not being merged into the list (§2.6 decision log).
      expect(out.builtins.map(b => b.label)).toEqual(['Empty']);
      // And neither half of the deleted catalogue was consulted to say it
      // (risk 11: the rewiring is what made the deletion safe).
      expect(h.calls.filter(c => c.verb === 'listScenes' || c.verb === 'listBuiltins'))
        .toEqual([]);
    } finally { fake.restore(); }
  });

  it('web_document_new places a DOCUMENT and opens it, instead of clearing to a draft', async () => {
    const out = JSON.parse(await new McpSceneTools(() => undefined).webDocumentNew()) as {
      ok: boolean; documentId: string;
    };
    expect(out).toEqual({ ok: true, documentId: 'doc_created' });
    expect(h.calls.map(c => c.verb)).toEqual(['createEmpty', 'openDocument']);
    // `newEmpty()` was the pre-716 body of this op — an unsaved draft that a
    // reload lost.
    expect(h.calls.some(c => c.verb === 'newEmpty')).toBe(false);
  });

  it('web_document_open goes through the document-open funnel', async () => {
    // Resolves against the document list first, so a typo is an error instead
    // of a silent no-op, and reaches `openDocument` directly — with the id
    // already resolved there is nothing left for the old openScene tolerance
    // to do.
    const fake = installFakeDocumentProject({ documents: manifestRows() });
    try {
      const out = JSON.parse(await new McpProjectTools(() => undefined).webDocumentOpen('doc_part')) as {
        ok?: boolean; error?: string;
      };
      expect(out.error, 'web_document_open must open the listed document').toBeUndefined();
      expect(h.calls.map(c => c.verb)).toContain('openDocument');
    } finally { fake.restore(); }
  });

  it('web_document_save reports the id it wrote as a documentId', async () => {
    const named = JSON.parse(await new McpSceneTools(() => undefined).webDocumentSave('Copy')) as {
      saved: boolean; id: string; documentId: string;
    };
    expect(named).toMatchObject({ saved: true, id: 'doc_saved_as', documentId: 'doc_saved_as' });
    expect(h.calls).toContainEqual({ verb: 'saveAs', arg: 'Copy' });

    h.calls.length = 0;
    const inPlace = JSON.parse(await new McpSceneTools(() => undefined).webDocumentSave('')) as { saved: boolean };
    expect(inPlace.saved).toBe(true);
    expect(h.calls).toEqual([{ verb: 'save' }]);
  });
});
