// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-fmu-parameters-field-renderer.tsx — the "Parameters" / "Inputs" groups
 * of the `Fmu` component (plan-502 F7), registered on `Fmu.FmuVariables`,
 * followed by the collapsed "Package details" (plan-510).
 *
 * One `InspectorRow` per variable that may carry a start-value override
 * (`fmuOverrideAllowed`: inputs and parameters, never `calculatedParameter` or
 * `constant`; String variables are not offered — plan-498 limit), grouped
 * Parameters / Inputs, with a typed editor (number with min/max clamp,
 * checkbox, enumeration dropdown by NAME that writes the value). The label is
 * the FMI variable NAME (`g`); the description, causality and start value are
 * the label's tooltip.
 *
 * Two kinds of rows, two write paths (decision log "Edit-Semantik"):
 *  - **live-writable** (input, tunable parameter): the value IS the signal
 *    child; every editor commit writes it through a signal writer (one
 *    `SignalStore.set` per commit). Locked with a hint while
 *    `AllowViewerToFmu = false`; editable without CONNECT (standalone) with the
 *    hint that the value only reaches the FMU through CONNECT.
 *  - **restart-required** (fixed parameter): a LOCAL draft (React state) — no
 *    live write, no op per keystroke. "Save as start value" writes ONE op;
 *    the provisioning plugin restarts the instance ("applies after restart",
 *    an icon with that tooltip next to the label).
 *
 * The override state is the row's DOT (plan-510, like every other inspector
 * override): visible when an override is stored OR the value/draft differs
 * from the modelDescription start — filled = stored override, ring = only
 * changed. A click on the dot is "Reset to start value": it removes the
 * override and — for a live row — writes the start live, for a draft row
 * resets the draft. "Save as start value" is the row's trailing icon button
 * (`FmuStartOverrides[name]` through the active edit target:
 * `setFmuStartOverride` → `setField`: Undo, Dirty, draft). Stored overrides
 * that match no allowed variable are conflict rows with "Remove".
 *
 * The signal value is read with a `SignalStore.subscribe` hook on the
 * `signalStore` prop, and written through `createSignalWriter` — the same
 * primitives as `useSignal` / `useSignalWrite`, which cannot be used here: they
 * need an `RVViewerProvider` above them, and the inspector is not mounted
 * inside one.
 *
 * Self-registers on import; the import lives in `App.tsx`.
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material';
import { Circle, RestartAlt, SaveAlt } from '@mui/icons-material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { NumberEditor, BooleanEditor, EnumEditor } from './rv-field-editors';
import { getActiveEditTarget } from './rv-edit-target';
import {
  fmuOf,
  fmuOverrideAllowed,
  fmuLiveWritable,
  fmuRestartRequired,
  fmuSeedOf,
  getFmuInstances,
  normalizeFmuOverrideValue,
  subscribeFmuInstances,
  type RVFmu,
} from '../engine/rv-fmu';
import type { FmuVariableShape } from '../engine/rv-extras-validator';
import { createSignalWriter, type SignalStore, type SignalWriter } from '../engine/rv-signal-store';
import { clearFmuStartOverride, setFmuStartOverride } from '../ops/rv-fmu-ops';
import { InspectorRow } from './rv-inspector-row';
import { InspectorSubheader } from './rv-inspector-blocks';
import { formatUnit } from './rv-number-format';
import { FmuEmbedBlock } from './FmuAttachAction';
import { ACCENT, FS, ICON_SIZE, INK_LOW, INK_MID, WARN } from './shared-sx';

// ── Constants ─────────────────────────────────────────────────────────────

export const FMU_PARAMETERS_TITLE = 'Parameters';
export const FMU_INPUTS_TITLE = 'Inputs';
export const FMU_CONFLICTS_TITLE = 'Conflicts';
export const FMU_SAVE_START_LABEL = 'Save as start value';
export const FMU_RESET_START_LABEL = 'Reset to start value';
export const FMU_REMOVE_ORPHAN_LABEL = 'Remove';
export const FMU_RESTART_HINT = 'applies after restart';
export const FMU_CHANGED_HINT = 'changed — differs from start value';
export const FMU_OVERRIDE_HINT = 'start value overridden';
export const FMU_EMPTY_LABEL = 'No inputs or parameters.';
export const FMU_LOCKED_HINT = 'Writing to the FMU is disabled (AllowViewerToFmu)';
export const FMU_STANDALONE_HINT = 'Live values reach the FMU only through CONNECT';
export const FMU_RERANGE_HINT = 'Re-attach the FMU to get value ranges';

