// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 Phase 5 — the planner UI controller (`PathNetworkInteraction`)
 * against a real document + the real path visualizer:
 *  - D-N4 selection: block select shows no 453 chrome (`selectedPath` null),
 *    enter = the hit path, Escape leaves the block, then clears; a planner
 *    selection of a `PN_Block_*` node resolves to NO path (M7);
 *  - "weiterbauen": catalog click with a selected block appends at its free
 *    end = ONE undo step, the pieces are linked;
 *  - ghost tool: click near a free end places tangent-true at the port;
 *  - block gizmo: drag of the move handle = ONE `layout.path.move`; rotate knob
 *    in the 15° raster; preview never touches data before release;
 *  - junction slide along the host; Delete removes the block;
 *  - lock: while running the controller is not editable and refuses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import type { RVViewer } from '../../src/core/rv-viewer';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { PATH_BLOCK_DRAG_TYPE, PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { setFatLinePositions } from '../../src/plugins/path-visualizer-plugin';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { specEnds, headingOf } from '../../src/core/engine/rv-path-blocks';
import { fingerprint, makeRig, type Rig } from './path-network-rig';

let rig: Rig;
let ui: PathNetworkInteraction;
let canvas: HTMLCanvasElement;

const viewerOf = (r: Rig): RVViewer => r.stub as unknown as RVViewer;

async function exec(id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: viewerOf(rig) });
  if (!r.ok) throw new Error(r.reason);
  return r.value as Record<string, unknown>;
}

function net() {
  return snapshotNetwork(rig.stub as never).input;
}

/** Client coordinates of a world point (top-down camera, canvas at its rect). */
function screenOf(x: number, y: number, z: number): { clientX: number; clientY: number } {
  const v = new Vector3(x, y, z).project(rig.stub.camera);
  const r = canvas.getBoundingClientRect();
  return { clientX: r.left + ((v.x + 1) / 2) * r.width, clientY: r.top + ((1 - v.y) / 2) * r.height };
}

function pointer(type: string, x: number, z: number, extra: PointerEventInit = {}): PointerEvent {
  return new PointerEvent(type, { ...screenOf(x, 0, z), button: 0, bubbles: true, ...extra });
}

function flushUi(): void {
  rig.scene.updateMatrixWorld(true);
  ui.tick();
}

const undoLen = (): number => rig.doc.historyHead().undoLen;
const wait = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

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
  flushUi();
});

afterEach(() => {
  ui.dispose();
  rig.plugin.dispose();
  canvas.remove();
  setActiveEditTarget(null);
  getDefaultPathNetwork().clear();
});

