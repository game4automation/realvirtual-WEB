// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletYard planning parameters (plan-630 §2.13 Phase 7, plan-681 §2.4 Phase 3) —
 * the model-specific DECLARATION the planning window renders, plus the pure
 * mapping of the committed values onto the runtime configuration.
 *
 * Nothing here touches a viewer: `palletYardParams(yard)` declares the rows for
 * the yard at its current size (instance keys `A1..An`, `V1..Vn` change with the
 * size — `redeclare` in the structural reset), `derivePalletYardConfig(yard, values)`
 * turns committed values into a {@link PalletYardConfig}. With every value at its
 * default the derived configuration equals `composeYard(n).config` (plus the
 * per-output interval, equal to the common one) — the DES parity (M3, 559)
 * rests on that.
 *
 * Effects (plan-630 Strukturinvariante: structure never changes in a running
 * simulation):
 *
 * | key                              | type / unit            | effect |
 * |----------------------------------|------------------------|--------|
 * | `size`                           | integer, modules 1..16 | reset — plan-681, the yard is rebuilt |
 * | `production.<A>.ratePerHour`     | number, Pal/h 0..120   | live — takt re-based, 0 = disabled |
 * | `station.<A>.active` / `<V>`     | boolean (chip row)     | reset — inactive station dropped from the configuration |
 * | `buffer.slotsPerModule`          | integer 0..3           | reset — the first k floor slots of every module |
 * | `vehicles`                       | integer 1..max of size | reset — plan-2015, AGVs placed / removed, the yard is rebuilt |
 * | `shipping.everySec` / `durationSec` | number, s           | live — pause plan re-planned from the instant |
 * | `battery.threshold` / `target`   | number, % 5..95        | live — read at the next decision |
 *
 * Deliberately NOT declared (plan-630 / 681 decision log): `vehicle.<S>.active`
 * (needs the engine field `Agv.Active`, plan-630 Phase 6, not built yet),
 * `retrieval` (plan-559 Phase 8 declares it), `battery.startSoc` (derived from the
 * vehicle count by the composition).
 *
 * `vehicles` (plan-2015) is NOT touched by that decision and is not a relaxation
 * of it: `vehicle.<S>.active` switches ONE existing AGV on and off at runtime and
 * therefore needs the engine field `Agv.Active`, while the COUNT is a composition
 * input of the same kind as `size` and `buffer.slotsPerModule` — the yard is
 * recomposed and rematerialised, so an AGV that is not in the fleet does not
 * exist as a node at all and nothing has to be deregistered.
 *
 * 559 Phase 8 takes this file over (plan-630 §2.13 "Uebergabe an 559") — it is
 * the model's declaration, not part of the generic fleet core's line budget.
 */

import type {
  PlanningKpiDef, PlanningParamDef, PlanningValue,
} from '@rv/core/planning/rv-planning-params';
import type { PalletYardConfig } from './layout';
import { DEFAULT_RATIOS, DEFAULT_SIZE, SIZE_MAX, SIZE_MIN, maxVehiclesFor, type YardComposition } from './yard-compose';

/** Planning owner of the yard (effective keys `palletYard.<key>`). */
export const PALLET_YARD_OWNER = 'palletYard';
/** Window title. */
export const PALLET_YARD_PLANNING_TITLE = 'Planning · PalletYard';
/** Floor slots per module the module geometry carries (`ModuleRatios.slots`). */
export const SLOTS_PER_MODULE = DEFAULT_RATIOS.slots;
/** Highest load of one output (Pal/h). */
export const RATE_MAX = 120;

