// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mint a pre-plan-716 `scn_` id — for TESTS ONLY.
 *
 * Production has no minter any more. `newSceneId()` was deleted in plan-716
 * Phase 6 and `tests/scene-removal-guard.test.ts` fails if one comes back,
 * because F1 is exactly the claim that no code path creates a `scn_` id.
 *
 * What still READS them is a long list, and every item on it needs a fixture:
 * the workspace migration converts them, the alias map resolves them forever,
 * the retired namespace holds them, and a folder project's scene cache is keyed
 * by them. Those tests have to be able to write the "before" state, and this is
 * the honest way to let them — a fixture that says fixture, rather than a
 * production export kept alive for its callers in `tests/`.
 *
 * Byte-for-byte the shape `newSceneId()` produced, because some of the readers
 * (`isCatalogueSceneDocument`'s prefix rule, the alias strip regexes) key off it.
 */
export function legacySceneId(): string {
  return 'scn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
