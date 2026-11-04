// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-681 §9.3 (continuous half) — the PalletYard size through the planning window
// in the CONTINUOUS kernel: 2 → 4 → Apply mid-run, ten simulated minutes, at least one
// order at a station of the new modules; back to 2.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { composeYard } from '../../src/plugins/models/PalletYard/yard-compose';
import { loadContinuousYard, type ContinuousYard } from './pallet-yard-continuous-scene';
import { PALLET_YARD_URL } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);

describe.skipIf(!AVAILABLE)('PalletYard size in the continuous kernel (plan-681 Phase 3)', () => {
  let y: ContinuousYard;
  let planning: PlanningParametersPlugin;
  const yardRoot = (): Object3D => {
    let hit: Object3D | null = null;
    y.root.traverse((n) => { if (!hit && n.name === 'PalletYardRoot') hit = n; });
    return hit!;
  };
  const placementIds = (): string[] => yardRoot().children
    .filter((c) => !!(c.userData?.realvirtual as Record<string, unknown> | undefined)?.AssetReference)
    .map((c) => c.name).sort();

  beforeAll(async () => {
    y = await loadContinuousYard({
      plugin: true,
      before: (v) => { planning = new PlanningParametersPlugin(); (v as unknown as { use(p: unknown): void }).use(planning); },
    });
    y.runTo(60);
  }, 240_000);
  afterAll(() => { y?.dispose(); });

  it('2 → 4 mid-run: rebuilt, restarted, a new station serves an order within 10 min', async () => {
    expect(planning.registry.set('palletYard.size', 4, 'ui').ok).toBe(true);
    const r = await planning.applyPendingAndReset();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    y.tick(2);                                  // simulation-start → the plugin binds the rebuilt yard
    expect(placementIds()).toEqual(composeYard(4).placements.map((p) => p.id).sort());
    expect(y.rt.vehicleIds).toEqual(composeYard(4).vehicles.map((v) => v.id));
    expect(y.now()).toBeLessThan(1);
    y.runTo(600);
    expect(y.rt.jobLog.some((j) => /:(pick|retrieve):A[34]>|>(V[34]|P(7|8|9|1[0-2]))$/.test(j)), y.rt.jobLog.join(' ')).toBe(true);
  }, 480_000);

  it('4 → 2: back to the document size, the yard runs on', async () => {
    expect(planning.registry.set('palletYard.size', 2, 'ui').ok).toBe(true);
    const r = await planning.applyPendingAndReset();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    y.tick(2);
    expect(placementIds()).toEqual(composeYard(2).placements.map((p) => p.id).sort());
    expect(y.rt.vehicleIds).toEqual(composeYard(2).vehicles.map((v) => v.id));
    y.runTo(300);
    expect(y.rt.counters.picks).toBeGreaterThan(0);
  }, 480_000);
});
