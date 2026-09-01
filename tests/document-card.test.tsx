// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentCard — the UI promises of plan-709 §3.1 (test §9.3).
 *
 * Renderer-free, after `document-stack-bar.test.tsx`: the card reads exactly
 * one thing (the view seam), so a hand-built {@link ActiveDocumentView} is the
 * whole environment. No SceneStore, no AssetDocument, no WebGLRenderer — which
 * is the point of the seam and therefore worth pinning here too.
 *
 * Four promises are easy to "fix" wrongly later and each has a test:
 *  - compact and hero render the SAME state, only smaller/larger;
 *  - the dirty dot carries unsaved work, not a disabled button;
 *  - the Save verb changes BEFORE the click when the source is read-only;
 *  - the live region speaks on save transitions and never on an edit.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { DocumentCard } from '../src/core/hmi/scene/DocumentCard';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';

// ─── Doubles ────────────────────────────────────────────────────────────

function crumb(label: string, over: Record<string, unknown> = {}) {
  return {
    index: 0, label, occurrence: '', referenceNodeId: null,
    dirty: false, stale: false, current: true, ...over,
  };
}

function makeView(over: Partial<ActiveDocumentView> = {}): ActiveDocumentView {
  return {
    name: 'Conveyor',
    crumbs: [crumb('Conveyor')],
    dirty: false,
    busy: false,
    stackDirty: false,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'planner',
    actions: { save: async () => ({ status: 'saved' }) },
    ...over,
  };
}

function mount(view: ActiveDocumentView | null, variant: 'compact' | 'hero' = 'compact') {
  setActiveDocumentView(view);
  return render(<DocumentCard variant={variant} activeMode="planner" />);
}

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
});

// ─── One card, two sizes ────────────────────────────────────────────────

describe('DocumentCard variants', () => {
  it('renders nothing when the seam reports no document', () => {
    mount(null);
    expect(screen.queryByTestId('document-card')).toBeNull();
  });

  it('compact and hero render the same state', () => {
    const view = makeView({ dirty: true, crumbs: [crumb('Line 2', { current: false }), crumb('Conveyor', { index: 1 })] });

    const compact = mount(view, 'compact');
    const compactCrumbs = screen.getAllByTestId(/^document-crumb/).map(e => e.textContent);
    const compactDirty = screen.getByTestId('document-card').querySelectorAll('[data-testid="dirty-dot"]').length;
    expect(screen.getByTestId('document-card').dataset.variant).toBe('compact');
    // Compact is the hierarchy panel's header row and states the document
    // ONCE, through the trail — the separate title line said the same word the
    // trail already ends in.
    expect(screen.queryByTestId('document-card-name')).toBeNull();
    expect(screen.getByTestId('document-crumb-current').textContent).toContain('Conveyor');
    compact.unmount();

    mount(view, 'hero');
    expect(screen.getByTestId('document-card').dataset.variant).toBe('hero');
    expect(screen.getByTestId('document-card-name').textContent).toBe('Conveyor');
    expect(screen.getAllByTestId(/^document-crumb/).map(e => e.textContent)).toEqual(compactCrumbs);
    expect(screen.getByTestId('document-card').querySelectorAll('[data-testid="dirty-dot"]').length)
      .toBe(compactDirty);
  });

  it('only the hero carries a preview', () => {
    const compact = mount(makeView(), 'compact');
    expect(screen.queryByTestId('document-card-preview')).toBeNull();
    compact.unmount();

    mount(makeView(), 'hero');
    expect(screen.getByTestId('document-card-preview')).toBeTruthy();
  });
});

// ─── Dirty ──────────────────────────────────────────────────────────────

describe('DocumentCard dirty state', () => {
  it('shows the shared dirty mark when the document has unsaved work', () => {
    mount(makeView({ dirty: true }));
    const card = screen.getByTestId('document-card');
    // The shared mark, not a bullet glued to the label — the same element the
    // breadcrumb and the ActivityBar render.
    expect(card.querySelector('[data-testid="dirty-dot"]')).not.toBeNull();
    expect(card.textContent).toContain('Unsaved');
  });

  it('shows no mark on a clean document', () => {
    mount(makeView({ dirty: false }));
    const card = screen.getByTestId('document-card');
    expect(card.querySelector('[data-testid="dirty-dot"]')).toBeNull();
    expect(card.textContent).not.toContain('Unsaved');
  });
});

// ─── The Save button ────────────────────────────────────────────────────

