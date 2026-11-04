// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { registerComponentSchema, registerParamApply } from '@rv/core/engine/rv-component-registry';
import { registerParamFieldResolver, registerParamRebuild, registerParamValidator, type FieldOp, type ParamFieldInfo, type ParamRebuildContext } from '@rv/core/params/rv-param-field';
import { registerComponentRebuild, type ComponentParamTarget } from '@rv/core/planning/rv-planning-component-params';
import { DEFAULT_SIZE, DEFAULT_VEHICLES, NO_AGV_DOWNTIME, SIZE_MAX, SIZE_MIN, defaultVehiclesFor, maxVehiclesFor, type AgvDowntime } from './yard-compose';
import type { YardPlanning } from './yard-planning';

/** rv_extras field name of the AGV-count parameter (plan-2015). */
export const VEHICLE_COUNT_FIELD = 'VehicleCount';
/** Highest AGV count any yard size can take — the schema bound of {@link VEHICLE_COUNT_FIELD}. */
export const VEHICLE_COUNT_MAX = maxVehiclesFor(SIZE_MAX);
/** rv_extras field: mean time between failures per AGV in seconds, 0 = no breakdowns. */
export const AGV_MTBF_FIELD = 'AgvMtbf';
/** rv_extras field: mean time to repair an AGV in seconds. */
export const AGV_MTTR_FIELD = 'AgvMttr';
/** rv_extras field: draw breakdown and repair times exponentially (seeded) instead of fixed. */
export const AGV_DOWNTIME_STOCHASTIC_FIELD = 'AgvDowntimeStochastic';
/** Every structural field of the component: a change of any of them rebuilds the yard. */
export const YARD_STRUCTURAL_FIELDS: readonly string[] = [VEHICLE_COUNT_FIELD, AGV_MTBF_FIELD, AGV_MTTR_FIELD, AGV_DOWNTIME_STOCHASTIC_FIELD];

let schemaRegistered = false;
/**
 * The `PalletYard` component schema (configuration on `PalletYardRoot`) — so
 * the Inspector shows `Size` as a READ-ONLY row (plan-681 §2.4): the size is the
 * result of the composition and changes through the planning window
 * (Planung ▸ Groesse), never as a free field. Pure data, no factory.
 *
 * `VehicleCount` (plan-2015) is the ONE exception and the ONE authored scalar of
 * this component: the number of AGVs. It is editable, it is the single stored
 * truth of the fleet size, and the derived `vehicles` list (`Stapler_1..n`), the
 * `Agv` placements and `battery.startSoc` all follow from it through
 * `composeYardWithVehicles`. Because the type declares `paramApply: 'rebuild'`
 * and registers the matching rebuild handler, the field carries variant and
 * experiment values and shows the variant icon in the Inspector.
 */
export function registerPalletYardSchema(): void {
  if (schemaRegistered) return;
  schemaRegistered = true;
  registerComponentSchema('PalletYard', {
    stations: { type: 'json' },
    waitPointPathId: { type: 'string' },
    vehicles: { type: 'json' },
    production: { type: 'json' },
    shippingPauses: { type: 'json' },
    vehicle: { type: 'json' },
    battery: { type: 'json' },
    Size: { type: 'number', default: DEFAULT_SIZE, readonly: true },
    [VEHICLE_COUNT_FIELD]: {
      type: 'number', default: DEFAULT_VEHICLES, min: 1, max: VEHICLE_COUNT_MAX, step: 1, label: 'AGVs',
    },
    // AGV breakdowns: one `Downtime` node per vehicle (`Downtime_Stapler_k`), composed
    // from these three fields and rebuilt with the fleet, so a variant with another AGV
    // count never aims a breakdown at a missing vehicle. MTBF 0 = no breakdowns.
    [AGV_MTBF_FIELD]: { type: 'number', default: NO_AGV_DOWNTIME.mtbf, min: 0, step: 60, unit: 's', label: 'AGV MTBF' },
    [AGV_MTTR_FIELD]: { type: 'number', default: NO_AGV_DOWNTIME.mttr, min: 1, step: 60, unit: 's', label: 'AGV MTTR' },
    [AGV_DOWNTIME_STOCHASTIC_FIELD]: { type: 'boolean', default: NO_AGV_DOWNTIME.stochastic, label: 'AGV downtime stochastic' },
  });
  // How a written value reaches the running model: the yard rebuilds its structure.
  registerParamApply('PalletYard', 'rebuild');
  // The Inspector needs a `number` descriptor (that is the editor with min/max/step),
  // the parameter admission needs `integer` — half an AGV must be refused BEFORE a
  // rebuild is started, not by the composition throwing inside it.
  registerParamFieldResolver('PalletYard', yardParamFieldInfo);
  registerParamValidator('PalletYard', validateYardComponent);
  registerParamRebuild('PalletYard', rebuildYardComponent);
  registerComponentRebuild('PalletYard', rebuildYardFromWrittenExtras);
}

