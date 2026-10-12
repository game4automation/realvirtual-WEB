// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.6 — the Projects screen's model hit list: group headers,
 * breadcrumbs, highlight, keyboard (arrows move focus, Enter opens), the lock
 * in a group header, the "N more" line and the F11 empty state.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModelSearchResults } from '../src/core/hmi/projects/ModelSearchResults';
import {
  buildModelSearchIndex, capModelSearch, searchModelIndex, type ModelSearchProject,
} from '../src/core/project/rv-model-search';
import {
  MODEL_INDEX_SCHEMA_VERSION, type ModelIndexBackend, type ModelIndexDoc, type ModelIndexSnapshot,
} from '../src/core/project/rv-model-index';

afterEach(() => cleanup());

function snap(projectId: string, docs: ModelIndexDoc[], backend: ModelIndexBackend = 'folder'): ModelIndexSnapshot {
  return { version: MODEL_INDEX_SCHEMA_VERSION, projectId, projectName: projectId, backend, updatedAt: '', docs };
}
const doc = (id: string, name: string, path: string, tags: string[] = []): ModelIndexDoc =>
  ({ id, name, path, tags });

const PROJECTS: ModelSearchProject[] = [
  { key: 'bundled:prj_sample', name: 'DemoRealvirtual' },
  { key: 'folder:mauser', name: 'Mauser 3D HMI' },
];
const SNAPS = [
  snap('mauser', [
    doc('m1', 'Conveyor Station 3', 'models/hall-b/conveyors/station3.glb', ['line']),
    doc('m2', 'Robot Cell', 'library/robot.glb', ['conveyor']),
  ]),
  snap('prj_sample', [doc('s1', 'Conveyor_Line', 'models/lines/conveyor.glb')], 'bundled'),
];

function result(term: string) {
  return capModelSearch(searchModelIndex(buildModelSearchIndex(SNAPS, PROJECTS), term));
}

describe('ModelSearchResults', () => {
  it('renders group headers in list order, breadcrumbs and highlighted names', () => {
    render(<ModelSearchResults result={result('conveyor')} onActivate={() => {}} />);
    const groups = screen.getAllByRole('group');
    expect(groups.map(g => g.getAttribute('aria-label'))).toEqual(['DemoRealvirtual', 'Mauser 3D HMI']);
    const station = screen.getByText((_, el) => el?.getAttribute('data-model-hit') === 'folder:mauser/m1');
    expect(within(station).getByText('models / hall-b / conveyors')).toBeTruthy();
    const marks = station.querySelectorAll('mark');
    expect([...marks].map(m => m.textContent)).toEqual(['Conveyor']);
  });

  it('a tag-only hit shows the matched tag', () => {
    render(<ModelSearchResults result={result('conveyor')} onActivate={() => {}} />);
    const robot = document.querySelector('[data-model-hit="folder:mauser/m2"]') as HTMLElement;
    const tags = robot.querySelector('[data-search-tags]');
    expect(tags?.textContent).toBe('tag: conveyor');
    expect(tags?.querySelector('mark')?.textContent).toBe('conveyor');
  });

  it('arrows only move the focus; Enter activates the focused hit', () => {
    const onActivate = vi.fn();
    render(<ModelSearchResults result={result('conveyor')} onActivate={onActivate} />);
    const rows = screen.getAllByRole('option');
    expect(rows.map(r => r.tabIndex)).toEqual([0, -1, -1]);
    rows[0].focus();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[1]);
    fireEvent.keyDown(rows[1], { key: 'End' });
    expect(document.activeElement).toBe(rows[2]);
    fireEvent.keyDown(rows[2], { key: 'Home' });
    expect(document.activeElement).toBe(rows[0]);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
    fireEvent.keyDown(rows[1], { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0].entry.doc.id).toBe('m1');
  });

  it('double-click opens; a single click does not', () => {
    const onActivate = vi.fn();
    render(<ModelSearchResults result={result('conveyor')} onActivate={onActivate} />);
    const row = screen.getAllByRole('option')[0];
    fireEvent.click(row);
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.doubleClick(row);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('busy makes every row inert', () => {
    const onActivate = vi.fn();
    render(<ModelSearchResults result={result('conveyor')} busy onActivate={onActivate} />);
    const row = screen.getAllByRole('option')[0];
    fireEvent.doubleClick(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('shows the lock in the header of a project that needs a grant', () => {
    render(
      <ModelSearchResults
        result={result('conveyor')}
        stateOf={g => (g.projectId === 'mauser' ? 'needs-grant' : undefined)}
        onActivate={() => {}}
      />,
    );
    expect(screen.getByTestId('model-search-lock-folder:mauser')).toBeTruthy();
    expect(screen.queryByTestId('model-search-lock-bundled:prj_sample')).toBeNull();
  });

  it('touch input gets an explicit Open chevron', () => {
    const onActivate = vi.fn();
    render(<ModelSearchResults result={result('conveyor')} touchInput onActivate={onActivate} />);
    fireEvent.click(screen.getAllByLabelText('Open')[0]);
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('the "N more" line after the cap', () => {
    const many = snap('mauser', Array.from({ length: 205 }, (_, i) => doc(`d${i}`, `Robot ${i}`, `m/d${i}.glb`)));
    const r = capModelSearch(searchModelIndex(buildModelSearchIndex([many], PROJECTS), 'robot'));
    render(<ModelSearchResults result={r} onActivate={() => {}} />);
    expect(screen.getByTestId('model-search-more').textContent).toContain('5 more matches');
  });

  it('empty state: "No documents match", plus the hint when linked projects are unindexed', () => {
    const { unmount } = render(
      <ModelSearchResults result={result('zzz')} unindexedCount={2} onActivate={() => {}} />);
    expect(screen.getByText('No documents match')).toBeTruthy();
    expect(screen.getByTestId('model-search-unindexed-hint').textContent)
      .toContain('Only projects that have been opened once are searched');
    unmount();
    render(<ModelSearchResults result={result('zzz')} unindexedCount={0} onActivate={() => {}} />);
    expect(screen.getByText('No documents match')).toBeTruthy();
    expect(screen.queryByTestId('model-search-unindexed-hint')).toBeNull();
  });
});
