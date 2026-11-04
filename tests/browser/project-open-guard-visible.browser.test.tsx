// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The project-switch hang of 2026-10-25, measured in real Chromium.
 *
 * Switching from a project with unsaved work (a document resumed from its
 * draft counts since 921ea41f) to the demo project raised the dirty guard
 * WHILE the dashboard's "Open project…" dialog was up. Both dialogs sat on the
 * default modal z-index and the progress dialog covered the guard, so the
 * switch awaited an answer nobody could see — "Please wait while the project
 * is updated" forever.
 *
 * Guarded here:
 *  - the guard dialog (`SceneConfirmDialog aboveModals`, as ProjectDialogHost
 *    mounts it) is the TOP element at its own centre while the operation
 *    dialog is open, whichever of the two mounted first;
 *  - the operation dialog names the running step, and says when that step is
 *    waiting for the user;
 *  - outside an operation, steps are not recorded (the rescan cascade would
 *    otherwise grow the list without bound).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { act, cleanup, render, screen } from '@testing-library/react';
import { CssBaseline } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { SceneConfirmDialog } from '../../src/core/hmi/scene/rv-scene-confirm-dialog';
import { ProjectOperationDialog } from '../../src/core/hmi/projects/ProjectOperationDialog';
import {
  beginProjectOpStep,
  getProjectOpProgress,
  resetProjectOpProgress,
  startProjectOp,
} from '../../src/core/project/project-op-progress';

function themed(ui: ReactNode) {
  return <ThemeProvider theme={rvDarkTheme}><CssBaseline />{ui}</ThemeProvider>;
}

function guard(open: boolean) {
  return (
    <SceneConfirmDialog open={open} sceneName="PalletYard" canSave={false}
      onSave={() => {}} onSaveAs={() => {}} onDiscard={() => {}} onCancel={() => {}}
      aboveModals />
  );
}

function guardIsOnTop(): boolean {
  const title = screen.getByText('Unsaved changes');
  const paper = title.closest('.MuiDialog-paper') as HTMLElement;
  const r = paper.getBoundingClientRect();
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return !!hit && paper.contains(hit);
}

afterEach(() => {
  cleanup();
  resetProjectOpProgress();
});

describe('project switch: the dirty guard is visible above the operation dialog', () => {
  it('guard opened AFTER the operation dialog (the hang path) is on top', async () => {
    const { rerender } = render(themed(<>
      <ProjectOperationDialog label="Open project" />
      {guard(false)}
    </>));
    rerender(themed(<>
      <ProjectOperationDialog label="Open project" />
      {guard(true)}
    </>));
    await screen.findByText('Unsaved changes');
    await new Promise(r => setTimeout(r, 400));   // let the enter transitions settle
    expect(guardIsOnTop()).toBe(true);
  });

  it('guard mounted BEFORE the operation dialog is on top as well', async () => {
    const { rerender } = render(themed(<>{guard(true)}</>));
    await screen.findByText('Unsaved changes');
    rerender(themed(<>
      {guard(true)}
      <ProjectOperationDialog label="Open project" />
    </>));
    await new Promise(r => setTimeout(r, 400));
    expect(guardIsOnTop()).toBe(true);
  });
});

describe('ProjectOperationDialog names the step', () => {
  it('shows the running step and a waiting-for-user hint, plus finished steps', async () => {
    render(themed(<ProjectOperationDialog label="Open project" />));
    expect(await screen.findByText('Please wait while the project is updated.')).toBeTruthy();

    act(() => {
      startProjectOp();
      beginProjectOpStep('Closing DiscreteEventSimulation — writing pending changes');
      beginProjectOpStep('Waiting for your answer — unsaved changes', { waitingForUser: true });
    });
    expect(await screen.findByText('Waiting for your answer — unsaved changes')).toBeTruthy();
    expect(screen.getByTestId('project-operation-elapsed').textContent)
      .toMatch(/Answer the open question/);
    expect(screen.getByText(/Details \(1 step done\)/)).toBeTruthy();
  });

  it('records nothing outside an operation', () => {
    resetProjectOpProgress();
    beginProjectOpStep('Registering new and changed files');
    expect(getProjectOpProgress().current).toBeNull();
    expect(getProjectOpProgress().finished).toHaveLength(0);
  });
});
