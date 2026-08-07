// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * tsl-import-hygiene.node.test.ts — plan-271 test 9.4 (node).
 *
 * Directory scan over `src/core/engine/materials/` (extends the
 * private-internal-gate source-regex pattern with readdirSync):
 *
 *  (a) `*-tsl.ts` modules import ONLY from 'three/webgpu' / 'three/tsl' /
 *      'three/addons/tsl/*' — never bare 'three' (dual-three-instance trap,
 *      plan-090). The addon TSL display nodes (OutlineNode, GTAONode, …) are
 *      allowed because they themselves import exclusively from three/webgpu
 *      + three/tsl (verified for three 0.185.1) — no second three instance.
 *  (b) NO file in materials/ imports rv-viewer (architecture rule,
 *      plan-271 review finding 9 — MaterialContext is passed down instead).
 *  (c) The factory references the `-tsl` modules ONLY via dynamic `import()`
 *      (bundle protection: three/webgpu must stay out of the default chunk).
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MATERIALS_DIR = resolve(__dirname, '../src/core/engine/materials');

const allFiles = readdirSync(MATERIALS_DIR).filter((f) => f.endsWith('.ts'));
const tslFiles = allFiles.filter((f) => f.endsWith('-tsl.ts'));
const factoryFile = 'material-factory.ts';

/** All module specifiers referenced by static import/export statements. */
function staticImportSpecifiers(src: string): string[] {
  const specs: string[] = [];
  // import ... from 'x'; export ... from 'x'; import 'x';
  const re = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    specs.push(m[1] ?? m[2]);
  }
  return specs;
}

describe('TSL import hygiene (plan-271, materials/)', () => {
  it('materials/ exists and contains at least one -tsl module + the factory', () => {
    expect(allFiles).toContain(factoryFile);
    expect(tslFiles.length).toBeGreaterThan(0);
  });

  it('(a) *-tsl.ts modules import ONLY from three/webgpu, three/tsl or three/addons/tsl/* — never bare three', () => {
    for (const file of tslFiles) {
      const src = readFileSync(join(MATERIALS_DIR, file), 'utf-8');
      for (const spec of staticImportSpecifiers(src)) {
        expect(
          spec === 'three/webgpu' || spec === 'three/tsl' || spec.startsWith('three/addons/tsl/'),
          `${file}: forbidden import '${spec}' — TSL modules may only import from three/webgpu / three/tsl / three/addons/tsl/*`,
        ).toBe(true);
      }
    }
  });

  it('(b) no file in materials/ imports rv-viewer (architecture rule)', () => {
    for (const file of allFiles) {
      const src = readFileSync(join(MATERIALS_DIR, file), 'utf-8');
      for (const spec of staticImportSpecifiers(src)) {
        expect(
          /rv-viewer/.test(spec),
          `${file}: must not import '${spec}' — materials/ never imports rv-viewer (pass MaterialContext down instead)`,
        ).toBe(false);
      }
    }
  });

  it('(c) the factory loads -tsl modules ONLY via dynamic import()', () => {
    const src = readFileSync(join(MATERIALS_DIR, factoryFile), 'utf-8');
    // No static import statement may reference a -tsl module …
    for (const spec of staticImportSpecifiers(src)) {
      expect(
        /-tsl/.test(spec),
        `${factoryFile}: static import of '${spec}' would drag three/webgpu into the default chunk`,
      ).toBe(false);
    }
    // … but a dynamic import() of one must exist (the pre-warm).
    expect(/\bimport\(\s*['"]\.\/[^'"]*-tsl['"]\s*\)/.test(src)).toBe(true);
  });

  it('(d) the pipe-flow TSL module never imports a wall-clock time node (plan-271 finding 5)', () => {
    // The uTime uniform must be fed EXCLUSIVELY from PipeFlowManager.update(dt)
    // (SimulationLoop dt) — the three/tsl `time`/timer nodes would keep
    // scrolling through pause and break WebGL/TSL determinism parity.
    const src = readFileSync(join(MATERIALS_DIR, 'rv-pipe-flow-tsl.ts'), 'utf-8');
    const banned = ['time', 'timerLocal', 'timerGlobal', 'timerDelta'];
    const importsRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]three\/tsl['"]/g;
    let sawImport = false;
    for (let m = importsRe.exec(src); m; m = importsRe.exec(src)) {
      sawImport = true;
      const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of banned) {
        expect(
          names.includes(name),
          `rv-pipe-flow-tsl.ts imports '${name}' — the TSL time base must be the sim-dt uniform, never wall-clock`,
        ).toBe(false);
      }
    }
    expect(sawImport, 'rv-pipe-flow-tsl.ts should import from three/tsl').toBe(true);
  });
});
