// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-764 §9.6 — the document card's generalised export, and (Phase 2) the
 * "Apply USD extras…" half of it.
 *
 *  - no provider: only "Export .glb…", test id unchanged;
 *  - with a provider: its entry from `exports[]`, its modes, its MIME type and
 *    file name in the download;
 *  - overlay stays listed, disabled without USD prim paths;
 *  - a result with placements written without geometry says so;
 *  - Apply: the entry only for a provider with `apply`; choosing a file runs
 *    `preview` (nothing else), the dialog shows the counters and the loss list,
 *    `commit` runs only on the click and with exactly the confirmation shown;
 *    Cancel commits nothing; extras-wipe explicitly confirms missing data removal, ambiguous no
 *    apply at all; a document-switched result says "Written — open the
 *    document to see it" (LOP #180);
 *  - both dialogs live in a lazily loaded module (plan-764 "Lazy-Apply-Dialog"):
 *    a module that fails to load is reported in the card's message dialog,
 *    nothing is previewed, committed or exported, and the next attempt loads
 *    again.
 *
 * Renderer-free like `document-card.test.tsx`: a hand-built view is the whole
 * environment, and `sceneFileExports` is exercised with a stub store and a
 * private registry so the global one stays empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentCard, setFileExportDialogsLoaderForTests } from '../src/core/hmi/scene/DocumentCard';
