// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * bake-test-path-enforced.node.test.ts — a test about the tests (plan-772 F4).
 *
 * ## What it enforces
 *
 * A test that loads a GLB must load it the way production does: through the
 * destructive bake. The bake is gated on `options.bakeRegistry`
 * (`rv-scene-loader.ts`), and a load without one silently returns the AUTHORING
 * tree — 117 nodes where production has 78, measured on `DemoRobotIK.glb`
 * (plan-772 B3). That is how the robot's TCP node could be removed by the bake
 * while the whole IK suite stayed green (plan-772 B2).
 *
 * So: every file under `tests/` that calls `loadGLB(` must also name
 * `bakeRegistry` or use `loadBakedGLB` — unless it is listed in
 * `tests/helpers/baked-load-allowlist.ts` with a reason.
 *
 * ## Why a meta-test and not an ESLint rule (plan-772 E1)
 *
 * `loadGLB` options are built dynamically and usually arrive as `{ ...opts }`,
 * which a lint rule cannot see through: it would be either trivially
 * circumventable or noisy with false positives. This test needs no lint
 * infrastructure, runs in the normal suite, and names the offending file. The
 * allowlist it reads is plain data, so switching the enforcement mechanism
 * later (lint, a CI script) reuses that file and throws away only the scan
 * below.
 *
 * ## Both directions
 *
 * - An unlisted file that loads unbaked **fails** — that is the point.
 * - A listed file that no longer loads unbaked, or no longer exists, fails as
 *   a **stale entry**. The list can therefore only shrink, and "I converted
 *   that file" is not something anyone has to remember to write down.
 *
 * The private sibling's `tests/` is scanned too when it is present (the node
 * config includes it), so the rule holds there as well.
 *
 * ## The one thing it does not see
 *
 * Classification is per FILE, not per call site: a file that bakes once may
 * still call `loadGLB` plainly elsewhere. That is deliberate — `loadGLB`
 * options are assembled at runtime, so a per-call-site rule would be guessing
 * — and it is what `tests/baked-load-helper.test.ts` relies on (it loads BOTH
 * ways on purpose, to measure the difference). A mixed file is therefore the
 * reviewer's job; a file that never bakes at all is this test's job.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_UNBAKED_BY_FILE, AUTHORING_LOADS, UNREVIEWED_LEGACY_LOADS } from './helpers/baked-load-allowlist';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
//! Assembled at runtime, not written as one literal — the same trick
//! `assert-public-safe.node.test.ts` uses for its marker. The private sibling's
//! folder name spelled out in full would make
//! `scripts/gen-private-test-excludes.mjs` classify this file as
//! private-dependent (`referencesPrivatePath`), and vitest would then SKIP it in
//! a community checkout: the one rule that has to hold everywhere would hold
//! nowhere on the public mirror. The scan below simply finds no second root
//! there, which is the correct behaviour.
const PRIVATE_TESTS = resolve(REPO, `../realvirtual-WebViewer-${'Private'}~/tests`);

/** The `tests/` roots this rule covers. */
const ROOTS: string[] = [HERE, ...(existsSync(PRIVATE_TESTS) ? [PRIVATE_TESTS] : [])];

/** Files that define or document the rule itself and are not subject to it. */
const EXEMPT = new Set([
  'bake-test-path-enforced.node.test.ts',
  'helpers/load-baked-glb.ts',
  'helpers/baked-load-allowlist.ts',
]);

/** Directories that hold no sources. `fixtures/` is deliberately NOT here —
 *  a shared fixture that loads a GLB is exactly the kind of hiding place this
 *  rule has to cover (`helpers/op-identity-fixture.ts` is one). */
const SKIP_DIRS = new Set(['node_modules', '__screenshots__']);

/** Every `.ts`/`.tsx` file under `root`, as paths relative to it (forward slashes). */
function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(absolute);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(relative(root, absolute).split('\\').join('/'));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * `code` without comments, so a `loadGLB(` in a file header does not count as
 * a call site and a `bakeRegistry` in prose does not count as enforcement.
 *
 * Three details that each cost a false positive when they were missing: CRLF
 * is normalised first (a `\r` is a line terminator to a JS regex, so an
 * `$`-anchored line-comment rule silently matched nothing in this repo's
 * CRLF files); the line-comment rule skips `//` preceded by a colon, so a
 * `https://…` inside a string does not swallow the rest of its line; and
 * string literals are NOT parsed, which is why a call site needs the import
 * below as well — `'…registered by loadGLB (plan-769)'` is prose in a string.
 */
