// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.9b / F7 — the keyboard route to all THREE bindings.
 *
 * Drag-and-drop is a mouse gesture and nothing else. The HTML drag API does not
 * fire from a keyboard at all and does not fire from touch either, so before
 * this route the three reference slots were simply unreachable for anyone not
 * using a pointer — a WAI-ARIA violation the plan calls out by name ("if a user
 * can drag and drop, a user must be able to do the equivalent from the
 * keyboard").
 *
 * Two things are pinned here, and the second is the more interesting one:
 *
 *  - every field can be bound with keystrokes only: focus the card's kebab,
 *    Enter, walk to the entry, Enter, walk to the candidate, Enter. No call to
 *    `click()` stands in for a gesture a keyboard user cannot make;
 *  - the picker offers only what the RULE accepts (the F8 counterpart on this
 *    route). A `.ts` outside `plugins/` is refused with a sentence on the drop
 *    path; here it must never appear as a candidate at all, because a refusal
 *    you cannot trigger needs no explanation.
 *
 * Written against the same store double as `hero-ref-drop.test.tsx` — the two
 * routes must end in the SAME `assign`, so they are best watched through the
 * same recorder.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { calls, state, store } = vi.hoisted(() => {
  const calls: Array<{ field: string; ref: string | null }> = [];
  const state = {
    writable: true,
    // `models/helper.ts` is the F8 case: right ending, wrong place. A backend
    // that ever widened its walk must not turn into a bindable candidate here.
    scripts: [
      'plugins/index.ts',
      'plugins/ribbon-tension-controls-plugin.tsx',
      'models/helper.ts',
    ],
    configs: ['connect/line1.connect.json'],
    knowledge: ['notes.knowledge.md'],
    documents: [] as Array<Record<string, unknown>>,
  };
  const backend = {
    listConnectConfigs: async () => state.configs,
    listKnowledgeFiles: async () => state.knowledge,
    listProjectScripts: async () => state.scripts,
  };
  let snapshot: unknown = null;
  let stamp = '';
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => {
      const next = `${state.writable}|${JSON.stringify(state.documents)}`;
      if (next !== stamp || snapshot === null) {
        stamp = next;
        snapshot = {
          project: { id: 'proj-1', name: 'Linie' },
          documents: state.documents,
          writable: state.writable,
        };
      }
      return snapshot;
    },
    getBackend: () => backend,
    setDocumentConnectRef: async (_id: string, ref: string | null) => {
      calls.push({ field: 'connectRef', ref });
    },
    setDocumentKnowledgeRef: async (_id: string, ref: string | null) => {
      calls.push({ field: 'knowledgeRef', ref });
    },
    setDocumentScriptRef: async (_id: string, ref: string | null) => {
      calls.push({ field: 'scriptRef', ref });
    },
  };
  return { calls, state, store };
});

vi.mock('../src/core/project/project-store', () => ({ getProjectStore: () => store }));

import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { DocumentHeroSection } from '../src/core/hmi/projects/DocumentHeroSection';
import {
  openProjectsDashboard,
  resetProjectsDashboardForTests,
} from '../src/core/hmi/projects/projects-dashboard-store';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';

/**
 * A view that publishes NO menu verbs.
 *
 * Deliberate: before Phase 5 the kebab only existed when the mode had verbs of
 * its own, so a document opened in a mode with none had no menu — and would
 * therefore have had no keyboard route either. The bind entries have to bring
 * the menu into existence, which is only provable on a view like this one.
 */
function view(name = 'DemoRibbonTension'): ActiveDocumentView {
  return {
    name,
    crumbs: [{
      index: 0, label: name, occurrence: '', referenceNodeId: null,
      dirty: false, stale: false, current: true,
    }],
    dirty: false, busy: false, stackDirty: false, stale: false,
    saveVerb: 'save', sourceMode: 'planner',
    actions: { save: async () => ({ status: 'saved' }) },
  } as unknown as ActiveDocumentView;
}

async function mount() {
  const r = render(<DocumentHeroSection />);
  // The candidate listings arrive asynchronously and the picker is built from
  // them; opening the menu before they land would show an empty dialog.
  // Either spelling: the chip is `-empty` while nothing is bound and carries
  // the bare testid once it is, and this suite mounts both states.
  await waitFor(() => expect(
    screen.queryByTestId('document-card-plugin-empty')
    ?? screen.getByTestId('document-card-plugin'),
  ).toBeTruthy());
  return r;
}

