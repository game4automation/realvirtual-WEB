// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9j (8.9 "Komfortabler Aufbau") — deleting, moving and the
 * building comforts of the path network by mouse and keyboard, in the REAL
 * viewer (snap plugin, path visualizer, path-network UI, the viewer's context
 * menu store, the real scene executor):
 *
 *  - a click selects a block, Delete removes it: the predecessor loses its
 *    successor, the freed end shows a free standard snap; ONE undo step
 *    restores block + both edges, redo deletes again;
 *  - Shift-click extends the selection, Delete removes all of it in one step;
 *  - right-click → context menu "Delete chain from here" removes the chain in
 *    one step; "Delete <block>" from the menu;
 *  - deleting a junction block heals its host (P7);
 *  - R turns the selected block by 90°;
 *  - move → undo → redo;
 *  - while the simulation runs a Delete is refused with the visible hint.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 120_000 });
import { Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PathNetworkUiPlugin } from '../../src/plugins/path-network/path-network-ui-plugin';
import { PATH_MENU_IDS, type PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { PATH_NETWORK_LOCKED_HINT } from '../../src/plugins/path-network/path-network-ui-model';
import { snapHoverStore } from '../../src/plugins/snap-point/snap-hover-store';
import { activateContext, deactivateContext } from '../../src/core/hmi/ui-context-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { specEnds } from '../../src/core/engine/rv-path-blocks';
import type { NetworkInput } from '../../src/core/engine/rv-path-network-ops';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';

const W = 800;
const H = 600;
const MAX_FRAMES = 240;
const PAUSE_KEY = 'pn-delete';

let handle: TestViewerHandle | null = null;

afterEach(() => {
  snapHoverStore.reset();
  deactivateContext('planner');
  setActiveEditTarget(null);
  handle?.dispose();
  handle = null;
});

const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < MAX_FRAMES && !cond(); i++) await frame();
  expect(cond(), what).toBe(true);
}

interface Rig {
  v: RVViewer;
  doc: RvDocument;
  viz: PathVisualizerPlugin;
  snap: SnapPointPlugin;
  ui: PathNetworkInteraction;
  canvas: HTMLCanvasElement;
}

async function boot(): Promise<Rig> {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const v = handle.viewer;
  v.setSimulationPaused(PAUSE_KEY, true); // path edits need the reset state
  v.modes.register({ id: 'planner', label: 'Planner' });
  v.modes.setMode('planner');
  const snap = new SnapPointPlugin();
  v.use(snap, 'core');
  const viz = new PathVisualizerPlugin();
  v.use(viz, 'core');
  v.use(new PathNetworkUiPlugin(), 'core');
  await v.loadScene(makeDraftScene({ kind: 'empty' }, PAUSE_KEY));
  await v.whenSceneReady();
  activateContext('planner');
  const doc = new RvDocument({ id: PAUSE_KEY, name: 'Delete', mode: 'scene', executor: new RvUnifiedExecutor(v, 'scene') });
  const target: EditTarget = {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: () => { throw new Error('unused'); },
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(target);
  v.camera.position.set(3, 12, 0.001);
  (v.controls as unknown as { target?: Vector3 }).target?.set(3, 0, 0);
  v.camera.lookAt(3, 0, 0);
  v.camera.updateMatrixWorld(true);
  (v.controls as unknown as { update?: () => void }).update?.();
  const ui = await (v.getPlugin('path-network-ui') as unknown as PathNetworkUiPlugin).whenInteractionReady();
  if (!ui) throw new Error('Path network interaction failed to load');
  await until(() => ui.getState().editable, 'path network editable');
  return { v, doc, viz, snap, ui, canvas: v.renderer.domElement as HTMLCanvasElement };
}

function screenOf(r: Rig, p: readonly number[]): { clientX: number; clientY: number } {
  r.v.camera.updateMatrixWorld(true);
  const q = new Vector3(p[0], p[1] ?? 0, p[2]).project(r.v.camera);
  const rect = r.canvas.getBoundingClientRect();
  return { clientX: rect.left + ((q.x + 1) / 2) * rect.width, clientY: rect.top + ((1 - q.y) / 2) * rect.height };
}

const net = (r: Rig): NetworkInput => snapshotNetwork(r.v as never).input;
const undoLen = (r: Rig): number => r.doc.historyHead().undoLen;
const succ = (r: Rig, id: string): string[] | null => net(r).paths.find((p) => p.id === id)?.successors ?? null;
const blockIds = (r: Rig): string[] => (net(r).blocks ?? []).map((b) => b.id).sort();
/** Topology fingerprint: path → block + successors, and the block ids. */
const topo = (r: Rig): string => JSON.stringify({
  paths: net(r).paths.map((p) => [p.id, p.block, [...p.successors].sort()]).sort(),
  blocks: blockIds(r),
});

async function exec(r: Rig, id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: r.v });
  if (!res.ok) throw new Error(res.reason);
  return res.value as Record<string, unknown>;
}

