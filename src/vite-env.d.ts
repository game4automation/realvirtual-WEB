/// <reference types="vite/client" />

// NOTE: the `VITE_UNIFIED_SIM` feature flag (Plan 194) was removed in the
// runtime unification (Phase B) — the SimulationKernel path is the only
// fixed-update orchestration now.
interface ImportMetaEnv {}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** True when the private sibling folder (realvirtual-WebViewer-Private~) is present at build time. */
declare const __RV_HAS_PRIVATE__: boolean;
/** plan-467 F15: real-WASM physics tests must fail instead of skip. Test-only;
 *  statically false in every build (see vite.config.ts `define`). */
declare const __RV_PHYSICS_REQUIRE_WASM__: boolean;
/** plan-501 SOL R2 #3: real-WASM kinematic-solver tests must fail instead of skip
 *  (RV_SOLVER_REQUIRE_WASM=1). Test-only; statically false in every build. */
declare const __RV_SOLVER_REQUIRE_WASM__: boolean;
/** plan-501 §9.7: the robotics model acceptance bands and the runtime/main-thread measurement run only
 *  with RV_PLAN501_ACCEPTANCE=1 (red until the numeric reference arrives). Test-only; statically
 *  false in every build. */
declare const __RV_PLAN501_ACCEPTANCE__: boolean;
/** plan-612 Phase 6: long-run knobs of the PalletYard soak tests (RV_SOAK_DAYS, RV_SOAK_ANIMATED_SEC);
 *  0 = the test default. Test-only; statically 0 in every build. */
declare const __RV_SOAK_DAYS__: number;
declare const __RV_SOAK_ANIMATED_SEC__: number;
//! True only in the embed library build, which ships no model plugins.
declare const __RV_EMBED__: boolean;

/** True when building with RV_COMMERCIAL=1 env var. Makes the build installable (PWA manifest). */
declare const __RV_COMMERCIAL__: boolean;

/** plan-679 Phase 9: true exactly in a pure AGPL/community build (no private tree compiled in);
 *  only then does index.html carry the AGPL watermark. Derived from the build stage, not settable. */
declare const __RV_AGPL_ATTRIBUTION__: boolean;

/** True on the dev server (and vitest) or when building with RV_INTERNAL=1.
 *  Gates internal/dev-only private features (DES, IK solver, STEP import, …)
 *  out of customer deploys — the gated dynamic import and its chunks are
 *  eliminated from the bundle when false. */
declare const __RV_INTERNAL__: boolean;
/** plan-646 F14: true only in the `--demo --path demo` build (public demo welcome window). */
declare const __RV_DEMO_WELCOME__: boolean;

/** plan-2209: terms consent for the public demo or a commercial developer workspace. */
declare const __RV_TERMS_GATE__: 'off' | 'demo' | 'developer';

/** Framework-synced semantic version (from package.json, e.g. "6.3.0"). */
declare const __RV_VERSION__: string;
/** Web-specific build number = commit count of this repo, e.g. "1247". */
declare const __RV_WEB_BUILD__: string;
/** Short git hash of the built commit, e.g. "a1b2c3d" ("" if unavailable). */
declare const __RV_COMMIT__: string;
/** Date of the built commit, "YYYY-MM-DD". */
declare const __RV_BUILD_DATE__: string;
/** When the build ran, local time "YYYY-MM-DD HH:MM" (no seconds, no time zone). */
declare const __RV_BUILD_TIME__: string;

/** The Isaac Sim extension download (plan-637 Phase 6, `scripts/_rv-livesync-extension.mjs`):
 *  extension version and deploy-relative zip path, or null when the build tree has no
 *  `integrations/omniverse-kit`. Undefined in configs without the plugin (embed, node tests) —
 *  read it through `livesyncExtensionDownload()`, never directly. */
declare const __RV_LIVESYNC_EXT__: { version: string; path: string } | null;

/** Which checkout the dev server is serving — `null` in every built bundle.
 *  `root` is the served directory (the authority); `plans`/`slug`/`vitePort`
 *  come from the worktree session manifest and are null in the canonical
 *  checkout. Read it through `rv-serve-info.ts`, never directly, so vitest
 *  (which defines no globals) does not hit a ReferenceError. */
declare const __RV_SERVE_INFO__: {
  host: string;
  root: string;
  branch: string;
  plans: number[] | null;
  slug: string | null;
  vitePort: number | null;
} | null;
