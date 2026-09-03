// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Ctrl/Cmd+S → the ONE save path (plan-709 §3.2, phases 2–3).
 *
 * The shortcut is the second way to press Save — the card's button is the
 * first — and it is the one nothing was asserting. It lives on the editor
 * plugin's own `keydown` listener (`AssetEditorPlugin.onKeyDown`, registered on
 * `window` when the plugin enters editor mode), so it is NOT a React element
 * and there is nothing to render: this test registers the very listener
 * production registers and dispatches real keyboard events at it.
 *
 * What is pinned, and why each one is a way the wiring can rot silently:
 *
 *  - **exactly one save.** The handler routes into `runSaveFlow` →
 *    `saveDocument`, the same path the card's button uses, so the bytes land at
 *    the document's own identity-routed path. A duplicated listener or a
 *    branch that fell through would show up as a second write;
 *  - **`preventDefault`.** Without it the browser's own "save page" dialog
 *    opens over a 3D editor — a failure invisible to any test that only checks
 *    that a save happened;
 *  - **busy.** A second press during a multi-second bake (or key repeat) must
 *    not start a second writer. The guard is the `saving` set inside
 *    `saveDocument`, and this asserts the shortcut goes THROUGH it rather than
 *    around it — the write is held open so the second press genuinely lands
 *    mid-save;
 *  - **the guards.** Shift+Ctrl+S is not this shortcut, a keystroke inside a
 *    text field belongs to the field, and with nothing open nothing happens.
 *
 * The write goes to a fake backend (same shape as
 * `save-document-routing.test.ts`); the exporter and the thumbnail renderer are
 * stubbed because neither is what this file is about.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  /** Project path → stored text. The whole "disk" of this test. */
  files: new Map<string, string>(),
  projectId: 'prj_one' as string | null,
  /** While set, every write blocks on it — the held-open save. */
  hold: null as Promise<void> | null,
}));

vi.mock('../src/core/project/project-store', async (original) => {
  const actual = await original<typeof import('../src/core/project/project-store')>();
  return { ...actual, getProjectStore: () => projectStore };
});

vi.mock('../src/core/editor/rv-asset-glb-export', async (original) => {
  const actual = await original<typeof import('../src/core/editor/rv-asset-glb-export')>();
  return {
    ...actual,
    exportAssetGlb: async (_root: unknown, name?: string) =>
      new TextEncoder().encode(`GLB:${name}`).buffer,
  };
});

// Thumbnails need a WebGL renderer and are best-effort in the code. `null` is
// the documented WebGPU path — no thumbnail write, no noise here.
vi.mock('../src/core/thumbnails/thumbnail-renderer', () => ({
  ThumbnailRenderer: class {
    render(): string | null { return null; }
    dispose(): void {}
  },
}));

const writes: string[] = [];

const backend = {
  kind: 'browser' as const,
  id: 'backend-1',
  writable: true,
  isActive: true,
  async writeBlob(relPath: string, blob: Blob) {
    if (h.hold) await h.hold;
    writes.push(relPath);
    h.files.set(relPath, await blob.text());
  },
  async readDocumentUrl(relPath: string) {
    const value = h.files.get(relPath);
    if (value === undefined) return null;
    const url = URL.createObjectURL(new Blob([value]));
    return { url, release: () => URL.revokeObjectURL(url) };
  },
  async listDocuments() {
    return [...h.files.keys()].map((path, i) => ({ id: `doc-${i}`, name: path, path }));
  },
};

const projectStore = {
  getBackend: () => backend,
  getProject: () => (h.projectId ? { id: h.projectId, documents: [] } : null),
};

import { AssetEditorPlugin } from '@rv-private/plugins/asset-editor/index';
import { forgetSavedRevisions, isSaving } from '../src/core/editor/rv-save-document';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  libraryDocumentBase,
} from '../src/core/editor/active-asset-store';

// ─── Doubles ──────────────────────────────────────────────────────────────

const BELT: AssetBase = libraryDocumentBase('Custom/Belt.glb');

function makeDoc(base: AssetBase = BELT, name = 'Belt') {
  const markSavedCalls: AssetBase[] = [];
  const doc = {
    name,
    base,
    dirty: true,
    markSavedCalls,
    document: {
      opCount: 2,
      runExclusive<T>(work: () => Promise<T>): Promise<T> { return work(); },
      markSaved(): void {},
    },
    async markSaved(next: AssetBase): Promise<void> {
      markSavedCalls.push(next);
      doc.base = next;
    },
  };
  return doc;
}

function makeViewer() {
  return {
    currentModelRoot: { name: 'Belt' },
    renderer: {},
    scene: {},
    emit: () => {},
    getPlugin: () => undefined,
  };
}

/**
 * The plugin with just enough state for its key handler.
 *
 * `_handleEditorKeys` reads `doc`, `viewer` and `testSession` and nothing else,
 * so no scene, no renderer and no `init()` are needed — the same reason
 * `editor-draft-conflict.test.ts` drives `_resolveOpenPlan` on a bare instance.
 * The listener registered is the exact function the plugin registers itself.
 */
