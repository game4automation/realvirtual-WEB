// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-section.tsx — Collapsible component section for the Property Inspector.
 *
 * Groups fields by component type (Drive, Sensor, etc.) with a colored header,
 * consumedOnly filter support, and per-component reset.
 */

import { useState, useMemo, useCallback, useEffect, useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  Box,
  Typography,
  Tooltip,
  Button,
} from '@mui/material';
import { ExpandMore, ChevronRight } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import { getConsumedFields } from '../engine/rv-extras-validator';
import { getFieldDescriptor, getSignalSlotFields, isFieldDisplayReadonly, isSignalSlotField } from '../engine/rv-component-registry';
import {
  ComponentSignalSlots,
  isPLCSignalComponent,
  PLCSignalSlot,
} from '../../plugins/signal-bind/InlineSignalSlots';
import { PLCSignalSections } from './rv-plc-signal-inspector';
import { useUnitScaleBadges } from '../../plugins/signal-bind/unit-scale-badge';
import { signalTypeBadgeColor } from './signal-colors';
import {
  baseComponentType,
  classifyField,
  componentColor,
  formatDisplayValue,
  getFieldUnit,
  getSignalHeaderColor,
  inferFieldType,
  isComponentRef,
  isScriptableObject,
  isDeprecatedFieldHidden,
  isFieldHidden,
  isSignalComponentType,
  signalTypeLabel,
} from './rv-inspector-helpers';
import { flattenObjectFields } from './rv-field-editors';
import { FieldRow } from './rv-field-row';
import { ReferencePickerRow } from './ReferencePickerRow';
import { pickableReferenceFields } from './rv-reference-field';
import { getActiveAssetContext, getActiveAssetVersion, subscribeActiveAsset } from '../editor/active-asset-store';
import { InspectorRow } from './rv-inspector-row';
import { fieldRendererRegistry } from './rv-field-renderer-registry';
import { componentActionRegistry, type ComponentAction, type ComponentActionContext } from './rv-component-action-registry';
import { aiTouchSx, useCommandView } from './rv-command-view';
import { getAiTouchMs } from './button-sim-state';
import { inspectorFieldKey, useInspectorFieldReveal } from './inspector-field-touch';
import { ACCENT, FS, ICON_SIZE, INK_HIGH, INK_LOW, INK_MID, MONO, ON_ACCENT, ROW_HOVER } from './shared-sx';
import { InspectorActionRow, InspectorSectionMenu, inspectorActionButtonSx, inspectorSegmentedGroupSx, segmentActions } from './rv-inspector-blocks';

// ── Expand state persistence (default: expanded) ────────────────────────

const LS_KEY_COLLAPSED = 'rv-inspector-collapsed';
const LS_KEY_SECTION_COLLAPSED = 'rv-inspector-section-collapsed';
const HIT_MIN = 24;

/** Module-level caches to avoid re-parsing localStorage on every toggle. */
let _collapsedCache: Set<string> | null = null;
let _sectionCollapsedCache: Set<string> | null = null;

function loadSet(storageKey: string, cacheRef: 'other' | 'section'): Set<string> {
  if (cacheRef === 'other' && _collapsedCache) return _collapsedCache;
  if (cacheRef === 'section' && _sectionCollapsedCache) return _sectionCollapsedCache;
  let set: Set<string>;
  try {
    const raw = localStorage.getItem(storageKey);
    set = raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    set = new Set();
  }
  if (cacheRef === 'other') _collapsedCache = set;
  else _sectionCollapsedCache = set;
  return set;
}

function persistSet(storageKey: string, set: Set<string>): void {
  localStorage.setItem(storageKey, JSON.stringify([...set]));
}

function loadCollapsedSet(): Set<string> {
  return loadSet(LS_KEY_COLLAPSED, 'other');
}

function persistCollapsed(key: string, collapsed: boolean): void {
  const set = loadCollapsedSet();
  if (collapsed) set.add(key); else set.delete(key);
  persistSet(LS_KEY_COLLAPSED, set);
}

function loadSectionCollapsedSet(): Set<string> {
  return loadSet(LS_KEY_SECTION_COLLAPSED, 'section');
}

function persistSectionCollapsed(key: string, collapsed: boolean): void {
  const set = loadSectionCollapsedSet();
  if (collapsed) set.add(key); else set.delete(key);
  persistSet(LS_KEY_SECTION_COLLAPSED, set);
}