import { describeApplyCommitResult, describeFileExportResult } from '../src/core/hmi/scene/DocumentFileExportDialogs';
import {
  resetActiveDocumentViewForTests,
  setActiveDocumentView,
  type ActiveDocumentFileExport,
  type ActiveDocumentView,
} from '../src/core/editor/active-document-view';
import { setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import {
  ExportProviderRegistry,
  type ApplyCommitResult,
  type ApplyPreview,
  type DocumentExportContext,
  type DocumentExportProvider,
} from '../src/core/export/rv-export-provider';
import { sceneFileExports } from '../src/core/hmi/scene/scene-document-view';
import type { SceneStore } from '../src/core/hmi/scene/scene-store';

// ─── Doubles ────────────────────────────────────────────────────────────

function makeView(actions: Partial<ActiveDocumentView['actions']> = {}): ActiveDocumentView {
  return {
    name: 'Line 2',
    crumbs: [{ index: 0, label: 'Line 2', occurrence: '', referenceNodeId: null, dirty: false, stale: false, current: true }],
    dirty: false,
    busy: false,
    stackDirty: false,
    stale: false,
    saveVerb: 'save',
    sourceMode: 'planner',
    actions: {
      save: async () => ({ status: 'saved' }),
      exportGlb: { run: async () => new Uint8Array([1, 2, 3]), fileName: 'Line 2.glb' },
      ...actions,
    },
  };
}

function mount(view: ActiveDocumentView): void {
  setActiveDocumentView(view);
  render(<DocumentCard variant="hero" activeMode="planner" />);
}

function openMenu(): void {
  fireEvent.click(screen.getByLabelText('More actions'));
}

/** A USD-like provider whose modes follow the context, like the real one. */
function usdLikeProvider(run = vi.fn()): DocumentExportProvider {
  return {
    id: 'usd',
    label: 'Export USD…',
    modes: (ctx) => [
      { id: 'standalone', label: 'Complete scene (.usdz)', fileName: `${ctx.documentName}.usdz`, mime: 'model/vnd.usdz+zip' },
      {
        id: 'overlay', label: 'realvirtual data layer (.rv.usda)', fileName: `${ctx.documentName}.rv.usda`, mime: 'model/vnd.usda',
        ...(!ctx.hasUsdPrimPaths() ? { disabledReason: 'Only for documents imported from USD.' } : {}),
      },
    ],
    preflight: async (_ctx, modeId) => ({ referencesWithoutGeometry: modeId === 'standalone' ? 2 : 0 }),
    run: async (ctx, modeId) => {
      run(ctx, modeId);
      const bytes = await ctx.documentGlb();
      return {
        bytes,
        fileName: modeId === 'overlay' ? `${ctx.documentName}.rv.usda` : `${ctx.documentName}.usdz`,
        mime: modeId === 'overlay' ? 'model/vnd.usda' : 'model/vnd.usdz+zip',
        stats: { referencesWithoutGeometry: modeId === 'standalone' ? 2 : 0 },
      };
    },
  };
}

function stubStore(hasUsdPrimPaths: boolean): SceneStore {
  return {
    exportSceneGlb: vi.fn(async () => new Uint8Array([7, 7, 7])),
    documentExportFacts: () => ({ documentId: 'doc-1', documentPath: 'Line 2.glb', revision: 'rev-9', hasUsdPrimPaths }),
  } as unknown as SceneStore;
}

/** The bound exports exactly as scene-document-view builds them, from a private registry. */
function boundExports(hasUsdPrimPaths: boolean, run = vi.fn()): { exports: ActiveDocumentFileExport[]; store: SceneStore } {
  const registry = new ExportProviderRegistry();
  registry.register(usdLikeProvider(run));
  const store = stubStore(hasUsdPrimPaths);
  return { exports: sceneFileExports(store, 'Line_2', registry).exports!, store };
}

// ─── Download capture ───────────────────────────────────────────────────

let downloads: Array<{ name: string; type: string }>;
let blobs: Map<string, Blob>;

beforeEach(() => {
  downloads = [];
  blobs = new Map();
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    const url = `blob:test-${n++}`;
    blobs.set(url, b as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, type: blobs.get(this.href)?.type ?? '' });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetActiveDocumentViewForTests();
  setOpenDocumentBase(null);
  setFileExportDialogsLoaderForTests(null);
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('DocumentCard export — no provider', () => {
  it('shows only "Export .glb…" with the unchanged test id', () => {
    mount(makeView());
    openMenu();
    expect(screen.getByTestId('document-card-verb-export-glb').textContent).toContain('Export .glb');
    expect(screen.queryByTestId('document-card-verb-export-usd')).toBeNull();
  });

  it('sceneFileExports adds no field at all while nothing is registered', () => {
    expect(sceneFileExports(stubStore(false), 'x', new ExportProviderRegistry())).toEqual({});
  });
});

describe('DocumentCard export — with a provider', () => {
  it('lists the provider beside GLB and downloads with its MIME type and file name', async () => {
    const { exports } = boundExports(false);
    mount(makeView({ exports }));
    openMenu();
    expect(screen.getByTestId('document-card-verb-export-glb')).toBeTruthy();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));

    // The data layer remains visible even without USD prim paths.
    expect(await screen.findByTestId('document-card-export-mode-standalone')).toBeTruthy();
    expect(screen.getByTestId('document-card-export-mode-overlay')).toBeDisabled();
    expect(screen.getByText('Only for documents imported from USD.')).toBeVisible();
    expect(screen.getByText('Line_2.usdz')).toBeTruthy();

    await waitFor(() => expect(screen.getByTestId('document-card-export-run')).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByTestId('document-card-export-run')); });
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ name: 'Line_2.usdz', type: 'model/vnd.usdz+zip' });
  });

  it('reports placements exported without geometry', async () => {
    const { exports } = boundExports(false);
    mount(makeView({ exports }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));
    await screen.findByTestId('document-card-export-run');
    expect(await screen.findByText('2 placements will be exported without geometry.')).toBeVisible();
    await act(async () => { fireEvent.click(screen.getByTestId('document-card-export-run')); });
    expect(await screen.findByText(/2 placements exported without geometry/)).toBeTruthy();
  });

  it('enables the data layer when the document has USD prim paths, and downloads the chosen mode', async () => {
    const run = vi.fn();
    const { exports } = boundExports(true, run);
    mount(makeView({ exports }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));
    const overlay = await screen.findByTestId('document-card-export-mode-overlay');
    fireEvent.click(overlay);
    await waitFor(() => expect(screen.getByTestId('document-card-export-run')).toBeEnabled());
    await act(async () => { fireEvent.click(screen.getByTestId('document-card-export-run')); });
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]).toEqual({ name: 'Line_2.rv.usda', type: 'model/vnd.usda' });
    expect(run).toHaveBeenCalledWith(expect.anything(), 'overlay');
    // No placement notice for a result that has none.
    expect(screen.queryByText(/exported without geometry/)).toBeNull();
  });

  it('Cancel never runs the exporter or downloads a file', async () => {
    const run = vi.fn();
    const { exports } = boundExports(false, run);
    mount(makeView({ exports }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));
    fireEvent.click(await screen.findByText('Cancel'));
    expect(run).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('an export failing after the explicit click shows its reason in the message dialog', async () => {
    const failing: ActiveDocumentFileExport = {
      id: 'usd', label: 'Export USD…',
      modes: () => [{ id: 'standalone', label: 'Standalone (.usdz)', fileName: 'x.usdz', mime: 'model/vnd.usdz+zip' }],
      run: async () => { throw new Error('No node mapping for glTF node 3.'); },
    };
    mount(makeView({ exports: [failing] }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));
    await screen.findByTestId('document-card-export-run');
    await act(async () => { fireEvent.click(screen.getByTestId('document-card-export-run')); });
    expect(await screen.findByText('No node mapping for glTF node 3.')).toBeTruthy();
  });
});

