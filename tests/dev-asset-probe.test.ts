// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-395 §7.2 — the availability probe, and the serving it probes.
 *
 * This file is the reason the whole skip mechanism can be trusted. Roughly
 * twenty browser suites now decide whether to run by asking
 * `devAssetAvailable()`, and if that function ever answered `true`
 * indiscriminately the suites would all run and fail, while if it answered
 * `false` indiscriminately they would all skip and the run would be green
 * having checked nothing. The second failure is the dangerous one, because it
 * looks like success — so both directions are pinned here.
 *
 * The trap being guarded is real and was measured in the plan-395 spike: the
 * Vite dev server answers EVERY unknown path with the SPA fallback,
 * `200 text/html`. A probe written the obvious way (`res.ok`) is therefore true
 * for an asset that does not exist.
 *
 * This file itself must NOT skip — it is the test of the skip.
 */

import { describe, it, expect } from 'vitest';
import { devAssetAvailable, devAssetsAvailable } from './fixtures/dev-asset-available';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

/**
 * A path the dev server certainly does not have, and that the SPA fallback
 * therefore answers with `200 text/html`.
 *
 * Deliberately NOT under `/private-assets/`: since plan-395 that prefix is
 * owned by the hardened route, which ends in a real 404 (asserted below). The
 * fallback — the actual trap — lives on every OTHER unknown path, and that is
 * the state a public checkout is in for the whole prefix, because with no
 * private sibling the plugin is not installed and nothing claims it.
 */
const ABSENT = '/definitely-not-here-395.glb';

/**
 * Whether the `/private-assets/` route is mounted at all.
 *
 * Two of the assertions below are about what that ROUTE does, so they need it to
 * exist. Without the private sibling — and under `RV_NO_PRIVATE=1`, which is how
 * that state is simulated — the plugin is never installed and `/private-assets/`
 * is just another unknown path the SPA fallback answers. Asserting a 404 there
 * would be asserting that a plugin nobody mounted behaves correctly.
 *
 * Everything else in this file runs in both worlds, deliberately: this is the
 * test OF the skip mechanic, so it is the one file that must not skip itself.
 */
const ROUTE_MOUNTED = await devAssetAvailable(DEV_GLB.tests);

describe('devAssetProbe_IgnoresSpaFallback', () => {
  it('reports the SPA fallback as NOT available, even though it is a 200', async () => {
    const raw = await fetch(ABSENT, { method: 'HEAD' });
    // The precondition, asserted rather than assumed: if the dev server ever
    // starts 404-ing unknown paths, this test would otherwise still pass while
    // no longer testing anything.
    expect(raw.ok, 'dev server is expected to answer unknown paths with the SPA fallback').toBe(true);
    expect(raw.headers.get('content-type') ?? '').toMatch(/text\/html/);

    expect(await devAssetAvailable(ABSENT)).toBe(false);
  });

  it.runIf(ROUTE_MOUNTED)('answers a missing private file with a real 404', async () => {
    // Worth its own line, separate from the SPA-fallback case above: the route
    // must not hand the fallback to a missing private asset, or a traversal
    // probe would be indistinguishable from a hit.
    const raw = await fetch('/private-assets/Development/fixtures/not-here-395.glb', { method: 'HEAD' });
    expect(raw.status).toBe(404);
  });

  it.runIf(ROUTE_MOUNTED)('refuses a traversal attempt over HTTP, not only in the resolver unit test', async () => {
    const raw = await fetch('/private-assets/Development/%2e%2e%2ffesto/project.json', { method: 'HEAD' });
    expect(raw.status).toBe(404);
  });

  it('reports an unreachable origin as not available instead of throwing', async () => {
    expect(await devAssetAvailable('http://127.0.0.1:9/nope.glb')).toBe(false);
  });
});

describe('devAssetProbe_TrueForRealAsset', () => {
  it('reports every DEV_GLB entry as available when the private sibling is there', async () => {
    // Not conditional on purpose. With the sibling present (the state of every
    // development machine and of the gate that matters) all seven must probe
    // true; if one does not, the suite that loads it would silently skip and
    // nobody would notice, which is exactly the failure §2.11 exists to catch.
    const results = await Promise.all(
      Object.entries(DEV_GLB).map(async ([key, url]) => [key, await devAssetAvailable(url)] as const),
    );
    const unavailable = results.filter(([, ok]) => !ok).map(([key]) => key);
    const anyAvailable = results.some(([, ok]) => ok);
    if (!anyAvailable) {
      // No sibling at all: that is the public-checkout case, and this file has
      // nothing to assert there. It is a different statement from "one of seven
      // is missing", which is a defect and fails below.
      expect(unavailable.length).toBe(Object.keys(DEV_GLB).length);
      return;
    }
    expect(unavailable, 'these DEV_GLB entries are not served — the suites loading them would skip').toEqual([]);
  });

  it('devAssetsAvailable is true only when all of them are', async () => {
    expect(await devAssetsAvailable(ABSENT, DEV_GLB.tests)).toBe(false);
  });
});

describe('projectSubfolders_ServedGenerically', () => {
  it('serves fixtures/, models/ and library/ of a project through the one route', async () => {
    const probes = await Promise.all([
      fetch(DEV_GLB.tests, { method: 'HEAD' }),
      fetch(DEV_GLB.robotIK, { method: 'HEAD' }),
    ]);
    const served = probes.filter(p => /gltf-binary|octet-stream/.test(p.headers.get('content-type') ?? ''));
    if (served.length === 0) return; // public checkout — nothing to serve, see above
    expect(served.length).toBe(probes.length);
    for (const p of served) {
      // `no-store` matters: these files change under the developer's hands and a
      // cached 36 MB fixture is a debugging session nobody enjoys.
      expect(p.headers.get('cache-control')).toBe('no-store');
    }
  });
});