/** Midpoint of a live path in world space. */
function midOf(pathId: string, f = 0.5): number[] {
  const p = getDefaultPathNetwork().get(pathId)!;
  const v = p.getAbsPosition(p.length * f);
  return [v.x, v.y, v.z];
}

/** A left click as the browser delivers it (optionally with Shift). */
async function clickPath(r: Rig, pathId: string, opts: { shift?: boolean; f?: number } = {}): Promise<void> {
  await until(() => r.viz.getLineObjects().has(pathId), `line of ${pathId}`);
  r.v.scene.updateMatrixWorld(true);
  const at = screenOf(r, midOf(pathId, opts.f ?? 0.5));
  const init = { ...at, button: 0, bubbles: true, shiftKey: !!opts.shift };
  r.canvas.dispatchEvent(new PointerEvent('pointerdown', init));
  r.canvas.dispatchEvent(new MouseEvent('mousedown', init));
  window.dispatchEvent(new PointerEvent('pointerup', init));
  window.dispatchEvent(new MouseEvent('mouseup', init));
  await frame();
}

/** A right click (pointerdown button 2 + contextmenu) on a path. */
async function rightClickPath(r: Rig, pathId: string, f = 0.5): Promise<void> {
  await until(() => r.viz.getLineObjects().has(pathId), `line of ${pathId}`);
  r.v.scene.updateMatrixWorld(true);
  const at = screenOf(r, midOf(pathId, f));
  r.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 2, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 2, bubbles: true }));
  r.canvas.dispatchEvent(new MouseEvent('contextmenu', { ...at, button: 2, bubbles: true, cancelable: true }));
  await frame();
}

function key(k: string, extra: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
}

/** Run a context-menu item of the open menu (what ContextMenuLayer does on a click). */
function runMenuItem(r: Rig, id: string): void {
  const snap = r.v.contextMenu.getSnapshot();
  const item = snap.items.find((i) => i.id === id);
  expect(item, `menu item ${id} in ${JSON.stringify(snap.items.map((i) => i.id))}`).toBeTruthy();
  item!.action!(snap.target!);
  r.v.contextMenu.close();
}

