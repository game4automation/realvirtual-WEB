// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-2227: the EAGER part of the conversion kernel — what ConnectSignal needs.
// rv-signal-conversion.ts (on demand) re-exports these; one definition each.

/** BOOL, INT (int32) or REAL (float32). */
export type ValueKind = 'bool' | 'int' | 'real';

/** Signed int32 storage: bool → 1/0, number → `| 0` (non-finite → 0). */
export function toInt32(value: boolean | number): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value | 0;
}

export function asBool(value: boolean | number): boolean {
  return typeof value === 'boolean' ? value : value !== 0;
}

/** Unity `ConnectSignal` rule: INT → BOOL is `> 0`, BOOL → INT is 1/0, else raw. */
export function connectSignalConvert(
  value: boolean | number,
  sourceKind: ValueKind | undefined,
  targetKind: ValueKind | undefined,
): boolean | number {
  if (sourceKind === 'int' && targetKind === 'bool') return toInt32(value) > 0;
  if (sourceKind === 'bool' && targetKind === 'int') return asBool(value) ? 1 : 0;
  return value;
}

/** `PLCOutputInt` → `'int'` etc., or undefined. */
export function kindOfPlcType(plcType: string | undefined): ValueKind | undefined {
  if (!plcType) return undefined;
  if (plcType.endsWith('Bool')) return 'bool';
  if (plcType.endsWith('Int')) return 'int';
  if (plcType.endsWith('Float')) return 'real';
  return undefined;
}
