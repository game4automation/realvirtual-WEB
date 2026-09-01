// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The projects dashboard after the tabs (plan-703 Phase 6, run 9).
 *
 * ## Where this file came from
 *
 * It is the surviving half of two files the tab removal took with it,
 * `projects-dashboard-store.test.ts` and `dashboard-document-filter.test.tsx`
 * (plan A9). Most of what those two pinned was never about tabs at all — the
 * store's snapshot identity, the classification filter, the classification
 * editor and the label sweep — and that half is here, unchanged in substance.
 *
 * What is **deliberately not** here is what died with the feature:
 * `normaliseProjectTab` / `projectTabOf` / `setProjectsTab` and the
 * `ProjectSections` panel. A test for a function that no longer exists is not a
 * promise anybody is keeping.
 *
 * ## And the new half
 *
 * The translation `buildDashboardTree` — the listings the dashboard actually
 * has (`documents[]`, the `docs-index.json` attachments, the registered
 * catalogs) turned into the roots §9.14 tests the tree against. §9.14 proves
 * the tree behaves; this proves it is fed the right thing.
 *
 * Renderer-free throughout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../src/hooks/use-viewer', () => ({
  // The classification editor and the filter bar pull nothing off the viewer,
  // but they sit in a tree of components that might. A viewer without a
  // thumbnail service is exactly the right amount of viewer.
  useViewer: () => ({ thumbnails: null }),
}));

import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import {
  DOCUMENT_CHIP_ALL,
  DOCUMENT_CHIP_UNCLASSIFIED,
  documentChipOptions,
  documentFilterActive,
  documentTagOptions,
  matchesDocumentChip,
  matchesDocumentFilter,
  matchesDocumentTag,
  type ClassifiedRow,
} from '../src/core/hmi/projects/document-filter';
import { DocumentFilterBar } from '../src/core/hmi/projects/DocumentFilterBar';
import { ClassificationEditor } from '../src/core/hmi/projects/ClassificationEditor';
import {
  closeProjectsDashboard,
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  resetProjectsDashboardForTests,
  setProjectsChip,
  setProjectsRailGroup,
  setProjectsSearch,
  setProjectsSelection,
  setProjectsTag,
  subscribeProjectsDashboard,
  toggleProjectsDashboard,
} from '../src/core/hmi/projects/projects-dashboard-store';
import {
  buildDashboardTree,
  catalogEntryPath,
  catalogRootId,
  type CatalogRootInput,
} from '../src/core/project/rv-project-tree-sources';
import { buildProjectTree, findTreeNode, walkProjectTree } from '../src/core/project/rv-project-tree';
import {
  documentIdCollisionProblemId,
  getProblems,
  reportDocumentIdCollisions,
  reportProblem,
  resetProblemsForTests,
} from '../src/core/hmi/problems-store';
import type { DocumentClassification, DocumentLevel } from '../src/core/project/rv-document-classification';

// ─── fixtures ────────────────────────────────────────────────────────────

function row(name: string, level?: DocumentLevel, tags?: string[]): ClassifiedRow {
  const classification: DocumentClassification | undefined =
    level === undefined && tags === undefined
      ? undefined
      : { v: 1, ...(level ? { level } : {}), ...(tags ? { tags } : {}) };
  return { name, classification };
}

const ROWS: ClassifiedRow[] = [
  row('Plant North', 'plant', ['line3']),
  row('Press 500t', 'assembly', ['press', 'kuka']),
  row('Gripper V2', 'part'),
  row('Planner Demo', 'scene'),
  row('Unity Export'),                 // no classification block at all
  row('Half Done', undefined, ['line3']),  // tags but no level
];

beforeEach(() => {
  resetProjectsDashboardForTests();
  resetProblemsForTests();
});
afterEach(() => cleanup());

// ─── the store (ported from projects-dashboard-store.test.ts) ────────────

