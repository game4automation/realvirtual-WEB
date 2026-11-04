// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2015 §9.3 — the AGV count on the REAL demo scene
 * (`public/demo-realvirtual/PalletYard.glb`, the document `doc_palletyard_hzmdb6`).
 *
 * Driven through the REAL parameter apply service with `origin: 'variant'` —
 * the very path the variant management uses — so what this test proves is what a
 * variant does: 3 → 5 → 1 → unset AGVs, each time counted on the BAKED scene
 * (`bakeRegistry`-materialised placements, not the authored tree) and on the
 * bound DES runner.
 *
 * Negative control (§9.3c): the count is read from the materialised placements,
 * so the assertions move with the scene — the last case withdraws the
 * `paramApply` capability and shows the apply refuse the value and the scene stay
 * at 3, which is what the test would see if the parameter did not work at all.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { registerAllBehaviors } from '../src/core/behaviors';
import { PlanningParametersPlugin } from '../src/plugins/planning-parameters';
import { createParamApplyService, type ParamApplyViewer } from '../src/core/params/rv-param-apply';
import type { FieldOp } from '../src/core/params/rv-param-field';
import { paramApplyOf, registerParamApply } from '../src/core/engine/rv-component-registry';
import { PalletYardPlugin } from '../src/plugins/models/PalletYard/index';
import { VEHICLE_COUNT_FIELD } from '@rv/plugins/models/PalletYard/yard-schema';
import { composeYardWithVehicles, defaultVehiclesFor, maxVehiclesFor } from '../src/plugins/models/PalletYard/yard-compose';
import { PALLET_YARD_OWNER, VEHICLES_KEY } from '../src/plugins/models/PalletYard/parameters';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { clearShared } from './helpers/agv-harness';

const YARD_URL = '/demo-realvirtual/PalletYard.glb';
const AVAILABLE = await fetch(YARD_URL, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);

let h: TestViewerHandle;
let v: RVViewer;
let plugin: PalletYardPlugin;
let planning: PlanningParametersPlugin;
let root: Object3D;
let abort: AbortController;

