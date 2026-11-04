// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2015 — the AGV count of the PalletYard as a parameter.
 *
 * The composition side (`composeYardWithVehicles`, `maxVehiclesFor`), the
 * component rules (`validateYardComponent`, `readVehicleCount`) and the
 * ADMISSION the variant icon hangs on: `checkFieldValue` must accept
 * `PalletYard.VehicleCount` — and the test proves that it is the
 * `paramApply` capability doing the work by withdrawing it and watching the
 * same check fail (negative control, §9.2).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SIZE, DEFAULT_VEHICLES, SIZE_MAX, SIZE_MIN,
  composeYard, composeYardWithVehicles, defaultVehiclesFor, maxVehiclesFor, vehicleStartPaths, composeGraph,
  composeGeometry,
} from '../src/plugins/models/PalletYard/yard-compose';
import { VEHICLE_COUNT_FIELD, VEHICLE_COUNT_MAX, readVehicleCount, registerPalletYardSchema, validateYardComponent } from '@rv/plugins/models/PalletYard/yard-schema';
import {
  PALLET_YARD_OWNER, PALLET_YARD_PLANNING_TITLE, VEHICLES_KEY, palletYardParams, validatePalletYard,
} from '../src/plugins/models/PalletYard/parameters';
import { parsePlanningDeclaration } from '../src/core/planning/rv-planning-params';
import { checkFieldValue } from '../src/core/params/rv-param-field';
import { paramApplyOf, registerParamApply } from '../src/core/engine/rv-component-registry';
import { viewerParamFieldEnv } from '../src/core/params/rv-param-apply';

registerPalletYardSchema();

const check = (field: string, value: number | null = null) =>
  checkFieldValue(viewerParamFieldEnv, 'PalletYard', field, value);

