// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-units.ts — the unit kernel of signal bindings (plan-512).
 *
 * A unit is the FMI 2.0 `BaseUnit` model (FMI Spec 2.0.4 §2.2.2): a vector of SI
 * exponents plus `factor` and `offset`, `value_SI = factor · value + offset`.
 * `rad` is its own pseudo base exponent, exactly as in FMI, so an angle is never
 * compatible with a length. Two units convert by a pure factor when their
 * exponents are equal and neither carries an offset.
 *
 * What this module is for: deriving the ONE number a binding writes into its
 * scale field (`Drive_FollowPosition.Scale` = factor(m → mm) = 1000). It never
 * converts a signal value — the SignalStore, the transports and the behavior
 * formulas stay untouched (plan-512 decision log: "the conversion lives at the
 * binding").
 *
 * Not to be confused with `rv-drive-units.ts` (drive-internal mm/deg display
 * helpers) — that module is not involved here.
 */

import { MathUtils } from 'three';
import { MM_TO_METERS } from './rv-constants';
import { DriveDirection, isRotation } from './rv-coordinate-utils';

/** The FMI base exponents (`rad` is FMI's pseudo base unit for angles). */
export type UnitDimension = 'm' | 's' | 'rad' | 'kg' | 'K' | 'A' | 'mol' | 'cd';

const DIMENSIONS: readonly UnitDimension[] = ['m', 's', 'rad', 'kg', 'K', 'A', 'mol', 'cd'];

export interface UnitDef {
  /** SI exponents; missing = 0. */
  dims: Partial<Record<UnitDimension, number>>;
  /** value_SI = factor · value + offset */
  factor: number;
  offset: number;
}

export type UnitDefs = Readonly<Record<string, UnitDef>>;

const MM = 1 / MM_TO_METERS;
const DEG = MathUtils.DEG2RAD;
const RPM = (2 * Math.PI) / 60;

function def(dims: UnitDef['dims'], factor: number, offset = 0): UnitDef {
  return Object.freeze({ dims: Object.freeze(dims), factor, offset });
}

/**
 * The built-in table, in canonical spelling (`mm/s2`, `deg`, `1/min`).
 * {@link normalizeUnitName} maps the aliases onto these keys. Deliberately
 * limited to length, angle, speed, acceleration and time: equal exponents are
 * necessary, not sufficient, and the table stays inside the quantities where
 * they are (plan-512 §8).
 */
export const BUILTIN_UNITS: UnitDefs = Object.freeze({
  // length
  m: def({ m: 1 }, 1),
  mm: def({ m: 1 }, MM),
  cm: def({ m: 1 }, 0.01),
  km: def({ m: 1 }, 1000),
  in: def({ m: 1 }, 0.0254),
  // angle
  rad: def({ rad: 1 }, 1),
  deg: def({ rad: 1 }, DEG),
  // linear speed
  'm/s': def({ m: 1, s: -1 }, 1),
  'mm/s': def({ m: 1, s: -1 }, MM),
  'cm/s': def({ m: 1, s: -1 }, 0.01),
  'm/min': def({ m: 1, s: -1 }, 1 / 60),
  'mm/min': def({ m: 1, s: -1 }, MM / 60),
  // angular speed
  'rad/s': def({ rad: 1, s: -1 }, 1),
  'deg/s': def({ rad: 1, s: -1 }, DEG),
  '1/min': def({ rad: 1, s: -1 }, RPM),
  // acceleration
  'm/s2': def({ m: 1, s: -2 }, 1),
  'mm/s2': def({ m: 1, s: -2 }, MM),
  'rad/s2': def({ rad: 1, s: -2 }, 1),
  'deg/s2': def({ rad: 1, s: -2 }, DEG),
  // time
  s: def({ s: 1 }, 1),
  ms: def({ s: 1 }, 0.001),
  min: def({ s: 1 }, 60),
  h: def({ s: 1 }, 3600),
  // dimensionless
  '1': def({}, 1),
  // temperature — known so an offset conversion is REFUSED instead of reported unknown
  K: def({ K: 1 }, 1),
  degC: def({ K: 1 }, 1, 273.15),
});

/** Whole-name aliases, applied after the character normalisation. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  rpm: '1/min',
  '/min': '1/min',
  'U/min': '1/min',
  Cel: 'degC',
  sec: 's',
});

/**
 * Canonical spelling of a unit name: `mm/s²` → `mm/s2`, `m/s^2` → `m/s2`,
 * `°` → `deg`, `rpm` → `1/min`, `Cel` → `degC`. Unknown names are returned
 * trimmed but otherwise unchanged.
 */
export function normalizeUnitName(name: string): string {
  const n = name.trim()
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\^/g, '')
    .replace(/°/g, 'deg');
  return ALIASES[n] ?? n;
}

/**
 * The definition of a unit name: `extra` (e.g. a source's own definitions)
 * first, under the name as written and normalised, then the built-in table.
 */
