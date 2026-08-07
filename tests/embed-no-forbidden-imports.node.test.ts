// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const EMBED_DIR = resolve(ROOT, 'src/embed');

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticImport = /\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  const dynamicImport = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(staticImport)) specifiers.push(match[1]);
  for (const match of source.matchAll(dynamicImport)) specifiers.push(match[1]);
  return specifiers;
}

function forbiddenReason(specifier: string): string | null {
  if (/^(?:react|react-dom)(?:\/|$)/.test(specifier)) return 'React';
  if (/^@mui(?:\/|$)/.test(specifier)) return 'MUI';
  if (/^monaco-editor(?:\/|$)/.test(specifier)) return 'Monaco';
  if (/^three\/(?:webgpu|tsl)(?:\/|$)/.test(specifier)) return 'Three WebGPU/TSL';
  if (/^stats-gl(?:\/|$)/.test(specifier)) return 'stats-gl';
  if (/^@rv-private(?:\/|$)/.test(specifier)) return '@rv-private';
  if (/(?:^|\/)interfaces(?:\/|$)/i.test(specifier)) return 'industrial interfaces';
  if (/(?:websocket|mqtt|ctrlx)/i.test(specifier)) return 'industrial interfaces';
  if (/(?:occt|cadlink|cad-link)/i.test(specifier)) return 'OCCT/CADLink';
  if (/(?:^|\/)rv-viewer(?:\.[cm]?[jt]s)?$/i.test(specifier)) return 'RVViewer';
  if (/(?:^|\/)rv-plugin(?:\.[cm]?[jt]s)?$/i.test(specifier)) return 'RVPlugin';
  return null;
}

describe('rv-embed import boundary', () => {
  it('contains no forbidden runtime or type imports', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(EMBED_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importSpecifiers(source)) {
        const reason = forbiddenReason(specifier);
        if (reason) {
          offenders.push(`${relative(ROOT, file).replace(/\\/g, '/')}: ${specifier} (${reason})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