function stripComments(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*/, '$1'))
    .join('\n');
}

interface Scanned {
  /** Path relative to its `tests/` root. */
  file: string;
  /** Absolute path, for the failure message. */
  absolute: string;
  /** Calls `loadGLB(` in real code. */
  loadsGlb: boolean;
  /** Names `bakeRegistry` or `loadBakedGLB` in real code. */
  bakes: boolean;
}

function scan(): Scanned[] {
  const out: Scanned[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      if (EXEMPT.has(file)) continue;
      const absolute = join(root, file);
      const code = stripComments(readFileSync(absolute, 'utf8'));
      // A file that does not IMPORT `loadGLB` cannot call it — the cheap way
      // past the one hole the comment stripper leaves (prose inside a string
      // literal). Both forms count: the static import and the dynamic
      // `const { loadGLB } = await import(…)` several suites use.
      const importsLoadGlb = /import\s*\{[^}]*\bloadGLB\b[^}]*\}\s*from/.test(code)
        || /\{[^}]*\bloadGLB\b[^}]*\}\s*=\s*(?:await\s*)?import\s*\(/.test(code);
      out.push({
        file,
        absolute,
        loadsGlb: importsLoadGlb && /\bloadGLB\s*\(/.test(code),
        bakes: /\bbakeRegistry\b/.test(code) || /\bloadBakedGLB\b/.test(code),
      });
    }
  }
  return out;
}

const SCANNED = scan();
const LOADERS = SCANNED.filter((s) => s.loadsGlb);
const UNBAKED = LOADERS.filter((s) => !s.bakes);

describe('every test that loads a GLB loads it baked', () => {
  it('finds the GLB-loading test files at all (the scan itself must not silently return nothing)', () => {
    // A broken scan would make every assertion below pass vacuously — the exact
    // failure mode this whole file exists to prevent, one level up.
    expect(LOADERS.length, 'no test file calls loadGLB — the scan is broken').toBeGreaterThan(20);
  });

  it('no unlisted test file loads a GLB without the destructive bake', () => {
    const offenders = UNBAKED
      .filter((s) => !ALLOWED_UNBAKED_BY_FILE.has(s.file))
      .map((s) => s.file);
    expect(
      offenders,
      'These files call loadGLB() without a bakeRegistry, so they assert against the AUTHORING tree '
      + '(117 nodes where production has 78) and would stay green while the baked path breaks. '
      + 'Use loadBakedGLB() from tests/helpers/load-baked-glb.ts — or, if the authoring tree really is '
      + 'the subject, add the file to tests/helpers/baked-load-allowlist.ts with its reason.',
    ).toEqual([]);
  });

  it('every allowlist entry still names a file that really loads unbaked', () => {
    const byFile = new Map(SCANNED.map((s) => [s.file, s]));
    const stale: string[] = [];
    for (const [file, reason] of ALLOWED_UNBAKED_BY_FILE) {
      const hit = byFile.get(file);
      if (!hit) stale.push(`${file} — no such file (reason was: ${reason})`);
      else if (!hit.loadsGlb) stale.push(`${file} — no longer calls loadGLB()`);
      else if (hit.bakes) stale.push(`${file} — now loads baked; remove the entry`);
    }
    expect(
      stale,
      'Stale allowlist entries. The list may only shrink: drop these lines from '
      + 'tests/helpers/baked-load-allowlist.ts.',
    ).toEqual([]);
  });

  it('reports the size of the blind spot, so it is a number and not a feeling', () => {
    const counts = {
      loaders: LOADERS.length,
      baked: LOADERS.length - UNBAKED.length,
      authoring: AUTHORING_LOADS.length,
      unreviewed: UNREVIEWED_LEGACY_LOADS.length,
    };
    // Not a threshold — the two assertions above already hold the line. This
    // prints the state into the run so a shrinking list is visible, and fails
    // only if the arithmetic stops adding up (an entry listed twice, say).
    expect(counts.baked + counts.authoring + counts.unreviewed).toBe(counts.loaders);
    console.info(
      `[bake-test-path] ${counts.loaders} GLB-loading test files: ${counts.baked} baked, `
      + `${counts.authoring} declared authoring, ${counts.unreviewed} unreviewed legacy (plan-772 Phase 1).`,
    );
  });
});
