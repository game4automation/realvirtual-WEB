// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-507 §9.4 — the project search as a flat list.
 *
 * `Screen` wires `ProjectSearchResults` the way `ProjectsDashboardHost` does —
 * search term, selection, the compact detail sheet, and the folder-hit glue
 * (select the folder, clear the term, focus the field). Like the harness in
 * `projects-folder-cards.test.tsx` it may not re-implement a rule: search,
 * filter order, cap and the verb rules all come from the modules under test.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ProjectSearchResults } from '../src/core/hmi/projects/ProjectSearchResults';
import { ProjectFolderContents, type FolderCardModel, type FolderTileModel } from '../src/core/hmi/projects/ProjectFolderContents';
import { ProjectsDetailSheet } from '../src/core/hmi/projects/ProjectsDetailSheet';
import {
  buildProjectTree, findTreeNode, folderContents, folderSubfolders, nearestFolderPath,
  type ProjectTreeNode, type ProjectTreeRootInput,
} from '../src/core/project/rv-project-tree';
import {
  buildProjectSearchIndex, capSearchResult, filterSearchGroups, isDocumentHit,
  searchDocumentRows, searchProjectIndex, MAX_SEARCH_RESULTS,
} from '../src/core/project/rv-project-tree-search';
import { documentChipOptions, matchesDocumentChip } from '../src/core/hmi/projects/document-filter';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';

// ─── Fixtures ────────────────────────────────────────────────────────────

const PROJECT: ProjectTreeRootInput = {
  id: 'proj', name: 'MyProject', kind: 'project', writable: true,
  files: [
    { path: 'models/lines/line3.glb', documentId: 'd_line3' },
    { path: 'models/lines/other.glb', documentId: 'd_other' },
    { path: 'models/line-a.glb', documentId: 'd_a' },
    { path: 'models/line-b.glb', documentId: 'd_b' },
    { path: 'docs/lineplan.pdf' },
    { path: 'a/b/c/d/e/deep-line.glb', documentId: 'd_deep' },
  ],
  folders: ['models/line-empty'],
};
const CATALOG: ProjectTreeRootInput = {
  id: 'cat', name: 'Conveyors', kind: 'catalog', writable: false,
  files: [{ path: 'parts/belts/belt-line-3m.glb' }],
};

/** Only `line-a.glb` carries a level — the chip's only input. */
const classificationOf = (node: ProjectTreeNode): DocumentClassification | undefined =>
  node.name === 'line-a.glb' ? ({ v: 1, level: 'assembly' } as never) : undefined;

interface ScreenProps {
  initialSearch?: string;
  compactLayout?: boolean;
  touchInput?: boolean;
  chip?: string | null;
  max?: number;
  onSelectSpy?: (node: ProjectTreeNode) => void;
  onActivateSpy?: (node: ProjectTreeNode) => void;
}

function Screen({
  initialSearch = 'line', compactLayout = false, touchInput = false, chip = null,
  max = MAX_SEARCH_RESULTS, onSelectSpy, onActivateSpy,
}: ScreenProps) {
  const roots = useMemo(() => buildProjectTree([PROJECT, CATALOG]), []);
  const index = useMemo(() => buildProjectSearchIndex(roots), [roots]);
  const [search, setSearch] = useState(initialSearch);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // The host's rule: a leaf selection raises the compact sheet, a folder does not.
  useEffect(() => {
    const node = selectedPath ? findTreeNode(roots, selectedPath) : null;
    setSheetOpen(node !== null && node.kind !== 'folder' && node.kind !== 'root');
  }, [selectedPath, roots]);

  const groups = useMemo(() => searchProjectIndex(index, search), [index, search]);
  const chips = documentChipOptions(searchDocumentRows(groups, classificationOf), chip);
  const result = capSearchResult(filterSearchGroups(groups,
    hit => !isDocumentHit(hit) || matchesDocumentChip(classificationOf(hit.entry.node), chip)), max);

  const onSelect = (node: ProjectTreeNode) => { onSelectSpy?.(node); setSelectedPath(node.path!); };
  const onActivate = (node: ProjectTreeNode) => {
    onActivateSpy?.(node);
    if (node.kind === 'folder') {
      setSelectedPath(node.path!);
      setSearch('');
      inputRef.current?.focus();
    }
  };

  const folderPath = nearestFolderPath(roots, selectedPath) ?? roots[0].path!;
  const cards: FolderCardModel[] = folderContents(roots, folderPath).map(node => ({
    key: node.path!,
    entry: { id: node.path!, name: node.name, category: 'custom' as const },
    tier: 'user' as const,
    selected: selectedPath === node.path,
    onSelect: () => setSelectedPath(node.path!),
    onOpen: () => {},
  }));
  const tiles: FolderTileModel[] = folderSubfolders(roots, folderPath).map(node => ({
    key: node.path!, name: node.name, onOpen: () => setSelectedPath(node.path!),
  }));

  return (
    <>
      <input aria-label="Search this project" ref={inputRef} value={search}
        onChange={(e) => setSearch(e.target.value)} />
      <div data-testid="selected-path">{selectedPath ?? ''}</div>
      <div data-testid="folder-path">{folderPath}</div>
      <div data-testid="chip-counts">{chips.map(c => `${c.key}:${c.count}`).join(',')}</div>
      {search.trim() !== ''
        ? (
          <ProjectSearchResults result={result} selectedPath={selectedPath}
            compactLayout={compactLayout} touchInput={touchInput}
            onSelect={onSelect} onActivate={onActivate} />
        )
        : <ProjectFolderContents cards={cards} folders={tiles} compactLayout={compactLayout} />}
      {compactLayout && (
        <ProjectsDetailSheet open={sheetOpen} onClose={() => setSheetOpen(false)}
          detail={{ title: selectedPath, subtitle: 'Model', actions: [] }} />
      )}
    </>
  );
}

