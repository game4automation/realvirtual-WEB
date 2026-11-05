// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { strFromU8, unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

/** Actual exporter output: prim paths and their own metadata, excluding children. */
export function mountPrims(usdz: Uint8Array): Map<string, string> {
  const prims = new Map<string, string>(), stack: string[] = [];
  let pending: string | null = null, metadata = '', dictionaryDepth = 0;
  for (const raw of strFromU8(unzipSync(usdz)['model.usda']).split('\n')) {
    const line = raw.trim();
    if (pending) metadata += raw + '\n';
    if (line.endsWith('= {')) { dictionaryDepth++; continue; }
    if (dictionaryDepth > 0) {
      if (line.startsWith('}')) dictionaryDepth--;
      continue;
    }
    const def = /^def\s+\w*\s*"([^"]+)"/.exec(line);
    if (def) {
      pending = `${stack.at(-1) ?? ''}/${def[1]}`;
      if (prims.has(pending)) throw new Error(`Duplicate prim: ${pending}`);
      metadata = raw + '\n';
    } else if (line.startsWith('{') && pending) {
      prims.set(pending, metadata); stack.push(pending); pending = null;
    } else if (line.startsWith('}')) stack.pop();
  }
  return prims;
}