/** Stable empty-actions array — shared by every section without registered actions. */
const EMPTY_ACTIONS: readonly import('./rv-component-action-registry').ComponentAction[] = Object.freeze([]);

// ── Opt-in fields shown with their default (plan-577) ───────────────────

/**
 * Opt-in fields added to a component AFTER documents were written. The
 * inspector otherwise renders only stored keys, so an existing `MU` (`{}`) or
 * `GripTarget` would never offer them; these appear with their schema default
 * until the user sets them.
 */
const SEEDED_DEFAULT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  MU: ['LoadSeatDepth'],
  GripTarget: ['LoadOnCarrier'],
};

/** `data` plus the schema default of every seeded field it does not store (same object when nothing is missing). */
export function withSeededDefaults(componentType: string, data: Record<string, unknown>): Record<string, unknown> {
  const seeded = SEEDED_DEFAULT_FIELDS[componentType];
  if (!seeded) return data;
  let out: Record<string, unknown> | null = null;
  for (const field of seeded) {
    if (field in data) continue;
    const def = getFieldDescriptor(componentType, field)?.default;
    if (def === undefined) continue;
    out ??= { ...data };
    out[field] = def;
  }
  return out ?? data;
}

// ── Read-only live row spec ──────────────────────────────────────────────

/**
 * A pre-formatted read-only row for the `readOnlyLive` ComponentSection mode.
 * A virtual-component field whose value is one of these renders its `display`
 * string verbatim with an optional accent `color` and an optional `onClick`
 * (used by the Snap "Paired with" row to navigate to the partner component).
 * Any non-spec field value is formatted through `formatDisplayValue`.
 */
export interface RuntimeRowSpec {
  /** Marks the value as a pre-formatted read-only row (vs. a raw data field). */
  readonly __runtimeRow: true;
  /** Already-formatted display text. */
  display: string;
  /** Optional accent color for the value (e.g. amber for "Occupied"). */
  color?: string;
  /** Optional click handler — renders the value as a clickable link. */
  onClick?: () => void;
}

export function runtimeRow(display: string, opts?: { color?: string; onClick?: () => void }): RuntimeRowSpec {
  return { __runtimeRow: true, display, color: opts?.color, onClick: opts?.onClick };
}

export function isRuntimeRow(value: unknown): value is RuntimeRowSpec {
  return typeof value === 'object' && value !== null && (value as RuntimeRowSpec).__runtimeRow === true;
}

function activateOnKey(handler: () => void) {
  return (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handler();
    }
  };
}

/** A single read-only label/value row for the `readOnlyLive` mode — same
 *  visual language as the editable field rows, but never an editor. Resolves
 *  a {@link RuntimeRowSpec} (color + clickable navigation) or a raw value. */
function ReadOnlyLiveRow({ fieldName, value }: { fieldName: string; value: unknown }) {
  const spec = isRuntimeRow(value) ? value : null;
  const text = spec ? spec.display : formatDisplayValue(value);
  const clickable = !!spec?.onClick;
  return (
    <InspectorRow
      label={fieldName}
      labelTitle={fieldName}
      labelColor={INK_LOW}
      minHeight={HIT_MIN}
      py={0.15}
    >
      <Typography
        onClick={spec?.onClick}
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        onKeyDown={clickable ? activateOnKey(() => spec?.onClick?.()) : undefined}
        sx={{
          fontSize: FS.label,
          fontFamily: MONO,
          color: spec?.color ?? 'text.primary',
          fontWeight: spec?.color ? 600 : 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...(clickable ? {
            display: 'flex',
            alignItems: 'center',
            minWidth: HIT_MIN,
            minHeight: HIT_MIN,
            cursor: 'pointer',
            '&:hover': { textDecoration: 'underline' },
            '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1, borderRadius: 0.5 },
          } : {}),
        }}
      >
        {text}
      </Typography>
    </InspectorRow>
  );
}

// ── ComponentSection ─────────────────────────────────────────────────────

