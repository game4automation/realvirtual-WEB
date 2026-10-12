// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-478 §9.8 — the Quick-Open popover.
 *
 * It is opened by a key, so the contract under test is that it can be FINISHED
 * by key: move, jump, choose, dismiss, and hand the focus back to whatever had
 * it. Rendered for real in Chromium — `aria-activedescendant` and focus return
 * are exactly the two things a shallow render cannot answer.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { openProjectsDashboard, closeProjectsDashboard, openRecentDocumentsOnHover, scheduleRecentDocumentsClose, cancelRecentDocumentsClose, getRecentDocumentsOpen, setRecentDocumentsOpen, setRecentDocumentsPinned, subscribeRecentDocumentsOpen } from '../src/core/hmi/projects/projects-dashboard-store';
import { useState, useSyncExternalStore } from 'react';
import { RecentDocumentsPopover } from '../src/core/hmi/projects/RecentDocumentsPopover';
import {
  RecentDocumentRow,
  recentKey,
} from '../src/core/hmi/projects/RecentDocumentsSection';
import type { RecentDocumentEntry } from '../src/core/project/rv-project-recents';

function entry(
  id: string,
  name = id,
  over: Partial<RecentDocumentEntry> = {},
): RecentDocumentEntry {
  return {
    projectId: 'P', backend: 'folder',
    documentId: id, documentName: name, projectName: 'Project',
    documentPath: `models/${id}.glb`,
    mode: 'hmi', openedAt: '2026-09-12T10:00:00.000Z',
    ...over,
  };
}

const ENTRIES = [entry('a', 'Alpha'), entry('b', 'Beta'), entry('c', 'Gamma')];
const modeLabel = (m: string) => (m === 'hmi' ? 'HMI' : undefined);

function open(over: {
  entries?: readonly RecentDocumentEntry[];
  busy?: boolean;
  onOpen?: (e: RecentDocumentEntry) => void;
  onClose?: () => void;
} = {}) {
  return render(
    <RecentDocumentsPopover
      open
      entries={over.entries ?? ENTRIES}
      rowStates={new Map()}
      modeLabel={modeLabel}
      busy={over.busy ?? false}
      onOpen={over.onOpen ?? (() => {})}
      onClose={over.onClose ?? (() => {})}
    />,
  );
}

/**
 * The combobox input (plan-507). Keyboard and `aria-activedescendant` live on
 * it now — the listbox never takes the DOM focus.
 */
function combobox(): HTMLInputElement {
  return screen.getByRole('combobox') as HTMLInputElement;
}

/** The id `aria-activedescendant` should be pointing at. */
function selected(): string | null {
  return combobox().getAttribute('aria-activedescendant');
}

function press(key: string, init: Record<string, unknown> = {}) {
  fireEvent.keyDown(combobox(), { key, ...init });
}

function type(value: string) {
  fireEvent.change(combobox(), { target: { value } });
}

afterEach(cleanup);

describe('rendering', () => {
  it('shows the same rows the dashboard section shows', () => {
    open();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByTestId('recent-mode-a').textContent).toBe('HMI');
  });

  it('is a listbox, so a screen reader announces a selection and not a dialog', () => {
    open();
    const box = screen.getByTestId('recent-documents-popover');
    expect(box.getAttribute('role')).toBe('listbox');
    expect(box.getAttribute('aria-label')).toBe('Recently opened documents');
  });

  it('renders nothing at all while closed', () => {
    render(
      <RecentDocumentsPopover
        open={false}
        entries={ENTRIES}
        rowStates={new Map()}
        modeLabel={modeLabel}
        busy={false}
        onOpen={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('recent-documents-popover')).toBeNull();
  });

  it('says so when there is nothing to offer', () => {
    open({ entries: [] });
    expect(screen.getByText('Nothing opened yet.')).toBeTruthy();
  });
});

