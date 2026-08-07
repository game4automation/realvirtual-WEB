// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-row.tsx — Single field row for the Property Inspector.
 *
 * Renders a field name, override indicator, and either an editor widget,
 * a reference badge, or a read-only display value.
 */

import {
  Box,
  Typography,
  IconButton,
} from '@mui/material';
import { Circle } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import type { FieldDescriptor } from '../engine/rv-component-registry';
import { isFieldDisplayReadonly } from '../engine/rv-component-registry';
import {
  inferFieldType,
  isComponentRef,
  isScriptableObject,
  formatDisplayValue,
  type FieldStatus,
} from './rv-inspector-helpers';
import { FieldEditor } from './rv-field-editors';
import { ReferenceDisplay, ScriptableObjectDisplay } from './rv-reference-display';
import { InspectorRow } from './rv-inspector-row';

const INK_LOW = 'rgba(255,255,255,0.5)';
const HIT_MIN = 24;

// ── Editability decision (pure, React-free → unit-testable) ─────────────────

/**
 * Decide whether a field row exposes an editor.
 * A field is editable only when it is a CONSUMED schema field, is not a
 * structural reference, and its schema descriptor does not mark it read-only for
 * display (`readonly:true` OR `scope:'des'` — DES-only config is never editable).
 *
 * plan-325: SIGNAL references (`isSignalRefType`) are the one reference kind
 * that IS editable — as Unlink/Change through the SignalSlotRow binding path,
 * never through a value editor. Pass `isSignalRef` to open the gate for them;
 * sensor/drive/other structural references stay read-only.
 */
export function isFieldEditable(
  status: FieldStatus,
  isReference: boolean,
  descriptor?: FieldDescriptor,
  isSignalRef = false,
): boolean {
  return status === 'consumed'
    && (!isReference || isSignalRef)
    && !isFieldDisplayReadonly(descriptor);
}

// ── FieldRow ──────────────────────────────────────────────────────────────

export interface FieldRowProps {
  fieldName: string;
  value: unknown;
  status: FieldStatus;
  isOverridden: boolean;
  onEdit: (value: unknown) => void;
  onReset: () => void;
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
  /** Schema descriptor for this field — supplies the optional `readonly` flag.
   *  Looked up and passed by the caller (rv-component-section). */
  descriptor?: FieldDescriptor;
  /** Optional unit suffix for numeric fields (e.g. "mm", "mm/s"). Rendered inside
   *  the number input (right) when editable, or after the value when read-only. */
  unit?: string;
}

export function FieldRow({ fieldName, value, status, isOverridden, onEdit, onReset, viewer, signalStore, descriptor, unit }: FieldRowProps) {
  const fieldType = inferFieldType(fieldName, value);
  const isReference = fieldType === 'reference' || fieldType === 'scriptableobject';
  // References are always read-only (structural links, not user-editable values);
  // a readonly schema descriptor also forces read-only display.
  const isEditable = isFieldEditable(status, isReference, descriptor);
  // DES-only config: shown read-only with a "(DES)" tag so the user knows the
  // value is consumed by the discrete-event scheduler, not the live view.
  const isDes = descriptor?.scope === 'des';

  // Tooltip text \u2014 NOTE: reference fields intentionally get no row tooltip.
  // The ReferenceDisplay / ScriptableObjectDisplay chip carries its own (richer)
  // tooltip; adding a row tooltip too would show two overlapping tooltips at once.
  let tooltipText = '';
  if (status === 'ignored') tooltipText = 'Not used by WebViewer';
  else if (status === 'unknown') tooltipText = 'Unknown field \u2014 not mapped in WebViewer';
  else if (isReference) tooltipText = '';
  else if (isOverridden) tooltipText = 'Overridden \u2014 click dot to reset';

  // The editable object expander still spans the full field width; the (now
  // compact) Vector3 editor fits the capped field column and right-aligns with
  // the other input fields.
  const fullWidthField = fieldType === 'object' && isEditable;

  const labelNode = (
    <>
      {fieldName}
      {isDes && (
        <Box
          component="span"
          sx={{ ml: 0.5, fontSize: 11, color: INK_LOW, fontStyle: 'italic' }}
        >
          (DES)
        </Box>
      )}
    </>
  );

  return (
    <InspectorRow
      label={labelNode}
      labelTitle={isDes ? `${fieldName} — DES-only config (read-only in live view)` : fieldName}
      labelColor={isEditable || isReference ? 'text.primary' : INK_LOW}
      fullWidthField={fullWidthField}
      alignField={isReference ? 'end' : 'stretch'}
      opacity={isEditable || isReference ? 1 : (status === 'consumed' ? 1 : 0.5)}
      rowTooltip={tooltipText}
      dot={isOverridden ? (
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          sx={{ width: HIT_MIN, height: HIT_MIN, p: 0, color: '#4fc3f7' }}
          title="Reset to default"
          aria-label={`reset ${fieldName} to default`}
        >
          <Circle sx={{ fontSize: 7 }} />
        </IconButton>
      ) : undefined}
    >
      {isComponentRef(value) ? (
        <ReferenceDisplay value={value} viewer={viewer} signalStore={signalStore} />
      ) : isScriptableObject(value) ? (
        <ScriptableObjectDisplay value={value as Record<string, unknown>} />
      ) : isEditable ? (
        <FieldEditor value={value} onChange={onEdit} fieldType={fieldType} fieldName={fieldName} editable unit={unit} />
      ) : (
        <Typography
          sx={{
            fontSize: 11,
            fontFamily: 'monospace',
            color: INK_LOW,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {formatDisplayValue(value)}
          {unit && typeof value === 'number' ? (
            <Box component="span" sx={{ color: INK_LOW, ml: 0.5 }}>{unit}</Box>
          ) : null}
        </Typography>
      )}
    </InspectorRow>
  );
}
