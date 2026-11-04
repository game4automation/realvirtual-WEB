// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { runBlockageChecker, type BlockageCheckerContext } from '../../src/core/diagnostics/rv-blockage-checker';
import type { BlockageFinding } from '../../src/core/diagnostics/rv-blockage-probes';

/** Structural viewer shape: no runtime viewer/DOM import needed by node tests. */
export interface BlockageViewer {
  readonly progressLedger: BlockageCheckerContext['ledger'] | null;
  readonly waitRegistry: BlockageCheckerContext['registry'] | null;
  readonly blockageBudgets: BlockageCheckerContext['budgets'] | null;
  readonly simTime: number;
}
export interface ExpectNoBlockageOptions {
  /** Sampling floor, as in runBlockageChecker; does not override model budgets. */
  idleSec?: number;
  allow?: (finding: BlockageFinding) => boolean;
  requireCoverage?: boolean;
}

/** Assert the current run before reset/dispose; this is not a historical timeout check. */
export function expectNoBlockage(
  target: BlockageViewer | BlockageCheckerContext, opts: ExpectNoBlockageOptions = {},
): void {
  let ctx: BlockageCheckerContext;
  if ('ledger' in target) ctx = target;
  else {
    const { progressLedger: ledger, waitRegistry: registry, blockageBudgets: budgets, simTime: now } = target;
    if (!ledger || !registry || !budgets) throw new Error('expectNoBlockage: viewer blockage instrumentation is not initialized');
    ctx = { ledger, registry, budgets, now };
  }
  const report = runBlockageChecker({ ...ctx, idleSec: opts.idleSec ?? ctx.idleSec });
  const failures = report.findings.filter(f => !opts.allow?.(f)).map(f => {
    const budget = ctx.budgets.resolve(f.waiterId);
    return `${f.cls}: ${f.chain.join(' -> ')}\n`
      + `  idle ${f.idleSec} s vs budget ${budget.MaxIdleSec} s (${f.budgetSource}); progress ${f.progressCount}\n`
      + f.checks.map(c => `  ${c.name}: ${c.ok ? 'ok' : 'not ok'} — ${c.detail}`).join('\n');
  });
  if (opts.requireCoverage && report.coverage.missing.length) {
    failures.push(`coverage missing: ${report.coverage.missing.join(', ')} (${report.coverage.registered}/${report.coverage.expected} registered)`);
  }
  if (failures.length) throw new Error(`expectNoBlockage at ${report.atSec} s:\n${failures.join('\n')}`);
}
