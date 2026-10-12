// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.6 — the "Recently opened" section.
 *
 * Two blocks, the split `dashboard-one-list.test.tsx` established for this
 * screen:
 *
 *  1. **The component**, rendered for real — chips, the lock icon, the empty
 *     case, and the disabled state while a chain runs.
 *  2. **The host's wiring**, asserted over the inlined source. The host is
 *     4000 lines of React that no test renders cheaply, and the three things
 *     that can silently go missing here are one-liners inside it: the kiosk
 *     gate, and the two `forgetRecentsOfProject` calls that make F10 true. A
 *     behavioural test would need the whole dashboard to see any of them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import HOST_SOURCE from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';
import BOTTOM_BAR_SOURCE from '../src/core/hmi/BottomBar.tsx?raw';
import { RecentDocumentsSection } from '../src/core/hmi/projects/RecentDocumentsSection';
import type { RecentDocumentEntry } from '../src/core/project/rv-project-recents';
import type { LinkedRowState } from '../src/core/hmi/projects/ProjectsList';

function entry(over: Partial<RecentDocumentEntry> = {}): RecentDocumentEntry {
  return {
    projectId: 'P', backend: 'folder',
    documentId: 'doc_a', documentName: 'Line 3', projectName: 'mauser3dhmi',
    documentPath: 'models/line3.glb',
    mode: 'hmi', openedAt: '2026-09-12T10:00:00.000Z',
    ...over,
  };
}

const LABELS: Record<string, string> = { hmi: 'HMI', planner: 'Planner', editor: 'Editor' };
const modeLabel = (m: string) => LABELS[m];

function renderSection(
  entries: readonly RecentDocumentEntry[],
  over: {
    rowStates?: Map<string, LinkedRowState>;
    busy?: boolean;
    onOpen?: (e: RecentDocumentEntry) => void;
    onForget?: (e: RecentDocumentEntry) => void;
    onClear?: () => void;
  } = {},
) {
  return render(
    <RecentDocumentsSection
      entries={entries}
      rowStates={over.rowStates ?? new Map()}
      modeLabel={modeLabel}
      busy={over.busy ?? false}
      onOpen={over.onOpen ?? (() => {})}
      onForget={over.onForget ?? (() => {})}
      onClear={over.onClear ?? (() => {})}
    />,
  );
}

afterEach(cleanup);

// ─── 1. The component ────────────────────────────────────────────────────

