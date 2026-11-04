// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-row.tsx — Single field row for the Property Inspector.
 *
 * Renders a field name, override indicator, and either an editor widget,
 * a reference badge, or a read-only display value.
 */

import { Suspense, useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  Box,
  Button,
  Typography,
  IconButton,
  Tooltip,
} from '@mui/material';
import { Circle, Link as LinkIcon, LinkOff, WarningAmber } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import type { FieldDescriptor } from '../engine/rv-component-registry';
import { isFieldDisplayReadonly } from '../engine/rv-component-registry';
import {
  inferFieldType,
  isComponentRef,
  isStoredAddressRecord,
  isScriptableObject,
  formatDisplayValue,
  type FieldStatus,
} from './rv-inspector-helpers';
import { getActivePersistenceTarget } from './rv-edit-target';
import { FieldEditor, NumberEditor } from './rv-field-editors';
import { ReferenceDisplay, ScriptableObjectDisplay } from './rv-reference-display';
import { InspectorRow } from './rv-inspector-row';
import { ACCENT, ERROR, FS, ICON_SIZE, INK_LOW } from './shared-sx';
import type { FieldEditState } from './rv-extras-editor';
import { getAiTouchMs, useAiTouch, useButtonSimState, type AiTouchView, type ButtonSimPhase } from './button-sim-state';
import { aiSimPhaseSx, aiTouchSx } from './rv-command-view';
import { fieldRowActionsFor, fieldRowDecorationFor } from './rv-field-row-actions';
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
  /** Custom value editor for editable rows outside confirmation/applying states. */
  valueEditor?: ReactNode;
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
  /**
   * Concrete component key of the section (`Source`, `Drive_1`). Set → plugin field-row
   * actions (`rv-field-row-actions.ts`, e.g. "Show in planning window") may add a control
   * to the row's trailing slot. Absent → no actions.
   */
  componentType?: string;
  /** Variant apply/refusal state for this exact row. */
  editState?: FieldEditState;
  onConfirmEdit?: () => void;
  onCancelEdit?: () => void;
  /** Base reset is unavailable while edits persist to a variant. */
  resetDisabled?: boolean;
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