type Value = boolean | number;

// ── Helpers ───────────────────────────────────────────────────────────────

/** Variables the section offers a row for (override allowed, not String). */
export function fmuParameterRows(fmu: RVFmu): FmuVariableShape[] {
  return fmu.variables.filter((v) => fmuOverrideAllowed(v) && v.type !== 'String');
}

/** The typed value of a start string (`override ?? start`). */
function typedStart(v: FmuVariableShape, text: string | undefined): Value {
  const plc = v.type === 'Boolean' ? 'PLCInputBool' : v.type === 'Real' ? 'PLCInputFloat' : 'PLCInputInt';
  return fmuSeedOf({ ...v, start: text ?? v.start }, plc);
}

/** Extras written before plan-502 carry none of the range/enum fields. */
function isPre502(fmu: RVFmu): boolean {
  return !fmu.variables.some((v) => v.initial !== undefined || v.min !== undefined || v.max !== undefined
    || v.declaredType !== undefined || v.enumItems !== undefined);
}

function valuesEqual(a: Value | undefined, b: Value | undefined): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  return a === b;
}

function useFmuInstances(): readonly RVFmu[] {
  return useSyncExternalStore(subscribeFmuInstances, getFmuInstances, getFmuInstances);
}

const noopSubscribe = () => () => {};

/** Live value of one signal (subscribe on the store; undefined without store/name). */
function useStoreSignal(store: SignalStore | null, name: string | undefined): Value | undefined {
  const subscribe = useCallback(
    (cb: () => void) => (store && name ? store.subscribe(name, cb) : noopSubscribe()),
    [store, name],
  );
  const get = useCallback(() => (store && name ? store.get(name) : undefined), [store, name]);
  return useSyncExternalStore(subscribe, get, get);
}

/** A writer of the HMI writer kind (same as `useSignalWrite`), per store. */
function useStoreWriter(store: SignalStore | null): (name: string, v: Value) => void {
  const ref = useRef<{ store: SignalStore; writer: SignalWriter } | null>(null);
  return useCallback((name: string, v: Value) => {
    if (!store) return;
    if (ref.current?.store !== store) ref.current = { store, writer: createSignalWriter(store, 'hmi:fmu-parameters', 'hmi') };
    ref.current.writer.set(name, v);
  }, [store]);
}

// ── Editor ────────────────────────────────────────────────────────────────

function VariableEditor({ v, value, onChange, disabled }: {
  v: FmuVariableShape; value: Value; onChange: (v: Value) => void; disabled?: boolean;
}) {
  if (v.type === 'Boolean') {
    return <BooleanEditor value={value === true || value === 1} onChange={onChange} disabled={disabled} ariaLabel={v.name} />;
  }
  if (v.type === 'Enumeration' && v.enumItems && v.enumItems.length > 0) {
    const items = v.enumItems;
    const current = items.find((it) => it.value === Number(value));
    const options = items.map((it) => it.name);
    return (
      <EnumEditor
        value={current?.name ?? ''}
        options={current ? options : ['', ...options]}
        disabled={disabled}
        ariaLabel={v.name}
        onChange={(name) => {
          const it = items.find((i) => i.name === name);
          if (it) onChange(it.value);
        }}
      />
    );
  }
  const integer = v.type === 'Integer' || v.type === 'Enumeration';
  return (
    <NumberEditor
      value={Number(value)}
      unit={formatUnit(v.unit)}
      min={v.min}
      max={v.max}
      disabled={disabled}
      ariaLabel={v.name}
      onChange={(n) => onChange(integer ? Math.round(n) : n)}
    />
  );
}

// ── Row parts ─────────────────────────────────────────────────────────────