export function parseUnit(name: string | undefined, extra?: UnitDefs): UnitDef | undefined {
  if (!name) return undefined;
  const norm = normalizeUnitName(name);
  return extra?.[name] ?? extra?.[norm] ?? BUILTIN_UNITS[norm];
}

export type UnitConversion =
  | { ok: true; factor: number }
  | { ok: false; reason: 'unknown-source' | 'unknown-target' | 'incompatible' | 'offset' };

function sameDims(a: UnitDef, b: UnitDef): boolean {
  for (const d of DIMENSIONS) {
    if ((a.dims[d] ?? 0) !== (b.dims[d] ?? 0)) return false;
  }
  return true;
}

/** Strip binary noise (`6.000000000000001` → `6`) without losing a real digit. */
function cleanFactor(f: number): number {
  return Number(f.toPrecision(15));
}

/**
 * The factor that turns a value in `from` into the same quantity in `to`
 * (`conversion('m', 'mm').factor === 1000`).
 *
 * `opts.fromDef` (the signal's own `SignalMeta.unitDef`) takes precedence over
 * the table for the source. `incompatible` = different exponents; `offset` =
 * both known but at least one carries an offset (K/degC), which a pure factor
 * cannot express — v1 refuses rather than computing a wrong value.
 */
export function conversion(
  from: string,
  to: string,
  opts?: { fromDef?: UnitDef; extra?: UnitDefs },
): UnitConversion {
  const src = opts?.fromDef ?? parseUnit(from, opts?.extra);
  if (!src) return { ok: false, reason: 'unknown-source' };
  const dst = parseUnit(to, opts?.extra);
  if (!dst) return { ok: false, reason: 'unknown-target' };
  if (!sameDims(src, dst)) return { ok: false, reason: 'incompatible' };
  if (src.offset !== 0 || dst.offset !== 0) {
    if (src.offset === dst.offset && src.factor === dst.factor) return { ok: true, factor: 1 };
    return { ok: false, reason: 'offset' };
  }
  if (!(dst.factor > 0) || !Number.isFinite(src.factor)) return { ok: false, reason: 'incompatible' };
  return { ok: true, factor: cleanFactor(src.factor / dst.factor) };
}

/** Quantity tokens a schema slot may declare as `signalUnit`. */
export const QUANTITY_TOKENS: Readonly<Record<string, { linear: string; rotary: string }>> = Object.freeze({
  '@drive-position': { linear: 'mm', rotary: 'deg' },
  '@drive-speed': { linear: 'mm/s', rotary: 'deg/s' },
  '@drive-acceleration': { linear: 'mm/s2', rotary: 'deg/s2' },
});

/**
 * The target unit of a slot. A literal (`'mm'`) is returned unchanged; a
 * quantity token resolves through the `Drive.Direction` of the carrying node
 * (`isRotation` — no second list of rotary directions). A token without a drive
 * context — or on a `Virtual` drive — yields undefined: no auto-scale, no
 * problem entry.
 */
export function resolveSignalUnit(
  signalUnit: string,
  ctx: { driveDirection?: DriveDirection | string },
): string | undefined {
  if (!signalUnit.startsWith('@')) return signalUnit;
  const token = QUANTITY_TOKENS[signalUnit];
  const dir = ctx.driveDirection as DriveDirection | undefined;
  if (!token || !dir || dir === DriveDirection.Virtual) return undefined;
  return isRotation(dir) ? token.rotary : token.linear;
}

/**
 * One FMI `BaseUnit` record as stored in `Fmu.FmuUnits` (`{ m: 1, s: -1,
 * factor, offset }`) → {@link UnitDef}. Non-numeric exponents are ignored;
 * returns undefined for a non-object.
 */
export function unitDefFromBaseUnit(raw: unknown): UnitDef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const dims: UnitDef['dims'] = {};
  for (const d of DIMENSIONS) {
    const v = r[d];
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) dims[d] = v;
  }
  const factor = typeof r.factor === 'number' && Number.isFinite(r.factor) && r.factor !== 0 ? r.factor : 1;
  const offset = typeof r.offset === 'number' && Number.isFinite(r.offset) ? r.offset : 0;
  return { dims, factor, offset };
}

/** The whole `Fmu.FmuUnits` map → {@link UnitDefs} (malformed entries dropped). */
export function unitDefsFromBaseUnits(raw: unknown): Record<string, UnitDef> {
  const out: Record<string, UnitDef> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const d = unitDefFromBaseUnit(value);
    if (name && d) out[name] = d;
  }
  return out;
}

/** Relative float equality for scale factors (1e-9), tolerant of `undefined`. */
export function approxEqualFactor(a: unknown, b: number): boolean {
  if (typeof a !== 'number' || !Number.isFinite(a)) return false;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Short display form of a factor (`1000`, `57.2958`, `0.001`). */
export function formatFactor(f: number): string {
  if (!Number.isFinite(f)) return String(f);
  return Number(f.toPrecision(6)).toString();
}
