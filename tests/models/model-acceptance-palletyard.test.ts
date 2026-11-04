// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Criterion: exact pallets-out equality; fixed seed drift is a behavior change requiring deliberate re-recording.
// One sim day FastForward covers stochastic downtime as well as steady production.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../src/plugins/des/material-flow';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import { updateDesRunSettings } from '../../src/core/hmi/des-run-settings-store';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DesHandoverBackend } from '../../src/plugins/des/fleet/des-handover';
import { createAcceptanceViewer, loadAcceptanceModel, until, yieldBrowser } from './_model-acceptance';
// Baseline recorded 2026-11-02: seed 42, RNG v2, Base column (3 AGVs, downtime MTBF 3600 s /
// MTTR 600 s stochastic), 1 sim day FastForward. Tolerance 0: the same seed must give the
// identical count. A deliberate model/DES change that moves it is re-recorded here, with reason.
const BASELINE_PALLETS_OUT = 925;
let h: Awaited<ReturnType<typeof createAcceptanceViewer>>;
let plugin: PalletYardPlugin;
afterAll(() => h?.dispose());
describe('PalletYard model acceptance', () => {
  beforeAll(async () => {
    updateDesRunSettings({ seedMode: 'fixed' });
    h = await createAcceptanceViewer();
    h.viewer.use(new PlanningParametersPlugin());
    plugin = new PalletYardPlugin(); h.viewer.use(plugin);
    await loadAcceptanceModel(h.viewer, '/demo-realvirtual/PalletYard.glb');
    h.viewer.simulationKernel!.setMode('des');
    await Promise.resolve(); h.viewer.resetSimulation();
    await until(() => plugin.runtime !== null, 'PalletYard runtime');
  }, 240_000);
  it('matches Base pallets out after one sim day', async () => {
    const r = h.viewer.simulationKernel!.desControl() as unknown as DESRunner;
    if (r.rngVersion !== 2) { r.clearMUs(); r.setRngVersion(2); }
    r.setMasterSeed(42);
    const before = plugin.runtime; r.reset();
    await until(() => plugin.runtime !== null && plugin.runtime !== before, 'PalletYard reset runtime');
    const rt = plugin.runtime!, be = rt.adapters as DesHandoverBackend;
    const manager = r.getManager(), start = performance.now();
    for (let t = 1; t <= 86400; t++) {
      be.clock.schedule(t, () => {}); manager.processUpTo(t, 1e8); rt.frame();
      if (t % 300 === 0) {
        if (performance.now() - start > 180_000) throw new Error(`PalletYard: ${t} s sim (expected 86400 within 180 s wall)`);
        await yieldBrowser();
      }
    }
    const out = (be.sinkOf('V1')?.totalProcessed ?? 0) + (be.sinkOf('V2')?.totalProcessed ?? 0);
    console.log(`PALLETYARD_PALLETS_OUT=${out}`, { delivered: rt.counters.delivered, produced: rt.counters.produced });
    expect(out, `PalletYard: ${out} pallets out after 86400 s sim (expected exactly ${BASELINE_PALLETS_OUT}, Base column, seed 42, RNG v2)`).toBe(BASELINE_PALLETS_OUT);
  }, 240_000);
});
