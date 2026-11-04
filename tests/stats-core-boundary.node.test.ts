// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-2011 §9.7: the hub must not depend on its plugin contributors. */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugins = resolve(root, 'src/plugins');
const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
const options = ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(dir, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?[jt]sx?$/.test(file) ? [file] : [];
  });
}

describe('statistics core boundary', () => {
  it('has no plugin imports, including type-only imports and re-exports', () => {
    const files = sources(resolve(root, 'src/core/stats'));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      // The parser covers static/type imports, re-exports and dynamic imports.
      for (const { fileName: spec } of ts.preProcessFile(source.text, true, true).importedFiles) {
        const target = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule?.resolvedFileName
          ?? (spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
        const rel = relative(plugins, target).replace(/\\/g, '/');
        if ((!rel.startsWith('../') && !rel.includes(':') && rel !== '..')
          || /(?:^|\/)plugins(?:\/|$)/.test(spec)) {
          offenders.push(`${relative(root, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
