// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { runBlockageChecker, type BlockageCheckerContext, type BlockageReport } from './rv-blockage-checker';
import { blockageProblemId, BLOCKAGE_PROBLEM_CODES, clearBlockageProblems, clearProblem, getProblems,
  reportProblem } from '../hmi/problems-store';

export type BlockageSnapshot = BlockageReport & { exempt: number };
export const EMPTY_BLOCKAGE_COVERAGE = { expected: 0, registered: 0, armed: 0, complete: 0, inactive: 0,
  bySource: {}, missing: [], unknown: [], coverageComplete: true } as const;

/** Viewer-owned lifetime; only sample() and setOn() publish Problems/signals. */
export class BlockageWatch {
  private on = false;
  private since: number | null = null;
  lastReport: BlockageSnapshot | null = null;
  constructor(private readonly context: () => BlockageCheckerContext | null,
    readonly sampleEverySec = 1) {}

  status() { return { on: this.on, sampleEverySec: this.sampleEverySec, since: this.since }; }
  inspect(): BlockageSnapshot {
    const ctx = this.context();
    return ctx ? { ...runBlockageChecker({ ...ctx, readOnly: true }), exempt: ctx.budgets.exemptSubtrees() }
      : { findings: [], coverage: { ...EMPTY_BLOCKAGE_COVERAGE }, atSec: 0, exempt: 0 };
  }
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.since = on ? this.context()?.now ?? 0 : null;
    if (!on) {
      clearBlockageProblems();
      const ctx = this.context();
      ctx?.budgets.publishFindings([], ctx.now);
    }
  }
  sample(): void {
    if (!this.on) return;
    const ctx = this.context();
    if (!ctx) return;
    const report = this.inspect();
    this.lastReport = report;
    if (report.findings.length) ctx.ledger.lastFindings = structuredClone(report.findings);
    this.publishReport(report);
  }
  private publishReport(report: BlockageSnapshot, signals = true): void {
    const ctx = this.context();
    if (!ctx) return;
    if (signals) ctx.budgets.publishFindings(report.findings.flatMap(f => f.cycles
      ? f.cycles.flatMap(c => c.filter((_, i) => i % 2 === 0)) : [f.waiterId]), ctx.now);
    const active = new Set<string>();
    for (const f of report.findings) {
      const id = blockageProblemId(f.cls, f.waiterId);
      active.add(id);
      const budget = ctx.budgets.resolve(f.waiterId);
      const nodePath = ctx.budgets.nodePath(f.chain[0]) ?? f.nodePath;
      const members = new Set((f.cycles ?? [f.chain]).flatMap(c => c.filter((_, i) => i % 2 === 0)));
      reportProblem({ id, code: BLOCKAGE_PROBLEM_CODES[f.cls],
        severity: f.cls === 'deadlock' ? 'error' : budget.Severity,
        title: f.cls === 'deadlock' ? `Deadlock: ${members.size} vehicles wait in a circle`
          : `Stall: ${f.waiterId} makes no progress`,
        detail: [`Class: ${f.cls}`, `Chain: ${f.chain.join(' -> ')}`,
          `Idle: ${f.idleSec} s (budget ${budget.MaxIdleSec} s; wait budget ${budget.MaxWaitSec} s)`,
          `Budget: ${f.budgetSource}`, ...f.checks.map(c => `${c.name}: ${c.ok ? 'ok' : 'failed'} - ${c.detail}`)].join('\n'),
        nodePath, ...(nodePath ? { action: { label: 'Go to node', commandId: 'selection.select',
          args: { path: nodePath, frame: true } } } : {}),
      });
    }
    const { coverage } = report;
    if (coverage.missing.length) {
      const id = blockageProblemId('coverage', 'model');
      active.add(id);
      reportProblem({ id, code: BLOCKAGE_PROBLEM_CODES.coverage, severity: 'info',
        title: `Coverage: ${coverage.missing.length} of ${coverage.expected} units are not observed`,
        detail: `Class: coverage\nMissing: ${coverage.missing.join(', ')}` });
    }
    for (const p of getProblems()) {
      if (Object.values(BLOCKAGE_PROBLEM_CODES).some(code => code === p.code) && !active.has(p.id)) clearProblem(p.id);
    }
  }
  /** Capture only at checkpoint boundaries; model budget declarations remain services. */
  snapshotState() {
    const ctx = this.context();
    if (!ctx) throw new Error('diag.blockage: context unavailable');
    const ledger = ctx.ledger.snapshotState();
    const budgets = ledger.entries.map(([id]) => {
      const b = ctx.budgets.resolve(id);
      return { id, MaxWaitSec: b.MaxWaitSec, MaxIdleSec: b.MaxIdleSec, WarmupSec: b.WarmupSec,
        ExpectedWaits: [...b.ExpectedWaits], ExpectFlow: b.ExpectFlow, Severity: b.Severity,
        Exempt: b.Exempt, Scope: b.Scope, budgetSource: b.budgetSource, sources: b.sources, suppressed: b.suppressed };
    });
    return { on: this.on, since: this.since, lastReport: this.lastReport, ledger, budgets };
  }
  prepareSnapshot(state: ReturnType<BlockageWatch['snapshotState']>) {
    if (!this.context()) throw new Error('diag.blockage: context unavailable');
    if (typeof state.on !== 'boolean' || (state.since !== null && !Number.isFinite(state.since))
      || !Array.isArray(state.ledger.entries) || !Array.isArray(state.budgets))
      throw new Error('diag.blockage: invalid state');
    for (const [id, entry] of state.ledger.entries) {
      if (id !== entry.unitId || !Number.isFinite(entry.count) || !Number.isFinite(entry.lastChangeSec)
        || !Number.isFinite(entry.firstSeenSec) || !['armed', 'complete', 'inactive'].includes(entry.state))
        throw new Error('diag.blockage: invalid ledger');
    }
    // Budgets are model configuration, checked before commit rather than overwritten.
    const ctx = this.context()!;
    for (const b of state.budgets) {
      const current = ctx.budgets.resolve(b.id);
      for (const key of ['MaxWaitSec', 'MaxIdleSec', 'WarmupSec', 'ExpectedWaits', 'ExpectFlow',
        'Severity', 'Exempt', 'Scope', 'budgetSource', 'sources'] as const)
        if (JSON.stringify(current[key]) !== JSON.stringify(b[key])) throw new Error(`diag.blockage: budget changed for ${b.id}`);
    }
    return state;
  }
  restoreSnapshot(state: ReturnType<BlockageWatch['snapshotState']>): void {
    const ctx = this.context()!;
    this.on = state.on; this.since = state.since; this.lastReport = state.lastReport;
    ctx.ledger.restoreState(state.ledger);
    clearBlockageProblems();
    if (this.on && this.lastReport) this.publishReport(this.lastReport, false);
  }

  reset(keepOn = false): void {
    const restart = keepOn && this.on;
    this.setOn(false);
    clearBlockageProblems();
    this.lastReport = null;
    if (restart) this.setOn(true);
  }
  counters(report: BlockageSnapshot | null = this.context() ? this.inspect() : this.lastReport) {
    const coverage = report?.coverage ?? this.context()?.ledger.sample(0, undefined, true).coverage ?? EMPTY_BLOCKAGE_COVERAGE;
    return { deadlock: report?.findings.filter(f => f.cls === 'deadlock').length ?? 0,
      stall: report?.findings.filter(f => f.cls === 'stall').length ?? 0,
      coverage: { expected: coverage.expected, registered: coverage.registered, armed: coverage.armed,
        missing: coverage.missing.length } };
  }
}