describe('snapshot identity', () => {
  it('returns the identical object until something changes', () => {
    // Not cosmetic: this store feeds `useSyncExternalStore`, and a fresh object
    // per read is an infinite render loop (§2.6.4).
    const a = getProjectsDashboardSnapshot();
    expect(getProjectsDashboardSnapshot()).toBe(a);
    openProjectsDashboard();
    const b = getProjectsDashboardSnapshot();
    expect(b).not.toBe(a);
    expect(getProjectsDashboardSnapshot()).toBe(b);
  });
});

describe('open / close / toggle', () => {
  it('starts closed and toggles both ways', () => {
    expect(getProjectsDashboardSnapshot().open).toBe(false);
    toggleProjectsDashboard();
    expect(getProjectsDashboardSnapshot().open).toBe(true);
    toggleProjectsDashboard();
    expect(getProjectsDashboardSnapshot().open).toBe(false);
  });

  it('can open directly onto a rail group', () => {
    openProjectsDashboard({ kind: 'scenes' });
    expect(getProjectsDashboardSnapshot().group).toEqual({ kind: 'scenes' });
  });

  it('a plain open lands on the project screen, not the list', () => {
    openProjectsDashboard();
    expect(getProjectsDashboardSnapshot().view).toBe('project');
  });

  it('reopening after a close still lands on the project screen', () => {
    openProjectsDashboard();
    closeProjectsDashboard();
    openProjectsDashboard();
    expect(getProjectsDashboardSnapshot().view).toBe('project');
  });

  it('opening aimed at the projects group shows the list', () => {
    openProjectsDashboard({ kind: 'projects' });
    expect(getProjectsDashboardSnapshot().view).toBe('projects');
  });

  it('keeps the whole view state on close, so reopening resumes', () => {
    openProjectsDashboard({ kind: 'library', sourceId: 'lib1' });
    setProjectsSearch('belt');
    setProjectsChip('conveyor');
    setProjectsSelection({ kind: 'document', documentId: 's1' });

    closeProjectsDashboard();
    openProjectsDashboard();
    const s = getProjectsDashboardSnapshot();
    expect(s.open).toBe(true);
    // Everything the user had set survives the round trip — the dashboard is
    // a place they return to, not a form to fill in again.
    expect(s.search).toBe('belt');
    expect(s.chip).toBe('conveyor');
    expect(s.selection).toEqual({ kind: 'document', documentId: 's1' });
    expect(s.group).toEqual({ kind: 'library', sourceId: 'lib1' });
  });

  it('a legacy group from a previous session still parses', () => {
    // A deep link, a reopened dashboard or another plugin can be holding a kind
    // the tabs used to name. It must survive as a value; the group no longer
    // selects a panel, so there is nothing left for it to select wrongly.
    setProjectsRailGroup({ kind: 'scenes' });
    closeProjectsDashboard();
    expect(getProjectsDashboardSnapshot().group).toEqual({ kind: 'scenes' });
  });
});

describe('selection', () => {
  it('drops the selection, the chip and the tag when the rail group changes', () => {
    openProjectsDashboard();
    setProjectsSelection({ kind: 'document', documentId: 's1' });
    setProjectsChip('robot');
    setProjectsTag('line3');
    setProjectsRailGroup({ kind: 'models' });
    const s = getProjectsDashboardSnapshot();
    expect(s.selection).toEqual({ kind: 'none' });
    expect(s.chip).toBeNull();
    expect(s.tag).toBeNull();
  });

  it('carries the full provider identity for an asset selection', () => {
    setProjectsSelection({ kind: 'asset', providerId: 'core', sourceId: 'lib', assetId: 'a1' });
    expect(getProjectsDashboardSnapshot().selection).toEqual({
      kind: 'asset', providerId: 'core', sourceId: 'lib', assetId: 'a1',
    });
  });

  it('carries (rootId, relPath) for a folder and for an attachment', () => {
    // The Phase-6 variants. A folder has no document id and nothing opens it,
    // so it is addressed the way the tree addresses every node.
    setProjectsSelection({ kind: 'folder', rootId: 'proj', relPath: 'machines' });
    expect(getProjectsDashboardSnapshot().selection).toEqual({
      kind: 'folder', rootId: 'proj', relPath: 'machines',
    });
    setProjectsSelection({ kind: 'file', rootId: 'proj', relPath: 'docs/BOM.pdf' });
    expect(getProjectsDashboardSnapshot().selection).toEqual({
      kind: 'file', rootId: 'proj', relPath: 'docs/BOM.pdf',
    });
  });

  it('an empty relPath is how a ROOT is selected', () => {
    setProjectsSelection({ kind: 'folder', rootId: 'core:cloud', relPath: '' });
    const sel = getProjectsDashboardSnapshot().selection;
    expect(sel.kind === 'folder' && sel.relPath).toBe('');
  });
});