describe('scene export context', () => {
  it('binds the cheap preflight to document JSON without exporting document bytes', async () => {
    const documentJson = { scene: 0, scenes: [{ nodes: [] }], nodes: [] };
    const store = stubStore(false);
    store.documentExportJson = vi.fn(async () => documentJson);
    const registry = new ExportProviderRegistry();
    const preflight = vi.fn(async (ctx: DocumentExportContext, _modeId: string) => {
      expect(await ctx.documentJson!()).toBe(documentJson);
      return { referencesWithoutGeometry: 5 };
    });
    registry.register({ ...usdLikeProvider(), preflight });
    const bound = sceneFileExports(store, 'Line_2', registry).exports![0];
    expect(await bound.preflight!('standalone')).toEqual({ referencesWithoutGeometry: 5 });
    expect(preflight).toHaveBeenCalledWith(expect.anything(), 'standalone');
    expect(store.documentExportJson).toHaveBeenCalledTimes(1);
    expect(store.exportSceneGlb).not.toHaveBeenCalled();
  });

  it('reads the authored (non-embedding) bytes and the store facts lazily', async () => {
    let ctx: DocumentExportContext | null = null;
    const registry = new ExportProviderRegistry();
    registry.register({
      ...usdLikeProvider(),
      run: async (c) => { ctx = c; return { bytes: await c.documentGlb(), fileName: 'a', mime: 'b', stats: {} }; },
    });
    const store = stubStore(true);
    const bound = sceneFileExports(store, 'Line_2', registry).exports!;
    await bound[0].run('standalone');
    expect(store.exportSceneGlb).toHaveBeenCalledWith({ embedReferences: false });
    expect(ctx!.documentId).toBe('doc-1');
    expect(ctx!.documentRevision()).toBe('rev-9');
    expect(ctx!.hasUsdPrimPaths()).toBe(true);
    expect(ctx!.documentName).toBe('Line_2');
    // plan-764 Phase 2: the scene writer binds the plan-527 replace sequence.
    expect(ctx!.replaceDocument).toBeTypeOf('function');
  });
});

describe('describeFileExportResult', () => {
  it('says nothing without placements and counts them otherwise', () => {
    expect(describeFileExportResult('a.usdz', {})).toBeNull();
    expect(describeFileExportResult('a.usdz', { referencesWithoutGeometry: 0 })).toBeNull();
    expect(describeFileExportResult('a.usdz', { referencesWithoutGeometry: 1 })).toContain('1 placement exported without geometry');
    expect(describeFileExportResult('a.usdz', { referencesWithoutGeometry: 3 })).toContain('3 placements exported without geometry');
  });

  it('names approximated colours (plan-764 step 3), alone and together with placements', () => {
    expect(describeFileExportResult('a.usdz', { colorsApproximated: 0 })).toBeNull();
    expect(describeFileExportResult('a.usdz', { colorsApproximated: 1 })).toBe(
      'a.usdz: 1 colour approximated (vertex colours the format cannot combine with the material).',
    );
    const both = describeFileExportResult('a.usdz', { referencesWithoutGeometry: 2, colorsApproximated: 3 })!;
    expect(both).toContain('2 placements exported without geometry');
    expect(both).toContain('3 colours approximated');
    expect(both.startsWith('a.usdz: ')).toBe(true);
  });
});

