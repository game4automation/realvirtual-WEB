// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.10 — the invariant layer is DEV-only, checked along the three
 * axes the plan keeps apart, because they are three different claims:
 *
 * 1. **switched off** — the only switch is `import.meta.env.DEV`; there is no
 *    localStorage, URL or env override that could arm it in production;
 * 2. **not loaded** — every reference to the module in `src/` sits behind an
 *    `import.meta.env.DEV` guard, which is what lets the bundler drop it;
 * 3. **not shipped** — the module has no top-level side effect, so once
 *    unreferenced it is droppable rather than merely unused.
 *
 * A node test on purpose: it reasons about the SOURCE, which is where a
 * build-time property can actually be decided. Whether the marker string
 * survives a real production build is additionally measured in phase 5.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const MODULE_REL = 'src/core/engine/rv-invariants.ts';
const MODULE_SRC = readFileSync(join(ROOT, MODULE_REL), 'utf8');

/** Every .ts/.tsx file under src/, recursively. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('1) switched off — the only switch is import.meta.env.DEV', () => {
  it('reads import.meta.env.DEV and nothing else as its switch', () => {
    expect(MODULE_SRC).toContain('import.meta.env.DEV === true');
  });

  it('has no runtime override — no localStorage, no URL parameter, no env var', () => {
    expect(MODULE_SRC).not.toMatch(/localStorage|sessionStorage/);
    expect(MODULE_SRC).not.toMatch(/URLSearchParams|location\.search/);
    expect(MODULE_SRC).not.toMatch(/process\.env/);
  });

  it('refuses to install when the switch is off', () => {
    // The guard is the FIRST statement of installInvariants, so there is no
    // path that wires a handler in a production build.
    expect(MODULE_SRC).toMatch(/export function installInvariants\([^)]*\): boolean \{\s*\n\s*if \(!invariantsEnabled\(\)\) return false;/);
  });

  it('never throws and never writes a Problems entry', () => {
    expect(MODULE_SRC).not.toMatch(/\bthrow new\b/);
    expect(MODULE_SRC).not.toMatch(/\breportProblem\b/);
  });
});

describe('2) not loaded — every reference in src/ is behind a DEV guard', () => {
  const importers = sourceFiles(join(ROOT, 'src'))
    .filter((f) => !f.endsWith('rv-invariants.ts'))
    .map((f) => ({ file: f, text: readFileSync(f, 'utf8') }))
    .filter((f) => f.text.includes('rv-invariants'));

  it('is imported by exactly one module — the viewer', () => {
    const rel = importers.map((f) => f.file.split(/[\\/]src[\\/]/)[1]?.replace(/\\/g, '/'));
    expect(rel).toEqual(['core/rv-viewer.ts']);
  });

  it('uses every imported symbol only inside an import.meta.env.DEV guard', () => {
    for (const { file, text } of importers) {
      const uses = text.split('\n').filter((l) => /installInvariants|invariantsOnRenderedFrame/.test(l) && !l.trim().startsWith('import '));
      expect(uses.length, `${file} imports the layer but never uses it`).toBeGreaterThan(0);
      for (const line of uses) {
        expect(line, `unguarded reference in ${file}: ${line.trim()}`).toContain('import.meta.env.DEV');
      }
    }
  });
});

describe('3) not shipped — the module is droppable', () => {
  it('has no top-level side effect that would pin it into the bundle', () => {
    const topLevel = MODULE_SRC
      .split('\n')
      .filter((l) => /^[a-zA-Z]/.test(l))
      .filter((l) => !/^(import|export|type|interface|const|let|function|declare)\b/.test(l));
    expect(topLevel).toEqual([]);
  });

  it('initialises every module-level value with a pure allocation', () => {
    // The module-level values are the state WeakMap, the pending list and the
    // two axis tuples. Each is a literal or an empty container — no call into
    // other code, so importing the module observes nothing and dropping it
    // changes nothing.
    const topLevelConsts = MODULE_SRC.split('\n').filter((l) => /^(const|let) /.test(l));
    expect(topLevelConsts.length).toBeGreaterThan(0);
    for (const line of topLevelConsts) {
      expect(line, `module-level value must be a pure allocation: ${line}`)
        .toMatch(/=\s*(new (WeakMap|Map|Set)<|\[|\{|'|"|\d|true|false)/);
    }
  });
});
