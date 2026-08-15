// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * selection→asset resolution (plan-410 F1).
 *
 * Two layers:
 *  - the registry itself (first non-null wins, unregister, throwing resolver),
 *  - and the TIMING, against a REAL {@link ModeManager}: the resolution has to
 *    happen on `mode-changing`, because the planner clears its selection in its
 *    own deactivate hook — which runs before the editor is ever activated
 *    (review finding R1-1). A mocked hook order would prove nothing here, so
 *    this drives the actual manager with a real deactivate hook.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModeManager, type ModeHost, type ModePluginSets } from '../src/core/rv-mode-manager';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import {
  registerSelectionAssetResolver,
  resolveSelectionToAsset,
  _clearSelectionAssetResolvers,
} from '@rv-private/plugins/asset-editor/selection-asset-resolver';
import { libraryDocumentBase, projectDocumentBase } from '../src/core/editor/active-asset-store';
import {
  peekPendingAssetOpen,
  setPendingAssetOpen,
  takePendingAssetOpen,
} from '@rv-private/plugins/asset-editor/pending-open-store';

const BELT: AssetBase = projectDocumentBase('library/Custom/Belt.glb', 'Belt');

beforeEach(() => {
  _clearSelectionAssetResolvers();
  takePendingAssetOpen();
  try { localStorage.removeItem('rv-active-mode'); } catch { /* ignore */ }
});

