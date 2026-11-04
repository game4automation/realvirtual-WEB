// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-editors.tsx — Inline editor widgets for the Property Inspector.
 *
 * Contains NumberEditor, BooleanEditor, EnumEditor, StringEditor, Vector3Editor,
 * ObjectEditor, SubFieldRow, FieldEditor, and the flattenObjectFields utility.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Box,
  Typography,
  TextField,
  Select,
  MenuItem,
  Checkbox,
  Slider,
} from '@mui/material';
import { DragNumberField } from './DragNumberField';
import { InspectorRow } from './rv-inspector-row';
import { isCompleteDecimal, isInvalidDecimalDraft, parseDecimal } from './rv-number-format';
import { ACCENT, DIVIDER, ERROR, FS, ICON_SIZE, INK_LOW, SUCCESS, inspectorInputSx } from './shared-sx';
import { type FieldType, ENUM_FIELDS, colorToHex, hexToColor } from './rv-inspector-helpers';

// ── Direction fallback (used when ENUM_FIELDS lookup returns undefined) ───

const DIRECTION_OPTIONS = [
  'LinearX', 'LinearY', 'LinearZ',
  'RotationX', 'RotationY', 'RotationZ',
  'Virtual',
];

// ── Field Editor Props ────────────────────────────────────────────────────

export interface FieldEditorProps {
  value: unknown;
  onChange: (value: unknown) => void;
  fieldType: FieldType;
  fieldName: string;
  editable?: boolean;
  /** Optional unit suffix rendered inside number inputs (e.g. "mm", "mm/s"). */
  unit?: string;
  /** Enum choices from the component schema (wire values). When given they win
   *  over the name-keyed `ENUM_FIELDS` fallback, which only knows a handful of
   *  legacy fields (Direction, Active, CollisionRole ...). */
  options?: string[];
  /** Inclusive bounds and drag step of a number field, from the schema
   *  (`minimum` / `maximum` / `step`, plan-673). Passed on to the number editor,
   *  which clamps a typed value on commit and a drag continuously — so a bound
   *  the writer would have to enforce is enforced at the input instead. */
  min?: number;
  max?: number;
  step?: number;
}

// ── NumberEditor ──────────────────────────────────────────────────────────

// Live commits while typing are gated by `isCompleteDecimal` (rv-number-format):
// mid-edit drafts like "1.", "1," or "-" don't snap the value to a premature
// parse result. Comma and dot are both decimal separators (plan-510).