const VEHICLES = `${PALLET_YARD_OWNER}.${VEHICLES_KEY}`;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timeout: ${what}`);
    await sleep(25);
  }
}

const yardRoot = (): Object3D => {
  let hit: Object3D | null = null;
  root.traverse((n) => { if (!hit && n.name === 'PalletYardRoot') hit = n; });
  if (!hit) throw new Error('PalletYardRoot missing');
  return hit;
};

/**
 * The AGVs that STAND IN THE SCENE: reference nodes named `Stapler_N` below the
 * yard root that the placement instancer actually materialised. Counting the
 * composition or the authored tree instead would be blind to a rebuild that did
 * not reach the scene.
 */
function staplersInScene(): string[] {
  return yardRoot().children
    .filter((c) => !!(c.userData?.realvirtual as Record<string, unknown> | undefined)?.AssetReference)
    .filter((c) => /^Stapler_\d+$/.test(c.name))
    .filter((c) => v.placements.instanceOf(c) !== null)
    .map((c) => c.name)
    .sort((a, b) => Number(a.slice(8)) - Number(b.slice(8)));
}

/** The `Agv` component instances the DES runner is bound to. */
const boundAgvs = (): number => {
  const ctl = v.simulationKernel?.desControl() as unknown as { liveInstances?: Array<{ def: { type?: string } }> } | null;
  return (ctl?.liveInstances ?? []).filter((i) => i.def.type === 'Agv').length;
};

/** The stored parameter value on the yard root, or undefined. */
const storedCount = (): unknown =>
  ((yardRoot().userData.realvirtual as Record<string, Record<string, unknown>>).PalletYard ?? {})[VEHICLE_COUNT_FIELD];

function service() {
  return createParamApplyService({
    viewer: v as unknown as ParamApplyViewer,
    documentLoadId: () => 'pallet-yard-vehicle-count',
    signal: () => abort.signal,
  });
}

const yardAddress = (): string => {
  const a = v.registry!.getAddressForNode(yardRoot());
  if (!a) throw new Error('the yard root has no address');
  return a;
};

const op = (value: number | null): FieldOp => (value === null
  ? { address: yardAddress(), component: 'PalletYard', field: VEHICLE_COUNT_FIELD, op: 'unset' }
  : { address: yardAddress(), component: 'PalletYard', field: VEHICLE_COUNT_FIELD, op: 'set', value });

/** Apply a count the way a variant does, then wait for the run to be bound again. */
async function applyCount(value: number | null) {
  const r = await service().apply([op(value)], { origin: 'variant' });
  if (r.ok) await until(() => plugin.runtime !== null, `runtime bound after ${value}`);
  return r;
}

beforeAll(async () => {
  if (!AVAILABLE) return;
  clearShared();
  abort = new AbortController();
  h = await createTestViewer('webgl');
  v = h.viewer;
  v.loop.setPaused('pallet-yard-vehicle-count', true);
  registerAllBehaviors(v.behaviors);
  planning = new PlanningParametersPlugin();
  v.use(planning);
  plugin = new PalletYardPlugin();
  v.use(plugin);
  await v.loadModel(YARD_URL);
  await v.whenSceneReady();
  await Promise.resolve();
  root = (v as unknown as { currentModel: Object3D }).currentModel;
  v.scene.updateMatrixWorld(true);
  v.simulationKernel!.setMode('des');
  await Promise.resolve();
  v.resetSimulation();
  await until(() => plugin.runtime !== null, 'first bind');
}, 300_000);

afterAll(async () => { abort?.abort(); await sleep(300); h?.dispose(); clearShared(); }, 60_000);

describe.skipIf(!AVAILABLE)('plan-2015 the AGV count on the demo scene', () => {
  it('9.3a the document runs 3 AGVs and the field is variable', () => {
    expect(staplersInScene()).toEqual(['Stapler_1', 'Stapler_2', 'Stapler_3']);
    expect(boundAgvs()).toBe(3);
    expect(plugin.yard.counts.vehicles).toBe(3);
    expect(plugin.docVehicles).toBeNull();              // the document carries no value yet
    expect(storedCount()).toBeUndefined();
    // The admission the variant icon hangs on.
    expect(paramApplyOf('PalletYard')).toBe('rebuild');
    expect(service().checkValue('PalletYard', VEHICLE_COUNT_FIELD, 5).ok).toBe(true);
  }, 120_000);

  it('9.3b 3 → 5: two AGVs are PLACED, run and are bound; 5 → 1 removes four', async () => {
    const before = staplersInScene();
    const r = await applyCount(5);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(before).toHaveLength(3);
    expect(staplersInScene()).toEqual(['Stapler_1', 'Stapler_2', 'Stapler_3', 'Stapler_4', 'Stapler_5']);
    expect(boundAgvs()).toBe(5);
    expect(storedCount()).toBe(5);
    expect(plugin.runtime!.vehicleIds).toEqual(composeYardWithVehicles(2, 5).vehicles.map((x) => x.id));
    // A placed AGV is wired like a loaded one: same components, same children.
    const reg = v.registry!;
    const at = (name: string) => yardRoot().children.find((c) => c.name === name)!;
    const typesAt = (name: string) => [...reg.getComponentsAt(reg.getPathForNode(at(name))!).keys()].sort();
    expect(typesAt('Stapler_5')).toEqual(typesAt('Stapler_1'));
    expect(at('Stapler_5').children.map((c) => c.name).sort()).toEqual(at('Stapler_1').children.map((c) => c.name).sort());
    // Every AGV got its own start SOC — the composition derives one per vehicle.
    expect(plugin.yard.config.battery.startSoc).toHaveLength(5);

    const down = await applyCount(1);
    expect(down.ok, JSON.stringify(down)).toBe(true);
    expect(staplersInScene()).toEqual(['Stapler_1']);
    expect(boundAgvs()).toBe(1);
    expect(plugin.yard.config.battery.startSoc).toEqual([90]);
  }, 240_000);

  it('9.3c unset goes back to the size default, and more than fits is refused', async () => {
    const back = await applyCount(null);
    expect(back.ok, JSON.stringify(back)).toBe(true);
    expect(staplersInScene()).toHaveLength(defaultVehiclesFor(2));
    expect(storedCount()).toBeUndefined();

    // 9 does not fit a yard of 2 modules — refused, the scene is untouched.
    const tooMany = await applyCount(9);
    expect(tooMany.ok).toBe(false);
    expect(staplersInScene()).toHaveLength(3);
    expect(boundAgvs()).toBe(3);
  }, 240_000);

  it('9.3e the planning window row (Fleet ▸ Vehicles) rebuilds the fleet and is bounded', async () => {
    const row = () => planning.registry.list().find((p) => p.key === VEHICLES)!;
    expect(row(), 'the row is declared').toBeTruthy();
    expect(row().def).toMatchObject({ label: 'Vehicles', group: 'Fleet', type: 'integer' });
    // An untouched row shows what stands in the scene.
    expect({ value: row().value, source: row().source }).toEqual({ value: 3, source: 'default' });
    expect(row().def.max).toBe(maxVehiclesFor(2));

    // More than fits does not even become pending — the declared bound of THIS size refuses it.
    const tooMany = planning.registry.set(VEHICLES, 9, 'ui');
    expect(tooMany.ok).toBe(false);
    expect(row().pending).toBeUndefined();
    expect(planning.registry.set(VEHICLES, 0, 'ui').ok).toBe(false);

    // Structural: setting it only marks it pending — the scene does not change yet.
    expect(planning.registry.set(VEHICLES, 6, 'ui').ok).toBe(true);
    expect(staplersInScene()).toHaveLength(3);
    const r = await planning.applyPendingAndReset();
    expect(r.ok, JSON.stringify(r)).toBe(true);
    await until(() => plugin.runtime !== null, 'runtime bound after the planning apply');
    expect(staplersInScene()).toHaveLength(6);
    expect(boundAgvs()).toBe(6);
    // The redeclare kept the row on the value the scene has.
    expect(row().value).toBe(6);

    // Back to the document's fleet, so the following cases start from 3 again.
    expect(planning.registry.set(VEHICLES, 3, 'ui').ok).toBe(true);
    const back = await planning.applyPendingAndReset();
    expect(back.ok, JSON.stringify(back)).toBe(true);
    await until(() => plugin.runtime !== null, 'runtime bound after the reset to 3');
    expect(staplersInScene()).toHaveLength(3);
  }, 240_000);

  it('9.3f NEGATIVE CONTROL: without the paramApply capability the apply is refused and nothing moves', async () => {
    expect(staplersInScene()).toHaveLength(3);
    registerParamApply('PalletYard', null);
    try {
      const r = await service().apply([op(5)], { origin: 'variant' });
      expect(r.ok).toBe(false);
      expect(r.error).toBe('invalid');
      expect(r.detail).toMatch(/has no way to take a changed 'VehicleCount' over/);
      expect(staplersInScene()).toHaveLength(3);
      expect(boundAgvs()).toBe(3);
    } finally {
      registerParamApply('PalletYard', 'rebuild');
    }
    // and with the capability back the very same apply works — so 9.3b was not luck
    const r = await applyCount(4);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(staplersInScene()).toHaveLength(4);
    await applyCount(null);
  }, 240_000);
});
