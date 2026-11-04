// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 Phase 4 (review #3, Phase-6 prerequisite) — a Model-Script on the
 * REAL PalletYard, through the real app lifecycle: the viewer loads the scene
 * with the PalletYard plugin, the script is released by the trust gate (the
 * WebComponent plugin wires it from the loaded model), the kernel switches to
 * DES — no private rebind, no second setup. `self.sink('Sink_V1').on(...)` in
 * `setup()` addresses the shipping sink by its PLACEMENT name, the way the
 * yard itself does: the script sees exactly the arrivals of the sink the yard
 * ships into, and no "sink not found" problem is raised.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { getProblems } from '../../src/core/hmi/problems-store';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { clearShared } from '../helpers/agv-harness';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import type { DESRunner } from '@rv/plugins/des/des-runner';
import { instanceAt } from '@rv/plugins/des/fleet/des-handover';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard/index';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { PALLET_YARD_URL, nodeNamed } from './pallet-yard-scene-load';

const AVAILABLE = (await devAssetAvailable(PALLET_YARD_URL)) && (await devAssetAvailable('/library/MobileRobots/AGVStacker.glb'));
const SIM_SEC = 1800;

const SHIPPING = `
function setup(self) {
  const st = self.persist({ v1: [], v2: 0 });
  self.sink('Sink_V1').on(function (mu) { st.v1.push([self.now, mu.id]); });
  self.sink('Sink_V2').on(function () { st.v2++; });
  return { state() { return st; } };
}`;

describe.skipIf(!AVAILABLE)('plan-2212 — script sink listener on the real PalletYard (app lifecycle)', () => {
  let h: TestViewerHandle;
  let v: RVViewer;
  let root: Object3D;
  let yard: PalletYardPlugin;
  let scripts: WebComponentPlugin;
  let runner: DESRunner;
  let scriptNode: Object3D;

  beforeAll(async () => {
    clearShared();
    h = await createTestViewer('webgl');
    v = h.viewer;
    v.loop.setPaused('plan-2212-yard-script', true);
    registerAllBehaviors(v.behaviors);
    yard = new PalletYardPlugin();
    v.use(yard);
    scripts = new WebComponentPlugin({ allowScripts: false, createHost: () => RVScriptHost.create() });
    v.use(scripts);
    await v.loadModel(PALLET_YARD_URL);
    await v.whenSceneReady();
    await Promise.resolve();
    root = (v as unknown as { currentModel: Object3D }).currentModel;
    // The script node of the document (authored id → registered DES address).
    scriptNode = new Object3D();
    scriptNode.name = 'ShippingMonitor';
    scriptNode.userData.realvirtual = { NodeId: 'yard-shipping-monitor-test', WebComponent: { Code: SHIPPING } };
    root.add(scriptNode);
    v.registry!.registerNode(`${root.name}/ShippingMonitor`, scriptNode);
    v.registry!.registerNodeId(scriptNode);
    // Trust release: the plugin wires the scripts of the loaded model.
    scripts.setAllowScripts(true);
    await scripts.whenWired();
    v.simulationKernel!.setMode('des');
    await Promise.resolve();
    runner = v.simulationKernel!.desControl() as unknown as DESRunner;
    v.scene.updateMatrixWorld(true);
  }, 240_000);
  afterAll(() => { h?.dispose(); clearShared(); });

  it('setup() subscribes by placement name; the script sees every arrival of the yard sink', async () => {
    expect(runner, 'DES runner').toBeTruthy();
    expect(yard.runtime, 'yard bound').not.toBeNull();
    const inst = scripts.instances.find(i => i.node === scriptNode)!;
    expect(inst, 'script instance').toBeDefined();
    expect(inst.adapter!.mode).toBe('des');
    expect(inst.ok, inst.disabledReason ?? '').toBe(true);
    expect(getProblems().filter(p => p.id.startsWith('des-script-sink'))).toEqual([]);

    runner.setEndTime(SIM_SEC);
    runner.setSubMode('fastforward');
    for (let i = 0; i < 100_000 && !runner.runComplete; i++) { runner.tick(1 / 60); runner.lateTick(1 / 60); yard.onRender(); }
    expect(runner.runComplete).not.toBeNull();

    const st = inst.component!.callHandler('state').value as { v1: Array<[number, number]>; v2: number };
    const sinkV1 = instanceAt(runner, nodeNamed(root, 'Sink_V1')!, 'sink')!;
    const sinkV2 = instanceAt(runner, nodeNamed(root, 'Sink_V2')!, 'sink')!;
    expect(sinkV1.totalProcessed + sinkV2.totalProcessed, 'the yard shipped').toBeGreaterThan(0);
    expect(st.v1).toHaveLength(sinkV1.totalProcessed);
    expect(st.v2).toBe(sinkV2.totalProcessed);
    expect(getProblems().filter(p => p.id.startsWith('des-script-sink'))).toEqual([]);
  }, 240_000);
});