describe('keyboard navigation', () => {
  it('starts on the most recent entry', () => {
    open();
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[0])}`);
  });

  it('ArrowDown / ArrowUp move the selection', () => {
    open();
    press('ArrowDown');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[1])}`);
    press('ArrowDown');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[2])}`);
    press('ArrowUp');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[1])}`);
  });

  it('clamps at both ends rather than wrapping', () => {
    open();
    press('ArrowUp');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[0])}`);
    for (let i = 0; i < 6; i++) press('ArrowDown');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[2])}`);
  });

  it('Home and End jump', () => {
    open();
    press('End');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[2])}`);
    press('Home');
    expect(selected()).toBe(`recent-option-${recentKey(ENTRIES[0])}`);
  });

  it('marks the selected row with aria-selected, and only that one', () => {
    open();
    press('ArrowDown');
    const options = screen.getAllByRole('option');
    expect(options.map(o => o.getAttribute('aria-selected')))
      .toEqual(['false', 'true', 'false']);
  });
});

describe('choosing an entry', () => {
  it('Enter opens the selected one and closes first', () => {
    const order: string[] = [];
    open({
      onOpen: (e) => order.push(`open:${e.documentId}`),
      onClose: () => order.push('close'),
    });
    press('ArrowDown');
    press('Enter');
    // Closed BEFORE the chain runs: the target mode may unmount the host this
    // popover lives in, and a popover still open then never returns focus.
    expect(order).toEqual(['close', 'open:b']);
  });

  it('a click opens the clicked row, not the selected one', () => {
    const onOpen = vi.fn();
    open({ onOpen });
    fireEvent.click(screen.getByText('Gamma'));
    expect(onOpen.mock.calls[0][0].documentId).toBe('c');
  });

  it('Enter does nothing while a chain is already running', () => {
    const onOpen = vi.fn();
    open({ busy: true, onOpen });
    press('Enter');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Enter on an empty ring does nothing', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    open({ entries: [], onOpen, onClose });
    press('Enter');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('dismissal and focus', () => {
  it('Escape closes', () => {
    const onClose = vi.fn();
    open({ onClose });
    press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape does not let the dashboard shell close on the same press', () => {
    const onClose = vi.fn();
    const onWindow = vi.fn();
    open({ onClose });
    window.addEventListener('keydown', onWindow);
    try {
      press('Escape');
      // `stopPropagation` — one press dismisses ONE thing.
      expect(onWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('takes the focus on open and hands it back on Escape', async () => {
    // A host that owns the open flag, so the close really unmounts the popover
    // the way the dashboard host does.
    function Harness() {
      const [isOpen, setOpen] = useState(false);
      return (
        <>
          <button data-testid="origin" onClick={() => setOpen(true)}>origin</button>
          <RecentDocumentsPopover
            open={isOpen}
            entries={ENTRIES}
            rowStates={new Map()}
            modeLabel={modeLabel}
            busy={false}
            onOpen={() => {}}
            onClose={() => setOpen(false)}
          />
        </>
      );
    }
    render(<Harness />);
    const origin = screen.getByTestId('origin');
    origin.focus();
    fireEvent.click(origin);

    await new Promise(r => requestAnimationFrame(() => r(null)));
    // The search field, not the listbox (plan-507 combobox).
    const input = combobox();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByTestId('recent-documents-popover')).toBeNull();
    expect(document.activeElement).toBe(origin);
  });
});


// ─── T-UI-3 — the path line, measured (plan-482 §3.1) ────────────────────

/**
 * Grown out of the measurement spike that answered the gate question, now
 * pointed at the PRODUCTION component instead of a hand-built replica.
 *
 * The claim: three spans carrying staggered `flex-shrink` factors 9999 / 100 /
 * 1 give way in the order directory -> project name -> file name, and the file
 * name — the half that actually distinguishes two rows — stays whole longest,
 * including next to the mode chip at the popover's 560px.
 *
 * Everything below reads the REAL Chromium layout: a span is truncated exactly
 * when `scrollWidth > clientWidth`. An earlier draft of this test asserted
 * `width > 0` on the file name, which a file name shrunk to `c…` would have
 * passed — the geometry is asserted, not its presence.
 */
describe('T-UI-3 — the recents path line under pressure', () => {
  const LONG_PATH = 'models/production-line/conveyor-section-3-with-sensors-and-diverter.glb';
  const LONG_PROJECT = 'Werk 4 – Endmontagelinie Nord mit Pufferstrecke und Kommissionierung';
  /** The popover's own width: `min(560px, calc(100vw - 32px))`. */
  const POPOVER_WIDTH = 560;
  /**
   * The grid the monotonicity check walks. Fine-grained below 480px because the
   * thresholds sit close together on this component, but no longer asked to
   * WITNESS each stage: the band between the project name and the file name
   * measures about 7px on this build, and where it falls moves with the host's
   * font metrics, so any fixed grid can step over it and report a simultaneous
   * collapse that did not happen. The stages are found by bisection instead.
   */
  const WIDTHS = [760, 640, POPOVER_WIDTH, 480, 440, 430, 420, 410, 400, 320];

  /** Render one production row inside a container of a fixed width. */
  function rowAt(width: number, over: Partial<RecentDocumentEntry> = {}) {
    const e = entry('long', 'Linie 3 – Endmontage', {
      documentPath: LONG_PATH,
      mode: 'hmi',
      ...over,
    });
    const view = render(
      <div style={{ width: `${width}px`, overflow: 'hidden' }}>
        <RecentDocumentRow
          entry={e}
          state={undefined}
          modeLabel={() => 'EDITOR'}
          busy={false}
          compact
          onOpen={() => {}}
        />
      </div>,
    );
    const line = screen.getByTestId('recent-path-long');
    const file = screen.getByTestId('recent-path-file-long');
    const [project, dir] = [...line.children] as HTMLElement[];
    return { view, line, file, project, dir };
  }

  const clipped = (el: HTMLElement) => el.scrollWidth > el.clientWidth;

  /** A container wide enough that nothing gives way, and one so narrow all three have. */
  const WHOLE_WIDTH = 1000;
  const TIGHT_WIDTH = 200;

  /**
   * The widest container at which `span` is already clipped, by bisection.
   *
   * Not a fixed grid, deliberately. The three thresholds are staggered but the
   * bands between them are narrow — 7px between the project name and the file
   * name on this build — and their exact position rides on the host's font
   * metrics, so a sampled grid can step straight over a band and report a
   * simultaneous collapse that never happened. The documented claim is the
   * ORDER of these thresholds, so the order is what is measured.
   *
   * Bisection is sound here because clipping is monotonic in the container
   * width, which the test below asserts rather than assumes.
   */
  function firstClipWidth(span: 'dir' | 'project' | 'file'): number {
    const clippedAt = (width: number) => {
      const r = rowAt(width);
      const is = clipped(r[span]);
      cleanup();
      return is;
    };
    let whole = WHOLE_WIDTH;
    let narrow = TIGHT_WIDTH;
    while (whole - narrow > 1) {
      const mid = Math.floor((whole + narrow) / 2);
      if (clippedAt(mid)) narrow = mid;
      else whole = mid;
    }
    return narrow;
  }

  /** The three clipping states of one row, at one width. */
  function stateAt(width: number) {
    const r = rowAt(width);
    const m = { width, dir: clipped(r.dir), project: clipped(r.project), file: clipped(r.file) };
    cleanup();
    return m;
  }

  afterEach(cleanup);

  it('gives way in the order directory -> project name -> file name', () => {
    // The bisection's premise: whole at one end, all given way at the other.
    expect(stateAt(WHOLE_WIDTH)).toMatchObject({ dir: false, project: false, file: false });
    expect(stateAt(TIGHT_WIDTH)).toMatchObject({ dir: true, project: true, file: true });

    const dir = firstClipWidth('dir');
    const project = firstClipWidth('project');
    const file = firstClipWidth('file');

    // The directory gives way at the widest container, the file name at the
    // narrowest — the promised order, stated as the order of the thresholds.
    expect(dir).toBeGreaterThan(project);
    expect(project).toBeGreaterThan(file);

    // And each stage is a real band a user can sit in, not a rounding artefact:
    // just inside the first threshold ONLY the directory has given way …
    expect(stateAt(project + 1)).toMatchObject({ dir: true, project: false, file: false });
    // … and just inside the second the project name has joined, file still whole.
    expect(stateAt(file + 1)).toMatchObject({ dir: true, project: true, file: false });

    // Monotonic: once a span clips it stays clipped as the container narrows.
    // This is also what makes the bisection above meaningful.
    const rows = WIDTHS.map(stateAt);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].dir) expect(rows[i].dir).toBe(true);
      if (rows[i - 1].project) expect(rows[i].project).toBe(true);
      if (rows[i - 1].file) expect(rows[i].file).toBe(true);
    }
    // The file name is never the first to go.
    expect(rows.every(r => !r.file || (r.dir && r.project))).toBe(true);
  });

  it('keeps the file name whole and visible at the popover width', () => {
    const r = rowAt(POPOVER_WIDTH);
    // Whole: no ellipsis on this span at all.
    expect(r.file.scrollWidth).toBe(r.file.clientWidth);
    // Visible: its box lies inside the line's box, not past its right edge.
    const box = r.file.getBoundingClientRect();
    const lineBox = r.line.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(Math.round(box.right)).toBeLessThanOrEqual(Math.round(lineBox.right) + 1);
  });

  it('never overflows the line horizontally, at any width', () => {
    for (const width of WIDTHS) {
      const r = rowAt(width);
      expect(r.line.scrollWidth).toBeLessThanOrEqual(r.line.clientWidth);
      cleanup();
    }
  });

  it('holds the row height constant — a long path never wraps', () => {
    const short = rowAt(POPOVER_WIDTH, { documentPath: 'a.glb' });
    const shortHeight = short.line.getBoundingClientRect().height;
    cleanup();
    const long = rowAt(POPOVER_WIDTH);
    expect(long.line.getBoundingClientRect().height).toBe(shortHeight);
  });

  it('a very long project name still does not overflow the line', () => {
    const r = rowAt(480, { projectName: LONG_PROJECT });
    expect(clipped(r.project)).toBe(true);
    expect(r.line.scrollWidth).toBeLessThanOrEqual(r.line.clientWidth);
  });

  it('a path without a slash is the file span alone', () => {
    const r = rowAt(320, { documentPath: 'line3.glb' });
    expect(r.dir.textContent).toBe('');
    expect(r.file.textContent).toBe('line3.glb');
    expect(r.line.scrollWidth).toBeLessThanOrEqual(r.line.clientWidth);
  });

  it('the popover shows the same path line the dashboard does', () => {
    open({ entries: [entry('a', 'Alpha', { documentPath: LONG_PATH })] });
    expect(screen.getByTestId('recent-path-a').textContent).toContain(LONG_PATH);
    expect(screen.getByTestId('recent-path-file-a').textContent)
      .toBe('conveyor-section-3-with-sensors-and-diverter.glb');
  });
});


describe('side flyout dismissal', () => {
  it('dismisses on an outside pointer click', () => {
    const onClose = vi.fn();
    open({ onClose });
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open while pinned, including after choosing a document', () => {
    const onClose = vi.fn();
    const onOpen = vi.fn();
    open({ onClose, onOpen });
    fireEvent.click(screen.getByRole('button', { name: 'Pin recently opened' }));
    fireEvent.pointerDown(document.body);
    fireEvent.click(screen.getByText('Alpha'));
    expect(onOpen).toHaveBeenCalledWith(ENTRIES[0]);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('returns to click-away dismissal after unpinning', () => {
    const onClose = vi.fn();
    open({ onClose });
    const pin = screen.getByRole('button', { name: 'Pin recently opened' });
    fireEvent.click(pin);
    fireEvent.click(pin);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});


describe('Projects folder hover', () => {
  afterEach(() => { setRecentDocumentsOpen(false); closeProjectsDashboard(); vi.useRealTimers(); });

  it('allows moving from the folder into the flyout before dismissing', () => {
    vi.useFakeTimers();
    openRecentDocumentsOnHover();
    expect(getRecentDocumentsOpen()).toBe(true);
    scheduleRecentDocumentsClose();
    vi.advanceTimersByTime(400);
    expect(getRecentDocumentsOpen()).toBe(true);
    cancelRecentDocumentsClose();
    vi.advanceTimersByTime(1000);
    expect(getRecentDocumentsOpen()).toBe(true);
    scheduleRecentDocumentsClose();
    vi.advanceTimersByTime(800);
    expect(getRecentDocumentsOpen()).toBe(false);
  });

  it('does not time out while pinned', () => {
    vi.useFakeTimers();
    openRecentDocumentsOnHover();
    setRecentDocumentsPinned(true);
    scheduleRecentDocumentsClose();
    vi.advanceTimersByTime(5000);
    expect(getRecentDocumentsOpen()).toBe(true);
  });

  it('closes a pinned flyout when Projects opens, and a hover reopens it over the open dashboard', () => {
    openRecentDocumentsOnHover();
    setRecentDocumentsPinned(true);
    expect(getRecentDocumentsOpen()).toBe(true);
    openProjectsDashboard();
    expect(getRecentDocumentsOpen()).toBe(false);
    openRecentDocumentsOnHover();
    expect(getRecentDocumentsOpen()).toBe(true);
    setRecentDocumentsOpen(false);
    closeProjectsDashboard();
    openRecentDocumentsOnHover();
    expect(getRecentDocumentsOpen()).toBe(true);
  });

  it('does not steal keyboard focus when opened by hover', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    render(<RecentDocumentsPopover open autoFocus={false} entries={ENTRIES}
      rowStates={new Map()} modeLabel={modeLabel} busy={false} onOpen={() => {}} onClose={() => {}} />);
    await new Promise(requestAnimationFrame);
    expect(document.activeElement).toBe(button);
    button.remove();
  });
});


// ─── plan-507 §9.3 — type-ahead ──────────────────────────────────────────

const TYPEAHEAD = [
  entry('p', 'Pipeline', { documentPath: 'models/pipeline.glb' }),
  entry('l1', 'line3', { documentPath: 'models/lines/line3.glb' }),
  entry('o', 'Other', { documentPath: 'old/other.glb' }),
  entry('l2', 'line3-old', { documentPath: 'old/lines/line3-old.glb' }),
  entry('l3', 'Line demo', { documentPath: 'demo/line-demo.glb' }),
];
const optionId = (e: RecentDocumentEntry) => `recent-option-${recentKey(e)}`;
const visibleRows = () => screen.queryAllByRole('option').map(o => o.getAttribute('data-testid'));

describe('type-ahead (plan-507)', () => {
  it('filters to matching rows and puts the cursor on the best one', () => {
    open({ entries: TYPEAHEAD });
    type('line');
    // "Other" never matches; the word-start hits rank above the mid-word "Pipeline".
    expect(visibleRows()).not.toContain('recent-row-o');
    expect(visibleRows()[visibleRows().length - 1]).toBe('recent-row-p');
    expect(selected()).toBe(optionId(TYPEAHEAD[1]));
  });

  it('marks the matched part of the name', () => {
    open({ entries: TYPEAHEAD });
    type('line');
    const row = screen.getByTestId('recent-row-l1');
    expect(row.querySelector('mark')?.textContent).toBe('line');
  });

  it('resets the cursor when the term changes, clamps when only the ring does', () => {
    const view = open({ entries: TYPEAHEAD });
    type('l');
    press('ArrowDown'); press('ArrowDown'); press('ArrowDown');
    const ranked = screen.getAllByRole('option');
    expect(ranked.length).toBeGreaterThanOrEqual(4);
    expect(selected()).toBe(ranked[3].id);
    type('li');
    expect(selected()).toBe(screen.getAllByRole('option')[0].id);
    // Same term, the ring shrinks under the cursor: clamp, not reset.
    press('End');
    const before = screen.getAllByRole('option');
    expect(selected()).toBe(before[before.length - 1].id);
    view.rerender(
      <RecentDocumentsPopover open entries={TYPEAHEAD.slice(0, 4)} rowStates={new Map()}
        modeLabel={modeLabel} busy={false} onOpen={() => {}} onClose={() => {}} />,
    );
    const after = screen.getAllByRole('option');
    expect(selected()).toBe(after[after.length - 1].id);
  });

  it('a trailing space keeps the cursor where it is', () => {
    open({ entries: TYPEAHEAD });
    type('line');
    press('ArrowDown');
    const at = selected();
    type('line ');
    expect(selected()).toBe(at);
  });

  it('ArrowDown + Enter opens the second filtered hit', () => {
    const onOpen = vi.fn();
    open({ entries: TYPEAHEAD, onOpen });
    type('line');
    const second = screen.getAllByRole('option')[1].getAttribute('data-testid')!.replace('recent-row-', '');
    press('ArrowDown');
    press('Enter');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].documentId).toBe(second);
  });

  it('an Enter that commits an IME composition opens nothing', () => {
    const onOpen = vi.fn();
    open({ entries: TYPEAHEAD, onOpen });
    type('line');
    press('Enter', { isComposing: true });
    press('Enter', { keyCode: 229 });
    expect(onOpen).not.toHaveBeenCalled();
    press('Enter');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says "Nothing matches" and Enter does nothing', () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    open({ entries: TYPEAHEAD, onOpen, onClose });
    type('zzz');
    expect(screen.getByText('Nothing matches')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(selected()).toBeNull();
    press('Enter');
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape with a typed term closes and hands the focus back; reopening starts empty', async () => {
    function Harness() {
      const [isOpen, setOpen] = useState(false);
      return (
        <>
          <button data-testid="origin" onClick={() => setOpen(true)}>origin</button>
          <RecentDocumentsPopover open={isOpen} entries={TYPEAHEAD} rowStates={new Map()}
            modeLabel={modeLabel} busy={false} onOpen={() => {}} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Harness />);
    const origin = screen.getByTestId('origin');
    origin.focus();
    fireEvent.click(origin);
    await new Promise(r => requestAnimationFrame(() => r(null)));
    type('line');
    press('Escape');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.activeElement).toBe(origin);
    fireEvent.click(origin);
    expect(combobox().value).toBe('');
    expect(screen.getAllByRole('option')).toHaveLength(TYPEAHEAD.length);
  });

  it('ARIA: named input, activedescendant is a real option inside the controlled listbox', () => {
    open({ entries: TYPEAHEAD });
    const input = combobox();
    expect(input.getAttribute('aria-label')).toBe('Search recently opened');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    type('line');
    press('ArrowDown');
    const option = document.getElementById(input.getAttribute('aria-activedescendant')!)!;
    expect(option.getAttribute('role')).toBe('option');
    const listbox = document.getElementById(input.getAttribute('aria-controls')!)!;
    expect(listbox.getAttribute('role')).toBe('listbox');
    expect(listbox.getAttribute('data-testid')).toBe('recent-documents-popover');
    expect(listbox.contains(option)).toBe(true);
  });
});

// ─── plan-507 SOL-3 — a hover-opened flyout keeps its focused search ─────

describe('hover-opened flyout with the focus inside (plan-507)', () => {
  /** The popover bound to the store, the way the host binds it. */
  function Bound() {
    const isOpen = useSyncExternalStore(subscribeRecentDocumentsOpen, getRecentDocumentsOpen);
    return (
      <RecentDocumentsPopover open={isOpen} autoFocus={false} entries={TYPEAHEAD} rowStates={new Map()}
        modeLabel={modeLabel} busy={false} onOpen={() => {}} onClose={() => setRecentDocumentsOpen(false)} />
    );
  }
  let outside: HTMLButtonElement;

  afterEach(() => {
    act(() => { setRecentDocumentsOpen(false); });
    closeProjectsDashboard();
    vi.useRealTimers();
    outside?.remove();
  });

  function setup() {
    outside = document.createElement('button');
    document.body.appendChild(outside);
    render(<Bound />);
    vi.useFakeTimers();
    act(() => { openRecentDocumentsOnHover(); });
    return document.getElementById('recent-documents-flyout')!;
  }

  it('stays open while the search field has the focus, closes once the focus leaves', () => {
    const panel = setup();
    act(() => { combobox().focus(); });
    fireEvent.mouseLeave(panel);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getRecentDocumentsOpen()).toBe(true);
    // The focus moves to an element outside the panel.
    act(() => { outside.focus(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getRecentDocumentsOpen()).toBe(false);
  });

  it('a blur to nowhere (relatedTarget null) counts as leaving', () => {
    const panel = setup();
    act(() => { combobox().focus(); });
    fireEvent.mouseLeave(panel);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getRecentDocumentsOpen()).toBe(true);
    act(() => { combobox().blur(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getRecentDocumentsOpen()).toBe(false);
  });

  it('closing clears the flag, so the next hover open times out again', () => {
    setup();
    act(() => { combobox().focus(); });
    act(() => { press('Escape'); });
    expect(getRecentDocumentsOpen()).toBe(false);
    act(() => { openRecentDocumentsOnHover(); });
    expect(getRecentDocumentsOpen()).toBe(true);
    fireEvent.mouseLeave(document.getElementById('recent-documents-flyout')!);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(getRecentDocumentsOpen()).toBe(false);
  });
});