export interface ComponentSectionProps {
  nodePath: string;
  componentType: string;
  data: Record<string, unknown>;
  overriddenFields: Set<string>;
  consumedOnly: boolean;
  signalValue?: string | null;
  /** Optional action element rendered in the component header (e.g. "Open AAS" button). */
  headerAction?: React.ReactNode;
  /** Optional extra content rendered inside the expanded card, below the field rows (e.g. BehaviorLiveStateSections). */
  extraContent?: React.ReactNode;
  /**
   * Read-only live mode: render ALL `data` fields as visible read-only rows
   * under the normal collapsible header — no editors, no overlay, no
   * consumed/other split, no "N more fields" collapse, no signal short-circuit.
   * Used for ephemeral virtual components (live behavior state, snap data) that
   * flow through the SAME header/collapse/color pipeline as a real component.
   */
  readOnlyLive?: boolean;
  onFieldEdit: (fieldName: string, value: unknown) => void;
  onFieldReset: (fieldName: string) => void;
  onResetComponent: () => void;
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
}

export function ComponentSection({ nodePath, componentType, data, overriddenFields, consumedOnly, signalValue, headerAction, extraContent, readOnlyLive, onFieldEdit, onFieldReset, onResetComponent, viewer, signalStore }: ComponentSectionProps) {
  // A PLCInput/PLCOutput section header is a pure TYPE badge — it names the
  // direction while no value is in play, so the hue stays but the intensity is
  // always `weak` (plan-341 §2.8 b). Every other component keeps its type colour.
  const color = isSignalComponentType(componentType)
    ? signalTypeBadgeColor(componentType)
    : componentColor(componentType);
  const base = baseComponentType(componentType);
  const expandKey = `${nodePath}:${componentType}`;
  const [showOther, setShowOther] = useState(() => !loadCollapsedSet().has(expandKey));
  const [sectionExpanded, setSectionExpanded] = useState(() => !loadSectionCollapsedSet().has(expandKey));

  const toggleOther = useCallback(() => {
    setShowOther(prev => {
      const next = !prev;
      persistCollapsed(expandKey, !next);
      return next;
    });
  }, [expandKey]);

  const toggleSection = useCallback(() => {
    setSectionExpanded(prev => {
      const next = !prev;
      persistSectionCollapsed(expandKey, !next);
      return next;
    });
  }, [expandKey]);

  /**
   * Flatten entries: if a value is a non-ref, non-vector3 object/array,
   * expand it into sub-field rows (e.g. Status.Connected, Status.Value).
   * This way objects like Status render as regular grayed-out field rows.
   */
  const flattenEntries = useCallback((entries: [string, unknown][]): [string, unknown][] => {
    const result: [string, unknown][] = [];
    for (const [key, value] of entries) {
      const ft = inferFieldType(key, value);
      if (ft === 'object' && !isComponentRef(value) && !isScriptableObject(value)) {
        // Flatten object/array sub-fields into regular rows
        const flat = flattenObjectFields(value as Record<string, unknown> | unknown[], key);
        for (const f of flat) result.push([f.key, f.value]);
      } else {
        result.push([key, value]);
      }
    }
    return result;
  }, []);

  // Structural references an author can pick in the editor (a step's sensor,
  // drive or signal). Only while an asset document is being edited: there a
  // field edit is an undoable document op. Elsewhere they keep their read-only
  // ReferenceDisplay row.
  const assetVersion = useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const pickable = useMemo(
    () => (getActiveAssetContext() !== null ? pickableReferenceFields(base) : []),
    // assetVersion: re-evaluate when the editor opens or closes a document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, assetVersion],
  );
  const pickableNames = useMemo(() => new Set(pickable.map((p) => p.field)), [pickable]);

  // Separate consumed fields (editable) from non-consumed (read-only)
  const { consumedEntries, otherEntries } = useMemo(() => {
    const consumed = new Set(getConsumedFields(base));
    const consumedRaw: [string, unknown][] = [];
    const otherRaw: [string, unknown][] = [];

    for (const [key, value] of Object.entries(withSeededDefaults(base, data))) {
      if (key.startsWith('_')) continue;
      if (isFieldHidden(base, key)) continue;
      // Rendering-precedence contract (plan-325 S3/S4): signal-slot keys are
      // removed from the generic FieldRow pipeline ENTIRELY — SignalSlotRow is
      // their only render path (also for value === null/undefined, where
      // inferFieldType would misclassify them as 'string' and open an editor).
      if (isSignalSlotField(base, key)) continue;
      // A pickable reference has its own row below (ReferencePickerRow).
      if (pickableNames.has(key)) continue;
      // A DEPRECATED field drives nothing. While it is empty it gets no row at
      // all; once a document actually carries a value it is shown read-only with
      // a "(deprecated)" tag (added by FieldRow), so the user can see why the
      // value has no effect instead of being offered an editor for a dead field.
      const descriptor = getFieldDescriptor(base, key);
      if (isDeprecatedFieldHidden(descriptor, value)) continue;
      // A read-only schema field (readonly:true OR scope:'des') renders its value
      // but never an editor → route it into the read-only ("other") branch rather
      // than the consumed/editable one. The "(DES)" tag is added by FieldRow.
      const isReadonly = isFieldDisplayReadonly(descriptor) || descriptor?.deprecated === true;
      if (consumed.has(key) && !isReadonly) {
        consumedRaw.push([key, value]);
      } else {
        otherRaw.push([key, value]);
      }
    }

    // Consumed entries keep objects as-is (editable ObjectEditor handles them)
    // Other entries flatten objects into sub-field rows
    return { consumedEntries: consumedRaw, otherEntries: flattenEntries(otherRaw) };
  }, [base, data, flattenEntries, pickableNames]);

  // An MCP field write (web_editor_set_field / web_component_set) asks for its
  // row to be visible before the AI "clicks" it: open this section — and the
  // "more fields" block when the field lives there — without persisting, so the
  // user's own collapse preference survives the next selection.
  const aiReveal = useInspectorFieldReveal();
  useEffect(() => {
    if (!aiReveal || readOnlyLive || aiReveal.path !== nodePath || aiReveal.componentType !== componentType) return;
    setSectionExpanded(true);
    const f = aiReveal.fieldName;
    if (otherEntries.some(([k]) => k === f || k.startsWith(`${f}.`))) setShowOther(true);
    // Only a NEW request reveals; a data change must not re-open what the user closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiReveal?.seq]);
  const aiKeyOf = (fieldName: string): string | undefined =>
    !readOnlyLive && nodePath ? inspectorFieldKey(nodePath, componentType, fieldName) : undefined;

  // Action buttons contributed by plugins for this component type. Re-resolved
  // on every render — the registry is small and lookups are O(1); this keeps
  // visibility/isActive snappy without a separate tick-mechanism.
  const actions = useMemo(() => {
    // Look up by both the literal componentType (e.g. "ReplayRecording_1")
    // and its stripped base (e.g. "ReplayRecording") so plugins can register
    // against either form. Concrete-first lets a per-instance override beat
    // a generic base registration, should we ever ship one.
    const concrete = componentActionRegistry.get(componentType);
    const baseList = base !== componentType ? componentActionRegistry.get(base) : EMPTY_ACTIONS;
    return [...concrete, ...baseList];
  }, [componentType, base]);
  // plan-510 fix: operations stay in the body, component management goes into
  // the header's ⋮ menu (placement 'menu').
  const bodyActions = useMemo(() => actions.filter((a) => a.placement !== 'menu'), [actions]);
  const menuActions = useMemo(() => actions.filter((a) => a.placement === 'menu'), [actions]);

  // Re-evaluation tick — `isActive` reads from `node.userData`, which the
  // action mutates synchronously. React doesn't see that change on its own
  // (no state subscription), so we bump a local counter on every click to
  // force isActive() to re-run for the icon's active/outlined style.
  // Re-render is local to this section.
  const [actionTick, setActionTick] = useState(0);

  const actionCtx = useMemo<ComponentActionContext | null>(() => {
    if (!viewer || actions.length === 0) return null;
    const node = viewer.registry?.getNode(nodePath);
    if (!node) return null;
    return { node, nodePath, viewer, componentData: data, componentType };
    // actionTick is intentionally in deps so the ctx identity changes on
    // click — drives the actions.map() loop to re-evaluate isActive().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, nodePath, data, actions.length, actionTick]);

  // plan-512 F8: badges on the scale fields of bound slots — from the same
  // evaluator as the Problems entries. Empty for virtual/live sections.
  const unitBadges = useUnitScaleBadges(readOnlyLive ? null : viewer, nodePath, componentType, data);

  // ── Read-only live short-circuit ──
  // A virtual component (live behavior state, snap data) renders ALL its data
  // fields as visible read-only rows under the NORMAL collapsible header. No
  // editor, no overlay, no consumed/other split, no "N more fields" collapse,
  // no signal short-circuit. Same header / collapse / color as a real section.
  if (readOnlyLive) {
    const entries = Object.entries(data).filter(([k]) => !k.startsWith('_'));
    return (
      <Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            px: 1,
            py: 0.375,
            bgcolor: color + '11',
            borderBottom: `1px solid ${color}22`,
            borderTop: `1px solid ${color}22`,
          }}
        >
          <Box
            onClick={toggleSection}
            role="button"
            tabIndex={0}
            aria-expanded={sectionExpanded}
            onKeyDown={activateOnKey(toggleSection)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              minHeight: HIT_MIN,
              cursor: 'pointer',
              userSelect: 'none',
              '&:hover .rv-comp-title': { textDecoration: 'underline' },
              '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1, borderRadius: 0.5 },
            }}
          >
            {sectionExpanded
              ? <ExpandMore sx={{ fontSize: ICON_SIZE.sm, color: color }} />
              : <ChevronRight sx={{ fontSize: ICON_SIZE.sm, color: color }} />}
            <Typography
              className="rv-comp-title"
              sx={{ fontSize: FS.label, fontWeight: 700, color: color, letterSpacing: 0.5, textTransform: 'uppercase' }}
            >
              {componentType}
            </Typography>
          </Box>
          {signalValue != null && (
            <Typography sx={{ fontSize: FS.label, fontWeight: 600, fontFamily: MONO, ml: 'auto', color: getSignalHeaderColor(componentType, String(signalValue)) }}>
              {signalValue}
            </Typography>
          )}
          {headerAction}
        </Box>
        {sectionExpanded && entries.map(([fieldName, value]) => (
          <ReadOnlyLiveRow key={fieldName} fieldName={fieldName} value={value} />
        ))}
        {sectionExpanded && extraContent}
      </Box>
    );
  }

  // ── Signal short-circuit (plan-200 B2) ──
  // A PLC signal node renders a clean card: a friendly header + the full dotted
  // SYMBOL name + a single Value row. No "Name" row, no collapsed "Status.Value",
  // no "N more fields" clutter.
  if (isSignalComponentType(componentType)) {
    const symbol = typeof data.Name === 'string' ? data.Name : (nodePath.split('/').pop() ?? nodePath);
    const valueText = signalValue ?? '—';
    const valueColor = getSignalHeaderColor(componentType, String(valueText));
    // Unity's `Signal.Comment` — the one line of prose that says what a tag is
    // FOR. It already travels in rv_extras and is already indexed on the store
    // (rv-signal-construction registerSignal), and the badge tooltip and the
    // picker have shown it for a while; this card was the surface that dropped
    // it (plan-425 F1). Read through the SAME store metadata the other surfaces
    // read — a second pipeline straight out of `userData.realvirtual` would be
    // free to disagree with them. Absent comment renders NO row, so the card
    // does not grow an empty line for the majority of signals that have none.
    const comment = signalStore?.getSignalMeta(symbol)?.comment;
    return (
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.375, bgcolor: color + '11', borderBottom: `1px solid ${color}22`, borderTop: `1px solid ${color}22` }}>
          <Typography sx={{ fontSize: FS.label, fontWeight: 700, color, letterSpacing: 0.5, textTransform: 'uppercase' }}>
            {`Signal (${signalTypeLabel(componentType)})`}
          </Typography>
          <Typography sx={{ fontSize: FS.label, fontWeight: 600, fontFamily: MONO, ml: 'auto', color: valueColor }}>
            {valueText}
          </Typography>
          {headerAction}
        </Box>
        {/* plan-514: the card's rows are InspectorRows — the same value column
            as every other section (no private 64 px label width). */}
        <InspectorRow label="Symbol" labelColor={INK_LOW} py={0.15}>
          <Tooltip title={symbol} placement="top">
            <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: INK_MID, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{symbol}</Typography>
          </Tooltip>
        </InspectorRow>
        <InspectorRow label="Value" labelColor={INK_LOW} py={0.15}>
          <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: valueColor, fontWeight: 500 }}>{valueText}</Typography>
        </InspectorRow>
        {comment && (
          <InspectorRow label="Comment" labelColor={INK_LOW} py={0.15}>
            <Typography sx={{ fontSize: FS.label, color: INK_MID, minWidth: 0, overflowWrap: 'anywhere' }}>{comment}</Typography>
          </InspectorRow>
        )}
        {extraContent}
      </Box>
    );
  }

  const actionCtxForBody = actionCtx;
  // One body action button (plan-510 fix: extracted so segment groups can share it).
  const renderBodyAction = (action: ComponentAction) => {
    const actionCtx = actionCtxForBody!;
    // plan-499: a command view renders through the command (reason,
    // afterglow, one execute per click) — see CommandActionButton.
    if (action.command) {
        return (
          <CommandActionButton
            key={action.id}
            action={action}
            ctx={actionCtx}
            onAfterClick={() => setActionTick(t => t + 1)}
          />
        );
      }
      const active = action.isActive ? action.isActive(actionCtx) : false;
      const Icon = action.icon;
      const button = (
        <Button
          key={action.id}
          size="small"
          // Explicit `color` overrides the theme primary — used by
          // axis-coded buttons (Splat Invert X/Y/Z = red/green/blue
          // to match Three.js axis convention). Falls back to MUI's
          // theme primary when not specified.
          color={action.color ? undefined : 'primary'}
          variant={active ? 'contained' : 'outlined'}
          onClick={() => {
            action.onClick(actionCtx);
            // Immediately re-evaluate isActive — the action mutated
            // userData synchronously, but React has no way to notice
            // without our nudge.
            setActionTick(t => t + 1);
          }}
          startIcon={Icon ? <Icon sx={{ fontSize: ICON_SIZE.sm }} /> : undefined}
          sx={{
            ...inspectorActionButtonSx,
            // Custom color path — overrides MUI's color prop. Active
            // = filled (contained), inactive = outlined; hover
            // brightens proportionally.
            ...(action.color ? {
              color: active ? ON_ACCENT : action.color,
              bgcolor: active ? action.color : 'transparent',
              borderColor: action.color,
              '&:hover': {
                bgcolor: active ? action.color : action.color + '22',
                borderColor: action.color,
              },
            } : {}),
          }}
        >
          {typeof action.label === 'function' ? action.label(actionCtx) : action.label ?? action.id}
        </Button>
      );
      return action.tooltip
        ? <Tooltip key={action.id} title={action.tooltip} placement="top">{button}</Tooltip>
        : button;
  };

  return (
    <Box>
      {/* Component type header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.375,
          bgcolor: color + '11',
          borderBottom: `1px solid ${color}22`,
          borderTop: `1px solid ${color}22`,
        }}
      >
        <Box
          onClick={toggleSection}
          role="button"
          tabIndex={0}
          aria-expanded={sectionExpanded}
          onKeyDown={activateOnKey(toggleSection)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            minHeight: HIT_MIN,
            cursor: 'pointer',
            userSelect: 'none',
            '&:hover .rv-comp-title': { textDecoration: 'underline' },
            '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1, borderRadius: 0.5 },
          }}
        >
          {sectionExpanded
            ? <ExpandMore sx={{ fontSize: ICON_SIZE.sm, color: color }} />
            : <ChevronRight sx={{ fontSize: ICON_SIZE.sm, color: color }} />}
          <Typography
            className="rv-comp-title"
            sx={{
              fontSize: FS.label,
              fontWeight: 700,
              color: color,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {componentType}
          </Typography>
        </Box>
        {signalValue != null && (
          <Typography
            sx={{
              fontSize: FS.label,
              fontWeight: 600,
              fontFamily: MONO,
              ml: 'auto',
              color: getSignalHeaderColor(componentType, String(signalValue)),
            }}
          >
            {signalValue}
          </Typography>
        )}
        {headerAction}
        {menuActions.length > 0 && actionCtx && (
          <Box sx={{ ml: signalValue == null && overriddenFields.size === 0 ? 'auto' : 0, order: 1 }}>
            <InspectorSectionMenu
              actions={menuActions}
              ctx={actionCtx}
              onAfterClick={() => setActionTick(t => t + 1)}
            />
          </Box>
        )}
        {overriddenFields.size > 0 && (
          <Tooltip title="Click to reset all overrides for this component" placement="top">
            <Typography
              onClick={(e) => { e.stopPropagation(); onResetComponent(); }}
              role="button"
              tabIndex={0}
              aria-label={`Reset ${overriddenFields.size} override${overriddenFields.size !== 1 ? 's' : ''} for ${componentType}`}
              onKeyDown={activateOnKey(onResetComponent)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                minHeight: HIT_MIN,
                fontSize: FS.label,
                color: ACCENT,
                ml: 'auto',
                cursor: 'pointer',
                '&:hover': { color: INK_HIGH, textDecoration: 'underline' },
                '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: 1, borderRadius: 0.5 },
              }}
            >
              {overriddenFields.size} override{overriddenFields.size !== 1 ? 's' : ''}
            </Typography>
          </Tooltip>
        )}
      </Box>

      {sectionExpanded && (
      // Padded body — adds breathing room before the first field (after the
      // header) and after the last field (before the next component section).
      <Box sx={{ py: 1 }}>
      {/* Consumed (editable) fields */}
      {consumedEntries.map(([fieldName, value]) => {
        // Check for a custom field renderer plugin
        const CustomRenderer = fieldRendererRegistry.getRenderer(componentType, fieldName);
        if (CustomRenderer) {
          // The custom renderer spans the full section-body width and aligns its
          // own title/rows to the inspector's label/value columns internally.
          return (
            <CustomRenderer
              key={fieldName}
              value={value}
              fieldName={fieldName}
              componentType={componentType}
              nodePath={nodePath}
              viewer={viewer}
              signalStore={signalStore}
            />
          );
        }
        return (
          <FieldRow
            key={fieldName}
            fieldName={fieldName}
            value={value}
            status="consumed"
            isOverridden={overriddenFields.has(fieldName)}
            onEdit={(v) => onFieldEdit(fieldName, v)}
            onReset={() => onFieldReset(fieldName)}
            viewer={viewer}
            signalStore={signalStore}
            descriptor={getFieldDescriptor(base, fieldName)}
            unit={getFieldUnit(base, fieldName, data)}
            nodePath={nodePath}
            derived={unitBadges.get(fieldName)}
            aiKey={aiKeyOf(fieldName)}
          />
        );
      })}

      {/* Inline signal-slot rows (plan-325): EVERY componentRef+signal schema
          field renders as a SignalSlotRow — also when the GLB has no value.
          The keys were removed from the FieldRow pipeline above; binding runs
          through SignalBindingManager + persistence, never onFieldEdit. */}
      {pickable.map(({ field, target }) => (
        <ReferencePickerRow
          key={`ref:${field}`}
          fieldName={field}
          value={data[field]}
          target={target}
          viewer={viewer}
          nodePath={nodePath}
          onEdit={(v) => onFieldEdit(field, v)}
        />
      ))}

      {getSignalSlotFields(base).length > 0 && (
        <ComponentSignalSlots
          viewer={viewer}
          signalStore={signalStore}
          nodePath={nodePath}
          componentType={componentType}
          data={data}
        />
      )}

      {/* plan-418 F6: a raw PLC signal node (PLCInput… / PLCOutput…) IS the
          signal, so its section gets the ONE synthetic `Value` bind row — same row component,
          same persistence, and the only surface that also explains a
          fail-closed slot (duplicate name / unregistered signal). */}
      {isPLCSignalComponent(base) && (
        <PLCSignalSlot
          viewer={viewer}
          nodePath={nodePath}
          componentType={componentType}
        />
      )}

      {/* plan-589 F3/F4: the symbol's own editor ("Signal") and where it is bound in the plant
          ("PLC binding"). Below the bind row on purpose — what the signal IS, then who reads it in
          the model, then which gateway address it carries. */}
      {isPLCSignalComponent(base) && (
        <PLCSignalSections
          viewer={viewer}
          nodePath={nodePath}
          componentType={componentType}
          data={data}
          onFieldEdit={onFieldEdit}
        />
      )}

      {/* Action buttons contributed by plugins (e.g. Splat Invert X/Y/Z,
          Drive Jog, Sensor Reset). Rendered between consumed fields and the
          collapsible "other fields" section so they sit visually with the
          editable area, not with the diagnostic dump.
          Styling: theme primary accent — intentionally NOT the component's
          own color, so the buttons read consistently across all sections and
          stand out from the section's text/header tint.
          Layout (plan-510): InspectorActionRow — a pure layout wrapper that
          starts the buttons on the value column's edge; the buttons and
          their action logic are unchanged. Consecutive actions sharing a
          `group` render as ONE segmented control (Jog − | Stop | Jog +);
          `placement: 'menu'` actions live in the header's ⋮ menu instead. */}
      {bodyActions.length > 0 && actionCtx && (
        <InspectorActionRow data-testid="rv-component-actions">
          {segmentActions(bodyActions.filter((a) => !a.visible || a.visible(actionCtx))).map((segment) => {
            const rendered = segment.items.map((action) => renderBodyAction(action));
            return segment.group
              ? (
                <Box key={`group-${segment.group}`} data-testid={`rv-action-group-${segment.group}`} sx={inspectorSegmentedGroupSx}>
                  {rendered}
                </Box>
              )
              : rendered;
          })}
        </InspectorActionRow>
      )}

      {/* Collapsible other (read-only) fields — hidden when consumedOnly is active.
          Exception: a component with NO consumed fields at all is pure metadata (JTData,
          CADLink). For those the filter would leave an empty section behind, so their values
          stay visible — the filter exists to hide diagnostic noise next to real fields, not to
          blank out a component that has nothing else to show. */}
      {(!consumedOnly || consumedEntries.length === 0) && otherEntries.length > 0 && (
        <>
          <Box
            onClick={toggleOther}
            role="button"
            tabIndex={0}
            aria-expanded={showOther}
            onKeyDown={activateOnKey(toggleOther)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              minHeight: HIT_MIN,
              px: 1,
              py: 0.125,
              cursor: 'pointer',
              '&:hover': { bgcolor: ROW_HOVER },
              '&:focus-visible': { outline: `1px solid ${ACCENT}`, outlineOffset: -1 },
            }}
          >
            <ExpandMore sx={{
              fontSize: ICON_SIZE.xs,
              color: INK_LOW,
              transform: showOther ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
            }} />
            <Typography sx={{ fontSize: FS.label, color: INK_LOW, ml: 0.25 }}>
              {otherEntries.length} more field{otherEntries.length !== 1 ? 's' : ''}
            </Typography>
          </Box>
          {showOther && otherEntries.map(([fieldName, value]) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              value={value}
              status={classifyField(componentType, fieldName)}
              isOverridden={overriddenFields.has(fieldName)}
              onEdit={(v) => onFieldEdit(fieldName, v)}
              onReset={() => onFieldReset(fieldName)}
              viewer={viewer}
              signalStore={signalStore}
              descriptor={getFieldDescriptor(base, fieldName)}
              unit={getFieldUnit(base, fieldName, data)}
              nodePath={nodePath}
              aiKey={aiKeyOf(fieldName)}
            />
          ))}
        </>
      )}

      {extraContent}
      </Box>
      )}
    </Box>
  );
}

