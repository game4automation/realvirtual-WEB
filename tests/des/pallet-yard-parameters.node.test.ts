// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-630 §9.8 (pure half) + plan-681 §2.4 — the PalletYard planning declaration,
// the configuration it derives and the live takt change (pure, no viewer).
import { describe, expect, it } from 'vitest';
import { parsePlanningDeclaration, checkPlanningValue } from '@rv/core/planning/rv-planning-params';
import {
  PALLET_YARD_OWNER, PALLET_YARD_PLANNING_TITLE, SIZE_KEY, SLOTS_KEY, VEHICLES_KEY, derivePalletYardConfig, intervalOfRate,
  palletYardParams, rateKeyOf, stationActiveKeyOf, validatePalletYard,
} from '../../src/plugins/models/PalletYard/parameters';
import { DEFAULT_YARD, composeYard } from '../../src/plugins/models/PalletYard/yard-compose';
import { PALLET_YARD_CONFIG } from '../../src/plugins/models/PalletYard/layout';
import { createTakt, intervalOf, retimeTakt, taktDue, taktHeadFree } from '@rv/core/fleet/core/order-sources';

describe('palletYardParams — the declaration', () => {
  it('declares size as integer 1..16, default 2, reset, group Size, label Module (plan-681 §2.4)', () => {
    const size = palletYardParams(DEFAULT_YARD).find((p) => p.key === SIZE_KEY)!;
    expect(size).toMatchObject({ type: 'integer', min: 1, max: 16, step: 1, default: 2, apply: 'reset', group: 'Size', label: 'Module' });
  });

  it('is a valid declaration at every size, instance keys follow the size', () => {
    for (const n of [1, 2, 4, 16]) {
      const yard = composeYard(n);
      const parsed = parsePlanningDeclaration({ owner: PALLET_YARD_OWNER, title: PALLET_YARD_PLANNING_TITLE, params: palletYardParams(yard) });
      expect(parsed.errors).toEqual([]);
      const keys = palletYardParams(yard).map((p) => p.key);
      expect(keys).toContain(rateKeyOf(`A${n}`));
      expect(keys).toContain(stationActiveKeyOf(`V${n}`));
      expect(keys).not.toContain(rateKeyOf(`A${n + 1}`));
    }
  });

  it('only structure-free parameters are live (plan-630 Strukturinvariante)', () => {
    for (const p of palletYardParams(composeYard(3))) {
      // plan-2015: the AGV count is structural too — the yard is recomposed and rematerialised.
      const structural = p.key === SIZE_KEY || p.key.startsWith('station.') || p.key === SLOTS_KEY || p.key === VEHICLES_KEY;
      expect(p.apply, p.key).toBe(structural ? 'reset' : 'live');
    }
  });

  it('size outside 1..16 or not an integer is rejected by the registry check', () => {
    const size = palletYardParams(DEFAULT_YARD).find((p) => p.key === SIZE_KEY)!;
    expect(checkPlanningValue(size, 17).ok).toBe(false);
    expect(checkPlanningValue(size, 0).ok).toBe(false);
    expect(checkPlanningValue(size, 2.5).ok).toBe(false);
    expect(checkPlanningValue(size, 4).ok).toBe(true);
  });
});

