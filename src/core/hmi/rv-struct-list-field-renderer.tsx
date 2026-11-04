// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-struct-list-field-renderer.tsx — inspector editor for a field that holds a
 * LIST OF STRUCTS (plan-673 Phase 2).
 *
 * Without it such a field is not authorable in the browser at all. The generic
 * array editor in `rv-field-editors.tsx` offers no add, no remove and no
 * reorder — on an empty list it prints `[ ]` and there is no way to put anything
 * in it — and inside an entry every sub-field falls through to a text box: an
 * enum renders as free text, a Vector3 as `[object Object]`, and no unit or
 * bound reaches the input. A property that can only be set as raw text is not
 * finished.
 *
 * It is SCHEMA-DRIVEN, not hard-coded to one field: `getStructItemFields` reads
 * the item shape out of the rv-ODT `items.properties` of the field, so the
 * entry editors are the same number / enum / boolean / Vector3 / string editors
 * the component's own rows use, with the same units, bounds and choices. Any
 * future struct list gets a real editor by registering this renderer for its
 * `(componentType, fieldName)` — nothing else.
 *
 * Every mutation goes through `persistFieldOp`, the same `setField` op the
 * property inspector uses, so an edit lands in the SceneStore op log outside the
 * editor and in the AssetDocument inside, undoably, and survives a save.
 */

import { useEffect, useState } from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import { getStructItemFields, type FieldDescriptor } from '../engine/rv-component-registry';
import { BooleanEditor, EnumEditor, NumberEditor, StringEditor, Vector3Editor } from './rv-field-editors';
import { InspectorRow } from './rv-inspector-row';
import { DIVIDER, FS, ICON_SIZE, INK_LOW } from './shared-sx';

const HIT = 22;

type Row = Record<string, unknown>;

/** The value a fresh entry starts with, from the item schema's own defaults. */
export function defaultStructEntry(itemFields: Readonly<Record<string, FieldDescriptor>>): Row {
  const out: Row = {};
  for (const [name, desc] of Object.entries(itemFields)) {
    if (desc.default !== undefined) {
      out[name] = desc.default !== null && typeof desc.default === 'object'
        ? structuredClone(desc.default) : desc.default;
      continue;
    }
    // A sub-field without a declared default still needs a value, or the entry
    // would open with a row the editor cannot render.
    out[name] = desc.type === 'vector3' ? { x: 0, y: 0, z: 0 }
      : desc.type === 'number' ? 0
        : desc.type === 'boolean' ? false
          : '';
  }
  return out;
}

