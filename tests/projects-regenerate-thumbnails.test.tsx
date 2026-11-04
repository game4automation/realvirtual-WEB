// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 #20 — the project row's ⋮ item "Regenerate thumbnails" is a VIEW of
 * the registry command `project.regenerateThumbnails`.
 *
 * The host cannot be rendered by a test (it says so itself), so this mounts
 * `ProjectsList` with the host's two production halves —
 * `regenerateThumbnailsMenuState` (the command's rule → disabled + tooltip) and
 * `dispatchRegenerateThumbnails` (dispatch by id) — on a registry of its own.
 * Asserted: the item exists on every row, is disabled with the read-only
 * reason on the bundled demo (and does nothing there), and on a writable
 * project dispatches the command with the row's id. The progress dialog shows
 * the run's count, document and result from the progress store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

const sceneHolder = vi.hoisted(() => ({ store: { getSnapshot: () => ({ dirty: false }) } as unknown }));
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  getSceneStore: () => sceneHolder.store,
  initSceneStore: () => sceneHolder.store,
}));

import { ProjectsList } from '../src/core/hmi/projects/ProjectsList';
import { RegenerateThumbnailsDialog } from '../src/core/hmi/projects/RegenerateThumbnailsDialog';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  dispatchRegenerateThumbnails,
  READ_ONLY_PROJECT,
  REGENERATE_THUMBNAILS_COMMAND,
  regenerateThumbnailsMenuState,
} from '../src/core/thumbnails/rv-thumbnail-regenerate-commands';
import {
  _resetRegenerateProgressForTest,
  beginRegenerateProgress,
  finishRegenerateProgress,
  recordRegenerateResult,
  setRegenerateCurrent,
  setRegenerateTotal,
} from '../src/core/thumbnails/rv-thumbnail-regenerate-progress';
import { DEMO_PROJECT_ID, DEMO_PROJECT_NAME } from '../src/core/project/backends/bundled-backend';
import { resetProjectStore } from '../src/core/project/project-store';
import { installFakeDocumentProject, type FakeDocumentProject } from './helpers/fake-document-project';

const noop = () => {};
const PROJECT_ID = 'prj_fake_documents';
const viewer = { renderer: {}, modes: { activeMode: 'hmi' } } as never;

let project: FakeDocumentProject;
let registry: CommandRegistry;

function mount(onDispatch: (id: string) => void) {
  return render(<ProjectsList
    activeProjectId={PROJECT_ID}
    modeLocked={false}
    onOpenProject={noop}
    onAdd={noop}
    onNew={noop}
    onLocate={noop}
    onRemove={noop}
    onRenameProject={noop}
    onDeleteProject={noop}
    onRegenerateThumbnails={onDispatch}
    regenerateThumbnailsState={(id) => regenerateThumbnailsMenuState(id, viewer, registry)}
    rows={[
      { id: DEMO_PROJECT_ID, name: DEMO_PROJECT_NAME, hint: 'bundled' },
      { id: PROJECT_ID, name: 'Mine', hint: 'browser' },
    ]}
  />);
}

beforeEach(() => {
  localStorage.clear();
  resetProjectStore();
  _resetRegenerateProgressForTest();
  project = installFakeDocumentProject({ documents: [] });
  registry = new CommandRegistry();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  project.restore();
  resetProjectStore();
  _resetRegenerateProgressForTest();
});

describe('project row ⋮ — Regenerate thumbnails', () => {
  it('is offered on a writable project and dispatches the command with the row id', async () => {
    const execute = vi.spyOn(registry, 'execute').mockResolvedValue({ ok: true, value: {} });
    mount((id) => { void dispatchRegenerateThumbnails(id, viewer, registry); });

    fireEvent.click(screen.getByLabelText('Project actions for Mine'));
    const item = screen.getByTestId(`project-regenerate-thumbnails-${PROJECT_ID}`);
    expect(item.textContent).toBe('Regenerate thumbnails');
    expect(item.getAttribute('aria-disabled')).toBeNull();

    fireEvent.click(item);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe(REGENERATE_THUMBNAILS_COMMAND);
    expect(execute.mock.calls[0]![1]).toEqual({ projectId: PROJECT_ID });
    expect(execute.mock.calls[0]![2]).toMatchObject({ origin: 'ui' });
  });

  it('is disabled on the read-only bundled project, says why, and does nothing', async () => {
    const execute = vi.spyOn(registry, 'execute');
    const onDispatch = vi.fn();
    mount(onDispatch);

    // The bundled row gets a kebab for this verb alone.
    fireEvent.click(screen.getByLabelText(`Project actions for ${DEMO_PROJECT_NAME}`));
    const item = screen.getByTestId(`project-regenerate-thumbnails-${DEMO_PROJECT_ID}`);
    expect(item.getAttribute('aria-disabled')).toBe('true');

    fireEvent.mouseOver(item);
    expect((await screen.findByRole('tooltip')).textContent).toBe(READ_ONLY_PROJECT);

    fireEvent.click(item);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('a read-only open project is disabled by the same rule', () => {
    (project.backend as { writable: boolean }).writable = false;
    expect(regenerateThumbnailsMenuState(PROJECT_ID, viewer, registry)).toEqual({ reason: READ_ONLY_PROJECT });
  });
});

describe('RegenerateThumbnailsDialog', () => {
  it('shows the count and the current document, then the result with the failures by name', async () => {
    render(<RegenerateThumbnailsDialog />);
    act(() => {
      beginRegenerateProgress({ id: PROJECT_ID, name: 'Mine' }, noop);
      setRegenerateTotal(12);
      recordRegenerateResult(null);
      recordRegenerateResult(null);
      setRegenerateCurrent('Gantry');
    });
    expect(screen.getByText('Regenerating thumbnails')).toBeTruthy();
    expect(screen.getByTestId('regenerate-thumbnails-count').textContent).toBe('3 / 12');
    expect(screen.getByTestId('regenerate-thumbnails-current').textContent).toBe('Gantry');
    expect(screen.getByTestId('regenerate-thumbnails-cancel')).toBeTruthy();

    act(() => {
      recordRegenerateResult({ documentId: 'doc_bad', name: 'Bad', reason: 'The file could not be read.' });
      finishRegenerateProgress({ cancelled: false });
    });
    const result = screen.getByTestId('regenerate-thumbnails-result').textContent ?? '';
    expect(result).toContain('2 written, 1 failed.');
    expect(result).toContain('Bad — The file could not be read.');
    fireEvent.click(screen.getByTestId('regenerate-thumbnails-close'));
  });
});