describe('derivePalletYardConfig', () => {
  it('at the defaults equals the composition (and the legacy configuration) — the M3 parity base', () => {
    const cfg = derivePalletYardConfig(DEFAULT_YARD, {});
    const { intervalPerOutput, ...production } = cfg.production;
    expect({ ...cfg, production }).toEqual(DEFAULT_YARD.config);
    expect(intervalPerOutput).toEqual([90, 90]);
    expect({ ...cfg, production }).toEqual(PALLET_YARD_CONFIG);
    // a copy — the composition stays untouched by a later live change
    cfg.battery.threshold = 1;
    expect(DEFAULT_YARD.config.battery.threshold).toBe(30);
  });

  it('drops a switched-off station and keeps phase / pause offset with the remaining one', () => {
    const cfg = derivePalletYardConfig(DEFAULT_YARD, { [stationActiveKeyOf('A1')]: false, [stationActiveKeyOf('V1')]: false });
    expect(cfg.stations.filter((s) => s.kind === 'pick').map((s) => s.id)).toEqual(['A2']);
    expect(cfg.production.phaseSec).toEqual([45]);
    expect(cfg.stations.filter((s) => s.kind === 'drop').map((s) => s.id)).toEqual(['V2']);
    expect(cfg.shippingPauses.offsetSec).toEqual([900]);
  });

  it('keeps the first k floor slots of every module', () => {
    const cfg = derivePalletYardConfig(composeYard(4), { [SLOTS_KEY]: 1 });
    expect(cfg.stations.filter((s) => s.kind === 'buffer').map((s) => s.id)).toEqual(['P1', 'P4', 'P7', 'P10']);
  });

  it('maps a load to the takt interval; 0 Pal/h disables the output', () => {
    const cfg = derivePalletYardConfig(DEFAULT_YARD, { [rateKeyOf('A2')]: 60 });
    expect(cfg.production.intervalPerOutput).toEqual([90, 60]);
    expect(intervalOfRate(0)).toBe(Infinity);
  });
});

describe('validatePalletYard', () => {
  it('needs one active output and one active input, a sane pause plan, threshold < target', () => {
    expect(validatePalletYard({ [SIZE_KEY]: 2 })).toEqual({});
    expect(Object.keys(validatePalletYard({ [SIZE_KEY]: 2, [stationActiveKeyOf('A1')]: false, [stationActiveKeyOf('A2')]: false })))
      .toEqual([stationActiveKeyOf('A1')]);
    expect(validatePalletYard({ 'shipping.everySec': 600, 'shipping.durationSec': 600 })['shipping.durationSec']).toBeTruthy();
    expect(validatePalletYard({ 'battery.threshold': 80, 'battery.target': 80 })['battery.threshold']).toBeTruthy();
  });
});

describe('takt — live load change (plan-630 §2.13, Gate R1 #6)', () => {
  const prod = () => ({ intervalSec: 90, phaseSec: [0, 45], intervalPerOutput: [90, 90] });

  it('re-bases on the last release: nextAt = max(now, last + new interval)', () => {
    const p = prod();
    const s = createTakt(p, 0);
    expect(taktDue(s, p, 0, true)).toBe(true);           // released at 0, next at 90
    p.intervalPerOutput[0] = 60;
    retimeTakt(s, p, 30);
    expect(s.nextAt).toBe(60);
    p.intervalPerOutput[0] = 20;
    retimeTakt(s, p, 30);
    expect(s.nextAt).toBe(30);                          // last + 20 already passed → now
  });

  it('0 Pal/h shuts both release paths and drops a blocked takt; 0 → x plans exactly one instant', () => {
    const p = prod();
    const s = createTakt(p, 1);
    expect(taktDue(s, p, 45, false)).toBe(false);        // blocked at its first instant
    expect(s.blocked).toBe(true);
    p.intervalPerOutput[1] = Infinity;
    retimeTakt(s, p, 50);
    expect(s).toMatchObject({ disabled: true, blocked: false, nextAt: null });
    expect(taktHeadFree(s, p, 51)).toBe(false);         // the freed head releases nothing
    expect(taktDue(s, p, 1000, true)).toBe(false);
    p.intervalPerOutput[1] = 90;
    retimeTakt(s, p, 200);
    expect(s).toMatchObject({ disabled: false, nextAt: 200 });
    expect(intervalOf(p, 1)).toBe(90);
  });

  it('an output configured at 0 Pal/h starts disabled', () => {
    const p = { ...prod(), intervalPerOutput: [Infinity, 90] };
    expect(createTakt(p, 0)).toMatchObject({ disabled: true, nextAt: null });
  });
});