/** Move `from` to `to` in a copy of `list`; out-of-range indices return the input. */
export function moveEntry<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function SubEditor({ name, desc, value, onChange }: {
  name: string;
  desc: FieldDescriptor;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (desc.type) {
    case 'number':
      return (
        <NumberEditor
          value={typeof value === 'number' ? value : 0}
          onChange={(v) => onChange(v)}
          unit={desc.unit}
          min={desc.min}
          max={desc.max}
          step={desc.step}
          ariaLabel={name}
        />
      );
    case 'boolean':
      return <BooleanEditor value={value === true} onChange={(v) => onChange(v)} ariaLabel={name} />;
    case 'enum': {
      const options = desc.enumMap ? Object.keys(desc.enumMap) : [];
      const current = String(value ?? options[0] ?? '');
      const withCurrent = options.includes(current) ? options : [current, ...options];
      return <EnumEditor value={current} onChange={(v) => onChange(v)} options={withCurrent} ariaLabel={name} />;
    }
    case 'vector3': {
      const v = (value ?? {}) as { x?: number; y?: number; z?: number };
      return (
        <Vector3Editor
          value={{ x: v.x ?? 0, y: v.y ?? 0, z: v.z ?? 0 }}
          onChange={(nv) => onChange(nv)}
        />
      );
    }
    default:
      return <StringEditor value={String(value ?? '')} onChange={(v) => onChange(v)} />;
  }
}

export function StructListRenderer({ value, fieldName, componentType, nodePath }: FieldRendererProps) {
  const itemFields = getStructItemFields(componentType, fieldName);
  const initial = Array.isArray(value) ? (value as unknown[]).map((e) => ({ ...(e as Row) })) : [];
  const [rows, setRows] = useState<Row[]>(initial);

  // Re-sync when the underlying field changes (model reload, undo).
  useEffect(() => {
    setRows(Array.isArray(value) ? (value as unknown[]).map((e) => ({ ...(e as Row) })) : []);
  }, [value]);

  if (!itemFields) {
    return (
      <Typography sx={{ fontSize: FS.micro, fontFamily: 'monospace', color: INK_LOW }}>
        {`${fieldName}: no item shape in the schema`}
      </Typography>
    );
  }

  const commit = (next: Row[]): void => {
    const prev = rows;
    setRows(next);
    persistFieldOp(nodePath, componentType, fieldName, next, prev);
  };

  const entryLabel = (row: Row, i: number): string => {
    // The first enum sub-field is what the entry IS (a shape's `Kind`), so it
    // belongs in the header next to the index rather than only in a row below.
    const kindKey = Object.keys(itemFields).find((k) => itemFields[k].type === 'enum');
    const kind = kindKey ? String(row[kindKey] ?? '') : '';
    return kind ? `${i + 1}. ${kind}` : `${i + 1}`;
  };

  return (
    <Box sx={{ width: '100%' }}>
      <InspectorRow label={fieldName} labelTitle={fieldName} dense minHeight={22}>
        <Typography sx={{ fontSize: FS.micro, color: INK_LOW }}>
          {rows.length === 0 ? 'empty' : `${rows.length} ${rows.length === 1 ? 'entry' : 'entries'}`}
        </Typography>
      </InspectorRow>

      {rows.map((row, i) => (
        <Box
          key={i}
          data-testid={`struct-entry-${i}`}
          sx={{ mt: 0.25, pl: 0.5, borderLeft: `2px solid ${DIVIDER}` }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            <Typography sx={{ fontSize: FS.micro, color: 'text.secondary', flexGrow: 1 }}>
              {entryLabel(row, i)}
            </Typography>
            <Tooltip title="Move up">
              <span>
                <IconButton
                  size="small" disabled={i === 0}
                  data-testid={`struct-up-${i}`}
                  aria-label={`move ${fieldName} entry ${i + 1} up`}
                  onClick={() => commit(moveEntry(rows, i, i - 1))}
                  sx={{ width: HIT, height: HIT, p: 0 }}
                >
                  <ArrowUpwardIcon sx={{ fontSize: ICON_SIZE.sm }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton
                  size="small" disabled={i === rows.length - 1}
                  data-testid={`struct-down-${i}`}
                  aria-label={`move ${fieldName} entry ${i + 1} down`}
                  onClick={() => commit(moveEntry(rows, i, i + 1))}
                  sx={{ width: HIT, height: HIT, p: 0 }}
                >
                  <ArrowDownwardIcon sx={{ fontSize: ICON_SIZE.sm }} />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Duplicate">
              <IconButton
                size="small"
                data-testid={`struct-duplicate-${i}`}
                aria-label={`duplicate ${fieldName} entry ${i + 1}`}
                onClick={() => {
                  const next = [...rows];
                  next.splice(i + 1, 0, structuredClone(row));
                  commit(next);
                }}
                sx={{ width: HIT, height: HIT, p: 0 }}
              >
                <ContentCopyIcon sx={{ fontSize: ICON_SIZE.sm }} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove">
              <IconButton
                size="small"
                data-testid={`struct-remove-${i}`}
                aria-label={`remove ${fieldName} entry ${i + 1}`}
                onClick={() => commit(rows.filter((_, j) => j !== i))}
                sx={{ width: HIT, height: HIT, p: 0 }}
              >
                <RemoveIcon sx={{ fontSize: ICON_SIZE.sm }} />
              </IconButton>
            </Tooltip>
          </Box>

          {Object.entries(itemFields).map(([name, desc]) => (
            <InspectorRow
              key={name}
              label={name}
              labelTitle={desc.unit ? `${name} (${desc.unit})` : name}
              labelColor="text.disabled"
              dense
              minHeight={22}
              py={0.125}
              alignField="stretch"
            >
              <SubEditor
                name={`${fieldName}[${i}].${name}`}
                desc={desc}
                value={row[name]}
                onChange={(nv) => {
                  const next = [...rows];
                  next[i] = { ...next[i], [name]: nv };
                  commit(next);
                }}
              />
            </InspectorRow>
          ))}
        </Box>
      ))}

      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
        <Button
          size="small"
          startIcon={<AddIcon fontSize="small" />}
          data-testid="struct-add"
          onClick={() => commit([...rows, defaultStructEntry(itemFields)])}
          sx={{ fontSize: FS.label, textTransform: 'none' }}
        >
          Add entry
        </Button>
      </Box>
    </Box>
  );
}

// ── Self-registration ──
// plan-673: the one struct list that exists today. A future one is registered
// here the same way — the renderer itself needs no change.
fieldRendererRegistry.register({
  componentType: 'CollisionShapeSet',
  fieldName: 'Shapes',
  component: StructListRenderer,
});