const HIT = 20;
const messageSx = { fontSize: FS.label, color: INK_LOW, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' } as const;

/** The label tooltip: description first, then the FMI facts. */
function labelTitleOf(v: FmuVariableShape, restart: boolean): string {
  return [
    v.description,
    `${v.name} · vr ${v.valueReference}`,
    `${v.causality} · ${v.variability}${v.initial ? ` · initial ${v.initial}` : ''}`,
    `start ${v.start ?? '—'}${v.declaredType ? ` · ${v.declaredType}` : ''}`,
    restart ? FMU_RESTART_HINT : undefined,
  ].filter(Boolean).join('\n');
}

function VariableLabel({ v, restart }: { v: FmuVariableShape; restart: boolean }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
      <Box component="span" data-testid={`fmu-param-label-${v.name}`}>{v.name}</Box>
      {restart && (
        <RestartAlt
          data-testid={`fmu-param-restart-hint-${v.name}`}
          aria-label={FMU_RESTART_HINT}
          titleAccess={FMU_RESTART_HINT}
          sx={{ fontSize: ICON_SIZE.xs, color: INK_LOW }}
        />
      )}
    </Box>
  );
}

/**
 * The override / deviation dot in the gutter — the reset control. Null when
 * there is nothing to reset (no stored override and the value equals the start).
 */
function ResetDot({ name, overridden, changed, onReset }: {
  name: string; overridden: boolean; changed: boolean; onReset: () => void;
}) {
  if (!overridden && !changed) return null;
  const tip = `${overridden ? FMU_OVERRIDE_HINT : FMU_CHANGED_HINT} — click: ${FMU_RESET_START_LABEL.toLowerCase()}`;
  return (
    <Tooltip title={tip} placement="left">
      <IconButton
        size="small"
        data-testid={`fmu-param-reset-${name}`}
        data-state={overridden ? 'override' : 'changed'}
        aria-label={`${FMU_RESET_START_LABEL}: ${name}`}
        onClick={(e) => { e.stopPropagation(); onReset(); }}
        sx={{ width: HIT, height: HIT, p: 0, color: ACCENT }}
      >
        {overridden ? (
          <Circle data-testid={`fmu-param-override-${name}`} sx={{ fontSize: ICON_SIZE.dot }} />
        ) : (
          <Box
            data-testid={`fmu-param-changed-${name}`}
            sx={{ width: ICON_SIZE.dot, height: ICON_SIZE.dot, borderRadius: '50%', border: `1.5px solid ${ACCENT}`, boxSizing: 'border-box' }}
          />
        )}
      </IconButton>
    </Tooltip>
  );
}

/** "Save as start value" — the row's trailing icon button; the tooltip names why it is disabled. */
function SaveStartButton({ name, disabledReason, onSave }: { name: string; disabledReason: string | null; onSave: () => void }) {
  const button = (
    <IconButton
      size="small"
      data-testid={`fmu-param-save-${name}`}
      aria-label={`${FMU_SAVE_START_LABEL}: ${name}`}
      disabled={disabledReason !== null}
      onClick={onSave}
      sx={{ width: HIT, height: HIT, p: 0, flexShrink: 0 }}
    >
      <SaveAlt sx={{ fontSize: ICON_SIZE.sm }} />
    </IconButton>
  );
  return (
    <Tooltip title={disabledReason ?? FMU_SAVE_START_LABEL} placement="top">
      {disabledReason !== null ? <span style={{ display: 'inline-flex' }}>{button}</span> : button}
    </Tooltip>
  );
}

function saveDisabledReason(available: boolean, canonical: string | null, alreadyStart: boolean): string | null {
  if (!available) return 'No editable document is open';
  if (canonical === null) return 'Value does not match type';
  if (alreadyStart) return 'Already the start value';
  return null;
}

function RowShell({ v, restart, dot, trailing, children }: {
  v: FmuVariableShape; restart: boolean; dot: ReactNode; trailing: ReactNode; children: ReactNode;
}) {
  return (
    <Box data-testid={`fmu-param-row-${v.name}`}>
      <InspectorRow
        label={<VariableLabel v={v} restart={restart} />}
        labelTitle={labelTitleOf(v, restart)}
        labelColor={INK_MID}
        dot={dot}
        trailing={trailing}
        minHeight={24}
      >
        {children}
      </InspectorRow>
    </Box>
  );
}

// ── Rows ──────────────────────────────────────────────────────────────────

