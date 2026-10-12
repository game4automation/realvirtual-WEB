// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.7 — the hero card as a drop target, all THREE reference slots.
 *
 * This closes a gap that predates the plan: before it, not one test in the repo
 * simulated `CONNECT_CONFIG_DRAG_TYPE` or `KNOWLEDGE_FILE_DRAG_TYPE`. The
 * Unity-style assignment — the whole point of plan-718 §3 — was shipped on the
 * strength of manual trials. The third slot arriving is the moment to pin the
 * contract for all three at once, because they share one handler and a change
 * to any of them is a change to the others.
 *
 * What is being pinned, and why each half matters:
 *
 *  - the hit-test runs on `dataTransfer.types`, never on `getData()`. During
 *    `dragover` the browser makes `getData()` return the empty string for
 *    security reasons (MDN), so a handler that read the payload to decide
 *    whether to accept would show no ring at all;
 *  - the payload is validated on drop, so a drag carrying the right MIME type
 *    and the wrong path cannot write a binding the loader would refuse;
 *  - a refusal SAYS SO (F8). A drop that silently does nothing is
 *    indistinguishable from a broken screen, and that ambiguity is the reason
 *    people go back to editing `project.json`.
 *
 * The project store is faked rather than seeded: the hero needs one document
 * row, three listings and three setters, and opening a real project would drag
 * in the whole boot path for that.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// ─── The store double, hoisted so the module mock can reach it ──────────

// `vi.mock` factories are hoisted above every top-level binding, so the fake's
// state has to be hoisted with them — `vi.hoisted` is the seam for exactly that.
const { calls, state, store } = vi.hoisted(() => {
  const calls: Array<{ field: string; ref: string | null }> = [];
  const state = {
    writable: true,
    scripts: ['plugins/index.ts', 'plugins/ribbon-tension-controls-plugin.tsx'],
    configs: ['connect/line1.connect.json'],
    knowledge: ['notes.knowledge.md'],
    documents: [] as Array<Record<string, unknown>>,
  };
  const backend = {
    listConnectConfigs: async () => state.configs,
    listKnowledgeFiles: async () => state.knowledge,
    listProjectScripts: async () => state.scripts,
  };
  // ONE store object and ONE snapshot object, rebuilt only when the fake state
  // really changes. `getProjectStore()` and `getSnapshot()` are both identity-
  // sensitive in the component — the store is an effect dependency and the
  // snapshot feeds `useSyncExternalStore` — so a double that mints a fresh
  // object per call renders forever instead of failing honestly.
  let snapshot: unknown = null;
  let stamp = '';
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => {
      const next = `${state.writable}|${state.documents.length}`;
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

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DocumentHeroSection } from '../src/core/hmi/projects/DocumentHeroSection';
import {
  CONNECT_CONFIG_DRAG_TYPE,
  KNOWLEDGE_FILE_DRAG_TYPE,
  SCRIPT_FILE_DRAG_TYPE,
} from '../src/core/hmi/projects/connect-config-dnd';
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

// ─── Doubles ────────────────────────────────────────────────────────────

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

/**
 * A DataTransfer stand-in with the browser's own asymmetry built in: `types` is
 * always readable, `getData()` only when `allowRead` — which is exactly the
 * state during `dragover`, and the reason the hit-test may not use it.
 */
function transfer(payload: Record<string, string>, allowRead = true) {
  return {
    types: Object.keys(payload),
    getData: (type: string) => (allowRead ? payload[type] ?? '' : ''),
    dropEffect: 'none',
    effectAllowed: 'all',
  };
}

function zone(): HTMLElement {
  return screen.getByTestId('document-hero-dropzone');
}

/**
 * Dispatch a drag event carrying a FAKE `dataTransfer`.
 *
 * `fireEvent.dragOver(el, { dataTransfer })` cannot be used here: this suite
 * runs in a real browser, where `new DragEvent()` refuses anything that is not
 * a genuine `DataTransfer` — and a genuine one cannot be populated outside a
 * real drag. So the event is built plain and the property defined onto it,
 * which is what React's synthetic layer reads.
 */
function fire(type: 'dragover' | 'drop', dataTransfer: object): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  fireEvent(zone(), event);
  return event;
}

/** Drag over and then drop one payload on the hero. */
function dragAndDrop(payload: Record<string, string>) {
  fire('dragover', transfer(payload, false));
  fire('drop', transfer(payload));
}

async function mount() {
  const r = render(<DocumentHeroSection />);
  // The candidate listings arrive asynchronously; a chip that has not seen
  // them yet reports every binding as missing.
  await waitFor(() => expect(screen.getByTestId('document-card-plugin-empty')).toBeTruthy());
  return r;
}

beforeEach(() => {
  calls.length = 0;
  state.writable = true;
  state.documents = [{ id: 'd1', path: 'models/DemoRibbonTension.glb', name: 'DemoRibbonTension', tier: 'user' }];
  resetProjectsDashboardForTests();
  openProjectsDashboard();
  setActiveDocumentView(view());
  setOpenDocumentBase({ kind: 'document', documentId: 'd1', path: 'models/DemoRibbonTension.glb' } as never);
});

afterEach(() => {
  cleanup();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
});

// ─── The three accepted drags ───────────────────────────────────────────

describe('plan-479 §9.7 — each drag type binds its own field', () => {
  it('a CONNECT config drag writes connectRef', async () => {
    await mount();
    dragAndDrop({ [CONNECT_CONFIG_DRAG_TYPE]: 'connect/line1.connect.json' });
    expect(calls).toEqual([{ field: 'connectRef', ref: 'connect/line1.connect.json' }]);
  });

  it('a knowledge drag writes knowledgeRef', async () => {
    await mount();
    dragAndDrop({ [KNOWLEDGE_FILE_DRAG_TYPE]: 'notes.knowledge.md' });
    expect(calls).toEqual([{ field: 'knowledgeRef', ref: 'notes.knowledge.md' }]);
  });

  it('a script drag writes scriptRef — the binding that needed a text editor', async () => {
    await mount();
    dragAndDrop({
      [SCRIPT_FILE_DRAG_TYPE]: 'plugins/ribbon-tension-controls-plugin.tsx',
    });
    expect(calls).toEqual([
      { field: 'scriptRef', ref: 'plugins/ribbon-tension-controls-plugin.tsx' },
    ]);
  });

  it('binds a script at any depth under plugins/', async () => {
    await mount();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'plugins/hmi/deep/panel.tsx' });
    expect(calls).toEqual([{ field: 'scriptRef', ref: 'plugins/hmi/deep/panel.tsx' }]);
  });
});