// ─── Apply USD extras (plan-764 Phase 2, §9.6) ──────────────────────────

function previewOf(over: Partial<ApplyPreview> = {}): ApplyPreview {
  return {
    previewToken: 'usdx-1',
    targetRevision: 'rev-9',
    matched: 214,
    unmatchedPrims: ['/Root/Scenes/Scene/A', '/Root/Scenes/Scene/B', '/Root/Scenes/Scene/C'],
    ambiguous: [],
    extrasLost: [],
    warnings: [],
    blocked: null,
    fileName: 'line.usdz',
    schemaVersion: 1,
    documentNodesWithExtras: 214,
    ...over,
  };
}

const OK_COMMIT: ApplyCommitResult = {
  ok: true,
  revision: 'rev-10',
  replace: { ok: true, operationId: 'op', revision: 'rev-10', reloaded: 'open-document', placementsRebaked: 0 },
};

type CommitFn = (token: string, confirm: { acceptExtrasLoss?: boolean; confirmExtrasLost?: boolean }) => Promise<ApplyCommitResult>;

function applyExport(
  preview: ApplyPreview | Error,
  commit: ReturnType<typeof vi.fn<CommitFn>> = vi.fn<CommitFn>(async () => OK_COMMIT),
) {
  const previewFn = vi.fn(async (_file: { name: string; bytes: Uint8Array }) => {
    if (preview instanceof Error) throw preview;
    return preview;
  });
  const exp: ActiveDocumentFileExport = {
    id: 'usd',
    label: 'Export USD…',
    modes: () => [{ id: 'standalone', label: 'Standalone (.usdz)', fileName: 'x.usdz', mime: 'model/vnd.usdz+zip' }],
    run: async () => ({ bytes: new Uint8Array(), fileName: 'x.usdz', mime: 'model/vnd.usdz+zip', stats: {} }),
    apply: { label: 'Apply USD extras…', preview: previewFn, commit },
  };
  return { exp, previewFn, commit };
}

/** The shared flow explains first; the native chooser is stubbed, then a real File is read. */
async function chooseApplyFile(name = 'line.usdz'): Promise<void> {
  fireEvent.click(screen.getByTestId('document-card-verb-apply-usd'));
  fireEvent.click(await screen.findByRole('button', { name: 'Choose USD file…' }));
  const input = await screen.findByTestId('document-card-apply-file') as HTMLInputElement;
  const f = new File([new Uint8Array([1, 2, 3])], name);
  await act(async () => { fireEvent.change(input, { target: { files: [f] } }); });
}

