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
/** plan-501 §9.7: the SiMoRob acceptance bands and the runtime/main-thread measurement run only
 *  with RV_PLAN501_ACCEPTANCE=1 (red until the numeric reference arrives). Test-only; statically
 *  false in every build. */
declare const __RV_PLAN501_ACCEPTANCE__: boolean;
//! True only in the embed library build, which ships no model plugins.
declare const __RV_EMBED__: boolean;

/** True when building with RV_COMMERCIAL=1 env var. Hides AGPL watermark. */
declare const __RV_COMMERCIAL__: boolean;

/** True on the dev server (and vitest) or when building with RV_INTERNAL=1.
 *  Gates internal/dev-only private features (DES, IK solver, STEP import, …)
 *  out of customer deploys — the gated dynamic import and its chunks are
 *  eliminated from the bundle when false. */
declare const __RV_INTERNAL__: boolean;

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
