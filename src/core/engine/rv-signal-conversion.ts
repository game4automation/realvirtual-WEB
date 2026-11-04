// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-conversion — the ONE value-conversion kernel of the SignalConnector
 * (plan-2227). Pure functions, no Three.js, no store, no allocation on the hot
 * path. The C# twins (`SignalConversion.cs` in Unity and CONNECT) follow this
 * file and the canonical vectors in `tests/fixtures/signal-conversion-vectors.json`.
 *
 * ## Number model (binding for every runtime)
 *
 * - Every INT signal value is stored as **signed 32 bit** (Unity `int`, CONNECT
 *   `SignalValues`). A DWORD with bit 31 set is negative (`0x80000000` =
 *   −2147483648). Bit arithmetic uses `| 0`, never `>>> 0`.
 * - `Width` + `Signed` only decide how an INT is INTERPRETED when it is read
 *   (`Byte` = value & 0xFF, signed → −128..127) and the clamp range when an INT
 *   is written by `Scale`.
 * - A REAL target has float32 semantics everywhere (`Math.fround`); a result
 *   that is not finite AFTER that conversion is not written (`undefined`).
 * - `Round` = half away from zero, `Truncate` = towards zero.
 */

export type SignalConnectorMode = 'Copy' | 'IntToBool' | 'BoolToInt' | 'BitFromWord' | 'BitToWord' | 'Scale';
export type IntCondition = 'NotZero' | 'Equals' | 'GreaterOrEqual';
export type WordWidth = 'Byte' | 'Word' | 'DWord';
export type RoundingMode = 'Round' | 'Truncate';
import { asBool, toInt32, type ValueKind } from './rv-signal-convert-core';

// The eager part (ConnectSignal) lives in rv-signal-convert-core; one definition each.
export { asBool, connectSignalConvert, kindOfPlcType, toInt32, type ValueKind } from './rv-signal-convert-core';

export const SIGNAL_CONNECTOR_MODES: readonly SignalConnectorMode[] =
  Object.freeze(['Copy', 'IntToBool', 'BoolToInt', 'BitFromWord', 'BitToWord', 'Scale']);

/** All conversion options of one connector — the scalar fields of the component. */
export interface ConversionOptions {
  Mode: SignalConnectorMode;
  Condition: IntCondition;
  CompareValue: number;
  TrueValue: number;
  FalseValue: number;
  Bit: number;
  Width: WordWidth;
  Signed: boolean;
  Factor: number;
  Offset: number;
  Rounding: RoundingMode;
  Invert: boolean;
}

/** Schema defaults (rv-odt.json `SignalConnector`). */
export const DEFAULT_CONVERSION_OPTIONS: Readonly<ConversionOptions> = Object.freeze({
  Mode: 'Copy',
  Condition: 'NotZero',
  CompareValue: 0,
  TrueValue: 1,
  FalseValue: 0,
  Bit: 0,
  Width: 'Word',
  Signed: true,
  Factor: 1,
  Offset: 0,
  Rounding: 'Round',
  Invert: false,
});

// ─── Number model ──────────────────────────────────────────────────────

/** Bit count of a width: 8, 16 or 32. */
export function widthBits(width: WordWidth): number {
  return width === 'Byte' ? 8 : width === 'DWord' ? 32 : 16;
}

/**
 * Interpret an int32-stored value at `width`: the low `widthBits` bits, sign
 * extended when `signed`. `DWord` signed is the identity; `DWord` unsigned
 * yields 0..4294967295.
 */
export function interpretWord(int32: number, width: WordWidth, signed: boolean): number {
  const v = int32 | 0;
  switch (width) {
    case 'Byte': return signed ? (v << 24) >> 24 : v & 0xff;
    case 'Word': return signed ? (v << 16) >> 16 : v & 0xffff;
    default: return signed ? v : v >>> 0; // interpretation only — storage stays signed
  }
}

/** Inclusive value range of an INT at `width` / `signed`. */
export function widthRange(width: WordWidth, signed: boolean): { min: number; max: number } {
  const bits = widthBits(width);
  if (signed) return { min: -(2 ** (bits - 1)), max: 2 ** (bits - 1) - 1 };
  return { min: 0, max: 2 ** bits - 1 };
}

