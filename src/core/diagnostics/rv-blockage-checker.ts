// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { ProgressLedger, Coverage } from './rv-progress-ledger';
import type { WaitRegistry, WaitEdge } from './rv-wait-registry';
import type { BudgetResolver } from './rv-blockage-budget';
import { probeBlockages, type BlockageFinding } from './rv-blockage-probes';

export interface BlockageReport {
  findings: readonly BlockageFinding[];
  coverage: Coverage;
  atSec: number;
  waitGraph?: readonly WaitEdge[];
}
export interface BlockageCheckerContext {
  ledger: ProgressLedger; registry: WaitRegistry; budgets: BudgetResolver; now: number;
  idleSec?: number;
  /** Inspect existing instrumentation without sampling adapters, history or signal writes. */
  readOnly?: boolean;
  waitGraph?: boolean;
}
export function runBlockageChecker(ctx: BlockageCheckerContext): BlockageReport {
  const { ledger, registry, budgets, now } = ctx;
  // Zero is only the cheap sampling floor: each unit's inherited threshold follows.
  const sampled = ledger.sample(ctx.idleSec ?? 0, now, ctx.readOnly);
  const candidates = sampled.candidates.filter(e => {
    const b = budgets.resolve(e.unitId);
    return !b.Exempt && !b.suppressed && now >= b.WarmupSec && now - e.lastChangeSec >= b.MaxIdleSec;
  });
  const edges = candidates.length || ctx.waitGraph ? registry.collect(now, ctx.readOnly) : [];
  const expected = new Set(candidates.filter(e => {
    const b = budgets.resolve(e.unitId);
    return edges.some(edge => edge.waiterId === e.unitId && budgets.isExpectedWait(b, edge.kind));
  }).map(e => e.unitId));
  // Classification is local to this sample: never overwrite adapter-owned lifecycle state.
  const coverage = { ...sampled.coverage, armed: sampled.coverage.armed - expected.size,
    inactive: sampled.coverage.inactive + expected.size };
  const findings = probeBlockages({ candidates: candidates.filter(e => !expected.has(e.unitId)), edges, budgets, now });
  if (!ctx.readOnly && findings.length) ledger.lastFindings = structuredClone(findings);
  if (!ctx.readOnly) budgets.publishFindings(findings.flatMap(f => f.cycles
    ? f.cycles.flatMap(c => c.filter((_, i) => i % 2 === 0)) : [f.waiterId]), now);
  return { findings, coverage, atSec: now, ...(ctx.waitGraph ? { waitGraph: edges } : {}) };
}
