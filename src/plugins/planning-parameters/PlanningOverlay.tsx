// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PlanningOverlay — the planning window (plan-630 §2.6 / §3.1).
 *
 * A {@link ControlWindow} that renders the DECLARED planning parameters of the
 * loaded model and knows nothing about the model itself: group by group, one
 * control per parameter, chosen from its declared type and range.
 *
 *   number/integer with min+max  →  ControlSlider   (drag, committed on release)
 *   number/integer without range →  ControlNumber   (typed, committed on Enter)
 *   boolean with `ui.chipRow`    →  ChipToggleRow   (one chip per element)
 *   boolean / enum               →  LatchGroup      (one of N, latched)
 *
 * The effect is always on screen: `⚡` is applied at the next instant of the sim
 * clock, `↻` waits for the next structural reset. A group whose rows share one
 * effect says it once, in its heading; a group with both says it again on every
 * row. A value that is waiting shows as "pending: old → new" and is withdrawn
 * by clicking that line; the footer button names how many are waiting.
 *
 * ## Why this does not render per frame
 *
 * The registry's snapshot is value-stable: same values, same object, so
 * `useSyncExternalStore` does not re-render. Key figures are displayed and
 * polled by the central Statistics window.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, Typography } from '@mui/material';
import {
  ChipToggleRow, ControlGroup, ControlNumber, ControlSlider, ControlWindow, LatchGroup,
  type ChipToggleItem,
} from '../../core/hmi/ControlWindow';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type {
  PlanningParamState, PlanningRegistry, PlanningSnapshot,
} from '../../core/planning/rv-planning-registry';
import {
  PLANNING_VISIBILITY_ID, getPlanningPlugin, getPlanningRegistry,
  type PlanningParametersPlugin, type PlanningScenarioState,
} from './index';
import { subscribeVariantMode, variantModeActive } from '../../core/hmi/rv-variant-ui-mode';
import { ScenarioBar } from './ScenarioBar';

const NOOP_SUBSCRIBE = () => () => {};
const EMPTY_SNAPSHOT: PlanningSnapshot = {
  version: 0, owners: [], params: [], pendingCount: 0, changeLog: [], experimentRunning: false,
};
const NO_SCENARIO: PlanningScenarioState | null = null;

// ─── Window ────────────────────────────────────────────────────────────────

/** The planning window; renders nothing until a model declares a parameter. */
export function PlanningWindow({ viewer }: UISlotProps) {
  const variantsActive = useSyncExternalStore(subscribeVariantMode, variantModeActive);
  const registry = getPlanningRegistry(viewer);
  const plugin = getPlanningPlugin(viewer);
  const snapshot = useSyncExternalStore(
    registry?.subscribe ?? NOOP_SUBSCRIBE,
    registry ? () => registry.getSnapshot() : () => EMPTY_SNAPSHOT,
  );
  // The collapsed title line names the active scenario (§3.3).
  const scenario = useSyncExternalStore(
    plugin ? (cb: () => void) => plugin.subscribeScenario(cb) : NOOP_SUBSCRIBE,
    plugin ? () => plugin.getScenarioState() : () => NO_SCENARIO,
  );

  // Experiment factors declared on demand (`ui.hidden`, plan-2005 Phase 7) are listed and
  // applied, but not shown; a window with nothing of a model to show stays closed.
  if (variantsActive || !registry || !snapshot.params.some((p) => p.owner !== 'display' && !isHidden(p))) return null;
  const subtitle = [
    planningTitle(snapshot),
    scenario ? scenario.block.active : '',
    snapshot.pendingCount > 0 ? `${snapshot.pendingCount} pending` : '',
  ].filter(Boolean).join(' · ');

  return (
    <ControlWindow
      title="Legacy planning"
      panelId="planning-parameters"
      defaultWidth={340}
      defaultPosition={{ x: Math.max(16, window.innerWidth - 340 - 16), y: 120 }}
      defaultCollapsed
      subtitle={subtitle || undefined}
      // A real height and a resize handle (ControlWindow's telemetry exception):
      // a plant declares as many parameters as it has, and a content-high window
      // grows past the screen — with the apply button the first thing off it.
      resizable
      defaultHeight={520}
    >
      <PlanningBody registry={registry} snapshot={snapshot} plugin={plugin} />
    </ControlWindow>
  );
}

