// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Checked-in state goldens for the e2e suite (plan-600 F6).
 *
 * There was no baseline mechanic in this repo before: `toMatchFileSnapshot` /
 * `toMatchSnapshot` appear in no test file, and `tests/**\/__screenshots__/` is
 * gitignored. So this one is deliberately small and deliberately strict:
 *
 * - goldens live in `e2e/__goldens__/<spec>/<step>.json` and ARE checked in;
 * - a MISSING golden is RED — it is never written silently. Only an explicit
 *   `RV_UPDATE_GOLDENS=1` creates or rewrites one;
 * - the comparison is EXACT (the snapshot has already been rounded by the
 *   collector) — there is no tolerance band;
 * - the JSON is written one key per line, so a single changed drive shows up as
 *   a single line in `git diff`.
 *
 * A golden is only meaningful when it is compared across FRESH runs — two calls
 * within one run prove nothing about reproducibility.
 */

import { expect } from 'playwright/test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Root of the checked-in goldens. */
export const GOLDEN_ROOT = resolve(HERE, '__goldens__');

/** True when the run is allowed to create or rewrite goldens. */
export function goldensAreUpdating(): boolean {
  return process.env.RV_UPDATE_GOLDENS === '1';
}

/** Absolute path of the golden file for `name` (e.g. `golden-pilot/start`). */
export function goldenPath(name: string): string {
  return join(GOLDEN_ROOT, `${name}.json`);
}

/** The canonical on-disk form: one key per line, trailing newline. */
export function serializeGolden(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Compares `actual` against the checked-in golden `name`.
 *
 * Fails when the golden does not exist (naming the way to create it) and when
 * the value differs. With `RV_UPDATE_GOLDENS=1` it writes instead of comparing
 * and returns `'written'`.
 */
export function expectGolden(name: string, actual: unknown): 'compared' | 'written' {
  const file = goldenPath(name);

  if (goldensAreUpdating()) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, serializeGolden(actual), 'utf8');
    return 'written';
  }

  if (!existsSync(file)) {
    throw new Error(
      `Golden "${name}" does not exist (${file}).\n`
      + 'A missing golden is a failure, not a reason to create one. If this state is '
      + 'intended, record it deliberately:\n'
      + `  RV_UPDATE_GOLDENS=1 npx playwright test <spec>\n`
      + 'then review the written file in `git diff` before committing it.',
    );
  }

  const expected = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  // Exact: the collector already rounded what needed rounding.
  expect(actual, `state golden "${name}" (${file})`).toEqual(expected);
  return 'compared';
}