/** Input / tunable parameter: the value is the live signal. */
function LiveRow({ fmu, v, nodePath, store, locked }: {
  fmu: RVFmu; v: FmuVariableShape; nodePath: string; store: SignalStore | null; locked: boolean;
}) {
  const signal = fmu.signalOf(v.name);
  const live = useStoreSignal(store, signal?.name);
  const write = useStoreWriter(store);
  const override = fmu.overrideOf(v.name);
  const effectiveStart = typedStart(v, override);
  const xmlStart = typedStart(v, undefined);
  const value = live ?? effectiveStart;
  const canonical = normalizeFmuOverrideValue(v, value);
  const target = getActiveEditTarget();

  const onChange = (next: Value): void => {
    if (locked || !signal) return;
    write(signal.name, next);
  };
  const saveStart = (): void => {
    if (canonical === null) return;
    setFmuStartOverride(getActiveEditTarget(), nodePath, v.name, canonical, fmu.FmuStartOverrides);
  };
  const resetStart = (): void => {
    clearFmuStartOverride(getActiveEditTarget(), nodePath, v.name, fmu.FmuStartOverrides);
    if (!locked && signal) write(signal.name, xmlStart);
  };

  return (
    <RowShell
      v={v}
      restart={false}
      dot={(
        <ResetDot
          name={v.name}
          overridden={override !== undefined}
          changed={!valuesEqual(value, xmlStart)}
          onReset={resetStart}
        />
      )}
      trailing={(
        <SaveStartButton
          name={v.name}
          disabledReason={saveDisabledReason(target.available, canonical, canonical === override)}
          onSave={saveStart}
        />
      )}
    >
      <VariableEditor v={v} value={value} onChange={onChange} disabled={locked || !signal} />
    </RowShell>
  );
}