/** True for a parameter the window does not show (`ui.hidden`). */
function isHidden(p: PlanningParamState): boolean {
  return p.def.ui?.hidden === true;
}

/** Model owners with at least one parameter the window shows. */
function shownOwners(snapshot: PlanningSnapshot): PlanningSnapshot['owners'] {
  return snapshot.owners.filter((o) => o.owner !== 'display'
    && snapshot.params.some((p) => p.owner === o.owner && !isHidden(p)));
}

/** Model name for one owner, plain `Planning` for several. */
function planningTitle(snapshot: PlanningSnapshot): string {
  const models = shownOwners(snapshot);
  return models.length === 1 ? models[0].title : 'Planning';
}

function PlanningBody({ registry, snapshot, plugin }: {
  registry: PlanningRegistry;
  snapshot: PlanningSnapshot;
  plugin?: PlanningParametersPlugin;
}) {
  const [applying, setApplying] = useState(false);
  const groups = useMemo(() => groupParams(snapshot.params.filter((p) => !isHidden(p))), [snapshot]);

  const set = useCallback((key: string, value: unknown) => {
    registry.set(key, value, 'ui');
  }, [registry]);

  const apply = useCallback(() => {
    setApplying(true);
    // Straight at the registry: the runner itself tells the plugin that an apply
    // is in flight, so there is no second entry that has to be taken instead.
    void registry.applyPendingAndReset().finally(() => setApplying(false));
  }, [registry]);

  // plan-2005 Phase 7: while an experiment batch runs, the window is read-only — the
  // batch owns the values (the registry refuses every other origin anyway).
  const locked = snapshot.experimentRunning;
  return (
    <>
      {locked && (
        <Typography role="status" data-testid="planning-experiment-lock" sx={{ fontSize: 10, color: '#ffcc80' }}>
          Experiment running — the planning window is read-only until the batch ends
        </Typography>
      )}
      <Box inert={locked} aria-disabled={locked || undefined} data-testid="planning-inputs"
        sx={{ display: 'flex', flexDirection: 'column', gap: 1.25, opacity: locked ? 0.55 : 1 }}>
        {plugin && <ScenarioBar plugin={plugin} registry={registry} snapshot={snapshot} />}
        {groups.map(([group, params]) => (
          <ControlGroup key={group} label={groupLabel(group, params)}>
            {renderGroup(params, set, registry, mixedEffects(params))}
          </ControlGroup>
        ))}
      </Box>
      <ResetToDefaults registry={registry} snapshot={snapshot} disabled={applying || locked} />
      {/* Always enabled (Thomas 2026-10-26: "jederzeit neu aufbauen", a simulation
          reset is allowed for it): with pending values it applies them, without
          any it rebuilds the declared structure and restarts the run. Works while
          the simulation runs — the apply halts, rebuilds, resets and resumes. */}
      <Button
        variant="outlined"
        size="small"
        fullWidth
        disabled={applying || locked}
        onClick={apply}
        sx={{ minHeight: 36, fontSize: 11, fontWeight: 700, textTransform: 'none' }}
      >
        {applying
          ? 'Rebuilding …'
          : snapshot.pendingCount > 0
            ? `Reset & apply (${snapshot.pendingCount} pending)`
            : 'Rebuild & reset'}
      </Button>
    </>
  );
}

/**
 * "Reset to defaults" (Thomas 2026-10-26) — one per model owner, generic: every
 * factor parameter of that owner back to its declared default. Live values take
 * effect at the next sim instant as usual; reset-class values (the PalletYard
 * size) go pending and wait for the apply button below (rebuild + one reset).
 * Disabled while every value — pending included — already is its default.
 * The non-default test reads the snapshot, so it re-renders with it.
 */
function ResetToDefaults({ registry, snapshot, disabled }: {
  registry: PlanningRegistry;
  snapshot: PlanningSnapshot;
  disabled: boolean;
}) {
  const owners = shownOwners(snapshot);
  return (
    <>
      {owners.map((o) => {
        const dirty = snapshot.params.some((p) => p.owner === o.owner && p.role === 'factor' && !isHidden(p)
          && (p.pending !== undefined ? p.pending : p.value) !== p.def.default);
        const label = owners.length > 1 ? `Reset ${o.title} to defaults` : 'Reset to defaults';
        return (
          <Button
            key={o.owner}
            variant="text"
            size="small"
            fullWidth
            disabled={disabled || !dirty}
            onClick={() => { registry.resetToDefaults(o.owner, 'ui'); }}
            sx={{ minHeight: 28, fontSize: 11, textTransform: 'none' }}
          >
            {label}
          </Button>
        );
      })}
    </>
  );
}