/**
 * Field info the PARAMETER paths see (plan-2015): `VehicleCount` is an integer
 * parameter, everything else falls through to the registered schema.
 */
function yardParamFieldInfo(_component: string, field: string): ParamFieldInfo | null {
  if (field === VEHICLE_COUNT_FIELD) return { type: 'integer', default: DEFAULT_VEHICLES };
  if (field === AGV_MTBF_FIELD) return { type: 'number', unit: 's', default: NO_AGV_DOWNTIME.mtbf };
  if (field === AGV_MTTR_FIELD) return { type: 'number', unit: 's', default: NO_AGV_DOWNTIME.mttr };
  if (field === AGV_DOWNTIME_STOCHASTIC_FIELD) return { type: 'boolean', default: NO_AGV_DOWNTIME.stochastic };
  return null;
}

/**
 * Cross-field rule of the component (plan-2015): a whole number of AGVs, at
 * least one, and no more than the yard at ITS CURRENT SIZE has start positions
 * for — the schema bound is the bound of the largest yard, this is the bound of
 * the yard in front of the user. Refused at admission, so a bad value never
 * starts a rebuild.
 */
export function validateYardComponent(candidate: Readonly<Record<string, unknown>>): Record<string, string> {
  const errors: Record<string, string> = {};
  const mtbf = candidate[AGV_MTBF_FIELD];
  if (mtbf !== undefined && mtbf !== null && (typeof mtbf !== 'number' || !Number.isFinite(mtbf) || mtbf < 0)) {
    errors[AGV_MTBF_FIELD] = 'The AGV MTBF must be a number of seconds >= 0 (0 = no breakdowns)';
  }
  const mttr = candidate[AGV_MTTR_FIELD];
  if (mttr !== undefined && mttr !== null && (typeof mttr !== 'number' || !Number.isFinite(mttr) || mttr < 1)) {
    errors[AGV_MTTR_FIELD] = 'The AGV MTTR must be at least 1 second';
  }
  return { ...errors, ...validateVehicleCount(candidate) };
}

function validateVehicleCount(candidate: Readonly<Record<string, unknown>>): Record<string, string> {
  const raw = candidate[VEHICLE_COUNT_FIELD];
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { [VEHICLE_COUNT_FIELD]: 'The AGV count must be a whole number of at least 1' };
  }
  const size = typeof candidate.Size === 'number' ? candidate.Size : activePlugin?.yard.size ?? DEFAULT_SIZE;
  const max = size >= SIZE_MIN && size <= SIZE_MAX ? maxVehiclesFor(size) : VEHICLE_COUNT_MAX;
  if (raw > max) return { [VEHICLE_COUNT_FIELD]: `At most ${max} AGVs fit a yard of ${size} modules` };
  return {};
}

/**
 * `PalletYard.VehicleCount` of an rv_extras block, or null when the block does
 * not carry a usable one (absent, not a whole number, outside what `size` can
 * take) — then the size's own default applies. Never throws: a document is data.
 */
export function readVehicleCount(cfg: Readonly<Record<string, unknown>>, size: number): number | null {
  const raw = cfg[VEHICLE_COUNT_FIELD];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return null;
  const max = size >= SIZE_MIN && size <= SIZE_MAX ? maxVehiclesFor(size) : VEHICLE_COUNT_MAX;
  return raw > max ? null : raw;
}