describe('selection-asset-resolver registry', () => {
  it('returns the first non-null answer', () => {
    registerSelectionAssetResolver(() => null);
    registerSelectionAssetResolver(() => BELT);
    registerSelectionAssetResolver(() => (libraryDocumentBase('x')));
    expect(resolveSelectionToAsset('Plant/Belt')).toEqual(BELT);
  });

  it('returns null when nobody recognises the path', () => {
    registerSelectionAssetResolver(() => null);
    expect(resolveSelectionToAsset('Plant/SomeHmiNode')).toBeNull();
  });

  it('unregister removes the resolver', () => {
    const off = registerSelectionAssetResolver(() => BELT);
    expect(resolveSelectionToAsset('p')).toEqual(BELT);
    off();
    expect(resolveSelectionToAsset('p')).toBeNull();
  });

  it('a throwing resolver is skipped, not propagated (it runs inside a mode switch)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerSelectionAssetResolver(() => { throw new Error('boom'); });
    registerSelectionAssetResolver(() => BELT);
    expect(resolveSelectionToAsset('p')).toEqual(BELT);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ─── Timing against a real ModeManager ────────────────────────────────────

/**
 * Wire a real ModeManager to a real event bus, a selection that a real planner
 * deactivate hook clears, and the editor's `mode-changing` listener.
 */
function makeWorkspace(opts: { selectedPath: string | null }) {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const selection = { primaryPath: opts.selectedPath };
  const order: string[] = [];

  const emit = (event: string, data: unknown): void => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(data);
  };
  const on = (event: string, fn: (d: unknown) => void): (() => void) => {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(fn);
    return () => { set!.delete(fn); };
  };

  // Stands in for the layout planner: clears the selection when it is
  // deactivated (index.ts `setActive(false)` does exactly this).
  const planner: RVViewerPlugin = {
    id: 'layout-planner',
    modes: ['planner'],
    init: () => {},
    onModeDeactivate: () => {
      order.push('planner-deactivate');
      selection.primaryPath = null;
    },
  } as unknown as RVViewerPlugin;

  const viewer = { selectionManager: selection } as unknown as RVViewer;

  const host: ModeHost = {
    viewer,
    pluginsForMode: (from, to): ModePluginSets => ({
      enable: [],
      disable: [],
      activateHooks: [],
      deactivateHooks: from === 'planner' && to !== 'planner' ? [planner] : [],
    }),
    enablePlugin: () => {},
    disablePlugin: () => {},
    callPlugin: (p, method) => {
      (p as unknown as Record<string, () => void>)[method]?.();
    },
    setContext: () => {},
    emit: (event, data) => emit(event, data),
  };

  const modes = new ModeManager(host);
  modes.register({ id: 'planner', label: 'Planner' });
  modes.register({ id: 'editor', label: 'Editor', runtime: 'detached' });

  // The AssetEditorPlugin's listener, verbatim (index.ts init()).
  on('mode-changing', (data) => {
    const { to } = data as { to: string };
    if (to !== 'editor') return;
    order.push('resolve');
    if (peekPendingAssetOpen()) return;
    const path = selection.primaryPath;
    if (!path) return;
    const base = resolveSelectionToAsset(path);
    if (base) setPendingAssetOpen(base);
  });

  return { modes, selection, order };
}

describe('selection→editor timing (real ModeManager)', () => {
  it('resolves the selection although the planner clears it in its deactivate hook', async () => {
    registerSelectionAssetResolver((p) => (p === 'Plant/Belt_1/Mesh' ? BELT : null));
    const ws = makeWorkspace({ selectedPath: 'Plant/Belt_1/Mesh' });
    ws.modes.setMode('planner');

    expect(await ws.modes.requestMode('editor')).toBe(true);

    // The hook DID clear the selection — and the resolution still happened,
    // because it ran first.
    expect(ws.selection.primaryPath).toBeNull();
    expect(ws.order).toEqual(['resolve', 'planner-deactivate']);
    expect(takePendingAssetOpen()).toEqual(BELT);
  });

  it('an explicit "Edit asset" request always wins over the selection', async () => {
    const explicit: AssetBase = projectDocumentBase('library/Custom/Chosen.glb', 'Chosen');
    registerSelectionAssetResolver(() => BELT);
    const ws = makeWorkspace({ selectedPath: 'Plant/Belt_1/Mesh' });
    ws.modes.setMode('planner');

    setPendingAssetOpen(explicit);
    await ws.modes.requestMode('editor');

    expect(takePendingAssetOpen()).toEqual(explicit);
  });

  it('an unresolvable selection leaves no pending request (→ last-edited fallback)', async () => {
    registerSelectionAssetResolver(() => null);
    const ws = makeWorkspace({ selectedPath: 'Plant/SomeHmiNode' });
    ws.modes.setMode('planner');

    await ws.modes.requestMode('editor');

    expect(takePendingAssetOpen()).toBeNull();
  });

  it('switching to a NON-editor mode never sets a pending request', async () => {
    registerSelectionAssetResolver(() => BELT);
    const ws = makeWorkspace({ selectedPath: 'Plant/Belt_1/Mesh' });
    // Entering the editor legitimately resolves the selection — consume that
    // handoff so the assertion below is about the planner switch alone.
    ws.modes.setMode('editor');
    expect(takePendingAssetOpen()).toEqual(BELT);

    await ws.modes.requestMode('planner');

    expect(takePendingAssetOpen()).toBeNull();
  });
});

// ─── The planner's own mapping ────────────────────────────────────────────

describe('planner placement → AssetBase mapping', () => {
  /**
   * The mapping the planner registers, exercised through the same shape its
   * real implementation uses: walk up to the placement root, placement →
   * catalogId → entry.localPath → AssetBase.
   */
  function makePlannerResolver(opts: {
    nodes: Record<string, { parentPath: string | null }>;
    placementIdByPath: Record<string, string>;
    placed: Array<{ id: string; catalogId: string; splatUrl?: string }>;
    entries: Array<{ id: string; localPath?: string; glbUrl?: string; splatUrl?: string; virtual?: boolean }>;
  }) {
    return (primaryPath: string): AssetBase | null => {
      if (!opts.nodes[primaryPath]) return null;
      let placementId: string | null = null;
      for (let p: string | null = primaryPath; p; p = opts.nodes[p]?.parentPath ?? null) {
        if (opts.placementIdByPath[p]) { placementId = opts.placementIdByPath[p]; break; }
      }
      if (!placementId) return null;
      const placed = opts.placed.find((c) => c.id === placementId);
      if (!placed || placed.splatUrl) return null;
      const entry = opts.entries.find((e) => e.id === placed.catalogId);
      const localPath = entry?.localPath;
      if (!entry || !localPath || !entry.glbUrl || entry.splatUrl) return null;
      if (entry.virtual || localPath.startsWith('splats/')) return null;
      return libraryDocumentBase(localPath);
    };
  }

  const base = {
    nodes: {
      'Layout/Belt_1': { parentPath: null },
      'Layout/Belt_1/Frame': { parentPath: 'Layout/Belt_1' },
      'Layout/Belt_1/Frame/Mesh': { parentPath: 'Layout/Belt_1/Frame' },
    },
    placementIdByPath: { 'Layout/Belt_1': 'pl-1' },
    placed: [{ id: 'pl-1', catalogId: 'cat-belt' }],
    entries: [{ id: 'cat-belt', localPath: 'Custom/Belt.glb', glbUrl: 'blob:x' }],
  };

  it('resolves a deep sub-mesh up to its placement root', () => {
    const resolve = makePlannerResolver(base);
    expect(resolve('Layout/Belt_1/Frame/Mesh')).toEqual(libraryDocumentBase('Custom/Belt.glb'));
  });

  it('returns null for a splat placement', () => {
    const resolve = makePlannerResolver({
      ...base,
      placed: [{ id: 'pl-1', catalogId: 'cat-belt', splatUrl: 'blob:s' }],
    });
    expect(resolve('Layout/Belt_1')).toBeNull();
  });

  it('returns null for a virtual (DES) catalog entry', () => {
    const resolve = makePlannerResolver({
      ...base,
      entries: [{ id: 'cat-belt', localPath: 'Custom/X.glb', glbUrl: '', virtual: true }],
    });
    expect(resolve('Layout/Belt_1')).toBeNull();
  });

  it('returns null for an entry without a local path (cloud/provider asset)', () => {
    const resolve = makePlannerResolver({
      ...base,
      entries: [{ id: 'cat-belt', glbUrl: 'https://example/x.glb' }],
    });
    expect(resolve('Layout/Belt_1')).toBeNull();
  });

  it('returns null for a node that is not part of any placement', () => {
    const resolve = makePlannerResolver({
      ...base,
      nodes: { ...base.nodes, 'Scene/Floor': { parentPath: null } },
    });
    expect(resolve('Scene/Floor')).toBeNull();
  });
});