// ─── The hit-test ───────────────────────────────────────────────────────

describe('plan-479 §9.7 — the hit-test reads types, not the payload', () => {
  it('accepts the drag while getData() is still empty', async () => {
    await mount();
    const dt = transfer({ [SCRIPT_FILE_DRAG_TYPE]: 'plugins/index.ts' }, false);
    const event = fire('dragover', dt);
    // `preventDefault` is what makes the element a drop target at all; without
    // it the browser refuses the drop and no binding could ever be made.
    expect(event.defaultPrevented).toBe(true);
    expect(dt.dropEffect).toBe('link');
  });

  it('ignores a drag carrying no known type at all', async () => {
    await mount();
    dragAndDrop({ 'text/plain': 'plugins/index.ts' });
    expect(calls).toEqual([]);
    expect(screen.queryByTestId('document-hero-connect-notice')).toBeNull();
  });

  it('ignores every drag while the project is read-only', async () => {
    state.writable = false;
    await mount();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'plugins/index.ts' });
    dragAndDrop({ [CONNECT_CONFIG_DRAG_TYPE]: 'connect/line1.connect.json' });
    expect(calls).toEqual([]);
  });
});

// ─── F8: a refusal that says why ────────────────────────────────────────

describe('plan-479 §9.7 / F8 — an refused drop states its reason', () => {
  it('refuses a .ts outside plugins/ and names the rule', async () => {
    await mount();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'models/helper.ts' });

    expect(calls).toEqual([]);
    const notice = screen.getByTestId('document-hero-connect-notice');
    expect(notice.textContent).toContain('models/helper.ts');
    expect(notice.textContent).toContain('plugins/');
  });

  it('refuses the right place with the wrong ending', async () => {
    await mount();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'plugins/readme.md' });

    expect(calls).toEqual([]);
    expect(screen.getByTestId('document-hero-connect-notice').textContent)
      .toContain('plugins/readme.md');
  });

  it('the reason can be dismissed, and a good drop clears it', async () => {
    await mount();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'models/helper.ts' });
    expect(screen.getByTestId('document-hero-connect-notice')).toBeTruthy();

    fireEvent.click(screen.getByTestId('document-hero-connect-dismiss'));
    expect(screen.queryByTestId('document-hero-connect-notice')).toBeNull();

    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'models/helper.ts' });
    expect(screen.getByTestId('document-hero-connect-notice')).toBeTruthy();
    dragAndDrop({ [SCRIPT_FILE_DRAG_TYPE]: 'plugins/index.ts' });
    await waitFor(() =>
      expect(screen.queryByTestId('document-hero-connect-notice')).toBeNull());
    expect(calls).toEqual([{ field: 'scriptRef', ref: 'plugins/index.ts' }]);
  });

  it('says nothing when a wrong-typed drop was never for this card', async () => {
    // A CONNECT drag with a non-config payload is a bug elsewhere, not a user
    // error — the pre-plan-479 behaviour (silence) is kept deliberately.
    await mount();
    dragAndDrop({ [CONNECT_CONFIG_DRAG_TYPE]: 'models/Plant.glb' });
    expect(calls).toEqual([]);
    expect(screen.queryByTestId('document-hero-connect-notice')).toBeNull();
  });
});
