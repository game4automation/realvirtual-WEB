// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal-load runner (plan-465, Phase 3).
 *
 * Sweeps a signal-change rate axis and reports the two rates SEPARATELY:
 * what was produced, and what actually arrived in the SignalStore after
 * coalescing. Conflating them is how a "50 000 changes/s" claim gets made about
 * a system that dropped 90 % of them on the way in.
 *
 *   # in-browser (isolates the store's own cost, no network at all)
 *   node scripts/perf-signal-load.mjs --source browser --rates 1000,5000,20000,50000
 *
 *   # through CONNECT (the real chain — needs the gateway AND the Python publisher)
 *   node scripts/perf-signal-load.mjs --source connect --base http://localhost:5100 \
 *        --rates 1000,5000,20000
 *
 * For `--source connect` this runner does NOT start the publisher: it measures
 * what arrives. Start `tools/mqtt-test/publish-load-plcs.py` alongside it (see
 * docs/perf/README.md) and pass the rate it is configured for so the report can
 * put produced and arrived side by side.
 */

import {
  fingerprint, fingerprintMarkdown, launch, newPage, parseArgs, perfUrl,
  reportBaseName, startServer, writeReport,
} from './lib/perf-bench-lib.mjs';

const args = parseArgs(process.argv.slice(2));
const int = (key, fallback) => (args[key] === undefined ? fallback : Number(args[key]));
const rates = String(args.rates ?? '1000,5000,20000,50000').split(',').map(Number).filter(Boolean);
const source = args.source === 'connect' ? 'connect' : 'browser';
const durationS = int('duration', 60);
const headless = args.headless === true || args.headless === 'true';
const plcs = int('plcs', 2);
const signalsPerPlc = int('signals', 500);
const withLine = args.line === true || args.line === 'true';

if (source === 'connect' && !args.base) {
  console.error('--source connect needs --base <origin> (the CONNECT gateway, e.g. http://localhost:5100)');
  process.exit(2);
}

let serverHandle = null;
let baseUrl = args.base ? String(args.base) : null;
if (!baseUrl) {
  serverHandle = await startServer({ port: int('port', 5199) });
  baseUrl = serverHandle.baseUrl;
}

const browser = await launch({ headless, antiThrottle: true });
const rows = [];