/** Props of {@link NumberEditor}. `min`/`max`/`disabled`/`ariaLabel` are optional (plan-502 F8). */
export interface NumberEditorProps {
  value: number;
  onChange: (v: number) => void;
  unit?: string;
  /** Inclusive lower bound: drags clamp to it, a typed value is clamped on commit (blur/Enter). */
  min?: number;
  /** Inclusive upper bound (see `min`). */
  max?: number;
  /** Drag step per pixel (default 1); also derives the fraction digits (plan-650). */
  step?: number;
  /**
   * false = commit only at the END of an edit (blur, Enter, end of a drag) — for values whose
   * commit is expensive (plan-650: a parametric family regenerates once per commit). Default true.
   */
  liveCommit?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

/** Clamp `n` into the optional range. */
export function clampToRange(n: number, min?: number, max?: number): number {
  let out = n;
  if (min !== undefined && Number.isFinite(min) && out < min) out = min;
  if (max !== undefined && Number.isFinite(max) && out > max) out = max;
  return out;
}

/** "0.5…1", "≥ 0", "≤ 10" — the range hint shown next to a bounded field ('' without bounds). */
export function formatRangeHint(min?: number, max?: number): string {
  const lo = min !== undefined && Number.isFinite(min);
  const hi = max !== undefined && Number.isFinite(max);
  if (lo && hi) return `${min}…${max}`;
  if (lo) return `≥ ${min}`;
  if (hi) return `≤ ${max}`;
  return '';
}

export function NumberEditor({ value, onChange, unit, min, max, step, liveCommit = true, disabled, ariaLabel }: NumberEditorProps) {
  const [draft, setDraft] = useState(String(value));
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const hint = formatRangeHint(min, max);
  // The value a clamping commit just sent: its re-synced draft must not fire a
  // second live commit before the parent's value catches up.
  const clampedRef = useRef<number | null>(null);

  // Re-sync draft when the external value changes from outside (gizmo drag,
  // reset, live signal, polling tick). We compare numerically against the
  // parsed draft so the user's in-progress typing is not clobbered. Only
  // user-edited drafts are protected while focused; untouched fields stay live.
  useEffect(() => {
    // The latest draft, not the render's closure: an acknowledgement can arrive
    // after the next keystroke and must not clear that keystroke's dirty flag.
    const latest = draftRef.current;
    const parsed = parseDecimal(latest);
    // A matching complete draft is acknowledged by the parent, so later
    // external updates must remain visible even while the field has focus.
    const acknowledged = isCompleteDecimal(latest) && parsed === value;
    if (dirtyRef.current && !acknowledged) return;
    dirtyRef.current = false;
    if (parsed === null || parsed !== value) {
      setDraft(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Live commit on typing: fire onChange whenever the draft is a complete,
  // finite number that differs from the current external value. Drag scrubs
  // already commit live via onDragChange; this brings the keyboard path to
  // parity. Trailing-dot / lone-minus drafts are skipped so typing "1.5"
  // doesn't briefly snap to 1.
  useEffect(() => {
    if (disabled || !liveCommit || !dirtyRef.current) return;
    if (!isCompleteDecimal(draft)) return;
    const parsed = parseDecimal(draft);
    if (parsed === null) return;
    // A bounded field commits live only INSIDE its range: clamping mid-typing
    // would snap "0" (on the way to "0.7") to the minimum and clobber the draft.
    // Out-of-range drafts are clamped on blur/Enter.
    if (clampToRange(parsed, min, max) !== parsed) return;
    if (clampedRef.current !== null && parsed === clampedRef.current) return;
    clampedRef.current = null;
    if (parsed !== value) {
      onChange(parsed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const commit = useCallback(() => {
    if (!dirtyRef.current) {
      // An acknowledged live edit already cleared the dirty flag; blur still
      // normalises the typed spelling ("-9,5" -> "-9.5").
      const settled = parseDecimal(draft);
      if (settled !== null && settled === value) setDraft(String(value));
      return;
    }
    dirtyRef.current = false;
    const parsed = parseDecimal(draft);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }
    const clamped = clampToRange(parsed, min, max);
    if (clamped !== parsed) {
      clampedRef.current = clamped;
    }
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  }, [draft, value, onChange, min, max]);

  const field = (
    <Box sx={{ width: '100%' }}>
    <DragNumberField
      compact
      value={draft}
      onValueChange={(next) => { dirtyRef.current = true; draftRef.current = next; setDraft(next); }}
      onCommit={commit}
      onDragChange={liveCommit ? (n) => { const c = clampToRange(n, min, max); if (c !== value) onChange(c); } : undefined}
      min={min !== undefined && Number.isFinite(min) ? min : -Number.MAX_SAFE_INTEGER}
      max={max !== undefined && Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER}
      step={step !== undefined && step > 0 ? step : 1}
      fractionDigits={step !== undefined && step > 0 && step >= 1 ? 0 : 3}
      unit={unit}
      disabled={disabled}
      ariaLabel={ariaLabel}
      error={isInvalidDecimalDraft(draft)}
      sx={{ width: '100%' }}
    />
    </Box>
  );
  if (!hint) return field;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: '100%' }} title={`Range ${hint}`}>
      <Box sx={{ flex: 1, minWidth: 0 }}>{field}</Box>
      <Typography
        component="span"
        data-testid="rv-number-range"
        sx={{ fontSize: FS.micro, color: INK_LOW, whiteSpace: 'nowrap', fontFamily: 'monospace' }}
      >
        {hint}
      </Typography>
    </Box>
  );
}

// ── BooleanEditor ────────────────────────────────────────────────────────

export function BooleanEditor({ value, onChange, disabled, ariaLabel }: {
  value: boolean; onChange: (v: boolean) => void; disabled?: boolean; ariaLabel?: string;
}) {
  // Minimal checkbox — the standard property-inspector boolean. Sits at the
  // field column's left edge (alignField="stretch") so it lines up with where
  // the number/enum input boxes begin. Compact padding; primary tint when on.
  return (
    <Checkbox
      size="small"
      checked={value}
      disabled={disabled}
      inputProps={ariaLabel ? { 'aria-label': ariaLabel } : undefined}
      onChange={(_, checked) => onChange(checked)}
      sx={{
        p: 0.125,
        color: INK_LOW,
        '&.Mui-checked': { color: 'primary.main' },
        '& .MuiSvgIcon-root': { fontSize: ICON_SIZE.md },
      }}
    />
  );
}

// ── EnumEditor ───────────────────────────────────────────────────────────

export function EnumEditor({ value, onChange, options, disabled, ariaLabel }: {
  value: string; onChange: (v: string) => void; options: string[]; disabled?: boolean; ariaLabel?: string;
}) {
  return (
    <Select
      size="small"
      value={value}
      disabled={disabled}
      inputProps={ariaLabel ? { 'aria-label': ariaLabel } : undefined}
      onChange={(e) => onChange(e.target.value)}
      sx={{
        fontSize: FS.label,
        fontFamily: 'monospace',
        height: 18,
        width: '100%',
        ...inspectorInputSx,
        '& .MuiSelect-select': { py: 0.25, px: 1 },
      }}
    >
      {options.map((opt) => (
        <MenuItem key={opt} value={opt} sx={{ fontSize: FS.label }}>{opt}</MenuItem>
      ))}
    </Select>
  );
}

// ── StringEditor ─────────────────────────────────────────────────────────

export function StringEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [localValue, setLocalValue] = useState(value);

  // Re-sync when the external value changes from outside — a selection change
  // (the inspector keys sections by component TYPE, so the editor instance is
  // reused across nodes), undo/redo, a reset. Without it the field kept showing
  // the first node's text (every `Group` read "axis1") and a blur would have
  // WRITTEN that stale text into the newly selected node. Mid-typing this does
  // not fire: `value` only changes on commit.
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const handleBlur = () => {
    if (localValue !== value) onChange(localValue);
  };

  return (
    <TextField
      size="small"
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(); }}
      slotProps={{
        input: { sx: { fontSize: FS.label, fontFamily: 'monospace', height: 18 } },
      }}
      sx={{
        width: '100%',
        '& .MuiOutlinedInput-root': inspectorInputSx,
      }}
    />
  );
}

// ── Vector3Editor ────────────────────────────────────────────────────────

// ── Axis colors ──────────────────────────────────────────────────────────

const AXIS_COLORS = { x: ERROR, y: SUCCESS, z: ACCENT } as const;

/**
 * DragLabel — Unity-style draggable axis label.
 * Click-drag horizontally on the label to scrub the numeric value.
 * Sensitivity scales with drag distance; holding Shift for fine control.
 */
function DragLabel({
  axis,
  value,
  onDrag,
  onDragEnd,
}: {
  axis: 'x' | 'y' | 'z';
  value: number;
  onDrag: (newValue: number) => void;
  onDragEnd: () => void;
}) {
  const dragRef = useRef<{ startX: number; startValue: number } | null>(null);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startValue: value };
  }, [value]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const sensitivity = e.shiftKey ? 0.01 : 0.1;
    const newValue = +(dragRef.current.startValue + dx * sensitivity).toFixed(4);
    onDrag(newValue);
  }, [onDrag]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    onDragEnd();
  }, [onDragEnd]);

  return (
    <Typography
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      sx={{
        fontSize: FS.micro,
        fontWeight: 600,
        color: AXIS_COLORS[axis],
        width: 10,
        textAlign: 'center',
        textTransform: 'uppercase',
        flexShrink: 0,
        cursor: 'ew-resize',
        userSelect: 'none',
        '&:hover': { opacity: 0.8 },
      }}
    >
      {axis}
    </Typography>
  );
}

