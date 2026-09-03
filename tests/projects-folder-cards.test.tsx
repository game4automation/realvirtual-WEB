// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Lauf 13 — folders in the tree, assets on cards.
 *
 * The user asked for the Unity project window: "the project tree should show
 * only folders! assets are shown as cards!". `project-tree.test.tsx` pins the
 * left half (no document rows, a card dropped onto a folder moves, a read-only
 * catalog refuses). This file pins the right half and the seam between them:
 *
 *  1. The grid shows the SELECTED folder's contents, and only its own.
 *  2. Search and the chips cut the cards; the chip counts match what is shown.
 *  3. Double-click opens — the same verb a tree row's double-click used to be.
 *  4. Dragging a card and dropping it on a folder moves it, through the tree.
 *
 * The wiring under test is the host's, reproduced here as `Screen`: the host
 * itself needs a project store, a library registry and a viewer, none of which
 * this behaviour depends on. What `Screen` may NOT do is re-implement a rule —
 * every rule below comes from `rv-project-tree.ts` unchanged.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useMemo, useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectTree } from '../src/core/hmi/projects/ProjectTree';
import {
  ProjectFolderContents,
  type FolderCardModel,
  type FolderTileModel,
} from '../src/core/hmi/projects/ProjectFolderContents';
import {
  buildProjectTree,
  folderContents,
  folderSubfolders,
  nearestFolderPath,
  type ProjectTreeNode,
  type ProjectTreeRootInput,
} from '../src/core/project/rv-project-tree';
import {
  documentChipOptions,
  matchesDocumentFilter,
  matchesSearchTerm,
  type DocumentFilterState,
} from '../src/core/hmi/projects/document-filter';

// ─── Fixtures ────────────────────────────────────────────────────────────

const PROJECT_ROOT: ProjectTreeRootInput = {
  id: 'proj_myplant',
  name: 'MyPlant',
  kind: 'project',
  writable: true,
  files: [
    { path: 'machines/Filler.glb', documentId: 'doc_filler' },
    { path: 'machines/Capper.glb', documentId: 'doc_capper' },
    { path: 'parts/Roll2m.glb', documentId: 'doc_roll' },
    { path: 'docs/Module_A/4112630_BOM.pdf' },
  ],
};

const READONLY_CATALOG: ProjectTreeRootInput = {
  id: 'cat_cloud',
  name: 'Component Cloud',
  kind: 'catalog',
  writable: false,
  remote: true,
  files: [{ path: 'conveyors/Belt.glb' }],
};

/** Classification of a fixture row, by name — the chips' only input. */
const LEVELS: Record<string, string> = { 'Filler.glb': 'assembly' };

const NO_FILTER: DocumentFilterState = { term: '', chip: null, tag: null };

interface ScreenProps {
  roots?: ProjectTreeRootInput[];
  filter?: DocumentFilterState;
  onOpen?: (node: ProjectTreeNode) => void;
  onMove?: (node: ProjectTreeNode, to: string) => void;
}

/**
 * Tree + grid, wired the way `ProjectsDashboardHost` wires them.
 *
 * Deliberately thin: selection state, the derived folder, the filtered cards
 * and the card→tree drag handshake. Everything it computes it computes with the
 * exported helpers, so a rule that changes changes this too.
 */