/** Straight → Curve R → Straight, chained (PN_S1 → PN_C1 → PN_S2). */
async function chainOfThree(r: Rig): Promise<void> {
  await exec(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
  await exec(r, 'layout.path.place', { block: 'curve', side: 'right', atPath: 'PN_S1', atEnd: 'end' });
  await exec(r, 'layout.path.place', { block: 'straight', lengthM: 2, atPath: 'PN_C1', atEnd: 'end' });
  expect(succ(r, 'PN_S1')).toEqual(['PN_C1']);
  expect(succ(r, 'PN_C1')).toEqual(['PN_S2']);
  await until(() => !!r.snap.getRegistry()?.getById('path-snap:PN_S1:end'), 'path-end snaps registered');
}

const blockOf = (r: Rig, pathId: string): string => net(r).paths.find((p) => p.id === pathId)!.block;

describe('plan-628 9.9j delete + building comfort (real viewer, mouse / keyboard)', () => {
  it('Delete key on a block: neighbours lose the reference, free snap reappears, one undo step, redo', async () => {
    const r = await boot();
    await chainOfThree(r);
    const before = topo(r);
    const curveBlock = blockOf(r, 'PN_C1');

    await clickPath(r, 'PN_C1');
    expect(r.ui.getState().selectedBlocks).toEqual([curveBlock]);
    const u0 = undoLen(r);
    key('Delete');
    await until(() => !blockIds(r).includes(curveBlock), 'curve block deleted');
    expect(undoLen(r)).toBe(u0 + 1);
    expect(succ(r, 'PN_S1')).toEqual([]);
    expect(net(r).paths.some((p) => p.successors.includes('PN_S2'))).toBe(false);
    expect(net(r).paths.some((p) => p.id === 'PN_C1')).toBe(false);
    expect(r.ui.getState().selectedBlocks).toEqual([]);
    await until(() => r.snap.getRegistry()?.getById('path-snap:PN_S1:end')?.occupied === false, 'free snap at the predecessor');
    await until(() => r.snap.getRegistry()?.getById('path-snap:PN_S2:start')?.occupied === false, 'free snap at the successor');

    await r.doc.undo();
    await until(() => topo(r) === before, 'one undo restores block + both edges');
    await r.doc.redo();
    await until(() => !blockIds(r).includes(curveBlock), 'redo deletes again');
    expect(succ(r, 'PN_S1')).toEqual([]);
  });

  it('Shift-click extends the selection; Delete removes all selected blocks in ONE step', async () => {
    const r = await boot();
    await chainOfThree(r);
    const before = topo(r);
    const a = blockOf(r, 'PN_S1');
    const c = blockOf(r, 'PN_S2');
    await clickPath(r, 'PN_S1');
    await clickPath(r, 'PN_S2', { shift: true });
    expect([...r.ui.getState().selectedBlocks].sort()).toEqual([a, c].sort());
    // A second Shift-click takes a block out again.
    await clickPath(r, 'PN_S2', { shift: true });
    expect(r.ui.getState().selectedBlocks).toEqual([a]);
    await clickPath(r, 'PN_S2', { shift: true });

    const u0 = undoLen(r);
    key('Delete');
    await until(() => blockIds(r).length === 1, 'both deleted');
    expect(undoLen(r)).toBe(u0 + 1);
    expect(succ(r, 'PN_C1')).toEqual([]);
    await r.doc.undo();
    await until(() => topo(r) === before, 'one undo restores both');
  });

  it('context menu: "Delete chain from here" removes the chain in one step; "Delete <block>" removes one', async () => {
    const r = await boot();
    await chainOfThree(r);
    const before = topo(r);

    await rightClickPath(r, 'PN_S1');
    const snap = r.v.contextMenu.getSnapshot();
    expect(snap.open).toBe(true);
    expect(snap.items.map((i) => i.id)).toEqual(expect.arrayContaining([PATH_MENU_IDS.delete, PATH_MENU_IDS.deleteChain, PATH_MENU_IDS.selectChain, PATH_MENU_IDS.rotate]));
    const u0 = undoLen(r);
    runMenuItem(r, PATH_MENU_IDS.deleteChain);
    await until(() => blockIds(r).length === 0 && net(r).paths.length === 0, 'whole chain deleted');
    expect(undoLen(r)).toBe(u0 + 1);
    await r.doc.undo();
    await until(() => topo(r) === before, 'one undo restores the chain');

    await rightClickPath(r, 'PN_S2');
    runMenuItem(r, PATH_MENU_IDS.delete);
    await until(() => !net(r).paths.some((p) => p.id === 'PN_S2'), 'menu delete removes the block');
    expect(succ(r, 'PN_C1')).toEqual([]);
  });

  it('deleting a junction block (menu) heals its host', async () => {
    const r = await boot();
    await exec(r, 'layout.path.place', { block: 'straight', lengthM: 6, x: 0, z: 0, headingDeg: 0 });
    const host = blockOf(r, 'PN_S1');
    const res = await exec(r, 'layout.path.junction', { kind: 'diverge', pathId: 'PN_S1', s: 3, side: 'left' });
    const jb = String(res.blockId);
    const withJunction = topo(r);
    const branch = net(r).paths.filter((p) => p.block === jb);
    expect(branch.length).toBeGreaterThan(0);

    await rightClickPath(r, branch[branch.length - 1].id, 0.8);
    const ids = r.v.contextMenu.getSnapshot().items.map((i) => i.id);
    expect(ids).toContain(PATH_MENU_IDS.delete);
    expect(ids).not.toContain(PATH_MENU_IDS.rotate); // a junction turns with its host
    runMenuItem(r, PATH_MENU_IDS.delete);
    await until(() => !blockIds(r).includes(jb), 'junction deleted');
    const hostPaths = net(r).paths.filter((p) => p.block === host);
    expect(hostPaths).toHaveLength(1); // healed back into one piece
    expect(net(r).paths).toHaveLength(1);
    await r.doc.undo();
    await until(() => topo(r) === withJunction, 'undo restores the junction');
  });

  it('R turns the selected block by 90°; move → undo → redo', async () => {
    const r = await boot();
    await chainOfThree(r);
    const a = blockOf(r, 'PN_S1');
    await clickPath(r, 'PN_S1');
    const h0 = (net(r).blocks ?? []).find((b) => b.id === a)!.extras.pose[2];
    key('r');
    await until(() => Math.abs((net(r).blocks ?? []).find((b) => b.id === a)!.extras.pose[2] - (h0 + 90)) < 1e-6, 'R turned the block by +90°');
    await r.doc.undo();
    await until(() => Math.abs((net(r).blocks ?? []).find((b) => b.id === a)!.extras.pose[2] - h0) < 1e-6, 'undo turns it back');

    // Move the curve (chain) by its handle, undo, redo.
    const curve = blockOf(r, 'PN_C1');
    await clickPath(r, 'PN_C1');
    expect(r.ui.getState().selectedBlock?.id).toBe(curve);
    const pose = (net(r).blocks ?? []).find((b) => b.id === curve)!.extras.pose;
    const s2Start = (): number[] => specEnds(net(r).paths.find((p) => p.id === 'PN_S2')!.segments)!.start.position;
    const z0 = s2Start()[2];
    r.v.scene.updateMatrixWorld(true);
    const from = screenOf(r, [pose[0], 0.03, pose[1]]);
    const to = screenOf(r, [pose[0], 0.03, pose[1] - 2]);
    r.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...from, button: 0, bubbles: true }));
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2, bubbles: true }));
    r.canvas.dispatchEvent(new PointerEvent('pointermove', { ...to, bubbles: true }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...to, button: 0, bubbles: true }));
    await until(() => Math.abs(s2Start()[2] - z0) > 1, 'the chain moved');
    const z1 = s2Start()[2];
    await r.doc.undo();
    await until(() => Math.abs(s2Start()[2] - z0) < 1e-6, 'undo moves it back');
    expect(succ(r, 'PN_S1')).toEqual(['PN_C1']);
    await r.doc.redo();
    await until(() => Math.abs(s2Start()[2] - z1) < 1e-6, 'redo moves it again');
  });

  it('while the simulation runs, Delete is refused with the visible hint', async () => {
    const r = await boot();
    await chainOfThree(r);
    await clickPath(r, 'PN_C1');
    r.v.setSimulationPaused(PAUSE_KEY, false);
    await until(() => !r.ui.getState().editable, 'locked while running');
    const before = topo(r);
    key('Delete');
    await frame();
    expect(topo(r)).toBe(before);
    expect(r.ui.getState().lastError).toBe(PATH_NETWORK_LOCKED_HINT);
    // The context menu says so too instead of offering the verbs.
    await rightClickPath(r, 'PN_C1');
    expect(r.v.contextMenu.getSnapshot().items.map((i) => i.id)).toEqual([PATH_MENU_IDS.locked]);
    r.v.contextMenu.close();
  });
});
