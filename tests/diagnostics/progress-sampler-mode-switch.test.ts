// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
/**
 * Continuous → DES in the same viewer, then "Save Snapshot" (LOP, release 6.6.0).
 *
 * On the PalletYard: the progress sampler kept the continuous pallets (MUs) it had sampled across the mode switch.
 * The switch is Reset-on-Switch (simulation-kernel.ts: `clearMUs()` on the outgoing
 * executor), so those MUs no longer exist — but the sampler only drops them on its next
 * sample (every 60 fixed steps). A DES snapshot taken before that threw
 * `diag.blockage: sampled MU has no stable DES id` (rv-progress-wiring.ts snapshotState).
 */
import { afterEach, expect, it } from 'vitest';
import { registerAllBehaviors } from '../../src/core/behaviors';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import { resetDESMUCounter } from '../../src/plugins/des/rv-des-mu';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { SnapPointPlugin } from '../../src/plugins/snap-point';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import { createParityHost, type ParityHost } from '../helpers/parity-harness';
import { clearShared } from '../helpers/agv-harness';
import { devAssetAvailable } from '../fixtures/dev-asset-available';

const URL_ = '/demo-realvirtual/PalletYard.glb';
const AVAILABLE = await devAssetAvailable(URL_);

let host: ParityHost | null = null;
afterEach(() => { host?.dispose(); host = null; clearShared(); });

it.skipIf(!AVAILABLE)('a DES snapshot right after continuous → DES does not carry continuous MUs', async () => {
  clearShared(); resetDESMUCounter();
  host = await createParityHost();
  const v = host.viewer;
  registerAllBehaviors(v.behaviors);
  v.use(new SnapPointPlugin());
  v.use(new PalletYardPlugin());
  const data = await (await fetch(URL_)).arrayBuffer();
  const blob = URL.createObjectURL(new Blob([data], { type: 'model/gltf-binary' }));
  try {
    await v.loadModel(blob, { modelName: 'PalletYard.glb', identityUrl: URL_ });
    await v.whenSceneReady();
    await v.getPlugin<WebComponentPlugin>('web-component')?.whenWired();
  } finally { URL.revokeObjectURL(blob); }
  v.scene.updateMatrixWorld(true);
  const tick = (v as unknown as { _tickOnce(dt: number): void })._tickOnce.bind(v);
  const sampledMus = () => (v.progressWiring as unknown as { mus: Map<object, unknown> }).mus.size;

  // Continuous until the sampler holds live MUs.
  expect(v.simulationKernel!.mode).toBe('continuous');
  for (let i = 0; i < 240 && sampledMus() === 0; i++) tick(0.25);
  expect(sampledMus(), 'continuous run sampled MUs').toBeGreaterThan(0);

  v.simulationKernel!.setMode('des');
  expect(v.simulationKernel!.mode).toBe('des');
  const runner = v.simulationKernel!.desControl() as unknown as DESRunner;
  expect(runner).toBeTruthy();

  // "Save Snapshot" right after the switch, before the sampler's next sample.
  let snapshot = '';
  expect(() => { snapshot = runner.snapshotJson(); }).not.toThrow();
  expect(JSON.parse(snapshot)).toBeTruthy();
  // Reset-on-Switch: nothing of the continuous run may survive in the sampler.
  expect(sampledMus(), 'continuous MUs left in the sampler').toBe(0);
}, 240_000);