describe('plan-2015 composition at an explicit AGV count', () => {
  it('composes exactly n AGVs with the derived names, placements and start SOCs', () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const yard = composeYardWithVehicles(2, n);
      expect(yard.counts.vehicles, `counts at ${n}`).toBe(n);
      expect(yard.vehicles.map((v) => v.id)).toEqual(Array.from({ length: n }, (_, k) => `Stapler_${k + 1}`));
      expect(yard.config.vehicles).toEqual(yard.vehicles.map((v) => v.id));
      expect(yard.placements.filter((p) => p.asset === 'AGVStacker')).toHaveLength(n);
      // One start SOC per vehicle — the surplus of a smaller fleet is not produced.
      expect(yard.config.battery.startSoc).toHaveLength(n);
      expect(yard.config.battery.startSoc.every((s) => s >= 50 && s <= 90)).toBe(true);
      // Per-station lists stay on stations, not on vehicles.
      expect(yard.config.production.phaseSec).toHaveLength(yard.counts.outputs);
      expect(yard.config.shippingPauses.offsetSec).toHaveLength(yard.counts.inputs);
    }
  });

  it('raising the count APPENDS: the AGVs already there keep their start path', () => {
    const three = composeYardWithVehicles(2, 3).vehicles;
    const five = composeYardWithVehicles(2, 5).vehicles;
    expect(five.slice(0, 3)).toEqual(three);
    expect(composeYardWithVehicles(2, 1).vehicles).toEqual(three.slice(0, 1));
  });

  it('the default count reproduces composeYard(size) byte for byte', () => {
    for (let n = SIZE_MIN; n <= 6; n++) {
      expect(JSON.stringify(composeYardWithVehicles(n, defaultVehiclesFor(n)))).toBe(JSON.stringify(composeYard(n)));
    }
    expect(DEFAULT_VEHICLES).toBe(defaultVehiclesFor(DEFAULT_SIZE));
  });

  it('maxVehiclesFor is the real limit of the graph — one more does not compose', () => {
    for (const n of [1, 2, 4, SIZE_MAX]) {
      const max = maxVehiclesFor(n);
      const { geometry, xMin, xMax } = composeGeometry(n);
      expect(max).toBe(vehicleStartPaths(composeGraph(geometry, xMin, xMax), n).length);
      expect(() => composeYardWithVehicles(n, max)).not.toThrow();
      expect(() => composeYardWithVehicles(n, max + 1)).toThrow(/at most/);
    }
    expect(VEHICLE_COUNT_MAX).toBe(maxVehiclesFor(SIZE_MAX));
    expect(maxVehiclesFor(2)).toBe(8);
    expect(defaultVehiclesFor(2)).toBe(3);
  });

  it('refuses a count that is not a whole number of at least one', () => {
    for (const bad of [0, -1, 2.5, Number.NaN]) {
      expect(() => composeYardWithVehicles(2, bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe('plan-2015 the component rules', () => {
  it('validates against the CURRENT size, not the largest yard', () => {
    expect(validateYardComponent({ Size: 2, [VEHICLE_COUNT_FIELD]: 8 })).toEqual({});
    expect(validateYardComponent({ Size: 2, [VEHICLE_COUNT_FIELD]: 9 })[VEHICLE_COUNT_FIELD])
      .toMatch(/At most 8 AGVs fit a yard of 2 modules/);
    expect(validateYardComponent({ Size: 4, [VEHICLE_COUNT_FIELD]: 9 })).toEqual({});
    expect(validateYardComponent({ Size: 2, [VEHICLE_COUNT_FIELD]: 0 })[VEHICLE_COUNT_FIELD]).toMatch(/at least 1/);
    expect(validateYardComponent({ Size: 2, [VEHICLE_COUNT_FIELD]: 2.5 })[VEHICLE_COUNT_FIELD]).toMatch(/whole number/);
    // A document without the field is valid — the size's default applies.
    expect(validateYardComponent({ Size: 2 })).toEqual({});
  });

  it('reads a usable count out of an rv_extras block and nothing else', () => {
    expect(readVehicleCount({ [VEHICLE_COUNT_FIELD]: 5 }, 2)).toBe(5);
    expect(readVehicleCount({}, 2)).toBeNull();
    expect(readVehicleCount({ [VEHICLE_COUNT_FIELD]: 9 }, 2)).toBeNull();     // more than fits
    expect(readVehicleCount({ [VEHICLE_COUNT_FIELD]: '3' }, 2)).toBeNull();   // not a number
    expect(readVehicleCount({ [VEHICLE_COUNT_FIELD]: 0 }, 2)).toBeNull();
  });
});

describe('plan-2015 the planning row in the Fleet group', () => {
  it('declares Vehicles beside the charge rows, structural, bounded by the size', () => {
    const row = palletYardParams(composeYard(2)).find((p) => p.key === VEHICLES_KEY);
    expect(row, 'the Vehicles row is declared').toBeTruthy();
    expect(row).toMatchObject({
      label: 'Vehicles', type: 'integer', group: 'Fleet', apply: 'reset', min: 1, step: 1, default: 3,
    });
    expect(row!.max).toBe(maxVehiclesFor(2));
    // The whole declaration is well formed (the registry's own parser).
    const parsed = parsePlanningDeclaration({
      owner: PALLET_YARD_OWNER, title: PALLET_YARD_PLANNING_TITLE, params: palletYardParams(composeYard(2)),
    });
    expect(parsed.errors).toEqual([]);
  });

  it('bound and default follow the size, so a redeclare shows what stands there', () => {
    for (const n of [1, 3, 6]) {
      const row = palletYardParams(composeYard(n)).find((p) => p.key === VEHICLES_KEY)!;
      expect({ n, max: row.max, def: row.default }).toEqual({ n, max: maxVehiclesFor(n), def: defaultVehiclesFor(n) });
    }
  });

  it('the cross rule refuses a count that does not fit the committed size', () => {
    expect(validatePalletYard({ size: 2, [VEHICLES_KEY]: 8 })[VEHICLES_KEY]).toBeUndefined();
    expect(validatePalletYard({ size: 2, [VEHICLES_KEY]: 9 })[VEHICLES_KEY]).toMatch(/At most 8 AGVs/);
    expect(validatePalletYard({ size: 4, [VEHICLES_KEY]: 9 })[VEHICLES_KEY]).toBeUndefined();
    expect(validatePalletYard({ size: 2, [VEHICLES_KEY]: 0 })[VEHICLES_KEY]).toMatch(/At least one AGV/);
  });
});

describe('plan-2015 admission — what makes the field variable', () => {
  afterEach(() => registerParamApply('PalletYard', 'rebuild'));

  it('accepts VehicleCount through the rebuild path', () => {
    expect(paramApplyOf('PalletYard')).toBe('rebuild');
    const v = check(VEHICLE_COUNT_FIELD, 5);
    expect(v.ok, JSON.stringify(v)).toBe(true);
    expect(v.ok && v.mode).toBe('rebuild');
    // An unset is admissible too — back to the size's default.
    expect(check(VEHICLE_COUNT_FIELD, null).ok).toBe(true);
    expect(check(VEHICLE_COUNT_FIELD, 2.5).ok).toBe(false);
  });

  it('still refuses the read-only Size and the json groups beside it', () => {
    expect(check('Size', 4)).toMatchObject({ ok: false, reason: 'readonly' });
    expect(check('production')).toMatchObject({ ok: false, reason: 'type' });
    expect(check('vehicles')).toMatchObject({ ok: false, reason: 'type' });
    expect(check('battery')).toMatchObject({ ok: false, reason: 'type' });
  });

  it('NEGATIVE CONTROL: without the paramApply capability the same field is refused', () => {
    expect(check(VEHICLE_COUNT_FIELD, 5).ok).toBe(true);
    registerParamApply('PalletYard', null);
    const v = check(VEHICLE_COUNT_FIELD, 5);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe('unsupported');
    expect(!v.ok && v.detail).toMatch(/has no way to take a changed 'VehicleCount' over/);
  });
});
