// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The card's MOUNT contract (plan-709 §2.1.2, test §9.1).
 *
 * Phase 3 replaced a mode-keyed registry with a direct mount, which moves three
 * questions from "who registered first" into plain rules:
 *
 *  - the card appears exactly when the seam reports a document;
 *  - a view published by another mode is discarded (the reader's half of the
 *    writer contract, §2.1.1 R2-S);
 *  - a mode switch never blanks the card while something is open — in EITHER
 *    order of "the new writer publishes" and "the old writer clears".
 *
 * Plus the boundary the plan calls out by name: the share overlay is a UI slot
 * and has nothing to do with the header, so removing the registry cannot touch
 * it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  DocumentCard,
  DOCUMENT_CARD_UI_ID,
  DOCUMENT_CARD_VISIBILITY,
} from '../src/core/hmi/scene/DocumentCard';
import {
  clearActiveDocumentViewFor,
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  resolveActiveDocumentView,
  setSharedDocumentProjection,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import {
  projectDocumentBase,
  sceneDocumentBase,
  setOpenDocumentBase,
} from '../src/core/editor/active-asset-store';
import { isUIElementVisible, setContext, useUIVisible } from '../src/core/hmi/ui-context-store';
import { SharePlugin } from '../src/core/share/share-plugin';

function makeView(sourceMode: string, name = 'Conveyor'): ActiveDocumentView {
  return {
    name,
    crumbs: [{
      index: 0, label: name, occurrence: '', referenceNodeId: null,
      dirty: false, stale: false, current: true,
    }],
    dirty: false, busy: false, stackDirty: false, stale: false,
    saveVerb: 'save', sourceMode,
    actions: { save: async () => ({ status: 'saved' }) },
  };
}

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
  setContext('mode:viewer', false);
});

// ─── Appearing and disappearing ─────────────────────────────────────────

describe('DocumentCard mount', () => {
  it('is absent while nothing is open', () => {
    render(<DocumentCard activeMode="planner" />);
    expect(screen.queryByTestId('document-card')).toBeNull();
  });

  it('appears as soon as the seam reports a document, in every mode', () => {
    for (const mode of ['planner', 'hmi', 'des', 'editor']) {
      const r = render(<DocumentCard activeMode={mode} />);
      act(() => { setActiveDocumentView(makeView(mode)); });
      expect(screen.getByTestId('document-card')).toBeTruthy();
      r.unmount();
      resetActiveDocumentViewForTests();
    }
  });

  it('disappears again when the seam is cleared', () => {
    render(<DocumentCard activeMode="planner" />);
    act(() => { setActiveDocumentView(makeView('planner')); });
    expect(screen.getByTestId('document-card')).toBeTruthy();
    act(() => { setActiveDocumentView(null); });
    expect(screen.queryByTestId('document-card')).toBeNull();
  });

  it('discards a view published by a different mode', () => {
    render(<DocumentCard activeMode="planner" />);
    // The scene store finishing a background autosave while the editor is up is
    // exactly this: a view arriving from a mode that is not the one on screen.
    act(() => { setActiveDocumentView(makeView('editor')); });
    expect(screen.queryByTestId('document-card')).toBeNull();
  });

  it('does not filter where no mode is given — the dashboard hero', () => {
    render(<DocumentCard variant="hero" />);
    act(() => { setActiveDocumentView(makeView('editor')); });
    expect(screen.getByTestId('document-card')).toBeTruthy();
  });
});

// ─── The mode switch, both orders ───────────────────────────────────────

describe('DocumentCard across a mode switch', () => {
  it('stays on screen when the new writer publishes first', () => {
    const { rerender } = render(<DocumentCard activeMode="editor" />);
    act(() => { setActiveDocumentView(makeView('editor', 'Gripper')); });
    expect(screen.getByTestId('document-crumb-current').textContent).toBe('Gripper');

    // planner takes over: it publishes, THEN the editor clears its own view.
    rerender(<DocumentCard activeMode="planner" />);
    act(() => { setActiveDocumentView(makeView('planner', 'MyPlant')); });
    act(() => { clearActiveDocumentViewFor('editor'); });

    expect(screen.getByTestId('document-crumb-current').textContent).toBe('MyPlant');
  });

  it('stays on screen when the old writer clears first', () => {
    setOpenDocumentBase(projectDocumentBase('models/Plant.glb', 'MyPlant'));
    const { rerender } = render(<DocumentCard activeMode="editor" />);
    act(() => { setActiveDocumentView(makeView('editor', 'Gripper')); });

    rerender(<DocumentCard activeMode="planner" />);
    act(() => { clearActiveDocumentViewFor('editor'); });

    // The gap. `getOpenDocumentBase` is the truth about "something is open"
    // (plan-703 Lauf 14), so the card keeps standing — busy, and honest about
    // not being actionable yet — instead of blinking out.
    const handover = screen.getByTestId('document-card');
    expect(handover).toBeTruthy();
    expect(screen.getByTestId('document-crumb-current').textContent).toBe('MyPlant');

    act(() => { setActiveDocumentView(makeView('planner', 'MyPlant')); });
    expect(screen.getByTestId('document-crumb-current').textContent).toBe('MyPlant');
  });

  it('the handover card refuses to save, with a reason', async () => {
    setOpenDocumentBase(projectDocumentBase('models/Plant.glb', 'MyPlant'));
    const view = resolveActiveDocumentView('planner');
    expect(view?.saveVerb).toBe('blocked');
    expect(await view!.actions.save()).toMatchObject({ status: 'blocked' });
  });

  it('a cleared writer cannot wipe somebody else’s view', () => {
    setActiveDocumentView(makeView('planner', 'MyPlant'));
    clearActiveDocumentViewFor('editor');
    expect(resolveActiveDocumentView('planner')?.name).toBe('MyPlant');
  });
});

