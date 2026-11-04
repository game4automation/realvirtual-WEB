// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Real headless demo-line / PalletYard measurement; no vitest process is started. */
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
const output = new URL('../.des-series-measure.mjs', import.meta.url);
const source = `
import { startLine } from './tests/des/des-lifecycle-line';
import { buildYard } from './tests/des/pallet-yard-harness';
import { beginRunSeries } from './src/plugins/des/series/des-series-runtime';
import { encodeRunSeriesBlob } from './src/plugins/des/series/des-series-codec';
export function measure(rasterExtrema) {
  const results = [];
  for (const name of ['Demo line', 'PalletYard']) {
    const world = name === 'PalletYard' ? buildYard('fastforward', {durationSec: 3600}) : startLine();
    const runner = world.runner;
    const manager = runner.getManager();
    const runtime = beginRunSeries(manager, () => [{id:'measurement', title:'Counters', rows:()=>runner.statistics().components.map(c=>({key:c.path,label:c.name,value:c.totalProcessed}))}], runner.liveInstances.map(i=>i.adapter), rasterExtrema);
    let reads = 0, readMs = 0;
    const read = g => { const start = performance.now(); const value = runtime.read(g); readMs += performance.now()-start; reads++; return value; };
    const off = manager.addTimeAdvanceListener(t => runtime.recorder.onTimeAdvance(t, read));
    const start = performance.now();
    if (name === 'PalletYard') world.runTo(3600);
    else while (manager.processEvents(10000) > 0) {}
    runtime.recorder.finish(manager.currentTime, read);
    off();
    const blob = runtime.recorder.toBlob({variantId:null,variantRevision:0,configKey:'measure',rngVersion:manager.rngVersion,seed:manager.masterSeed,crn:true});
    results.push({name, components:manager.componentCount, events:manager.totalEventsProcessed, simTime:manager.currentTime, series:blob.series.length,
      rawBytes:blob.series.reduce((n,s)=>n+s.values.byteLength+(s.min?.byteLength??0)+(s.max?.byteLength??0),0),
      encoded:JSON.stringify(encodeRunSeriesBlob(blob)), reads, readMs, runMs:performance.now()-start});
    runner.dispose();
  }
  return results;
}`;
try {
  const result = await build({ stdin: {contents:source, resolveDir:process.cwd(), loader:'ts'}, bundle:true, write:false, format:'esm', platform:'node', packages:'external', define:{'__RV_HAS_PRIVATE__':'false','__RV_EMBED__':'true','import.meta.env.DEV':'false','import.meta.env.PROD':'true','import.meta.env.BASE_URL':JSON.stringify('/')}, target:'es2022', logLevel:'silent' });
  await writeFile(output, result.outputFiles[0].contents);
  const {measure} = await import(output.href);
  for (const {encoded,...result} of measure(!process.argv.includes('--event-extrema'))) console.log(JSON.stringify({...result,jsonBytes:Buffer.byteLength(encoded),gzipBytes:gzipSync(encoded).byteLength}));
} finally { await unlink(output).catch(()=>{}); }

