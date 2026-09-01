// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * e2e-import-specifier — the E2E suite must stay collectable (plan-731 §9.1, F1).
 *
 * `@playwright/test` is NOT a dependency of this package; `playwright/test` is a
 * regular export of the installed `playwright` package and is what
 * `playwright.config.ts` uses. A single spec importing `@playwright/test`
 * makes `npm run e2e` fail at COLLECTION time — every spec, not just that one —
 * which is what plan-726 mistook for a repo-wide dependency defect.
 *
 * This test pins the specifier so the blocker cannot come back silently.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { globSync } from 'node:fs';

const ROOT = resolve(__dirname, '..');

describe('e2e import specifiers', () => {
  it('no spec imports @playwright/test (only playwright/test resolves here)', () => {
    const specs = globSync('e2e/**/*.spec.ts', { cwd: ROOT });
    expect(specs.length).toBeGreaterThan(0);

    const offenders = specs.filter((rel) =>
      readFileSync(resolve(ROOT, rel), 'utf8').includes("from '@playwright/test'"),
    );
    expect(offenders).toEqual([]);
  });

  it('playwright/test resolves from this package', () => {
    expect(() => require.resolve('playwright/test')).not.toThrow();
  });
});
