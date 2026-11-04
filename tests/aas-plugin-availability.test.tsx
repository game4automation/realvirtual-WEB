// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-682 Phase 1 (§9.1) — AasLinkPlugin and OrderManagerPlugin are core
 * plugins: available in every delivery with AAS links, self-gated, and their
 * model work runs AFTER model packs rewrote / attached AAS links.
 *
 * Driven through the viewer's REAL plugin dispatcher (`createCoreViewer`,
 * plan-435 harness) plus a tiny event bus for `on` / `emit`, so `model-loaded`
 * fires after every `onModelLoaded` exactly as in `RVViewer.loadModel`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Object3D } from 'three';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { createCoreViewer, resetModeStorage } from './helpers/core-toggle-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewerPlugin } from '../src/core/rv-plugin';
import { AasDocumentGroups, AasLinkPlugin, AasTooltipContent } from '../src/plugins/aas-link-plugin';
import type { AasDocument } from '../src/plugins/aas-link-parser';
import {
  OrderManagerPlugin,
  _resetOrderStore,
  isCartAvailable,
} from '../src/plugins/order-manager-plugin';
import {
  AAS_RESOLUTION_KEY,
  installAasResolution,
  resetAasResolution,
} from '../src/plugins/aas-resolution';
import { resetCache, resetIndex } from '../src/plugins/aas-link-parser';
import { resetAasSources } from '../src/core/aas/rv-aas-source';
import {
  _resetStore as resetUIContexts,
  activateContext,
  deactivateContext,
  registerUIElement,
} from '../src/core/hmi/ui-context-store';
import { ORDER_PANEL_GATE } from '../src/core/hmi/left-panel-visibility';

const ID_A = 'urn:test:a';
const ID_B = 'urn:test:b';

// ─── Harness ────────────────────────────────────────────────────────────

/** createCoreViewer + an event bus + a scene, model loads like loadModel. */
function harness() {
  const h = createCoreViewer();
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const scene = new Object3D();
  const leftPanelOpen = vi.fn();
  const panelSnap = { activePanel: null };
  const internals = h.internals as unknown as Record<string, unknown>;
  Object.assign(internals, {
    scene,
    projectAssetsPath: '/t/',
    _pluginContext: { forPlugin: () => ({}) },
    contextMenu: { register: vi.fn(), unregister: vi.fn() },
    leftPanelManager: { open: leftPanelOpen, toggle: vi.fn(), subscribe: () => () => {}, getSnapshot: () => panelSnap },
    highlighter: { clear: vi.fn(), highlightMultiple: vi.fn() },
    on: (ev: string, fn: (p: unknown) => void) => {
      if (!handlers.has(ev)) handlers.set(ev, new Set());
      handlers.get(ev)!.add(fn);
      return () => { handlers.get(ev)?.delete(fn); };
    },
    emit: (ev: string, p?: unknown) => { for (const fn of [...(handlers.get(ev) ?? [])]) fn(p); },
  });
  const viewer = h.viewer;
  const emit = internals.emit as (ev: string, p?: unknown) => void;
  const count = (ev: string) => handlers.get(ev)?.size ?? 0;

  // What main.ts does at boot: central resolution first, then the core plugins.
  installAasResolution(viewer as never);

  const load = async (root: Object3D, plugins?: string[]): Promise<LoadResult> => {
    scene.clear();
    scene.add(root);
    const result = { root, modelConfig: { plugins } } as unknown as LoadResult;
    (h.internals as unknown as { _lastLoadResult: LoadResult })._lastLoadResult = result;
    await h.internals._notifyPluginsModelLoaded(result);
    emit('model-loaded', { result });
    return result;
  };
  const clear = () => {
    h.internals._notifyPluginsModelCleared();
    emit('model-cleared');
    (h.internals as unknown as { _lastLoadResult: LoadResult | null })._lastLoadResult = null;
  };
  return { ...h, viewer, scene, load, clear, emit, count, leftPanelOpen };
}

function linkNode(aasId: string, name = 'Motor'): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData._rvAasLink = { aasId, description: 'Motor' };
  return n;
}

/** Index served at /t/aasx/index.json — entries keyed by AAS id. */
function mockIndex(entries: Record<string, { file: string; idShort: string; productName?: string }>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith('/t/aasx/index.json')) return new Response(JSON.stringify(entries));
    return new Response(null, { status: 404 });
  });
}

