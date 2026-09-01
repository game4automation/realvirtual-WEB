// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.5 — Markdown in the detail pane: preview always, editing where allowed
 * (plan-445 F7).
 *
 * The renderer is asked for through the product's ONE lazy entry point, so the
 * test swaps that loader for a double rather than pulling `react-markdown` into
 * a unit test — the same trick `rv-node-knowledge-field-renderer` is tested
 * with, and the reason `__setMarkdownLoader` exists.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ProjectsDetailPane } from '../src/core/hmi/projects/ProjectsDetailPane';
import { __setMarkdownLoader } from '../src/core/hmi/rv-markdown-lazy';

/** A renderer double: enough to prove the source reached the renderer. */
function useFakeMarkdown(): void {
  __setMarkdownLoader(async () => ({
    ReactMarkdown: ({ children }: { children: string }) => (
      <div data-testid="fake-markdown">{children}</div>
    ),
    remarkGfm: null,
  }));
}

afterEach(() => {
  cleanup();
  __setMarkdownLoader();
});

const SOURCE = '# Line one\n\nSome note text.';

describe('§9.5 — preview', () => {
  it('renders the file through the lazy markdown chunk', async () => {
    useFakeMarkdown();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: false, onSave: () => {} }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('fake-markdown')).toBeTruthy());
    expect(screen.getByTestId('fake-markdown').textContent).toBe(SOURCE);
  });

  it('says so while the bytes are still being read', () => {
    useFakeMarkdown();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: null, editable: true, onSave: () => {} }}
      />,
    );
    expect(screen.getByText('Reading…')).toBeTruthy();
    expect(screen.queryByTestId('projects-detail-md-editor')).toBeNull();
  });

  it('shows nothing of the sort for a selection without markdown', () => {
    render(<ProjectsDetailPane title="Plant.glb" />);
    expect(screen.queryByTestId('projects-detail-md-tab-preview')).toBeNull();
  });
});

describe('§9.5 — the Edit tab', () => {
  it('is absent on a read-only file, and the preview still is not', async () => {
    useFakeMarkdown();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: false, onSave: () => {} }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('fake-markdown')).toBeTruthy());
    // Absent, not disabled: there is nothing the user could do to earn it.
    expect(screen.queryByTestId('projects-detail-md-tab-edit')).toBeNull();
    expect(screen.getByTestId('projects-detail-md-tab-preview')).toBeTruthy();
  });

  it('is offered on a writable one', () => {
    useFakeMarkdown();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: true, onSave: () => {} }}
      />,
    );
    expect(screen.getByTestId('projects-detail-md-tab-edit')).toBeTruthy();
  });
});

describe('§9.5 — saving', () => {
  it('hands the edited body back, and only on Save', async () => {
    useFakeMarkdown();
    const onSave = vi.fn();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: true, onSave }}
      />,
    );
    fireEvent.click(screen.getByTestId('projects-detail-md-tab-edit'));
    const editor = screen.getByTestId('projects-detail-md-editor') as HTMLTextAreaElement;
    expect(editor.value).toBe(SOURCE);
    // Typing alone writes nothing — the file is not a live document.
    fireEvent.change(editor, { target: { value: '# Edited' } });
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('# Edited');
  });

  it('Save is inert until something actually changed', () => {
    useFakeMarkdown();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: true, onSave: () => {} }}
      />,
    );
    fireEvent.click(screen.getByTestId('projects-detail-md-tab-edit'));
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Cancel drops the draft and goes back to the preview', async () => {
    useFakeMarkdown();
    const onSave = vi.fn();
    render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: true, onSave }}
      />,
    );
    fireEvent.click(screen.getByTestId('projects-detail-md-tab-edit'));
    fireEvent.change(screen.getByTestId('projects-detail-md-editor'), {
      target: { value: 'thrown away' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onSave).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('fake-markdown').textContent).toBe(SOURCE));
  });

  it('a different selection never inherits the previous draft', async () => {
    useFakeMarkdown();
    const { rerender } = render(
      <ProjectsDetailPane
        title="notes"
        markdown={{ text: SOURCE, editable: true, onSave: () => {} }}
      />,
    );
    fireEvent.click(screen.getByTestId('projects-detail-md-tab-edit'));
    fireEvent.change(screen.getByTestId('projects-detail-md-editor'), {
      target: { value: 'half-typed' },
    });
    rerender(
      <ProjectsDetailPane
        title="other"
        markdown={{ text: '# Other', editable: true, onSave: () => {} }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('fake-markdown').textContent).toBe('# Other'));
  });
});
