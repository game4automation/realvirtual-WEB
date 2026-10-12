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
import { Circle, Link as LinkIcon, LinkOff, WarningAmber } from '@mui/icons-material';
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
import { ACCENT, FS, ICON_SIZE, INK_LOW } from './shared-sx';
import { getAiTouchMs, useAiTouch, useButtonSimState, type AiTouchView, type ButtonSimPhase } from './button-sim-state';
import { aiSimPhaseSx, aiTouchSx } from './rv-command-view';
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
 *
 * A `deprecated` field is never editable either: it only reaches a row when the
 * document carries a value, and the row exists to EXPLAIN that value, not to
 * invite the user to tune a field nothing reads. This is display only — the
 * overlay/MCP write guards read `isFieldDisplayReadonly`, so a migration tool
 * can still clear the value.
 */
export function isFieldEditable(
  status: FieldStatus,
  isReference: boolean,
  descriptor?: FieldDescriptor,
  isSignalRef = false,
): boolean {
  return status === 'consumed'
    && (!isReference || isSignalRef)
    && descriptor?.deprecated !== true
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
  /** Registry path of the node carrying this field — a reference resolves relative to its asset (plan-757 F7). */
  nodePath?: string;
  /**
   * plan-512 F8: this number field is the scale field of a bound slot and the
   * unit logic has something to say about it (auto / manual / conflict /
   * mismatch / unknown / not-effective / not-applied). Rendered as a badge
   * after the label; it coexists with the override dot in the gutter (a manual
   * value IS an override). Absent → today's rendering, unchanged.
   */
  derived?: FieldRowDerived;
  /**
   * Choreography key of this row ({@link inspectorFieldKey}). Set → the row is
   * addressable as `data-rv-button-id`, so an MCP field write hovers/presses it
   * like a button and leaves the AI afterglow on it. Absent → no AI visuals.
   */
  aiKey?: string;
}

/** Row sx for the AI choreography: hover/press while the write is on its way, then the afterglow. */
export function fieldRowAiSx(phase: ButtonSimPhase | null, touch: AiTouchView): Record<string, unknown> {
  return phase === 'hover' || phase === 'pressed' ? aiSimPhaseSx(phase) : aiTouchSx(touch, getAiTouchMs());
}

/** The unit badge of a scale field (plan-512) — status kind, tooltip, reset action. */
export interface FieldRowDerived {
  status: { kind: 'auto' | 'manual' | 'conflict' | 'mismatch' | 'unknown' | 'not-effective' | 'not-applied' };
  tooltip: string;
  onResetToAuto?: () => void;
}

