// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Real-viewer rig of the plan-628 8.11 browser tests (9.9l / 9.9m / 9.9n /
 * 9.9r): the real viewer with snap plugin, path visualizer and path-network
 * UI on an empty draft scene, a scene document behind the active edit target
 * (undo steps are countable), a top-down camera, and mouse / keyboard helpers
 * that dispatch the events the browser delivers. `mode` boots planner or des.
 *
 * Optionally a minimal planner stand-in (`withPlanner`) registered as
 * `layout-planner`: it owns ONE placement (a box node added through the
 * document), the real rubber-band `BoxSelectController` wired exactly like the
 * planner's canvas interaction (pointer-down on empty canvas → `start`), and
 * the structural planner verbs the path network calls (`removeSelected`,
 * `snapshotPlacements`, `getPlacedRootById`, `moveById`).
 */

import { expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Vector3, type Object3D } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PathNetworkUiPlugin } from '../../src/plugins/path-network/path-network-ui-plugin';
import type { PathNetworkInteraction } from '../../src/plugins/path-network/path-network-interaction';
import { activateContext, deactivateContext } from '../../src/core/hmi/ui-context-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import type { NetworkInput } from '../../src/core/engine/rv-path-network-ops';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { freshOpId } from '../../src/core/ops/rv-op-utils';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { BoxSelectController } from '../../src/plugins/layout-planner/box-select-controller';
import type { BoxSelectHitProvider } from '../../src/plugins/layout-planner/box-select-hit';
import { snapHoverStore } from '../../src/plugins/snap-point/snap-hover-store';

export const RIG_W = 800;
export const RIG_H = 600;
const MAX_FRAMES = 240;

export interface PlannerStandIn {
  readonly placementPath: string;
  readonly node: Object3D;
  readonly box: BoxSelectController;
  readonly providers: Set<BoxSelectHitProvider>;
}

export interface RealRig {
  v: RVViewer;
  doc: RvDocument;
  viz: PathVisualizerPlugin;
  snap: SnapPointPlugin;
  ui: PathNetworkInteraction;
  canvas: HTMLCanvasElement;
  planner: PlannerStandIn | null;
  handle: TestViewerHandle;
}

export const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < MAX_FRAMES && !cond(); i++) await frame();
  expect(cond(), what).toBe(true);
}

