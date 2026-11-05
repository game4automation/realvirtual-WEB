// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * LOP #248 item 5 on the REAL PalletYard (its GLB carries no DESManager): des.seed.set with the
 * default 42 and with 43, through the command registry as MCP, with a real SceneStore behind the
 * viewer (the app's write path: addNode + setField through the scene document).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { clearShared } from '../helpers/agv-harness';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import { initSceneStore } from '../../src/core/hmi/scene/scene-store-singleton';
import { getSceneStore, setSceneStore } from '../../src/core/hmi/scene/scene-store-ref';
import type { SceneStore } from '../../src/core/hmi/scene/scene-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../../src/core/hmi/des-run-commands';
import { findDesManager } from '../../src/core/material-flow/des-manager-node';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
describe.skipIf(!AVAILABLE)('des.seed.set on the REAL PalletYard', () => {
  let h: TestViewerHandle;
  let v: RVViewer;
  beforeAll(async () => {
    clearShared();
    h = await createTestViewer('webgl');
    v = h.viewer;
    registerAllBehaviors(v.behaviors);
    v.use(new PalletYardPlugin());
    initSceneStore(v);
    await v.loadModel(PALLET_YARD_URL);
    await v.whenSceneReady();
    await Promise.resolve();
    v.simulationKernel!.setMode('des');
    await Promise.resolve();
    ensureDesRunCommandsRegistered();
  }, 240_000);
  afterAll(() => { h?.dispose(); setSceneStore(null as unknown as SceneStore); clearShared(); });

  it('sets 42 (the default) and then 43; both reach the live DES and the scene DESManager', async () => {
    expect(getSceneStore(), 'a real SceneStore').not.toBeNull();
    expect(findDesManager(v.scene), 'the PalletYard GLB carries no DESManager').toBeNull();
    const ctl = v.simulationKernel!.desControl()! as { masterSeed?: number };
    const outcomes: Record<number, unknown> = {};
    for (const seed of [42, 43]) {
      outcomes[seed] = await commandRegistry.execute('des.seed.set', { seed, mode: 'fixed' }, { origin: 'mcp', viewer: v });
      console.info(`[seed-pallet-yard] seed ${seed}: ${JSON.stringify(outcomes[seed])}; live=${ctl.masterSeed}; stored=${JSON.stringify(findDesManager(v.scene) && { path: findDesManager(v.scene)!.path, raw: findDesManager(v.scene)!.rawMasterSeed })}`);
    }
    expect(outcomes[42]).toMatchObject({ ok: true, value: { seed: 42, mode: 'fixed' } });
    expect(outcomes[43]).toMatchObject({ ok: true, value: { seed: 43, mode: 'fixed' } });
    expect(ctl.masterSeed).toBe(43);
    const stored = findDesManager(v.scene);
    expect(stored?.rawMasterSeed).toBe(43);
    expect(v.registry?.getNode(stored!.path), 'the DESManager node is addressable by its path').toBeTruthy();
  }, 120_000);
});
