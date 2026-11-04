// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { CommandError, type CommandContext, type CommandEnabled, type CommandImpl } from '../hmi/rv-command-registry';
import { getProblems, type ProblemEntry } from '../hmi/problems-store';
import { computeDesRunState, serializeDesRunStatus } from '../material-flow/rv-des-run-state';
import { getDefaultAgvFleet } from '../engine/rv-agv-fleet';
import { readFleetStatus, type VehicleStatus } from '../fleet/fleet-status';
import { checkDesStatsSanity } from './rv-des-stats-sanity';
import type { SimDesControl } from '../material-flow/simulation-kernel';

function desEnabled(ctx: CommandContext): CommandEnabled {
  return ctx.viewer.simulationKernel?.desControl?.() != null
    ? true : { reason: 'not in DES mode', details: { hint: "web_execute(\"workspace.setMode\", {mode:\"des\"})" } };
}

const jsonNumber = (n: number): number | string => Number.isFinite(n) ? n : String(n);
const boundedLimit = (n: number | undefined, fallback: number, max: number): number =>
  n == null || !Number.isFinite(n) ? fallback : Math.max(1, Math.min(max, Math.floor(n)));

function readDesStatus(viewer: CommandContext['viewer'], ctl: SimDesControl) {
  return {
    ...serializeDesRunStatus(computeDesRunState(ctl, {
      simulationPaused: viewer.isSimulationPaused, pauseReasons: viewer.simulationPauseReasons,
    })),
    subMode: ctl.subMode, multiplier: jsonNumber(ctl.multiplier),
    statResetTime: jsonNumber(ctl.statResetTime ?? 0),
  };
}

export const desStatus: CommandImpl = {
  enabled: desEnabled,
  run: ({ viewer }) => readDesStatus(viewer, viewer.simulationKernel!.desControl()!),
};

export interface DesEventsArgs { limit?: number; component?: string; action?: string }
export const desEvents: CommandImpl<DesEventsArgs> = {
  enabled: desEnabled,
  run({ viewer }, { limit, component, action }) {
    const ctl = viewer.simulationKernel!.desControl()!;
    if (!ctl.peekEvents) return { ok: false, reason: 'runner-without-event-peek' };
    return { ...ctl.peekEvents(boundedLimit(limit, 20, 200), { component: component ?? undefined, action: action ?? undefined }), simTime: jsonNumber(ctl.simTime) };
  },
};

export interface ProblemsListArgs { severity?: string; code?: string; node?: string; limit?: number }
const severityOrder = { error: 0, warning: 1, info: 2 };

export function filterProblems(entries: readonly ProblemEntry[], args: ProblemsListArgs) {
  const severity = args.severity?.toLowerCase();
  if (severity != null && severity !== 'error' && severity !== 'warning' && severity !== 'info') {
    throw new CommandError('Invalid severity: allowed values error|warning|info');
  }
  const counts = { error: 0, warning: 0, info: 0 };
  for (const entry of entries) counts[entry.severity]++;
  const node = args.node?.toLowerCase();
  const filtered = entries.filter(p =>
    (severity == null || p.severity === severity)
    && (args.code == null || p.code.startsWith(args.code))
    && (node == null || (p.nodePath !== undefined && p.nodePath.toLowerCase().includes(node))));
  filtered.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    || a.at - b.at || (a.id < b.id ? -1 : a.id === b.id ? 0 : 1));
  const limit = boundedLimit(args.limit, 100, 500);
  return {
    problems: filtered.slice(0, limit).map(({ id, code, severity, title, detail, nodePath, at, quiet }) =>
      ({ id, code, severity, title, detail, nodePath, at, quiet: quiet === true })),
    counts, total: filtered.length, truncated: filtered.length > limit,
  };
}

export const problemsList: CommandImpl<ProblemsListArgs> = {
  enabled: () => true,
  run: (_ctx, args) => filterProblems(getProblems(), args),
};

/** Reader for a viewer without a signal store: every vehicle falls back to its handle. */
const NO_SIGNALS = { get: () => undefined };

export interface FleetStatusArgs { vehicle?: string; state?: string }
export function filterFleetStatus(vehicles: readonly VehicleStatus[], args: FleetStatusArgs) {
  const counts = { free: 0, order: 0, handling: 0, charging: 0, fault: 0, idle: 0 };
  const state = args.state?.toLowerCase();
  if (state != null && !Object.prototype.hasOwnProperty.call(counts, state)) {
    throw new CommandError('Invalid state: allowed values free|order|handling|charging|fault|idle');
  }
  for (const v of vehicles) counts[v.state]++;
  const vehicle = args.vehicle?.toLowerCase();
  return { vehicles: vehicles.filter(v => (vehicle == null || v.id.toLowerCase().includes(vehicle))
    && (state == null || v.state === state)), counts };
}

