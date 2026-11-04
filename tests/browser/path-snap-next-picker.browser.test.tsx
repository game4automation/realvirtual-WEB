// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.9d (8.4, G3) + the 9.9h step (8.8) — "next part" at a standard
 * snap, by mouse, in the REAL viewer (snap plugin, path visualizer, path
 * network UI, the rendered picker popup):
 *
 *  - hovering a path line reveals its free end snap; a click on that marker
 *    opens the snap picker WITH the "Path blocks" section (Straight, Curve L/R,
 *    Branch, Merge, Stub);
 *  - "Curve R" attaches the curve at the end — ONE undo step, chained
 *    (successor), tangent-true (position + heading);
 *  - a third block through the picker at the curve's free end;
 *  - 9.9h: dragging the middle block's move handle takes the downstream block
 *    along, the chain edge stays and no `path-link-gap` appears;
 *  - the same picker at a conveyor snap offers compatible library parts and no
 *    path-block section (regression of the existing picker).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
vi.setConfig({ hookTimeout: 90_000, testTimeout: 90_000 });
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Group, Object3D, Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PathNetworkUiPlugin } from '../../src/plugins/path-network/path-network-ui-plugin';
import { SnapPointPickerPopup } from '../../src/plugins/snap-point/SnapPointPickerPopup';
import { snapHoverStore } from '../../src/plugins/snap-point/snap-hover-store';
import { activateContext, deactivateContext } from '../../src/core/hmi/ui-context-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { headingOf, specEnds } from '../../src/core/engine/rv-path-blocks';
import { validatePathNetwork } from '../../src/core/engine/rv-path-network-validate';
import { findCompatibleLibraryAssets } from '../../src/plugins/snap-point/library-snap-index';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';

// The compatible-asset lookup loads GLBs; the conveyor regression only needs a list.
vi.mock('../../src/plugins/snap-point/library-snap-index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/plugins/snap-point/library-snap-index')>()),
  findCompatibleLibraryAssets: vi.fn(async () => []),
}));
const mockFindCompatible = vi.mocked(findCompatibleLibraryAssets);

const W = 800;
const H = 600;
const MAX_FRAMES = 240;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  cleanup();
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
  canvas: HTMLCanvasElement;
}

async function boot(): Promise<Rig> {
  handle = await createTestViewer('webgl', { width: W, height: H });
  const v = handle.viewer;
  v.setSimulationPaused('pn-picker', true); // path edits need the reset state
  v.modes.register({ id: 'planner', label: 'Planner' });
  v.modes.setMode('planner');
  const snap = new SnapPointPlugin();
  v.use(snap, 'core');
  const viz = new PathVisualizerPlugin();
  v.use(viz, 'core');
  v.use(new PathNetworkUiPlugin(), 'core');
  await v.loadScene(makeDraftScene({ kind: 'empty' }, 'pn-picker'));
  await v.whenSceneReady();
  expect(await v.getPlugin<PathNetworkUiPlugin>('path-network-ui')!.whenInteractionReady()).not.toBeNull();
  // The planner's "authoring is live" UI context (the layout planner sets it in the app).
  activateContext('planner');
  // The scene document the layout.path.* commands book into (the real executor).
  const doc = new RvDocument({ id: 'pn-picker', name: 'Picker', mode: 'scene', executor: new RvUnifiedExecutor(v, 'scene') });
  const target: EditTarget = {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: () => { throw new Error('unused'); },
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(target);
  // Top-down camera over the work area (+X right on screen).
  v.camera.position.set(3, 12, 0.001);
  (v.controls as unknown as { target?: Vector3 }).target?.set(3, 0, 0);
  v.camera.lookAt(3, 0, 0);
  v.camera.updateMatrixWorld(true);
  (v.controls as unknown as { update?: () => void }).update?.();
  const canvas = v.renderer.domElement as HTMLCanvasElement;
  return { v, doc, viz, snap, canvas };
}

function screenOf(r: Rig, p: readonly number[]): { clientX: number; clientY: number } {
  r.v.camera.updateMatrixWorld(true);
  const q = new Vector3(p[0], p[1] ?? 0, p[2]).project(r.v.camera);
  const rect = r.canvas.getBoundingClientRect();
  return { clientX: rect.left + ((q.x + 1) / 2) * rect.width, clientY: rect.top + ((1 - q.y) / 2) * rect.height };
}

const net = (r: Rig) => snapshotNetwork(r.v as never).input;

async function exec(r: Rig, id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: r.v });
  if (!res.ok) throw new Error(res.reason);
  return res.value as Record<string, unknown>;
}