const searchField = () => screen.getByLabelText('Search this project') as HTMLInputElement;
const results = () => screen.getByTestId('project-search-results');
const rowOf = (name: string) =>
  results().querySelector<HTMLElement>(`[data-card-path$="/${name}"]`)!;
const rowNames = () => [...results().querySelectorAll('[data-card-path]')]
  .map(el => el.getAttribute('data-card-path')!.split('/').pop()!);
const typeTerm = (value: string) => fireEvent.change(searchField(), { target: { value } });

afterEach(cleanup);

// ─── Rendering ───────────────────────────────────────────────────────────

describe('the list', () => {
  it('groups by root in root order, a catalog named as a library', () => {
    render(<Screen />);
    const groups = within(results()).getAllByRole('group');
    expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['MyProject', 'Conveyors']);
    expect(groups[1].textContent).toContain('Library: Conveyors');
    expect(groups[1].textContent).toContain('belt-line-3m.glb');
  });

  it('names the folders a hit sits in, folding the middle past four levels', () => {
    render(<Screen />);
    expect(rowOf('line3.glb').querySelector('[data-search-crumbs]')!.textContent).toBe('models / lines');
    expect(rowOf('deep-line.glb').querySelector('[data-search-crumbs]')!.textContent)
      .toBe('a / … / c / d / e');
  });

  it('marks the matched part of the name', () => {
    render(<Screen />);
    expect(rowOf('line3.glb').querySelector('mark')!.textContent).toBe('line');
  });

  it('carries the detail sheet marks: container and the selected row', () => {
    render(<Screen />);
    expect(results().hasAttribute('data-folder-contents')).toBe(true);
    fireEvent.click(rowOf('line3.glb'));
    expect(rowOf('line3.glb').getAttribute('data-card-selected')).toBe('true');
    expect(rowOf('line-a.glb').getAttribute('data-card-selected')).toBeNull();
  });

  it('says so when nothing matches', () => {
    render(<Screen initialSearch="zzz" />);
    expect(screen.getByText('Nothing in this project matches the search.')).toBeTruthy();
  });

  it('caps the list and names the rest', () => {
    render(<Screen max={2} />);
    expect(rowNames()).toHaveLength(2);
    const total = searchProjectIndex(buildProjectSearchIndex(buildProjectTree([PROJECT, CATALOG])), 'line')
      .reduce((n, g) => n + g.hits.length, 0);
    expect(screen.getByTestId('project-search-more').textContent)
      .toBe(`${total - 2} more matches — refine the search`);
  });

  it('an empty term shows the folder cards, not the list', () => {
    render(<Screen initialSearch="" />);
    expect(screen.queryByTestId('project-search-results')).toBeNull();
    expect(document.querySelector('[data-card-path="proj/models"]')).not.toBeNull();
  });
});

// ─── Chips ───────────────────────────────────────────────────────────────

describe('chips in search mode', () => {
  it('hide unmatched document hits, keep folder hits, count before filtering', () => {
    render(<Screen chip="assembly" />);
    const names = rowNames();
    expect(names).toContain('line-a.glb');
    expect(names).not.toContain('line3.glb');
    // Folder hits are chip-independent.
    expect(names).toContain('lines');
    expect(names).toContain('line-empty');
    // Counted over the unfiltered document hits (4 GLB + 1 PDF + the catalog one).
    expect(screen.getByTestId('chip-counts').textContent).toContain('all:6');
    expect(screen.getByTestId('chip-counts').textContent).toContain('assembly:1');
  });
});

// ─── Verbs ───────────────────────────────────────────────────────────────