try {
  for (const rate of rates) {
    console.log(`\n=== rate ${rate} changes/s (${source})`);
    const { page } = await newPage(browser, { verbose: false });
    // A line is optional here on purpose: the point of this runner is the STORE
    // cost, and mixing in 2400 transported MUs would hide it. `--line` adds the
    // line back for the combined case the matrix owns.
    const url = withLine
      ? perfUrl(baseUrl, { scenario: 'line', mode: 'supported', duration: durationS, load: source, mu: int('mu', 2400) })
      : baseUrl;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 300_000 });
    await page.waitForFunction(() => window.__rvSyntheticLine !== undefined, undefined, { timeout: 600_000 });

    // With `--line`, PerfTestPlugin owns the load generator (it starts one for
    // `load=browser`); starting a second here would double the rate and make the
    // reported axis meaningless. Without `--line` this runner owns it.
    const runnerOwnsLoad = source === 'browser' && !withLine;
    if (runnerOwnsLoad) {
      // changes/s = (signals * changeRatio) / cycleSeconds. Fix the cycle at
      // 50 ms (a realistic PLC scan) and solve for the ratio.
      const cycleMs = int('cycle', 50);
      const perCycle = Math.max(1, Math.round((rate * cycleMs) / 1000));
      const total = plcs * signalsPerPlc;
      const changeRatio = Math.min(1, perCycle / total);
      await page.evaluate(async (cfg) => {
        await window.__rvSyntheticLoad.start(cfg);
      }, { plcs, signalsPerPlc, cycleMs, changeRatio, lineSignals: [] });
      if (changeRatio >= 1) {
        console.log(`  note: requested ${rate}/s needs ${perCycle} changes per ${cycleMs} ms cycle `
          + `but only ${total} signals exist — capped at ${Math.round((total * 1000) / cycleMs)}/s`);
      }
    }

    await page.evaluate(() => { window.__rvPerfProbe.reset(); window.__rvPerfProbe.start(); });
    await new Promise((r) => setTimeout(r, durationS * 1000));
    const measured = await page.evaluate(() => {
      const probe = window.__rvPerfProbe;
      probe.stop();
      return {
        probe: probe.reportJSON(),
        load: window.__rvSyntheticLoad?.stats?.() ?? null,
        store: window.__rvViewer?.signalStore?.stats?.() ?? null,
      };
    });
    if (runnerOwnsLoad) await page.evaluate(() => window.__rvSyntheticLoad.stop());

    const p = measured.probe;
    const stats = measured.load;
    const elapsed = (stats?.elapsedMs ?? durationS * 1000) / 1000;
    rows.push({
      requestedRate: rate,
      producedRate: stats ? stats.produced / elapsed : null,
      arrivedRate: stats ? stats.committed / elapsed : null,
      flushMsAvg: stats && stats.flushes ? stats.flushMsTotal / stats.flushes : null,
      flushMsMax: stats?.flushMsMax ?? null,
      frameP95: p.frameMs?.p95 ?? null,
      stepP95: p.stepMs?.p95 ?? null,
      jitterP95: p.jitterMs?.p95 ?? null,
      coalescedGaps: p.latency?.coalescedGaps ?? 0,
      latencySamples: p.latency?.samples ?? 0,
      signals: measured.store?.signals ?? 0,
      listeners: measured.store?.listeners ?? 0,
    });
    console.log(`  produced ${rows.at(-1).producedRate?.toFixed(0) ?? 'n/a'}/s · `
      + `arrived ${rows.at(-1).arrivedRate?.toFixed(0) ?? 'n/a'}/s · frame p95 ${p.frameMs?.p95?.toFixed(1) ?? '-'} ms`);
    await page.close();
  }
} finally {
  const page0 = await browser.newPage();
  await page0.goto(baseUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const fp = await fingerprint(page0, browser, { source, rates, durationS, plcs, signalsPerPlc, headless })
    .catch(() => ({ timestamp: new Date().toISOString(), host: 'unknown' }));
  await page0.close().catch(() => {});
  await browser.close();
  await serverHandle?.close();

  const baseName = String(args.out ?? reportBaseName(`signal-load-${source}`));
  const { mdPath, jsonPath } = await writeReport(baseName, {
    markdown: render(fp),
    json: { fingerprint: fp, options: { source, rates, durationS, plcs, signalsPerPlc, withLine }, rows },
  });
  console.log(`\nReport: ${mdPath}\n        ${jsonPath}`);

  function render(fingerprintData) {
    const l = [];
    l.push('# realvirtual WEB — signal load (plan-465)');
    l.push('');
    l.push('## Machine fingerprint');
    l.push('');
    l.push(fingerprintMarkdown(fingerprintData));
    l.push('');
    l.push(`## Configuration\n\n- Source: \`${source}\`; ${durationS} s per rate; ${plcs} PLC(s) x ${signalsPerPlc} signals; line ${withLine ? 'built' : 'not built'}`);
    if (source === 'connect') {
      l.push('- Produced rate is whatever `tools/mqtt-test/publish-load-plcs.py` was configured for;');
      l.push('  this runner only measures what ARRIVED. Record the publisher\'s own counter next to it.');
    }
    l.push('');
    l.push('| requested (/s) | produced (/s) | arrived (/s) | flush avg / max (ms) | frame p95 (ms) | step p95 (ms) | jitter p95 (ms) | coalesced gaps |');
    l.push('|---:|---:|---:|---|---:|---:|---:|---:|');
    for (const r of rows) {
      l.push(`| ${r.requestedRate} | ${r.producedRate?.toFixed(0) ?? '—'} | ${r.arrivedRate?.toFixed(0) ?? '—'} `
        + `| ${r.flushMsAvg?.toFixed(3) ?? '—'} / ${r.flushMsMax?.toFixed(3) ?? '—'} `
        + `| ${r.frameP95?.toFixed(1) ?? '—'} | ${r.stepP95?.toFixed(2) ?? '—'} `
        + `| ${r.jitterP95?.toFixed(1) ?? '—'} | ${r.coalescedGaps} |`);
    }
    l.push('');
    l.push('"Arrived" is post-dedup: the buffer keeps only the last value per signal per tick,');
    l.push('so a produced rate far above 60 Hz x signal-count necessarily shows a lower arrived rate.');
    l.push('That gap is a property of the design, not a loss to fix.');
    l.push('');
    return l.join('\n');
  }
}