// ── ColorEditor ──────────────────────────────────────────────────────────

/** Hex string editor with one undoable commit per picker choice or text edit. */
export function HexColorEditor({ value, onChange, disabled, ariaLabel }: {
  value: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(value.toUpperCase());
  const ref = useRef<HTMLInputElement | null>(null);
  const dirty = useRef(false);
  const latest = useRef({ value, onChange, disabled });
  latest.current = { value, onChange, disabled };
  useEffect(() => { setDraft(value.toUpperCase()); dirty.current = false; }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const commit = () => {
      const next = el.value.toUpperCase();
      setDraft(next);
      dirty.current = false;
      if (!latest.current.disabled && next !== latest.current.value.toUpperCase()) latest.current.onChange(next);
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, []);
  const commitText = () => {
    if (disabled || !dirty.current) return;
    dirty.current = false;
    if (/^#[0-9a-f]{6}$/i.test(draft)) {
      if (draft !== value.toUpperCase()) onChange(draft);
    } else setDraft(value.toUpperCase());
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: '100%', minWidth: 0 }}>
      <Box component="input" type="color" ref={ref} disabled={disabled}
        aria-label={ariaLabel ?? 'Colour'}
        value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : value}
        onInput={(e: React.FormEvent<HTMLInputElement>) => setDraft(e.currentTarget.value.toUpperCase())}
        sx={{ width: 28, height: 18, flexShrink: 0, p: 0, border: `1px solid ${DIVIDER}`, borderRadius: 0.5,
          bgcolor: 'transparent', cursor: disabled ? 'default' : 'pointer',
          '&::-webkit-color-swatch-wrapper': { p: 0.125 },
          '&::-webkit-color-swatch': { border: 'none', borderRadius: 0.5 } }} />
      <TextField size="small" value={draft} disabled={disabled}
        onChange={(e) => { dirty.current = true; setDraft(e.target.value.toUpperCase()); }}
        onBlur={commitText} onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }}
        slotProps={{ input: { sx: { fontSize: FS.label, fontFamily: 'monospace', height: 18 } },
          htmlInput: { 'aria-label': `${ariaLabel ?? 'Colour'} hex` } }}
        sx={{ flex: 1, minWidth: 0, '& .MuiOutlinedInput-root': inspectorInputSx }} />
    </Box>
  );
}

