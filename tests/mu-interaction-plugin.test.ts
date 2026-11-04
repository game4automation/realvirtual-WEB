// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-interaction-plugin.test.ts — plan-567 §9.2 / §9.3: the Commissioning
 * interaction and the MCP tools on top of the engine primitives.
 *
 *  - context menu: the remove entry only on a carrier, only in Commissioning;
 *    in DES / a multiuser client it stays visible with the reason (F9);
 *  - Delete key: removes the selected carrier in Commissioning, nothing once
 *    the workspace is left; the selection is cleaned up;
 *  - drag: Esc restores the pose; DES / multiuser refuse with the reason;
 *  - reconciler roundtrip Commissioning ↔ Planner: a pre-placed carrier keeps
 *    its document path, a clone gets and loses its synthetic path (SOL #8);
 *  - MCP: `web_transport_status` lists `mus[].id`, `web_mu_delete` /
 *    `web_mu_move` work with it; unknown ids, the wrong workspace and an
 *    occupied target are refused with nothing changed (SOL #12).
 *
 * The viewer is a narrow double (pattern: mu-reconciler.test.ts) with a real
 * NodeRegistry, ContextMenuStore and transport manager.
 */

import { executeDelegateValue } from './helpers/execute-value';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { queryValue } from './helpers/query-value';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { ContextMenuStore, type ContextMenuTarget } from '../src/core/hmi/context-menu-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { ConnectionHoldController, __setConnectionHoldsForTests } from '../src/core/engine/rv-connection-hold';
import { MuReconciler } from '../src/plugins/layout-planner/mu-reconciler';
import {
  MuInteractionPlugin,
  REASON_DES,
  REASON_MODE,
  REASON_MULTIUSER,
  ensureMuCommandsRegistered,
  muNotFound,
} from '../src/plugins/mu-interaction-plugin';
import { McpRuntimeTools } from '../src/plugins/mcp-bridge/rv-mcp-runtime-tools';
import { classifiedScene, muOf, palletRow } from './_mu-preplaced-fixture';
import type { RVViewer } from '../src/core/rv-viewer';

const MU_HALF = new Vector3(0.05, 0.05, 0.05);

function surfaceAt(scene: Scene, name: string, x: number): RVTransportSurface {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, -0.1, 0);
  scene.add(node);
  const s = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2, 0.05, 0.5)));
  s.TransportDirection.set(1, 0, 0);
  s.Radial = false;
  s.TextureScale = 1;
  s.HeightOffsetOverride = 0;
  s.reapplyConfig();
  s.initTransport();
  s.drive = { currentSpeed: 0, name: 'd' } as unknown as RVDrive;
  return s;
}

function cloneMu(scene: Scene, name: string, x: number): RVMovingUnit {
  const node = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial());
  node.name = name;
  node.position.set(x, 0, 0);
  scene.add(node);
  return new RVMovingUnit(node, 'src', MU_HALF.clone());
}

interface Harness {
  viewer: RVViewer;
  tm: RVTransportManager;
  scene: Scene;
  registry: NodeRegistry;
  menu: ContextMenuStore;
  setMode(m: string): void;
  setKernel(m: string): void;
  select(paths: string[]): void;
  selected(): string[];
  emit(name: string): void;
  canvas: HTMLCanvasElement;
}

