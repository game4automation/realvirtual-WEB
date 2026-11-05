// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Separate process: its input/export/compiler allocations are outside the measured
// post-pass. --expose-gc and --trace-gc-nvp provide end-of-call heap snapshots AND
// live-heap observations immediately before/after collections during the call.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
const [modulePath, inputPath, optionsPath, output = 'text'] = process.argv.slice(2);
const source = readFileSync(modulePath, 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const postProcess = output === 'chunks' ? module.postProcessModelUsdaChunks : module.postProcessModelUsda;
const input = readFileSync(inputPath, 'utf8');
const opts = JSON.parse(readFileSync(optionsPath, 'utf8'));
opts.prims = new Map(opts.prims);
postProcess('def Xform "_rvN0" {}', { finalNames: ['Warm'], prims: new Map([[0, { customData: { address: '#warm' }, visibility: 'inherited' }]]) });
if (typeof global.gc !== 'function') throw new Error('Memory probe needs --expose-gc');
// Include the optimized, repeatedly used formatter rather than measuring only
// its cold invocation. Both warm results are dropped before the measured GC.
for (let warm = 0; warm < 2; warm++) postProcess(input, opts);
const measurements = [];
let result;
for (let run = 0; run < 1; run++) {
  result = undefined;
  global.gc({ type: 'major', execution: 'sync' });
  const beforeMemory = process.memoryUsage();
  result = postProcess(input, opts);
  // Force materialisation, including the old implementation's concatenation ropes.
  if (output === 'text') result.text.charCodeAt(result.text.length - 1);
  const afterMemory = process.memoryUsage();
  const data = output === 'chunks' ? result.chunks : result.text;
  const outputBytes = typeof data === 'string' ? Buffer.byteLength(data) : data.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  // Include actual ArrayBuffers, including unused capacity in final chunk views.
  const buffers = typeof data === 'string' ? [] : [...new Set(data.map((chunk) => chunk.buffer))];
  const retainedBytes = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const bufferPeak = Math.max(0, afterMemory.arrayBuffers - beforeMemory.arrayBuffers, retainedBytes);
  const hash = createHash('sha256');
  if (typeof data === 'string') hash.update(data);
  else for (const chunk of data) hash.update(chunk);
  measurements.push({ before: beforeMemory.heapUsed, after: afterMemory.heapUsed, bufferPeak, outputBytes,
    renamed: result.renamed, unmatched: result.unmatched,
    digest: hash.digest('hex') });
}
writeFileSync(inputPath + '.results.json', JSON.stringify(measurements));