/** Effective-key-free owner-local keys. */
export const SIZE_KEY = 'size';
export const rateKeyOf = (output: string): string => `production.${output}.ratePerHour`;
export const stationActiveKeyOf = (station: string): string => `station.${station}.active`;
export const SLOTS_KEY = 'buffer.slotsPerModule';
export const SHIP_EVERY_KEY = 'shipping.everySec';
export const SHIP_DURATION_KEY = 'shipping.durationSec';
export const BATTERY_THRESHOLD_KEY = 'battery.threshold';
export const BATTERY_TARGET_KEY = 'battery.target';
/** Number of AGVs of the fleet (plan-2015) — structural, like `size` and the buffer slots. */
export const VEHICLES_KEY = 'vehicles';

/** Station ids of a kind in their NUMBER order (`V1, V2, V3`) — the geometry lists them module-pair-wise. */
const idsOf = (yard: Pick<YardComposition, 'stations'>, kind: 'pick' | 'drop'): string[] =>
  yard.stations.filter((s) => s.kind === kind).map((s) => s.id).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const outputsOf = (yard: Pick<YardComposition, 'stations'>): string[] => idsOf(yard, 'pick');
const inputsOf = (yard: Pick<YardComposition, 'stations'>): string[] => idsOf(yard, 'drop');

/** The rows of the planning window for the yard at its current size. */
export function palletYardParams(yard: Pick<YardComposition, 'size' | 'stations' | 'config'>): PlanningParamDef[] {
  const cfg = yard.config;
  const defaultRate = Math.round(3600 / cfg.production.intervalSec);
  const out: PlanningParamDef[] = [
    {
      key: SIZE_KEY, label: 'Module', type: 'integer', unit: 'modules',
      min: SIZE_MIN, max: SIZE_MAX, step: 1, default: DEFAULT_SIZE,
      group: 'Size', apply: 'reset', order: 0,
      description: 'Size of the yard in modules (one output, one input, three floor slots, one charger each). '
        + 'Applying rebuilds the yard and restarts the simulation.',
    },
  ];
  let order = 0;
  for (const a of outputsOf(yard)) {
    out.push({
      key: rateKeyOf(a), label: a, type: 'number', unit: 'Pal/h', min: 0, max: RATE_MAX, step: 1,
      default: defaultRate, group: 'Production load', apply: 'live', order: order++,
      description: `Production load of output ${a}. 0 = the output produces nothing.`,
    });
  }
  order = 0;
  for (const a of outputsOf(yard)) {
    out.push({
      key: stationActiveKeyOf(a), label: a, type: 'boolean', default: true,
      group: 'Stations', apply: 'reset', order: order++, ui: { chipRow: 'Outputs' },
    });
  }
  for (const v of inputsOf(yard)) {
    out.push({
      key: stationActiveKeyOf(v), label: v, type: 'boolean', default: true,
      group: 'Stations', apply: 'reset', order: order++, ui: { chipRow: 'Inputs' },
    });
  }
  out.push({
    key: SLOTS_KEY, label: 'Buffer slots per module', type: 'integer', min: 0, max: SLOTS_PER_MODULE, step: 1,
    default: SLOTS_PER_MODULE, group: 'Stations', apply: 'reset', order: order++,
    description: 'Active floor slots per module — the first k of each module.',
  });
  out.push(
    {
      key: SHIP_EVERY_KEY, label: 'Pause every', type: 'number', unit: 's',
      default: cfg.shippingPauses.everySec, group: 'Shipping', apply: 'live', order: 0,
      description: 'A shipping input pauses every this many seconds.',
    },
    {
      key: SHIP_DURATION_KEY, label: 'Duration', type: 'number', unit: 's',
      default: cfg.shippingPauses.durationSec, group: 'Shipping', apply: 'live', order: 1,
      description: 'Length of a shipping pause (0 = no pauses).',
    },
    {
      key: VEHICLES_KEY, label: 'Vehicles', type: 'integer', unit: 'AGV',
      min: 1, max: maxVehiclesFor(yard.size), step: 1,
      default: cfg.vehicles.length, group: 'Fleet', apply: 'reset', order: 0,
      description: 'Number of AGVs in the fleet. Applying rebuilds the yard: AGVs are placed or '
        + 'removed and the simulation restarts. The upper bound is the number of start positions '
        + 'the loop of this yard size has.',
    },
    {
      key: BATTERY_THRESHOLD_KEY, label: 'Charge threshold', type: 'number', unit: '%', min: 5, max: 95, step: 1,
      default: cfg.battery.threshold, group: 'Fleet', apply: 'live', order: 1,
    },
    {
      key: BATTERY_TARGET_KEY, label: 'Charge target', type: 'number', unit: '%', min: 5, max: 95, step: 1,
      default: cfg.battery.target, group: 'Fleet', apply: 'live', order: 2,
    },
  );
  return out;
}