/** Compact slider and decimal input; dragging only updates the local draft. */
export function CompactSliderEditor({ value, min, max, step, onChange, disabled, ariaLabel }: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const dirty = useRef(false);
  useEffect(() => { setDraft(String(value)); dirty.current = false; }, [value]);
  const commitNumber = () => {
    if (disabled || !dirty.current) return;
    dirty.current = false;
    const next = parseDecimal(draft);
    if (next === null) setDraft(String(value));
    else {
      setDraft(String(next));
      if (next !== value) onChange(next);
    }
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%', minWidth: 0 }}>
      <Slider size="small" value={parseDecimal(draft) ?? value} min={min} max={max} step={step}
        disabled={disabled} aria-label={ariaLabel}
        onChange={(_, next) => setDraft(String(next))}
        onChangeCommitted={(_, next) => {
          if (!disabled && typeof next === 'number') {
            setDraft(String(next));
            dirty.current = false;
            if (next !== value) onChange(next);
          }
        }}
        sx={{ flex: 1, minWidth: 0, mx: 0.5,
          '& .MuiSlider-thumb': { width: 10, height: 10 },
          '& .MuiSlider-track': { height: 2 },
          '& .MuiSlider-rail': { height: 2, opacity: 0.2 } }} />
      <DragNumberField compact value={draft} disabled={disabled} ariaLabel={`${ariaLabel ?? 'Slider'} value`}
        min={min ?? 0} max={max ?? 100} step={step ?? 1}
        onValueChange={(next) => { dirty.current = true; setDraft(next); }} onCommit={commitNumber}
        sx={{ width: 52, flexShrink: 0 }} />
    </Box>
  );
}

/**
 * A Unity Color `{r,g,b,a}` as a swatch with the browser's colour picker and
 * the hex value. The picker fires continuously while the user drags; the value
 * is written once, on the input's native `change` (picker closed / committed),
 * so a colour choice is ONE undoable edit. Alpha is preserved.
 */
export function ColorEditor({ value, onChange, disabled, ariaLabel }: {
  value: { r: number; g: number; b: number; a?: number };
  onChange: (v: { r: number; g: number; b: number; a: number }) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const hex = colorToHex(value);
  const [draft, setDraft] = useState(hex);
  const ref = useRef<HTMLInputElement | null>(null);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  useEffect(() => { setDraft(hex); }, [hex]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const commit = () => {
      const next = hexToColor(el.value, latest.current.value);
      if (next && el.value.toLowerCase() !== colorToHex(latest.current.value)) latest.current.onChange(next);
    };
    el.addEventListener('change', commit);
    return () => el.removeEventListener('change', commit);
  }, []);

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
      <Box
        component="input"
        type="color"
        ref={ref}
        aria-label={ariaLabel ?? 'Colour'}
        value={draft}
        disabled={disabled}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        sx={{
          width: 36, height: 18, p: 0, border: `1px solid ${DIVIDER}`, borderRadius: 0.5,
          bgcolor: 'transparent', cursor: disabled ? 'default' : 'pointer',
          '&::-webkit-color-swatch-wrapper': { p: 0.125 },
          '&::-webkit-color-swatch': { border: 'none', borderRadius: 0.5 },
        }}
      />
      <Typography component="span" sx={{ fontSize: FS.label, fontFamily: 'monospace', color: INK_LOW }}>
        {draft.toUpperCase()}
      </Typography>
    </Box>
  );
}

