// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-connector-ops — pure authoring rules of the `SignalConnector`
 * (plan-2227 Phase 2), shared by the inspector section, the editor commands
 * `signalConnector.setMode` / `signalConnector.createBits` and the read
 * command `signalConnector.list`. No DOM, no document, no store.
 *
 * - which fields a Mode uses (the inspector shows only those);
 * - which slots a Mode change clears (one rule for UI, MCP and the
 *   `editor.setField('Mode')` redirect);
 * - the bit list and child names of *Create bit connectors…*.
 */

import {
  CONNECTOR_SLOTS,
  MODE_SLOT_PAIRS,
  SIGNAL_CONNECTOR_MODES,
  selectSlots,
  widthBits,
  type ConnectorSlot,
  type SignalConnectorMode,
  type WordWidth,
} from './rv-signal-conversion';

/** Component type key of the connector (rv_extras block name, registry type). */
export const SIGNAL_CONNECTOR_TYPE = 'SignalConnector';

/** Scalar option fields of each Mode (besides `Mode` and `Enabled`, which every Mode shows). */
export const MODE_OPTION_FIELDS: Readonly<Record<SignalConnectorMode, readonly string[]>> = Object.freeze({
  Copy: ['Invert'],
  IntToBool: ['Condition', 'CompareValue', 'Invert'],
  BoolToInt: ['TrueValue', 'FalseValue'],
  BitFromWord: ['Bit', 'Width', 'Invert'],
  BitToWord: ['Bit', 'Width', 'Signed', 'Invert'],
  Scale: ['Factor', 'Offset', 'Rounding', 'Signed', 'Width'],
});

/** Every scalar option field of the component (union of {@link MODE_OPTION_FIELDS}). */
export const SIGNAL_CONNECTOR_OPTION_FIELDS: readonly string[] = Object.freeze([
  'Condition', 'CompareValue', 'TrueValue', 'FalseValue', 'Bit', 'Width', 'Signed', 'Factor', 'Offset', 'Rounding', 'Invert',
]);

/** True for a known Mode name. */
export function isSignalConnectorMode(v: unknown): v is SignalConnectorMode {
  return typeof v === 'string' && (SIGNAL_CONNECTOR_MODES as readonly string[]).includes(v);
}

/** The Mode a component block stands for (unknown / missing → the schema default `Copy`). */
export function modeOf(data: Readonly<Record<string, unknown>> | null | undefined): SignalConnectorMode {
  const m = data?.Mode;
  return isSignalConnectorMode(m) ? m : 'Copy';
}

/** Every slot some (source, target) pair of `mode` uses. */
export function slotsUsableIn(mode: SignalConnectorMode): ReadonlySet<ConnectorSlot> {
  const out = new Set<ConnectorSlot>();
  for (const [s, t] of MODE_SLOT_PAIRS[mode]) { out.add(s); out.add(t); }
  return out;
}

/**
 * Whether an AUTHORED slot value names a target: a non-empty string, or a
 * reference object with an address, a path or an unresolved path. Same reading
 * as the runtime (`RVSignalConnector._slotSet` on the raw extras).
 */
export function isSlotAuthored(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  if (typeof raw === 'string') return true;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    return Boolean(r.address || r.path || r.unresolvedPath);
  }
  return false;
}

/**
 * Slots a switch to `mode` clears: every authored slot that is not part of the
 * pair the new Mode would pick from the authored slots (the runtime's own
 * selection, `selectSlots`). After the switch no set slot is inactive, so the
 * `signal-connector-slot-mismatch` warning can only come from a foreign file.
 */
export function slotsClearedBySetMode(mode: SignalConnectorMode, data: Readonly<Record<string, unknown>>): ConnectorSlot[] {
  return selectSlots(mode, (slot) => isSlotAuthored(data[slot])).inactiveSet;
}

