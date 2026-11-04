// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9a (8.1, G8) — path building blocks as planner-library entries.
 *
 *  - the built-in catalog has the 5 kinds (straight, curve, diverge, merge,
 *    stub), each a procedural `pathBlock` entry without a GLB; a JSON catalog's
 *    `pathBlock` survives `normalizeCatalogEntry`;
 *  - placing a library entry (card click → canvas click, and card drag → drop)
 *    goes through `layout.path.place` — ONE undo step, and the result is
 *    field-for-field the block `layout.path.place` writes with the same args;
 *    a junction entry goes through `layout.path.junction`;
 *  - the planner hands a path-block card to the path network UI instead of its
 *    GLB draft / placement mode (`setPathBlockEntryHandler`);
 *  - the catalog appears in every authoring mode (planner, des) and leaves
 *    outside them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Vector3 } from 'three';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import type { RVViewer } from '../../src/core/rv-viewer';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { normalizeCatalogEntry } from '../../src/core/library/library-store';
import type { LibraryCatalogEntry } from '../../src/core/library/library-types';
import { ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { PathNetworkUiPlugin } from '../../src/plugins/path-network/path-network-ui-plugin';
import {
  PATH_LIBRARY_CATALOG_KEY,
  catalogEntryForPathBlock,
  pathBlockLibraryEntries,
} from '../../src/plugins/path-network/path-network-ui-model';
import { DT_CATALOG_ID } from '../../src/plugins/layout-planner/drag-types';
import { LayoutPlannerPlugin } from '../../src/plugins/layout-planner';
import { createGizmoRecorder, createMockViewer } from '../_layout-planner-async-harness';
import { makeRig, type Rig } from './path-network-rig';

const entryOf = (kind: string): LibraryCatalogEntry => pathBlockLibraryEntries().find((e) => e.pathBlock?.kind === kind)!;

describe('plan-628 9.9a library entries (pure)', () => {
  it('the built-in catalog lists the 5 kinds as procedural path-block entries', () => {
    const entries = pathBlockLibraryEntries();
    expect(entries.map((e) => e.pathBlock!.kind)).toEqual(['straight', 'curve', 'diverge', 'merge', 'stub']);
    for (const e of entries) {
      expect(e.id.startsWith('path-block:')).toBe(true);
      expect(e.glbUrl).toBe('');
      expect(e.noPrefetch).toBe(true);
      expect(e.thumbnailUrl?.startsWith('data:image/svg+xml')).toBe(true);
      // every entry maps back onto the toolbar catalog (one tool, two entries)
      expect(catalogEntryForPathBlock(e.pathBlock!)).not.toBeNull();
    }
    expect(catalogEntryForPathBlock(entryOf('straight').pathBlock!)!.id).toBe('straight-2');
    expect(catalogEntryForPathBlock({ kind: 'nope' })).toBeNull();
    // foreign parameters → a transient tool entry with exactly those parameters
    const foreign = catalogEntryForPathBlock({ kind: 'straight', params: { lengthM: 3.5 } })!;
    expect(foreign.spec).toEqual({ kind: 'straight', lengthM: 3.5 });
  });

  it('normalizeCatalogEntry passes pathBlock through (JSON catalog), never inventing a GLB url', () => {
    const e = normalizeCatalogEntry({ id: 'pb', name: 'Long straight', pathBlock: { kind: 'straight', params: { lengthM: 5 } } }, 'https://x.test/lib/');
    expect(e.pathBlock).toEqual({ kind: 'straight', params: { lengthM: 5 } });
    expect(e.glbUrl).toBe('');
    expect(e.noPrefetch).toBe(true);
    expect(e.category).toBe('des');
  });
});

// ─── placement through the path network UI ─────────────────────────────

let rig: Rig;
let ui: PathNetworkInteraction;
let canvas: HTMLCanvasElement;

const viewerOf = (r: Rig): RVViewer => r.stub as unknown as RVViewer;
const net = () => snapshotNetwork(rig.stub as never).input;
const undoLen = (): number => rig.doc.historyHead().undoLen;
const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

function screenOf(x: number, z: number): { clientX: number; clientY: number } {
  const v = new Vector3(x, 0, z).project(rig.stub.camera);
  const r = canvas.getBoundingClientRect();
  return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
}

async function exec(id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: viewerOf(rig) });
  if (!r.ok) throw new Error(r.reason);
  return r.value as Record<string, unknown>;
}

/** The one block of the network with its paths (ids stripped: the comparison is about content). */
function blockContent(): unknown {
  const n = net();
  return {
    blocks: (n.blocks ?? []).map((b) => ({ id: b.id, extras: b.extras })),
    paths: n.paths.map((p) => ({ id: p.id, block: p.block, segments: p.segments, successors: p.successors })),
  };
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:600px';
  canvas.width = 800;
  canvas.height = 600;
  document.body.appendChild(canvas);
  rig = makeRig(canvas);
  rig.plugin.setPlannerMode(true);
  ensurePathNetworkCommandsRegistered(commandRegistry);
  ui = new PathNetworkInteraction(viewerOf(rig), rig.plugin);
  rig.scene.updateMatrixWorld(true);
  ui.tick();
});

afterEach(() => {
  ui.dispose();
  rig.plugin.dispose();
  canvas.remove();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
});