/** Boot the rig in `mode`; `withPlanner` adds the planner stand-in with one placement at (px, pz). */
export async function bootRealRig(mode: 'planner' | 'des', opts: { withPlanner?: { x: number; z: number } } = {}): Promise<RealRig> {
  const handle = await createTestViewer('webgl', { width: RIG_W, height: RIG_H });
  const v = handle.viewer;
  const pauseKey = `pn-l5-${mode}`;
  v.setSimulationPaused(pauseKey, true); // path edits need the reset state
  v.modes.register({ id: 'planner', label: 'Planner' }).register({ id: 'des', label: 'DES' });
  v.modes.setMode(mode);
  const providers = new Set<BoxSelectHitProvider>();
  const plannerRef: { node: Object3D | null; path: string; doc: RvDocument | null } = { node: null, path: '', doc: null };
  if (opts.withPlanner) {
    // Registered BEFORE the path network UI, so its init finds it (as main.ts order does).
    const standIn = {
      id: 'layout-planner',
      store: { addCatalogDirect: (): void => {}, removeCatalog: (): void => {}, chainModeEnabled: true },
      setPathBlockEntryHandler: () => () => {},
      registerBoxSelectHitProvider: (p: BoxSelectHitProvider) => { providers.add(p); return () => { providers.delete(p); }; },
      findPlacedIdByRoot: () => null,
      snapshotPlacements: () => ({
        placements: plannerRef.node && plannerRef.node.parent
          ? [{ id: 'P1', position: [plannerRef.node.position.x, plannerRef.node.position.y, plannerRef.node.position.z] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] }]
          : [],
      }),
      getPlacedRootById: (id: string) => (id === 'P1' && plannerRef.node?.parent ? plannerRef.node : null),
      // The planner's Delete: the selected placement removed as ONE (nested) transaction.
      removeSelected: async (): Promise<void> => {
        const doc = plannerRef.doc!;
        const sel = v.selectionManager.getSnapshot().selectedPaths;
        if (!sel.includes(plannerRef.path)) return;
        await doc.withTransaction('Delete item', async () => {
          await doc.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'removeNode', nodePath: plannerRef.path, spec: placementSpec(plannerRef.path) } as unknown as RvOp);
        });
        v.selectionManager.clear();
      },
      moveById: async (_id: string, pos: [number, number, number]): Promise<void> => {
        plannerRef.node!.position.set(pos[0], pos[1], pos[2]);
        plannerRef.node!.updateMatrixWorld(true);
      },
    };
    v.use(standIn as never, 'core');
  }
  const snap = new SnapPointPlugin();
  v.use(snap, 'core');
  const viz = new PathVisualizerPlugin();
  v.use(viz, 'core');
  v.use(new PathNetworkUiPlugin(), 'core');
  await v.loadScene(makeDraftScene({ kind: 'empty' }, pauseKey));
  await v.whenSceneReady();
  activateContext('planner');
  const doc = new RvDocument({ id: pauseKey, name: 'L5', mode: 'scene', executor: new RvUnifiedExecutor(v, 'scene') });
  plannerRef.doc = doc;
  const target: EditTarget = {
    available: true,
    persistsTo: 'scene',
    documentKey: doc,
    setField: () => { throw new Error('unused'); },
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  setActiveEditTarget(target);
  v.camera.position.set(3, 14, 0.001);
  (v.controls as unknown as { target?: Vector3 }).target?.set(3, 0, 0);
  v.camera.lookAt(3, 0, 0);
  v.camera.updateMatrixWorld(true);
  (v.controls as unknown as { update?: () => void }).update?.();
  const uiPlugin = v.getPlugin('path-network-ui') as unknown as PathNetworkUiPlugin;
  // The planner stand-in was registered before the scene loaded: re-run the plugin's sync.
  uiPlugin.onModelLoaded();
  const ui = await uiPlugin.whenInteractionReady();
  if (!ui) throw new Error('Path network interaction failed to load');
  await until(() => ui.getState().editable, 'path network editable');
  const canvas = v.renderer.domElement as HTMLCanvasElement;

  let planner: PlannerStandIn | null = null;
  if (opts.withPlanner) {
    const root = (v as unknown as { currentModel: Object3D }).currentModel;
    const rootPath = v.registry?.getPathForNode(root) ?? root.name;
    const path = `${rootPath}/Placement_P1`;
    await doc.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath: path, spec: { ...placementSpec(path), position: [opts.withPlanner.x, 0, opts.withPlanner.z] } } as unknown as RvOp);
    const node = v.registry!.getNode(path)!;
    expect(node, 'placement node').toBeTruthy();
    const mesh = new Mesh(new BoxGeometry(1, 0.5, 1), new MeshBasicMaterial({ color: 0x888888 }));
    mesh.position.y = 0.25;
    node.add(mesh);
    node.updateMatrixWorld(true);
    plannerRef.node = node;
    plannerRef.path = path;
    const box = new BoxSelectController({
      viewer: v,
      canvas,
      getObjectMap: () => new Map(node.parent ? [['P1', node]] : []),
      getRegistry: () => v.registry,
      getActive: () => true,
      getMuMap: () => null,
      getHitProviders: () => providers,
    });
    box.attach();
    // Registered after the path network UI (plugin init) — its claim on a line wins, as in the app.
    const onDown = (e: PointerEvent): void => { if (e.button === 0) box.start(e); };
    canvas.addEventListener('pointerdown', onDown);
    planner = { placementPath: path, node, box, providers };
  }
  return { v, doc, viz, snap, ui, canvas, planner, handle };
}

function placementSpec(path: string): Record<string, unknown> {
  const i = path.lastIndexOf('/');
  return { parentPath: path.slice(0, i), name: path.slice(i + 1), position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], components: {} };
}

export function disposeRealRig(r: RealRig | null): void {
  snapHoverStore.reset();
  deactivateContext('planner');
  setActiveEditTarget(null);
  r?.planner?.box.dispose();
  r?.handle.dispose();
}