/**
 * Whether the inspector shows `field` of a connector block: `Mode` and `Enabled`
 * always; a slot when the Mode can use it OR it is set (a stray slot from a
 * foreign file stays visible, so it can be cleared); an option when the Mode
 * uses it (`CompareValue` only for a comparing `Condition`). Unknown fields pass.
 */
export function isSignalConnectorFieldVisible(data: Readonly<Record<string, unknown>>, field: string): boolean {
  if (field === 'Mode' || field === 'Enabled') return true;
  const mode = modeOf(data);
  if ((CONNECTOR_SLOTS as readonly string[]).includes(field)) {
    return slotsUsableIn(mode).has(field as ConnectorSlot) || isSlotAuthored(data[field]);
  }
  if (!SIGNAL_CONNECTOR_OPTION_FIELDS.includes(field)) return true;
  if (!MODE_OPTION_FIELDS[mode].includes(field)) return false;
  if (field === 'CompareValue') return data.Condition === 'Equals' || data.Condition === 'GreaterOrEqual';
  return true;
}

// ─── Create bit connectors ─────────────────────────────────────────────

/** The two Modes *Create bit connectors…* creates. */
export type BitConnectorMode = Extract<SignalConnectorMode, 'BitFromWord' | 'BitToWord'>;

/** True for `BitFromWord` / `BitToWord`. */
export function isBitMode(v: unknown): v is BitConnectorMode {
  return v === 'BitFromWord' || v === 'BitToWord';
}

/** True for a known word width. */
export function isWordWidth(v: unknown): v is WordWidth {
  return v === 'Byte' || v === 'Word' || v === 'DWord';
}

/** Child node name of the connector for `bit`: `Bit00` … `Bit31` (R9). */
export function bitChildName(bit: number): string {
  return `Bit${String(bit).padStart(2, '0')}`;
}

/**
 * Parse a bit list: an array of numbers, or text like `"0-7"`, `"0,2,5"`,
 * `"0-3, 8-11"`. Returns the bits in the given order, or an error text.
 * Every bit must be an integer below the width; no bit may repeat.
 */
export function parseBitList(spec: unknown, width: WordWidth): { bits: number[] } | { error: string } {
  const max = widthBits(width);
  const out: number[] = [];
  const push = (n: number): string | null => {
    if (!Number.isInteger(n) || n < 0 || n >= max) return `bit ${n} is outside a ${width} (valid 0..${max - 1})`;
    if (out.includes(n)) return `bit ${n} is listed twice`;
    out.push(n);
    return null;
  };
  if (Array.isArray(spec)) {
    for (const v of spec) {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      const err = push(n);
      if (err) return { error: err };
    }
  } else if (typeof spec === 'string' && spec.trim()) {
    for (const part of spec.split(',')) {
      const p = part.trim();
      if (!p) continue;
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(p);
      if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (b < a) return { error: `range "${p}" runs backwards` };
        for (let n = a; n <= b; n++) {
          const err = push(n);
          if (err) return { error: err };
        }
        continue;
      }
      if (!/^\d+$/.test(p)) return { error: `"${p}" is not a bit number or a range` };
      const err = push(Number(p));
      if (err) return { error: err };
    }
  }
  if (out.length === 0) return { error: 'no bits given' };
  return { bits: out };
}

/** The BOOL slot and the INT slot of a bit Mode. */
export function bitModeSlots(mode: BitConnectorMode): { word: ConnectorSlot; bool: ConnectorSlot } {
  return mode === 'BitFromWord'
    ? { word: 'SourceInt', bool: 'TargetBool' }
    : { word: 'TargetInt', bool: 'SourceBool' };
}

/** An INT shown as the bits of its width, grouped by 4 (`0000 0000 0010 0101`) — display only. */
export function formatBinary(value: number, width: WordWidth): string {
  const n = widthBits(width);
  const bits = ((value | 0) >>> 0).toString(2).padStart(32, '0').slice(32 - n);
  return bits.replace(/(.{4})(?=.)/g, '$1 ');
}
