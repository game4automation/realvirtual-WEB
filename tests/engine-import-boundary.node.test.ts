// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 F1 / F4 — the engine/viewer boundary, as a failing test instead of
 * a convention (review finding 11).
 *
 * The recipe (`rv-prepare-and-bake.ts`) and the init-context builder
 * (`rv-init-context.ts`) are engine data: `ModelCache` runs the recipe for a
 * placement and the embed facade — which has no `RVViewer` — builds its init
 * context from them. Neither may import from the viewer class, a plugin or the
 * HMI layer; the day one does, a placement's bake depends on the shell it runs
 * in and the two paths drift apart again.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const GUARDED = [
  'src/core/engine/rv-prepare-and-bake.ts',
  'src/core/engine/rv-init-context.ts',
  // plan-610 F9: the reference audit hands the viewer a list; the viewer reports it.
  'src/core/engine/rv-reference-audit.ts',
];

/** Import specifiers that mean "the viewer shell", relative to `src/core/engine/`. */
const FORBIDDEN = [
  /^\.\.\/rv-viewer(\.ts)?$/,          // src/core/rv-viewer.ts
  /^\.\.\/\.\.\/plugins\//,            // src/plugins/**
  /^\.\.\/hmi\//,                      // src/core/hmi/**
  /^@rv\/core\/rv-viewer/,
  /^@rv\/plugins\//,
  /^@rv\/core\/hmi\//,
];

function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(source)) !== null) out.push(m[1]);
  return out;
}

describe('engine import boundary (plan-757)', () => {
  for (const file of GUARDED) {
    it(`${file} imports nothing from the viewer, the plugins or the HMI`, () => {
      const source = readFileSync(resolve(repoRoot, file), 'utf8');
      const offenders = importSpecifiers(source).filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
      expect(offenders, `${file} reaches across the engine boundary`).toEqual([]);
    });
  }

  it('the specifier matcher recognises the three forbidden layers', () => {
    const probe = "import { RVViewer } from '../rv-viewer';\nimport x from '../../plugins/foo';\nimport { r } from '../hmi/problems-store';\nimport ok from './rv-bake-pipeline';";
    const offenders = importSpecifiers(probe).filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
    expect(offenders).toEqual(['../rv-viewer', '../../plugins/foo', '../hmi/problems-store']);
  });
});