describe('the section itself', () => {
  it('names the document, its project and the mode it was used in', () => {
    renderSection([entry()]);
    expect(screen.getByText('Line 3')).toBeTruthy();
    // The project name shares the secondary line with the path since plan-482,
    // so it is read off the line rather than looked up as a standalone node.
    expect(screen.getByTestId('recent-path-doc_a').textContent).toContain('mauser3dhmi');
    expect(screen.getByTestId('recent-mode-doc_a').textContent).toBe('HMI');
  });

  // T-UI-1 (plan-482 F1/F6) — the path is REAL text in the DOM, not a tooltip
  // the screen reader may or may not announce. Both halves of the split are
  // present and, read together, spell the whole path.
  it('shows the project-relative path as real text, file name in its own span', () => {
    renderSection([entry({ documentPath: 'models/production-line/line3.glb' })]);
    const line = screen.getByTestId('recent-path-doc_a');
    expect(line.textContent).toContain('models/production-line/line3.glb');
    expect(screen.getByTestId('recent-path-file-doc_a').textContent).toBe('line3.glb');
  });

  it('a path with no folder renders as the file name alone', () => {
    renderSection([entry({ documentPath: 'line3.glb' })]);
    expect(screen.getByTestId('recent-path-file-doc_a').textContent).toBe('line3.glb');
    expect(screen.getByTestId('recent-path-doc_a').textContent).toContain('line3.glb');
  });

  // R8 — the tooltip wraps the TEXT, never the ButtonBase. A wrapper that
  // swallowed the click would take the row's only function with it.
  it('still opens on click with the path line in place', () => {
    const onOpen = vi.fn();
    renderSection([entry({ documentPath: 'models/line3.glb' })], { onOpen });
    fireEvent.click(screen.getByTestId('recent-path-doc_a'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders NOTHING when the ring is empty', () => {
    renderSection([]);
    expect(screen.queryByTestId('recent-documents-section')).toBeNull();
  });

  it('shows no timestamp and no relative time (user decision 2026-09-07)', () => {
    const { container } = renderSection([entry()]);
    expect(container.textContent).not.toMatch(/ago|2026-09-12|10:00/);
  });

  it('drops the chip for a mode this build does not register', () => {
    renderSection([entry({ mode: 'des' })]);
    expect(screen.queryByTestId('recent-mode-doc_a')).toBeNull();
  });

  it('shows a lock for a project whose grant lapsed or whose folder is gone', () => {
    const rowStates = new Map<string, LinkedRowState>([['P', 'needs-grant']]);
    renderSection([entry()], { rowStates });
    expect(screen.getByTestId('recent-lock-doc_a')).toBeTruthy();
  });

  it('shows no lock for a ready project', () => {
    const rowStates = new Map<string, LinkedRowState>([['P', 'ready']]);
    renderSection([entry()], { rowStates });
    expect(screen.queryByTestId('recent-lock-doc_a')).toBeNull();
  });

  it('opens on click, and passes the whole entry', () => {
    const onOpen = vi.fn();
    renderSection([entry()], { onOpen });
    fireEvent.click(screen.getByText('Line 3'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0]).toMatchObject({ projectId: 'P', documentId: 'doc_a' });
  });

  it('every row is inert while a chain runs — never queued (F11)', () => {
    const onOpen = vi.fn();
    renderSection([entry()], { busy: true, onOpen });
    fireEvent.click(screen.getByText('Line 3'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('offers "Remove from list" per row and "Clear" for the section (F8)', () => {
    const onForget = vi.fn();
    const onClear = vi.fn();
    renderSection([entry()], { onForget, onClear });

    fireEvent.click(screen.getByTestId('recent-menu-doc_a'));
    fireEvent.click(screen.getByTestId('recent-forget-doc_a'));
    expect(onForget.mock.calls[0][0]).toMatchObject({ documentId: 'doc_a' });

    fireEvent.click(screen.getByTestId('recent-documents-clear'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('keeps two documents that share an id in different projects apart', () => {
    renderSection([
      entry({ projectId: 'P1', documentId: 'shared', documentName: 'Cell', projectName: 'One' }),
      entry({ projectId: 'P2', documentId: 'shared', documentName: 'Cell', projectName: 'Two' }),
    ]);
    // Two rows, not one collapsed key — identity is the PAIR.
    expect(screen.getAllByText('Cell')).toHaveLength(2);
    const lines = screen.getAllByTestId('recent-path-shared').map(n => n.textContent ?? '');
    expect(lines.some(t => t.includes('One'))).toBe(true);
    expect(lines.some(t => t.includes('Two'))).toBe(true);
  });
});

// ─── 2. The host's wiring ────────────────────────────────────────────────

/** The host's source with whole-line comments removed (the F8 guard pattern). */
const HOST_CODE = HOST_SOURCE
  .split('\n')
  .filter(line => !/^\s*(\/\/|\/\*|\*)/.test(line))
  .join('\n');

describe('the host wires the section (F5, F10)', () => {
  it('keeps recently opened out of the Projects window', () => {
    expect(HOST_CODE).not.toContain('<RecentDocumentsSection');
    expect(HOST_CODE).toContain('<RecentDocumentsPopover');
  });

  // Since plan-509 through `forgetProjectTraces`, which drops the recents
  // AND the folder model-index snapshot (pinned in forget-project-traces.test).
  it('unlinking a project forgets its recents (F10)', () => {
    const remove = HOST_CODE.slice(HOST_CODE.indexOf('const handleRemove'));
    expect(remove.slice(0, remove.indexOf('}, ['))).toContain('forgetProjectTraces(id)');
  });

  it('deleting a project forgets its recents too (F10)', () => {
    const del = HOST_CODE.slice(HOST_CODE.indexOf('const handleDeleteProject'));
    expect(del.slice(0, del.indexOf('}, ['))).toContain('forgetProjectTraces(id)');
  });

  it('the Quick-Open listener and popover are both gated on the kiosk lock', () => {
    const effect = HOST_CODE.slice(HOST_CODE.indexOf('isRecentDocumentsShortcut'));
    // The listener effect returns before it subscribes.
    expect(HOST_CODE).toMatch(/if \(modeLocked\) return;[\s\S]{0,400}isRecentDocumentsShortcut/);
    expect(effect).toContain("window.addEventListener('keydown', onKeyDown)");
    // And the popover itself is null under the lock.
    expect(HOST_CODE).toContain('const quickOpenPopover = modeLocked ? null : (');
  });

  // Since plan-509 the deps come from ONE builder shared with the model
  // search's `openModelHit`; the recents add only their `forgetRecent`.
  it('the chain gets the dirty guard and the store-backed document list', () => {
    const builder = HOST_CODE.slice(HOST_CODE.indexOf('const openChainDeps = useCallback('));
    const deps = builder.slice(0, builder.indexOf('}), ['));
    expect(deps).toContain('confirmDiscardDirtyScene');
    expect(deps).toContain('documents: () => store.getSnapshot().documents');
    // plan-513: the target is the stored last mode, read before the chain runs.
    expect(HOST_CODE).toContain('openRecentEntry(entry, { ...openChainDeps(), forgetRecent }, { lastMode })');
    expect(HOST_CODE).toContain('readDocumentMode(entry.backend, entry.projectId, entry.documentId)');
  });
});

// ─── 3. plan-507 §9.6 — the search wiring ────────────────────────────────

describe('the host wires the project search (plan-507)', () => {
  it('builds the index once per tree — never per keystroke', () => {
    const memo = HOST_CODE.match(/useMemo\(\s*\(\)\s*=>\s*buildProjectSearchIndex\(treeRoots\),\s*\[([^\]]*)\]\)/);
    expect(memo).not.toBeNull();
    expect(memo![1]).not.toContain('dash.search');
    expect(memo![1]).toContain('treeRoots');
  });

  it('filters search hits by chip and tag only, never by the substring filter', () => {
    const start = HOST_CODE.indexOf('const searchIndex = useMemo');
    const end = HOST_CODE.indexOf('useDashboardSearchShortcut(', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = HOST_CODE.slice(start, end);
    expect(block).not.toContain('matchesDocumentFilter(');
    expect(block).toMatch(/filterSearchGroups\([\s\S]*matchesDocumentChip\([\s\S]*matchesDocumentTag\(/);
    expect(block).toContain('capSearchResult(');
  });

  it('renders the hit list INSTEAD of the cards while a term is typed', () => {
    expect(HOST_CODE).toMatch(/\{searchMode \? \(\s*<ProjectSearchResults[\s\S]*?\) : \(\s*<ProjectFolderContents/);
  });

  it('claims `/` and Ctrl+K only on the project screen, for the search field', () => {
    expect(HOST_CODE).toContain('useDashboardSearchShortcut(searchInputRef,');
    expect(HOST_CODE).toMatch(/useDashboardSearchShortcut\(searchInputRef,\s*dash\.open && dash\.view === 'project' && project\.project !== null\)/);
    expect(HOST_CODE).toContain('inputRef={searchInputRef}');
    expect(HOST_CODE).toContain('placeholder="Search this project…"');
  });

  it('a folder hit navigates: select, clear the term, focus the field', () => {
    const fn = HOST_CODE.slice(HOST_CODE.indexOf('const handleSearchActivate'));
    const body = fn.slice(0, fn.indexOf('}, ['));
    expect(body).toContain("setProjectsSelection({ kind: 'folder'");
    expect(body).toContain("setProjectsSearch('')");
    expect(body).toContain('searchInputRef.current?.focus()');
    expect(body).toContain('handleTreeActivate(node)');
  });

  it('the BottomBar steps aside for a claimed shortcut', () => {
    const bar = BOTTOM_BAR_SOURCE.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
    expect(bar).toContain('isUnclaimedSearchShortcut(e)');
    expect(bar).not.toMatch(/[^d]isSearchShortcut\(e\)/);
  });
});
