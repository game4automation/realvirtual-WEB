// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-597 §9.2 — every `ui.filter` declaration carries a `ui.category`.
 *
 * A runtime guard over `getRegisteredCapabilities()` proves nothing: tests
 * clear the registry, and the production registrations are scattered module
 * side effects. So this guard scans the SOURCE with the TypeScript parser
 * (tests/helpers/category-coverage-scan.ts). Test files are not scanned.
 *
 * Public tree only, so the guard also runs in the Community edition; the
 * private sibling runs the same scanner over its own tree in its own guard
 * (private tests/component-category-coverage-private.node.test.ts).
 */

import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, scanTree, violations } from './helpers/category-coverage-scan';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_SRC = join(ROOT, 'src');

describe('scanner fixtures (§9.2)', () => {
  const FORMS: Array<[string, string]> = [
    ['registerCapabilities', `registerCapabilities('X', { ui: { filter: 'Xs', badge: '#fff' } });`],
    ['registerComponent', `registerComponent({ type: 'X', capabilities: { ui: { filter: 'Xs' } }, create: () => null });`],
    ['registerTooltipComponent', `registerTooltipComponent(RVX, { pick: 'select', ui: { badge: '#fff', filter: 'Xs', priority: 10 } });`],
    ['constant type key', `registerComponent({ type: X_TYPE, capabilities: { ui: { filter: 'Xs' } } });`],
    ['nested capabilities', `registerComponent({\n  type: 'X',\n  capabilities: {\n    authorable: true,\n    ui: {\n      filter: 'Xs',\n      badge: '#fff',\n    },\n  },\n});`],
  ];

  for (const [name, src] of FORMS) {
    it(`flags a ${name} declaration without category`, () => {
      const decls = scanSource('fixture.ts', src);
      expect(decls).toHaveLength(1);
      expect(violations(decls)).toHaveLength(1);
    });

    it(`flags a ${name} declaration with an unknown or 'other' category`, () => {
      for (const bad of ['custom', 'other']) {
        const withBad = src.replace("filter: 'Xs'", `filter: 'Xs', category: '${bad}'`);
        expect(violations(scanSource('fixture.ts', withBad))).toHaveLength(1);
      }
    });

    it(`accepts a ${name} declaration with a valid category`, () => {
      const ok = src.replace("filter: 'Xs'", "filter: 'Xs', category: 'transport'");
      const decls = scanSource('fixture.ts', ok);
      expect(decls).toHaveLength(1);
      expect(violations(decls)).toHaveLength(0);
    });
  }

  it('resolves the type key of a declaration', () => {
    expect(scanSource('f.ts', FORMS[0]![1])[0]!.typeKey).toBe('X');
    expect(scanSource('f.ts', FORMS[1]![1])[0]!.typeKey).toBe('X');
    expect(scanSource('f.ts', FORMS[3]![1])[0]!.typeKey).toBe('X_TYPE');
  });

  it('ignores comments, JSDoc examples and filter: null', () => {
    const src = `/**\n * registerCapabilities('X', { ui: { filter: 'Xs' } });\n */\n// { filter: 'Ys' }\nregisterCapabilities('Z', { ui: { filter: null } });`;
    expect(scanSource('f.ts', src)).toHaveLength(0);
  });
});

describe('every ui.filter declaration carries a ui.category (§9.2)', () => {
  // Generous timeout: ~3000 files are read, and the full node suite runs
  // forks in parallel (the 5 s default timed out under load).
  it('public tree', { timeout: 60_000 }, () => {
    const decls = scanTree(PUBLIC_SRC, ROOT);
    // Plausibility anchors against a silently empty scan. 39 capability `ui`
    // declarations at plan-597 time (the plan's "~52" counted CSS `filter:`
    // and comments too); 35 leaves room for a merge, not for an empty scan.
    expect(decls.length).toBeGreaterThanOrEqual(35);
    const keys = new Set(decls.map((d) => d.typeKey));
    for (const anchor of ['Drive', 'TransportSurface', 'Lamp']) expect(keys).toContain(anchor);
    const bad = violations(decls).map((d) => `${d.file}:${d.line} filter '${d.filter}' category ${d.category ?? '(missing)'}`);
    expect(bad).toEqual([]);
  });
});