// ─── Grouping and controls ─────────────────────────────────────────────────

/** Parameters by declared group, groups in first-appearance order, rows by `order`. */
function groupParams(params: readonly PlanningParamState[]): Array<[string, PlanningParamState[]]> {
  const byGroup = new Map<string, PlanningParamState[]>();
  for (const p of params) {
    const list = byGroup.get(p.def.group);
    if (list) list.push(p);
    else byGroup.set(p.def.group, [p]);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => (a.def.order ?? 0) - (b.def.order ?? 0));
  }
  return [...byGroup.entries()].filter(([, list]) => list.length > 0);
}

/** True when a group holds both live and reset rows — then every row says which it is. */
function mixedEffects(params: readonly PlanningParamState[]): boolean {
  return params.some((p) => p.apply === 'live') && params.some((p) => p.apply === 'reset');
}

/** The group heading carries the effect of its rows: `Stations ↻`, `Shipping ⚡`. */
function groupLabel(group: string, params: readonly PlanningParamState[]): string {
  const reset = params.some((p) => p.apply === 'reset');
  if (mixedEffects(params)) return `${group} ⚡ ↻`;
  return `${group} ${reset ? '↻' : '⚡'}`;
}

type SetFn = (key: string, value: unknown) => void;

/**
 * The rows of one group, in the order the model declared them. A chip row takes
 * the place of its FIRST member, so `Ausgänge`, `Eingänge`, `Pufferplätze` come
 * out in the order they were written — collecting the chip rows and appending
 * them would silently reorder the group.
 *
 * `showBadge` only in a group whose rows differ in effect: when all of them are
 * `live` (or all `reset`) the group heading already says so, and repeating it on
 * every row is noise.
 */
function renderGroup(
  params: PlanningParamState[],
  set: SetFn,
  registry: PlanningRegistry,
  showBadge: boolean,
) {
  const chipRows = new Map<string, PlanningParamState[]>();
  for (const p of params) {
    const name = p.def.type === 'boolean' ? p.def.ui?.chipRow : undefined;
    if (!name) continue;
    const list = chipRows.get(name);
    if (list) list.push(p);
    else chipRows.set(name, [p]);
  }

  const emitted = new Set<string>();
  const rows: React.ReactNode[] = [];
  for (const p of params) {
    const name = p.def.type === 'boolean' ? p.def.ui?.chipRow : undefined;
    if (!name) {
      rows.push(<ParamRow key={p.key} param={p} set={set} registry={registry} showBadge={showBadge} />);
      continue;
    }
    if (emitted.has(name)) continue;
    emitted.add(name);
    const list = chipRows.get(name)!;
    rows.push(
      <ChipToggleRow
        key={`chip:${name}`}
        label={showBadge ? `${name} ${effectBadge(list[0])}` : name}
        ariaLabel={name}
        items={list.map((p2): ChipToggleItem => ({
          id: p2.key,
          label: p2.def.label,
          value: p2.value === true,
          pending: typeof p2.pending === 'boolean' ? p2.pending : undefined,
          description: p2.def.description,
        }))}
        onToggle={(id, next) => set(id, next)}
      />,
    );
  }
  return rows;
}

/** `⚡` applies at the next sim instant, `↻` waits for the structural reset. */
function effectBadge(param: PlanningParamState): string {
  return param.apply === 'live' ? '⚡' : '↻';
}

