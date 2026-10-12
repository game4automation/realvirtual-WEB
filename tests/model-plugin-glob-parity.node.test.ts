// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 Phase 3 / R3 — the two private-project globs may not drift apart.
 *
 * `rv-model-plugin-manager.ts` declares the same set of paths twice: once as
 * `privatePluginModuleImporters` (the modules it EXECUTES) and once as
 * `privatePluginSourceImporters` (the same files as `?raw` text, read without
 * executing anything). They have always been wordFOR-word identical, and
 * nothing enforced it.
 *
 * That mattered little while both lists were "one index file per project". It
 * matters now: the source glob is what the export scan (F4) and the migration
 * read, so a file the execution glob can load but the source glob cannot see
 * gets a warning chip for a plugin that works perfectly — and the reverse
 * produces a chip that promises a plugin nothing can load.
 *
 * The test reads the two lists out of the SOURCE rather than out of the module,
 * because a lazy `import.meta.glob` exposes only what it matched on this
 * machine, not the pattern it was asked for — and on a checkout without the
 * private sibling both would be empty and the test vacuous.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE = readFileSync(
  resolve(__dirname, '../src/core/rv-model-plugin-manager.ts'),
  'utf8',
);

/**
 * The glob patterns of one declaration, in source order.
 *
 * Deliberately a source scan and not an import: what is under test is the
 * TEXT the two declarations were written with.
 */
function globPatternsOf(declaration: string): string[] {
  const at = SOURCE.indexOf(`const ${declaration}`);
  expect(at, `${declaration} is no longer declared under that name`).toBeGreaterThan(-1);
  const globAt = SOURCE.indexOf('import.meta.glob', at);
  expect(globAt, `${declaration} no longer uses import.meta.glob`).toBeGreaterThan(-1);
  const open = SOURCE.indexOf('[', globAt);
  const close = SOURCE.indexOf(']', open);
  expect(close).toBeGreaterThan(open);
  return [...SOURCE.slice(open, close).matchAll(/'([^']+)'/g)].map(m => m[1]);
}

describe('plan-479 R3 — execution glob and ?raw glob stay in step', () => {
  it('both declarations name exactly the same patterns, in the same order', () => {
    const execution = globPatternsOf('privatePluginModuleImporters');
    const source = globPatternsOf('privatePluginSourceImporters');

    expect(execution.length).toBeGreaterThan(0);
    // Order matters as much as membership: `Object.entries` iteration order is
    // what the resolvers walk, and two lists that agree on the set but not the
    // order are two different resolution orders.
    expect(source).toEqual(execution);
  });

  it('covers the three project roots, each in both TypeScript flavours', () => {
    const patterns = globPatternsOf('privatePluginModuleImporters');
    for (const root of [
      '../../../realvirtual-WebViewer-Private~/projects',
      '../../../realvirtual-web-pro/projects',
      '../../../projects',
    ]) {
      const ofRoot = patterns.filter(p => p.startsWith(`${root}/`));
      expect(ofRoot, `no pattern for ${root}`).toHaveLength(2);
      expect(ofRoot.some(p => p.endsWith('.ts'))).toBe(true);
      expect(ofRoot.some(p => p.endsWith('.tsx'))).toBe(true);
    }
  });

  it('every pattern reaches below plugins/ at any depth (plan-479 F5)', () => {
    // The point of Phase 3: a document may name its OWN file, not only the
    // project's collecting `index.ts`. A pattern that still ends in
    // `plugins/index.ts` would leave the aggregator mandatory.
    for (const pattern of globPatternsOf('privatePluginModuleImporters')) {
      expect(pattern).toContain('/plugins/**/');
    }
  });

  it('keeps both globs lazy — never one lazy and one eager', () => {
    // Vite #12292: the same pattern used both lazily and eagerly is an open,
    // unconfirmed bug. Both of these are `eager: false` and must stay so.
    for (const declaration of [
      'privatePluginModuleImporters',
      'privatePluginSourceImporters',
    ]) {
      const at = SOURCE.indexOf(`const ${declaration}`);
      const options = SOURCE.slice(at, SOURCE.indexOf('};', at));
      expect(options, `${declaration} must stay lazy`).toContain('eager: false');
    }
  });
});
