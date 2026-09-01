// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-450 — "Rename" is a verb again in the detail pane.
 *
 * plan-717 removed the Rename BUTTON and left only a click on the pane title,
 * whose sole affordance is `cursor: 'text'`. The pane's own header comment
 * demands the opposite (§3.4: "every primary action must exist as an explicit
 * button… there is no keyboard equivalent"), so this restores the button —
 * without adding a second commit path.
 *
 * What this file pins is the PANE's half (§9.2, 9.3, 9.7, 9.8):
 *
 *   - both entry points open the same editor and commit exactly once (9.2)
 *   - the entry is inserted STRUCTURALLY, after the last `primary` action, and
 *     never by matching a label (9.3)
 *   - starting the editor SELECTS the name rather than merely focusing it (9.7)
 *   - Escape, blur, an unchanged name and a blank one all commit nothing (9.8)
 *
 * The host's half — which selections actually supply `onRename`, and what a
 * refused name does — is `projects-rename-host.test.tsx`. The split is not
 * cosmetic: `onRename` returns `void` and the pane never learns a verdict
 * (§2.5), so a pane test can neither produce nor observe a refusal.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ProjectsDetailPane,
  type DetailAction,
} from '../src/core/hmi/projects/ProjectsDetailPane';

afterEach(cleanup);

// ─── Helpers ─────────────────────────────────────────────────────────────

function action(key: string, label: string, primary?: boolean): DetailAction {
  return { key, label, onClick: () => {}, ...(primary ? { primary: true } : {}) };
}

/** Labels of the Actions section, in DOM order. */
function actionLabels(): string[] {
  return screen.getAllByRole('button').map(b => b.textContent ?? '');
}

/** The inline rename editor, or null when it is closed. */
function editor(): HTMLInputElement | null {
  return screen.queryByLabelText('Rename') as HTMLInputElement | null;
}

// ─── 9.2 — one editor, one commit, whichever route ───────────────────────

describe('plan-450 §9.2 — every entry point commits through the same handler', () => {
  it('the title click and the Rename button reach the SAME commit, once each', async () => {
    const onRename = vi.fn();
    const { rerender } = render(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[action('open', 'Open', true)]}
        onRename={onRename}
      />,
    );

    // Route 1 — the inline title (plan-717's route, untouched).
    fireEvent.click(screen.getByText('Belt.glb'));
    fireEvent.change(await screen.findByLabelText('Rename'), { target: { value: 'Roll.glb' } });
    fireEvent.keyDown(screen.getByLabelText('Rename'), { key: 'Enter' });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenLastCalledWith('Roll.glb');

    // Route 2 — the button. Re-mounted on the ORIGINAL name, so the second
    // commit has the same work to do as the first.
    rerender(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[action('open', 'Open', true)]}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(await screen.findByLabelText('Rename'), { target: { value: 'Roll.glb' } });
    fireEvent.keyDown(screen.getByLabelText('Rename'), { key: 'Enter' });

    // Two routes, two commits, ONE argument — no second path that spells the
    // name differently, and no dialog in between.
    expect(onRename).toHaveBeenCalledTimes(2);
    expect(new Set(onRename.mock.calls.map(c => c[0]))).toEqual(new Set(['Roll.glb']));
  });

  it('the button opens the inline editor, not a dialog', async () => {
    render(
      <ProjectsDetailPane title="Belt.glb" actions={[action('open', 'Open', true)]} onRename={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(editor()).not.toBeNull());
    // The `AssetPromptDialog` route (plan-717's dead `renameAsset`) must stay
    // dead: a second commit path is exactly what this plan refuses to add.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryAllByLabelText('Rename')).toHaveLength(1);
  });

  it('a rename started from the button survives a re-render of the actions', async () => {
    // The entry is synthesised inside a memo; a caller that rebuilds `actions`
    // (the host does, on every store tick) must not close the editor.
    const { rerender } = render(
      <ProjectsDetailPane title="Belt.glb" actions={[action('open', 'Open', true)]} onRename={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(editor()).not.toBeNull());
    rerender(
      <ProjectsDetailPane title="Belt.glb" actions={[action('open', 'Open', true)]} onRename={() => {}} />,
    );
    expect(editor()).not.toBeNull();
  });
});

// ─── 9.3 — the insertion point is structural ─────────────────────────────

describe('plan-450 §9.3 — rename is inserted after the last primary action', () => {
  it('goes first when no action is primary', () => {
    render(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[action('dup', 'Duplicate'), action('del', 'Delete')]}
        onRename={() => {}}
      />,
    );
    expect(actionLabels()).toEqual(['Rename', 'Duplicate', 'Delete']);
  });

  it('goes after the single primary action', () => {
    render(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[action('open', 'Open', true), action('dup', 'Duplicate'), action('del', 'Delete')]}
        onRename={() => {}}
      />,
    );
    expect(actionLabels()).toEqual(['Open', 'Rename', 'Duplicate', 'Delete']);
  });

  it('goes after the LAST primary action when there are two', () => {
    render(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[
          action('open', 'Open', true),
          action('edit', 'Edit', true),
          action('dup', 'Duplicate'),
        ]}
        onRename={() => {}}
      />,
    );
    expect(actionLabels()).toEqual(['Open', 'Edit', 'Rename', 'Duplicate']);
  });

  it('does not read labels: "Edit a copy" is a primary too', () => {
    // The asset branch spells its primary verb two ways depending on
    // writability. A label match on "Open"/"Edit" would put Rename in the wrong
    // place for one of them; the `primary` flag cannot drift with the copy.
    render(
      <ProjectsDetailPane
        title="Belt.glb"
        actions={[action('edit', 'Edit a copy', true), action('dup', 'Duplicate')]}
        onRename={() => {}}
      />,
    );
    expect(actionLabels()).toEqual(['Edit a copy', 'Rename', 'Duplicate']);
  });

  it('is the only action when the caller supplies none', () => {
    // The Actions section itself has to appear — before plan-450 an empty
    // `actions` hid the whole block, which would have hidden the new verb.
    render(<ProjectsDetailPane title="Belt.glb" onRename={() => {}} />);
    expect(actionLabels()).toEqual(['Rename']);
    expect(screen.getByText('Actions')).toBeTruthy();
  });

  it('never mutates the caller\'s array', () => {
    // `actions` comes out of the host's `useMemo`; splicing into it would add
    // one "Rename" per render until the pane was a list of them.
    const actions = [action('open', 'Open', true), action('dup', 'Duplicate')];
    const { rerender } = render(
      <ProjectsDetailPane title="Belt.glb" actions={actions} onRename={() => {}} />,
    );
    rerender(<ProjectsDetailPane title="Belt.glb" actions={actions} onRename={() => {}} />);
    expect(actions.map(a => a.key)).toEqual(['open', 'dup']);
    expect(actionLabels()).toEqual(['Open', 'Rename', 'Duplicate']);
  });
});

