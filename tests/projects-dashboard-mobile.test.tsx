// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-458 §9.2 — the projects dashboard on the compact layout.
 *
 * ## What is rendered, and what is asserted over source
 *
 * `ProjectsDashboardHost.tsx` says of itself that it cannot be rendered by a
 * test: it pulls the project store, the library registry, the scene store, the
 * viewer and the private asset editor. Two established patterns cover it, and
 * this file uses both rather than inventing a third:
 *
 *  - **Rendered, for everything that lives in a component.** The shell, the
 *    hero band, the grid, the cards, the detail pane and the detail sheet are
 *    the REAL components here, wired the way the host wires them — the same
 *    approach as `projects-folder-cards.test.tsx` and
 *    `dashboard-hero-placement.test.tsx`.
 *  - **Asserted over the host's own source** (`?raw`), for the handful of
 *    facts that exist only as host JSX: which column is gated on the compact
 *    layout, which sx the search field gets, whether the detail is a pane or a
 *    sheet. That is the pattern of `dashboard-one-list.test.tsx` and
 *    `connect-active-document.test.ts`, and it is honest: a harness that
 *    re-typed the host's JSX would only ever test itself.
 *
 * The two AXES are mocked separately, because separating them is the point:
 * `useMobileLayout` is width, `useTouchDevice` is the pointer. Both are reset
 * before every test so one case cannot configure the next.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../src/hooks/use-viewport-insets', () => ({
  useViewportInsets: () => ({ left: 0, right: 0, top: 0 }),
}));
vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hooks/use-mobile-layout')>()),
  useMobileLayout: vi.fn(() => true),
  useTouchDevice: vi.fn(() => true),
}));

import { useMemo, useState } from 'react';
import {
  act, cleanup, fireEvent, render, screen, waitFor, within,
} from '@testing-library/react';
import { useMobileLayout, useTouchDevice } from '../src/hooks/use-mobile-layout';
import { ProjectsDashboard } from '../src/core/hmi/projects/ProjectsDashboard';
import { DocumentHeroSection } from '../src/core/hmi/projects/DocumentHeroSection';
import {
  ProjectFolderContents,
  type FolderCardModel,
  type FolderTileModel,
} from '../src/core/hmi/projects/ProjectFolderContents';
import { ProjectsDetailPane } from '../src/core/hmi/projects/ProjectsDetailPane';
import { ProjectsDetailSheet } from '../src/core/hmi/projects/ProjectsDetailSheet';
import { mobileLibraryTiles } from '../src/core/hmi/projects/mobile-folder-view';
import {
  buildProjectTree,
  folderContents,
  folderSubfolders,
  nearestFolderPath,
  type ProjectTreeRootInput,
} from '../src/core/project/rv-project-tree';
import {
  openProjectsDashboard,
  resetProjectsDashboardForTests,
} from '../src/core/hmi/projects/projects-dashboard-store';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import HOST_SOURCE from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';

// ─── Fixtures ────────────────────────────────────────────────────────────

const PROJECT: ProjectTreeRootInput = {
  id: 'proj_aml',
  name: 'AutomationML',
  kind: 'project',
  writable: true,
  files: [
    { path: 'aml/Cell.glb', documentId: 'doc_cell' },
    { path: 'docs/readme.md' },
  ],
};

const LIBRARY: ProjectTreeRootInput = {
  id: 'lib_a',
  name: 'Lib A',
  kind: 'catalog',
  writable: false,
  files: [{ path: 'conveyors/Belt.glb' }],
};

/**
 * Tree + grid + detail, wired the way the host wires them on a phone.
 *
 * Thin on purpose: selection, the derived folder, the tiles and the sheet's
 * open state. Every RULE it consults is imported unchanged — `folderContents`,
 * `folderSubfolders`, `nearestFolderPath`, `mobileLibraryTiles`.
 */
