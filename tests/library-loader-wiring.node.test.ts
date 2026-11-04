// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 review C7: the library loader sees the SAME view of `libraries[]`
 * on every path in main.ts — a still-listed bundled catalog URL reads as the
 * realvirtual library project from the very first `setProject` on, not only
 * after the first project-store notification.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

describe('plan-778 review C7 — main.ts hands the loader the bundled-catalog view', () => {
  it('every libraryProjectLoader.setProject call gets withBundledCatalogAsLibraryProject(...) or a view made by it', () => {
    const calls = [...main.matchAll(/libraryProjectLoader\.setProject\(([^;]*)\);/g)].map((m) => m[1].trim());
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const views = new Set([...main.matchAll(/const (\w+) = withBundledCatalogAsLibraryProject\(/g)].map((m) => m[1]));
    for (const arg of calls) {
      const ok = arg.startsWith('withBundledCatalogAsLibraryProject(') || views.has(arg);
      expect(ok, `setProject(${arg})`).toBe(true);
    }
  });
});