function harness(tm: RVTransportManager, scene: Scene): Harness {
  let mode = 'commissioning';
  let kernel = 'continuous';
  let selection: string[] = [];
  const registry = new NodeRegistry();
  const menu = new ContextMenuStore();
  const canvas = document.createElement('canvas');
  canvas.width = 400; canvas.height = 300;
  const camera = new PerspectiveCamera(50, 4 / 3, 0.01, 100);
  camera.position.set(0, 5, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const listeners = new Map<string, Set<() => void>>();
  const viewer = {
    transportManager: tm,
    scene,
    registry,
    contextMenu: menu,
    camera,
    controls: { enabled: true },
    renderer: { domElement: canvas },
    keyboardScope: null,
    keyboardScopeIsPrimary: true,
    currentModelRoot: scene,
    get modes() { return { activeMode: mode }; },
    get simulationKernel() { return { mode: kernel }; },
    raycastManager: {
      addAuxRaycastTarget: () => {},
      removeAuxRaycastTarget: () => {},
      raycastForRVNodeDetailed: () => null,
    },
    selectionManager: {
      getSnapshot: () => ({ selectedPaths: selection, primaryPath: selection[0] ?? null }),
      selectPaths: (p: string[]) => { selection = [...p]; },
      select: (p: string) => { selection = [p]; },
      toggle: (p: string) => { selection = selection.includes(p) ? selection.filter((x) => x !== p) : [...selection, p]; },
      refreshHighlight: () => {},
    },
    markRenderDirty: () => {},
    on(name: string, cb: () => void) {
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
  } as unknown as RVViewer;
  return {
    viewer, tm, scene, registry, menu, canvas,
    setMode: (m) => { mode = m; },
    setKernel: (m) => { kernel = m; },
    select: (p) => { selection = [...p]; },
    selected: () => selection,
    emit: (name) => { for (const cb of [...(listeners.get(name) ?? [])]) cb(); },
  };
}

function targetOf(h: Harness, node: Object3D): ContextMenuTarget {
  return { path: h.registry.getPathForNode(node) ?? node.name, node, types: [], extras: {} };
}

function itemIds(h: Harness): string[] {
  return h.menu.getSnapshot().items.map((i) => i.id);
}

let plugins: MuInteractionPlugin[] = [];
beforeEach(() => {
  __setConnectionHoldsForTests(new ConnectionHoldController());
  ensureMuCommandsRegistered();
});
afterEach(() => {
  for (const p of plugins.splice(0)) p.dispose();
  __setConnectionHoldsForTests(null);
  commandRegistry.attachViewer(undefined);
});

/** A paused line with a pre-placed pallet (with one load) and a clone carrier, plugin active. */
function setup(): { h: Harness; plugin: MuInteractionPlugin; pallet: RVMovingUnit; clone: RVMovingUnit; palletNode: Object3D } {
  const { root, pallets } = palletRow(1, 1);
  const { scene, tm } = classifiedScene(root);
  tm.surfaces.push(surfaceAt(scene, 'BeltA', 0), surfaceAt(scene, 'BeltB', 6));
  tm.activatePreplaced();
  const clone = cloneMu(scene, 'Clone', 1.5);
  tm.mus.push(clone);
  const h = harness(tm, scene);
  // Document paths of the model (what the loader registers).
  root.traverse((n) => { if (n !== root) h.registry.registerNode(NodeRegistry.computeNodePath(n), n); });
  const plugin = new MuInteractionPlugin();
  plugins.push(plugin);
  plugin.init(h.viewer);
  plugin.onModeActivate('commissioning', h.viewer);
  plugin.onRender();
  return { h, plugin, pallet: muOf(tm, pallets[0]), clone, palletNode: pallets[0] };
}

describe('context menu (F5, F9)', () => {
  it('the remove entry appears on a carrier (and on its load), not on other nodes', () => {
    const { h, pallet } = setup();
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.node));
    expect(itemIds(h)).toContain('mu.remove');
    h.menu.close();
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.loadedMus[0].node.children[0]));
    expect(itemIds(h)).toContain('mu.remove');
    h.menu.close();
    h.menu.open({ x: 0, y: 0 }, targetOf(h, h.tm.surfaces[0].node));
    expect(itemIds(h)).not.toContain('mu.remove');
  });

  it('outside Commissioning nothing; in DES / a multiuser client the entry names the reason', () => {
    const { h, pallet } = setup();
    h.setMode('hmi');
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.node));
    expect(h.menu.getSnapshot().open).toBe(false);

    h.setMode('commissioning');
    h.setKernel('des');
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.node));
    let items = h.menu.getSnapshot().items;
    expect(items.map((i) => i.id)).toEqual(['mu.remove-unavailable']);
    expect(items[0].resolvedLabel).toContain(REASON_DES);
    h.menu.close();

    h.setKernel('continuous');
    h.tm.preplacedActivationBlocked = true;
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.node));
    items = h.menu.getSnapshot().items;
    expect(items[0].resolvedLabel).toContain(REASON_MULTIUSER);
  });

  it('the command item removes the carrier through the registry', async () => {
    const { h, pallet } = setup();
    h.menu.open({ x: 0, y: 0 }, targetOf(h, pallet.node));
    const item = h.menu.getSnapshot().items.find((i) => i.id === 'mu.remove')!;
    const r = await commandRegistry.execute(item.command!.id, item.command!.args(h.menu.getSnapshot().target!), { origin: 'ui', viewer: h.viewer });
    expect(r.ok).toBe(true);
    expect(h.tm.mus).not.toContain(pallet);
  });
});

