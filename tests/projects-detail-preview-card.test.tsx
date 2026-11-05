// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The detail pane's preview card: the document's facts as chips on its corners
 * (type, age, size), the open-mode chip that changes the mode, and the subtitle
 * that says where the document lives.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectsDetailPane } from '../src/core/hmi/projects/ProjectsDetailPane';
import { DocumentModeMenuChip } from '../src/core/hmi/projects/DocumentModeMenuChip';
import { documentSubtitle } from '../src/core/hmi/projects/dashboard-documents';

afterEach(cleanup);

const MODES = [
  { id: 'hmi', label: 'HMI' },
  { id: 'planner', label: 'Planner' },
  { id: 'editor', label: 'Editor' },
];

describe('preview card: mode on the card, facts in a row below', () => {
  it('shows type, relative age (exact date on hover) and size in one row under the card', () => {
    const modified = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    render(
      <ProjectsDetailPane
        title="sidecutter"
        previewPlaceholder
        previewInfo={{ type: 'GLB', modified, size: '6.0 MB' }}
      />,
    );
    expect(screen.getByTestId('projects-detail-chip-type')).toHaveTextContent('GLB');
    const age = screen.getByTestId('projects-detail-chip-modified');
    expect(age).toHaveTextContent('3 days ago');
    expect(age.getAttribute('title')).toMatch(/^Modified /);
    expect(screen.getByTestId('projects-detail-chip-size')).toHaveTextContent('6.0 MB');
    // One row UNDER the card, not on it.
    const row = screen.getByTestId('projects-detail-info-row');
    expect(row).toContainElement(age);
    expect(screen.getByTestId('projects-detail-preview')).not.toContainElement(row);
    // The facts are chips now, not field rows.
    expect(screen.queryByText('Size')).toBeNull();
    expect(screen.queryByText('Modified')).toBeNull();
  });

  it('puts the mode control on the card and draws no chip for a missing fact', () => {
    render(
      <ProjectsDetailPane
        title="sidecutter"
        previewPlaceholder
        previewInfo={{ type: 'GLB' }}
        previewModeControl={<span data-testid="mode-slot">Planner</span>}
      />,
    );
    expect(screen.getByTestId('projects-detail-preview')).toContainElement(screen.getByTestId('mode-slot'));
    expect(screen.queryByTestId('projects-detail-chip-size')).toBeNull();
    expect(screen.queryByTestId('projects-detail-chip-modified')).toBeNull();
  });
});

describe('DocumentModeMenuChip', () => {
  it('names the current mode, lists every mode with the current one checked, and reports a pick', () => {
    const onChange = vi.fn();
    render(<DocumentModeMenuChip value="planner" options={MODES} onChange={onChange} />);
    const chip = screen.getByTestId('document-mode-menu-chip');
    expect(chip).toHaveTextContent('Planner');
    fireEvent.click(chip);
    const items = screen.getAllByRole('menuitem');
    expect(items.map(i => i.textContent)).toEqual(['HMI', 'Planner', 'Editor']);
    expect(items[1].classList.contains('Mui-selected')).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Editor' }));
    expect(onChange).toHaveBeenCalledWith('editor');
  });

  it('picking the current mode again changes nothing', () => {
    const onChange = vi.fn();
    render(<DocumentModeMenuChip value="hmi" options={MODES} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('document-mode-menu-chip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'HMI' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('says "Mode" when the document names none', () => {
    render(<DocumentModeMenuChip value={null} options={MODES} onChange={() => {}} />);
    expect(screen.getByTestId('document-mode-menu-chip')).toHaveTextContent('Mode');
  });
});

describe('documentSubtitle', () => {
  it('joins the folder and read-only, and is null when neither applies', () => {
    expect(documentSubtitle({ path: 'models/sidecutter.glb' }, false)).toBe('models/');
    expect(documentSubtitle({ path: 'models/sidecutter.glb' }, true)).toBe('models/ · Read-only');
    expect(documentSubtitle({ path: 'root.glb' }, true)).toBe('Read-only');
    expect(documentSubtitle({ path: 'root.glb' }, false)).toBeNull();
  });
});
