// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DES-Perfektion A2 on the REAL PalletYard (tutorial gaps 21 and 13):
 * - the warm-up and end set with des.setEnd survive sim.reset (live AND armed for the new run);
 * - a write issued right after sim.reset is not dropped.
 * Through the command registry as MCP, with a real SceneStore behind the viewer.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RVViewer } from '../../src/core/rv-viewer';
import { registerAllBehaviors } from '../../src/core/behaviors';
import { createTestViewer, type TestViewerHandle } from '../helpers/create-test-viewer';
import { clearShared } from '../helpers/agv-harness';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import { initSceneStore } from '../../src/core/hmi/scene/scene-store-singleton';
import { setSceneStore } from '../../src/core/hmi/scene/scene-store-ref';
import type { SceneStore } from '../../src/core/hmi/scene/scene-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { ensureDesRunCommandsRegistered } from '../../src/core/hmi/des-run-commands';
import { ensureSimCommandsRegistered } from '../../src/plugins/sim-controller/sim-commands';
import { findDesManager } from '../../src/core/material-flow/des-manager-node';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

interface WarmupState { statResetTime: number; statResetDone: boolean; warmupEventId: number }
type Ctl = { endTime?: number; statResetTime?: number; masterSeed?: number; manager?: { exportRunState(): WarmupState } };

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
describe.skipIf(!AVAILABLE)('DES clock settings across sim.reset on the REAL PalletYard', () => {
  let h: TestViewerHandle;
  let v: RVViewer;
  const exec = (id: string, args: Record<string, unknown>) => commandRegistry.execute(id, args, { origin: 'mcp', viewer: v });
  const ctl = () => v.simulationKernel!.desControl()! as unknown as Ctl;
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
    ensureSimCommandsRegistered();
  }, 240_000);
  afterAll(() => { h?.dispose(); setSceneStore(null as unknown as SceneStore); clearShared(); });

  it('gap 21: end and warm-up set by des.setEnd are still live and armed after sim.reset', async () => {
    expect(await exec('des.setEnd', { end: '00:03:00:00', statReset: '00:00:30:00' })).toMatchObject({ ok: true, value: { endTime: 10800, statResetTime: 1800 } });
    expect(await exec('sim.reset', {})).toMatchObject({ ok: true });
    await Promise.resolve();
    const c = ctl();
    console.info(`[clock-reset] after reset: end=${c.endTime} warmup=${c.statResetTime} stored=${JSON.stringify(findDesManager(v.scene) && { end: findDesManager(v.scene)!.rawEndTime, warmup: findDesManager(v.scene)!.rawStatReset })} run=${JSON.stringify(c.manager?.exportRunState?.())}`);
    expect(c.endTime).toBe(10800);
    expect(c.statResetTime).toBe(1800);
    const run = c.manager?.exportRunState?.();
    if (run) {
      expect(run.statResetDone, 'the new run still has its warm-up ahead').toBe(false);
      expect(run.warmupEventId, 'the warm-up event is queued for the new run').toBeGreaterThanOrEqual(0);
    }
    // The command read-back agrees.
    expect(await exec('des.setEnd', {})).toMatchObject({ ok: true, value: { endTime: 10800, statResetTime: 1800 } });
  }, 120_000);

  it('gap 13: a seed written right after sim.reset (same tick) is accepted and stored', async () => {
    const reset = exec('sim.reset', {});
    const seed = exec('des.seed.set', { seed: 44, mode: 'fixed' });
    expect(await reset).toMatchObject({ ok: true });
    expect(await seed).toMatchObject({ ok: true, value: { seed: 44 } });
    expect(ctl().masterSeed).toBe(44);
    expect(findDesManager(v.scene)?.rawMasterSeed).toBe(44);
  }, 120_000);

  it('gap 13: end and warm-up written right after sim.reset are accepted and stored', async () => {
    expect(await exec('sim.reset', {})).toMatchObject({ ok: true });
    const r = await exec('des.setEnd', { end: '00:04:00:00', statReset: '00:00:20:00' });
    expect(r).toMatchObject({ ok: true, value: { endTime: 14400, statResetTime: 1200 } });
    expect(findDesManager(v.scene)).toMatchObject({ rawEndTime: 14400, rawStatReset: 1200 });
  }, 120_000);
});
