// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * model-url-alias — an old `?model=` link still opens the demo (plan-737 9.2).
 *
 * The demo models have now lived at three addresses: the deploy root, then
 * `models/`, then the deploy root again, and since plan-737
 * `demo-realvirtual/`. Every one of those spellings is in circulation in a
 * shared link, a bookmark, a slide, and a `localStorage` value.
 *
 * `savedModel` and `configModel` in `main.ts` have always resolved by FILE NAME
 * for exactly this reason. `urlModel` did not — it was passed through as a URL —
 * which was harmless only while that URL happened to be right. This pins the
 * rule the alias implements, on the same shape `main.ts` uses, so it cannot
 * silently regress into "the value is a URL, so it must be correct".
 *
 * The resolution itself is a pure function of the catalogue, so it is tested as
 * one rather than by booting `main.ts`.
 */

import { describe, expect, it } from 'vitest';
import { DEMO_BASE_PATH } from '../src/core/project/backends/bundled-backend';

interface Entry { filename: string; url: string }

/** The catalogue a plan-737 deploy resolves for the demo folder. */
const ENTRIES: Entry[] = [
  { filename: 'DemoRealvirtualWeb.glb', url: `/${DEMO_BASE_PATH}DemoRealvirtualWeb.glb` },
  { filename: 'DemoPlanner.glb', url: `/${DEMO_BASE_PATH}DemoPlanner.glb` },
];

/**
 * The rule from `main.ts`, restated. Matched on the file name with query and
 * fragment stripped — the same key `savedEntry` uses.
 */
function resolveModelParam(urlModel: string | null, entries: Entry[]): string | null {
  const base = urlModel?.split(/[?#]/)[0].split('/').pop()?.toLowerCase() ?? '';
  const hit = urlModel
    ? entries.find(e => e.url === urlModel || e.filename.toLowerCase() === base)
    : null;
  return hit?.url ?? urlModel ?? null;
}

describe('?model= alias resolution', () => {
  it('resolves the old deploy-root link', () => {
    expect(resolveModelParam('/DemoRealvirtualWeb.glb', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('resolves the older models/ link', () => {
    expect(resolveModelParam('models/DemoRealvirtualWeb.glb', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
    expect(resolveModelParam('/models/DemoRealvirtualWeb.glb', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('resolves a bare file name', () => {
    expect(resolveModelParam('DemoRealvirtualWeb.glb', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('is case-insensitive on the file name, like the saved-model match', () => {
    expect(resolveModelParam('/models/demorealvirtualweb.GLB', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('ignores a query string and a fragment when matching', () => {
    expect(resolveModelParam('/DemoRealvirtualWeb.glb?v=2#hash', ENTRIES))
      .toBe('/demo-realvirtual/DemoRealvirtualWeb.glb');
  });

  it('leaves the current link untouched', () => {
    const current = '/demo-realvirtual/DemoPlanner.glb';
    expect(resolveModelParam(current, ENTRIES)).toBe(current);
  });

  it('passes an unknown model through unchanged', () => {
    // It may legitimately address a host this catalogue knows nothing about;
    // rewriting it would break the deep links that work today.
    const foreign = 'https://cdn.example/customer/models/Press.glb';
    expect(resolveModelParam(foreign, ENTRIES)).toBe(foreign);
    expect(resolveModelParam('/Nothing.glb', ENTRIES)).toBe('/Nothing.glb');
  });

  it('is null when nothing was asked for', () => {
    expect(resolveModelParam(null, ENTRIES)).toBeNull();
  });

  it('degrades gracefully when the deploy ships no demo folder', () => {
    // An empty catalogue must not turn a working link into null — the value is
    // passed through and the loader reports its own 404.
    expect(resolveModelParam('/DemoRealvirtualWeb.glb', []))
      .toBe('/DemoRealvirtualWeb.glb');
  });
});
