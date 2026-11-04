// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.3 (budget half) — variants are opt-in, so their code stays off the
 * startup path. Walks the STATIC import graph from `src/main.ts` (same walker as the
 * eager-source ratchet): no file under `src/core/variants|params|experiments/` or
 * `src/plugins/variants|experiments/` is eager, except the allowlist of §2.7, which
 * together stays ≤ 6 144 B. `src/core/params/**` is not eager through the OLD planning
 * plugin either (its apply runner reaches the hull through `import()`, Gate R1 #6).
 */

import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eagerGraph, norm, REPO_ROOT as ROOT } from '../helpers/static-import-graph';

const GUARDED = [
  'src/core/variants/', 'src/core/params/', 'src/core/experiments/',
  'src/plugins/variants/', 'src/plugins/experiments/',
];
const ALLOW = [
  'src/plugins/variants/index.ts',
  'src/plugins/variants/variant-command-descriptors.ts',
  'src/plugins/experiments/index.ts',
  'src/plugins/experiments/experiment-command-descriptors.ts',
  'src/core/hmi/rv-run-lease.ts',
];
const BUDGET = 6144;

const rel = (f: string): string => norm(f).replace(/^.*?realvirtual-WebViewer~\//, '').replace(/^.*?2013-p1\//, '');

describe('variants: opt-in bundle boundary (9.3)', () => {
  const files = [...eagerGraph(resolve(ROOT, 'src/main.ts'))].map((f) => ({ abs: f, rel: rel(f) }));

  it('walks a real graph that contains the eager loader', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.rel.endsWith('src/plugins/variants/index.ts'))).toBe(true);
  });

  it('no variant / param / experiment code is eager outside the allowlist', () => {
    const leaked = files
      .filter((f) => GUARDED.some((g) => f.rel.includes(g)))
      .filter((f) => !ALLOW.some((a) => f.rel.endsWith(a)))
      .map((f) => f.rel);
    expect(leaked).toEqual([]);
  });

  it('the old planning plugin does not make the apply service eager (lazy adapter)', () => {
    const viaPlanning = [...eagerGraph(resolve(ROOT, 'src/plugins/planning-parameters/index.ts'))].map(rel);
    expect(viaPlanning.filter((f) => f.includes('src/core/params/'))).toEqual([]);
  });

  // Measured as minified JS (what the startup bundle carries), not as source bytes: a
  // source-byte budget made the eager files drop their comments to fit.
  it(`the eager allowlist stays within ${BUDGET} B minified`, () => {
    const eagerAllowed = files.filter((f) => ALLOW.some((a) => f.rel.endsWith(a)));
    const sizes = eagerAllowed.map((f) => ({
      rel: f.rel,
      bytes: transformSync(readFileSync(f.abs, 'utf8'), { loader: 'ts', minify: true }).code.length,
    }));
    const bytes = sizes.reduce((n, s) => n + s.bytes, 0);
    expect(bytes, sizes.map((s) => `${s.rel}: ${s.bytes}`).join(', ')).toBeLessThanOrEqual(BUDGET);
  });
});