/** Open the card menu the way a keyboard user does: focus, then Enter. */
async function openMenuByKeyboard() {
  const kebab = screen.getByRole('button', { name: 'More actions' });
  kebab.focus();
  expect(document.activeElement).toBe(kebab);
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByTestId('document-card-bind-scriptRef')).toBeTruthy());
}

/**
 * Walk to one bind entry with the arrow keys and activate it.
 *
 * MUI focuses the first item when a menu opens, so the entry's INDEX is the
 * number of ArrowDowns — which is also the assertion that the three entries
 * are in one keyboard order and none of them is skippable.
 */
async function chooseEntry(index: number) {
  for (let i = 0; i < index; i++) await userEvent.keyboard('{ArrowDown}');
  await userEvent.keyboard('{Enter}');
  await waitFor(() => expect(screen.getByTestId('document-hero-bind-dialog')).toBeTruthy());
}

/** Tab to the nth candidate below "None" and press Enter. */
async function chooseCandidate(index: number) {
  for (let i = 0; i <= index; i++) await userEvent.keyboard('{Tab}');
  await userEvent.keyboard('{Enter}');
}

beforeEach(() => {
  calls.length = 0;
  state.writable = true;
  state.documents = [{
    id: 'd1', path: 'models/DemoRibbonTension.glb', name: 'DemoRibbonTension', tier: 'user',
  }];
  resetProjectsDashboardForTests();
  openProjectsDashboard();
  setActiveDocumentView(view());
  setOpenDocumentBase({
    kind: 'document', documentId: 'd1', path: 'models/DemoRibbonTension.glb',
  } as never);
});

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
});

// ─── The three fields, keyboard only ────────────────────────────────────

describe('plan-479 §9.9b — every binding is reachable without a pointer', () => {
  it('binds connectRef from the keyboard', async () => {
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(0);
    await chooseCandidate(0);
    await waitFor(() => expect(calls).toEqual([
      { field: 'connectRef', ref: 'connect/line1.connect.json' },
    ]));
  });

  it('binds scriptRef from the keyboard — the binding that needed a text editor', async () => {
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(1);
    await chooseCandidate(1);
    await waitFor(() => expect(calls).toEqual([
      { field: 'scriptRef', ref: 'plugins/ribbon-tension-controls-plugin.tsx' },
    ]));
  });

  it('binds knowledgeRef from the keyboard', async () => {
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(2);
    await chooseCandidate(0);
    await waitFor(() => expect(calls).toEqual([
      { field: 'knowledgeRef', ref: 'notes.knowledge.md' },
    ]));
  });

  it('clears a binding from the keyboard — "None" is the first stop', async () => {
    state.documents = [{
      id: 'd1',
      path: 'models/DemoRibbonTension.glb',
      name: 'DemoRibbonTension',
      tier: 'user',
      scriptRef: 'plugins/index.ts',
    }];
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(1);
    // No Tab: the trap puts focus on "None", so Enter alone unbinds.
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(calls).toEqual([{ field: 'scriptRef', ref: null }]));
  });

  it('writes nothing when "None" is chosen on a field that is already unbound', async () => {
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(1);
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByTestId('document-hero-bind-dialog')).toBeNull());
    expect(calls).toEqual([]);
  });
});

// ─── The candidate filter — F8 on the menu route ────────────────────────

describe('plan-479 §9.9b / F8 — the picker offers only what the rule accepts', () => {
  it('never lists a .ts outside plugins/', async () => {
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(1);

    expect(screen.getByTestId('document-hero-bind-option-plugins/index.ts')).toBeTruthy();
    expect(screen.getByTestId(
      'document-hero-bind-option-plugins/ribbon-tension-controls-plugin.tsx')).toBeTruthy();
    // The file the drop path refuses with a sentence is simply not on offer.
    expect(screen.queryByTestId('document-hero-bind-option-models/helper.ts')).toBeNull();
  });

  it('says where the candidates would come from when there are none', async () => {
    state.scripts = ['models/helper.ts'];
    await mount();
    await openMenuByKeyboard();
    await chooseEntry(1);

    const empty = screen.getByTestId('document-hero-bind-empty');
    expect(empty.textContent).toContain('plugins/');
    expect(screen.queryByTestId('document-hero-bind-option-models/helper.ts')).toBeNull();
  });
});

// ─── Read-only ──────────────────────────────────────────────────────────

describe('plan-479 §9.9b — a read-only project offers no route at all', () => {
  it('drops the bind entries, and with them the menu this view had no verbs for', async () => {
    state.writable = false;
    await mount();
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });
});
