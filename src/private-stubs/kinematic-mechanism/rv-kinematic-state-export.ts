// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * kinematic-mechanism/rv-kinematic-state-export.ts — community stub for the mechanism state blob export (private).
 *
 * Not a runtime path: the only core-tree consumers are TEST HELPERS under `tests/`,
 * which tsc pulls in via the tsconfig `include` even though every test that USES
 * them is skipped without the private sibling. Without this file the
 * community typecheck fails on files that can never execute there. Shapes are
 * deliberately open (index signatures) — they exist to satisfy the checker, not
 * to describe the real API.
 */

export function exportMechanismStateBlob(..._args: any[]): any { return null; }
