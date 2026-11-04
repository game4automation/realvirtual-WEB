// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeTypes = new Set(['DESSource', 'DESSink', 'DESStation', 'DESStorage', 'DESConveyor', 'DESDowntime']);

/** Pure structural scan: only node names and matched types leave this function. */
export function scanLegacyNodes(document) {
  const hits = [];
  for (const [index, node] of (document.nodes ?? []).entries()) {
    const types = new Set();
    const visit = (value) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (nativeTypes.has(key) || key === '_desComponent') types.add(key);
        if (typeof child === 'string' && nativeTypes.has(child)) types.add(child);
        visit(child);
      }
    };
    visit(node.extras);
    for (const type of types) hits.push({ node: node.name ?? `node[${index}]`, type });
  }
  return hits;
}

/** Parse a GLB without exposing its JSON or parser errors in the report. */
export function scanGlb(input) {
  const bytes = Buffer.from(input);
  if (bytes.subarray(0, 64).toString('utf8').startsWith('version https://git-lfs')) {
    return { status: 'lfs-pointer', hits: [] };
  }
  try {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF'
      || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error();
    let document;
    let offset = 12;
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) throw new Error();
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      if (length % 4 !== 0 || offset + 8 + length > bytes.length) throw new Error();
      if (offset === 12 && type !== 0x4e4f534a) throw new Error();
      if (type === 0x4e4f534a) {
        if (document !== undefined) throw new Error();
        document = JSON.parse(bytes.toString('utf8', offset + 8, offset + 8 + length));
      }
      offset += 8 + length;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)
      || (document.nodes !== undefined && !Array.isArray(document.nodes))) throw new Error();
    return { status: 'scanned', hits: scanLegacyNodes(document) };
  } catch {
    return { status: 'invalid', hits: [] };
  }
}

export function inventory(repoRoot) {
  const report = { scanned: 0, hits: [], lfsPointers: [], invalid: [] };
  const label = (path) => relative(repoRoot, path).split('\\').join('/');
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { report.invalid.push(label(dir)); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.glb$/i.test(entry.name)) {
        report.scanned++;
        let result;
        try { result = scanGlb(readFileSync(path)); }
        catch { result = { status: 'invalid', hits: [] }; }
        if (result.status === 'lfs-pointer') report.lfsPointers.push(label(path));
        else if (result.status === 'invalid') report.invalid.push(label(path));
        for (const hit of result.hits) report.hits.push({ file: label(path), ...hit });
      }
    }
  };
  for (const dir of ['public', 'examples', 'tests', '../realvirtual-WebViewer-Private~/projects']) {
    const path = resolve(repoRoot, dir);
    if (existsSync(path)) walk(path);
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = inventory(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    for (const hit of report.hits) console.log(JSON.stringify(hit));
    for (const file of report.lfsPointers) console.log(JSON.stringify({ file, type: 'lfs-pointer' }));
    for (const file of report.invalid) console.log(JSON.stringify({ file, type: 'invalid' }));
    console.log(`des-legacy-inventory: ${report.scanned} glb scanned, ${report.hits.length} hits, ${report.lfsPointers.length} lfs pointers, ${report.invalid.length} invalid`);
  }
  process.exitCode = report.hits.length > 0 ? 1 : 0;
}
