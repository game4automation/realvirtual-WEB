// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DESExperimentMatrixPanel — THE single DES Experiment Matrix window (plan-265).
 *
 * One FlexSim-style table: experiments are COLUMNS, rows fall into two blocks —
 * PARAMETERS (property/boolean overrides applied before each run) and RESULTS
 * (KPIs as mean ± 95%CI over the replications). A compact RUN block on top holds
 * the per-experiment replication count ("Seed runs N") and a status line. The
 * first column is the fixed Baseline; every other column highlights its deviation
 * (column tint + changed cells + KPI Δ). Per column: an active checkbox (Run all
 * scope), a ▶ Run-this button and a ⟳ running indicator (F16).
 *
 * All data crosses the repo seam through the public `SimDesControl` facade
 * (JSON-string / primitive transport) — no private type imports. Replaces the
 * clock/experiments-tree/compare windows (F1); the batch runs via the
 * runExperimentBatch / runAllExperiments API (plan-265 phase 2).
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Box, Typography, IconButton, Tooltip, Checkbox, Button, CircularProgress, TextField,
  FormControlLabel, Menu, MenuItem,
} from '@mui/material';
import { PlayArrow, Refresh, PlaylistPlay, ChevronRight, Delete, AddAPhoto, Add, Stop } from '@mui/icons-material';
import { FloatingPanel } from '../../core/hmi/FloatingPanel';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import type { SimDesControl } from '../../core/material-flow/simulation-kernel';
import {
  runScopeStore, type ExperimentInfo, type ParamOverrideInfo, type RunInfo,
} from '../../core/material-flow/rv-run-history-store';
import { formatSimClock, formatDesDuration, parseDesDuration } from './format-sim-time';
import { fmtBytes } from './des-experiments-helpers';
import {
  ensureActiveProject, ensureActiveScope, listProjectExperiments, modelKeyOf, computeGlbFingerprint,
} from '../../core/material-flow/rv-project-manager';
import { FieldEditor } from '../../core/hmi/rv-field-editors';
import type { FieldType } from '../../core/hmi/rv-inspector-helpers';
import {
  collectMatrixColumns, collectMatrixRows, buildKpiRows,
  type MatrixValue, type MatrixParamRow, type MatrixKpiRow,
} from './des-matrix-helpers';
import { lintParamScript } from './des-param-script-lint';

const REFRESH_MS = 2000;
const NAME_COL = 190;
const EXP_COL = 130;

/** Parsed `SimDesControl.batchProgressJson()`. */
interface BatchProgress { exp: string; replIndex: number; total: number; phase: string; }
function parseBatchProgress(json: string | null | undefined): BatchProgress | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.exp !== 'string') return null;
    return {
      exp: raw.exp,
      replIndex: typeof raw.replIndex === 'number' ? raw.replIndex : 0,
      total: typeof raw.total === 'number' ? raw.total : 0,
      phase: typeof raw.phase === 'string' ? raw.phase : 'running',
    };
  } catch { return null; }
}

/** Infer a FieldEditor field type from an override value. */
function inferFieldType(v: MatrixValue): FieldType {
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  return 'string';
}

/** Row's representative value (baseline first, else first defined) → drives the
 *  editor type and the seed for creating a new override on an inherited cell. */
function rowDefault(row: MatrixParamRow, cols: readonly ExperimentInfo[]): MatrixValue {
  for (const c of cols) {
    const cell = row.cells.get(c.experiment);
    if (cell && cell.overridden) return cell.value;
  }
  return 0;
}

/** Format a KPI cell mean ± CI (or "—" when empty). */
function fmtKpi(mean: number, ci95: number, empty: boolean): string {
  if (empty) return '—';
  const m = Math.abs(mean) >= 100 ? mean.toFixed(0) : mean.toFixed(1);
  return ci95 > 0 ? `${m} ±${ci95 >= 10 ? ci95.toFixed(0) : ci95.toFixed(1)}` : m;
}

/** Status label for a run row. */
function runStatusLabel(r: RunInfo): string {
  if (r.status === 'completed') return 'completed';
  if (r.status === 'aborted') return 'aborted';
  return r.status ? 'running' : 'snapshot';
}

/** One selectable parameter from the scene's rv_extras (the "+" picker). */
export interface ParamSuggestion {
  path: string; component: string; field: string; value: MatrixValue; label: string;
}

/**
 * Harvest selectable parameters from the DES nodes' rv_extras: every primitive
 * field of every realvirtual component on a node the DES runner knows. The
 * suggestion carries the CURRENT model value — adding it seeds the baseline
 * override with that value instead of a blind 0.
 */
