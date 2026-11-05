// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-mapping-options — the conversion options of a CONNECT 1:1 signal mapping in the bridge dialog
 * (plan-2227 Phase 5). The gateway converts with the SignalConnector kernel, so the choices and defaults
 * are those of the model component (`rv-signal-conversion.ts`): a mode, and only the options that mode reads.
 * "1:1 (coercion)" keeps the legacy mapping without a mode.
 */

import { useEffect, useState } from 'react';
import { Checkbox, MenuItem, TextField } from '@mui/material';
import { InspectorRow } from './rv-inspector-row';
import { inspectorInputSx } from './shared-sx';
import { parseDecimal } from './rv-number-format';
import type { ConnectSignalMapping } from './connect-store';
import type { IntCondition, RoundingMode, SignalConnectorMode, WordWidth } from '../engine/rv-signal-conversion';

/**
 * The conversion part of a CONNECT mapping (plan-2227): with `mode` the gateway converts through the
 * SignalConnector kernel and `coercion` does not apply; an absent option takes its default.
 */
export interface MappingConversion {
  mode?: SignalConnectorMode;
  condition?: IntCondition;
  compareValue?: number;
  trueValue?: number;
  falseValue?: number;
  /** 0 .. width-1; BitToWord mappings onto one destination build that word together. */
  bit?: number;
  width?: WordWidth;
  signed?: boolean;
  factor?: number;
  offset?: number;
  rounding?: RoundingMode;
  invert?: boolean;
}

/** Option keys each mode reads; the bridge dialog writes only these. */
export const MAPPING_MODE_OPTIONS: Readonly<Record<SignalConnectorMode, readonly (keyof ConnectSignalMapping)[]>> = {
  Copy: ['invert'],
  IntToBool: ['condition', 'compareValue', 'invert'],
  BoolToInt: ['trueValue', 'falseValue'],
  BitFromWord: ['bit', 'width', 'invert'],
  BitToWord: ['bit', 'width', 'signed', 'invert'],
  Scale: ['factor', 'offset', 'rounding', 'width', 'signed'],
};

/** Short label of a mapping's conversion for the bridge list: `1:1`, `1:1 coerce`, `BitToWord bit 3`, `Scale`. */
export function mappingConversionLabel(m: ConnectSignalMapping): string {
  if (!m.mode) return m.coercion === 'Coerce' ? '1:1 coerce' : '1:1';
  if (m.mode === 'BitFromWord' || m.mode === 'BitToWord') return `${m.mode} bit ${m.bit ?? 0}`;
  return m.mode;
}

/** Mode choices; '' = legacy 1:1 with coercion. */
const MODES: readonly { value: SignalConnectorMode | ''; label: string; title: string }[] = [
  { value: '', label: '1:1 (coercion)', title: 'Copy the value; Strict needs equal types, Coerce allows bool↔int and int→float' },
  { value: 'Copy', label: 'Copy', title: 'BOOL→BOOL, INT→INT, REAL→REAL, INT→REAL' },
  { value: 'IntToBool', label: 'INT → BOOL', title: 'TRUE when the INT meets the condition' },
  { value: 'BoolToInt', label: 'BOOL → INT', title: 'Writes the TRUE or FALSE value' },
  { value: 'BitFromWord', label: 'Bit from word', title: 'One bit of an INT word to a BOOL' },
  { value: 'BitToWord', label: 'Bit to word', title: 'A BOOL into one bit of an INT word; mappings onto the same word build it together' },
  { value: 'Scale', label: 'Scale', title: 'value × factor + offset, INT/REAL to INT/REAL' },
];

const CONDITIONS: readonly IntCondition[] = ['NotZero', 'Equals', 'GreaterOrEqual'];
const WIDTHS: readonly WordWidth[] = ['Byte', 'Word', 'DWord'];
const ROUNDINGS: readonly RoundingMode[] = ['Round', 'Truncate'];

/** Bits of a width. */
function bitsOf(width: WordWidth | undefined): number {
  return width === 'Byte' ? 8 : width === 'DWord' ? 32 : 16;
}