/** One non-chip parameter: its control, its effect badge and its pending note. */
function ParamRow({ param, set, registry, showBadge }: {
  param: PlanningParamState;
  set: SetFn;
  registry: PlanningRegistry;
  showBadge: boolean;
}) {
  const { def } = param;
  const label = showBadge ? `${def.label} ${effectBadge(param)}` : def.label;
  const numeric = def.type === 'number' || def.type === 'integer';
  const bounded = numeric && typeof def.min === 'number' && typeof def.max === 'number';
  const shown = param.pending !== undefined ? param.pending : param.value;

  let control: React.ReactNode;
  if (bounded) {
    control = (
      <PlanningSlider
        label={label}
        unit={def.unit}
        min={def.min!}
        max={def.max!}
        step={def.step}
        value={typeof shown === 'number' ? shown : 0}
        onCommit={(v) => set(param.key, v)}
      />
    );
  } else if (numeric) {
    control = (
      <ControlNumber
        label={label}
        unit={def.unit}
        value={typeof shown === 'number' ? shown : 0}
        min={def.min}
        max={def.max}
        integer={def.type === 'integer'}
        error={param.error}
        description={def.description}
        onCommit={(v) => set(param.key, v)}
      />
    );
  } else if (def.type === 'enum') {
    control = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{label}</Typography>
        <LatchGroup
          ariaLabel={def.label}
          options={(def.options ?? []).map((o) => ({ id: o.id, label: o.label }))}
          value={typeof shown === 'string' ? shown : null}
          onChange={(id) => set(param.key, id)}
        />
      </Box>
    );
  } else {
    control = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
        <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>{label}</Typography>
        <LatchGroup
          ariaLabel={def.label}
          options={[{ id: 'on', label: 'On' }, { id: 'off', label: 'Off' }]}
          value={shown === true ? 'on' : 'off'}
          onChange={(id) => set(param.key, id === 'on')}
        />
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {control}
      {param.pending !== undefined && (
        <Box
          component="button"
          type="button"
          onClick={() => registry.revertPending(param.key)}
          aria-label={`Revert pending ${def.label}`}
          sx={{
            alignSelf: 'flex-start',
            border: 'none',
            bgcolor: 'transparent',
            cursor: 'pointer',
            p: 0,
            fontFamily: 'inherit',
            fontSize: 10,
            color: '#ffcc80',
          }}
        >
          {`pending: ${formatValue(param.value)} → ${formatValue(param.pending)}`}
        </Box>
      )}
      {param.error && param.pending === undefined && !numeric && (
        <Typography role="alert" sx={{ fontSize: 10, color: '#ef9a9a' }}>{param.error}</Typography>
      )}
    </Box>
  );
}

/**
 * A slider whose thumb follows the finger but whose MODEL hears one value, on
 * release (§3.3): a live change per intermediate pixel would flood the change
 * log of the running plant. The local value is dropped as soon as the model
 * reports a different one, so a rejected or re-based value is never left on
 * screen.
 */
function PlanningSlider({ label, unit, min, max, step, value, onCommit }: {
  label: string;
  unit?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onCommit(v: number): void;
}) {
  // The drag carries the model value it STARTED from, so a value that changed
  // meanwhile discards it by itself. No state is written during a render —
  // otherwise every published change would cost the window a second commit.
  const [drag, setDrag] = useState<{ base: number; value: number } | null>(null);
  const shown = drag && drag.base === value ? drag.value : value;

  return (
    <ControlSlider
      label={label}
      unit={unit}
      min={min}
      max={max}
      step={step}
      value={shown}
      onChange={(v) => setDrag({ base: value, value: v })}
      onCommit={(v) => { setDrag(null); onCommit(v); }}
    />
  );
}

function formatValue(v: unknown): string {
  if (v === true) return 'on';
  if (v === false) return 'off';
  return String(v);
}

/**
 * The overlay slot, registered by the plugin the first time a model declares a
 * planning parameter. The window is at home in the viewer, the DES workspace,
 * commissioning and the planner; the asset editor is the one place it does not
 * belong — that view authors a tree, it does not run a plant.
 *
 * The rule itself is registered by the plugin at start-up
 * ({@link PLANNING_VISIBILITY_ID} / {@link PLANNING_VISIBILITY_RULE}), NOT
 * carried on the entry: `SlotRenderer` registers an entry's `visibilityRule`
 * during its render, and a rule that arrives with a slot registered at runtime
 * therefore writes to the visibility store mid-render, which React rightly
 * complains about. Registering it up front is the same rule without that.
 */
export const PLANNING_OVERLAY_UI: { id: string; slots: UISlotEntry[] } = {
  id: 'planning-parameters-ui',
  slots: [{
    slot: 'overlay',
    component: PlanningWindow,
    order: 90,
    visibilityId: PLANNING_VISIBILITY_ID,
  }],
};