describe('subscribers', () => {
  it('notifies on change and stops after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeProjectsDashboard(() => { calls++; });
    openProjectsDashboard();
    setProjectsSearch('x');
    expect(calls).toBe(2);
    unsub();
    setProjectsSearch('y');
    expect(calls).toBe(2);
  });

  it('a throwing subscriber never blocks the others', () => {
    let reached = false;
    subscribeProjectsDashboard(() => { throw new Error('boom'); });
    subscribeProjectsDashboard(() => { reached = true; });
    expect(() => openProjectsDashboard()).not.toThrow();
    expect(reached).toBe(true);
  });
});

// ─── the classification filter (ported from dashboard-document-filter) ───

describe('document filter — chips', () => {
  it('matches everything for "All" and for no chip at all', () => {
    for (const r of ROWS) {
      expect(matchesDocumentChip(r.classification, null)).toBe(true);
      expect(matchesDocumentChip(r.classification, DOCUMENT_CHIP_ALL)).toBe(true);
    }
  });

  it('selects exactly one level', () => {
    const kept = ROWS.filter(r => matchesDocumentChip(r.classification, 'assembly'));
    expect(kept.map(r => r.name)).toEqual(['Press 500t']);
  });

  it('"Unclassified" selects documents whose bytes carry no level', () => {
    const kept = ROWS.filter(
      r => matchesDocumentChip(r.classification, DOCUMENT_CHIP_UNCLASSIFIED));
    // Both the file with no block at all AND the one that has tags but no
    // level: "unclassified" is a statement about the LEVEL, and a tagged file
    // whose level nobody set is still a file nobody has said what it is.
    expect(kept.map(r => r.name)).toEqual(['Unity Export', 'Half Done']);
  });

  it('an unrecognised chip matches nothing rather than everything', () => {
    // A filter that silently stops filtering is the failure a user cannot see;
    // an empty result is one they can.
    const kept = ROWS.filter(r => matchesDocumentChip(r.classification, 'sub-assembly'));
    expect(kept).toEqual([]);
  });
});

describe('document filter — tags', () => {
  it('matches any tag on the document, case-insensitively', () => {
    expect(ROWS.filter(r => matchesDocumentTag(r.classification, 'line3'))
      .map(r => r.name)).toEqual(['Plant North', 'Half Done']);
    expect(matchesDocumentTag(ROWS[1].classification, 'KUKA')).toBe(true);
  });

  it('an empty tag filter keeps everything', () => {
    for (const r of ROWS) {
      expect(matchesDocumentTag(r.classification, null)).toBe(true);
      expect(matchesDocumentTag(r.classification, '')).toBe(true);
    }
  });
});