describe('Delete key (F5, F8)', () => {
  it('removes the selected carrier in Commissioning and cleans the selection', async () => {
    const { h, pallet, palletNode } = setup();
    const path = h.registry.getPathForNode(palletNode)!;
    h.select([path]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(h.tm.mus).not.toContain(pallet);
    expect(h.selected()).toEqual([]);
  });

  it('does nothing after the workspace was left', async () => {
    const { h, plugin, pallet, palletNode } = setup();
    plugin.onModeDeactivate('commissioning', h.viewer);
    h.setMode('hmi');
    h.select([h.registry.getPathForNode(palletNode)!]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(h.tm.mus).toContain(pallet);
  });

  it('a selected clone carrier (synthetic path) is removed too', async () => {
    const { h, clone } = setup();
    const path = h.registry.getPathForNode(clone.node)!;
    expect(path.startsWith('__mu#')).toBe(true);
    h.select([path]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await Promise.resolve(); await Promise.resolve();
    expect(h.tm.mus).not.toContain(clone);
  });
});

describe('drag (F6, SOL #3/#10)', () => {
  it('Esc restores the pose and the owner', () => {
    const { h, plugin, clone } = setup();
    const pos = clone.node.position.clone();
    const parent = clone.node.parent;
    expect(plugin.startDrag(clone, { clientX: 300, clientY: 150, pointerId: 7 })).toBe(true);
    expect(clone.heldBy).toBe('user');
    plugin.updateDrag({ clientX: 350, clientY: 120 });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(plugin.dragging).toBe(false);
    expect(clone.heldBy).toBeNull();
    expect(clone.node.parent).toBe(parent);
    expect(clone.node.position.equals(pos)).toBe(true);
    expect((h.viewer.controls as { enabled: boolean }).enabled).toBe(true);
  });

  it('a simulation reset or a workspace switch aborts the gesture', () => {
    const { h, plugin, clone } = setup();
    plugin.startDrag(clone, { clientX: 300, clientY: 150, pointerId: 7 });
    h.emit('mode-changing');
    expect(plugin.dragging).toBe(false);
    expect(clone.heldBy).toBeNull();
  });

  it('DES and multiuser clients refuse with the reason, nothing held', () => {
    const { h, plugin, clone } = setup();
    h.setKernel('des');
    expect(plugin.startDrag(clone, { clientX: 1, clientY: 1, pointerId: 1 })).toBe(false);
    expect(plugin.hintText).toBe(REASON_DES);
    h.setKernel('continuous');
    h.tm.preplacedActivationBlocked = true;
    expect(plugin.startDrag(clone, { clientX: 1, clientY: 1, pointerId: 1 })).toBe(false);
    expect(plugin.hintText).toBe(REASON_MULTIUSER);
    expect(clone.heldBy).toBeNull();
  });
});

describe('reconciler roundtrip Commissioning ↔ Planner (SOL #8)', () => {
  it('a pre-placed carrier keeps its document path; a clone gets and loses its synthetic path', () => {
    const { h, plugin, pallet, clone, palletNode } = setup();
    const docPath = NodeRegistry.computeNodePath(palletNode);
    const loadPath = NodeRegistry.computeNodePath(pallet.loadedMus[0].node);
    expect(h.registry.getPathForNode(palletNode)).toBe(docPath);
    expect(palletNode.userData._muRef).toBe(pallet);
    expect(h.registry.getPathForNode(clone.node)).toMatch(/^__mu#/);

    // Leave Commissioning → markers and the synthetic path go, document paths stay.
    plugin.onModeDeactivate('commissioning', h.viewer);
    expect(h.registry.getPathForNode(palletNode)).toBe(docPath);
    expect(h.registry.getNode(loadPath)).toBe(pallet.loadedMus[0].node);
    expect(palletNode.userData._muRef).toBeUndefined();
    expect(h.registry.getPathForNode(clone.node) ?? null).toBeNull();

    // A planner reconciler on the same MUs, then back.
    const planner = new MuReconciler({ viewer: h.viewer, getMUs: () => h.tm.mus });
    planner.reconcile();
    expect(h.registry.getPathForNode(palletNode)).toBe(docPath);
    planner.disposeAll();
    expect(h.registry.getPathForNode(palletNode)).toBe(docPath);
    expect(h.registry.getNode(loadPath)).toBe(pallet.loadedMus[0].node);

    plugin.onModeActivate('commissioning', h.viewer);
    plugin.onRender();
    expect(palletNode.userData._muRef).toBe(pallet);
  });

  it('a pre-placed load riding on a deleted clone keeps its document path', () => {
    const { h, clone } = setup();
    const extra = new Object3D();
    extra.name = 'DocChild';
    clone.node.add(extra);
    h.registry.registerNode('Model/DocChild', extra);
    // The clone disappears from the line → its reconciler entry goes.
    h.tm.removeMU(clone);
    plugins[0].onRender();
    expect(h.registry.getNode('Model/DocChild')).toBe(extra);
  });
});

// ─── MCP (§9.3) ─────────────────────────────────────────────────────────

describe('MCP web_mu_delete / web_mu_move (F7, SOL #12)', () => {
  function tools(h: Harness): McpRuntimeTools {
    return new McpRuntimeTools(() => h.viewer);
  }

  it('web_transport_status lists the ids the two tools take', async () => {
    const { h, pallet, clone } = setup();
    const status = JSON.parse(await queryValue(h.viewer, 'transport.status')) as { mus: { id: number; name: string }[] };
    const ids = status.mus.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining([pallet.id, clone.id]));
  });

  it('web_mu_delete removes by id; a load id addresses its carrier', async () => {
    const { h, pallet } = setup();
    const res = JSON.parse(await executeDelegateValue(tools(h), 'mu.delete', { id: pallet.loadedMus[0].id })) as Record<string, unknown>;
    // plan-2007: the old alias added ok:true; the command value carries the payload only.
    expect(res['error']).toBeUndefined();
    expect(res['id']).toBe(pallet.id);
    expect(res['preplaced']).toBe(true);
    expect(h.tm.mus).not.toContain(pallet);
  });

  it('unknown id and wrong workspace are refused; nothing changes', async () => {
    const { h, pallet } = setup();
    const before = h.tm.mus.length;
    const unknown = JSON.parse(await executeDelegateValue(tools(h), 'mu.delete', { id: 999999 })) as Record<string, unknown>;
    expect(unknown['error']).toBe(muNotFound(999999));
    h.setMode('hmi');
    const wrong = JSON.parse(await executeDelegateValue(tools(h), 'mu.delete', { id: pallet.id })) as Record<string, unknown>;
    expect(wrong['error']).toBe(REASON_MODE);
    const wrongMove = JSON.parse(await executeDelegateValue(tools(h), 'mu.move', { id: pallet.id, x: 6, y: 0, z: 0 })) as Record<string, unknown>;
    expect(wrongMove['error']).toBe(REASON_MODE);
    expect(h.tm.mus.length).toBe(before);
    expect(pallet.node.position.x).toBeCloseTo(0, 6);
  });

  it('web_mu_move sets the carrier onto the named surface; an occupied spot is refused unchanged', async () => {
    const { h, clone, pallet } = setup();
    const ok = JSON.parse(await executeDelegateValue(tools(h), 'mu.move', { id: clone.id, x: 6, y: 0, z: 0, surface: 'BeltB' })) as Record<string, unknown>;
    expect(ok['error']).toBeUndefined();
    expect(ok['surface']).toBe('BeltB');
    clone.updateAABB();
    expect(clone.aabb.center.x).toBeCloseTo(6, 6);

    const before = pallet.node.position.clone();
    const occupied = JSON.parse(await executeDelegateValue(tools(h), 'mu.move', { id: pallet.id, x: 6, y: 0, z: 0 })) as Record<string, unknown>;
    expect(String(occupied['error'])).toMatch(/occupied/);
    expect(pallet.node.position.equals(before)).toBe(true);

    const noSurface = JSON.parse(await executeDelegateValue(tools(h), 'mu.move', { id: clone.id, x: 6, y: 0, z: 0, surface: 'Nope' })) as Record<string, unknown>;
    expect(noSurface['error']).toBe('Transport surface "Nope" not found');
  });
});