/**
 * Cross rules (plan-630 F4): at least one active output and one active input,
 * a sane pause plan, charging threshold below the target. Instance keys absent
 * from `values` (another size) count as active.
 */
export function validatePalletYard(values: Readonly<Record<string, PlanningValue>>): Record<string, string> {
  const errors: Record<string, string> = {};
  const size = typeof values[SIZE_KEY] === 'number' ? values[SIZE_KEY] as number : DEFAULT_SIZE;
  const activeOf = (prefix: 'A' | 'V'): string[] => {
    const ids: string[] = [];
    for (let i = 1; i <= size; i++) ids.push(`${prefix}${i}`);
    return ids.filter((id) => values[stationActiveKeyOf(id)] !== false);
  };
  if (activeOf('A').length === 0) errors[stationActiveKeyOf('A1')] = 'At least one output must stay active';
  if (activeOf('V').length === 0) errors[stationActiveKeyOf('V1')] = 'At least one input must stay active';
  const every = values[SHIP_EVERY_KEY];
  const dur = values[SHIP_DURATION_KEY];
  if (typeof every === 'number' && every <= 0) errors[SHIP_EVERY_KEY] = 'Must be greater than 0 s';
  if (typeof dur === 'number' && dur < 0) errors[SHIP_DURATION_KEY] = 'Must not be negative';
  if (typeof every === 'number' && typeof dur === 'number' && dur >= every) {
    errors[SHIP_DURATION_KEY] = 'A pause must be shorter than its cycle';
  }
  const th = values[BATTERY_THRESHOLD_KEY];
  const tg = values[BATTERY_TARGET_KEY];
  if (typeof th === 'number' && typeof tg === 'number' && th >= tg) {
    errors[BATTERY_THRESHOLD_KEY] = 'The charging threshold must be below the target';
  }
  // plan-2015: the fleet is bounded by the start positions of THIS size — the
  // declared max follows the size through `redeclare`, this catches a value that
  // was committed at a larger size and no longer fits.
  const vehicles = values[VEHICLES_KEY];
  if (typeof vehicles === 'number' && size >= SIZE_MIN && size <= SIZE_MAX) {
    const max = maxVehiclesFor(size);
    if (!Number.isInteger(vehicles) || vehicles < 1) errors[VEHICLES_KEY] = 'At least one AGV is needed';
    else if (vehicles > max) errors[VEHICLES_KEY] = `At most ${max} AGVs fit a yard of ${size} modules`;
  }
  return errors;
}

/** Interval (s) of a load in Pal/h; 0 → `Infinity` (disabled). */
export function intervalOfRate(rate: number): number {
  return rate > 0 ? 3600 / rate : Infinity;
}

/**
 * The runtime configuration of the yard at the committed values: a deep copy of
 * `yard.config` with the stations that are switched off (and the floor slots
 * beyond `buffer.slotsPerModule` of each module) dropped, phases / pause
 * offsets / start SOC kept per station, per-output intervals from the loads,
 * the pause plan and the battery thresholds. A copy the runtime may mutate for
 * live changes — never the composition itself.
 */
