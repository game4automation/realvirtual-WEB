// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kinematic-solver/rv-kinematic-solver-provider.ts — community stub for the WASM kinematic solver provider (private).
 *
 * Not a runtime path: the only core-tree consumers are TEST HELPERS under `tests/`,
 * which tsc pulls in via the tsconfig `include` even though every test that USES
 * them is skipped without the private sibling. Without this file the
 * community typecheck fails on files that can never execute there. Shapes are
 * deliberately open (index signatures) — they exist to satisfy the checker, not
 * to describe the real API.
 */

export type KinematicSolverInstance = { [key: string]: any };
export type KinematicSolverProvider = { [key: string]: any };
