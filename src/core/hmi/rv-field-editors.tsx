// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-editors.tsx — Inline editor widgets for the Property Inspector.
 *
 * Contains NumberEditor, BooleanEditor, EnumEditor, StringEditor, Vector3Editor,
 * ObjectEditor, SubFieldRow, FieldEditor, and the flattenObjectFields utility.
 */

import { useState, useRef, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Switch,
  Select,
  MenuItem,
} from '@mui/material';
import { type FieldType, ENUM_FIELDS } from './rv-inspector-helpers';

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
}

// ── NumberEditor ──────────────────────────────────────────────────────────

export function NumberEditor({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [localValue, setLocalValue] = useState(String(value));

  // Sync local value when external value changes
  const displayValue = String(value);
  if (localValue !== displayValue && !document.activeElement?.closest('[data-number-field]')) {
    // Only sync when not focused — prevents cursor jump during typing
  }

  const handleBlur = () => {
    const parsed = parseFloat(localValue);
    if (!isNaN(parsed) && parsed !== value) {
      onChange(parsed);
    } else {
      setLocalValue(String(value));
    }
  };

  return (
    <TextField
      data-number-field
      size="small"
      type="number"
      value={localValue}
      onChange={(e) => setLocalValue(e.target.value)}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(); }}
      slotProps={{
        input: { sx: { fontSize: 11, fontFamily: 'monospace', height: 24 } },
        htmlInput: { step: 'any' },
      }}
      sx={{
        width: '100%',
        '& .MuiOutlinedInput-root': {
          bgcolor: 'rgba(255,255,255,0.04)',
          '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
          '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
          '&.Mui-focused fieldset': { borderColor: 'primary.main' },
        },
        // Hide number spinners
        '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
          WebkitAppearance: 'none', margin: 0,
        },
        '& input[type=number]': { MozAppearance: 'textfield' },
      }}
    />
  );
}

// ── BooleanEditor ────────────────────────────────────────────────────────

export function BooleanEditor({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      size="small"
      checked={value}
      onChange={(_, checked) => onChange(checked)}
      sx={{ ml: 'auto' }}
    />
  );
}

// ── EnumEditor ───────────────────────────────────────────────────────────

export function EnumEditor({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <Select
      size="small"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      sx={{
        fontSize: 11,
        fontFamily: 'monospace',
        height: 24,
        width: '100%',
        bgcolor: 'rgba(255,255,255,0.04)',
        '& .MuiSelect-select': { py: 0.25, px: 1 },
        '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
        '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
        '&.Mui-focused fieldset': { borderColor: 'primary.main' },
      }}
    >
      {options.map((opt) => (
        <MenuItem key={opt} value={opt} sx={{ fontSize: 11 }}>{opt}</MenuItem>
      ))}
    </Select>
  );
}

// ── StringEditor ─────────────────────────────────────────────────────────

export function StringEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [localValue, setLocalValue] = useState(value);

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
        input: { sx: { fontSize: 11, fontFamily: 'monospace', height: 24 } },
      }}
      sx={{
        width: '100%',
        '& .MuiOutlinedInput-root': {
          bgcolor: 'rgba(255,255,255,0.04)',
          '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
          '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
          '&.Mui-focused fieldset': { borderColor: 'primary.main' },
        },
      }}
    />
  );
}

// ── Vector3Editor ────────────────────────────────────────────────────────

// ── Axis colors ──────────────────────────────────────────────────────────

const AXIS_COLORS = { x: '#ef5350', y: '#66bb6a', z: '#4fc3f7' } as const;

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
        fontSize: 9,
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

export function Vector3Editor({ value, onChange }: { value: { x: number; y: number; z: number }; onChange: (v: { x: number; y: number; z: number }) => void }) {
  const [local, setLocal] = useState({ x: String(value.x), y: String(value.y), z: String(value.z) });

  const handleBlur = (axis: 'x' | 'y' | 'z') => {
    const parsed = parseFloat(local[axis]);
    if (!isNaN(parsed) && parsed !== value[axis]) {
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
      bgcolor: 'rgba(255,255,255,0.04)',
      '& fieldset': { borderColor: 'rgba(255,255,255,0.08)' },
      '&:hover fieldset': { borderColor: 'rgba(255,255,255,0.15)' },
      '&.Mui-focused fieldset': { borderColor: 'primary.main' },
    },
    '& input[type=number]::-webkit-outer-spin-button, & input[type=number]::-webkit-inner-spin-button': {
      WebkitAppearance: 'none', margin: 0,
    },
    '& input[type=number]': { MozAppearance: 'textfield' },
  };

  return (
    <Box sx={{ display: 'flex', gap: 0.5, width: '100%' }}>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <Box key={axis} sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 0.25 }}>
          <DragLabel
            axis={axis}
            value={value[axis]}
            onDrag={(v) => handleDrag(axis, v)}
            onDragEnd={handleDragEnd}
          />
          <TextField
            size="small"
            type="number"
            value={local[axis]}
            onChange={(e) => setLocal((prev) => ({ ...prev, [axis]: e.target.value }))}
            onBlur={() => handleBlur(axis)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(axis); }}
            slotProps={{
              input: { sx: { fontSize: 10, fontFamily: 'monospace', height: 22 } },
              htmlInput: { step: 'any' },
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
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.125, minHeight: 22 }}>
      <Typography sx={{ fontSize: 9, color: 'text.disabled', minWidth: 60, maxWidth: 90, flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: typeof value === 'boolean' ? 'flex-end' : 'stretch' }}>
        {typeof value === 'boolean' ? (
          <Switch size="small" checked={value} onChange={(_, c) => onChange(c)} />
        ) : typeof value === 'number' ? (
          <NumberEditor value={value} onChange={(v) => onChange(v)} />
        ) : (
          <StringEditor value={String(value ?? '')} onChange={(v) => onChange(v)} />
        )}
      </Box>
    </Box>
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
    return <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: 'text.disabled' }}>[ ]</Typography>;
  }

  if (Array.isArray(value)) {
    return (
      <Box sx={{ width: '100%', pl: 0.5, borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
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
    <Box sx={{ width: '100%', pl: 0.5, borderLeft: '1px solid rgba(255,255,255,0.06)' }}>
      {entries.map(([k, v]) => (
        <SubFieldRow key={k} label={k} value={v}
          onChange={(nv) => onChange({ ...value, [k]: nv })}
        />
      ))}
    </Box>
  );
}

// ── FieldEditor (dispatcher) ─────────────────────────────────────────────

export function FieldEditor({ value, onChange, fieldType, fieldName, editable }: FieldEditorProps) {
  switch (fieldType) {
    case 'boolean':
      return <BooleanEditor value={value as boolean} onChange={(v) => onChange(v)} />;
    case 'number':
      return <NumberEditor value={value as number} onChange={(v) => onChange(v)} />;
    case 'enum':
      return <EnumEditor value={String(value)} onChange={(v) => onChange(v)} options={ENUM_FIELDS[fieldName] ?? DIRECTION_OPTIONS} />;
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
