// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-628 §9.7 — path network authoring in the REAL viewer.
 *
 * Phase 1 part (layer): a layout document whose only content is a stored
 * `addNode(Path)` (a 10-m straight) loads, the visualizer registers the
 * `Path Network` group (the path arrives AFTER `model-loaded`), and the group
 * eye removes the line pixels and brings them back — booted in `planner` and in
 * `des` (B9: handles there from the start, no mode switch needed).
 *
 * Phases 2/5 add the block drag, the junction tool and the block gizmo here.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { PerspectiveCamera, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { createTestViewer, readRenderTargetPixelsAsync, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { RVViewer } from '../../src/core/rv-viewer';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { makeDraftScene } from '../../src/core/hmi/scene/rv-scene-types';
import { PATH_NETWORK_GROUP, PathVisualizerPlugin } from '../../src/plugins/path-visualizer-plugin';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';

const W = 256;
const H = 192;
/** Bound on frames waited for the visualizer poll (500 ms cadence). */
const MAX_FRAMES = 240;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
});

function frame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < MAX_FRAMES && !cond(); i++) await frame();
  expect(cond(), what).toBe(true);
}

/** A layout document with one 10-m straight as a stored addNode. */
function straightScene(rootPath: string) {
  const scene = makeDraftScene({ kind: 'empty' }, 'pn-layer');
  scene.edits.ops = [{
    id: 'pn_add_1', ts: Date.now(), schemaV: 1, kind: 'addNode',
    nodePath: `${rootPath}/PN_S1`,
    spec: {
      parentPath: rootPath, name: 'PN_S1',
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: { Path: { type: 'Path', version: 1, id: 'PN_S1', segments: [{ kind: 'line', from: [-5, 0, 0], to: [5, 0, 0] }], successors: [] } },
    },
  }] as unknown as RvOp[];
  return scene;
}

/** Count path-green pixels seen by a top-down camera (every layer enabled). */
async function linePixels(v: RVViewer): Promise<number> {
  const renderer = v.renderer as unknown as WebGLRenderer;
  const cam = new PerspectiveCamera(50, W / H, 0.1, 100);
  cam.position.set(0, 12, 0.001);
  cam.lookAt(0, 0, 0);
  cam.layers.enableAll();
  cam.updateMatrixWorld(true);
  const rt = new WebGLRenderTarget(W, H);
  const prevTarget = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    v.scene.updateMatrixWorld(true);
    renderer.render(v.scene, cam);
    const px = await readRenderTargetPixelsAsync(v, rt);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      // Path green 0x43a047 at ANY antialias coverage: green-dominant by RATIO, which
      // is coverage-independent (r/g = 0.42, b/g = 0.44). An absolute `b > 60` gate
      // cannot be used since 9768b0df: that colour's blue is 0x47, so at opacity 0.9
      // only near-fully-covered pixels clear it (48 of 346 on this 256x192 target).
      if (g > 40 && r < g * 0.6 && b < g * 0.6) n++;
    }
    return n;
  } finally {
    renderer.setRenderTarget(prevTarget);
    rt.dispose();
  }
}

async function bootIn(mode: 'planner' | 'des'): Promise<{ v: RVViewer; plugin: PathVisualizerPlugin }> {
  handle = await createTestViewer('webgl', { width: 640, height: 480 });
  const v = handle.viewer;
  v.modes.register({ id: 'planner', label: 'Planner' }).register({ id: 'des', label: 'DES' });
  v.modes.setMode(mode);
  const plugin = new PathVisualizerPlugin();
  v.use(plugin, 'core'); // after the switch: the boot mode must be read at init (B9)
  await v.loadScene(makeDraftScene({ kind: 'empty' }, 'probe'));
  const root = (v as unknown as { currentModel: { name: string } | null }).currentModel!;
  const rootPath = v.registry?.getPathForNode(root as never) ?? root.name;
  await v.loadScene(straightScene(rootPath));
  await v.whenSceneReady();
  return { v, plugin };
}

describe('path network layer in the real viewer (Phase 1)', () => {
  for (const mode of ['planner', 'des'] as const) {
    it(`mode ${mode}: group registered after load, eye off removes the line pixels, eye on restores them`, async () => {
      const { v, plugin } = await bootIn(mode);
      expect(getDefaultPathNetwork().get('PN_S1')).not.toBeNull();
      await until(() => !!v.groups?.get(PATH_NETWORK_GROUP), 'Path Network group registered by the poll');
      expect(v.groups!.get(PATH_NETWORK_GROUP)!.nodes).toEqual([plugin.layer]);
      expect(plugin.isPlannerMode).toBe(true);
      await until(() => plugin.getHandleObjects().size > 0, `handles in ${mode} without a mode switch`);

      const shown = await linePixels(v);
      expect(shown).toBeGreaterThan(50);

      v.groups!.setVisible(PATH_NETWORK_GROUP, false);
      await frame();
      await frame();
      expect(await linePixels(v)).toBe(0);
      expect(plugin.getHandleObjects().size).toBe(0);

      v.groups!.setVisible(PATH_NETWORK_GROUP, true);
      await frame();
      await frame();
      expect(await linePixels(v)).toBeGreaterThan(50);
      expect(plugin.getHandleObjects().size).toBeGreaterThan(0);
    }, 60_000);
  }
});