/** Fixed parameter: a local draft, stored as ONE op; the plugin restarts the instance. */
function DraftRow({ fmu, v, nodePath }: { fmu: RVFmu; v: FmuVariableShape; nodePath: string }) {
  const override = fmu.overrideOf(v.name);
  const effectiveStart = typedStart(v, override);
  const xmlStart = typedStart(v, undefined);
  const [draft, setDraft] = useState<Value>(effectiveStart);
  // Re-sync when the stored start changes from outside (Undo/Redo, re-attach).
  const startKey = `${override ?? ''}|${v.start ?? ''}`;
  useEffect(() => {
    setDraft(typedStart(v, override));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);
  const canonical = normalizeFmuOverrideValue(v, draft);
  const target = getActiveEditTarget();

  const saveStart = (): void => {
    if (canonical === null) return;
    setFmuStartOverride(getActiveEditTarget(), nodePath, v.name, canonical, fmu.FmuStartOverrides);
  };
  const resetStart = (): void => {
    clearFmuStartOverride(getActiveEditTarget(), nodePath, v.name, fmu.FmuStartOverrides);
    setDraft(xmlStart);
  };

  return (
    <RowShell
      v={v}
      restart
      dot={(
        <ResetDot
          name={v.name}
          overridden={override !== undefined}
          changed={!valuesEqual(draft, xmlStart)}
          onReset={resetStart}
        />
      )}
      trailing={(
        <SaveStartButton
          name={v.name}
          disabledReason={saveDisabledReason(
            target.available,
            canonical,
            canonical === override || (override === undefined && valuesEqual(draft, xmlStart)),
          )}
          onSave={saveStart}
        />
      )}
    >
      <VariableEditor v={v} value={draft} onChange={setDraft} />
    </RowShell>
  );
}

function OrphanRow({ fmu, nodePath, name, value, reason }: {
  fmu: RVFmu; nodePath: string; name: string; value: string; reason: string;
}) {
  const text = reason === 'unknown-variable' ? 'no variable of this name'
    : reason === 'not-overridable' ? 'Variable is not overridable' : 'Value does not match type';
  return (
    <Box data-testid={`fmu-param-orphan-${name}`}>
      <InspectorRow
        label={name}
        labelTitle={name}
        labelColor={WARN}
        py={0.25}
        trailing={(
          <Button
            size="small" variant="text" color="warning"
            sx={{ minWidth: 0, height: HIT, px: 0.75, py: 0, fontSize: FS.label, textTransform: 'none', flexShrink: 0 }}
            data-testid={`fmu-param-orphan-remove-${name}`}
            disabled={!getActiveEditTarget().available}
            onClick={() => { clearFmuStartOverride(getActiveEditTarget(), nodePath, name, fmu.FmuStartOverrides); }}
          >
            {FMU_REMOVE_ORPHAN_LABEL}
          </Button>
        )}
      >
        <Typography sx={{ ...messageSx, color: WARN }}>
          = {value} · {text} (not applied)
        </Typography>
      </InspectorRow>
    </Box>
  );
}

/** A hint in the value column (label column empty), wrapping. */
function HintRow({ testId, color, children }: { testId: string; color?: string; children: ReactNode }) {
  return (
    <InspectorRow label="" py={0.25}>
      <Typography data-testid={testId} sx={{ ...messageSx, ...(color ? { color } : {}) }}>{children}</Typography>
    </InspectorRow>
  );
}

// ── Renderer ──────────────────────────────────────────────────────────────

/** The inspector renderer registered on `Fmu.FmuVariables`. */
export function FmuParametersRenderer({ nodePath, viewer, signalStore }: FieldRendererProps) {
  useFmuInstances(); // re-render on state / override changes
  const fmu = fmuOf(viewer?.registry?.getNode(nodePath) ?? null);
  const store = signalStore ?? viewer?.signalStore ?? null;
  const rows = useMemo(() => (fmu ? fmuParameterRows(fmu) : []), [fmu, fmu?.variables]);
  if (!fmu || !fmu.embed) return null;

  const locked = !fmu.allowViewerToFmu;
  const standalone = fmu.state === 'standalone' || fmu.state === 'unsupported';
  const params = rows.filter((v) => v.causality === 'parameter');
  const inputs = rows.filter((v) => v.causality === 'input');
  const hasLive = rows.some((v) => fmuLiveWritable(v));
  const numeric = rows.some((v) => v.type === 'Real' || v.type === 'Integer' || v.type === 'Enumeration');

  const row = (v: FmuVariableShape) => (fmuRestartRequired(v)
    ? <DraftRow key={v.name} fmu={fmu} v={v} nodePath={nodePath} />
    : <LiveRow key={v.name} fmu={fmu} v={v} nodePath={nodePath} store={store} locked={locked} />);

  const hints = (
    <>
      {hasLive && locked && <HintRow testId="fmu-param-locked-hint" color={WARN}>{FMU_LOCKED_HINT}</HintRow>}
      {hasLive && !locked && standalone && <HintRow testId="fmu-param-standalone-hint">{FMU_STANDALONE_HINT}</HintRow>}
      {numeric && isPre502(fmu) && <HintRow testId="fmu-param-rerange-hint">{FMU_RERANGE_HINT}</HintRow>}
    </>
  );

  const groups: Array<[string, FmuVariableShape[]]> = [];
  if (params.length > 0) groups.push([FMU_PARAMETERS_TITLE, params]);
  if (inputs.length > 0) groups.push([FMU_INPUTS_TITLE, inputs]);

  return (
    <Box data-testid="fmu-parameters">
      {groups.length === 0 && rows.length === 0 && (
        <>
          <InspectorSubheader>{FMU_PARAMETERS_TITLE}</InspectorSubheader>
          {fmu.orphanedOverrides.length === 0 && <HintRow testId="fmu-param-empty">{FMU_EMPTY_LABEL}</HintRow>}
          {hints}
        </>
      )}
      {groups.map(([title, vars], i) => (
        <Fragment key={title}>
          <InspectorSubheader>{title}</InspectorSubheader>
          {i === 0 && hints}
          {vars.map(row)}
        </Fragment>
      ))}
      {fmu.orphanedOverrides.length > 0 && (
        <>
          <InspectorSubheader>{FMU_CONFLICTS_TITLE}</InspectorSubheader>
          {fmu.orphanedOverrides.map((o) => (
            <OrphanRow key={o.name} fmu={fmu} nodePath={nodePath} name={o.name} value={o.value} reason={o.reason} />
          ))}
        </>
      )}
      <FmuEmbedBlock fmu={fmu} value={fmu.FmuEmbed} />
    </Box>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'Fmu',
  fieldName: 'FmuVariables',
  component: FmuParametersRenderer,
});
