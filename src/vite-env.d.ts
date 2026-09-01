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

/** Which checkout the dev server is serving — `null` in every built bundle.
 *  `root` is the served directory (the authority); `plans`/`slug`/`vitePort`
 *  come from the worktree session manifest and are null in the canonical
 *  checkout. Read it through `rv-serve-info.ts`, never directly, so vitest
 *  (which defines no globals) does not hit a ReferenceError. */
declare const __RV_SERVE_INFO__: {
  root: string;
  branch: string;
  plans: number[] | null;
  slug: string | null;
  vitePort: number | null;
} | null;
