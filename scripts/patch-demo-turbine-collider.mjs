// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Usage: node scripts/patch-demo-turbine-collider.mjs [--in glb] [--out glb] [--update-project]
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readGlb, writeGlb } from './lib/rv-glb.mjs';

/** Pure patch: keep all other JSON and the opaque binary remainder intact. */
export function patchTurbineCollider(glbBuffer) {
  const { json, rest } = readGlb(glbBuffer);
  // Count raw parent/child matches explicitly: a path lookup alone could hide ambiguity.
  const matches = (json.nodes ?? []).flatMap(parent => parent.name === 'Turbine'
    ? (parent.children ?? []).filter(i => json.nodes[i]?.name === 'Turbine-cut') : []);
  if (matches.length !== 1) throw new Error(`Expected exactly one Turbine/Turbine-cut, found ${matches.length}`);
  const node = json.nodes[matches[0]];
  // Same fields and local-coordinate convention as the existing cap collider.
  const colliders = [{
    type: 'BoxCollider', isTrigger: false, enabled: true,
    center: { x: -0.020749867, y: 0.0272840261, z: -7.75143528 },
    size: { x: 38.2475, y: 38.4586, z: 15.9788342 },
  }];
  if (isDeepStrictEqual(node.extras?.realvirtual?.colliders, colliders)) {
    return { buffer: glbBuffer, changed: false };
  }
  node.extras ??= {};
  node.extras.realvirtual ??= {};
  node.extras.realvirtual.colliders = colliders;
  return { buffer: writeGlb(json, rest), changed: true };
}

export function updateDemoProjectMetadata(output, buffer) {
  const projectPath = resolve(dirname(output), 'project.json');
  const source = readFileSync(projectPath, 'utf8');
  const expected = JSON.parse(source);
  const docs = expected.documents.filter(doc => doc.path === 'DemoRealvirtualWeb.glb');
  if (docs.length !== 1) throw new Error('Expected exactly one DemoRealvirtualWeb.glb document');
  const metadata = {
    sha256: createHash('sha256').update(buffer).digest('hex'),
    sizeBytes: buffer.length,
    mtimeMs: statSync(output).mtimeMs,
  };
  // Locate the document object using JSON tokens; strings may contain braces.
  const stack = [];
  const spans = [];
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}]/g)) {
    if (token[0] === '{') stack.push(token.index);
    if (token[0] === '}') {
      const start = stack.pop();
      const end = token.index + 1;
      if (JSON.parse(source.slice(start, end)).path === 'DemoRealvirtualWeb.glb') spans.push([start, end]);
    }
  }
  if (spans.length !== 1) throw new Error('Cannot uniquely locate demo document text');
  const [start, end] = spans[0];
  let document = source.slice(start, end);
  for (const [key, value] of Object.entries(metadata)) {
    const pattern = new RegExp(`("${key}"\\s*:\\s*)("[^"\\\\]*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, 'g');
    let count = 0;
    document = document.replace(pattern, (_, prefix) => { count++; return prefix + JSON.stringify(value); });
    if (count !== 1) throw new Error(`Expected one ${key} field in demo document`);
  }
  const updated = source.slice(0, start) + document + source.slice(end);
  Object.assign(docs[0], metadata);
  if (!isDeepStrictEqual(JSON.parse(updated), expected)) throw new Error('Unexpected project metadata change');
  if (updated !== source) writeFileSync(projectPath, updated);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: {
    in: { type: 'string' }, out: { type: 'string' }, 'update-project': { type: 'boolean' },
  } });
  const input = resolve(values.in ?? 'public/demo-realvirtual/DemoRealvirtualWeb.glb');
  const output = resolve(values.out ?? input);
  const { buffer, changed } = patchTurbineCollider(readFileSync(input));
  if (changed || output !== input) writeFileSync(output, buffer);
  if (values['update-project']) updateDemoProjectMetadata(output, buffer);
  console.log(`${changed ? 'Patched' : 'Unchanged'}: ${output} (${buffer.length} bytes)`);
}
