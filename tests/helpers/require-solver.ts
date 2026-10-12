// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * require-solver — the ONE skip guard of the kinematic-solver suites (plan-501 SOL R1 #9, R2 #3).
 *
 * Extracted from `mechanism-inverse.test.ts`: without the `rv_kinematic_solver.wasm` artifact a
 * solver suite skips LOUDLY — which is right for a community checkout and wrong for the closing
 * gate, where a green run without the solver proves nothing. With `RV_SOLVER_REQUIRE_WASM=1` the
 * build constant `__RV_SOLVER_REQUIRE_WASM__` (vite.config.ts `define`, because the suites run in
 * browser mode where a shell variable is invisible) turns the skip into a FAILURE.
 */

/** True when the current run was started with `RV_SOLVER_REQUIRE_WASM=1`. */
export const SOLVER_REQUIRE_WASM: boolean =
  typeof __RV_SOLVER_REQUIRE_WASM__ !== 'undefined' && __RV_SOLVER_REQUIRE_WASM__;

/** What a provider exposes about its load — structural, so any provider (or a fake) fits. */
export interface SolverLoadState {
  available: boolean;
  failure?: string;
  failureDetail?: string;
}

/**
 * Skip (or, when required, fail) a solver test whose artifact is missing. Returns true when the
 * test may run.
 *
 * @param require injectable for the negative test of this very guard; defaults to the build flag.
 */
export function requireSolver(
  ctx: { skip: (note?: string) => void },
  state: SolverLoadState,
  require: boolean = SOLVER_REQUIRE_WASM,
): boolean {
  if (state.available) return true;
  const why = `rv_kinematic_solver.wasm unavailable (${state.failure ?? 'unknown'}`
    + `${state.failureDetail ? `: ${state.failureDetail}` : ''})`;
  if (require) {
    throw new Error(`[plan-501] RV_SOLVER_REQUIRE_WASM=1 but ${why} — the solver suites must run, not skip`);
  }
  ctx.skip(`${why} — plan-404 artifact missing`);
  return false;
}