describe('DocumentCard save button', () => {
  it('is NEVER disabled — not clean, not busy, not blocked', () => {
    for (const view of [
      makeView({ dirty: false }),
      makeView({ dirty: true }),
      makeView({ busy: true }),
      makeView({ saveVerb: 'blocked', saveReason: 'The open project is read-only.' }),
      makeView({ saveVerb: 'save-into-project' }),
    ]) {
      const r = mount(view);
      const button = screen.getByTestId('document-card-save') as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      r.unmount();
    }
  });

  it('is BLUE only when a click would do something (2026-08-19)', () => {
    // Active = contained/primary: unsaved changes, a save in flight, or the
    // read-only copy. A clean in-place save is a no-op and renders muted —
    // still enabled and in the keyboard order (§3.1), never removed.
    const active = [
      makeView({ dirty: true }),
      makeView({ busy: true }),
      makeView({ saveVerb: 'save-into-project', dirty: false }),
    ];
    for (const view of active) {
      const r = mount(view);
      expect(screen.getByTestId('document-card-save').className)
        .toContain('MuiButton-contained');
      r.unmount();
    }
    const muted = [
      makeView({ dirty: false }),
      makeView({ saveVerb: 'blocked', saveReason: 'The open project is read-only.' }),
    ];
    for (const view of muted) {
      const r = mount(view);
      const button = screen.getByTestId('document-card-save') as HTMLButtonElement;
      expect(button.className).toContain('MuiButton-outlined');
      expect(button.disabled).toBe(false);
      r.unmount();
    }
  });

  it('announces the copy BEFORE the click when the source is read-only', () => {
    mount(makeView({ saveVerb: 'save-into-project' }));
    expect(screen.getByTestId('document-card-save').textContent).toBe('Save into project');
  });

  it('says Save for a writable origin', () => {
    mount(makeView({ saveVerb: 'save' }));
    expect(screen.getByTestId('document-card-save').textContent).toBe('Save');
  });

  it('shows the reason on a blocked click instead of failing silently', async () => {
    const save = vi.fn(async () => ({ status: 'saved' } as const));
    mount(makeView({
      saveVerb: 'blocked',
      saveReason: 'No project is open — open or create one to save.',
      actions: { save },
    }));
    fireEvent.click(screen.getByTestId('document-card-save'));
    await waitFor(() => expect(screen.getByTestId('document-card-notice').textContent)
      .toBe('No project is open — open or create one to save.'));
    // A blocked verb never reaches the writer: a save that cannot land must not
    // be attempted, or the refusal would arrive as an error after the fact.
    expect(save).not.toHaveBeenCalled();
  });

  it('replaces Save with the conflict notice on a stale frame', () => {
    mount(makeView({ stale: true, dirty: true }));
    expect(screen.queryByTestId('document-card-save')).toBeNull();
    expect(screen.getByTestId('document-card-stale').textContent).toContain('changed below');
  });
});

// ─── The live region ────────────────────────────────────────────────────

describe('DocumentCard live region', () => {
  it('exists from the first render and starts silent', () => {
    mount(makeView({ dirty: true }));
    const region = screen.getByTestId('document-card-status');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
  });

  it('says nothing about an edit — only about a save', () => {
    mount(makeView({ dirty: false }));
    act(() => { setActiveDocumentView(makeView({ dirty: true })); });
    expect(screen.getByTestId('document-crumb-current').textContent).toContain('Conveyor');
    // The document just became dirty. A region that spoke here would speak on
    // every keystroke, which is how a live region gets switched off.
    expect(screen.getByTestId('document-card-status').textContent).toBe('');
  });

  it('announces the transition Saving… → Saved', async () => {
    let release: (v: { status: 'saved' }) => void = () => {};
    const pending = new Promise<{ status: 'saved' }>((r) => { release = r; });
    mount(makeView({ dirty: true, actions: { save: () => pending } }));

    fireEvent.click(screen.getByTestId('document-card-save'));
    await waitFor(() => expect(screen.getByTestId('document-card-status').textContent).toBe('Saving…'));

    await act(async () => { release({ status: 'saved' }); await pending; });
    await waitFor(() => expect(screen.getByTestId('document-card-status').textContent).toBe('Saved'));
  });

  it('names a failure rather than falling silent', async () => {
    mount(makeView({
      dirty: true,
      actions: { save: async () => ({ status: 'error', message: 'disk full' }) },
    }));
    fireEvent.click(screen.getByTestId('document-card-save'));
    await waitFor(() => expect(screen.getByTestId('document-card-status').textContent)
      .toBe('Save failed: disk full'));
  });
});

// ─── The breadcrumb ─────────────────────────────────────────────────────

describe('DocumentCard breadcrumb', () => {
  it('renders one chip for a scene document', () => {
    mount(makeView());
    expect(screen.getAllByTestId(/^document-crumb/).map(e => e.textContent)).toEqual(['Conveyor']);
  });

  it('renders the occurrence chain, the deepest frame current', () => {
    mount(makeView({
      crumbs: [
        crumb('Plant', { index: 0, current: false }),
        crumb('Line 2', { index: 1, current: false }),
        crumb('Conveyor', { index: 2 }),
      ],
    }));
    expect(screen.getAllByTestId(/^document-crumb/).map(e => e.textContent))
      .toEqual(['Plant', 'Line 2', 'Conveyor']);
    expect(screen.getByTestId('document-crumb-current').textContent).toBe('Conveyor');
  });

  it('routes a chip click through the writer’s navigation handler', () => {
    const onCrumb = vi.fn();
    mount(makeView({
      crumbs: [crumb('Plant', { index: 0, current: false }), crumb('Conveyor', { index: 1 })],
      actions: { save: async () => ({ status: 'saved' }), onCrumb },
    }));
    fireEvent.click(screen.getAllByTestId('document-crumb')[0]);
    expect(onCrumb).toHaveBeenCalledTimes(1);
    expect(onCrumb.mock.calls[0][0].label).toBe('Plant');
  });
});
