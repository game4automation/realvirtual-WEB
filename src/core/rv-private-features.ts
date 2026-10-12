// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-private-features — the contract between `main.ts` and every
 * `@rv-private/private-plugins` entry (plan-598 F2).
 *
 * Three shapes of that entry exist and all three export the SAME two functions:
 *
 *   - the checked-in private entry (`realvirtual-WebViewer-Private~/src/private-plugins.ts`),
 *   - the community stub (`src/private-stubs/private-plugins.ts`, no-op),
 *   - the generated customer entry (`scripts/_workspace-lib.mjs`,
 *     `generateCustomerPrivatePlugins()`).
 *
 * ## Why two functions
 *
 * `registerPrivatePlugins(viewer)` used to `await import()` each feature adapter
 * and register it, one after the other — so the download of feature N+1 started
 * only when feature N had finished REGISTERING, all of it serially in front of
 * the first GLB request. The registration order is a contract (modes, component
 * registrations and the smooth-motion gate must be settled before the first
 * model loads), the download order is not. So the two are split:
 *
 *   1. `prefetchPrivateFeatures()` — called early in `init()`. Starts the
 *      `import()` of every feature whose module is free of load-time side
 *      effects and returns the promises. Registers NOTHING. A feature module may
 *      export an idempotent `prefetch()` hook (smooth motion uses it to start its
 *      wasm fetch); it runs as soon as the module arrives.
 *   2. `registerPrivatePlugins(viewer, mods)` — called at the SAME place as
 *      before, registers in the SAME fixed order, and consumes a prefetched
 *      promise where there is one instead of importing again.
 *
 * Features whose modules DO have load-time side effects (component / schema /
 * command registrations at module top level) are not prefetched: evaluating
 * them earlier would move those side effects in front of the core plugin
 * registration. Which features those are is declared once, in the private
 * `tier-manifest.json` (`loadSideEffects: true`); `tests/private-features-prefetch.test.ts`
 * pins the checked-in entry against it.
 */

import type { RVViewer } from './rv-viewer';

/** The shape every `features/*.register.ts` adapter exports. */
export interface PrivateFeatureModule {
  register: (viewer: RVViewer) => Promise<void>;
  /** Optional, idempotent: start expensive work (a wasm fetch) before `register()`. */
  prefetch?: () => unknown;
}

export type PrivateFeatureLoader = () => Promise<PrivateFeatureModule>;

/** Feature id → the already-running import of its adapter module. */
export type PrivateFeatureModules = ReadonlyMap<string, Promise<PrivateFeatureModule>>;

/** The empty set — what the community stub prefetches. */
export const NO_PREFETCHED_FEATURES: PrivateFeatureModules = new Map();

/**
 * Start the given imports now and return them keyed by feature id.
 *
 * Every promise gets a no-op rejection handler attached, so a chunk that fails
 * to load is not reported as an unhandled rejection before `registerPrivatePlugins`
 * gets to it — the ORIGINAL promise (still rejecting) is what is handed on, and
 * the register pass reports the failure exactly as it always did.
 */
export function startPrivateFeatureImports(
  loaders: ReadonlyArray<readonly [string, PrivateFeatureLoader]>,
): PrivateFeatureModules {
  const started = new Map<string, Promise<PrivateFeatureModule>>();
  for (const [feature, load] of loaders) {
    let p: Promise<PrivateFeatureModule>;
    try {
      p = load();
    } catch (error) {
      p = Promise.reject(error);
    }
    const withHook = p.then((mod) => {
      try { mod.prefetch?.(); } catch (error) {
        console.warn(`[private-plugins] feature "${feature}" prefetch hook failed:`, error);
      }
      return mod;
    });
    withHook.catch(() => { /* reported by the register pass */ });
    started.set(feature, withHook);
  }
  return started;
}

/**
 * Register one feature, isolated: a throwing adapter (or a chunk that failed to
 * load) is logged and skipped, so one broken subsystem cannot abort the pass.
 * Uses the prefetched import when there is one, else imports now.
 */
export async function registerPrivateFeature(
  viewer: RVViewer,
  feature: string,
  load: PrivateFeatureLoader,
  mods?: PrivateFeatureModules,
): Promise<void> {
  try {
    const { register } = await (mods?.get(feature) ?? load());
    await register(viewer);
  } catch (error) {
    console.error(`[private-plugins] feature "${feature}" failed to register:`, error);
  }
}