const searchText = (n: Object3D) => (n.userData._rvAasLink as { searchText?: string }).searchText;

beforeEach(() => {
  resetModeStorage();
  resetIndex();
  resetCache();
  resetAasSources();
  resetAasResolution();
  resetUIContexts();
  _resetOrderStore();
  try { sessionStorage.clear(); } catch { /* unavailable */ }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Registration ───────────────────────────────────────────────────────

describe('core registration', () => {
  it('should register aas-link and order-manager as core plugins on a viewer booted without any model pack', () => {
    const h = harness();
    h.viewer.use(new AasLinkPlugin(), 'core').use(new OrderManagerPlugin(), 'core');
    expect(h.viewer.getPlugin('aas-link')).toBeDefined();
    expect(h.viewer.getPlugin('order-manager')).toBeDefined();
    expect((h.viewer.getPlugin('aas-link') as RVViewerPlugin).core).toBe(true);
    expect((h.viewer.getPlugin('order-manager') as RVViewerPlugin).core).toBe(true);
  });

  it('should keep both core plugins after a model pack that previously registered them is unloaded', () => {
    const h = harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.viewer.use(new AasLinkPlugin(), 'core').use(new OrderManagerPlugin(), 'core');
    // A legacy pack: registers the same ids again and removes "its" ids on unload.
    const packIds: string[] = [];
    for (const p of [new AasLinkPlugin(), new OrderManagerPlugin()]) { h.viewer.use(p); packIds.push(p.id); }
    for (const id of packIds) h.viewer.removePlugin(id);
    expect(h.viewer.getPlugin('aas-link')).toBeDefined();
    expect(h.viewer.getPlugin('order-manager')).toBeDefined();
    warn.mockRestore();
  });
});

// ─── Ordering (F5) and selective mode ──────────────────────────────────

describe('model work ordering', () => {
  it("should run a pack's AAS rewrite before the AAS pre-resolution and index metadata (F5)", async () => {
    mockIndex({ [ID_B]: { file: 'b.aasx', idShort: 'B', productName: 'Swapped' } });
    const h = harness();
    h.viewer.use(new AasLinkPlugin(), 'core');
    // A model pack registers AFTER the core plugins and rewrites A → B in its
    // own onModelLoaded (the demo supplier swap).
    const rewriter: RVViewerPlugin = {
      id: 'pack-rewriter',
      onModelLoaded: (r) => { ((r.root as Object3D).children[0].userData._rvAasLink as { aasId: string }).aasId = ID_B; },
    };
    h.viewer.use(rewriter);
    const root = new Object3D();
    const node = linkNode(ID_A);
    root.add(node);
    await h.load(root);
    await vi.waitFor(() => expect(node.userData[AAS_RESOLUTION_KEY]).toBe('resolved'));
    await vi.waitFor(() => expect(searchText(node)).toBe('Swapped B'));
  });

  it.each([
    ['rv_plugins: []', [] as string[]],
    ['an explicit list', ['listed-dummy']],
  ])('should deliver onModelLoaded to both plugins with %s (selective mode)', async (_label, plugins) => {
    mockIndex({});
    const h = harness();
    h.viewer.use(new AasLinkPlugin(), 'core').use(new OrderManagerPlugin(), 'core');
    h.viewer.use({ id: 'listed-dummy', onModelLoaded: () => {} });
    await h.load(new Object3D(), plugins);
    expect(h.internals._modelLoadedIds.has('aas-link')).toBe(true);
    expect(h.internals._modelLoadedIds.has('order-manager')).toBe(true);
  });

  it('should keep both plugins working across a model switch (pack A → pack-less model → pack A)', async () => {
    mockIndex({ [ID_A]: { file: 'a.aasx', idShort: 'A', productName: 'Alpha' } });
    const h = harness();
    h.viewer.use(new AasLinkPlugin(), 'core').use(new OrderManagerPlugin(), 'core');
    const loadWith = async () => { const r = new Object3D(); const n = linkNode(ID_A); r.add(n); await h.load(r); return n; };
    const n1 = await loadWith();
    await vi.waitFor(() => expect(searchText(n1)).toBe('Alpha A'));
    h.clear();
    await h.load(new Object3D());
    h.clear();
    const n3 = await loadWith();
    await vi.waitFor(() => expect(searchText(n3)).toBe('Alpha A'));
    expect(h.internals._modelLoadedIds.has('order-manager')).toBe(true);
  });

  it('should run model work after pack rewrites, replay it on onActivate, and drop it after onModelCleared/onDeactivate', async () => {
    mockIndex({ [ID_A]: { file: 'a.aasx', idShort: 'A', productName: 'Alpha' } });
    const h = harness();
    const plugin = new AasLinkPlugin();
    h.viewer.use(plugin, 'core');
    const baseline = h.count('model-loaded');

    // A load that is still in progress when the plugin is switched off: the
    // deferred work must never run and its listener must be gone.
    const root = new Object3D();
    const node = linkNode(ID_A);
    root.add(node);
    const result = { root, modelConfig: {} } as unknown as LoadResult;
    plugin.onModelLoaded(result, h.viewer);
    expect(h.count('model-loaded')).toBe(baseline + 1);
    plugin.onDeactivate();
    expect(h.count('model-loaded')).toBe(baseline);
    h.scene.add(root);
    h.emit('model-loaded', { result });
    await new Promise(r => setTimeout(r, 20));
    expect(searchText(node)).toBeUndefined();

    // Replay: the model is fully loaded now, onActivate runs the work at once.
    (h.internals as unknown as { _lastLoadResult: LoadResult })._lastLoadResult = result;
    plugin.onActivate(h.viewer);
    expect(h.count('model-loaded')).toBe(baseline);
    await vi.waitFor(() => expect(searchText(node)).toBe('Alpha A'));

    // onModelCleared drops a pending index answer of the old model.
    delete (node.userData._rvAasLink as { searchText?: string }).searchText;
    plugin.onActivate(h.viewer);
    plugin.onModelCleared();
    await new Promise(r => setTimeout(r, 20));
    expect(searchText(node)).toBeUndefined();
    expect(h.count('model-loaded')).toBe(baseline);
  });
});

// ─── UI gates (F2, F3, RR4) ─────────────────────────────────────────────

describe('UI gates', () => {
  function setup(resolution: string | null) {
    const h = harness();
    const aas = new AasLinkPlugin();
    const order = new OrderManagerPlugin();
    h.viewer.use(aas, 'core').use(order, 'core');
    if (resolution) {
      const n = linkNode(ID_A);
      n.userData[AAS_RESOLUTION_KEY] = resolution;
      h.scene.add(n);
    }
    const AasButton = aas.slots[0].component;
    const CartButton = order.slots[0].component;
    const ui = () => render(
      <ThemeProvider theme={rvDarkTheme}>
        <RVViewerProvider value={h.viewer as never}>
          <AasButton viewer={h.viewer as never} />
          <CartButton viewer={h.viewer as never} />
        </RVViewerProvider>
      </ThemeProvider>,
    );
    return { h, aas, order, ui };
  }

  it('should hide AasButton and OrderManagerButton when no resolvable AAS link exists', () => {
    const { ui } = setup('unknown-id');
    ui();
    expect(screen.queryByLabelText('AAS Components')).toBeNull();
    expect(screen.queryByLabelText('Order Cart')).toBeNull();
  });

  it('should show both buttons with a resolvable AAS link', () => {
    const { ui } = setup('resolved');
    ui();
    expect(screen.getByLabelText('AAS Components')).toBeInTheDocument();
    expect(screen.getByLabelText('Order Cart')).toBeInTheDocument();
  });

  it('should show the cart action in the pinned AAS tooltip when an AAS link resolves', () => {
    mockIndex({});
    const { h } = setup('resolved');
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasTooltipContent
          data={{ type: 'aas', aasId: ID_A, description: 'Motor', resolution: 'resolved' } as never}
          isPinned
          viewer={h.viewer}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Add to Cart')).toBeInTheDocument();
  });

  it('should hide cart button, tooltip action and panel together in mode viewer and close an open cart on switch', () => {
    mockIndex({});
    const { h, ui } = setup('resolved');
    activateContext('mode:viewer');
    ui();
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasTooltipContent
          data={{ type: 'aas', aasId: ID_A, description: 'Motor', resolution: 'resolved' } as never}
          isPinned
          viewer={h.viewer}
        />
      </ThemeProvider>,
    );
    expect(screen.queryByLabelText('Order Cart')).toBeNull();
    expect(screen.queryByText('Add to Cart')).toBeNull();
    expect(isCartAvailable()).toBe(false);
    // Leaving viewer mode brings all of them back together.
    act(() => { deactivateContext('mode:viewer'); });
    expect(screen.getByLabelText('Order Cart')).toBeInTheDocument();
    expect(screen.getByText('Add to Cart')).toBeInTheDocument();
  });

  it("should apply isCartAvailable to the context menu entry and the addItem panel open (incl. visibility override)", () => {
    const { h, order } = setup('resolved');
    order.onModelLoaded({} as never, h.viewer);
    const reg = (h.internals as unknown as { contextMenu: { register: ReturnType<typeof vi.fn> } }).contextMenu.register;
    const item = reg.mock.calls.at(-1)![0].items.find((i: { id: string }) => i.id === 'order-manager.add-to-cart');
    const node = linkNode(ID_A);
    node.userData[AAS_RESOLUTION_KEY] = 'resolved';

    expect(item.condition({ node, path: 'Motor' })).toBe(true);
    order.addItem(ID_A, 'Motor', 'ACME', 'A-1', 'Motor');
    expect(h.leftPanelOpen).toHaveBeenCalledTimes(1);

    activateContext('mode:viewer');
    expect(item.condition({ node, path: 'Motor' })).toBe(false);
    order.addItem(ID_B, 'Other', 'ACME', 'B-1', 'Motor');
    expect(h.leftPanelOpen).toHaveBeenCalledTimes(1);

    // A deployment override that shows the panel in viewer mode opens every entry.
    registerUIElement(ORDER_PANEL_GATE.id, { hiddenIn: [] });
    expect(item.condition({ node, path: 'Motor' })).toBe(true);
    order.addItem(ID_B, 'Other', 'ACME', 'B-1', 'Motor');
    expect(h.leftPanelOpen).toHaveBeenCalledTimes(2);
  });
});

// ─── plan-682 Phase 3: collapsible document groups ──────────────────────

describe('grouped documents in the pinned tooltip', () => {
  const d = (lang: string, kind: string, title: string, n: number): AasDocument => ({
    title, baseTitle: title, documentIdShort: `Document${n}`, mimeType: 'application/pdf', zipPath: '',
    language: lang, kind, url: `https://vendor.example/a/${lang.toLowerCase()}/${n}`,
  });
  const docs: AasDocument[] = [
    d('DE', 'Anwendungsbeschreibung', 'Zahnrad', 1), d('EN', 'Application description', 'Gear', 1),
    d('DE', 'Anwendungsbeschreibung', 'Münzen', 2), d('EN', 'Application description', 'Coins', 2),
    d('DE', 'Betriebsanleitung', 'Bedienung', 3), d('EN', 'Operating instructions', 'Operation', 3),
  ];

  it('should render one collapsed group per kind with its count, operating instructions first, and one row per document when expanded', () => {
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <AasDocumentGroups docs={docs} aasId={ID_A} sourceKey={null} />
      </ThemeProvider>,
    );
    const heads = screen.getAllByRole('button', { expanded: false });
    expect(heads.map(h => h.textContent)).toEqual([
      expect.stringMatching(/\(1\)$/),
      expect.stringMatching(/\(2\)$/),
    ]);
    expect(heads[0].textContent).toMatch(/Operating instructions|Betriebsanleitung/);
    // Collapsed: no document rows yet.
    expect(screen.queryByText('Gear')).toBeNull();
    expect(screen.queryByText('Zahnrad')).toBeNull();
    act(() => { heads[1].click(); });
    // Expanded: two rows (not four), each with both language chips.
    const group = screen.getByTestId('aas-doc-group:application-description');
    const chipsDE = group.querySelectorAll('span, button');
    const text = group.textContent ?? '';
    expect((text.match(/DE/g) ?? []).length).toBe(2);
    expect((text.match(/EN/g) ?? []).length).toBe(2);
    expect(chipsDE.length).toBeGreaterThan(0);
  });
});