const undoLen = (r: Rig): number => r.doc.historyHead().undoLen;

/** A mouse move as the browser delivers it (pointer + mouse events on the canvas). */
function move(r: Rig, at: { clientX: number; clientY: number }, extra: MouseEventInit = {}): void {
  r.canvas.dispatchEvent(new PointerEvent('pointermove', { ...at, bubbles: true, ...extra }));
  r.canvas.dispatchEvent(new MouseEvent('mousemove', { ...at, bubbles: true, ...extra }));
}

/** A left click as the browser delivers it. */
function click(r: Rig, at: { clientX: number; clientY: number }): void {
  r.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0, bubbles: true }));
  r.canvas.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0, bubbles: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { ...at, button: 0, bubbles: true }));
  window.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0, bubbles: true }));
}

const markerVisible = (r: Rig, snapId: string): boolean =>
  !!(r.snap.getMarkerRenderer() as unknown as { handleBySnapId: Map<string, { root?: Object3D }> }).handleBySnapId.get(snapId)?.root?.visible;

/** Hover the line of `pathId` in its middle, then move onto its `end` marker and click it. */
async function openPickerAtEnd(r: Rig, pathId: string, end: 'start' | 'end'): Promise<void> {
  const p = net(r).paths.find((x) => x.id === pathId)!;
  const ends = specEnds(p.segments)!;
  const live = getDefaultPathNetwork().get(pathId)!;
  const mid = live.getAbsPosition(live.length / 2);
  const midS = [mid.x, mid.y, mid.z];
  await until(() => r.viz.getLineObjects().has(pathId), `line of ${pathId}`);
  r.v.scene.updateMatrixWorld(true);
  move(r, screenOf(r, midS));
  await frame();
  const snapId = `path-snap:${pathId}:${end}`;
  await until(() => markerVisible(r, snapId), `hover on ${pathId} reveals ${snapId}`);
  const at = screenOf(r, end === 'end' ? ends.end.position : ends.start.position);
  move(r, at);
  await until(() => snapHoverStore.getState().hovered?.id === snapId, `${snapId} hovered`);
  click(r, at);
  await until(() => snapHoverStore.getState().pickerOpen, 'picker open');
}