export function screenOf(r: RealRig, p: readonly number[]): { clientX: number; clientY: number } {
  r.v.camera.updateMatrixWorld(true);
  const q = new Vector3(p[0], p[1] ?? 0, p[2]).project(r.v.camera);
  const rect = r.canvas.getBoundingClientRect();
  return { clientX: rect.left + ((q.x + 1) / 2) * rect.width, clientY: rect.top + ((1 - q.y) / 2) * rect.height };
}

export const netOf = (r: RealRig): NetworkInput => snapshotNetwork(r.v as never).input;
export const undoLen = (r: RealRig): number => r.doc.historyHead().undoLen;
export const succOf = (r: RealRig, id: string): string[] | null => netOf(r).paths.find((p) => p.id === id)?.successors ?? null;
export const blockIdsOf = (r: RealRig): string[] => (netOf(r).blocks ?? []).map((b) => b.id).sort();
export const blockOf = (r: RealRig, pathId: string): string => netOf(r).paths.find((p) => p.id === pathId)!.block;

export async function execCmd(r: RealRig, id: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await commandRegistry.execute<Record<string, unknown>>(id, args, { origin: 'mcp', viewer: r.v });
  if (!res.ok) throw new Error(res.reason);
  return res.value as Record<string, unknown>;
}

/** Midpoint (or fraction `f`) of a live path in world space. */
export function pointOn(pathId: string, f = 0.5): number[] {
  const p = getDefaultPathNetwork().get(pathId)!;
  const v = p.getAbsPosition(p.length * f);
  return [v.x, v.y, v.z];
}

/** Pointer events at a screen point, as the browser delivers them. */
export function down(r: RealRig, at: { clientX: number; clientY: number }, extra: PointerEventInit = {}): void {
  const init = { ...at, button: 0, buttons: 1, bubbles: true, pointerType: 'mouse', pointerId: 1, ...extra };
  r.canvas.dispatchEvent(new PointerEvent('pointerdown', init));
}
export function move(r: RealRig, at: { clientX: number; clientY: number }, buttons = 0, extra: PointerEventInit = {}): void {
  const init = { ...at, button: 0, buttons, bubbles: true, pointerType: 'mouse', pointerId: 1, ...extra };
  r.canvas.dispatchEvent(new PointerEvent('pointermove', init));
  window.dispatchEvent(new PointerEvent('pointermove', init));
}
export function up(r: RealRig, at: { clientX: number; clientY: number }, extra: PointerEventInit = {}): void {
  const init = { ...at, button: 0, buttons: 0, bubbles: true, pointerType: 'mouse', pointerId: 1, ...extra };
  window.dispatchEvent(new PointerEvent('pointerup', init));
}

/** A left click at a screen point (down + up). */
export async function clickAt(r: RealRig, at: { clientX: number; clientY: number }, extra: PointerEventInit = {}): Promise<void> {
  down(r, at, extra);
  up(r, at, extra);
  await frame();
}

/** Click a path's line (selects its block). */
export async function clickPath(r: RealRig, pathId: string, opts: { shift?: boolean; f?: number } = {}): Promise<void> {
  await until(() => r.viz.getLineObjects().has(pathId), `line of ${pathId}`);
  r.v.scene.updateMatrixWorld(true);
  await clickAt(r, screenOf(r, pointOn(pathId, opts.f ?? 0.5)), { shiftKey: !!opts.shift });
}

/** A mouse drag from `a` to `b` in `steps` moves (e.g. the marquee). */
export async function drag(r: RealRig, a: { clientX: number; clientY: number }, b: { clientX: number; clientY: number }, extra: PointerEventInit = {}, steps = 6): Promise<void> {
  down(r, a, extra);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    move(r, { clientX: a.clientX + (b.clientX - a.clientX) * t, clientY: a.clientY + (b.clientY - a.clientY) * t }, 1, extra);
    await frame();
  }
  up(r, b, extra);
  await frame();
}

export function key(k: string, extra: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
}

/** Type a string key by key. */
export function typeKeys(text: string): void {
  for (const ch of text) key(ch);
}

/** Hover: a button-less move, then frames for the coalesced hover pick. */
export async function hover(r: RealRig, at: { clientX: number; clientY: number }): Promise<void> {
  move(r, at, 0);
  await frame();
  await frame();
}
