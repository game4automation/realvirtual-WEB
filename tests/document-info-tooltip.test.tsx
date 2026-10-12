// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.7 — DocumentInfoTooltip: nothing without a block, nothing
 * mounted before a hover, the preview after it, and the touch row instead of
 * a tooltip on a coarse pointer (F6, F7, F10).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import { DocumentInfoTooltip } from '../src/core/hmi/projects/DocumentInfoTooltip';
import type { DocumentInfo } from '../src/core/project/rv-document-info';

const INFO: DocumentInfo = {
  v: 1,
  summary: 'Hydraulic press 400 t',
  description: '# P400\n\nThe cell consists of **press**, belt and unloader.\n\nSecond paragraph.',
};

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

afterEach(() => { cleanup(); });

describe('plan-506 §9.7 — DocumentInfoTooltip', () => {
  it('without a block the child is the only element — no wrapper, no popper', () => {
    const { container } = render(
      <DocumentInfoTooltip info={null} touch={false}>
        <div data-testid="row">Press.glb</div>
      </DocumentInfoTooltip>,
    );
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(screen.getByTestId('row'));
    expect(container.firstElementChild!.children).toHaveLength(0);
  });

  it('an empty block counts as no block', () => {
    const { container } = render(
      <DocumentInfoTooltip info={{ v: 1, description: '   ' }} touch={false}>
        <div data-testid="row">Press.glb</div>
      </DocumentInfoTooltip>,
    );
    expect(container.firstElementChild).toBe(screen.getByTestId('row'));
  });

  it('mounts nothing before a hover and the preview after the enter delay', async () => {
    render(
      <DocumentInfoTooltip info={INFO} touch={false}>
        <div data-testid="row">Press.glb</div>
      </DocumentInfoTooltip>,
    );
    expect(screen.queryByText('Hydraulic press 400 t')).toBeNull();
    expect(screen.queryByTestId('document-info-tooltip')).toBeNull();

    fireEvent.mouseOver(screen.getByTestId('row'));
    // Inside the enter delay: still nothing.
    await act(async () => { await wait(150); });
    expect(screen.queryByTestId('document-info-tooltip')).toBeNull();

    await waitFor(() => expect(screen.getByTestId('document-info-tooltip')).toBeTruthy(), { timeout: 2000 });
    expect(screen.getByText('Hydraulic press 400 t')).toBeTruthy();
    // First paragraph as plain text — heading dropped, Markdown stripped.
    expect(screen.getByText('The cell consists of press, belt and unloader.')).toBeTruthy();
    expect(screen.queryByText('Second paragraph.')).toBeNull();
  });

  it('a long list carries no tooltip content until one row is hovered', () => {
    render(
      <div>
        {Array.from({ length: 50 }, (_, i) => (
          <DocumentInfoTooltip key={i} info={INFO} touch={false}>
            <div data-testid={`row-${i}`}>Row {i}</div>
          </DocumentInfoTooltip>
        ))}
      </div>,
    );
    expect(document.querySelectorAll('[data-testid="document-info-tooltip"]')).toHaveLength(0);
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(0);
  });

  it('touch renders the chevron row instead of a tooltip, and expands on click', async () => {
    render(
      <DocumentInfoTooltip info={INFO} touch>
        <div data-testid="row">Press.glb</div>
      </DocumentInfoTooltip>,
    );
    expect(screen.getByTestId('document-info-expand-row')).toBeTruthy();
    expect(screen.queryByText('Hydraulic press 400 t')).toBeNull();

    fireEvent.mouseOver(screen.getByTestId('row'));
    await act(async () => { await wait(600); });
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show description' }));
    expect(screen.getByText('Hydraulic press 400 t')).toBeTruthy();
    expect(screen.getByText('The cell consists of press, belt and unloader.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide description' }));
    expect(screen.queryByText('Hydraulic press 400 t')).toBeNull();
  });

  it('touch without a block adds no chevron', () => {
    render(
      <DocumentInfoTooltip info={undefined} touch>
        <div data-testid="row">Press.glb</div>
      </DocumentInfoTooltip>,
    );
    expect(screen.queryByTestId('document-info-expand-row')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