describe('DocumentCard — Apply USD extras', () => {
  beforeEach(() => {
    // The native file chooser is not part of the test — the change event is.
    const click = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      if (this.type === 'file') return;
      click.call(this);
    });
  });

  it('shows no apply entry for a provider without apply', () => {
    const { exports } = boundExports(false);
    mount(makeView({ exports }));
    openMenu();
    expect(screen.queryByTestId('document-card-verb-apply-usd')).toBeNull();
    expect(screen.queryByTestId('document-card-apply-file')).toBeNull();
  });

  it('choosing a file runs preview only; the dialog shows counts and the loss list; commit only on the click', async () => {
    const lost = ['Cell/Robot/Gripper', 'Cell/Conveyor 2', 'Cell/Sensor.A', 'Cell/Robot', 'Ref 1'];
    const { exp, previewFn, commit } = applyExport(previewOf({ extrasLost: lost }));
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();

    // The card reads the file with `file.arrayBuffer()` — a real Blob read in
    // the browser that act() does not drain — before it calls preview; wait for
    // it like the other cases wait for the dialog (the dialog proves nothing
    // about preview's arguments, so it is awaited explicitly here).
    await waitFor(() => expect(previewFn).toHaveBeenCalledTimes(1));
    expect(previewFn.mock.calls[0][0]).toMatchObject({ name: 'line.usdz' });
    expect(Array.from(previewFn.mock.calls[0][0].bytes)).toEqual([1, 2, 3]);
    expect(commit).not.toHaveBeenCalled();
    expect((await screen.findByTestId('document-card-apply-counts')).textContent)
      .toBe('214 nodes matched · 3 prims unmatched');
    expect(screen.getByText(/rvSchemaVersion 1/)).toBeTruthy();
    expect(screen.getByText('5 nodes lose their realvirtual data:')).toBeTruthy();
    const list = screen.getByTestId('document-card-apply-lost');
    for (const p of lost) expect(list.textContent).toContain(p);
    expect(screen.queryByTestId('document-card-apply-anyway')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByTestId('document-card-apply-run')); });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('usdx-1', { confirmExtrasLost: true });
    expect(await screen.findByText('Applied the realvirtual data of line.usdz.')).toBeTruthy();
  });

  it('Cancel commits nothing', async () => {
    const { exp, commit } = applyExport(previewOf());
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    fireEvent.click(await screen.findByTestId('document-card-apply-cancel'));
    expect(commit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('document-card-apply-dialog')).toBeNull());
  });

  it('no loss: Apply commits without any confirmation flag', async () => {
    const { exp, commit } = applyExport(previewOf());
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    const run = await screen.findByTestId('document-card-apply-run');
    await act(async () => { fireEvent.click(run); });
    expect(commit).toHaveBeenCalledWith('usdx-1', {});
  });

  it('extras-wipe: the blocked dialog explicitly confirms removal (acceptExtrasLoss)', async () => {
    const { exp, commit } = applyExport(previewOf({
      blocked: 'extras-wipe', matched: 0, unmatchedPrims: [], extrasLost: ['Cell', '<scene>'],
    }));
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    expect((await screen.findByTestId('document-card-apply-wipe')).textContent)
      .toContain('line.usdz carries no realvirtual data at all, the document has 214 nodes with data.');
    expect(screen.getByText(/Apply realvirtual data from USD — blocked/)).toBeTruthy();
    expect(screen.queryByTestId('document-card-apply-run')).toBeNull();
    const anyway = screen.getByTestId('document-card-apply-anyway');
    expect(anyway.textContent).toBe('Apply and remove missing data');
    await act(async () => { fireEvent.click(anyway); });
    expect(commit).toHaveBeenCalledWith('usdx-1', { acceptExtrasLoss: true, confirmExtrasLost: true });
  });

  it('ambiguous: the list is shown and there is no way to apply', async () => {
    const { exp, commit } = applyExport(previewOf({
      blocked: 'ambiguous', ambiguous: ['/Root/Scenes/Scene/A, /Root/Scenes/Scene/B: 2 prims claim the document node "A"'],
    }));
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    expect((await screen.findByTestId('document-card-apply-ambiguous')).textContent).toContain('2 prims claim');
    expect(screen.queryByTestId('document-card-apply-run')).toBeNull();
    expect(screen.queryByTestId('document-card-apply-anyway')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('a document switched during the replace: "Written — open the document to see it"', async () => {
    const commit = vi.fn<CommitFn>(async () => ({
      ok: true,
      revision: 'rev-10',
      replace: {
        ok: true, operationId: 'op', revision: 'rev-10', reloaded: 'none',
        reloadSkipped: 'document-switched', placementsRebaked: 0,
      },
    }));
    const { exp } = applyExport(previewOf(), commit);
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    const run = await screen.findByTestId('document-card-apply-run');
    await act(async () => { fireEvent.click(run); });
    expect(await screen.findByText(/Written — open the document to see it/)).toBeTruthy();
  });

  it('a guard error of the preview lands in the message dialog, no apply dialog', async () => {
    const { exp, commit } = applyExport(new Error('customData.realvirtual cannot be read (line.usdz, layer line.rv.usda, prim /Root/X)'));
    mount(makeView({ exports: [exp] }));
    openMenu();
    await chooseApplyFile();
    expect(await screen.findByText(/prim \/Root\/X/)).toBeTruthy();
    expect(screen.queryByTestId('document-card-apply-dialog')).toBeNull();
    expect(commit).not.toHaveBeenCalled();
  });

  it('sceneFileExports binds the provider apply to the scene context', async () => {
    const registry = new ExportProviderRegistry();
    const seen: Array<{ ctx: DocumentExportContext; token?: string }> = [];
    registry.register({
      ...usdLikeProvider(),
      apply: {
        label: 'Apply USD extras…',
        preview: async (ctx) => { seen.push({ ctx }); return previewOf(); },
        commit: async (ctx, token) => { seen.push({ ctx, token }); return OK_COMMIT; },
      },
    });
    const bound = sceneFileExports(stubStore(false), 'Line_2', registry).exports!;
    expect(bound[0].apply?.label).toBe('Apply USD extras…');
    await bound[0].apply!.preview({ name: 'a.usdz', bytes: new Uint8Array() });
    await bound[0].apply!.commit('usdx-1', {});
    expect(seen.map((s) => s.ctx.documentId)).toEqual(['doc-1', 'doc-1']);
    expect(seen[1].token).toBe('usdx-1');
  });
});

describe('describeApplyCommitResult', () => {
  it('names the cause of every outcome', () => {
    expect(describeApplyCommitResult('a.usdz', OK_COMMIT)).toBe('Applied the realvirtual data of a.usdz.');
    expect(describeApplyCommitResult('a.usdz', { ok: false, code: 'stale-preview' })).toMatch(/changed since the preview/);
    expect(describeApplyCommitResult('a.usdz', {
      ok: false, code: 'replace-failed',
      replace: { ok: false, operationId: 'op', reason: 'local-changes', detail: 'Save or discard them first.' },
    })).toBe('Not applied (local-changes): Save or discard them first.');
  });
});

// ─── Lazy dialog module (plan-764 "Lazy-Apply-Dialog") ──────────────────

describe('DocumentCard — the dialog module fails to load', () => {
  const chunkError = () => new TypeError('Failed to fetch dynamically imported module: /assets/DocumentFileExportDialogs-x.js');

  beforeEach(() => {
    const click = HTMLInputElement.prototype.click;
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      if (this.type === 'file') return;
      click.call(this);
    });
  });

  it('apply: the card says so, and nothing is previewed or committed', async () => {
    setFileExportDialogsLoaderForTests(() => Promise.reject(chunkError()));
    const { exp, previewFn, commit } = applyExport(previewOf());
    mount(makeView({ exports: [exp] }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-apply-usd'));
    expect(await screen.findByText(/The apply dialog could not be loaded \(Failed to fetch dynamically imported module/)).toBeTruthy();
    expect(screen.queryByTestId('document-card-apply-dialog')).toBeNull();
    expect(previewFn).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it('export: the card says so, and nothing is exported', async () => {
    setFileExportDialogsLoaderForTests(() => Promise.reject(chunkError()));
    const run = vi.fn();
    const { exports } = boundExports(false, run);
    mount(makeView({ exports }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-export-usd'));
    expect(await screen.findByText(/The export dialog could not be loaded/)).toBeTruthy();
    expect(screen.queryByTestId('document-card-export-run')).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(downloads).toHaveLength(0);
  });

  it('a failed load is not cached: the next attempt loads again and opens the dialog', async () => {
    let calls = 0;
    setFileExportDialogsLoaderForTests(() => {
      calls++;
      return calls === 1 ? Promise.reject(chunkError()) : import('../src/core/hmi/scene/DocumentFileExportDialogs');
    });
    const { exp } = applyExport(previewOf());
    mount(makeView({ exports: [exp] }));
    openMenu();
    fireEvent.click(screen.getByTestId('document-card-verb-apply-usd'));
    expect(await screen.findByText(/The apply dialog could not be loaded/)).toBeTruthy();
    fireEvent.click(screen.getByText('Close'));
    openMenu();
    await chooseApplyFile();
    expect(await screen.findByTestId('document-card-apply-dialog')).toBeTruthy();
    expect(calls).toBe(2);
  });
});