function mountKeyHandler(doc: ReturnType<typeof makeDoc> | null): () => void {
  const plugin = new AssetEditorPlugin();
  const internals = plugin as unknown as {
    viewer: unknown; doc: unknown; onKeyDown: (e: KeyboardEvent) => void;
  };
  internals.viewer = makeViewer();
  internals.doc = doc;
  window.addEventListener('keydown', internals.onKeyDown);
  return () => window.removeEventListener('keydown', internals.onKeyDown);
}

function pressS(
  opts: { ctrl?: boolean; meta?: boolean; shift?: boolean; from?: EventTarget } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 's', code: 'KeyS',
    ctrlKey: opts.ctrl ?? false,
    metaKey: opts.meta ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true, cancelable: true,
  });
  (opts.from ?? document.body).dispatchEvent(event);
  return event;
}

/** Long enough for a whole save (or its refusal) to run to the end. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

let unmount: (() => void) | null = null;

beforeEach(() => {
  h.files.clear();
  h.files.set('library/Custom/Belt.glb', 'old bytes');
  h.projectId = 'prj_one';
  h.hold = null;
  writes.length = 0;
  forgetSavedRevisions();
});

afterEach(async () => {
  unmount?.();
  unmount = null;
  // A save is fire-and-forget from the handler's point of view; letting the
  // last one finish here keeps it from writing into the next test's counters.
  await settle();
});

// ─── The shortcut fires the one save path ─────────────────────────────────

describe('Ctrl/Cmd+S in the asset editor', () => {
  it('Ctrl+S saves the open document exactly once', async () => {
    const doc = makeDoc();
    unmount = mountKeyHandler(doc);

    const event = pressS({ ctrl: true });
    await vi.waitFor(() => { expect(doc.markSavedCalls).toHaveLength(1); });
    await settle();

    // One press, one write — identity-routed to the document's own path
    // rather than somewhere the shortcut picked for itself.
    expect(writes).toEqual(['library/Custom/Belt.glb']);
    expect(h.files.get('library/Custom/Belt.glb')).toBe('GLB:Belt');
    // …and the browser's own save dialog never gets the chance.
    expect(event.defaultPrevented).toBe(true);
  });

  it('Cmd+S does the same on macOS', async () => {
    const doc = makeDoc();
    unmount = mountKeyHandler(doc);

    const event = pressS({ meta: true });
    await vi.waitFor(() => { expect(doc.markSavedCalls).toHaveLength(1); });
    await settle();

    expect(writes).toEqual(['library/Custom/Belt.glb']);
    expect(event.defaultPrevented).toBe(true);
  });
});

// ─── Busy: the second press is not a second writer ────────────────────────

describe('Ctrl+S while a save is already running', () => {
  it('starts no second save, and the first one still completes', async () => {
    const doc = makeDoc();
    unmount = mountKeyHandler(doc);

    let release!: () => void;
    h.hold = new Promise<void>(resolve => { release = resolve; });

    pressS({ ctrl: true });
    // Wait until the first save really is mid-write — otherwise "the second
    // press did nothing" could just mean the first one had already finished.
    await vi.waitFor(() => { expect(isSaving(doc)).toBe(true); });
    expect(writes).toEqual([]);               // held at the write

    pressS({ ctrl: true });                   // impatient second press / key repeat
    await settle();
    expect(writes).toEqual([]);               // no second writer slipped past

    release();
    h.hold = null;
    await vi.waitFor(() => { expect(doc.markSavedCalls).toHaveLength(1); });
    await settle();

    expect(writes).toEqual(['library/Custom/Belt.glb']);
    expect(doc.markSavedCalls).toHaveLength(1);
    expect(isSaving(doc)).toBe(false);
  });

  it('but a later press saves again once the first one finished', async () => {
    const doc = makeDoc();
    unmount = mountKeyHandler(doc);

    pressS({ ctrl: true });
    await vi.waitFor(() => { expect(writes).toHaveLength(1); });
    await settle();

    doc.dirty = true;
    pressS({ ctrl: true });
    await vi.waitFor(() => { expect(writes).toHaveLength(2); });
  });
});

// ─── The guards ───────────────────────────────────────────────────────────

describe('Ctrl+S guards', () => {
  it('Shift+Ctrl+S is not this shortcut — nothing is saved or prevented', async () => {
    unmount = mountKeyHandler(makeDoc());

    const event = pressS({ ctrl: true, shift: true });
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(writes).toEqual([]);
  });

  it('a keystroke inside a text field belongs to the field', async () => {
    unmount = mountKeyHandler(makeDoc());
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      const event = pressS({ ctrl: true, from: input });
      await settle();

      expect(event.defaultPrevented).toBe(false);
      expect(writes).toEqual([]);
    } finally {
      input.remove();
    }
  });

  it('does nothing when no document is open', async () => {
    unmount = mountKeyHandler(null);

    const event = pressS({ ctrl: true });
    await settle();

    expect(event.defaultPrevented).toBe(false);
    expect(writes).toEqual([]);
  });
});
