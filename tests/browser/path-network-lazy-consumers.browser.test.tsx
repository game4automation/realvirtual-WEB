// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PathNetworkUiPlugin, setPathNetworkInteractionLoaderForTests } from '../../src/plugins/path-network/path-network-ui-plugin';
import { PathNetworkToolButton } from '../../src/plugins/path-network/PathNetworkToolbar';
import { SnapPointPickerPopup } from '../../src/plugins/snap-point/SnapPointPickerPopup';
import { snapHoverStore } from '../../src/plugins/snap-point/snap-hover-store';
import { activateContext, deactivateContext } from '../../src/core/hmi/ui-context-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { snapshotNetwork } from '../../src/plugins/path-network/path-network-scene';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { RvDocument } from '../../src/core/ops/rv-document';
import { RvUnifiedExecutor } from '../../src/core/ops/rv-unified-executors';

vi.setConfig({ hookTimeout: 90_000, testTimeout: 90_000 });
const W = 800;
const H = 600;
let handle: TestViewerHandle | null = null;
interface Rig { v: RVViewer; doc: RvDocument; viz: PathVisualizerPlugin; snap: SnapPointPlugin; canvas: HTMLCanvasElement }
afterEach(() => {
  cleanup();
  snapHoverStore.reset();
  deactivateContext('planner');
  setActiveEditTarget(null);
  handle?.dispose();
  handle = null;
  setPathNetworkInteractionLoaderForTests(null);
});
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

it('plan-2036 updates mounted toolbar and open picker when the delayed interaction arrives', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  setPathNetworkInteractionLoaderForTests(async () => {
    await gate;
    return import('../../src/plugins/path-network/path-network-interaction');
  });
  const r = await boot();
  const plugin = r.v.getPlugin<PathNetworkUiPlugin>('path-network-ui')!;
  expect(plugin.interaction).toBeNull();
  const result = await commandRegistry.execute('layout.path.place',
    { block: 'straight', lengthM: 2, x: 0, z: 0, headingDeg: 0 }, { origin: 'mcp', viewer: r.v });
  expect(result.ok).toBe(true);
  await waitFor(() => expect(r.snap.getRegistry()!.getById('path-snap:PN_S1:end')).toBeTruthy());
  snapHoverStore.openPicker(r.snap.getRegistry()!.getById('path-snap:PN_S1:end')!, { x: 400, y: 200 });
  const view = render(<RVViewerProvider value={r.v}>
    <PathNetworkToolButton />
    <SnapPointPickerPopup viewer={r.v} />
  </RVViewerProvider>);
  expect(snapHoverStore.getState().pickerOpen).toBe(true);
  expect(view.queryByTestId('path-network-tool')).toBeNull();
  expect(view.queryByTestId('snap-picker-path-blocks')).toBeNull();
  await act(async () => {
    release();
    expect(await plugin.whenInteractionReady()).not.toBeNull();
  });
  await waitFor(() => {
    expect(view.getByTestId('path-network-tool')).toBeTruthy();
    expect(view.getByTestId('snap-picker-path-blocks')).toBeTruthy();
  });
  // The newly available picker action performs a real, undoable path edit.
  const before = r.doc.historyHead().undoLen;
  fireEvent.click(view.getByTestId('snap-picker-path-curve-90-r'));
  await waitFor(() => expect(snapshotNetwork(r.v as never).input.paths).toHaveLength(2));
  expect(r.doc.historyHead().undoLen).toBe(before + 1);
  await waitFor(() => expect(snapHoverStore.getState().pickerOpen).toBe(false));
  fireEvent.click(view.getByTestId('path-network-tool'));
  expect(await view.findByTestId('path-catalog-straight-2')).toBeTruthy();
});
