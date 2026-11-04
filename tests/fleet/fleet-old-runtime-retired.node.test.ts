// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-559 Phase 8 / §9.14: retirement of the project-owned plugin lifecycle.
// Like des-legacy-retired.node.test.ts, this is a source guard, not proof against arbitrary rewrites.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const retired = 'src/plugins/models/PalletYard/legacy-plugin.ts';
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function oldLifecycle(text: string): boolean {
  return /\bclass\s+PalletYardPlugin\b(?!\s+extends\s+FleetPlugin\b)/.test(text)
    // Catch the old body copied under another class/file name, without matching FleetPlugin itself.
    || ['ensureLifecycle', 'tryBindContinuous', 'attachChargerLabels'].every(name =>
      new RegExp(`\\b${name}\\s*\\(`).test(text));
}

describe('PalletYard lifecycle retirement (plan-559 §9.14)', () => {
  it('keeps the parked implementation deleted', () => {
    expect(existsSync(join(root, retired))).toBe(false);
  });

  it('has no imports or re-exports of the retired module', () => {
    const violations: string[] = [];
    for (const file of ['src', 'tests', 'examples'].flatMap(dir => files(join(root, dir)))) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const text = readFileSync(file, 'utf8');
      const imports = /\b(?:import|export)\s+(?:[^;'"$]*?\s+from\s*)?['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;
      for (const match of text.matchAll(imports)) {
        if (/(?:^|\/)legacy-plugin(?:\.[cm]?[jt]sx?)?$/.test(match[1] ?? match[2])) {
          violations.push(relative(root, file));
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('does not restore the standalone class or move its old lifecycle elsewhere', () => {
    expect(['src', 'examples'].flatMap(dir => files(join(root, dir)))
      .filter(file => oldLifecycle(readFileSync(file, 'utf8')))
      .map(file => relative(root, file))).toEqual([]);
  });

  it('recognizes a renamed legacy body while allowing the FleetPlugin facade', () => {
    expect(oldLifecycle('class PalletYardPlugin implements RVViewerPlugin {}')).toBe(true);
    expect(oldLifecycle('class Renamed { ensureLifecycle() {} tryBindContinuous() {} attachChargerLabels() {} }')).toBe(true);
    expect(oldLifecycle('class PalletYardPlugin extends FleetPlugin {}')).toBe(false);
  });
});