function Screen({ roots: input = [PROJECT_ROOT], filter = NO_FILTER, onOpen, onMove }: ScreenProps) {
  const roots = useMemo(() => buildProjectTree(input), [input]);
  const [selectedPath, setSelectedPath] = useState<string | null>(roots[0]?.path ?? null);
  const [cardDragPath, setCardDragPath] = useState<string | null>(null);

  const folderPath = nearestFolderPath(roots, selectedPath) ?? roots[0]?.path ?? null;
  const rows = folderContents(roots, folderPath).map(node => ({
    node,
    name: node.name,
    classification: LEVELS[node.name]
      ? ({ v: 1, level: LEVELS[node.name] } as never)
      : undefined,
  }));

  const chips = documentChipOptions(rows, filter.chip);
  // Subfolder tiles ahead of the asset cards, exactly as the host builds them:
  // only the search cuts them (chips describe documents), click navigates.
  const subfolderTiles: FolderTileModel[] = folderSubfolders(roots, folderPath)
    .filter(node => matchesSearchTerm(node.name, filter.term))
    .map(node => ({
      key: node.path!,
      name: node.name,
      holdsSomething: node.hasContent ?? node.children.length > 0,
      onOpen: () => setSelectedPath(node.path!),
    }));
  const cards: FolderCardModel[] = rows
    .filter(row => matchesDocumentFilter(row, filter))
    .map(({ node }) => ({
      key: node.path!,
      entry: { id: node.path!, name: node.name, category: 'custom' as const },
      tier: 'user' as const,
      selected: selectedPath === node.path,
      onSelect: () => setSelectedPath(node.path!),
      onOpen: () => onOpen?.(node),
      draggable: node.writable,
      onDragStart: (e: React.DragEvent) => {
        setCardDragPath(node.path!);
        e.dataTransfer.effectAllowed = 'move';
      },
      onDragEnd: () => setCardDragPath(null),
    }));

  return (
    <>
      <div data-chip-counts={chips.map(c => `${c.key}:${c.count}`).join(',')} />
      <ProjectTree
        roots={roots}
        height={600}
        selectedPath={selectedPath}
        onSelect={(n) => setSelectedPath(n.path!)}
        onMove={onMove}
        externalDragPath={cardDragPath}
      />
      <ProjectFolderContents cards={cards} folders={subfolderTiles} />
    </>
  );
}

/** Names of the cards currently on screen, in DOM order. */
function cardNames(): string[] {
  return [...document.querySelectorAll('[data-card-path]')]
    .map(el => el.getAttribute('data-card-path')!.split('/').pop()!);
}

function clickFolder(path: string): void {
  fireEvent.click(document.querySelector(`[data-path="${path}"]`)!);
}

afterEach(cleanup);

// ─── 1. The grid shows the selected folder ───────────────────────────────

describe('Lauf 13 — the cards are the selected folder\'s contents', () => {
  it('starts on the project root: its subfolders are tiles, not an empty state', () => {
    render(<Screen />);
    expect(cardNames().sort()).toEqual(['docs', 'machines', 'parts']);
    expect(screen.queryByText('This folder is empty.')).toBeNull();
  });

  it('shows a folder\'s documents once that folder is picked', () => {
    render(<Screen />);
    clickFolder('proj_myplant/machines');
    expect(cardNames().sort()).toEqual(['Capper.glb', 'Filler.glb']);
  });

  it('shows only THAT folder — a sibling\'s contents never leak in', () => {
    render(<Screen />);
    clickFolder('proj_myplant/parts');
    expect(cardNames()).toEqual(['Roll2m.glb']);
  });

  it('shows an attachment as a card too, not only a GLB', () => {
    render(<Screen />);
    fireEvent.click(document.querySelector('[data-path="proj_myplant/docs"]')!);
    // `docs` itself holds only the subfolder; the grid shows it as a tile,
    // and clicking the tile navigates — the same verb as the tree row.
    expect(cardNames()).toEqual(['Module_A']);
    fireEvent.click(document.querySelector('[data-card-path$="Module_A"]')!
      .querySelector('*')!);
    expect(cardNames()).toEqual(['4112630_BOM.pdf']);
  });

  it('keeps the folder in view when a card is selected', () => {
    render(<Screen />);
    clickFolder('proj_myplant/machines');
    fireEvent.click(document.querySelector('[data-card-path$="Filler.glb"]')!
      .querySelector('*')!);
    expect(cardNames().sort()).toEqual(['Capper.glb', 'Filler.glb']);
  });
});

// ─── 2. Search and chips cut the cards ───────────────────────────────────