/** Clamp an integral number into the `width`/`signed` range and store it as int32. */
export function clampToWidth(x: number, width: WordWidth, signed: boolean): number {
  const bits = widthBits(width);
  const min = signed ? -(2 ** (bits - 1)) : 0;
  const max = signed ? 2 ** (bits - 1) - 1 : 2 ** bits - 1;
  const c = x < min ? min : x > max ? max : x;
  return c | 0; // 0..4294967295 wraps to the signed storage; -0 → 0
}

/** `Round` = half away from zero, `Truncate` = towards zero. */
export function roundValue(x: number, rounding: RoundingMode): number {
  return rounding === 'Truncate' ? Math.trunc(x) : Math.sign(x) * Math.round(Math.abs(x));
}

/** True when `bit` is an integer inside the width (0 ≤ bit < widthBits). */
export function bitFitsWidth(bit: number, width: WordWidth): boolean {
  return Number.isInteger(bit) && bit >= 0 && bit < widthBits(width);
}

// ─── Slots ─────────────────────────────────────────────────────────────

export type SourceSlot = 'SourceBool' | 'SourceInt' | 'SourceFloat';
export type TargetSlot = 'TargetBool' | 'TargetInt' | 'TargetFloat';
export type ConnectorSlot = SourceSlot | TargetSlot;

export const SOURCE_SLOTS: readonly SourceSlot[] = Object.freeze(['SourceBool', 'SourceInt', 'SourceFloat']);
export const TARGET_SLOTS: readonly TargetSlot[] = Object.freeze(['TargetBool', 'TargetInt', 'TargetFloat']);
export const CONNECTOR_SLOTS: readonly ConnectorSlot[] = Object.freeze([...SOURCE_SLOTS, ...TARGET_SLOTS]);

/** The value kind a slot carries. */
export function slotKind(slot: ConnectorSlot): ValueKind {
  return slot.endsWith('Bool') ? 'bool' : slot.endsWith('Int') ? 'int' : 'real';
}

/** The (source, target) slot pairs a mode accepts, in preference order. */
export const MODE_SLOT_PAIRS: Readonly<Record<SignalConnectorMode, readonly (readonly [SourceSlot, TargetSlot])[]>> = Object.freeze({
  Copy: [['SourceBool', 'TargetBool'], ['SourceInt', 'TargetInt'], ['SourceFloat', 'TargetFloat'], ['SourceInt', 'TargetFloat']],
  IntToBool: [['SourceInt', 'TargetBool']],
  BoolToInt: [['SourceBool', 'TargetInt']],
  BitFromWord: [['SourceInt', 'TargetBool']],
  BitToWord: [['SourceBool', 'TargetInt']],
  Scale: [['SourceInt', 'TargetInt'], ['SourceInt', 'TargetFloat'], ['SourceFloat', 'TargetInt'], ['SourceFloat', 'TargetFloat']],
});

/** Result of {@link selectSlots}. */
export interface SlotSelection {
  /** The active source slot, or null when the mode has no candidate set. */
  source: SourceSlot | null;
  /** The active target slot, or null when the mode has no candidate set. */
  target: TargetSlot | null;
  /** Slots that are SET but not active in this mode (→ `signal-connector-slot-mismatch`). */
  inactiveSet: ConnectorSlot[];
}

/**
 * Pick the active (source, target) pair of a mode from the slots that are set.
 *
 * The first pair whose both slots are set wins. Otherwise the slots the mode can
 * use that ARE set are kept as the half-filled active pair (so the unresolved
 * report names the missing side). Every other set slot is inactive.
 */
export function selectSlots(mode: SignalConnectorMode, isSet: (slot: ConnectorSlot) => boolean): SlotSelection {
  const pairs = MODE_SLOT_PAIRS[mode] ?? MODE_SLOT_PAIRS.Copy;
  let source: SourceSlot | null = null;
  let target: TargetSlot | null = null;
  for (const [s, t] of pairs) {
    if (isSet(s) && isSet(t)) { source = s; target = t; break; }
  }
  if (source === null) {
    for (const [s] of pairs) if (isSet(s)) { source = s; break; }
    for (const [, t] of pairs) if (isSet(t)) { target = t; break; }
    // A half pair must still be a pair this mode accepts.
    if (source !== null && target !== null && !pairs.some(([s, t]) => s === source && t === target)) target = null;
    if (source === null && target === null) { source = pairs[0][0]; target = pairs[0][1]; }
    else if (source === null) source = pairs.find(([, t]) => t === target)?.[0] ?? pairs[0][0];
    else if (target === null) target = pairs.find(([s]) => s === source)?.[1] ?? pairs[0][1];
  }
  const inactiveSet: ConnectorSlot[] = [];
  for (const slot of CONNECTOR_SLOTS) {
    if (slot !== source && slot !== target && isSet(slot)) inactiveSet.push(slot);
  }
  return { source, target, inactiveSet };
}

