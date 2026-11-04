// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { removeLocalStorage } from '../rv-safe-storage';

/**
 * rv-project-legacy-cleanup — retire the workspace keys on the first boot after
 * plan-743.
 *
 * ## Why deletion, and not migration
 *
 * A workspace root cannot be turned into linked projects without the user: the
 * old engine stored ONE handle, for the root, and never a handle per child
 * project — it had exactly one `putHandle` call in it, and that was the root's.
 * There is nothing to migrate a child project *from*; the replacement is the user
 * pointing Add at the old root once, which links every child in a single step.
 * Keeping the dead keys around instead would leave a workspace grant alive in
 * IndexedDB that no code path can ever spend.
 *
 * `rv-project/recent` goes with them: the linked list is stored under its own
 * key with a different row shape, and the old rows carry no `slug` and no
 * `linkedAt`.
 *
 * ## What is deliberately NOT touched
 *
 * `rv-project/recent-DOCUMENTS`, the cross-project ring plan-478 added. The
 * two names differ by one word and mean opposite things — the retired one is a
 * list of workspace roots, the new one a list of documents — so the deletion
 * below matches the EXACT legacy key and must never be widened to a prefix.
 *
 * `rv-project/last` and every `projectfolder:<id>` handle. They are the boot
 * resume path and the reopenable folders; a project the user opened
 * individually stays openable, and `listLinkedProjects` surfaces its handle
 * under a fallback label even though its display row is gone.
 *
 * ## Never blocks the boot
 *
 * Each deletion is its own try/catch and the promise always resolves. A browser
 * without IndexedDB (Safari private mode) or without localStorage must still
 * boot — the cleanup is housekeeping, and housekeeping that can fail a startup
 * is worse than the keys it removes. Only deletions, so re-running it is a
 * no-op and no "already done" marker is needed.
 */

import { deleteStoredHandle } from '../engine/rv-local-filesystem';

/** IndexedDB handle slot of the retired workspace root. */
const LEGACY_HANDLE_KEY_WORKSPACE = 'workspace';

/** localStorage key of the retired workspace display record. */
const LEGACY_LS_KEY_WORKSPACE = 'rv-project/workspace';

/** localStorage key of the retired (capped) recents list. */
const LEGACY_LS_KEY_RECENT = 'rv-project/recent';

/**
 * Delete the retired workspace/recents keys. Idempotent, and never throws.
 *
 * Awaited before the project store resolves the active project, so the demo
 * collision guard in the same boot cannot see a half-deleted workspace handle.
 */
export async function runLegacyCleanup(): Promise<void> {
  try {
    await deleteStoredHandle(LEGACY_HANDLE_KEY_WORKSPACE);
  } catch {
    // No IndexedDB, or no such slot — both are already the desired end state.
  }
  removeLocalStorage(LEGACY_LS_KEY_WORKSPACE);
  removeLocalStorage(LEGACY_LS_KEY_RECENT);
}
