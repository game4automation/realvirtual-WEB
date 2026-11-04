// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Synthetic recorder storage spike; run with node scripts/spike-des-series-measure.mjs. */
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Bundle in memory so measurements use the real TypeScript implementation without generated files.
async function loadModule(relative) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(relative, import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2022', logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const [{ planSeries }, { encodeRunSeriesBlob }] = await Promise.all([
  loadModule('../src/plugins/des/series/des-series-plan.ts'),
  loadModule('../src/plugins/des/series/des-series-codec.ts'),
]);

/** State shares and rates are accumulated; event counters and alternating StatsRows are held. */
function sceneCandidates(components, rows) {
  const result = [
    { id: 'kpi:throughputPerHour', label: 'Throughput', kind: 'accumulated', priority: 1 },
    { id: 'kpi:meanUtilization', label: 'Mean utilization', kind: 'accumulated', priority: 1 },
  ];
  for (let i = 0; i < rows; i++) result.push({
    id: `row:synthetic/${String(i).padStart(4, '0')}`, label: `Statistic ${i}`,
    kind: i % 2 ? 'accumulated' : 'held', priority: 2,
  });
  for (let c = 0; c < components; c++) {
    const prefix = `comp:${String(c).padStart(4, '0')}@Synthetic/`;
    for (let s = 0; s < 10; s++) result.push({ id: `${prefix}state${s}`, label: `State ${s}`,
      kind: 'accumulated', priority: 3 });
    result.push({ id: `${prefix}outputPerHour`, label: 'Output per hour', kind: 'accumulated', priority: 3 });
    result.push({ id: `${prefix}totalProcessed`, label: 'Total processed', kind: 'held', priority: 3 });
  }
  return result;
}

console.log('Synthetic scenes: 10 states + rate + event counter per component, 2 matrix KPIs.');
console.log('StatsRows alternate held/accumulated. Samples are deterministic synthetic signals, not scene measurements.');
const table = [];
for (const components of [10, 50, 200]) {
  for (const rows of [0, 50, 200]) {
    const candidates = sceneCandidates(components, rows);
    const plan = planSeries(candidates);
    const series = plan.series.map((s, index) => {
      const values = Float32Array.from({ length: s.bucketCount }, (_, i) => s.kind === 'held'
        ? Math.floor((i + index) / 7) : (1 + Math.sin(i / 31 + index)) * 50);
      return { ...s, values, ...(s.kind === 'held' ? {
        min: Float32Array.from(values, v => Math.max(0, v - 1)),
        max: Float32Array.from(values, v => v + 1),
      } : {}) };
    });
    const blob = { version: 1, provenance: { variantId: null, variantRevision: 0, configKey: 'synthetic',
      rngVersion: 2, seed: 1, crn: true }, endTime: 3600, statResetTime: 0,
      simTimeReached: 3600, validUntil: 3600, ...plan, series };
    const line = JSON.stringify({ type: 'series', key: ['synthetic', 'Base', 1, 2, 'synthetic'],
      blob: encodeRunSeriesBlob(blob) }) + '\n';
    const rawBytes = series.reduce((n, s) => n + s.values.byteLength + (s.min?.byteLength ?? 0) + (s.max?.byteLength ?? 0), 0);
    table.push({ components, states: 10, statsRows: rows, candidates: candidates.length, selected: series.length,
      buckets: [1, 2, 3].map(p => `${p}:${[...new Set(series.filter(s => s.priority === p).map(s => s.bucketCount))].join('/') || '-'}`).join(' '),
      rawBytes, jsonBytes: Buffer.byteLength(line), gzipBytes: gzipSync(line).byteLength, truncated: !!plan.truncated });
  }
}
console.table(table);
console.log('D1b: run this codec on actual Demo Cell and PalletYard source catalogs and recorded samples.');