// ─── Conversion ────────────────────────────────────────────────────────

/**
 * Convert one source value for a target, or `undefined` = write nothing (result
 * not finite after the target conversion, an unsupported kind pair, or a `Bit`
 * outside the width).
 *
 * `BitToWord` returns the BOOL this connector contributes to its word (after
 * `Invert`); the word itself is built by {@link wordFromMask}.
 */
export function convertValue(
  value: boolean | number,
  sourceKind: ValueKind,
  targetKind: ValueKind,
  o: ConversionOptions,
): boolean | number | undefined {
  switch (o.Mode) {
    case 'Copy': {
      if (sourceKind === 'bool' && targetKind === 'bool') return asBool(value) !== o.Invert;
      if (sourceKind === 'int' && targetKind === 'int') return toInt32(value);
      if (targetKind === 'real' && (sourceKind === 'int' || sourceKind === 'real')) {
        const r = Math.fround(sourceKind === 'int' ? toInt32(value) : asNumber(value));
        return Number.isFinite(r) ? r : undefined;
      }
      return undefined;
    }
    case 'IntToBool': {
      if (sourceKind !== 'int' || targetKind !== 'bool') return undefined;
      const v = toInt32(value);
      const c = o.CompareValue | 0;
      const hit = o.Condition === 'Equals' ? v === c : o.Condition === 'GreaterOrEqual' ? v >= c : v !== 0;
      return hit !== o.Invert;
    }
    case 'BoolToInt':
      if (sourceKind !== 'bool' || targetKind !== 'int') return undefined;
      return asBool(value) ? o.TrueValue | 0 : o.FalseValue | 0;
    case 'BitFromWord': {
      if (sourceKind !== 'int' || targetKind !== 'bool' || !bitFitsWidth(o.Bit, o.Width)) return undefined;
      return (((toInt32(value) >> o.Bit) & 1) === 1) !== o.Invert;
    }
    case 'BitToWord':
      if (sourceKind !== 'bool' || targetKind !== 'int' || !bitFitsWidth(o.Bit, o.Width)) return undefined;
      return asBool(value) !== o.Invert;
    case 'Scale': {
      if (sourceKind === 'bool' || targetKind === 'bool') return undefined;
      const x0 = sourceKind === 'int' ? interpretWord(toInt32(value), o.Width, o.Signed) : asNumber(value);
      const x = x0 * o.Factor + o.Offset;
      if (targetKind === 'real') {
        const r = Math.fround(x);
        return Number.isFinite(r) ? r : undefined;
      }
      if (!Number.isFinite(x)) return undefined;
      return clampToWidth(roundValue(x, o.Rounding), o.Width, o.Signed);
    }
    default:
      return undefined;
  }
}

/**
 * The INT a word aggregator writes for a bit mask: bits not set by any
 * `BitToWord` connector are 0, the pattern is interpreted at `width`/`signed`
 * (so `Word` signed with bit 15 is −32768, `DWord` bit 31 always −2147483648).
 */
export function wordFromMask(mask: number, width: WordWidth, signed: boolean): number {
  return interpretWord(mask | 0, width, signed) | 0;
}

/** Set or clear one bit in a mask (int32). */
export function setMaskBit(mask: number, bit: number, on: boolean): number {
  return on ? (mask | (1 << bit)) | 0 : (mask & ~(1 << bit)) | 0;
}

/**
 * The word of a list of bit states — the reference form of the aggregator for
 * the vectors. Bits outside the width are ignored.
 */
export function wordFromBits(bits: readonly { bit: number; on: boolean }[], width: WordWidth, signed: boolean): number {
  let mask = 0;
  for (const b of bits) if (b.on && bitFitsWidth(b.bit, width)) mask = setMaskBit(mask, b.bit, true);
  return wordFromMask(mask, width, signed);
}

function asNumber(value: boolean | number): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}