// ─── plan-711 §9.8 — the GLEICH-Fall has no handover ────────────────────

describe('DocumentCard while both modes share one document (plan-711 F6)', () => {
  it('shows the other projection’s view instead of a blocked handover card', () => {
    setOpenDocumentBase(sceneDocumentBase('scene_7', 'Line 7'));
    // The scene published while the planner was up; the editor has bound the
    // SAME document and its own writer has not published yet. Without the
    // binding this is the handover gap — with it there is no handover: the view
    // still standing describes the very instance the editor now drives.
    setActiveDocumentView(makeView('planner', 'Line 7'));
    setSharedDocumentProjection(true);

    const view = resolveActiveDocumentView('editor');
    expect(view?.name).toBe('Line 7');
    expect(view?.saveVerb).not.toBe('blocked');
    expect(view?.saveReason).toBeUndefined();
    // Busy, because the recompose may still be running — that is the window's
    // honest answer, and `saveDocument()` already answers busy as a no-op.
    expect(view?.busy).toBe(true);
    expect(view?.sourceMode).toBe('editor');
  });

  it('the card stays on screen through the switch, with the document’s own name', () => {
    setOpenDocumentBase(sceneDocumentBase('scene_7', 'Line 7'));
    const { rerender } = render(<DocumentCard activeMode="planner" />);
    act(() => { setActiveDocumentView(makeView('planner', 'Line 7')); });

    rerender(<DocumentCard activeMode="editor" />);
    act(() => { setSharedDocumentProjection(true); });

    expect(screen.getByTestId('document-crumb-current').textContent).toBe('Line 7');
  });

  it('the UNGLEICH-Fall is byte-identical: no binding, blocked handover as before', async () => {
    setOpenDocumentBase(projectDocumentBase('models/Plant.glb', 'MyPlant'));
    setActiveDocumentView(makeView('editor', 'Gripper'));

    const view = resolveActiveDocumentView('planner');
    expect(view?.name).toBe('MyPlant');
    expect(view?.saveVerb).toBe('blocked');
    expect(await view!.actions.save()).toMatchObject({ status: 'blocked' });
  });

  it('releasing the binding restores the handover answer', () => {
    setOpenDocumentBase(sceneDocumentBase('scene_7', 'Line 7'));
    setActiveDocumentView(makeView('planner', 'Line 7'));
    setSharedDocumentProjection(true);
    expect(resolveActiveDocumentView('editor')?.saveVerb).not.toBe('blocked');

    setSharedDocumentProjection(false);
    expect(resolveActiveDocumentView('editor')?.saveVerb).toBe('blocked');
  });
});

// ─── The visibility gate ────────────────────────────────────────────────

describe('DocumentCard visibility gate', () => {
  it('is hidden in a viewer deploy and shown everywhere else', () => {
    // Registering the rule is what the mount site does on its first render;
    // both use the same exported constant so they cannot drift.
    function Probe() {
      return <span data-testid="probe">{String(useUIVisible(DOCUMENT_CARD_UI_ID, DOCUMENT_CARD_VISIBILITY as never))}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('true');
    act(() => { setContext('mode:viewer', true); });
    expect(screen.getByTestId('probe').textContent).toBe('false');
    expect(isUIElementVisible(DOCUMENT_CARD_UI_ID, new Set(['mode:viewer']))).toBe(false);
  });
});

// ─── The boundary the registry removal must not touch ───────────────────

describe('share overlay is independent of the card', () => {
  it('the share card hangs in the overlay slot, not in a header', () => {
    expect(new SharePlugin().slots.map(s => s.slot)).toEqual(['overlay']);
  });
});
