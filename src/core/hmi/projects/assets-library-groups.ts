// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * assets-library-groups — the two rules that survived the Assets tab.
 *
 * ## What this file used to be, and why it shrank
 *
 * It grouped every registered library source into one section of the Assets
 * tab (plan-702 Phase 1). That tab is gone — `ProjectTree` replaced it in
 * plan-703 Phase 6 — and the grouping machinery (`buildAssetGroups`,
 * `AssetLibraryGroup`, `assetGroupKey` and the card list they built) lost its
 * renderer with it. It was kept for one release because retiring it looked
 * like it meant retiring `ProjectCard` too; `ProjectFolderContents` has since
 * given `ProjectCard` a renderer of its own, so that coupling is gone and the
 * dead half went with plan-709 phase 6.
 *
 * ## The two rules that are still load-bearing
 *
 * 1. {@link selectionPointsIntoGroup} — a selection still pointing at a
 *    library that has just been detached leaves the detail pane describing a
 *    dead source (plan-702 §2.7 / R5). Exported so the rule is testable
 *    without mounting the dashboard host.
 * 2. {@link crossSourceKeyOf} — the bundled demo project's `library/` and the
 *    deployed standard catalog list the SAME files through two sources, and
 *    without a canonical identity every one of them renders twice.
 */

import type { LibraryCatalogEntry } from '../../library/library-types';

/** The currently selected asset, if the selection points at one. */
export interface SelectedAssetRef {
  providerId: string;
  sourceId: string;
  assetId: string;
}

/**
 * Does the current selection live inside this library?
 *
 * See rule 1 in the file header.
 */
export function selectionPointsIntoGroup(
  selection: { kind: string; providerId?: string; sourceId?: string },
  group: { providerId: string; sourceId: string },
): boolean {
  return selection.kind === 'asset'
    && selection.providerId === group.providerId
    && selection.sourceId === group.sourceId;
}

/**
 * Canonical cross-source identity of an entry, or null when it has none.
 *
 * The path below the last `library/` segment is the one thing both spellings
 * share (`library/Conveyors/Belt.glb` vs
 * `https://…/models/library/Conveyors/Belt.glb`). Entries whose URLs carry no
 * `library/` folder deliberately return null and are never deduplicated — a
 * coincidental basename match between two genuinely different libraries must
 * not hide a card.
 */
export function crossSourceKeyOf(entry: LibraryCatalogEntry): string | null {
  const path = entry.localPath || entry.glbUrl || entry.splatUrl || '';
  const idx = path.toLowerCase().lastIndexOf('library/');
  if (idx < 0) return null;
  const rest = path.slice(idx + 'library/'.length).toLowerCase();
  return rest.length > 0 ? rest : null;
}
