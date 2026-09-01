// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The availability probe for the internal GLB assets (plan-395 §2.6, F5/F5b).
 *
 * Every asset in `DEV_GLB` lives in the private Development project, which only
 * exists on a development machine. A public checkout has no private sibling, so
 * the tests that load one must report **`skipped`** there — not `passed`, which
 * is what an early `return` produces and what makes a suite green while it
 * checks nothing.
 *
 * The pairing is always the same:
 *
 * ```ts
 * const AVAILABLE = await devAssetAvailable(DEV_GLB.tests);
 * describe.skipIf(!AVAILABLE)('…', () => {
 *   beforeAll(async () => { …load the GLB… });
 *   it('…', () => { … });
 * });
 * ```
 *
 * Top-level `await` is deliberate and measured: the probe resolves BEFORE the
 * `describe` registers, a skipped suite's `beforeAll` never runs (so the
 * expensive load may stay there), and nested `describe`s inherit the skip.
 *
 * **Why the probe cannot just be `res.ok`** — the trap the plan-395 spike found,
 * and the reason this helper exists once instead of being copied into ~20 files:
 * the Vite dev server answers EVERY unknown path with the SPA fallback,
 * `200 text/html`. `res.ok` is therefore `true` for a GLB that is not there, so
 * `skipIf(!res.ok)` would never skip, every suite would run, and each would fail
 * deep inside a GLTF parser on an HTML document. The content type is what
 * distinguishes an asset from the fallback, so the content type is what is
 * checked.
 */

/** Content types the dev server and a static deploy use for a `.glb`. */
const GLB_CONTENT_TYPE = /gltf-binary|octet-stream/i;

/**
 * True when `url` really serves a GLB — not the dev server's HTML fallback.
 *
 * A `HEAD` request: the body is up to 36 MB and nothing here needs it. Network
 * errors resolve to `false` rather than throwing, because "the asset is not
 * reachable" and "the asset is not there" lead to the same decision, and a
 * throw at module scope would fail the file instead of skipping it.
 */
export async function devAssetAvailable(url: string): Promise<boolean> {
  try {
    const probe = await fetch(url, { method: 'HEAD' });
    if (!probe.ok) return false;
    return GLB_CONTENT_TYPE.test(probe.headers.get('content-type') ?? '');
  } catch {
    return false;
  }
}

/** True when every one of `urls` really serves a GLB. */
export async function devAssetsAvailable(...urls: string[]): Promise<boolean> {
  const results = await Promise.all(urls.map(devAssetAvailable));
  return results.every(Boolean);
}

/**
 * The reason string to hand a Playwright `test.skip(condition, reason)`.
 *
 * Exported so every spec says the same thing: a skip whose reason reads
 * "missing fixture" sends the next person looking for a bug that is not there.
 */
export const DEV_ASSET_SKIP_REASON =
  'internal asset unavailable — needs the private realvirtual-WebViewer-Private~ sibling '
  + '(projects/Development), see plan-395';