/**
 * The mapping the dialog saves: `mode` plus only the options that mode reads (an option left at its
 * default is still written, so the list shows what was chosen); without a mode the legacy fields only.
 */
export function mappingForSave(draft: ConnectSignalMapping): ConnectSignalMapping {
  const base: ConnectSignalMapping = { enabled: draft.enabled, sourceSignal: draft.sourceSignal, destSignal: draft.destSignal, coercion: draft.coercion ?? 'Strict' };
  if (!draft.mode) return base;
  const out: ConnectSignalMapping = { ...base, mode: draft.mode };
  const target = out as unknown as Record<string, unknown>;
  const source = draft as unknown as Record<string, unknown>;
  for (const key of MAPPING_MODE_OPTIONS[draft.mode]) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return out;
}

/** Why the draft cannot be saved, or null. */
export function mappingDraftProblem(draft: ConnectSignalMapping): string | null {
  if ((draft.mode === 'BitFromWord' || draft.mode === 'BitToWord')) {
    const bit = draft.bit ?? 0;
    const max = bitsOf(draft.width) - 1;
    if (!Number.isInteger(bit) || bit < 0 || bit > max) return `Bit must be 0..${max} for ${draft.width ?? 'Word'}`;
  }
  return null;
}

/**
 * A number field that keeps the typed text. A valid number is reported with `onChange`; an invalid draft keeps
 * the last valid value and is reported with `onInvalid`, so the dialog cannot save a silent default (DESIGN.md).
 */
function NumberField({ label, value, integer, onChange, onInvalid }: {
  label: string; value: number | undefined; integer?: boolean;
  onChange: (v: number) => void; onInvalid: (label: string, invalid: boolean) => void;
}) {
  // Full precision (String, not formatDecimal): the field must show the value that is saved (DESIGN.md).
  const [text, setText] = useState(value === undefined ? '' : String(value));
  const parsed = parseDecimal(text);
  const invalid = parsed === null || (integer === true && !Number.isInteger(parsed));
  useEffect(() => {
    onInvalid(label, invalid);
    return () => onInvalid(label, false);
  }, [label, invalid, onInvalid]);
  return (
    <TextField
      size="small"
      value={text}
      error={invalid}
      onChange={(e) => {
        setText(e.target.value);
        const next = parseDecimal(e.target.value);
        if (next !== null && (!integer || Number.isInteger(next))) onChange(next);
      }}
      inputProps={{ 'aria-label': label, 'aria-invalid': invalid, inputMode: integer ? 'numeric' : 'decimal' }}
      sx={inspectorInputSx}
    />
  );
}

function Select<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void;
}) {
  return (
    <TextField
      select size="small" value={value}
      onChange={(e) => onChange(e.target.value as T)}
      inputProps={{ 'aria-label': label }}
      sx={inspectorInputSx}
    >
      {options.map((o) => <MenuItem key={o} value={o} sx={{ fontSize: 12 }}>{o}</MenuItem>)}
    </TextField>
  );
}