describe('Lauf 13 — the filter narrows the cards, not the tree', () => {
  it('the search term drops the cards that do not match', () => {
    render(<Screen filter={{ term: 'capp', chip: null, tag: null }} />);
    clickFolder('proj_myplant/machines');
    expect(cardNames()).toEqual(['Capper.glb']);
    // The folder it is in is still in the tree — navigation does not move.
    expect(document.querySelector('[data-path="proj_myplant/parts"]')).not.toBeNull();
  });

  it('the search term cuts the subfolder tiles too — by name, like everything else', () => {
    render(<Screen filter={{ term: 'mach', chip: null, tag: null }} />);
    expect(cardNames()).toEqual(['machines']);
  });

  it('a chip never hides a subfolder tile — a folder carries no classification', () => {
    render(<Screen filter={{ term: '', chip: 'assembly', tag: null }} />);
    expect(cardNames().sort()).toEqual(['docs', 'machines', 'parts']);
  });

  it('a chip cuts by classification', () => {
    render(<Screen filter={{ term: '', chip: 'assembly', tag: null }} />);
    clickFolder('proj_myplant/machines');
    expect(cardNames()).toEqual(['Filler.glb']);
  });

  it('"Unclassified" selects the rows of this folder that carry no level', () => {
    render(<Screen filter={{ term: '', chip: 'unclassified', tag: null }} />);
    clickFolder('proj_myplant/machines');
    expect(cardNames()).toEqual(['Capper.glb']);
  });

  it('says so when the filter, not the folder, is why the grid is empty', () => {
    render(<Screen filter={{ term: 'nothing-matches-this', chip: null, tag: null }} />);
    clickFolder('proj_myplant/machines');
    expect(cardNames()).toEqual([]);
  });

  it('counts the chips over the folder in view, matching what is shown', () => {
    render(<Screen />);
    clickFolder('proj_myplant/machines');
    const counts = document.querySelector('[data-chip-counts]')!
      .getAttribute('data-chip-counts');
    // Two documents in `machines`, one classified — and NOT the three the
    // project holds in total.
    expect(counts).toBe('all:2,assembly:1,unclassified:1');
    expect(cardNames().length).toBe(2);
  });
});

// ─── 3. Double-click opens ───────────────────────────────────────────────

describe('Lauf 13 — a card opens on double-click', () => {
  it('opens the document the card stands for', () => {
    const onOpen = vi.fn();
    render(<Screen onOpen={onOpen} />);
    clickFolder('proj_myplant/parts');
    fireEvent.doubleClick(
      document.querySelector('[data-card-path$="Roll2m.glb"]')!.querySelector('*')!,
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].relPath).toBe('parts/Roll2m.glb');
  });
});

// ─── 4. Card onto a folder moves ─────────────────────────────────────────

describe('Lauf 13 — dragging a card onto a folder', () => {
  /** Drag the named card and drop it onto the middle of `toPath`'s tree row. */
  function dragCardOnto(cardSuffix: string, toPath: string): void {
    const card = document.querySelector(`[data-card-path$="${cardSuffix}"]`)!;
    const target = document.querySelector(`[data-path="${toPath}"]`)!;
    const dataTransfer = new DataTransfer();
    target.getBoundingClientRect = () => ({ top: 0, height: 20 }) as DOMRect;
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(target, { dataTransfer, clientY: 10 });
    fireEvent.drop(target, { dataTransfer, clientY: 10 });
  }

  it('moves it into that folder', () => {
    const onMove = vi.fn();
    render(<Screen onMove={onMove} />);
    clickFolder('proj_myplant/parts');
    dragCardOnto('Roll2m.glb', 'proj_myplant/machines');

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][0].documentId).toBe('doc_roll');
    expect(onMove.mock.calls[0][1]).toBe('machines/Roll2m.glb');
  });

  it('refuses the drop into a read-only catalog', () => {
    const onMove = vi.fn();
    render(<Screen roots={[PROJECT_ROOT, READONLY_CATALOG]} onMove={onMove} />);
    clickFolder('proj_myplant/parts');
    dragCardOnto('Roll2m.glb', 'cat_cloud/conveyors');
    expect(onMove).not.toHaveBeenCalled();
  });

  it('a read-only catalog\'s own cards are not draggable at all', () => {
    render(<Screen roots={[PROJECT_ROOT, READONLY_CATALOG]} />);
    clickFolder('cat_cloud/conveyors');
    const card = document.querySelector('[data-card-path$="Belt.glb"]')!;
    expect(card.getAttribute('draggable')).toBeNull();
  });
});