// ─── 9.1 (pane half) — the button exists exactly when `onRename` does ─────

describe('plan-450 §9.1 — the pane offers Rename on exactly one condition', () => {
  it('shows no Rename button without `onRename`, and no disabled one either', () => {
    render(
      <ProjectsDetailPane
        title="Sample.glb"
        badge="Sample"
        actions={[action('open', 'Open', true), action('dup', 'Duplicate to this project')]}
      />,
    );
    expect(actionLabels()).toEqual(['Open', 'Duplicate to this project']);
    // §2.9 / the file's own header: a read-only selection is told what it CAN
    // do, never shown five greyed-out buttons.
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull();
  });

  it('leaves the title inert without `onRename` — no editor on a click', () => {
    render(<ProjectsDetailPane title="Sample.glb" actions={[action('open', 'Open', true)]} />);
    fireEvent.click(screen.getByText('Sample.glb'));
    expect(editor()).toBeNull();
  });

  it('offers no Actions section at all when there is nothing to offer', () => {
    render(<ProjectsDetailPane title="Sample.glb" />);
    expect(screen.queryByText('Actions')).toBeNull();
  });
});

// ─── 9.7 — the name is selected, not merely focused ──────────────────────

describe('plan-450 §9.7 — starting the editor selects the existing name', () => {
  /** Open the editor the given way and answer with the focused input. */
  async function openVia(route: 'title' | 'button'): Promise<HTMLInputElement> {
    render(
      <ProjectsDetailPane title="Belt.glb" actions={[action('open', 'Open', true)]} onRename={() => {}} />,
    );
    fireEvent.click(route === 'title'
      ? screen.getByText('Belt.glb')
      : screen.getByRole('button', { name: 'Rename' }));
    const input = await screen.findByLabelText('Rename') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    return input;
  }

  it('selects the whole name when the button opens it', async () => {
    const input = await openVia('button');
    // `autoFocus` alone leaves the caret at one end and the name intact, so the
    // first keystroke APPENDS. A rename that appends is not a rename.
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Belt.glb'.length);
  });

  it('selects it for the title route too — one editor, one behaviour', async () => {
    const input = await openVia('title');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Belt.glb'.length);
  });

  it('so typing REPLACES the name rather than extending it', async () => {
    const onRename = vi.fn();
    render(
      <ProjectsDetailPane title="Belt.glb" actions={[]} onRename={onRename} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = await screen.findByLabelText('Rename') as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    // What a keystroke over a full selection does, spelled out: the browser
    // replaces the selected range. Asserted through the commit, because that is
    // the value the host would receive.
    fireEvent.change(input, { target: { value: 'Roll.glb' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).toHaveBeenCalledWith('Roll.glb');
  });
});

// ─── 9.8 — the abandon paths ─────────────────────────────────────────────

describe('plan-450 §9.8 — escape and blur cancel without committing', () => {
  function open(onRename: (next: string) => void) {
    render(
      <ProjectsDetailPane title="Belt.glb" actions={[action('open', 'Open', true)]} onRename={onRename} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    return screen.getByLabelText('Rename') as HTMLInputElement;
  }

  it('Escape abandons the edit and restores the title', async () => {
    const onRename = vi.fn();
    const input = open(onRename);
    fireEvent.change(input, { target: { value: 'Roll.glb' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(editor()).toBeNull());
    expect(screen.getByText('Belt.glb')).toBeTruthy();
  });

  it('a blur abandons it too — a stray click never renames a file', async () => {
    const onRename = vi.fn();
    const input = open(onRename);
    fireEvent.change(input, { target: { value: 'Roll.glb' } });
    fireEvent.blur(input);
    expect(onRename).not.toHaveBeenCalled();
    await waitFor(() => expect(editor()).toBeNull());
  });

  it('an unchanged name commits nothing', () => {
    const onRename = vi.fn();
    const input = open(onRename);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('a name that trims to nothing commits nothing', () => {
    const onRename = vi.fn();
    const input = open(onRename);
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('a new selection drops a half-typed rename', async () => {
    const onRename = vi.fn();
    const { rerender } = render(
      <ProjectsDetailPane title="Belt.glb" actions={[]} onRename={onRename} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Rename'), { target: { value: 'Roll.glb' } });
    rerender(<ProjectsDetailPane title="Capper.glb" actions={[]} onRename={onRename} />);
    await waitFor(() => expect(editor()).toBeNull());
    expect(onRename).not.toHaveBeenCalled();
  });
});
