// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Report + run-validity gate of the cell-matrix scenario (plan-492 Phase 3).
 *
 * Kept out of `perf-scale-matrix.mjs` on purpose: that file is 785 lines of line
 * scenario already, and the two scenarios share the runner, not the grading. The
 * cell gate asks completely different questions from the line gate — the line
 * asks "did it reach steady state", the cell matrix has no steady state to
 * reach and instead has to prove that THE SCENE IT MEASURED IS THE SCENE IT
 * CLAIMS: one bake per asset, `cells × (k+1)` placements, no sensors ticking, a
 * complete BVH, real pick samples, and two repetitions that agree.
 *
 * Everything here is pure: cells in, markdown/verdict out. That is what makes
 * `tests/perf/run-validity-gate.test.ts` able to test the gate without a browser.
 */

/** A repetition's p50 may differ from its neighbour by at most this much. */
export const CELL_P50_TOLERANCE = 0.10;
/** Frame-time budgets the knee is read against. */
export const KNEE_60HZ_MS = 16.7;
export const KNEE_30HZ_MS = 33.3;

/**
 * Refuse a configuration the cell scenario cannot honour — loudly, before a
 * browser is started. Exported shape (`{ ok, errors }`) so the gate test can
 * exercise every branch without a run.
 */
export function validateCellsConfig(cfg) {
  const errors = [];
  const CONFLICTING = ['mu', 'sensors', 'load', 'geometry', 'muasset', 'robots', 'robotmotion', 'lanes', 'segments', 'seglen', 'plcs'];
  for (const key of CONFLICTING) {
    if (cfg.raw?.[key] !== undefined) {
      errors.push(`--${key} belongs to the line scenario; --scenario cells has no material flow to apply it to`);
    }
  }
  for (const n of cfg.cells) {
    if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) errors.push(`--cells must be whole numbers >= 1 (got "${n}")`);
    else if (n > 64 && !cfg.allowLarge) errors.push(`--cells ${n} needs --allow-large (a 256-cell build can take minutes and megabytes)`);
  }
  for (const k of cfg.conv) {
    if (!Number.isFinite(k) || k < 1 || !Number.isInteger(k)) errors.push(`--cellconv must be whole numbers >= 1 (got "${k}")`);
  }
  const MOTIONS = ['none', 'conveyor', 'robot', 'all', 'sparse'];
  for (const m of cfg.motion) {
    if (!MOTIONS.includes(m)) errors.push(`--cellmotion "${m}" is not one of ${MOTIONS.join(', ')}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Grade ONE cell of the matrix.
 *
 * `expectedAssets` is 2 for the production path (conveyor + robot). A future
 * unbaked reference path would place the same assets through a different
 * pipeline, so the count is a parameter rather than a constant (plan-492 R8).
 *
 * @returns {{valid: boolean, checks: Array<{name: string, ok: boolean, detail: string}>, reason?: string}}
 */
export function evaluateCellValidity(cell, { expectedAssets = 2, requirePick = false } = {}) {
  const checks = [];
  const runs = (cell.runs ?? []).filter((r) => r && r.cellMatrix);
  const add = (name, ok, detail) => { checks.push({ name, ok, detail }); };

  if (runs.length === 0) {
    return { valid: false, checks, reason: 'no run produced a cellMatrix report' };
  }

  const expectedPlacements = cell.cells * (cell.conv + 1);
  for (const [i, run] of runs.entries()) {
    const m = run.cellMatrix;
    add(`placements[${i}]`, m.placements === expectedPlacements,
      `${m.placements} of ${expectedPlacements} (= ${cell.cells} x (${cell.conv} + 1))`);
    add(`bakes[${i}]`, m.bakes === expectedAssets, `${m.bakes} of ${expectedAssets} distinct assets`);
    // A ticking sensor is measurable work that the configuration does not
    // describe — "a conveying lane" is the experiment, not a sensor farm.
    add(`sensors[${i}]`, m.activeSensors === 0, `${m.activeSensors} sensors still in the manager list`);
    // Every chunk must carry its own pick structure (plan-756 F1) — a chunk
    // published without one would be brute-forced and the picking numbers
    // would measure something else. Reports written before plan-756 spell the
    // flag `bvhOk`; both spellings are accepted on READ, only `pickOk` is
    // written.
    const pickOk = m.pickOk ?? m.bvhOk;
    add(`pick[${i}]`, pickOk === true, pickOk ? 'every chunk has its pick structure' : 'a chunk pick structure is missing');
  }

  if (requirePick) {
    for (const [i, run] of runs.entries()) {
      const samples = run.pick?.samples ?? 0;
      // 0 samples is NOT "0 ms": it means the pointer sequence never ran.
      add(`pickSamples[${i}]`, samples > 0, `${samples} pointer samples`);
    }
  }

  const p50s = runs.map((r) => p50Of(r)).filter((v) => Number.isFinite(v) && v > 0);
  if (p50s.length >= 2) {
    const lo = Math.min(...p50s); const hi = Math.max(...p50s);
    const spread = (hi - lo) / lo;
    add('repeatability', spread <= CELL_P50_TOLERANCE,
      `p50 spread ${(spread * 100).toFixed(1)} % over ${p50s.length} runs (limit ${(CELL_P50_TOLERANCE * 100).toFixed(0)} %)`);
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    valid: failed.length === 0,
    checks,
    ...(failed.length > 0 ? { reason: failed.map((c) => `${c.name}: ${c.detail}`).join('; ') } : {}),
  };
}

/** Median frame time of a run, from the probe report. */
export function p50Of(run) {
  return Number(run?.probe?.frameMs?.p50 ?? run?.frameTime?.avg ?? NaN);
}

function pctOf(run, key) {
  return Number(run?.probe?.frameMs?.[key] ?? NaN);
}

/** Median of the finite numbers in `values`, or NaN. */
function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Reduce a cell's repetitions to the numbers the report prints.
 * The MEDIAN across repetitions, never the mean: one scheduling hiccup in one
 * repetition must not move the reported figure.
 */
export function summariseCell(cell) {
  const runs = (cell.runs ?? []).filter((r) => r && r.cellMatrix);
  const last = runs[runs.length - 1];
  const m = last?.cellMatrix ?? {};
  cell.summary = {
    placements: m.placements ?? 0,
    bakes: m.bakes ?? 0,
    materializeMs: Math.round(m.materializeMs ?? 0),
    bvhWaitMs: Math.round(m.bvhWaitMs ?? 0),
    bakeMs: Math.round(Object.values(m.bakeMs ?? {}).reduce((a, b) => a + b, 0)),
    chunks: m.chunks ?? 0,
    chunkMeshes: m.chunkMeshes ?? 0,
    dynamic: m.dynamic ?? 0,
    total: m.total ?? 0,
    drawCallsScene: last?.frameStats?.scene?.calls ?? 0,
    drawCallsShadow: last?.frameStats?.shadow?.calls ?? 0,
    triangles: last?.frameStats?.total?.triangles ?? 0,
    p50: round2(median(runs.map((r) => p50Of(r)))),
    p95: round2(median(runs.map((r) => pctOf(r, 'p95')))),
    p99: round2(median(runs.map((r) => pctOf(r, 'p99')))),
    gpu: last?.gpu ?? 'unknown',
  };
  return cell.summary;
}

function round2(v) { return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }

/**
 * The first cell whose p95 crosses a frame budget, per motion mode — the number
 * the optimisation plans are actually after ("it goes slow at N cells").
 */
export function findKnees(cells) {
  const byMotion = new Map();
  for (const cell of cells) {
    if (!byMotion.has(cell.motion)) byMotion.set(cell.motion, []);
    byMotion.get(cell.motion).push(cell);
  }
  const out = [];
  for (const [motion, group] of byMotion) {
    group.sort((a, b) => a.cells - b.cells);
    const first = (limit) => group.find((c) => Number.isFinite(c.summary?.p95) && c.summary.p95 > limit)?.cells ?? null;
    out.push({ motion, knee60: first(KNEE_60HZ_MS), knee30: first(KNEE_30HZ_MS) });
  }
  return out;
}

/** The report body. `fingerprintMd` is `fingerprintMarkdown(fp)` from the bench lib. */
export function renderCellsMarkdown(fingerprintMd, cells, options) {
  const lines = [];
  lines.push('# Cell-matrix performance benchmark (plan-492)', '');
  lines.push('N customer-shaped cells — a lane of chain conveyors plus a six-axis robot —');
  lines.push('built on the PRODUCTION placement path (`resolveBaked` + `materialize`), so every');
  lines.push('number below includes the destructive bake, the chunk meshes, the BVH and the');
  lines.push('shadow pass on real CAD.', '');
  lines.push(fingerprintMd, '');

  const gpuClasses = new Set(cells.map((c) => c.summary?.gpu ?? 'unknown'));
  if (gpuClasses.has('swiftshader')) {
    lines.push('> **CPU BASELINE.** At least one cell was rasterised by SwiftShader, not by a GPU.');
    lines.push('> Those frame times say nothing about what a machine with a GPU does and must not');
    lines.push('> be quoted next to hardware numbers — the `gpu` column says which is which.', '');
  }
  if (gpuClasses.size > 1) {
    lines.push('> **MIXED RASTERISERS** in one run. Compare only rows with the same `gpu` value.', '');
  }

  // VSync honesty. Every p50 sitting on the 60 Hz frame budget means the GPU
  // finished early and waited — the frame time is then the display's, not the
  // scene's, and the "knee" below is the first cell whose JITTER crosses the
  // budget rather than the first cell that cannot keep up.
  const p50s = cells.map((c) => c.summary?.p50).filter((v) => Number.isFinite(v));
  if (p50s.length > 0 && p50s.every((v) => Math.abs(v - KNEE_60HZ_MS) < 0.6)) {
    lines.push('> **VSYNC-CAPPED.** Every cell reports p50 ≈ 16.7 ms, i.e. the renderer finished');
    lines.push('> inside the frame budget everywhere in this sweep and waited for the display.');
    lines.push('> Read the DRAW CALLS, triangles and chunk-mesh columns as the scaling evidence,');
    lines.push('> not the frame times, and treat the knee row as "where jitter starts", not as a');
    lines.push('> capacity limit. A capacity number needs a larger sweep or an uncapped run.', '');
  }

  lines.push('## Cell matrix (placements)', '');
  lines.push('| cells | conv | motion | renderer | placements | bakes | mat ms | bake ms | bvh ms |'
    + ' chunks | chunk meshes | dyn/total | calls scene | calls shadow | tri | p50 | p95 | p99 | gpu | valid |');
  lines.push('|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---|---|');
  for (const cell of cells) {
    const s = cell.summary ?? {};
    lines.push(`| ${cell.cells} | ${cell.conv} | ${cell.motion} | ${cell.renderer} | ${s.placements ?? '-'} | ${s.bakes ?? '-'} |`
      + ` ${s.materializeMs ?? '-'} | ${s.bakeMs ?? '-'} | ${s.bvhWaitMs ?? '-'} |`
      + ` ${s.chunks ?? '-'} | ${s.chunkMeshes ?? '-'} | ${s.dynamic ?? '-'}/${s.total ?? '-'} |`
      + ` ${s.drawCallsScene ?? '-'} | ${s.drawCallsShadow ?? '-'} | ${s.triangles ?? '-'} |`
      + ` ${s.p50 ?? '-'} | ${s.p95 ?? '-'} | ${s.p99 ?? '-'} | ${s.gpu ?? '-'} |`
      + ` ${cell.validity?.valid ? 'yes' : 'NO'} |`);
  }
  lines.push('');

  lines.push('## Cost per placement', '');
  lines.push('| cells | motion | draw calls / placement | triangles / placement | chunk meshes / placement |');
  lines.push('|---:|---|---:|---:|---:|');
  for (const cell of cells) {
    const s = cell.summary ?? {};
    const n = s.placements || 1;
    lines.push(`| ${cell.cells} | ${cell.motion} | ${div(s.drawCallsScene, n)} | ${div(s.triangles, n)} | ${div(s.chunkMeshes, n)} |`);
  }
  lines.push('');

  lines.push('## Knee', '');
  lines.push('First cell count whose p95 crosses the budget. `-` = not reached in this sweep.', '');
  lines.push('| motion | > 16.7 ms (60 Hz) | > 33.3 ms (30 Hz) |');
  lines.push('|---|---:|---:|');
  for (const k of findKnees(cells)) lines.push(`| ${k.motion} | ${k.knee60 ?? '-'} | ${k.knee30 ?? '-'} |`);
  lines.push('');

  const invalid = cells.filter((c) => !c.validity?.valid);
  if (invalid.length > 0) {
    lines.push('## Invalid cells', '');
    lines.push('These rows did NOT measure what they claim; their frame times are not evidence.', '');
    for (const cell of invalid) lines.push(`- \`${cell.label}\` — ${cell.validity?.reason ?? 'no verdict'}`);
    lines.push('');
  }

  lines.push('## Options', '');
  lines.push('```', JSON.stringify(options, null, 2), '```', '');
  return lines.join('\n');
}

function div(a, b) {
  return Number.isFinite(a) && b > 0 ? Math.round((a / b) * 100) / 100 : '-';
}