/**
 * The AGV breakdown parameters of an rv_extras block: every field that is
 * absent or unusable falls back to its default (MTBF 0 = no breakdowns). Never
 * throws: a document is data.
 */
export function readAgvDowntime(cfg: Readonly<Record<string, unknown>>): AgvDowntime {
  const mtbf = cfg[AGV_MTBF_FIELD];
  const mttr = cfg[AGV_MTTR_FIELD];
  const stochastic = cfg[AGV_DOWNTIME_STOCHASTIC_FIELD];
  return {
    mtbf: typeof mtbf === 'number' && Number.isFinite(mtbf) && mtbf >= 0 ? mtbf : NO_AGV_DOWNTIME.mtbf,
    mttr: typeof mttr === 'number' && Number.isFinite(mttr) && mttr > 0 ? mttr : NO_AGV_DOWNTIME.mttr,
    stochastic: typeof stochastic === 'boolean' ? stochastic : NO_AGV_DOWNTIME.stochastic,
  };
}

/**
 * The plugin instance of the loaded document — the rebuild handlers are
 * registered per TYPE (module level) but the rebuild needs the session: the
 * learned asset templates, the scene root and the current composition. Set in
 * `init`, cleared in `dispose`.
 */
let activePlugin: YardPlanning | null = null;

/** The plugin serving the loaded yard, or null (tests, diagnostics). */
export function activeYardPlugin(): YardPlanning | null { return activePlugin; }

/**
 * `paramApply: 'rebuild'` of `PalletYard` (plan-2015): the AGV count of the ops
 * becomes the structure of the yard. Runs INSIDE the apply's transaction, at a
 * standstill — an `unset` goes back to the size's own default
 * ({@link defaultVehiclesFor}), which is what "the field is absent" means.
 */
async function rebuildYardComponent(ops: readonly FieldOp[], ctx: ParamRebuildContext): Promise<void> {
  const plugin = activePlugin;
  if (!plugin) throw new Error('palletYard: no loaded yard to rebuild');
  if (!ops.some((o) => YARD_STRUCTURAL_FIELDS.includes(o.field))) return;   // nothing structural
  const size = plugin.yard.size;
  // The apply rebuilds BEFORE it writes the fields: a field the ops do not name
  // keeps the value in effect (rv_extras), an `unset` goes back to its default
  // (for the AGV count: the size's own default).
  const cfg = plugin.yardExtras() ?? {};
  const effective = (field: string, unsetValue: unknown): unknown => {
    const op = ops.find((o) => o.field === field);
    if (!op) return cfg[field];
    return op.op === 'set' ? op.value : unsetValue;
  };
  const vehicles = effective(VEHICLE_COUNT_FIELD, defaultVehiclesFor(size)) ?? plugin.yard.counts.vehicles;
  if (typeof vehicles !== 'number') throw new Error(`palletYard: ${VEHICLE_COUNT_FIELD} needs a number`);
  const downtime = readAgvDowntime({
    [AGV_MTBF_FIELD]: effective(AGV_MTBF_FIELD, NO_AGV_DOWNTIME.mtbf),
    [AGV_MTTR_FIELD]: effective(AGV_MTTR_FIELD, NO_AGV_DOWNTIME.mttr),
    [AGV_DOWNTIME_STOCHASTIC_FIELD]: effective(AGV_DOWNTIME_STOCHASTIC_FIELD, NO_AGV_DOWNTIME.stochastic),
  });
  await plugin.rebuildYard(size, vehicles, ctx, downtime);
}

/**
 * `registerComponentRebuild` of `PalletYard` (plan-2015) — the planning window's
 * COMPONENT parameters take the other shape: the owner has already written the
 * value into rv_extras and asks the type to re-read it. Same rebuild, read from
 * the field instead of from the op.
 */
async function rebuildYardFromWrittenExtras(
  _targets: readonly ComponentParamTarget[],
  signal: AbortSignal,
): Promise<void> {
  const plugin = activePlugin;
  if (!plugin) throw new Error('palletYard: no loaded yard to rebuild');
  await plugin.rebuildFromStoredCount(plugin.rebuildContext(signal));
}

export function setActiveYardPlanning(planning: YardPlanning | null): void { activePlugin = planning; }