export function Vector3Editor({ value, onChange }: { value: { x: number; y: number; z: number }; onChange: (v: { x: number; y: number; z: number }) => void }) {
  const [local, setLocal] = useState({ x: String(value.x), y: String(value.y), z: String(value.z) });

  // Re-sync local strings whenever the external `value` changes — covers
  // Reset-to-zero, gizmo drag, undo/redo, and any other path that mutates
  // the underlying node from outside the input. We compare primitives in
  // deps so the effect skips frames where `value` reference changes but
  // numbers stay identical (the parent's polling tick triggers a fresh
  // object each 200ms). Mid-typing this effect doesn't fire because the
  // numeric `value` only updates on blur/drag.
  useEffect(() => {
    setLocal({ x: String(value.x), y: String(value.y), z: String(value.z) });
  }, [value.x, value.y, value.z]);

  const handleBlur = (axis: 'x' | 'y' | 'z') => {
    const parsed = parseDecimal(local[axis]);
    if (parsed !== null && parsed !== value[axis]) {
      onChange({ ...value, [axis]: parsed });
    } else {
      setLocal((prev) => ({ ...prev, [axis]: String(value[axis]) }));
    }
  };

  const handleDrag = useCallback((axis: 'x' | 'y' | 'z', newValue: number) => {
    setLocal((prev) => ({ ...prev, [axis]: String(newValue) }));
    onChange({ ...value, [axis]: newValue });
  }, [onChange, value]);

  const handleDragEnd = useCallback(() => {
    // Sync local display with current value after drag completes
    setLocal({ x: String(value.x), y: String(value.y), z: String(value.z) });
  }, [value]);

  const axisStyle = {
    width: '100%',
    '& .MuiOutlinedInput-root': {
      ...inspectorInputSx,
      '&.Mui-error fieldset': { borderColor: 'error.main' },
    },
    // Tighten MUI's default 14px horizontal input padding so the three axis
    // cells stay compact in the narrow field column (0.625 × 8 = 5px).
    '& .MuiOutlinedInput-input': { px: 0.625 },
  };

  return (
    <Box sx={{ display: 'flex', gap: 0.25, width: '100%' }}>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <Box key={axis} sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.125 }}>
          <DragLabel
            axis={axis}
            value={value[axis]}
            onDrag={(v) => handleDrag(axis, v)}
            onDragEnd={handleDragEnd}
          />
          <TextField
            size="small"
            type="text"
            value={local[axis]}
            error={isInvalidDecimalDraft(local[axis])}
            onChange={(e) => setLocal((prev) => ({ ...prev, [axis]: e.target.value }))}
            onBlur={() => handleBlur(axis)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(axis); }}
            slotProps={{
              input: { sx: { fontSize: FS.micro, fontFamily: 'monospace', height: 18 } },
              htmlInput: { inputMode: 'decimal', 'aria-label': `${axis} value` },
            }}
            sx={axisStyle}
          />
        </Box>
      ))}
    </Box>
  );
}

// ── flattenObjectFields ──────────────────────────────────────────────────

/** Flatten an object/array value into a list of { key, value } pairs for inline display as regular rows. */
export function flattenObjectFields(value: Record<string, unknown> | unknown[], prefix = ''): Array<{ key: string; value: unknown }> {
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return value.flatMap((item, i) => {
      if (typeof item === 'object' && item !== null) {
        return Object.entries(item as Record<string, unknown>).map(([k, v]) => ({
          key: `${prefix}[${i}].${k}`,
          value: v,
        }));
      }
      return [{ key: `${prefix}[${i}]`, value: item }];
    });
  }
  return Object.entries(value)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ({ key: prefix ? `${prefix}.${k}` : k, value: v }));
}

// ── SubFieldRow ──────────────────────────────────────────────────────────

