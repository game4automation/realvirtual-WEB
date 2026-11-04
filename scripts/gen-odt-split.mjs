// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Splits `schema/v1/rv-odt.json` (the source of truth) into two generated files so the ~129 kB of
 * component DESCRIPTIONS stay out of the eager startup bundle:
 *
 *  - `schema/v1/rv-odt.structure.json`    the same document without any `description` string;
 *    the component registry imports THIS one eagerly.
 *  - `schema/v1/rv-odt.descriptions.json` flat map `"<path>" -> description`; the path is the key
 *    path from the document root joined with "/" (e.g. `$defs/Drive/properties/TargetSpeed`).
 *    Loaded on demand through a dynamic `import()` (rv-component-schema-info.ts).
 *
 * A `description` key is only stripped where it is a keyword: a property that is itself NAMED
 * "description" lives inside a `properties` map and is an object, so it stays.
 *
 * Usage: `node scripts/gen-odt-split.mjs` writes the files; `--check` exits 1 when they are stale.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(ROOT, 'schema', 'v1');
export const SOURCE_FILE = join(SCHEMA_DIR, 'rv-odt.json');
export const STRUCTURE_FILE = join(SCHEMA_DIR, 'rv-odt.structure.json');
export const DESCRIPTIONS_FILE = join(SCHEMA_DIR, 'rv-odt.descriptions.json');

//! Strips every `description` keyword; returns the stripped copy and the path -> description map.
export function splitOdt(doc) {
  const descriptions = {};
  const walk = (node, path, inNameMap) => {
    if (Array.isArray(node)) return node.map((v, i) => walk(v, [...path, String(i)], false));
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (!inNameMap && key === 'description' && typeof value === 'string') {
        descriptions[path.join('/')] = value;
        continue;
      }
      out[key] = walk(value, [...path, key], key === 'properties' || key === '$defs');
    }
    return out;
  };
  return { structure: walk(doc, [], false), descriptions };
}

//! The two generated files as the exact text they must have on disk.
export function renderOdtSplit(sourceText = readFileSync(SOURCE_FILE, 'utf8')) {
  const { structure, descriptions } = splitOdt(JSON.parse(sourceText));
  return {
    structure: JSON.stringify(structure) + '\n',
    descriptions: JSON.stringify(descriptions) + '\n',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = renderOdtSplit();
  if (process.argv.includes('--check')) {
    const stale = [[STRUCTURE_FILE, out.structure], [DESCRIPTIONS_FILE, out.descriptions]]
      .filter(([f, text]) => !existsSync(f) || readFileSync(f, 'utf8').replace(/\r\n/g, '\n') !== text);
    if (stale.length) {
      console.error(`stale: ${stale.map(([f]) => f).join(', ')} - run: npm run gen:odt-split`);
      process.exit(1);
    }
  } else {
    writeFileSync(STRUCTURE_FILE, out.structure);
    writeFileSync(DESCRIPTIONS_FILE, out.descriptions);
    console.log(`wrote ${STRUCTURE_FILE} (${out.structure.length} B), ${DESCRIPTIONS_FILE} (${out.descriptions.length} B)`);
  }
}