describe('verbs', () => {
  it('click selects, double-click selects and activates', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<Screen onSelectSpy={onSelect} onActivateSpy={onActivate} />);
    fireEvent.click(rowOf('line3.glb'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.doubleClick(rowOf('line3.glb'));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0].name).toBe('line3.glb');
  });

  it('arrows, Home and End move the focus only; Enter selects and activates', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<Screen onSelectSpy={onSelect} onActivateSpy={onActivate} />);
    const rows = [...results().querySelectorAll<HTMLElement>('[data-card-path]')];
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'End' });
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    fireEvent.keyDown(rows[rows.length - 1], { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    fireEvent.keyDown(rows[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(rows[0]);
    expect(onSelect).not.toHaveBeenCalled();
    // Roving tab stop follows the focus.
    expect(rows[0].tabIndex).toBe(0);
    expect(rows[1].tabIndex).toBe(-1);
    const doc = rowOf('line3.glb');
    doc.focus();
    fireEvent.keyDown(doc, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('an inert file is only selected, and has no chevron', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<Screen touchInput onSelectSpy={onSelect} onActivateSpy={onActivate} />);
    const pdf = rowOf('lineplan.pdf');
    pdf.focus();
    fireEvent.keyDown(pdf, { key: 'Enter' });
    fireEvent.doubleClick(pdf);
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onActivate).not.toHaveBeenCalled();
    expect(within(pdf).queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('touch: a tap selects, the chevron opens', () => {
    const onSelect = vi.fn();
    const onActivate = vi.fn();
    render(<Screen touchInput onSelectSpy={onSelect} onActivateSpy={onActivate} />);
    const doc = rowOf('line3.glb');
    expect(within(rowOf('lines')).getByRole('button', { name: 'Open' })).toBeTruthy();
    fireEvent.click(doc);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.click(within(doc).getByRole('button', { name: 'Open' }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('no chevron without touch input', () => {
    render(<Screen />);
    expect(within(results()).queryAllByRole('button', { name: 'Open' })).toHaveLength(0);
  });
});

// ─── Folder hits navigate (SOL-5, SOL-R2-2) ──────────────────────────────

describe('activating a folder hit', () => {
  for (const compactLayout of [false, true]) {
    for (const folder of ['lines', 'line-empty']) {
      it(`navigates to ${folder} and parks the focus in the field (${compactLayout ? 'compact' : 'desktop'})`, () => {
        render(<Screen compactLayout={compactLayout} />);
        const row = rowOf(folder);
        row.focus();
        fireEvent.keyDown(row, { key: 'Enter' });
        expect(screen.getByTestId('selected-path').textContent).toBe(`proj/models/${folder}`);
        expect(searchField().value).toBe('');
        expect(screen.queryByTestId('project-search-results')).toBeNull();
        expect(screen.getByTestId('folder-path').textContent).toBe(`proj/models/${folder}`);
        expect(document.activeElement).toBe(searchField());
        // A folder never raises the sheet.
        expect(screen.queryByTestId('projects-detail-sheet')).toBeNull();
      });
    }
  }

  it('touch chevron on a folder navigates too', () => {
    render(<Screen touchInput />);
    fireEvent.click(within(rowOf('lines')).getByRole('button', { name: 'Open' }));
    expect(searchField().value).toBe('');
    expect(screen.getByTestId('folder-path').textContent).toBe('proj/models/lines');
  });
});

// ─── Focus repair (SOL-R2-1) ─────────────────────────────────────────────

describe('focus repair', () => {
  it('(a) the focused row is filtered away: the container catches the focus', () => {
    render(<Screen />);
    const row = rowOf('line-b.glb');
    row.focus();
    expect(document.activeElement).toBe(row);
    typeTerm('line3');
    expect(document.querySelector('[data-card-path$="/line-b.glb"]')).toBeNull();
    expect(document.activeElement).toBe(results());
  });

  it('(b) the focus is in the field: a vanishing selected row leaves it there', () => {
    render(<Screen />);
    fireEvent.click(rowOf('line-b.glb'));
    const field = searchField();
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
    typeTerm('line3');
    typeTerm('line3.');
    expect(document.querySelector('[data-card-path$="/line-b.glb"]')).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(field.value.length);
  });
});

// ─── Compact layout and the detail sheet (SOL-4) ─────────────────────────

describe('compact layout with the real detail sheet', () => {
  it('arrows raise no sheet; Enter does; closing hands the focus back to the row', () => {
    render(<Screen compactLayout />);
    const rows = [...results().querySelectorAll<HTMLElement>('[data-card-path]')];
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    fireEvent.keyDown(rows[1], { key: 'ArrowDown' });
    expect(screen.queryByTestId('projects-detail-sheet')).toBeNull();

    const doc = rowOf('line3.glb');
    doc.focus();
    fireEvent.keyDown(doc, { key: 'Enter' });
    const sheet = screen.getByTestId('projects-detail-sheet');
    const close = within(sheet).getByRole('button', { name: 'Close details' });
    expect(document.activeElement).toBe(close);

    fireEvent.click(close);
    expect(document.activeElement).toBe(rowOf('line3.glb'));
    expect(rowOf('line3.glb').getAttribute('data-card-selected')).toBe('true');
  });
});