export function derivePalletYardConfig(
  yard: Pick<YardComposition, 'config'>,
  values: Readonly<Record<string, PlanningValue>> = {},
): PalletYardConfig {
  const base = yard.config;
  const cfg: PalletYardConfig = structuredClone(base) as PalletYardConfig;
  const num = (key: string, fallback: number): number => (typeof values[key] === 'number' ? values[key] as number : fallback);
  const picks = base.stations.filter((s) => s.kind === 'pick');
  const drops = base.stations.filter((s) => s.kind === 'drop');
  const buffers = base.stations.filter((s) => s.kind === 'buffer');
  const slotsPerModule = Math.max(0, Math.min(SLOTS_PER_MODULE, Math.round(num(SLOTS_KEY, SLOTS_PER_MODULE))));
  const activeBuffer = new Set(buffers.filter((s) => {
    const n = Number(s.id.slice(1));                      // P<k>, 1-based, module-major
    return ((n - 1) % SLOTS_PER_MODULE) < slotsPerModule;
  }).map((s) => s.id));
  const isActive = (id: string): boolean => values[stationActiveKeyOf(id)] !== false;
  cfg.stations = cfg.stations.filter((s) => {
    if (s.kind === 'pick' || s.kind === 'drop') return isActive(s.id);
    if (s.kind === 'buffer') return activeBuffer.has(s.id);
    return true;
  });
  // Per-station values stay with their station when others are switched off.
  const keptPicks = picks.map((s, i) => ({ s, i })).filter(({ s }) => isActive(s.id));
  const keptDrops = drops.map((s, i) => ({ s, i })).filter(({ s }) => isActive(s.id));
  const defaultRate = 3600 / base.production.intervalSec;
  cfg.production.phaseSec = keptPicks.map(({ i }) => base.production.phaseSec[i] ?? 0);
  cfg.production.intervalPerOutput = keptPicks.map(({ s }) => intervalOfRate(num(rateKeyOf(s.id), defaultRate)));
  cfg.shippingPauses.offsetSec = keptDrops.map(({ i }) => base.shippingPauses.offsetSec[i] ?? 0);
  cfg.shippingPauses.everySec = num(SHIP_EVERY_KEY, base.shippingPauses.everySec);
  cfg.shippingPauses.durationSec = num(SHIP_DURATION_KEY, base.shippingPauses.durationSec);
  cfg.battery.threshold = num(BATTERY_THRESHOLD_KEY, base.battery.threshold);
  cfg.battery.target = num(BATTERY_TARGET_KEY, base.battery.target);
  return cfg;
}

/** What the key figures read from the bound runtime (kept small for tests). */
export interface KpiSource {
  /** Counters of the current run, or null while unbound. */
  counters(): { delivered: number; bufferPeak: number; blockedTakts: number } | null;
  /** Simulation seconds of the current run. */
  simSeconds(): number;
  /** Mean creation-to-completion time of this run, or null before its first completion. */
  meanOrderSec?(): number | null;
}

/** Sim key figures of the yard (plan-630 §2.12, `kind: 'sim'` — deterministic). */
export function palletYardKpis(src: KpiSource): PlanningKpiDef[] {
  return [
    {
      key: 'kpi.shippedPerHour', label: 'Shipped', unit: 'Pal/h', kind: 'sim', decimals: 1,
      read: () => {
        const c = src.counters();
        const t = src.simSeconds();
        return c && t > 0 ? c.delivered / (t / 3600) : null;
      },
    },
    { key: 'kpi.bufferPeak', label: 'Buffer peak', unit: 'Pal', kind: 'sim', read: () => src.counters()?.bufferPeak ?? null },
    { key: 'kpi.blockedTakts', label: 'Blocked takts', kind: 'sim', read: () => src.counters()?.blockedTakts ?? null },
    { key: 'kpi.meanOrderSec', label: 'Mean order time', unit: 's', kind: 'sim', decimals: 1,
      read: () => src.meanOrderSec?.() ?? null },
  ];
}