export function collectParamSuggestions(
  scene: { traverse(cb: (o: { name: string; userData: Record<string, unknown> }) => void): void },
  states: ReadonlyArray<{ name: string }>,
): ParamSuggestion[] {
  const wanted = new Set(states.map((s) => s.name));
  const byName = new Map<string, Record<string, Record<string, unknown>>>();
  scene.traverse((o) => {
    if (!wanted.has(o.name) || byName.has(o.name)) return;
    const rv = o.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    if (rv && typeof rv === 'object') byName.set(o.name, rv);
  });
  // Viewer/layout metadata components carry no process parameters — hide them
  // so the picker shows tunable simulation fields, not instance bookkeeping.
  const HIDDEN_COMPONENTS = new Set(['LayoutObject', 'MU', 'SnapPoints', 'WebSensor', 'rigidbody']);
  const HIDDEN_FIELDS = new Set(['ID', 'GlobalID', 'Name', 'Active', 'DebugMode']);
  const out: ParamSuggestion[] = [];
  for (const [name, rv] of byName) {
    for (const [comp, fields] of Object.entries(rv)) {
      if (!fields || typeof fields !== 'object' || HIDDEN_COMPONENTS.has(comp)) continue;
      for (const [field, v] of Object.entries(fields)) {
        if (field.startsWith('_') || HIDDEN_FIELDS.has(field)) continue;
        // Tunable parameters are numbers/booleans; strings are names/ids.
        if (typeof v !== 'number' && typeof v !== 'boolean') continue;
        out.push({ path: name, component: comp, field, value: v, label: `${name}.${comp}.${field}` });
      }
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out.slice(0, 80);
}

/**
 * Compact DD:HH:MM:SS duration cell (sim end / warmup per experiment). Commits
 * on blur/Enter only — committing per keystroke would persist partial entries
 * ("10" while typing "10:00"). Remounts (key) when the stored value changes.
 */
function DurationCell({ value, onCommit, testId }: {
  value: number;
  onCommit: (seconds: number) => void;
  testId?: string;
}) {
  const commit = (text: string) => {
    const t = text.trim();
    const seconds = t === '' ? 0 : parseDesDuration(t);
    if (seconds === null) return; // invalid / partial → leave stored value
    if (seconds !== value) onCommit(seconds);
  };
  return (
    <TextField key={value} size="small" fullWidth defaultValue={formatDesDuration(value)}
      placeholder="DD:HH:MM:SS"
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') commit((e.target as HTMLInputElement).value); }}
      inputProps={{
        ...(testId ? { 'data-testid': testId } : {}),
        style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, padding: '2px 4px', textAlign: 'center' },
      }} />
  );
}

/**
 * Parse the add-parameter input: `Component.Field`, `Node.Component.Field`,
 * each optionally with a `= value` suffix (number / true / false / string).
 * A 2-segment form is resolved to its node via the live component states —
 * unambiguous only when exactly ONE component of that type exists.
 */
export function parseParamInput(
  raw: string,
  states: ReadonlyArray<{ name: string; type: string }>,
): { path: string; component: string; field: string; value: MatrixValue } | { error: string } {
  let lhs = raw.trim();
  let value: MatrixValue = 0;
  const eq = lhs.indexOf('=');
  if (eq >= 0) {
    const vs = lhs.slice(eq + 1).trim();
    lhs = lhs.slice(0, eq).trim();
    if (vs === 'true' || vs === 'false') value = vs === 'true';
    else if (vs !== '' && Number.isFinite(Number(vs))) value = Number(vs);
    else value = vs;
  }
  const parts = lhs.split('.').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { error: 'Use Component.Field — e.g. DESSource.InterArrivalTime = 3' };
  if (parts.length >= 3) {
    return { path: parts[0], component: parts[1], field: parts.slice(2).join('.'), value };
  }
  const [component, field] = parts;
  // The override's `component` is the rv_extras name ('DESSource'), while the
  // live state reports the definition type ('Source') — accept both spellings
  // for node resolution and keep the user's spelling in the override.
  const matches = states.filter((s) => s.type === component || `DES${s.type}` === component);
  if (matches.length === 0) return { error: `No component of type '${component}' in the model` };
  if (matches.length > 1) {
    return { error: `${matches.length}× '${component}' — qualify the node: ${matches[0].name}.${component}.${field}` };
  }
  return { path: matches[0].name, component, field, value };
}

/**
 * F15 drill-down — the Run → Checkpoint list of ONE experiment (the capability
 * the old tree panel had). Every action goes through the public facade:
 * loadSnapshot + setSubMode('step') to jump to a checkpoint, deleteSnapshot /
 * deleteReplication to prune, saveSnapshot for "Snapshot now".
 */
function RunsDrilldown({ exp, ctl, onAction, onClose }: {
  exp: ExperimentInfo;
  ctl: () => SimDesControl | null;
  onAction: () => void;
  onClose: () => void;
}) {
  const runs = [...exp.runs].sort((a, b) => a.index - b.index);
  const act = (fn: (c: SimDesControl) => Promise<void> | void) => {
    const c = ctl(); if (!c) return;
    void (async () => { await fn(c); onAction(); })();
  };
  const snapshotNow = () => act((c) => c.saveSnapshot?.(
    { model: exp.model, exp: exp.experiment, repl: runs.length ? runs[runs.length - 1].index : 0 }));
  const loadCheckpoint = (r: RunInfo, t: number) => act((c) => {
    void c.loadSnapshot?.({ model: exp.model, exp: exp.experiment, repl: r.index, t });
    c.setSubMode('step');
  });

  return (
    <FloatingPanel open onClose={onClose} title={`Runs — ${exp.experiment}`}
      panelId="des-matrix-runs" defaultWidth={340} defaultHeight={360} minWidth={280}
      toolbar={
        <Tooltip title="Snapshot the current state now">
          <IconButton size="small" onClick={snapshotNow} data-testid="des-matrix-snapshot-now"><AddAPhoto sx={{ fontSize: 16 }} /></IconButton>
        </Tooltip>
      }>
      <Box sx={{ height: '100%', overflow: 'auto', px: 0.5, py: 0.5 }} data-testid="des-matrix-runs-panel">
        {runs.length === 0 && (
          <Typography sx={{ fontSize: 11, color: 'text.secondary', p: 1, textAlign: 'center' }}>
            No runs yet — run this experiment or take a snapshot.
          </Typography>
        )}
        {runs.map((r) => (
          <Box key={r.index} sx={{ mb: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, py: 0.25,
              bgcolor: 'rgba(255,255,255,0.03)', borderRadius: 0.5 }}>
              <Typography sx={{ fontSize: 11, fontWeight: 600, flex: 1 }}>
                #{r.index} · seed {r.seed} · {runStatusLabel(r)}
              </Typography>
              <Tooltip title="Delete run">
                <IconButton size="small" sx={{ p: 0.25 }} data-testid={`des-matrix-del-run-${r.index}`}
                  onClick={() => {
                    if (!window.confirm(`Delete run #${r.index} with all its checkpoints?`)) return;
                    act((c) => c.deleteReplication?.({ model: exp.model, exp: exp.experiment, repl: r.index }));
                  }}>
                  <Delete sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            </Box>
            {r.checkpoints.map((cp) => (
              <Box key={cp.simTime} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: 2, py: 0.15 }}>
                <Tooltip title="Load this checkpoint (step mode)">
                  <IconButton size="small" sx={{ p: 0.2 }} data-testid={`des-matrix-load-cp-${r.index}-${cp.simTime}`}
                    onClick={() => loadCheckpoint(r, cp.simTime)}>
                    <PlayArrow sx={{ fontSize: 14, color: '#4fc3f7' }} />
                  </IconButton>
                </Tooltip>
                <Typography sx={{ fontSize: 10.5, flex: 1, fontFamily: 'monospace' }}>
                  {formatSimClock(cp.simTime)} · {fmtBytes(cp.bytes)}
                </Typography>
                <Tooltip title="Delete checkpoint">
                  <IconButton size="small" sx={{ p: 0.2 }}
                    onClick={() => {
                      if (!window.confirm(`Delete checkpoint ${formatSimClock(cp.simTime)} of run #${r.index}?`)) return;
                      act((c) => c.deleteSnapshot?.({ model: exp.model, exp: exp.experiment, repl: r.index, t: cp.simTime }));
                    }}>
                    <Delete sx={{ fontSize: 13 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </FloatingPanel>
  );
}

/**
 * F4 param-script editor — a small setter-only JS editor for one experiment's
 * `paramScript`. Live-linted with the setter-only rule (des-param-script-lint);
 * Save is blocked while lint errors remain. (A Monaco upgrade — reusing the
 * ScriptEditorPanel host — is a follow-up; the textarea keeps the loop testable
 * and dependency-free.)
 */
function ParamScriptEditor({ exp, onSave, onClose }: {
  exp: ExperimentInfo;
  onSave: (source: string) => void;
  onClose: () => void;
}) {
  const [src, setSrc] = useState(exp.paramScript ?? '');
  const errors = useMemo(() => lintParamScript(src), [src]);
  return (
    <FloatingPanel open onClose={onClose} title={`Param script — ${exp.experiment}`}
      panelId="des-matrix-script" defaultWidth={420} defaultHeight={300} minWidth={320}
      toolbar={
        <Button size="small" variant="contained" disabled={errors.length > 0}
          data-testid="des-matrix-script-save"
          onClick={() => { onSave(src); onClose(); }} sx={{ fontSize: 11 }}>Save</Button>
      }>
      <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 0.75, gap: 0.5 }}>
        <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
          Setter-only — configure the model before each run, e.g.
          <code> self.setField('Src','DESSource','InterArrivalTime', 3)</code>
        </Typography>
        {/* Field fill is the shared white-alpha wash, not a black one: the panel
            behind it is already the darkest glass tier, so an inset field reads
            as *lighter* than its surface, the same way every other field does. */}
        <textarea value={src} onChange={(e) => setSrc(e.target.value)}
          data-testid="des-matrix-script-text"
          spellCheck={false}
          style={{ flex: 1, resize: 'none', fontFamily: 'monospace', fontSize: 12,
            background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.92)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 4, padding: 6 }} />
        {errors.length > 0 && (
          <Box data-testid="des-matrix-script-errors" sx={{ maxHeight: 70, overflow: 'auto' }}>
            {errors.map((er, i) => (
              <Typography key={i} sx={{ fontSize: 10, color: '#ef5350' }}>
                L{er.line}: {er.message}
              </Typography>
            ))}
          </Box>
        )}
      </Box>
    </FloatingPanel>
  );
}

export interface DESExperimentMatrixPanelProps extends UISlotProps {
  open: boolean;
  onClose: () => void;
}

export function DESExperimentMatrixPanel({ viewer, open, onClose }: DESExperimentMatrixPanelProps) {
  const [experiments, setExperiments] = useState<ExperimentInfo[]>([]);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [crn, setCrn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runsExp, setRunsExp] = useState<string | null>(null);
  const [scriptExp, setScriptExp] = useState<string | null>(null);
  const [newParam, setNewParam] = useState('');
  const [paramError, setParamError] = useState<string | null>(null);
  const [paramMenuAnchor, setParamMenuAnchor] = useState<HTMLElement | null>(null);
  const [suggestions, setSuggestions] = useState<ParamSuggestion[]>([]);

  const ctl = useCallback(
    (): SimDesControl | null => viewer.simulationKernel?.desControl() ?? null,
    [viewer],
  );

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const project = await ensureActiveProject();
      if (!runScopeStore.getSnapshot()) await ensureActiveScope(viewer);
      setExperiments(await listProjectExperiments(viewer, project.projectId));
      setProgress(parseBatchProgress(ctl()?.batchProgressJson?.()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [viewer, ctl]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const u1 = viewer.on('simulation-run-started', () => void refresh());
    const u2 = viewer.on('simulation-run-ending', () => void refresh());
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => { u1(); u2(); clearInterval(id); };
  }, [open, refresh, viewer]);

  const columns = useMemo(() => collectMatrixColumns(experiments), [experiments]);
  const paramRows = useMemo(() => collectMatrixRows(experiments), [experiments]);
  const kpiRows = useMemo(() => buildKpiRows(experiments), [experiments]);
  const baseline = columns[0];

  /** Columns with at least one deviation from the baseline (F14 tint). */
  const deviatingCols = useMemo(() => {
    const set = new Set<string>();
    for (const row of paramRows) {
      for (const c of columns) {
        if (c === baseline) continue;
        if (row.cells.get(c.experiment)?.diffFromBaseline) set.add(c.experiment);
      }
    }
    return set;
  }, [paramRows, columns, baseline]);

  const patchExp = useCallback((model: string, exp: string, patch: Record<string, unknown>) => {
    void (async () => {
      setBusy(true);
      try {
        await ctl()?.patchExperimentMetaJson?.(model, exp, JSON.stringify(patch));
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally { setBusy(false); }
    })();
  }, [ctl, refresh]);

  const setOverride = useCallback((exp: ExperimentInfo, row: MatrixParamRow, value: MatrixValue) => {
    const next: ParamOverrideInfo[] = exp.paramOverrides.filter(
      (o) => !(o.component === row.component && o.field === row.field),
    );
    next.push({ path: row.path, component: row.component, field: row.field, value });
    patchExp(exp.model, exp.experiment, { paramOverrides: next });
  }, [patchExp]);

  const runOne = useCallback((exp: ExperimentInfo) => {
    void (async () => {
      setBusy(true);
      try { await ctl()?.runExperimentBatch?.({ model: exp.model, exp: exp.experiment }, { replications: exp.replicationCount, crn }); await refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  }, [ctl, crn, refresh]);

  const runAll = useCallback(() => {
    const model = baseline?.model;
    if (!model) return;
    void (async () => {
      setBusy(true);
      try { await ctl()?.runAllExperiments?.(model, { crn }); await refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  }, [ctl, crn, baseline, refresh]);

  /** Create a new experiment in the active project and snapshot the current
   *  model state into it. The FIRST experiment becomes the fixed baseline
   *  column; further ones get a unique auto-name (rename via manifest later). */
  const createExperiment = useCallback(() => {
    void (async () => {
      setBusy(true);
      try {
        const c = ctl();
        if (!c?.patchExperimentMetaJson) { setError('Experiment store is not available in this build.'); return; }
        const project = await ensureActiveProject();
        const model = modelKeyOf(viewer);
        const glbHash = await computeGlbFingerprint(viewer);
        const existing = new Set(experiments.map((e) => e.experiment));
        let i = Math.max(1, columns.length);
        let name = columns.length === 0 ? 'Baseline' : `Experiment ${i}`;
        while (existing.has(name)) { i += 1; name = `Experiment ${i}`; }
        // Seed the per-experiment run settings from the live clock so a fresh
        // experiment is runnable right away (endTime 0 would refuse to run).
        await c.patchExperimentMetaJson(model, name, JSON.stringify({
          projectId: project.projectId, glbHash, baseSeed: c.masterSeed ?? 42,
          ...(Number.isFinite(c.endTime) && (c.endTime ?? 0) > 0 ? { endTime: c.endTime } : {}),
          ...((c.statResetTime ?? 0) > 0 ? { statResetTime: c.statResetTime } : {}),
        }));
        await c.saveSnapshot?.({ model, exp: name, repl: 0 });
        await refresh();
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  }, [ctl, viewer, experiments, columns.length, refresh]);

  const cancelBatch = useCallback(() => { ctl()?.cancelBatch?.(); }, [ctl]);

  /** Create/replace one baseline override — variants then deviate per cell. */
  const addOverride = useCallback((o: { path: string; component: string; field: string; value: MatrixValue }) => {
    if (!baseline) return;
    const next: ParamOverrideInfo[] = baseline.paramOverrides.filter(
      (x) => !(x.component === o.component && x.field === o.field),
    );
    next.push({ path: o.path, component: o.component, field: o.field, value: o.value });
    patchExp(baseline.model, baseline.experiment, { paramOverrides: next });
  }, [baseline, patchExp]);

  /** Add a parameter row from the dot-notation input. Without an explicit
   *  `= value` the CURRENT model value (from the scene rv_extras) seeds the
   *  baseline override, so the row starts truthful instead of at 0. */
  const addParam = useCallback(() => {
    if (!baseline || !newParam.trim()) return;
    const states = ctl()?.componentStates?.() ?? [];
    const parsed = parseParamInput(newParam, states);
    if ('error' in parsed) { setParamError(parsed.error); return; }
    setParamError(null);
    let value = parsed.value;
    if (!newParam.includes('=')) {
      const current = collectParamSuggestions(viewer.scene, states)
        .find((s) => s.path === parsed.path && s.component === parsed.component && s.field === parsed.field);
      if (current) value = current.value;
    }
    addOverride({ ...parsed, value });
    setNewParam('');
  }, [baseline, newParam, ctl, viewer, addOverride]);

  /** Open the "+" picker with everything the scene's rv_extras offers. */
  const openParamMenu = useCallback((anchor: HTMLElement) => {
    const states = ctl()?.componentStates?.() ?? [];
    setSuggestions(collectParamSuggestions(viewer.scene, states));
    setParamMenuAnchor(anchor);
  }, [ctl, viewer]);

  /** Load a stored snapshot into the live sim (step mode) — the "revert" link. */
  const loadSnapshotAt = useCallback((exp: ExperimentInfo, repl: number, t: number) => {
    const c = ctl(); if (!c) return;
    void (async () => {
      await c.loadSnapshot?.({ model: exp.model, exp: exp.experiment, repl, t });
      c.setSubMode('step');
    })();
  }, [ctl]);

  /** Delete an experiment (cascading: all runs + snapshots) after confirm. */
  const deleteExperiment = useCallback((exp: ExperimentInfo) => {
    if (!window.confirm(`Delete experiment '${exp.experiment}' with ALL its runs and snapshots?`)) return;
    void (async () => {
      setBusy(true);
      try { await ctl()?.deleteExperiment?.(exp.model, exp.experiment); await refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    })();
  }, [ctl, refresh]);

  const gridCols = `${NAME_COL}px repeat(${columns.length}, ${EXP_COL}px)`;

  const batchRunning = progress?.phase === 'running';
  // Overall batch position ("experiment i/n") — only meaningful while the
  // running experiment is one of the enabled columns.
  const enabledCols = columns.filter((c) => c.enabled);
  const batchExpIndex = batchRunning ? enabledCols.findIndex((c) => c.experiment === progress!.exp) : -1;

  const runAllTitle = busy || batchRunning
    ? 'A batch is running'
    : columns.length === 0
      ? 'Create an experiment first'
      : `Run all active experiments (${enabledCols.length} × N runs)`;

  const toolbar = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Tooltip title="Common Random Numbers — same seed stream per slot for a fair comparison">
        <FormControlLabel
          control={<Checkbox size="small" sx={{ p: 0.5 }} checked={crn} onChange={(e) => setCrn(e.target.checked)} data-testid="des-matrix-crn" />}
          label={<Typography sx={{ fontSize: 11 }}>CRN</Typography>}
          sx={{ m: 0, mr: 0.5 }}
        />
      </Tooltip>
      {batchRunning ? (
        <>
          <Typography sx={{ fontSize: 11, fontFamily: 'monospace', color: '#4fc3f7', whiteSpace: 'nowrap' }}
            data-testid="des-matrix-batch-progress">
            {batchExpIndex >= 0 && enabledCols.length > 1 ? `exp ${batchExpIndex + 1}/${enabledCols.length} · ` : ''}
            run {progress!.replIndex}/{progress!.total}
          </Typography>
          <Button size="small" variant="outlined" color="inherit" startIcon={<Stop />}
            onClick={cancelBatch} data-testid="des-matrix-cancel" sx={{ fontSize: 11 }}>
            Cancel
          </Button>
        </>
      ) : (
        <Tooltip title={runAllTitle}>
          <span>
            <Button size="small" variant="outlined" startIcon={<PlaylistPlay />} disabled={busy || columns.length === 0}
              onClick={runAll} data-testid="des-matrix-run-all" sx={{ fontSize: 11 }}>
              Run all
            </Button>
          </span>
        </Tooltip>
      )}
      <Tooltip title="Refresh">
        <IconButton size="small" onClick={() => void refresh()}><Refresh sx={{ fontSize: 16 }} /></IconButton>
      </Tooltip>
    </Box>
  );

  // Sticky cells must occlude the content scrolling beneath them, so they stay
  // near-opaque even though the panel glass itself is translucent — same grey
  // tone as the theme Paper tier so they don't read as foreign black bars.
  const stickyGlass = {
    bgcolor: 'rgba(30,30,30,0.96)',
  } as const;

  const sectionHeader = (label: string) => (
    <Box sx={{
      gridColumn: '1 / -1', px: 1, py: 0.25, mt: 0.5,
      bgcolor: 'rgba(255,255,255,0.05)', position: 'sticky', left: 0,
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, color: 'text.secondary', textTransform: 'uppercase',
    }}>{label}</Box>
  );

  const nameCell = (label: string, testId?: string) => (
    <Box data-testid={testId} sx={{
      position: 'sticky', left: 0, zIndex: 1, ...stickyGlass,
      px: 1, py: 0.4, fontSize: 11.5, borderRight: '1px solid rgba(255,255,255,0.06)',
      display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>{label}</Box>
  );

  const colTint = (exp: ExperimentInfo) =>
    exp === baseline ? 'rgba(79,195,247,0.06)' : deviatingCols.has(exp.experiment) ? 'rgba(255,167,38,0.05)' : 'transparent';

  const drillExp = runsExp ? experiments.find((e) => e.experiment === runsExp) ?? null : null;
  const editScriptExp = scriptExp ? experiments.find((e) => e.experiment === scriptExp) ?? null : null;

  return (
    <>
    <FloatingPanel open={open} onClose={onClose} title="DES Experiment Matrix"
      panelId="des-experiment-matrix" defaultWidth={560} defaultHeight={400} toolbar={toolbar}>
      <Box sx={{ height: '100%', overflow: 'auto' }} data-testid="des-matrix-panel">
        {error && <Typography sx={{ color: '#ef5350', fontSize: 11, px: 1, py: 0.5 }}>Error: {error}</Typography>}
        {columns.length === 0 ? (
          <Box sx={{ p: 3, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.25 }}>
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary', textAlign: 'center', maxWidth: 420 }}>
              Experiments compare simulation runs side by side — the first one becomes the
              fixed baseline, every further column varies parameters against it.
            </Typography>
            <Button size="small" variant="contained" startIcon={<Add />} disabled={busy}
              onClick={createExperiment} data-testid="des-matrix-new-empty">
              New experiment
            </Button>
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
              Snapshots the current model state as the baseline.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', minWidth: 'fit-content' }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: gridCols, alignItems: 'stretch', minWidth: 'fit-content' }}>
            {/* ── Header row (sticky) ── */}
            <Box sx={{ position: 'sticky', top: 0, left: 0, zIndex: 3, ...stickyGlass }} />
            {columns.map((exp) => {
              const running = progress?.phase === 'running' && progress.exp === exp.experiment;
              return (
                <Box key={exp.experiment} data-testid={`des-matrix-col-${exp.experiment}`}
                  sx={{ position: 'sticky', top: 0, zIndex: 2, ...stickyGlass, px: 0.5, py: 0.4,
                    borderBottom: exp === baseline ? '2px solid #4fc3f7' : '1px solid rgba(255,255,255,0.08)',
                    borderLeft: exp === baseline ? '2px solid #4fc3f7' : 'none' }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.25 }}>
                    <Tooltip title={exp.enabled ? 'Active (runs on "Run all")' : 'Skipped by "Run all"'}>
                      <Checkbox size="small" sx={{ p: 0.25 }} checked={exp.enabled}
                        data-testid={`des-matrix-active-${exp.experiment}`}
                        onChange={(e) => patchExp(exp.model, exp.experiment, { enabled: e.target.checked })} />
                    </Tooltip>
                    <Typography sx={{ fontSize: 11.5, fontWeight: 600, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{exp.experiment}</Typography>
                    {running
                      ? <CircularProgress size={13} data-testid={`des-matrix-running-${exp.experiment}`} />
                      : (
                        <Tooltip title="Delete experiment (all runs + snapshots)">
                          <IconButton size="small" sx={{ p: 0.2, color: 'rgba(255,255,255,0.35)', '&:hover': { color: '#ef5350' } }}
                            data-testid={`des-matrix-delete-${exp.experiment}`}
                            onClick={() => deleteExperiment(exp)}>
                            <Delete sx={{ fontSize: 13 }} />
                          </IconButton>
                        </Tooltip>
                      )}
                  </Box>
                  {exp === baseline && <Typography sx={{ fontSize: 10, fontWeight: 600, color: '#4fc3f7', letterSpacing: 0.5, textAlign: 'center' }}>BASELINE</Typography>}
                </Box>
              );
            })}

            {/* ── RUN block ── */}
            {sectionHeader('Run')}
            {nameCell('Seed runs (N)', 'des-matrix-row-N')}
            {columns.map((exp) => (
              <Box key={exp.experiment} sx={{ px: 0.5, py: 0.25, bgcolor: colTint(exp), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.25 }}>
                <TextField size="small" value={exp.replicationCount}
                  data-testid={`des-matrix-N-${exp.experiment}`}
                  onChange={(e) => {
                    const n = Math.max(1, Math.floor(Number(e.target.value) || 1));
                    if (n !== exp.replicationCount) patchExp(exp.model, exp.experiment, { replicationCount: n });
                  }}
                  inputProps={{ inputMode: 'numeric', style: { padding: '2px 4px', fontSize: 11, width: 40, fontFamily: 'ui-monospace, monospace', textAlign: 'center' } }} />
                <Tooltip title="Show runs & checkpoints">
                  <IconButton size="small" sx={{ p: 0.15 }} data-testid={`des-matrix-drilldown-${exp.experiment}`}
                    onClick={() => setRunsExp(exp.experiment)}>
                    <ChevronRight sx={{ fontSize: 15 }} />
                  </IconButton>
                </Tooltip>
              </Box>
            ))}
            {nameCell('Sim end (DD:HH:MM:SS)')}
            {columns.map((exp) => (
              <Box key={exp.experiment} sx={{ px: 0.5, py: 0.25, bgcolor: colTint(exp), display: 'flex', alignItems: 'center' }}>
                <DurationCell value={exp.endTime} testId={`des-matrix-end-${exp.experiment}`}
                  onCommit={(seconds) => patchExp(exp.model, exp.experiment, { endTime: seconds })} />
              </Box>
            ))}
            {nameCell('Stat reset / warmup')}
            {columns.map((exp) => (
              <Box key={exp.experiment} sx={{ px: 0.5, py: 0.25, bgcolor: colTint(exp), display: 'flex', alignItems: 'center' }}>
                <DurationCell value={exp.statResetTime} testId={`des-matrix-warmup-${exp.experiment}`}
                  onCommit={(seconds) => patchExp(exp.model, exp.experiment, { statResetTime: seconds })} />
              </Box>
            ))}
            {nameCell('Status')}
            {columns.map((exp) => {
              const running = progress?.phase === 'running' && progress.exp === exp.experiment;
              const label = running ? `running ${progress!.replIndex}/${progress!.total}`
                : exp.runs.some((r) => r.status !== undefined) ? 'done' : 'idle';
              return (
                <Box key={exp.experiment} sx={{ px: 0.5, py: 0.3, bgcolor: colTint(exp), textAlign: 'center' }}>
                  <Typography sx={{ fontSize: 11, color: running ? '#4fc3f7' : 'text.secondary' }}>{label}</Typography>
                </Box>
              );
            })}

            {/* ── PARAMETERS block ── */}
            {sectionHeader('Parameters')}
            {paramRows.length === 0 && (
              <Box sx={{ gridColumn: '1 / -1', px: 1, py: 0.5 }}>
                <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                  No parameter overrides yet — edit a cell to make an experiment deviate from the baseline.
                </Typography>
              </Box>
            )}
            {paramRows.map((row) => {
              const def = rowDefault(row, columns);
              const ftype = inferFieldType(def);
              return (
                <Box key={row.key} sx={{ display: 'contents' }}>
                  {nameCell(`${row.component}.${row.field}`)}
                  {columns.map((exp) => {
                    const cell = row.cells.get(exp.experiment);
                    const overridden = cell?.overridden ?? false;
                    const diff = cell?.diffFromBaseline ?? false;
                    const val = overridden ? cell!.value : def;
                    return (
                      <Box key={exp.experiment} data-testid={`des-matrix-cell-${row.key}-${exp.experiment}`}
                        sx={{ px: 0.5, py: 0.2, bgcolor: diff ? 'rgba(255,167,38,0.16)' : colTint(exp),
                          opacity: overridden ? 1 : 0.55,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          borderLeft: diff ? '2px solid #ffa726' : 'none' }}>
                        <FieldEditor value={val} fieldType={ftype} fieldName={row.field}
                          onChange={(v) => setOverride(exp, row, v as MatrixValue)} />
                      </Box>
                    );
                  })}
                </Box>
              );
            })}

            {/* Add-parameter row — the parameter (path) lives in the row
                description: type dot notation OR pick from the "+" menu; the
                VALUE is then edited in the experiment cells like any row. */}
            <Box sx={{ position: 'sticky', left: 0, zIndex: 1, ...stickyGlass,
              px: 0.5, py: 0.25, borderRight: '1px solid rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', gap: 0.25 }}>
              <TextField size="small" fullWidth value={newParam}
                placeholder="Component.Field"
                onChange={(e) => { setNewParam(e.target.value); if (paramError) setParamError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') addParam(); }}
                inputProps={{ 'data-testid': 'des-matrix-add-param',
                  style: { fontFamily: 'ui-monospace, monospace', fontSize: 11, padding: '2px 6px' } }} />
              <Tooltip title="Pick a parameter from the model">
                <span>
                  <IconButton size="small" sx={{ p: 0.25 }} disabled={busy}
                    onClick={(e) => openParamMenu(e.currentTarget)} data-testid="des-matrix-add-param-pick">
                    <Add sx={{ fontSize: 15 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            <Box sx={{ gridColumn: '2 / -1', px: 0.75, py: 0.25, display: 'flex', alignItems: 'center' }}>
              <Typography sx={{ fontSize: 10.5, color: paramError ? '#ef5350' : 'text.secondary',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                data-testid="des-matrix-add-param-hint">
                {paramError ?? 'Add a parameter: pick via + or type e.g. DESSource.InterArrivalTime'}
              </Typography>
            </Box>
            <Menu anchorEl={paramMenuAnchor} open={!!paramMenuAnchor}
              onClose={() => setParamMenuAnchor(null)}
              MenuListProps={{ dense: true }} sx={{ zIndex: 2000 }}>
              {suggestions.length === 0 && (
                <MenuItem disabled sx={{ fontSize: 11.5 }}>No parameters found in the model</MenuItem>
              )}
              {suggestions.map((s) => (
                <MenuItem key={s.label} sx={{ fontSize: 11.5, fontFamily: 'ui-monospace, monospace', gap: 1 }}
                  data-testid={`des-matrix-suggest-${s.label}`}
                  onClick={() => { setParamMenuAnchor(null); addOverride(s); }}>
                  {s.label}
                  <Typography component="span" sx={{ fontSize: 10.5, fontFamily: 'inherit', color: 'text.secondary', ml: 'auto' }}>
                    {String(s.value)}
                  </Typography>
                </MenuItem>
              ))}
            </Menu>

            {/* Param script row (F4). */}
            {nameCell('Param script')}
            {columns.map((exp) => {
              const has = !!(exp.paramScript && exp.paramScript.trim());
              return (
                <Box key={exp.experiment} sx={{ px: 0.5, py: 0.25, bgcolor: colTint(exp), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Tooltip title={has ? 'Edit the parameter script (runs before each run)' : 'Add a parameter script (JS, setter-only)'}>
                    <Button size="small" variant={has ? 'contained' : 'outlined'}
                      data-testid={`des-matrix-script-${exp.experiment}`}
                      onClick={() => setScriptExp(exp.experiment)}
                      sx={{ fontSize: 10.5, minWidth: 0, px: 0.75, py: 0, height: 20 }}>
                      {has ? 'Edit script' : 'Script…'}
                    </Button>
                  </Tooltip>
                </Box>
              );
            })}

            {/* ── RESULTS block ── */}
            {sectionHeader('Results (KPI)')}
            {kpiRows.map((row: MatrixKpiRow) => (
              <Box key={row.key} sx={{ display: 'contents' }}>
                {nameCell(`${row.label}${row.unit ? ` (${row.unit})` : ''}`)}
                {columns.map((exp) => {
                  const cell = row.cells.get(exp.experiment)!;
                  const delta = cell.deltaFromBaseline;
                  // Green/red only when the KPI has a known polarity — a Δ on
                  // an ambiguous metric (e.g. utilization) renders neutral so
                  // the color never lies about good/bad.
                  const deltaColor = delta === null || row.higherIsBetter === undefined
                    ? 'text.secondary'
                    : (delta > 0) === row.higherIsBetter ? '#66bb6a' : '#ef5350';
                  return (
                    <Box key={exp.experiment} data-testid={`des-matrix-kpi-${row.key}-${exp.experiment}`}
                      sx={{ px: 0.5, py: 0.3, bgcolor: colTint(exp), display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      <Typography sx={{ fontSize: 11, fontFamily: 'monospace' }}>
                        {fmtKpi(cell.mean, cell.ci95, cell.empty)}
                      </Typography>
                      {delta !== null && Math.abs(delta) > 1e-9 && (
                        <Typography sx={{ fontSize: 10, fontFamily: 'monospace', color: deltaColor }}>
                          {delta > 0 ? '▲' : '▼'}{Math.abs(delta) >= 10 ? Math.abs(delta).toFixed(0) : Math.abs(delta).toFixed(1)}
                        </Typography>
                      )}
                    </Box>
                  );
                })}
              </Box>
            ))}

            {/* Snapshots row — newest checkpoints as revert links (F15 inline). */}
            {nameCell('Snapshots')}
            {columns.map((exp) => {
              const cps = exp.runs
                .flatMap((r) => r.checkpoints.map((cp) => ({ repl: r.index, t: cp.simTime })))
                .sort((a, b) => b.t - a.t);
              const shown = cps.slice(0, 3);
              return (
                <Box key={exp.experiment} data-testid={`des-matrix-snapshots-${exp.experiment}`}
                  sx={{ px: 0.5, py: 0.3, bgcolor: colTint(exp), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.1 }}>
                  {cps.length === 0 && <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>—</Typography>}
                  {shown.map((s) => (
                    <Box key={`${s.repl}-${s.t}`} component="button" type="button"
                      onClick={() => loadSnapshotAt(exp, s.repl, s.t)}
                      data-testid={`des-matrix-snap-${exp.experiment}-${s.repl}-${s.t}`}
                      title={`Load this snapshot into the live sim (run #${s.repl}, step mode)`}
                      sx={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, fontFamily: 'ui-monospace, monospace',
                        color: '#4fc3f7', '&:hover': { textDecoration: 'underline' } }}>
                      ⏱ {formatSimClock(s.t)}
                    </Box>
                  ))}
                  {cps.length > shown.length && (
                    <Box component="button" type="button" onClick={() => setRunsExp(exp.experiment)}
                      sx={{ all: 'unset', cursor: 'pointer', fontSize: 10.5, color: 'text.secondary',
                        '&:hover': { textDecoration: 'underline' } }}>
                      all {cps.length}…
                    </Box>
                  )}
                </Box>
              );
            })}

            {/* Run row — the per-experiment action, a real button at the very
                BOTTOM of its column. */}
            {nameCell('')}
            {columns.map((exp) => {
              const running = progress?.phase === 'running' && progress.exp === exp.experiment;
              const noEnd = exp.endTime <= 0;
              return (
                <Box key={exp.experiment} sx={{ px: 0.5, py: 0.6, bgcolor: colTint(exp), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {running ? (
                    <Typography sx={{ fontSize: 11, fontFamily: 'monospace', color: '#4fc3f7' }}>
                      running {progress!.replIndex}/{progress!.total}
                    </Typography>
                  ) : (
                    <Tooltip title={noEnd ? 'Set "Sim end" first — a run needs a finite end time'
                      : `Run ${exp.replicationCount} replication${exp.replicationCount > 1 ? 's' : ''}`}>
                      <span>
                        <Button size="small" variant="outlined" startIcon={<PlayArrow sx={{ fontSize: 14 }} />}
                          disabled={busy || noEnd}
                          data-testid={`des-matrix-run-${exp.experiment}`} onClick={() => runOne(exp)}
                          sx={{ fontSize: 10.5, py: 0, minWidth: 84, px: 1, height: 24 }}>
                          Run{exp.replicationCount > 1 ? ` ${exp.replicationCount}×` : ''}
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>

          {/* "New experiment" — the LAST column is the add affordance. */}
          <Box sx={{ px: 0.75, py: 0.5, position: 'sticky', top: 0 }}>
            <Tooltip title="New experiment — snapshots the current model state as a new column">
              <span>
                <Button size="small" disabled={busy} onClick={createExperiment} data-testid="des-matrix-new"
                  startIcon={<Add sx={{ fontSize: 14 }} />}
                  sx={{ fontSize: 10.5, whiteSpace: 'nowrap', color: 'text.secondary',
                    border: '1px dashed rgba(255,255,255,0.25)', px: 1, py: 0.25,
                    '&:hover': { color: '#4fc3f7', borderColor: '#4fc3f7' } }}>
                  New experiment
                </Button>
              </span>
            </Tooltip>
          </Box>
          </Box>
        )}
      </Box>
    </FloatingPanel>
    {drillExp && (
      <RunsDrilldown exp={drillExp} ctl={ctl} onAction={() => void refresh()} onClose={() => setRunsExp(null)} />
    )}
    {editScriptExp && (
      <ParamScriptEditor exp={editScriptExp} onClose={() => setScriptExp(null)}
        onSave={(source) => patchExp(editScriptExp.model, editScriptExp.experiment, { paramScript: source })} />
    )}
    </>
  );
}