describe('document filter — combined', () => {
  it('cuts by search, level and tag at once', () => {
    const kept = ROWS.filter(r => matchesDocumentFilter(
      r, { term: '', chip: 'plant', tag: 'line3' }));
    expect(kept.map(r => r.name)).toEqual(['Plant North']);
  });

  it('the search term is independent of the classification', () => {
    const kept = ROWS.filter(r => matchesDocumentFilter(
      r, { term: 'press', chip: null, tag: null }));
    expect(kept.map(r => r.name)).toEqual(['Press 500t']);
  });

  it('reports whether anything is narrowing the view', () => {
    expect(documentFilterActive({ term: '', chip: null, tag: null })).toBe(false);
    expect(documentFilterActive({ term: '', chip: DOCUMENT_CHIP_ALL, tag: null })).toBe(false);
    expect(documentFilterActive({ term: ' ', chip: null, tag: null })).toBe(false);
    expect(documentFilterActive({ term: 'x', chip: null, tag: null })).toBe(true);
    expect(documentFilterActive({ term: '', chip: 'part', tag: null })).toBe(true);
    expect(documentFilterActive({ term: '', chip: null, tag: 'line3' })).toBe(true);
  });
});

describe('chip and tag options', () => {
  it('counts each level over the unfiltered list', () => {
    const chips = documentChipOptions(ROWS);
    expect(chips.map(c => [c.key, c.count])).toEqual([
      [DOCUMENT_CHIP_ALL, 6],
      ['part', 1],
      ['assembly', 1],
      ['plant', 1],
      ['scene', 1],
      [DOCUMENT_CHIP_UNCLASSIFIED, 2],
    ]);
  });

  it('offers no chip for a level nobody uses', () => {
    const chips = documentChipOptions([row('Only Scene', 'scene')]);
    expect(chips.map(c => c.key)).toEqual([DOCUMENT_CHIP_ALL, 'scene']);
  });

  it('still offers the selected chip when its count has dropped to zero', () => {
    // Otherwise deleting the last part leaves the filter on with nothing on
    // screen to turn it off with.
    const chips = documentChipOptions([row('Only Scene', 'scene')], 'part');
    expect(chips.find(c => c.key === 'part')).toEqual({ key: 'part', label: 'Part', count: 0 });
  });

  it('collects tags once each, sorted, first spelling wins', () => {
    expect(documentTagOptions(ROWS)).toEqual(['kuka', 'line3', 'press']);
    expect(documentTagOptions([
      row('a', undefined, ['Linie3']),
      row('b', undefined, ['linie3']),
    ])).toEqual(['Linie3']);
  });
});

describe('DocumentFilterBar', () => {
  it('renders one chip per option with its count, and reports clicks', () => {
    const onChipChange = vi.fn();
    render(
      <DocumentFilterBar
        chips={documentChipOptions(ROWS)}
        chip={null}
        onChipChange={onChipChange}
        tags={[]}
        tag={null}
        onTagChange={() => {}}
      />,
    );
    expect(screen.getByText('All 6')).toBeTruthy();
    expect(screen.getByText('Unclassified 2')).toBeTruthy();
    fireEvent.click(screen.getByText('Assembly 1'));
    expect(onChipChange).toHaveBeenCalledWith('assembly');
    // "All" reports null, not the literal, so the store keeps one spelling of
    // "no filter".
    fireEvent.click(screen.getByText('All 6'));
    expect(onChipChange).toHaveBeenLastCalledWith(null);
  });

  it('offers no tag picker in a project that uses no tags', () => {
    render(
      <DocumentFilterBar
        chips={documentChipOptions([])}
        chip={null}
        onChipChange={() => {}}
        tags={[]}
        tag={null}
        onTagChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText('Filter by tag')).toBeNull();
  });
});