describe('plan-628 9.9a library entries (placement)', () => {
  for (const kind of ['straight', 'curve'] as const) {
    it(`${kind}: card click arms the tool, a canvas click places — ONE undo step, field-for-field = layout.path.place`, async () => {
      await ui.pickLibraryEntry(entryOf(kind));
      expect(ui.getState().toolId).toBe(kind === 'straight' ? 'straight-2' : 'curve-90-l');
      const before = undoLen();
      const at = screenOf(1.5, -2);
      expect(ui.handlePointerDown(new PointerEvent('pointerdown', { ...at, button: 0, bubbles: true }))).toBe(true);
      await wait();
      expect(undoLen()).toBe(before + 1);
      const viaLibrary = blockContent();
      const pose = net().blocks![0].extras.pose;
      await rig.doc.undo();
      expect(net().paths).toHaveLength(0);
      const pb = entryOf(kind).pathBlock!;
      await exec('layout.path.place', { block: kind, ...pb.params, x: pose[0], z: pose[1], y: 0, headingDeg: pose[2] });
      expect(blockContent()).toEqual(viaLibrary);
    });
  }

  it('card drag → canvas drop places at a free end (tangent-true, linked) — ONE undo step', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    const dt = new DataTransfer();
    dt.setData(DT_CATALOG_ID, 'path-block:straight-2'); // what the planner's library card puts on a drag
    ui.beginLibraryDrag(entryOf('straight'));
    const at = screenOf(4.1, 0.05);
    const over = new DragEvent('dragover', { ...at, dataTransfer: dt, bubbles: true, cancelable: true });
    canvas.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    const before = undoLen();
    canvas.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: dt, bubbles: true, cancelable: true }));
    ui.endLibraryDrag();
    await wait();
    expect(undoLen()).toBe(before + 1);
    const n = net();
    expect(n.paths).toHaveLength(2);
    expect(n.paths.find((p) => p.id === 'PN_S1')!.successors).toEqual(['PN_S2']);
    expect(ui.getState().toolId).toBeNull();
  });

  it('a junction entry goes through layout.path.junction (stub on a 10 m path)', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 0 });
    await ui.pickLibraryEntry(entryOf('stub'));
    expect(ui.getState().toolId).toBe('stub');
    const spy = vi.spyOn(commandRegistry, 'execute');
    // the junction tool picks the line under the pointer
    rig.plugin.refresh();
    rig.scene.updateMatrixWorld(true);
    expect(rig.plugin.getLineObjects().get('PN_S1')).toBeTruthy();
    const at = screenOf(5, 0.05);
    canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, bubbles: true }));
    expect(ui.handlePointerDown(new PointerEvent('pointerdown', { ...at, button: 0, bubbles: true }))).toBe(true);
    await wait();
    expect(spy.mock.calls.some((c) => c[0] === 'layout.path.junction')).toBe(true);
    spy.mockRestore();
    expect((net().blocks ?? []).some((b) => b.extras.kind === 'stub')).toBe(true);
  });
});

// ─── the planner hand-off + the catalog follows the authoring modes ─────

describe('plan-628 9.9a planner hand-off', () => {
  it('a path-block card never becomes a GLB draft or a placement mode — it goes to the handler', () => {
    const viewer = createMockViewer(createGizmoRecorder());
    const rm = viewer.raycastManager as typeof viewer.raycastManager & { getAllowFilter: () => null; setAllowFilter: () => void };
    rm.getAllowFilter = () => null;
    rm.setAllowFilter = () => {};
    const planner = new LayoutPlannerPlugin();
    planner.store.setGridEnabled(false);
    const calls: string[] = [];
    planner.setPathBlockEntryHandler({
      pick: (e) => calls.push(`pick:${e.id}`),
      beginDrag: (e) => calls.push(`drag:${e.id}`),
      endDrag: () => calls.push('end'),
    });
    planner.onModeActivate('planner', viewer as never);
    planner.store.addCatalogDirect(PATH_LIBRARY_CATALOG_KEY, { version: '1.0', name: 'Path Network', entries: pathBlockLibraryEntries() });
    const straight = entryOf('straight');
    planner.setDragEntry(straight);
    expect((planner as unknown as { _dragEntry: unknown })._dragEntry).toBeNull();
    planner.setDragEntry(null);
    planner.store.setPlacementMode(straight.id);
    expect(planner.store.getSnapshot().placementMode).toBeNull();
    expect(calls).toEqual([`drag:${straight.id}`, 'end', `pick:${straight.id}`]);
    planner.store.removeCatalog(PATH_LIBRARY_CATALOG_KEY);
    planner.setActive(false);
  });

  it('the path-block catalog is in the library in planner and des, gone in other modes', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    let handler: unknown = null;
    const listeners: (() => void)[] = [];
    const viewer = {
      modes: { activeMode: 'planner' as string },
      getPlugin: (id: string) => {
        if (id === 'path-visualizer') return rig.plugin;
        if (id === 'layout-planner') {
          return {
            store: { addCatalogDirect: (k: string) => added.push(k), removeCatalog: (k: string) => removed.push(k) },
            setPathBlockEntryHandler: (h: unknown) => { handler = h; return () => { handler = null; }; },
          };
        }
        return undefined;
      },
      on: (ev: string, fn: () => void) => { if (ev === 'mode-changed') listeners.push(fn); return () => {}; },
      scene: rig.scene, camera: rig.stub.camera, renderer: null, controls: { enabled: true },
      markRenderDirty: () => {},
    };
    const plugin = new PathNetworkUiPlugin();
    plugin.init(viewer as never);
    expect(await plugin.whenInteractionReady()).not.toBeNull();
    expect(added).toEqual([PATH_LIBRARY_CATALOG_KEY]);
    expect(handler).not.toBeNull();
    viewer.modes.activeMode = 'des';
    for (const l of listeners) l();
    expect(added).toEqual([PATH_LIBRARY_CATALOG_KEY]); // still there, not added twice
    viewer.modes.activeMode = 'hmi';
    for (const l of listeners) l();
    expect(removed).toEqual([PATH_LIBRARY_CATALOG_KEY]);
    expect(handler).toBeNull();
    plugin.dispose();
  });
});