function Screen({
  roots: input = [PROJECT],
  compactLayout = true,
  touchInput = true,
  withLibrary = false,
  onOpen,
}: {
  roots?: ProjectTreeRootInput[];
  compactLayout?: boolean;
  touchInput?: boolean;
  withLibrary?: boolean;
  onOpen?: (path: string) => void;
} = {}) {
  const roots = useMemo(() => buildProjectTree(input), [input]);
  const projectRoots = roots.filter(r => r.rootKind !== 'catalog');
  const libraryRoots = roots.filter(r => r.rootKind === 'catalog');
  const [selectedPath, setSelectedPath] = useState<string | null>(projectRoots[0]?.path ?? null);
  const [gridMenu, setGridMenu] = useState<{ x: number; y: number } | null>(null);

  const folderPath = nearestFolderPath(roots, selectedPath) ?? projectRoots[0]?.path ?? null;
  const selectedNode = selectedPath
    ? folderContents(roots, folderPath).find(n => n.path === selectedPath) ?? null
    : null;
  const sheetOpen = selectedNode !== null;

  const folders: FolderTileModel[] = folderSubfolders(roots, folderPath).map(node => ({
    key: node.path!,
    name: node.name,
    holdsSomething: node.hasContent ?? node.children.length > 0,
    onOpen: () => setSelectedPath(node.path!),
    menuActions: [{ key: 'rename', label: 'Rename…', onClick: () => {} }],
  }));

  const cards: FolderCardModel[] = folderContents(roots, folderPath).map(node => ({
    key: node.path!,
    entry: { id: node.path!, name: node.name, category: 'custom' as const },
    tier: 'user' as const,
    selected: selectedPath === node.path,
    onSelect: () => setSelectedPath(node.path!),
    onOpen: () => onOpen?.(node.path!),
    menuActions: [{ key: 'open', label: 'Open', onClick: () => onOpen?.(node.path!) }],
    draggable: node.writable,
    onDragStart: () => {},
    onDragEnd: () => {},
  }));

  const libraryTiles: FolderTileModel[] = withLibrary && compactLayout
    && folderPath === projectRoots[0]?.path
    ? mobileLibraryTiles(libraryRoots).map(tile => ({
      key: tile.key,
      name: tile.name,
      holdsSomething: tile.holdsSomething,
      onOpen: () => setSelectedPath(tile.key),
    }))
    : [];

  const detail = {
    title: selectedNode?.name ?? null,
    subtitle: 'Model',
    actions: [{ key: 'open', label: 'Open', primary: true, onClick: () => {} }],
  };

  return (
    <>
      <div data-testid="folder-path">{folderPath}</div>
      <ProjectFolderContents
        cards={cards}
        folders={folders}
        tileGroups={libraryTiles.length > 0
          ? [{ key: 'libraries', label: 'Libraries', tiles: libraryTiles }]
          : []}
        compactLayout={compactLayout}
        touchInput={touchInput}
        onBackgroundContextMenu={(e) => setGridMenu({ x: e.clientX, y: e.clientY })}
      />
      {gridMenu !== null && (
        <div role="menu" data-testid="grid-menu-new-folder">New folder</div>
      )}
      {compactLayout
        ? (
          <ProjectsDetailSheet
            open={sheetOpen}
            onClose={() => setSelectedPath(folderPath)}
            detail={detail}
          />
        )
        : <ProjectsDetailPane {...detail} />}
    </>
  );
}

function makeView(name = 'Cell.glb'): ActiveDocumentView {
  return {
    name,
    crumbs: [{
      index: 0, label: name, occurrence: '', referenceNodeId: null,
      dirty: false, stale: false, current: true,
    }],
    dirty: false, busy: false, stackDirty: false, stale: false,
    saveVerb: 'save', sourceMode: 'planner',
    actions: { save: async () => ({ status: 'saved' }) },
  };
}

/** Long-press a node: down, wait out the delay, up, then the trailing click. */
function longPress(el: Element, at = { clientX: 10, clientY: 10 }) {
  fireEvent.pointerDown(el, { pointerType: 'touch', ...at });
  act(() => { vi.advanceTimersByTime(600); });
  fireEvent.pointerUp(el, { pointerType: 'touch' });
  fireEvent.click(el);
}

const item = (suffix: string) => document.querySelector(`[data-card-path$="${suffix}"]`)!;
/**
 * The clickable body of a card — reached through its LABEL.
 *
 * Not `querySelector('*')`: on a coarse pointer the card wears a
 * pointer-handler wrapper, and the wrapper is the first child, so a click on
 * it would never reach the card underneath. The label is inside the card and
 * bubbles to it either way.
 */
const cardBody = (suffix: string) =>
  within(item(suffix) as HTMLElement).getByText(suffix);
/** A folder tile has no wrapper: its first child bubbles to the tile itself. */
const tileBody = (suffix: string) => item(suffix).querySelector('*')!;

