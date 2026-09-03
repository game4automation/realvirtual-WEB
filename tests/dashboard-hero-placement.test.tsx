// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hero band's PLACEMENT in the dashboard (plan-709 F3, test §9.10).
 *
 * §9.3 pins what the card renders; this pins where it hangs, which is a
 * separate promise and the one a later layout change breaks by accident: a full
 * -width section of its own, ABOVE the search bar, with the card centred in it.
 * The order is the argument — the first thing the dashboard shows should be the
 * document you are working on, not the list of everything you are not.
 *
 * Follows `projects-dashboard-shell.test.tsx`: the shell is rendered directly
 * with the real hero section in its slot, so no project store is needed.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../src/hooks/use-viewport-insets', () => ({
  useViewportInsets: () => ({ left: 0, right: 0, top: 0 }),
}));
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ProjectsDashboard } from '../src/core/hmi/projects/ProjectsDashboard';
import { DocumentHeroSection } from '../src/core/hmi/projects/DocumentHeroSection';
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

function makeView(name = 'Conveyor'): ActiveDocumentView {
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

function renderDashboard(onReveal?: () => void) {
  return render(
    <ProjectsDashboard title="Projects" hero={<DocumentHeroSection onReveal={onReveal} />}>
      <div data-testid="body">body</div>
    </ProjectsDashboard>,
  );
}

beforeEach(() => {
  resetProjectsDashboardForTests();
  openProjectsDashboard();
});

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
});

describe('dashboard hero placement', () => {
  it('sits ABOVE the search bar in the document order', () => {
    setActiveDocumentView(makeView());
    renderDashboard();

    const hero = screen.getByTestId('document-hero');
    const search = screen.getByPlaceholderText('Search…');
    // DOCUMENT_POSITION_FOLLOWING on the search field means the hero comes
    // first — the assertion is about reading order, not about pixels.
    expect(hero.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('spans the full width and centres the card', () => {
    setActiveDocumentView(makeView());
    renderDashboard();
    const style = getComputedStyle(screen.getByTestId('document-hero'));
    expect(style.justifyContent).toBe('center');
    // A band, not a column beside something: it owns the whole row. The hero
    // sits inside its translucent band wrapper, which sits on the region.
    expect(screen.getByTestId('document-hero').parentElement?.parentElement)
      .toBe(screen.getByRole('region', { name: 'Projects' }));
  });

  it('renders the card in its hero size', () => {
    setActiveDocumentView(makeView());
    renderDashboard();
    expect(screen.getByTestId('document-card').dataset.variant).toBe('hero');
  });

  it('shows the empty state — and keeps the band — with nothing open', () => {
    renderDashboard();
    expect(screen.getByTestId('document-hero')).toBeTruthy();
    expect(screen.queryByTestId('document-card')).toBeNull();
    expect(screen.getByTestId('document-hero-empty').textContent)
      .toContain('double-click an asset');
  });

  it('clicking the card asks the dashboard to reveal the asset', () => {
    // The hero dropped its preview picture (2026-09-02); the whole card is
    // the one navigation target now.
    const onReveal = vi.fn();
    setActiveDocumentView(makeView());
    renderDashboard(onReveal);
    fireEvent.click(screen.getByTestId('document-card'));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});