function UnitScaleBadge({ fieldName, derived }: { fieldName: string; derived: FieldRowDerived }) {
  const kind = derived.status.kind;
  const icon = kind === 'auto'
    ? <LinkIcon sx={{ fontSize: ICON_SIZE.sm }} />
    : kind === 'manual'
      ? <LinkOff sx={{ fontSize: ICON_SIZE.sm }} />
      : <WarningAmber sx={{ fontSize: ICON_SIZE.sm }} />;
  const color = kind === 'auto' ? 'info.main' : 'warning.main';
  const common = {
    'data-testid': 'unit-scale-badge',
    'data-unit-status': kind,
    title: derived.tooltip,
    'aria-label': `${fieldName} unit scale: ${kind}`,
  };
  if (kind === 'manual' && derived.onResetToAuto) {
    const reset = derived.onResetToAuto;
    return (
      <IconButton
        {...common}
        size="small"
        onClick={(e) => { e.stopPropagation(); reset(); }}
        sx={{ ml: 0.5, width: HIT_MIN, height: HIT_MIN, p: 0, color }}
      >
        {icon}
      </IconButton>
    );
  }
  return (
    <Box component="span" {...common} sx={{ ml: 0.5, display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', color }}>
      {icon}
    </Box>
  );
}

export function FieldRow({ fieldName, value, status, isOverridden, onEdit, onReset, viewer, signalStore, descriptor, unit, nodePath, derived, aiKey }: FieldRowProps) {
  const aiPhase = useButtonSimState(aiKey ?? '');
  const aiTouch = useAiTouch(aiKey ?? '');
  // The schema knows the type; the value-based guess is only for fields the
  // schema does not describe. Before this, every enum outside the small
  // name-keyed ENUM_FIELDS list (RibbonRoller.Axis, RibbonSide, SpinMode, ...)
  // rendered as a free text box although rv-odt.json declares its choices.
  const schemaEnum = descriptor?.type === 'enum' && descriptor.enumMap
    ? Object.keys(descriptor.enumMap)
    : undefined;
  const fieldType = schemaEnum ? 'enum' : inferFieldType(fieldName, value);
  const isReference = fieldType === 'reference' || fieldType === 'scriptableobject';
  // References are always read-only (structural links, not user-editable values);
  // a readonly schema descriptor also forces read-only display.
  const isEditable = isFieldEditable(status, isReference, descriptor);
  // DES-only config: shown read-only with a "(DES)" tag so the user knows the
  // value is consumed by the discrete-event scheduler, not the live view.
  const isDes = descriptor?.scope === 'des';
  // Deprecated config: the field survives in the schema so an older document
  // still loads, but nothing reads it. It only reaches a row at all when the
  // document carries a value (see `isDeprecatedFieldHidden`), and then the tag
  // is the whole point — it explains why the value is ignored.
  const isDeprecated = descriptor?.deprecated === true;

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
      {derived && <UnitScaleBadge fieldName={fieldName} derived={derived} />}
      {isDes && (
        <Box
          component="span"
          sx={{ ml: 0.5, fontSize: FS.label, color: INK_LOW, fontStyle: 'italic' }}
        >
          (DES)
        </Box>
      )}
      {isDeprecated && (
        <Box
          component="span"
          sx={{ ml: 0.5, fontSize: FS.label, color: INK_LOW, fontStyle: 'italic' }}
        >
          (deprecated)
        </Box>
      )}
    </>
  );

  return (
    <InspectorRow
      label={labelNode}
      dataAttrs={aiKey ? { 'data-rv-button-id': aiKey, ...(aiPhase ? { 'data-rv-sim-phase': aiPhase } : {}) } : undefined}
      sx={aiKey ? fieldRowAiSx(aiPhase, aiTouch) : undefined}
      labelTitle={
        isDeprecated
          ? `${fieldName} — deprecated: the value is kept in the document but nothing reads it`
          : isDes ? `${fieldName} — DES-only config (read-only in live view)` : fieldName
      }
      labelColor={isEditable || isReference ? 'text.primary' : INK_LOW}
      fullWidthField={fullWidthField}
      alignField={isReference ? 'end' : 'stretch'}
      opacity={isEditable || isReference ? 1 : (status === 'consumed' ? 1 : 0.5)}
      rowTooltip={tooltipText}
      dot={isOverridden ? (
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          sx={{ width: HIT_MIN, height: HIT_MIN, p: 0, color: ACCENT }}
          title="Reset to default"
          aria-label={`reset ${fieldName} to default`}
        >
          <Circle sx={{ fontSize: ICON_SIZE.dot }} />
        </IconButton>
      ) : undefined}
    >
      {isComponentRef(value) ? (
        <ReferenceDisplay value={value} viewer={viewer} signalStore={signalStore} ownerPath={nodePath} />
      ) : isScriptableObject(value) ? (
        <ScriptableObjectDisplay value={value as Record<string, unknown>} />
      ) : isEditable ? (
        <FieldEditor value={value} onChange={onEdit} fieldType={fieldType} fieldName={fieldName} editable unit={unit} options={schemaEnum} />
      ) : (
        <Typography
          sx={{
            fontSize: FS.label,
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
