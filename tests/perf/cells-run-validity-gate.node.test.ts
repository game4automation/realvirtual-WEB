// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-492 §9.5 — the cell-matrix run-validity gate and its configuration check.
 *
 * The line scenario's gate asks "did the line reach steady state". A cell matrix
 * has no steady state; what it has to prove instead is that the scene it
 * measured is the scene it claims. Every check below corresponds to a way a
 * report could look perfectly reasonable while measuring something else:
 *
 *  - a missing placement (a materialisation that threw and was swallowed),
 *  - a second bake of the same asset (the cache key changed under us),
 *  - a sensor still in the manager list (F2b — measurable work nobody asked for),
 *  - `pickOk === false` (a chunk published without its pick structure would be
 *    brute-forced, so the picking numbers would measure something else),
 *  - zero pick samples reported as "0 ms",
 *  - two repetitions that do not agree.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateCellValidity,
  validateCellsConfig,
  findKnees,
  summariseCell,
  renderCellsMarkdown,
  CELL_P50_TOLERANCE,
  // @ts-expect-error — plain .mjs runner library, no type declarations
} from '../../scripts/lib/perf-cells-report.mjs';

interface RunShape { cellMatrix?: Record<string, unknown>; probe?: unknown; pick?: { samples: number } }

const matrix = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  placements: 16, bakes: 2, activeSensors: 0, pickOk: true,
  materializeMs: 120, bvhWaitMs: 40, bakeMs: { a: 100, b: 20 },
  chunks: 7, chunkMeshes: 64, dynamic: 100, total: 400, ...over,
});

const run = (p50: number, over: Record<string, unknown> = {}, extra: Partial<RunShape> = {}): RunShape => ({
  cellMatrix: matrix(over),
  probe: { frameMs: { p50, p95: p50 * 1.5, p99: p50 * 2 } },
  ...extra,
});

const cell = (runs: RunShape[]): Record<string, unknown> =>
  ({ cells: 4, conv: 3, motion: 'none', renderer: 'webgl', label: 'cells=4', runs });