describe('ClassificationEditor', () => {
  it('writes the whole block when the level changes', () => {
    const onChange = vi.fn();
    render(
      <ClassificationEditor
        classification={{ v: 1, level: 'part', tags: ['kuka'] }}
        knownTags={['kuka', 'line3']}
        onChange={onChange}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Classification level' }));
    fireEvent.click(screen.getByRole('option', { name: 'Assembly' }));
    // The tags ride along: the GLB stores level and tags as one block, so a
    // level change that dropped the tags would be a silent data loss.
    expect(onChange).toHaveBeenCalledWith({ v: 1, level: 'assembly', tags: ['kuka'] });
  });

  it('clearing the level to Unclassified keeps the tags', () => {
    const onChange = vi.fn();
    render(
      <ClassificationEditor
        classification={{ v: 1, level: 'part', tags: ['kuka'] }}
        knownTags={[]}
        onChange={onChange}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Classification level' }));
    fireEvent.click(screen.getByRole('option', { name: 'Unclassified' }));
    expect(onChange).toHaveBeenCalledWith({ v: 1, tags: ['kuka'] });
  });

  it('adding a tag appends it; removing the last thing writes null', () => {
    const onChange = vi.fn();
    const { unmount } = render(
      <ClassificationEditor classification={{ v: 1, level: 'part' }} knownTags={[]} onChange={onChange} />,
    );
    const input = screen.getByLabelText('Add tag');
    fireEvent.change(input, { target: { value: 'line3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ v: 1, level: 'part', tags: ['line3'] });
    unmount();

    onChange.mockClear();
    render(
      <ClassificationEditor classification={{ v: 1, tags: ['line3'] }} knownTags={[]} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('CancelIcon'));
    // Nothing left to say — and "classified as nothing" must land on disk as
    // the same state as "never classified" (plan-413 phase 1).
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('a read-only document shows its classification instead of controls', () => {
    render(
      <ClassificationEditor
        classification={{ v: 1, level: 'scene', tags: ['demo'] }}
        knownTags={[]}
      />,
    );
    expect(screen.getByText('Scene')).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.queryByLabelText('Classification level')).toBeNull();
    expect(screen.queryByLabelText('Add tag')).toBeNull();
  });
});

// ─── the label sweep (ported verbatim) ───────────────────────────────────

describe('the word "Model" is gone from the dashboard', () => {
  /**
   * Every string a user can read in `src/core/hmi/projects/`.
   *
   * Deliberately source-scanning rather than render-asserting: a rendered test
   * only proves the strings of the one tree it mounted, and the label sweep is
   * a claim about all of them. The same technique as
   * `layout-library-panel-slim.test.tsx`.
   *
   * Comments and identifiers are exempt on purpose — plan-413's decision log is
   * explicit that `openModel()` and friends keep their names until the file is
   * opened for another reason.
   */
  const sources = import.meta.glob('../src/core/hmi/projects/*.{ts,tsx}', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  function visibleStrings(code: string): string[] {
    // Strip block and line comments first, then take quoted literals.
    const stripped = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    return [...stripped.matchAll(/'([^'\\\n]{2,})'|"([^"\\\n]{2,})"/g)]
      .map(m => m[1] ?? m[2]);
  }

  it('has no user-visible label containing "Model" or "Modell"', () => {
    const offenders: string[] = [];
    for (const [file, code] of Object.entries(sources)) {
      for (const literal of visibleStrings(code)) {
        // A label is prose: it has a space or starts with a capital. Import
        // paths, css keys and identifiers are neither.
        const isProse = /\s/.test(literal) || /^[A-Z]/.test(literal);
        if (!isProse) continue;
        if (/\bmodels?\b|\bmodell/i.test(literal)) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ─── the listings → roots translation (new with Phase 6) ─────────────────

const PROJECT_INPUT = {
  id: 'proj_myplant',
  name: 'MyPlant',
  writable: true,
  documents: [
    { id: 'doc_filler', path: 'machines/Filler.glb', name: 'Filler' },
    { id: 'doc_roll', path: 'library/parts/Roll2m.glb', name: 'Roll2m' },
    { path: 'scenes/Plant.scene.glb', name: 'Plant' },      // no manifest id yet
  ],
  attachments: ['docs/Module_A/4112630_BOM.pdf'],
};

const CLOUD: CatalogRootInput = {
  providerId: 'core',
  sourceId: 'cloud',
  label: 'Component Cloud',
  writable: false,
  remote: true,
  entries: [
    { assetId: 'cloud:belt', name: 'Belt', path: 'conveyors/Belt.glb' },
    { assetId: 'cloud:clamp', name: 'Clamp', path: '' },
  ],
};

describe('buildDashboardTree — project folder and catalogs as siblings', () => {
  it('puts the project first and every catalog after it, marked', () => {
    const { roots } = buildDashboardTree({ project: PROJECT_INPUT, catalogs: [CLOUD] });
    expect(roots.map(r => [r.id, r.kind])).toEqual([
      ['proj_myplant', 'project'],
      ['core:cloud', 'catalog'],
    ]);
    expect(roots[1].remote).toBe(true);
  });

  it('a read-only catalog makes every node under it read-only', () => {
    // `writable` on a `LibrarySource` means "assets can be written into it"; in
    // the tree it means "its folders can be rearranged", which no provider
    // offers — so the host passes `false` and the whole subtree inherits it.
    // That is what makes the refusal visible before a drop rather than after.
    const { roots } = buildDashboardTree({ project: null, catalogs: [CLOUD] });
    expect(roots[0].writable).toBe(false);
    const nodes = buildProjectTree(roots);
    expect(walkProjectTree(nodes).every(n => !n.writable)).toBe(true);
  });

  it('carries the manifest id onto the row, and leaves it off where there is none', () => {
    const { roots } = buildDashboardTree({ project: PROJECT_INPUT });
    const nodes = buildProjectTree(roots);
    expect(findTreeNode(nodes, 'proj_myplant/machines/Filler.glb')?.documentId).toBe('doc_filler');
    expect(findTreeNode(nodes, 'proj_myplant/scenes/Plant.scene.glb')?.documentId)
      .toBeUndefined();
  });

  it('lists the docs-index attachments as ordinary files', () => {
    const { roots, refs } = buildDashboardTree({ project: PROJECT_INPUT });
    const nodes = buildProjectTree(roots);
    const pdf = findTreeNode(nodes, 'proj_myplant/docs/Module_A/4112630_BOM.pdf');
    expect(pdf?.kind).toBe('file');
    expect(pdf?.documentId).toBeUndefined();
    expect(refs.get('proj_myplant/docs/Module_A/4112630_BOM.pdf'))
      .toEqual({ kind: 'attachment', path: 'docs/Module_A/4112630_BOM.pdf' });
  });

  it('indexes every leaf so a click can answer what it hit', () => {
    const { refs } = buildDashboardTree({ project: PROJECT_INPUT, catalogs: [CLOUD] });
    expect(refs.get('proj_myplant/machines/Filler.glb'))
      .toEqual({ kind: 'document', path: 'machines/Filler.glb', documentId: 'doc_filler' });
    expect(refs.get('core:cloud/conveyors/Belt.glb')).toEqual({
      kind: 'catalogAsset', providerId: 'core', sourceId: 'cloud', assetId: 'cloud:belt',
    });
    // Folders are not in the index — a folder is not a thing you can open.
    expect(refs.has('proj_myplant/machines')).toBe(false);
  });

  it('an entry with no path falls back to its name rather than vanishing', () => {
    const { refs } = buildDashboardTree({ project: null, catalogs: [CLOUD] });
    expect(refs.get('core:cloud/Clamp')?.kind).toBe('catalogAsset');
  });

  it('keeps two entries that would share one path apart', () => {
    const twins: CatalogRootInput = {
      ...CLOUD,
      entries: [
        { assetId: 'a', name: 'Belt', path: 'conveyors/Belt.glb' },
        { assetId: 'b', name: 'Belt', path: 'conveyors/Belt.glb' },
      ],
    };
    const { roots, refs } = buildDashboardTree({ project: null, catalogs: [twins] });
    const paths = roots[0].files.map(f => f.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(refs.size).toBe(2);
  });

  it('takes the library-relative tail out of a URL-only entry', () => {
    expect(catalogEntryPath({
      assetId: 'x', name: 'Belt',
      path: 'https://cdn.example.com/models/library/Conveyors/Belt.glb',
    })).toBe('Conveyors/Belt.glb');
    expect(catalogEntryPath({
      assetId: 'x', name: 'Belt', path: 'https://cdn.example.com/whatever/Belt.glb',
    })).toBe('Belt.glb');
  });

  it('composes the catalog root id the same way the collapse key always did', () => {
    expect(catalogRootId('core', 'cloud')).toBe('core:cloud');
  });

  it('answers with no roots at all when nothing is open', () => {
    expect(buildDashboardTree({ project: null }).roots).toEqual([]);
  });
});

describe('buildDashboardTree — the filter narrows the listing, not the tree', () => {
  it('drops a folder that the filter emptied', () => {
    const { roots } = buildDashboardTree({
      project: PROJECT_INPUT,
      accept: ({ name }) => name.startsWith('Filler'),
    });
    const nodes = buildProjectTree(roots);
    expect(findTreeNode(nodes, 'proj_myplant/machines')).not.toBeNull();
    // `library/` held only Roll2m, which the filter removed — so the folder
    // is not there either. A grid got that for free; a tree has to be given it.
    expect(findTreeNode(nodes, 'proj_myplant/library')).toBeNull();
    expect(findTreeNode(nodes, 'proj_myplant/docs')).toBeNull();
  });

  it('judges a catalog entry on the path it wants, not on the dedup suffix', () => {
    const twins: CatalogRootInput = {
      ...CLOUD,
      entries: [
        { assetId: 'a', name: 'Belt', path: 'conveyors/Belt.glb' },
        { assetId: 'b', name: 'Belt', path: 'conveyors/Belt.glb' },
      ],
    };
    const { roots } = buildDashboardTree({
      project: null,
      catalogs: [twins],
      accept: ({ path }) => path === 'conveyors/Belt.glb',
    });
    // Both survive: whether a row passes the filter must not depend on how
    // many identically named rows came before it.
    expect(roots[0].files).toHaveLength(2);
  });
});

// ─── duplicate ids reach the Problems panel (Phase 5 rest) ───────────────

describe('reportDocumentIdCollisions', () => {
  it('reports one problem per colliding id, naming both paths', () => {
    reportDocumentIdCollisions([{ id: 'doc_roll', paths: ['a/Roll.glb', 'b/Roll.glb'] }]);
    const problems = getProblems();
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe(documentIdCollisionProblemId('doc_roll'));
    expect(problems[0].code).toBe('duplicate-asset-id');
    expect(problems[0].severity).toBe('error');
    // The repair is to rename or re-import ONE of them; the user cannot pick
    // which without seeing both.
    expect(problems[0].detail).toContain('a/Roll.glb');
    expect(problems[0].detail).toContain('b/Roll.glb');
  });

  it('retires a collision the user has fixed', () => {
    reportDocumentIdCollisions([{ id: 'doc_roll', paths: ['a/Roll.glb', 'b/Roll.glb'] }]);
    reportDocumentIdCollisions([]);
    expect(getProblems()).toEqual([]);
  });

  it('re-reporting the identical set keeps the same snapshot object', () => {
    // Opening the same project twice reports the same collisions; a fresh
    // array each time re-renders the panel for nothing.
    reportDocumentIdCollisions([{ id: 'doc_roll', paths: ['a/Roll.glb', 'b/Roll.glb'] }]);
    const first = getProblems();
    reportDocumentIdCollisions([{ id: 'doc_roll', paths: ['a/Roll.glb', 'b/Roll.glb'] }]);
    expect(getProblems()).toBe(first);
  });

  it('leaves problems of other codes alone', () => {
    reportProblem({
      id: 'missing-reference:occ1',
      severity: 'error',
      code: 'missing-reference',
      title: 'Referenced asset not found: Roll',
      detail: 'Searched for: assetId "doc_roll".',
    });
    reportDocumentIdCollisions([{ id: 'doc_roll', paths: ['a.glb', 'b.glb'] }]);
    reportDocumentIdCollisions([]);        // the collision was fixed
    // The missing reference is somebody else's business and survives untouched.
    expect(getProblems().map(p => p.code)).toEqual(['missing-reference']);
  });
});
