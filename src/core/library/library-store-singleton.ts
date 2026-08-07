// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-store-singleton — one library state per application (plan-372 Phase 4).
 *
 * ## Why this file exists at all
 *
 * `LayoutStore` is deliberately **not** a singleton: it is constructed by
 * `LayoutPlannerPlugin` and dies with it, and a good number of tests construct
 * several of them side by side. The library half cannot work that way. The
 * Projects dashboard lives in `core/` and must show the *same* subscriptions the
 * planner shows — two instances would disagree the moment a library is added in
 * one of them.
 *
 * So: `LibraryStore` is a process-wide singleton, and `LayoutStore` takes one as
 * a constructor argument. The planner passes {@link getLibraryStore}; a test that
 * wants an isolated store simply constructs its own `LibraryStore` and injects
 * it. That is why the constructor argument exists instead of `LayoutStore`
 * reaching for the singleton itself — the injection seam is what keeps the ~15
 * pre-existing `new LayoutStore()` test files independent of each other.
 */

import { LibraryStore } from './library-store';

let instance: LibraryStore | null = null;

/** The application-wide library store. Created on first use. */
export function getLibraryStore(): LibraryStore {
  if (!instance) instance = new LibraryStore();
  return instance;
}

/** Test seam — the next {@link getLibraryStore} call builds a fresh store. */
export function resetLibraryStoreForTests(): void {
  instance = null;
}
