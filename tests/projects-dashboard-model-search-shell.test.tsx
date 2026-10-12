// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-509 §9.8 — the shell's search field on the Projects screen: its
 * placeholder, the `/` / Ctrl+K shortcut through the host's second hook, the
 * activation condition as a pure function, and Escape (clear first, close
 * only when empty).
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../src/hooks/use-viewport-insets', () => ({
  useViewportInsets: () => ({ left: 0, right: 0, top: 0 }),
}));
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectsDashboard } from '../src/core/hmi/projects/ProjectsDashboard';
import {
  projectsScreenActive, useDashboardSearchShortcut,
} from '../src/core/hmi/projects/dashboard-search-shortcut';
import {
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  resetProjectsDashboardForTests,
  setProjectsSearch,
} from '../src/core/hmi/projects/projects-dashboard-store';

beforeEach(() => resetProjectsDashboardForTests());
afterEach(() => cleanup());

/** The Projects screen as the host wires it: shell field + its own shortcut hook. */
function ProjectsScreen({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useDashboardSearchShortcut(ref, active);
  return (
    <ProjectsDashboard title="Projects" showSearch searchPlaceholder="Search documents…" searchInputRef={ref}>
      <div data-testid="body">body</div>
    </ProjectsDashboard>
  );
}

function field(): HTMLInputElement {
  return screen.getByPlaceholderText('Search documents…') as HTMLInputElement;
}

describe('Projects screen search field', () => {
  it('renders with the "Search documents…" placeholder and hands out its input', () => {
    openProjectsDashboard();
    render(<ProjectsScreen />);
    expect(field().tagName).toBe('INPUT');
  });

  it('keeps the default placeholder for other callers', () => {
    openProjectsDashboard();
    render(<ProjectsDashboard title="Projects"><div /></ProjectsDashboard>);
    expect(screen.getByPlaceholderText('Search…')).toBeTruthy();
  });

  it('`/` and Ctrl/Cmd+K focus the field when the shortcut is active', () => {
    openProjectsDashboard();
    render(<ProjectsScreen />);
    expect(document.activeElement).not.toBe(field());
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(field());
    field().blur();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(field());
    field().blur();
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(field());
  });

  it('does nothing when the shortcut is inactive', () => {
    openProjectsDashboard();
    render(<ProjectsScreen active={false} />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).not.toBe(field());
  });

  it('Escape with a term clears it and does NOT close the dashboard', () => {
    openProjectsDashboard();
    setProjectsSearch('conveyor');
    render(<ProjectsScreen />);
    expect(field().value).toBe('conveyor');
    field().focus();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(getProjectsDashboardSnapshot().search).toBe('');
    expect(getProjectsDashboardSnapshot().open).toBe(true);
    expect(field().value).toBe('');
  });

  it('Escape in an empty field closes the dashboard as before', () => {
    openProjectsDashboard();
    render(<ProjectsScreen />);
    field().focus();
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(getProjectsDashboardSnapshot().open).toBe(false);
  });
});

describe('projectsScreenActive', () => {
  it('is true on the first open without a project, where view still says "project"', () => {
    expect(projectsScreenActive({ open: true, view: 'project' }, false)).toBe(true);
  });
  it('is true on the project list', () => {
    expect(projectsScreenActive({ open: true, view: 'projects' }, true)).toBe(true);
    expect(projectsScreenActive({ open: true, view: 'projects' }, false)).toBe(true);
  });
  it('is false on the project screen and while closed', () => {
    expect(projectsScreenActive({ open: true, view: 'project' }, true)).toBe(false);
    expect(projectsScreenActive({ open: false, view: 'projects' }, false)).toBe(false);
  });
});