describe('plan-628 Phase 5 path-network UI', () => {
  it('is active + editable in the authoring mode while reset', () => {
    expect(ui.getState()).toMatchObject({ active: true, editable: true });
  });

  it('D-N4: block click shows no single path, enter selects the path, Esc leaves then clears', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    const blockId = r.blockId as string;
    ui.selectBlock(blockId);
    flushUi();
    expect(ui.getState().selectedBlock?.id).toBe(blockId);
    expect(rig.plugin.selectedPath).toBeNull();
    ui.enterBlock(blockId, 'PN_S1');
    flushUi();
    expect(ui.getState()).toMatchObject({ enteredBlock: blockId, selectedBlock: null, selectedPath: 'PN_S1' });
    expect(rig.plugin.selectedPath).toBe('PN_S1');
    // the planner clearing its (instance) selection does not drop the entered path
    rig.stub.emit('selection-changed', { primaryNode: null });
    expect(rig.plugin.selectedPath).toBe('PN_S1');
    expect(ui.escape()).toBe(true);
    expect(ui.getState().selectedBlock?.id).toBe(blockId);
    expect(rig.plugin.selectedPath).toBeNull();
    expect(ui.escape()).toBe(true);
    expect(ui.getState().selectedBlock).toBeNull();
    expect(ui.escape()).toBe(false);
  });

  it('M7: a planner selection of the block node resolves to no path', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0 });
    const blockNode = rig.nodes.get('Root/PathNetwork/PN_Block_1')!;
    rig.stub.emit('selection-changed', { primaryNode: blockNode });
    expect(rig.plugin.selectedPath).toBeNull();
    rig.stub.emit('selection-changed', { primaryNode: rig.nodes.get('Root/PathNetwork/PN_Block_1/PN_S1')! });
    expect(rig.plugin.selectedPath).toBe('PN_S1');
  });

  it('weiterbauen: catalog click with a selected block appends at its end — ONE undo step, linked', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    ui.selectBlock(r.blockId as string);
    const before = undoLen();
    await ui.pickCatalog('curve-90-l');
    expect(undoLen()).toBe(before + 1);
    expect(ui.getState().toolId).toBeNull();
    const n = net();
    expect(n.paths).toHaveLength(2);
    const first = n.paths.find((p) => p.id === 'PN_S1')!;
    const curve = n.paths.find((p) => p.id !== 'PN_S1')!;
    expect(first.successors).toContain(curve.id);
    expect(ui.getState().selectedBlock?.id).toBe(curve.block);
    // one undo removes exactly the appended piece
    const fpOne = fingerprint(rig);
    await rig.doc.undo();
    expect(net().paths.map((p) => p.id)).toEqual(['PN_S1']);
    await rig.doc.redo();
    expect(fingerprint(rig)).toBe(fpOne);
  });

  it('ghost tool: a click within 0.35 m of a free end places tangent-true at that port', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 30 });
    const end = specEnds(net().paths[0].segments)!.end;
    await ui.pickCatalog('straight-2');
    expect(ui.getState().toolId).toBe('straight-2');
    const before = undoLen();
    expect(ui.handlePointerDown(pointer('pointerdown', end.position[0] + 0.1, end.position[2] + 0.05))).toBe(true);
    await wait();
    expect(undoLen()).toBe(before + 1);
    const added = net().paths.find((p) => p.id !== 'PN_S1')!;
    const e2 = specEnds(added.segments)!;
    expect(Math.hypot(e2.start.position[0] - end.position[0], e2.start.position[2] - end.position[2])).toBeLessThan(1e-3);
    expect(headingOf(e2.start.tangent)).toBeCloseTo(30, 3);
    expect(net().paths.find((p) => p.id === 'PN_S1')!.successors).toContain(added.id);
    expect(ui.getState().toolId).toBe('straight-2'); // stays armed for the next piece
    expect(ui.escape()).toBe(true);
    expect(ui.getState().toolId).toBeNull();
  });

  it('block gizmo: dragging the move handle = ONE layout.path.move, preview leaves data alone', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    ui.selectBlock(r.blockId as string);
    flushUi();
    const fp0 = fingerprint(rig);
    const before = undoLen();
    expect(ui.handlePointerDown(pointer('pointerdown', 0, 0))).toBe(true);
    canvas.dispatchEvent(pointer('pointermove', 1, 2));
    expect(fingerprint(rig)).toBe(fp0);
    window.dispatchEvent(pointer('pointerup', 1, 2));
    await wait();
    expect(undoLen()).toBe(before + 1);
    const s = specEnds(net().paths[0].segments)!.start.position;
    expect(s[0]).toBeCloseTo(1, 2);
    expect(s[2]).toBeCloseTo(2, 2);
  });

  it('block gizmo: the rotate knob turns in the 15° raster about the block pose', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    ui.selectBlock(r.blockId as string);
    flushUi();
    // knob sits 0.6 m to the LEFT of travel (+X → −Z); drag it ~40° counter-heading
    const knob = rig.scene.getObjectByName('__pathNetworkUi:rotate')!;
    expect(knob.visible).toBe(true);
    expect(knob.position.z).toBeCloseTo(-0.6, 6);
    expect(ui.handlePointerDown(pointer('pointerdown', knob.position.x, knob.position.z))).toBe(true);
    const a = (-90 + 40) * Math.PI / 180; // start angle −90° (−Z), +40°
    canvas.dispatchEvent(pointer('pointermove', 0.6 * Math.cos(a), 0.6 * Math.sin(a)));
    window.dispatchEvent(pointer('pointerup', 0.6 * Math.cos(a), 0.6 * Math.sin(a)));
    await wait();
    const t = specEnds(net().paths[0].segments)!.start.tangent;
    expect(headingOf(t)).toBeCloseTo(45, 3); // 40° → 45° raster
  });

  it('junction: the stub slides along its host; Delete removes the block and heals', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 10, x: 0, z: 0, headingDeg: 0 });
    const j = await exec('layout.path.junction', { kind: 'stub', pathId: 'PN_S1', s: 4, side: 'left' });
    const jb = j.blockId as string;
    ui.selectBlock(jb);
    flushUi();
    expect(ui.getState().selectedBlock).toMatchObject({ id: jb, junction: true });
    expect(rig.scene.getObjectByName('__pathNetworkUi:rotate')!.visible).toBe(false);
    const pose0 = net().blocks!.find((b) => b.id === jb)!.extras.pose;
    const before = undoLen();
    expect(ui.handlePointerDown(pointer('pointerdown', pose0[0], pose0[1]))).toBe(true);
    canvas.dispatchEvent(pointer('pointermove', pose0[0] + 2, 0.4));
    window.dispatchEvent(pointer('pointerup', pose0[0] + 2, 0.4));
    await wait();
    expect(undoLen()).toBe(before + 1);
    const pose1 = net().blocks!.find((b) => b.id === jb)!.extras.pose;
    expect(pose1[0] - pose0[0]).toBeCloseTo(2, 1);
    expect(pose1[1]).toBeCloseTo(0, 3); // stays on the host line
    ui.selectBlock(jb);
    expect(await ui.removeSelected()).toBe(true);
    expect(net().blocks!.some((b) => b.id === jb)).toBe(false);
    expect(net().paths).toHaveLength(1); // healed back to one host path
  });

  it('every placed path gets its line; block paths have no 453 handles until entered', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 0 });
    ui.selectBlock(r.blockId as string);
    await ui.pickCatalog('straight-2'); // appended + relinked in ONE transaction
    expect([...rig.plugin.getLineObjects().keys()].sort()).toEqual(['PN_S1', 'PN_S2']);
    const handlePaths = (): string[] => [...new Set([...rig.plugin.getHandleObjects().values()].map((m) => m.userData._rvPathId as string))];
    expect(handlePaths()).toEqual([]);
    ui.enterBlock(r.blockId as string, 'PN_S1');
    expect(handlePaths()).toEqual(['PN_S1']);
    ui.escape();
    expect(handlePaths()).toEqual([]);
  });

  it('catalog drag: dragover moves the ghost, drop places at the free end — ONE undo step, tool idle', async () => {
    await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0, headingDeg: 30 });
    const end = specEnds(net().paths[0].segments)!.end;
    const dt = new DataTransfer();
    dt.setData(PATH_BLOCK_DRAG_TYPE, 'straight-2');
    ui.beginCatalogDrag('straight-2');
    expect(ui.getState().toolId).toBe('straight-2');
    const at = screenOf(end.position[0] + 0.1, 0, end.position[2] + 0.05);
    const over = new DragEvent('dragover', { ...at, dataTransfer: dt, bubbles: true, cancelable: true });
    canvas.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(ui.ghostObject).not.toBeNull();
    const before = undoLen();
    canvas.dispatchEvent(new DragEvent('drop', { ...at, dataTransfer: dt, bubbles: true, cancelable: true }));
    ui.endCatalogDrag();
    await wait();
    expect(undoLen()).toBe(before + 1);
    const added = net().paths.find((p) => p.id !== 'PN_S1')!;
    expect(headingOf(specEnds(added.segments)!.start.tangent)).toBeCloseTo(30, 3);
    expect(net().paths.find((p) => p.id === 'PN_S1')!.successors).toContain(added.id);
    expect(ui.getState().toolId).toBeNull();
  });

  it('catalog drag: a foreign drag (library GLB) is ignored, a cancelled drag disarms', async () => {
    const dt = new DataTransfer();
    dt.setData('text/x-layout-catalog-id', 'conveyor');
    const over = new DragEvent('dragover', { ...screenOf(0, 0, 0), dataTransfer: dt, bubbles: true, cancelable: true });
    canvas.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(false);
    ui.beginCatalogDrag('curve-90-l');
    expect(ui.getState().toolId).toBe('curve-90-l');
    ui.endCatalogDrag();
    expect(ui.getState().toolId).toBeNull();
  });

  it('fat lines: a changed segment count gets a fresh geometry (three caches the instance count)', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 2, x: 0, z: 0 });
    rig.plugin.refresh();
    const line = rig.plugin.getLineObjects().get('PN_S1') as unknown as LineSegments2;
    const g0 = line.geometry;
    const n0 = g0.attributes.instanceStart.count;
    ui.selectBlock(r.blockId as string);
    await ui.setSelectedParams({ lengthM: 10 });
    await wait();
    rig.plugin.refresh();
    const g1 = line.geometry;
    expect(g1.attributes.instanceStart.count).toBeGreaterThan(n0);
    expect(g1).not.toBe(g0);
    const same = new Float32Array(g1.attributes.instanceStart.count * 6);
    setFatLinePositions(line, same);
    expect(line.geometry).toBe(g1); // same count keeps the geometry
  });

  it('lock: while the simulation runs nothing is editable and the catalog refuses', async () => {
    const r = await exec('layout.path.place', { block: 'straight', lengthM: 4, x: 0, z: 0 });
    ui.selectBlock(r.blockId as string);
    rig.stub.runtime.state = 'running';
    rig.stub.simTime = 1;
    flushUi();
    expect(ui.getState()).toMatchObject({ active: true, editable: false });
    const before = undoLen();
    await ui.pickCatalog('straight-2');
    expect(ui.getState().toolId).toBeNull();
    expect(await ui.removeSelected()).toBe(false);
    expect(undoLen()).toBe(before);
    expect(rig.scene.getObjectByName('__pathNetworkUi:move')!.visible).toBe(false);
  });
});