// ── Command-view action (plan-499) ───────────────────────────────────────

/**
 * An inspector action that is a VIEW of a command (`ComponentAction.command`):
 * disabled + tooltip = the command's `enabled()` reason (the same text an MCP
 * tool bound to that command returns as `{error}`), the MCP choreography's
 * hover/press and the AI afterglow land on this button, and a click is ONE
 * `execute(..., {origin:'ui'})` — never `action.onClick` as well.
 */
function CommandActionButton({ action, ctx, onAfterClick }: {
  action: ComponentAction;
  ctx: ComponentActionContext;
  onAfterClick: () => void;
}) {
  const cmd = action.command!;
  const view = useCommandView({
    id: cmd.id,
    args: () => cmd.args(ctx),
    viewer: ctx.viewer,
    ...(cmd.buttonKey ? { buttonKey: cmd.buttonKey } : {}),
  });
  const active = action.isActive ? action.isActive(ctx) : false;
  const Icon = action.icon;
  const label = typeof action.label === 'function' ? action.label(ctx) : action.label ?? action.id;
  const tip = view.disabled ? (view.reason ?? action.tooltip ?? '') : (action.tooltip ?? '');
  const button = (
    <Button
      size="small"
      color={action.color ? undefined : 'primary'}
      variant={active ? 'contained' : 'outlined'}
      disabled={view.disabled}
      onClick={() => { view.onClick(); onAfterClick(); }}
      startIcon={Icon ? <Icon sx={{ fontSize: ICON_SIZE.sm }} /> : undefined}
      {...view.dataAttrs}
      aria-description={view.touch ? 'Triggered by AI' : undefined}
      sx={{
        ...inspectorActionButtonSx,
        ...(view.simPhase === 'hover' || view.simPhase === 'pressed' ? { bgcolor: `${ACCENT}2e` } : null),
        ...(view.touch ? aiTouchSx(view.aiTouch, getAiTouchMs()) : null),
      }}
    >
      {label}
    </Button>
  );
  if (!tip) return button;
  // A disabled Button fires no events — the tooltip (= the reason) needs a wrapper.
  return (
    <Tooltip title={tip} placement="top">
      {view.disabled ? <span style={{ display: 'inline-flex' }}>{button}</span> : button}
    </Tooltip>
  );
}