/** Compact sub-field row for expanded object/array editing. */
export function SubFieldRow({ label, value, onChange }: {
  label: string; value: unknown; onChange: (v: unknown) => void;
}) {
  const isBool = typeof value === 'boolean';
  return (
    <InspectorRow
      label={label}
      labelTitle={label}
      labelColor="text.disabled"
      dense
      minHeight={22}
      py={0.125}
      alignField="stretch"
    >
      {isBool ? (
        <BooleanEditor value={value} onChange={(v) => onChange(v)} />
      ) : typeof value === 'number' ? (
        <NumberEditor value={value} onChange={(v) => onChange(v)} />
      ) : (
        <StringEditor value={String(value ?? '')} onChange={(v) => onChange(v)} />
      )}
    </InspectorRow>
  );
}

// ── ObjectEditor ─────────────────────────────────────────────────────────

/** Editable object/array field — always expanded with inline sub-fields. */
export function ObjectEditor({ value, onChange }: {
  value: Record<string, unknown> | unknown[];
  onChange: (v: unknown) => void;
}) {
  // Empty arrays — just show []
  if (Array.isArray(value) && value.length === 0) {
    return <Typography sx={{ fontSize: FS.micro, fontFamily: 'monospace', color: 'text.disabled' }}>[ ]</Typography>;
  }

  if (Array.isArray(value)) {
    return (
      <Box sx={{ width: '100%', pl: 0.5, borderLeft: `1px solid ${DIVIDER}` }}>
        {value.map((item, i) => (
          <Box key={i}>
            {typeof item === 'object' && item !== null ? (
              Object.entries(item as Record<string, unknown>).map(([k, v]) => (
                <SubFieldRow key={k} label={`[${i}].${k}`} value={v}
                  onChange={(nv) => {
                    const arr = [...value];
                    arr[i] = { ...(arr[i] as Record<string, unknown>), [k]: nv };
                    onChange(arr);
                  }}
                />
              ))
            ) : (
              <SubFieldRow label={`[${i}]`} value={item}
                onChange={(nv) => { const arr = [...value]; arr[i] = nv; onChange(arr); }}
              />
            )}
          </Box>
        ))}
      </Box>
    );
  }

  // Object — always expanded, sub-fields inline
  const entries = Object.entries(value);
  return (
    <Box sx={{ width: '100%', pl: 0.5, borderLeft: `1px solid ${DIVIDER}` }}>
      {entries.map(([k, v]) => (
        <SubFieldRow key={k} label={k} value={v}
          onChange={(nv) => onChange({ ...value, [k]: nv })}
        />
      ))}
    </Box>
  );
}

// ── FieldEditor (dispatcher) ─────────────────────────────────────────────

export function FieldEditor({ value, onChange, fieldType, fieldName, editable, unit, options, min, max, step }: FieldEditorProps) {
  switch (fieldType) {
    case 'boolean':
      return <BooleanEditor value={value as boolean} onChange={(v) => onChange(v)} />;
    case 'number':
      return <NumberEditor value={value as number} onChange={(v) => onChange(v)} unit={unit} min={min} max={max} step={step} />;
    case 'enum': {
      const current = String(value);
      const choices = options ?? ENUM_FIELDS[fieldName] ?? DIRECTION_OPTIONS;
      // A document may carry a value the schema no longer lists (older export,
      // hand-edited extras). Keep it selectable rather than letting MUI render
      // an out-of-range Select, so the user sees what is there and can move off it.
      const withCurrent = choices.includes(current) ? choices : [current, ...choices];
      return <EnumEditor value={current} onChange={(v) => onChange(v)} options={withCurrent} />;
    }
    case 'color':
      return <ColorEditor value={value as { r: number; g: number; b: number; a?: number }} onChange={(v) => onChange(v)} disabled={!editable} ariaLabel={fieldName} />;
    case 'vector3':
      return <Vector3Editor value={value as { x: number; y: number; z: number }} onChange={(v) => onChange(v)} />;
    case 'object':
      // Editable objects use inline sub-field editors
      return editable
        ? <ObjectEditor value={value as Record<string, unknown> | unknown[]} onChange={onChange} />
        : null; // Read-only objects are flattened into regular FieldRows by ComponentSection
    case 'string':
    default:
      return <StringEditor value={String(value ?? '')} onChange={(v) => onChange(v)} />;
  }
}