describe('cell-matrix run-validity gate (plan-492 R8/R10)', () => {
  it('accepts a cell whose scene is what it claims', () => {
    const verdict = evaluateCellValidity(cell([run(10), run(10.5)]));
    expect(verdict.valid, verdict.reason).toBe(true);
    expect(verdict.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
  });

  it('rejects a wrong placement count', () => {
    const verdict = evaluateCellValidity(cell([run(10, { placements: 15 })]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/placements\[0\]: 15 of 16/);
  });

  it('rejects a second bake of the same asset', () => {
    const verdict = evaluateCellValidity(cell([run(10, { bakes: 3 })]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/bakes\[0\]/);
  });

  it('rejects a ticking sensor', () => {
    const verdict = evaluateCellValidity(cell([run(10, { activeSensors: 4 })]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/4 sensors still in the manager list/);
  });

  it('rejects an incomplete pick structure even though the run "passed"', () => {
    const verdict = evaluateCellValidity(cell([run(10, { pickOk: false })]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/pick\[0\]/);
  });

  // Persisted reports from before plan-756 carry `bvhOk`; the gate must still
  // grade them instead of failing every historical run on a missing field.
  it('still reads the pre-plan-756 `bvhOk` spelling of persisted reports', () => {
    const legacy = matrix({ bvhOk: true });
    delete legacy.pickOk;
    expect(evaluateCellValidity(cell([{ ...run(10), cellMatrix: legacy }])).valid).toBe(true);
    const legacyBad = matrix({ bvhOk: false });
    delete legacyBad.pickOk;
    const verdict = evaluateCellValidity(cell([{ ...run(10), cellMatrix: legacyBad }]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/pick\[0\]/);
  });

  it('rejects repetitions that do not agree', () => {
    const over = 10 * (1 + CELL_P50_TOLERANCE * 2);
    const verdict = evaluateCellValidity(cell([run(10), run(over)]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/repeatability/);
  });

  it('counts zero pick samples as a failure, not as "0 ms"', () => {
    const withPick = cell([run(10, {}, { pick: { samples: 0 } })]);
    expect(evaluateCellValidity(withPick, { requirePick: true }).valid).toBe(false);
    const ok = cell([run(10, {}, { pick: { samples: 20 } })]);
    expect(evaluateCellValidity(ok, { requirePick: true }).valid).toBe(true);
  });

  it('rejects a cell that produced no cellMatrix at all', () => {
    const verdict = evaluateCellValidity(cell([{ probe: {} } as RunShape]));
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toMatch(/no run produced a cellMatrix/);
  });

  it('takes the expected asset count as a parameter (R8: a future unbaked path)', () => {
    expect(evaluateCellValidity(cell([run(10, { bakes: 2 })]), { expectedAssets: 2 }).valid).toBe(true);
    expect(evaluateCellValidity(cell([run(10, { bakes: 2 })]), { expectedAssets: 3 }).valid).toBe(false);
  });
});

describe('cells scenario configuration check', () => {
  const cfg = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ cells: [4], conv: [3], motion: ['none'], allowLarge: false, raw: {}, ...over });

  it('accepts the default sweep', () => {
    expect(validateCellsConfig(cfg({ cells: [1, 4, 16, 64] })).ok).toBe(true);
  });

  it('refuses line axes instead of ignoring them', () => {
    const res = validateCellsConfig(cfg({ raw: { mu: '2400', sensors: '4' } }));
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/--mu belongs to the line scenario/);
    expect(res.errors.join(' ')).toMatch(/--sensors belongs to the line scenario/);
  });

  it('refuses cells=0 and non-integer counts', () => {
    expect(validateCellsConfig(cfg({ cells: [0] })).ok).toBe(false);
    expect(validateCellsConfig(cfg({ cells: [2.5] })).ok).toBe(false);
    expect(validateCellsConfig(cfg({ cells: [Number.NaN] })).ok).toBe(false);
    expect(validateCellsConfig(cfg({ conv: [0] })).ok).toBe(false);
  });

  it('needs --allow-large above 64 cells', () => {
    expect(validateCellsConfig(cfg({ cells: [256] })).ok).toBe(false);
    expect(validateCellsConfig(cfg({ cells: [256], allowLarge: true })).ok).toBe(true);
    expect(validateCellsConfig(cfg({ cells: [64] })).ok).toBe(true);
  });

  it('refuses an unknown motion mode', () => {
    const res = validateCellsConfig(cfg({ motion: ['sideways'] }));
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toMatch(/not one of none, conveyor, robot, all, sparse/);
  });
});

describe('cells report', () => {
  const build = (): Array<Record<string, unknown>> => {
    const cells = [
      { cells: 1, conv: 3, motion: 'all', renderer: 'webgl', label: 'cells=1', runs: [run(8)] },
      { cells: 4, conv: 3, motion: 'all', renderer: 'webgl', label: 'cells=4', runs: [run(12)] },
      { cells: 16, conv: 3, motion: 'all', renderer: 'webgl', label: 'cells=16', runs: [run(30)] },
    ];
    for (const c of cells) { summariseCell(c); (c as { validity?: unknown }).validity = evaluateCellValidity(c); }
    return cells;
  };

  it('finds the knee per motion mode', () => {
    // p95 = p50 * 1.5 → 12, 18, 45: the 60 Hz budget breaks at 4 cells, 30 Hz at 16.
    const knees = findKnees(build());
    expect(knees).toEqual([{ motion: 'all', knee60: 4, knee30: 16 }]);
  });

  it('renders both tables and names the invalid rows', () => {
    const cells = build();
    (cells[2].runs as RunShape[])[0].cellMatrix!.activeSensors = 2;
    (cells[2] as { validity?: unknown }).validity = evaluateCellValidity(cells[2]);
    const md = renderCellsMarkdown('| host | test |', cells, { scenario: 'cells' });
    expect(md).toContain('## Cell matrix (placements)');
    expect(md).toContain('## Cost per placement');
    expect(md).toContain('## Knee');
    expect(md).toContain('## Invalid cells');
    expect(md).toMatch(/cells=16.*sensors still in the manager list/);
  });

  it('warns loudly when a SwiftShader row is present', () => {
    const cells = build();
    (cells[0] as { summary: { gpu: string } }).summary.gpu = 'swiftshader';
    const md = renderCellsMarkdown('| host | test |', cells, {});
    expect(md).toContain('CPU BASELINE');
  });
});