export const fleetStatus: CommandImpl<FleetStatusArgs> = {
  enabled: () => true,
  run: ({ viewer }, args) => filterFleetStatus(readFleetStatus(getDefaultAgvFleet(), viewer.signalStore ?? NO_SIGNALS), args),
};

interface DiagnoseSummaryInput {
  blockage?: { deadlock: number; stall: number; coverage: { missing: number; expected: number } };
  run: ReturnType<typeof serializeDesRunStatus>;
  faulted: { vehicles: readonly Pick<VehicleStatus, 'id' | 'faultReason'>[] };
  statsSanity: ReturnType<typeof checkDesStatsSanity> | null;
  problems: { counts: { error: number; warning: number; info: number } };
}

function formatRunTime(value: number | string): string {
  if (typeof value === 'string' || !Number.isFinite(value)) return String(value);
  const seconds = Math.max(0, Math.floor(value));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(n => String(n).padStart(2, '0')).join(':');
}

export function buildDiagnoseSummary({ run, faulted, statsSanity, problems, blockage }: DiagnoseSummaryInput): string[] {
  const time = formatRunTime(run.simTime);
  const end = formatRunTime(run.endTime);
  const sentences = {
    finished: run.reason === 'queue-drained' ? `Run finished: model event queue drained at ${time} (not blocked).`
      : `Run finished: end time ${end} reached (not blocked).`,
    stalled: `Run stalled: no more model events at ${time}, before the end time ${end}.`,
    paused: `Run paused at ${time}.`, running: `Run running at ${time}.`,
    idle: 'Run idle: not started.', 'not-des': 'Not in DES mode.',
  };
  const summary = [sentences[run.runState]];
  const vehicles = faulted.vehicles;
  if (vehicles.length) summary.push(`${vehicles.length} ${vehicles.length === 1 ? 'vehicle' : 'vehicles'} in fault: `
    + vehicles.slice(0, 3).map(v => `${v.id} – ${v.faultReason ?? 'fault'}`).join(', ')
    + (vehicles.length > 3 ? ', …' : '.'));
  if (statsSanity && !statsSanity.ok) {
    const n = new Set(statsSanity.issues.map(i => i.path)).size;
    const onlyOver = statsSanity.issues.every(i => i.rule === 'over-100' || i.rule === 'shares-over-100' || i.rule === 'utilization-over-100');
    summary.push(`Statistics implausible: ${n} ${n === 1 ? 'component' : 'components'} ${onlyOver ? 'over 100 %' : 'with invalid values'}.`);
  }
  const { error, warning, info } = problems.counts;
  const total = error + warning + info;
  if (total) summary.push(`${total} ${total === 1 ? 'problem' : 'problems'} (${error} ${error === 1 ? 'error' : 'errors'}).`);
  if (blockage) {
    summary.push(`Deadlock: ${blockage.deadlock} findings.`);
    summary.push(`Stall: ${blockage.stall} findings.`);
    summary.push(`Coverage: ${blockage.coverage.missing} of ${blockage.coverage.expected} units are not observed.`);
  }
  return summary;
}

export const diagnose: CommandImpl = {
  enabled: () => true,
  run(ctx) {
    const { viewer } = ctx;
    const ctl = viewer.simulationKernel?.desControl?.() ?? null;
    const run = ctl ? readDesStatus(viewer, ctl)
      : serializeDesRunStatus(computeDesRunState(null, { simulationPaused: false, pauseReasons: [] }));
    const problems = filterProblems(getProblems(), { limit: 10 });
    const vehicles = readFleetStatus(getDefaultAgvFleet(), viewer.signalStore ?? NO_SIGNALS);
    const fleet = { counts: filterFleetStatus(vehicles, {}).counts, total: vehicles.length };
    const stats = ctl?.statistics?.();
    const faulted = {
      components: (stats?.components ?? []).filter(c => c.currentState === 'Failure').map(({ path, name }) => ({ path, name })),
      vehicles: vehicles.filter(v => v.state === 'fault').map(({ id, faultReason }) => ({ id, faultReason })),
    };
    const statsSanity = stats ? checkDesStatsSanity(stats) : null;
    // Diagnose is itself an on-demand read: use a fresh checker result when a model is loaded.
    const blockageReport = viewer.progressLedger ? viewer.blockageWatch?.inspect() : null;
    return { summary: buildDiagnoseSummary({ run, problems, faulted, statsSanity,
      blockage: viewer.blockageWatch && (blockageReport || viewer.blockageWatch.status().on || viewer.blockageWatch.lastReport)
        ? viewer.blockageWatch.counters(blockageReport ?? viewer.blockageWatch.lastReport) : undefined }), run, problems, faulted, fleet, statsSanity };
  },
};