/** Mode and the options the chosen mode reads. Controlled: `value` is the draft, `onChange` gets the next draft. */
export function MappingOptionsFields({ value, onChange, onInvalid, conversionSupported }: {
  value: ConnectSignalMapping;
  /** The gateway understands `mode` (`/health` `mappingConversion`); otherwise only the 1:1 choice is offered. */
  conversionSupported: boolean;
  onChange: (next: ConnectSignalMapping) => void;
  /** A number field holds (or no longer holds) text that is not a valid number; keep it stable (useCallback). */
  onInvalid: (field: string, invalid: boolean) => void;
}) {
  const set = (patch: Partial<ConnectSignalMapping>): void => onChange({ ...value, ...patch });
  const uses = new Set(value.mode ? MAPPING_MODE_OPTIONS[value.mode] : []);
  const modeTitle = MODES.find((m) => m.value === (value.mode ?? ''))?.title;

  return (
    <>
      <InspectorRow label="Conversion" labelTitle={modeTitle} py={0.25}>
        <TextField
          select size="small" value={value.mode ?? ''}
          onChange={(e) => set({ mode: (e.target.value || undefined) as SignalConnectorMode | undefined })}
          inputProps={{ 'aria-label': 'Conversion' }}
          sx={inspectorInputSx}
        >
          {MODES.filter((m) => conversionSupported || m.value === '' || m.value === value.mode).map((m) => (
            <MenuItem key={m.value || 'legacy'} value={m.value} title={m.title} sx={{ fontSize: 12 }}>{m.label}</MenuItem>
          ))}
        </TextField>
      </InspectorRow>
      {!value.mode && (
        <InspectorRow label="Allow coercion" labelTitle="bool↔int and int→float" alignField="end" py={0.25}>
          <Checkbox size="small" checked={value.coercion === 'Coerce'} onChange={(e) => set({ coercion: e.target.checked ? 'Coerce' : 'Strict' })}
            inputProps={{ 'aria-label': 'Allow coercion' }} />
        </InspectorRow>
      )}
      {uses.has('condition') && (
        <InspectorRow label="Condition" py={0.25}>
          <Select label="Condition" value={value.condition ?? 'NotZero'} options={CONDITIONS} onChange={(condition) => set({ condition })} />
        </InspectorRow>
      )}
      {uses.has('compareValue') && value.condition && value.condition !== 'NotZero' && (
        <InspectorRow label="Compare value" py={0.25}>
          <NumberField label="Compare value" integer value={value.compareValue ?? 0} onChange={(compareValue) => set({ compareValue })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('trueValue') && (
        <InspectorRow label="TRUE value" py={0.25}>
          <NumberField label="TRUE value" integer value={value.trueValue ?? 1} onChange={(trueValue) => set({ trueValue })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('falseValue') && (
        <InspectorRow label="FALSE value" py={0.25}>
          <NumberField label="FALSE value" integer value={value.falseValue ?? 0} onChange={(falseValue) => set({ falseValue })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('width') && (
        <InspectorRow label="Width" labelTitle="Byte = 8, Word = 16, DWord = 32 bit" py={0.25}>
          <Select label="Width" value={value.width ?? 'Word'} options={WIDTHS} onChange={(width) => set({ width })} />
        </InspectorRow>
      )}
      {uses.has('bit') && (
        <InspectorRow label="Bit" labelTitle={`0..${bitsOf(value.width) - 1}`} py={0.25}>
          <NumberField label="Bit" integer value={value.bit ?? 0} onChange={(bit) => set({ bit })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('factor') && (
        <InspectorRow label="Factor" py={0.25}>
          <NumberField label="Factor" value={value.factor ?? 1} onChange={(factor) => set({ factor })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('offset') && (
        <InspectorRow label="Offset" py={0.25}>
          <NumberField label="Offset" value={value.offset ?? 0} onChange={(offset) => set({ offset })} onInvalid={onInvalid} />
        </InspectorRow>
      )}
      {uses.has('rounding') && (
        <InspectorRow label="Rounding" labelTitle="Round = half away from zero; Truncate = towards zero (INT destination)" py={0.25}>
          <Select label="Rounding" value={value.rounding ?? 'Round'} options={ROUNDINGS} onChange={(rounding) => set({ rounding })} />
        </InspectorRow>
      )}
      {uses.has('signed') && (
        <InspectorRow label="Signed" labelTitle="Signed interpretation of the INT word" alignField="end" py={0.25}>
          <Checkbox size="small" checked={value.signed !== false} onChange={(e) => set({ signed: e.target.checked })}
            inputProps={{ 'aria-label': 'Signed' }} />
        </InspectorRow>
      )}
      {uses.has('invert') && (
        <InspectorRow label="Invert" alignField="end" py={0.25}>
          <Checkbox size="small" checked={value.invert === true} onChange={(e) => set({ invert: e.target.checked })}
            inputProps={{ 'aria-label': 'Invert' }} />
        </InspectorRow>
      )}
    </>
  );
}