beforeEach(() => {
  resetProjectsDashboardForTests();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
  vi.mocked(useMobileLayout).mockReturnValue(true);
  vi.mocked(useTouchDevice).mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ─── F1 / F10 — the shell fills the viewport ─────────────────────────────

describe('plan-458 F1 — the shell on the compact layout', () => {
  it('sits flush left: no activity-bar offset', () => {
    openProjectsDashboard();
    render(<ProjectsDashboard title="Projects"><div /></ProjectsDashboard>);
    expect(screen.getByRole('region', { name: 'Projects' })).toHaveStyle({ left: '0px' });
  });

  it('keeps the activity-bar offset on the desktop', () => {
    vi.mocked(useMobileLayout).mockReturnValue(false);
    openProjectsDashboard();
    render(<ProjectsDashboard title="Projects"><div /></ProjectsDashboard>);
    expect(screen.getByRole('region', { name: 'Projects' })).toHaveStyle({ left: '46px' });
  });

  it('hides the header subtitle — it is nowrap and would collide at 390px', () => {
    openProjectsDashboard();
    render(
      <ProjectsDashboard title="P" subtitle="folder project · 0 documents">
        <div />
      </ProjectsDashboard>,
    );
    expect(screen.queryByTestId('projects-header-subtitle')).toBeNull();
  });

  it('keeps the subtitle on the desktop', () => {
    vi.mocked(useMobileLayout).mockReturnValue(false);
    openProjectsDashboard();
    render(
      <ProjectsDashboard title="P" subtitle="folder project · 0 documents">
        <div />
      </ProjectsDashboard>,
    );
    expect(screen.getByTestId('projects-header-subtitle')).toBeTruthy();
  });

  it('gives the window chrome 44px touch targets', () => {
    openProjectsDashboard();
    render(<ProjectsDashboard title="P" onBack={() => {}}><div /></ProjectsDashboard>);
    for (const name of ['Back to projects', 'Close Projects']) {
      const box = screen.getByLabelText(name).getBoundingClientRect();
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
  });

  it('F10: the overview search field is flexible, not a fixed 240px', () => {
    openProjectsDashboard();
    const { unmount } = render(<ProjectsDashboard title="P"><div /></ProjectsDashboard>);
    const width = () => getComputedStyle(
      screen.getByPlaceholderText('Search…').closest('.MuiTextField-root')!).width;
    expect(width()).not.toBe('240px');
    unmount();

    vi.mocked(useMobileLayout).mockReturnValue(false);
    render(<ProjectsDashboard title="P"><div /></ProjectsDashboard>);
    expect(width()).toBe('240px');
  });

  it('clips its own box, so the detail sheet slides in from the edge', () => {
    openProjectsDashboard();
    render(<ProjectsDashboard title="Projects"><div /></ProjectsDashboard>);
    expect(getComputedStyle(screen.getByRole('region', { name: 'Projects' })).overflow)
      .toBe('hidden');
  });
});

// ─── F9 — the compact hero ───────────────────────────────────────────────

describe('plan-458 F9 — the hero band', () => {
  function renderHero(compactLayout: boolean) {
    openProjectsDashboard();
    return render(
      <ProjectsDashboard
        title="P"
        hero={<DocumentHeroSection compactLayout={compactLayout} />}
      >
        <div />
      </ProjectsDashboard>,
    );
  }

  it('is the compact card, and offers no drop target', () => {
    setOpenDocumentBase({ kind: 'document', documentId: 'doc_cell', path: 'aml/Cell.glb', name: 'Cell.glb' });
    setActiveDocumentView(makeView());
    renderHero(true);
    expect(screen.getByTestId('document-card-compact')).toBeTruthy();
    // No drag on a phone — an outline promising one would be a lie.
    expect(screen.queryByTestId('document-hero-dropzone')).toBeNull();
  });

  it('keeps the hero card and its dropzone on the desktop', () => {
    setOpenDocumentBase({ kind: 'document', documentId: 'doc_cell', path: 'aml/Cell.glb', name: 'Cell.glb' });
    setActiveDocumentView(makeView());
    renderHero(false);
    expect(screen.getByTestId('document-hero-dropzone')).toBeTruthy();
    expect(screen.queryByTestId('document-card-compact')).toBeNull();
  });

  it('names the gesture the device has in its empty state', () => {
    const { unmount } = renderHero(true);
    expect(screen.getByTestId('document-hero-empty').textContent)
      .toContain('tap a document');
    unmount();
    renderHero(false);
    expect(screen.getByTestId('document-hero-empty').textContent)
      .toContain('double-click');
  });
});

// ─── F2 / F3 / F7 — the drill-down grid ──────────────────────────────────

describe('plan-458 F2/F3/F7 — the grid is the screen', () => {
  it('announces itself as the document list', () => {
    render(<Screen />);
    expect(screen.getByRole('list', { name: 'Documents' })).toBeTruthy();
  });

  it('F7: a single tap on a folder tile navigates', () => {
    render(<Screen />);
    expect(screen.getByTestId('folder-path').textContent).toBe('proj_aml');
    fireEvent.click(tileBody('aml'));
    expect(screen.getByTestId('folder-path').textContent).toBe('proj_aml/aml');
  });

  it('F3: the attached libraries are tiles under a "Libraries" heading', () => {
    render(<Screen roots={[PROJECT, LIBRARY]} withLibrary />);
    expect(screen.getByText('Libraries')).toBeTruthy();
    const tile = screen.getByRole('listitem', { name: 'Lib A' });
    fireEvent.click(tile.querySelector('*')!);
    expect(screen.getByTestId('folder-path').textContent).toBe('lib_a');
  });

  it('F3: no library section on the desktop — the tree column is their entrance', () => {
    render(<Screen roots={[PROJECT, LIBRARY]} withLibrary compactLayout={false} touchInput={false} />);
    expect(screen.queryByText('Libraries')).toBeNull();
  });

  it('drops the drag on the compact layout, and keeps it on the desktop', () => {
    const { unmount } = render(<Screen />);
    fireEvent.click(tileBody('aml'));
    expect(item('Cell.glb')).toBeTruthy();
    // No tree to drop onto, so a drag could only ever be refused.
    expect(item('Cell.glb').getAttribute('draggable')).toBeNull();
    unmount();

    render(<Screen compactLayout={false} touchInput={false} />);
    fireEvent.click(tileBody('aml'));
    expect(item('Cell.glb').getAttribute('draggable')).toBe('true');
  });
});

// ─── F8 / F13 — long-press ───────────────────────────────────────────────

describe('plan-458 F8/F13 — long-press is the right-click', () => {
  beforeEach(() => vi.useFakeTimers());

  it('opens the tile menu, and the trailing click does NOT navigate', () => {
    render(<Screen />);
    longPress(tileBody('aml'));
    expect(screen.getByRole('menu')).toBeTruthy();
    expect(screen.getByTestId('folder-path').textContent).toBe('proj_aml');
  });

  it('opens the card menu only — the grid gets no second menu from the same press', () => {
    render(<Screen />);
    fireEvent.click(tileBody('aml'));
    longPress(cardBody('Cell.glb'));
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(screen.queryByTestId('grid-menu-new-folder')).toBeNull();
    // The trailing click was consumed, and the press itself does not select —
    // a sheet here would cover the menu it was asked for.
    expect(screen.queryByTestId('projects-detail-sheet')).toBeNull();
  });

  it('opens the folder menu from the blank grid', () => {
    render(<Screen />);
    const grid = screen.getByRole('list', { name: 'Documents' });
    fireEvent.pointerDown(grid, { pointerType: 'touch', clientX: 300, clientY: 400 });
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.pointerUp(grid, { pointerType: 'touch' });
    expect(screen.getByTestId('grid-menu-new-folder')).toBeTruthy();
  });

  it('is cancelled by movement beyond the tolerance and by pointercancel', () => {
    render(<Screen />);
    const tile = tileBody('aml');
    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(tile, { pointerType: 'touch', clientX: 40, clientY: 10 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('menu')).toBeNull();

    fireEvent.pointerDown(tile, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerCancel(tile, { pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hybrid — a narrow window with a mouse keeps right-click and gets no long-press', () => {
    render(<Screen compactLayout touchInput={false} />);
    const tile = tileBody('aml');
    fireEvent.pointerDown(tile, { pointerType: 'mouse', clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.contextMenu(tile, { clientX: 10, clientY: 10 });
    expect(screen.getByRole('menu')).toBeTruthy();
  });
});

// ─── F6 — the detail sheet ───────────────────────────────────────────────

describe('plan-458 F6 — the detail sheet', () => {
  it('rises on a document tap, carries every verb as a button, and leaves the a11y tree at once on close', async () => {
    render(<Screen />);
    fireEvent.click(tileBody('aml'));
    fireEvent.click(cardBody('Cell.glb'));

    const sheet = await screen.findByTestId('projects-detail-sheet');
    expect(sheet).toBeVisible();
    expect(within(sheet).getByRole('button', { name: 'Open' })).toBeTruthy();

    fireEvent.click(within(sheet).getByRole('button', { name: 'Close details' }));
    // Immediately — not after the exit transition.
    expect(sheet.getAttribute('aria-hidden')).toBe('true');
    expect(sheet.hasAttribute('inert')).toBe(true);
    await waitFor(() => expect(screen.queryByTestId('projects-detail-sheet')).toBeNull());
  });

  it('stays away for a folder selection — navigation is not a thing with facts', () => {
    render(<Screen />);
    fireEvent.click(tileBody('aml'));
    expect(screen.queryByTestId('projects-detail-sheet')).toBeNull();
  });

  it('unmounts synchronously under reduced motion', async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('reduce'), media: q, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<Screen />);
      fireEvent.click(tileBody('aml'));
      fireEvent.click(cardBody('Cell.glb'));
      const sheet = await screen.findByTestId('projects-detail-sheet');
      fireEvent.click(within(sheet).getByRole('button', { name: 'Close details' }));
      expect(screen.queryByTestId('projects-detail-sheet')).toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });

  it('hands focus to the close button, and gives it back to the grid on close', async () => {
    render(<Screen />);
    fireEvent.click(tileBody('aml'));
    fireEvent.click(cardBody('Cell.glb'));
    const sheet = await screen.findByTestId('projects-detail-sheet');
    const close = within(sheet).getByRole('button', { name: 'Close details' });
    await waitFor(() => expect(document.activeElement).toBe(close));

    fireEvent.click(close);
    // The card it described is the selected one; the grid is the fallback.
    expect(document.activeElement?.closest('[data-card-path],[data-folder-contents]')).toBeTruthy();
  });
});

// ─── F11 — the desktop measures ──────────────────────────────────────────

describe('plan-458 F11 — the desktop pane keeps its column', () => {
  it('the detail pane is 260px wide and keeps its left hairline', () => {
    render(<ProjectsDetailPane title={null} />);
    const column = screen.getByTestId('projects-detail-empty').parentElement!;
    expect(getComputedStyle(column).width).toBe('260px');
    expect(getComputedStyle(column).borderLeftWidth).toBe('1px');
    expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull();
  });

  it('the sheet variant is full width, borderless, and offers the close button', () => {
    render(<ProjectsDetailPane title="Cell.glb" variant="sheet" onClose={() => {}} />);
    const close = screen.getByRole('button', { name: 'Close details' });
    expect(getComputedStyle(close).width).toBe('44px');
    expect(getComputedStyle(close.closest('[class*="MuiBox"]')!.parentElement!).borderLeftWidth)
      .toBe('0px');
  });
});

// ─── The host's own wiring, over its source ──────────────────────────────

describe('plan-458 — the host wiring that only source can show', () => {
  it('F2: the tree column is gated on the compact layout, not merely hidden', () => {
    expect(HOST_SOURCE).toContain('{!compactLayout && (');
    expect(HOST_SOURCE).toContain('data-testid="projects-tree-column"');
    // Gate BEFORE the width, i.e. the column is the thing gated.
    const gate = HOST_SOURCE.indexOf('{!compactLayout && (');
    const width = HOST_SOURCE.indexOf('width: 280,');
    expect(gate).toBeGreaterThan(-1);
    expect(width).toBeGreaterThan(gate);
  });

  it('F5: the grid search field is flexible on the compact layout and 200px otherwise', () => {
    expect(HOST_SOURCE).toContain("? { flex: '1 1 140px', minWidth: 0 }");
    expect(HOST_SOURCE).toContain(': { width: 200, flexShrink: 0 }');
    // 16px on a coarse pointer, whatever the layout — the iOS zoom rule.
    expect(HOST_SOURCE).toContain('fontSize: touchInput ? 16 : 12');
  });

  it('F6: the detail is a sheet on the compact layout and a pane otherwise', () => {
    expect(HOST_SOURCE).toContain('<ProjectsDetailSheet');
    expect(HOST_SOURCE).toContain('open={detailSheetOpen}');
    expect(HOST_SOURCE).toContain(': <ProjectsDetailPane {...detail} />}');
  });

  it('F3: "Add library…" joins the project menu only on the compact layout', () => {
    expect(HOST_SOURCE).toContain('{compactLayout && (');
    expect(HOST_SOURCE).toContain('Add library…');
    // The desktop keeps its header button on the Libraries section.
    expect(HOST_SOURCE).toContain('aria-label="Add library"');
  });

  it('F9: the hero is told which layout it is in', () => {
    expect(HOST_SOURCE).toContain('<DocumentHeroSection onReveal={handleHeroReveal} compactLayout={compactLayout} />');
  });

  it('F4: the trail is collapsed and a library trail is prefixed with its project', () => {
    expect(HOST_SOURCE).toContain('collapseCrumbs(trail, 3)');
    expect(HOST_SOURCE).toContain("rootKind === 'catalog'");
    expect(HOST_SOURCE).toContain('aria-label="Show hidden folders"');
  });

  it('the sheet opens on a thing and closes on a place', () => {
    expect(HOST_SOURCE).toContain("kind === 'document' || kind === 'documentPath'");
    expect(HOST_SOURCE).toContain("kind === 'file' || kind === 'asset'");
  });
});
