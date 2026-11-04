// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-2212 Phase 6: the 925 pallets of model-acceptance-palletyard.test.ts must not move when the
// bundled ShippingMonitor script RUNS (that test installs no WebComponentPlugin, so it never executes it).
// Same Base column, seed 42, RNG v2, 1 sim day FastForward - with the script active and observed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '../../src/plugins/des/material-flow';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { PalletYardPlugin } from '../../src/plugins/models/PalletYard';
import { WebComponentPlugin } from '../../src/plugins/web-component-plugin';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { updateDesRunSettings } from '../../src/core/hmi/des-run-settings-store';
import type { DESRunner } from '../../src/plugins/des/des-runner';
import type { DesHandoverBackend } from '../../src/plugins/des/fleet/des-handover';
import { createAcceptanceViewer, loadAcceptanceModel, until, yieldBrowser } from './_model-acceptance';
const BASELINE_PALLETS_OUT = 925; // identical to model-acceptance-palletyard.test.ts
let h: Awaited<ReturnType<typeof createAcceptanceViewer>>;
let plugin: PalletYardPlugin;
let scripts: WebComponentPlugin;
afterAll(() => h?.dispose());
describe('PalletYard model acceptance with the ShippingMonitor script active', () => {
  beforeAll(async () => {
    updateDesRunSettings({ seedMode: 'fixed' });
    h = await createAcceptanceViewer();
    h.viewer.use(new PlanningParametersPlugin());
    plugin = new PalletYardPlugin(); h.viewer.use(plugin);
    scripts = new WebComponentPlugin({ allowScripts: false, createHost: () => RVScriptHost.create() });
    h.viewer.use(scripts);
    await loadAcceptanceModel(h.viewer, '/demo-realvirtual/PalletYard.glb');
    scripts.setAllowScripts(true); // trust release, as in pallet-yard-script-sink
    await scripts.whenWired();
    h.viewer.simulationKernel!.setMode('des');
    await Promise.resolve(); h.viewer.resetSimulation();
    await until(() => plugin.runtime !== null, 'PalletYard runtime');
  }, 240_000);
  it('still ships exactly the Base pallets out while the script counts late shipments', async () => {
    const r = h.viewer.simulationKernel!.desControl() as unknown as DESRunner;
    if (r.rngVersion !== 2) { r.clearMUs(); r.setRngVersion(2); }
    r.setMasterSeed(42);
    const before = plugin.runtime; r.reset();
    await until(() => plugin.runtime !== null && plugin.runtime !== before, 'PalletYard reset runtime');
    await scripts.whenWired();
    const inst = scripts.instances.find(i => i.nodePath.endsWith('/ShippingMonitor'));
    expect(inst, 'ShippingMonitor instance').toBeDefined();
    expect(inst!.ok, inst!.disabledReason ?? '').toBe(true);
    expect(inst!.adapter!.mode).toBe('des');
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
    expect(out, `PalletYard with script: ${out} pallets out after 86400 s sim (expected exactly ${BASELINE_PALLETS_OUT})`).toBe(BASELINE_PALLETS_OUT);
    // The script ran: its rows are published and finite, and it saw a shipment (non-trivial longest gap).
    const rows = h.viewer.stats.list().find(s => s.id === 'scripts')!.rows!().filter(row => row.owner === inst!.nodePath);
    const late = rows.find(row => row.label === 'Late shipments');
    const gap = rows.find(row => row.label === 'Longest shipping gap');
    expect(late, 'Late shipments row').toBeDefined();
    expect(Number.isFinite(Number(late!.value)), 'Late shipments finite').toBe(true);
    expect(Number(gap?.value ?? 0), 'Longest shipping gap > 0 (the script heard shipments)').toBeGreaterThan(0);
  }, 240_000);
});
