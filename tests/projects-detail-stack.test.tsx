// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Multi-select in the project dashboard: the detail pane shows several selected
 * documents as a stack of placeholder cards with their names, instead of a
 * preview image, and its actions are the ones the caller passes for all of them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProjectsDetailPane } from '../src/core/hmi/projects/ProjectsDetailPane';

afterEach(cleanup);

describe('detail pane — multi-selection stack', () => {
  it('draws the stack with the count and every name, and no preview image', () => {
    const { container } = render(
      <ProjectsDetailPane
        title="3 documents"
        thumbnailUrl="blob:ignored"
        stack={{ names: ['Belt', 'Robot cell', 'Turntable'] }}
      />,
    );
    const stack = screen.getByTestId('projects-detail-stack');
    expect(stack).toHaveTextContent('3');
    for (const name of ['Belt', 'Robot cell', 'Turntable']) expect(stack).toHaveTextContent(name);
    expect(container.querySelector('img')).toBeNull();
  });

  it('lists six names and folds the rest into "+N more"', () => {
    const names = Array.from({ length: 9 }, (_, i) => `Doc ${i + 1}`);
    render(<ProjectsDetailPane title="9 documents" stack={{ names }} />);
    const stack = screen.getByTestId('projects-detail-stack');
    expect(stack).toHaveTextContent('Doc 6');
    expect(stack).not.toHaveTextContent('Doc 7');
    expect(stack).toHaveTextContent('+3 more');
  });

  it('a document without a picture gets the "No preview" tile, one with a picture does not', () => {
    const view = render(<ProjectsDetailPane title="Belt" previewPlaceholder />);
    expect(screen.getByTestId('projects-detail-no-preview')).toHaveTextContent('No preview');
    view.rerender(<ProjectsDetailPane title="Belt" previewPlaceholder thumbnailUrl="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />);
    expect(screen.queryByTestId('projects-detail-no-preview')).toBeNull();
  });

  it('a picture that fails to load falls back to the tile', () => {
    const { container } = render(
      <ProjectsDetailPane title="Belt" previewPlaceholder thumbnailUrl="blob:broken" />,
    );
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByTestId('projects-detail-no-preview')).toBeTruthy();
  });

  it('without previewPlaceholder (projects, folders) nothing is drawn when there is no picture', () => {
    render(<ProjectsDetailPane title="My project" />);
    expect(screen.queryByTestId('projects-detail-no-preview')).toBeNull();
  });

  it('runs the bulk actions it is given', () => {
    const onDelete = vi.fn();
    render(
      <ProjectsDetailPane
        title="2 documents"
        stack={{ names: ['A', 'B'] }}
        actions={[{ key: 'delete', label: 'Delete 2', destructive: true, onClick: onDelete }]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete 2' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