describe('plan-628 9.9d next part at a standard snap (real viewer, mouse)', () => {
  it('free path end → picker with path blocks → Curve R chained + tangent; third block; chain drag keeps the edge', async () => {
    const r = await boot();
    render(<SnapPointPickerPopup viewer={r.v} />);
    await exec(r, 'layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 });
    await until(() => r.snap.getRegistry()!.getById('path-snap:PN_S1:end') !== null, 'path-end snaps registered');

    // 1 — hover → free snap → click → picker with the path-block section
    await openPickerAtEnd(r, 'PN_S1', 'end');
    const section = await waitFor(() => document.querySelector('[data-testid="snap-picker-path-blocks"]') as HTMLElement);
    expect(section).toBeTruthy();
    const labels = [...section.querySelectorAll('[data-testid^="snap-picker-path-"]')].map((e) => e.textContent);
    expect(labels).toEqual(['Straight', 'Curve L', 'Curve R', 'Branch', 'Merge', 'Stub']);

    // 2 — Curve R: ONE undo step, chained, tangent-true
    const before = undoLen(r);
    fireEvent.click(document.querySelector('[data-testid="snap-picker-path-curve-90-r"]')!);
    await until(() => net(r).paths.length === 2, 'curve attached');
    await waitFor(() => expect(snapHoverStore.getState().pickerOpen).toBe(false));
    expect(undoLen(r)).toBe(before + 1);
    let n = net(r);
    const curve = n.paths.find((p) => p.id !== 'PN_S1')!;
    expect(n.paths.find((p) => p.id === 'PN_S1')!.successors).toEqual([curve.id]);
    const sEnd = specEnds(n.paths.find((p) => p.id === 'PN_S1')!.segments)!.end;
    const cStart = specEnds(curve.segments)!.start;
    expect(Math.hypot(cStart.position[0] - sEnd.position[0], cStart.position[2] - sEnd.position[2])).toBeLessThan(0.005);
    expect(Math.abs(headingOf(cStart.tangent) - headingOf(sEnd.tangent))).toBeLessThan(2);
    const curveBlock = (n.blocks ?? []).find((b) => b.id === curve.block)!;
    expect(curveBlock.extras.kind).toBe('curve');
    expect(curveBlock.extras.params.side).toBe('right');

    // 3 — a third block through the picker at the curve's free end
    await until(() => !!r.snap.getRegistry()!.getById(`path-snap:${curve.id}:end`), 'curve end snap');
    await openPickerAtEnd(r, curve.id, 'end');
    fireEvent.click(await waitFor(() => document.querySelector('[data-testid="snap-picker-path-straight-2"]') as HTMLElement));
    await until(() => net(r).paths.length === 3, 'third block attached');
    n = net(r);
    const third = n.paths.find((p) => p.id !== 'PN_S1' && p.id !== curve.id)!;
    expect(n.paths.find((p) => p.id === curve.id)!.successors).toEqual([third.id]);
    expect(validatePathNetwork(n).issues.filter((i) => i.code === 'path-link-gap' || i.code === 'path-kink')).toEqual([]);
    await waitFor(() => expect(snapHoverStore.getState().pickerOpen).toBe(false));

    // 4 — 9.9h: drag the MIDDLE block (the curve) by its move handle — the third follows
    const ui = (r.v.getPlugin('path-network-ui') as unknown as PathNetworkUiPlugin).interaction!;
    ui.selectBlock(curve.block);
    r.v.scene.updateMatrixWorld(true);
    const pose = curveBlock.extras.pose;
    const thirdStart0 = specEnds(third.segments)!.start.position;
    const from = screenOf(r, [pose[0], 0.03, pose[1]]);
    const to = screenOf(r, [pose[0], 0.03, pose[1] - 2]);
    r.canvas.dispatchEvent(new PointerEvent('pointerdown', { ...from, button: 0, bubbles: true }));
    move(r, { clientX: (from.clientX + to.clientX) / 2, clientY: (from.clientY + to.clientY) / 2 });
    move(r, to);
    window.dispatchEvent(new PointerEvent('pointerup', { ...to, button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { ...to, button: 0, bubbles: true }));
    await until(() => {
      const t = net(r).paths.find((p) => p.id === third.id);
      return !!t && Math.abs(specEnds(t.segments)!.start.position[2] - thirdStart0[2]) > 1;
    }, 'the downstream block followed the drag');
    n = net(r);
    expect(n.paths.find((p) => p.id === curve.id)!.successors).toEqual([third.id]);
    expect(validatePathNetwork(n).issues.filter((i) => i.code === 'path-link-gap')).toEqual([]);
  });

  it('the same picker at a conveyor snap offers library parts and no path blocks', async () => {
    const r = await boot();
    mockFindCompatible.mockResolvedValueOnce([
      { entry: { id: 'belt-1m', name: 'Belt 1 m', category: 'conveyor', glbUrl: 'x.glb' }, ownSnapName: 'Snap-XN-convroll' },
    ]);
    render(<SnapPointPickerPopup viewer={r.v} />);
    const owner = new Group();
    owner.name = 'Conveyor';
    const port = new Object3D();
    port.name = 'Snap-XP-convroll';
    port.position.set(0.5, 0, 0);
    owner.add(port);
    r.v.scene.add(owner);
    r.snap.rescanOwner(owner);
    const sp = r.snap.getRegistry()!.getByOwnerRoot(owner)[0];
    expect(sp.typeId).toBe('convroll');
    snapHoverStore.openPicker(sp, { x: 200, y: 200 });
    await waitFor(() => expect(document.querySelectorAll('[data-testid="library-item"]').length).toBe(1));
    expect(document.querySelector('[data-testid="snap-picker-path-blocks"]')).toBeNull();
  });
});