export function FieldRow({ fieldName, value, status, isOverridden, onEdit, onReset, viewer, signalStore, descriptor, unit, nodePath, derived, aiKey, componentType, editState, onConfirmEdit, onCancelEdit, resetDisabled = false, valueEditor }: FieldRowProps) {
  const aiPhase = useButtonSimState(aiKey ?? '');
  const aiTouch = useAiTouch(aiKey ?? '');
  const actionCtx = componentType ? { viewer, nodePath, componentType, fieldName } : null;
  const rowActions = actionCtx ? fieldRowActionsFor(actionCtx) : [];
  const actionIds = JSON.stringify(rowActions.map((action) => action.id));
  const valueActions = useMemo(
    () => componentType ? fieldRowActionsFor({ viewer, nodePath, componentType, fieldName }) : [],
    [actionIds, viewer, nodePath, componentType, fieldName],
  );
  const subscribeValue = useCallback((listener: () => void) => {
    const removers = valueActions.map((action) => action.subscribeValue?.(listener));
    return () => removers.forEach((remove) => remove?.());
  }, [valueActions]);
  // The snapshot must retain the parent's value when an action stops supplying
  // an override, even after this render selects a different effective value.
  const authoredValue = value;
  const effectiveValue = useSyncExternalStore(
    subscribeValue,
    () => {
      if (actionCtx) for (const action of rowActions) {
        const next = action.readValue?.(actionCtx);
        if (next !== undefined) return next;
      }
      return authoredValue;
    },
  );
  value = effectiveValue;
  const rowDecoration = actionCtx ? fieldRowDecorationFor(actionCtx, rowActions) : undefined;
  const trailing = rowActions.length > 0 ? (
    <Suspense fallback={null}>
      {rowActions.map((a) => (
        <a.component key={a.id} viewer={viewer} nodePath={nodePath} componentType={componentType!} fieldName={fieldName} />
      ))}
    </Suspense>
  ) : undefined;
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

  const shared = editState?.kind === 'error' && editState.code === 'shared-field';
  const [confirmBase, setConfirmBase] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const deferNumber = getActivePersistenceTarget() === 'variant' && (viewer?.simTime ?? 0) > 0;
  const editorValue = editState?.kind === 'confirm' ? editState.value : value;
  const confirmEditor = editState?.kind === 'confirm' ? (
    <Box role="alertdialog" aria-label={`Apply ${fieldName}`} sx={{ width: '100%' }}>
      <Typography sx={{ fontSize: FS.micro, color: INK_LOW }}>Applying this value resets the simulation to t = 0.</Typography>
      <Box sx={{ display: 'flex', gap: 0.5, mt: 0.25 }}>
        <Button size="small" onClick={onConfirmEdit} sx={{ minHeight: 24, px: 0.5, fontSize: FS.micro, textTransform: 'none' }}>Apply and reset</Button>
        <Button size="small" autoFocus onClick={() => { setEditorRevision(r => r + 1); onCancelEdit?.(); }} sx={{ minHeight: 24, px: 0.5, fontSize: FS.micro, textTransform: 'none' }}>Cancel</Button>
      </Box>
    </Box>
  ) : null;
  const switchBase = async () => {
    const plugin = viewer?.getPlugin('variants') as { commandRuntime(): Promise<{ activate(id: null): Promise<unknown> }> } | undefined;
    await (await plugin?.commandRuntime())?.activate(null);
    setConfirmBase(false);
  };

  return (
    <InspectorRow
      label={labelNode}
      dataAttrs={aiKey ? { 'data-rv-button-id': aiKey, ...(aiPhase ? { 'data-rv-sim-phase': aiPhase } : {}) } : undefined}
      sx={aiKey || rowDecoration
        ? { ...(aiKey ? fieldRowAiSx(aiPhase, aiTouch) : {}), ...(rowDecoration ?? {}) }
        : undefined}
      labelTitle={
        isDeprecated
          ? `${fieldName} — deprecated: the value is kept in the document but nothing reads it`
          : isDes ? `${fieldName} — DES-only config (read-only in live view)` : fieldName
      }
      labelColor={isEditable || isReference ? 'text.primary' : INK_LOW}
      fullWidthField={fullWidthField}
      trailing={trailing}
      alignField={isReference ? 'end' : 'stretch'}
      opacity={isEditable || isReference ? 1 : (status === 'consumed' ? 1 : 0.5)}
      rowTooltip={tooltipText}
      dot={isOverridden ? (resetDisabled ? (
        // A disabled button shows no title, so the reason goes on a wrapping tooltip.
        <Tooltip title="Switch to Base to reset base values">
          <span>
            <IconButton
              size="small"
              disabled
              sx={{ width: HIT_MIN, height: HIT_MIN, p: 0, color: ACCENT }}
              aria-label={`reset ${fieldName} to default`}
            >
              <Circle sx={{ fontSize: ICON_SIZE.dot }} />
            </IconButton>
          </span>
        </Tooltip>
      ) : (
        <IconButton
          size="small"
          onClick={(e) => { e.stopPropagation(); onReset(); }}
          sx={{ width: HIT_MIN, height: HIT_MIN, p: 0, color: ACCENT }}
          title="Reset to default"
          aria-label={`reset ${fieldName} to default`}
        >
          <Circle sx={{ fontSize: ICON_SIZE.dot }} />
        </IconButton>
      )) : undefined}
    >
      {editState?.kind === 'applying' ? (
        <Typography data-testid="variant-field-applying" sx={{ fontSize: FS.label, color: INK_LOW }}>
          Applying…
        </Typography>
      ) : isComponentRef(value) || isStoredAddressRecord(value) ? (
        <ReferenceDisplay
          value={value as { type: string; path?: string; address?: string; unresolvedPath?: string; componentType: string }}
          viewer={viewer} signalStore={signalStore} ownerPath={nodePath}
        />
      ) : isScriptableObject(value) ? (
        <ScriptableObjectDisplay value={value as Record<string, unknown>} />
      ) : isEditable ? (
        <Box sx={{ width: '100%', minWidth: 0 }}>
          {valueEditor !== undefined ? valueEditor : fieldType === 'number' && (deferNumber || editState?.kind === 'confirm') ? <NumberEditor
            key={`${editorRevision}:${editState?.revision ?? 0}`}
            value={editorValue as number} onChange={onEdit} liveCommit={false}
            unit={unit} min={descriptor?.min} max={descriptor?.max} step={descriptor?.step}
          /> : <FieldEditor
            key={`${editorRevision}:${editState?.revision ?? 0}`}
            value={editorValue} onChange={onEdit} fieldType={fieldType} fieldName={fieldName} editable
            unit={unit} options={schemaEnum}
            min={descriptor?.min} max={descriptor?.max} step={descriptor?.step}
          />}
          {confirmEditor}
          {editState?.kind === 'error' && (<>
            <Typography data-testid="variant-field-error" sx={{ mt: 0.25, fontSize: FS.micro, color: shared ? INK_LOW : ERROR, overflowWrap: 'anywhere' }}>
              {shared ? 'Shared by all variants. Edit in Base configuration.' : editState.reason}
            </Typography>
            {shared && <>
              <Button size="small" sx={{ minHeight: 24, px: 0.5, fontSize: FS.micro, textTransform: 'none' }} onClick={() => (viewer?.simTime ?? 0) > 0 ? setConfirmBase(true) : void switchBase()}>Switch to Base…</Button>
              {confirmBase && <Box role="alertdialog" aria-label="Switch to Base">
                <Typography>Switching to Base resets the simulation to t = 0.</Typography>
                <Button size="small" sx={{ minHeight: 24, px: 0.5, fontSize: FS.micro, textTransform: 'none' }} onClick={() => void switchBase()}>Switch and reset</Button>
                <Button size="small" sx={{ minHeight: 24, px: 0.5, fontSize: FS.micro, textTransform: 'none' }} onClick={() => setConfirmBase(false)}>Cancel</Button>
              </Box>}
            </>}
          </>)}
        </Box>
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
