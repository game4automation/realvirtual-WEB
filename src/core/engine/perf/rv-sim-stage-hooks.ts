// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Simulation-stage attribution seam (plan-469 Phase 0d).
 *
 * The plan-469 region hooks attribute the TRANSPORT step. They say nothing
 * about the three other stages the fixed update runs — the drive loop, the
 * behaviour fan-out and the visual managers — which is exactly the split a
 * robot-heavy scene needs: 600 rotary drives cost nothing in transport and
 * everything in `drives`.
 *
 * This module is the seam, not the instrument: a mutable holder plus two method
 * names. It is imported by `ContinuousRunner` (production code) so the runner
 * does NOT have to import the dev-only probe; every call site is wrapped in
 * `import.meta.env.DEV`, which Vite replaces with `false` in a production build
 * and Rollup then eliminates together with this module.
 *
 * Contract: `hooks` is `null` in production and in any run made with
 * `?hooks=off`. The stages are SIBLINGS — never nested — so a plain
 * enter/leave pair per stage is exact; there is no region stack here.
 */

/** The four stages of `ContinuousRunner.tick()`, in execution order. */
export type SimStage = 'drives' | 'transport' | 'behaviors' | 'visuals';

export const SIM_STAGES: readonly SimStage[] = ['drives', 'transport', 'behaviors', 'visuals'];

export interface SimStageHooks {
  enter(stage: SimStage): void;
  leave(stage: SimStage): void;
}

/**
 * The live hook holder. A plain mutable object rather than a module-level
 * `let` + setter so the hot path is one property load and one null check, and
 * so a consumer can cache the object (never the hook) across ticks.
 */
export const simStageProbe: { hooks: SimStageHooks | null } = { hooks: null };
