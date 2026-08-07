// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDashboard shell — the accessibility and dismissal contracts
 * (plan-372 §3.1/§3.4, Phase 7).
 *
 * Two of these are explicit plan requirements that are easy to "fix" wrongly
 * later: the overlay is announced as a region and NOT a dialog, and it does
 * NOT trap focus. Both exist so the mobile ActivityBar pill above it stays
 * reachable — a focus trap would leave a phone user with no way out.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// The shell reads viewport insets, which needs a live viewer context. The
// insets are layout, not behaviour, so a fixed stub keeps these tests about
// the accessibility and dismissal contracts.
vi.mock('../src/hooks/use-viewport-insets', () => ({
  useViewportInsets: () => ({ left: 0, right: 0, top: 0 }),
}));
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ProjectsDashboard } from '../src/core/hmi/projects/ProjectsDashboard';
import {
  getProjectsDashboardSnapshot,
  openProjectsDashboard,
  resetProjectsDashboardForTests,
} from '../src/core/hmi/projects/projects-dashboard-store';

beforeEach(() => resetProjectsDashboardForTests());
afterEach(() => cleanup());

function renderShell(props: { onBack?: () => void } = {}) {
  return render(
    <ProjectsDashboard title="Projects" {...props}>
      <div data-testid="body">body</div>
    </ProjectsDashboard>,
  );
}

describe('ProjectsDashboard shell', () => {
  it('renders nothing while the store says closed', () => {
    renderShell();
    expect(screen.queryByTestId('body')).toBeNull();
  });

  it('renders its body and title once opened', () => {
    openProjectsDashboard();
    renderShell();
    expect(screen.getByTestId('body')).toBeTruthy();
    expect(screen.getByText('Projects')).toBeTruthy();
  });

  it('offers the back arrow only when a caller supplies onBack', () => {
    openProjectsDashboard();
    const { unmount } = renderShell();
    // The list screen is the top of the drill-down: no way up, so no arrow.
    expect(screen.queryByLabelText('Back to projects')).toBeNull();
    unmount();

    const onBack = vi.fn();
    renderShell({ onBack });
    fireEvent.click(screen.getByLabelText('Back to projects'));
    expect(onBack).toHaveBeenCalledTimes(1);
    // Going up a level must not also dismiss the dashboard.
    expect(getProjectsDashboardSnapshot().open).toBe(true);
  });

  it('is announced as a labelled region, not a dialog', () => {
    openProjectsDashboard();
    renderShell();
    expect(screen.getByRole('region', { name: 'Projects' })).toBeTruthy();
    // A dialog role would imply a focus trap and an inert background; neither
    // is true here and both would strand a mobile user (§3.1).
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape', () => {
    openProjectsDashboard();
    renderShell();
    expect(getProjectsDashboardSnapshot().open).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(getProjectsDashboardSnapshot().open).toBe(false);
  });

  it('closes via the explicit close button', () => {
    openProjectsDashboard();
    renderShell();
    fireEvent.click(screen.getByLabelText('Close Projects'));
    expect(getProjectsDashboardSnapshot().open).toBe(false);
  });

  it('removes its key listener on unmount', () => {
    openProjectsDashboard();
    const { unmount } = renderShell();
    unmount();
    // Re-open, then fire Escape: with a leaked listener from the unmounted
    // tree this would still be handled and close the freshly opened overlay.
    openProjectsDashboard();
    expect(getProjectsDashboardSnapshot().open).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(getProjectsDashboardSnapshot().open).toBe(true);
  });
});
