// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * assets-library-groups — the Assets tab, grouped by the library an asset came
 * from (plan-702 Phase 1).
 *
 * The tab used to `flatMap` every registered source into one flat grid: the
 * user saw assets but never their origin, and with more than one library
 * attached there was no way to tell a customer's GitHub catalog from the
 * project's own `library/` folder. Grouping is the whole feature; this module
 * is its only logic.
 *
 * ## Why this is a free function and not a `useMemo` body
 *
 * There is no precedent in `tests/` for mounting `ProjectsDashboardHost` — it
 * would need the project store, the scene store and `useMode` mocked. Keeping
 * the grouping, the type conversions and the error tolerance in an exported
 * pure function is what makes them testable at all (plan-702 §9, T1).
 *
 * ## Two conversions that are not cosmetic
 *
 * `LibrarySource.needsPermission` is `boolean | undefined` and `error` is
 * `string | null`; the group type wants `boolean` and `string | undefined`.
 * Passing either through unconverted is a compile error, and papering over it
 * with a cast would let `null` reach a `{error && …}` render as a falsy value
 * that still occupies the field.
 *
 * ## One broken library must not take the tab with it
 *
 * `listEntries()` belongs to a provider this module does not own. A throw
 * inside the loop would abort the whole `useMemo` and blank the Assets tab for
 * every OTHER library too, so each source is read inside its own `try/catch`
 * and a failure becomes that section's error line (plan-702 §5.1 R4).
 */

import type {
  LibrarySource,
  RegisteredLibrarySource,
} from '../../library/library-source-registry';
import type { LibraryCatalogEntry } from '../../library/library-types';
import { NO_PROJECT } from '../../thumbnails/thumbnail-key';
import type { ProjectSectionCard } from './ProjectSections';

/** One library's worth of the Assets tab. Identity = `(providerId, sourceId)`. */
export interface AssetLibraryGroup {
  /** `${providerId}:${sourceId}` — stable collapse key AND React key. */
  groupKey: string;
  providerId: string;
  sourceId: string;
  label: string;
  kind: LibrarySource['kind'];
  writable: boolean;
  loaded: boolean;
  /** From `source.needsPermission ?? false` — the source field is optional. */
  needsPermission: boolean;
  /** From `source.error ?? undefined` — the source field is `string | null`. */
  error?: string;
  /** `typeof source.remove === 'function'` — the provider decides, not the UI. */
  removable: boolean;
  /** True when the source offers a re-scan (local folders do). */
  refreshable: boolean;
  cards: ProjectSectionCard[];
  /** Entry count BEFORE the search filter — drives "3 of 48". */
  totalCount: number;
}

/** The currently selected asset, if the selection points at one. */
export interface SelectedAssetRef {
  providerId: string;
  sourceId: string;
  assetId: string;
}

export interface BuildAssetGroupsOptions {
  sources: readonly RegisteredLibrarySource[];
  /** Raw search box contents; trimmed and lower-cased here. */
  searchTerm: string;
  /** Project id for the thumbnail cache key — `NO_PROJECT` when none is open. */
  projectId?: string;
  selectedAsset?: SelectedAssetRef | null;
  onSelect(ref: SelectedAssetRef): void;
}

/**
 * Does the current selection live inside this group?
 *
 * The remove path needs this: a selection still pointing at a library that has
 * just been detached leaves the detail pane describing a dead source
 * (plan-702 §2.7 / R5). Exported so the rule is testable without mounting the
 * dashboard host.
 */
export function selectionPointsIntoGroup(
  selection: { kind: string; providerId?: string; sourceId?: string },
  group: Pick<AssetLibraryGroup, 'providerId' | 'sourceId'>,
): boolean {
  return selection.kind === 'asset'
    && selection.providerId === group.providerId
    && selection.sourceId === group.sourceId;
}

/** The composite key a collapse state and a React list are keyed by. */
export function assetGroupKey(providerId: string, sourceId: string): string {
  return `${providerId}:${sourceId}`;
}

/**
 * Group every registered source into one {@link AssetLibraryGroup} each.
 *
 * While a search is active, groups without a single match are dropped —
 * a header reading "(0)" over nothing is noise the user has to scroll past.
 * With no search every group is returned, empty ones included: an attached
 * library that happens to be empty is exactly the thing a user needs to see.
 */
export function buildAssetGroups({
  sources,
  searchTerm,
  projectId,
  selectedAsset = null,
  onSelect,
}: BuildAssetGroupsOptions): AssetLibraryGroup[] {
  const term = searchTerm.trim().toLowerCase();
  const searchActive = term !== '';
  const match = (name: string) => !searchActive || name.toLowerCase().includes(term);
  const thumbProjectId = projectId ?? NO_PROJECT;

  const groups: AssetLibraryGroup[] = [];

  for (const { providerId, source } of sources) {
    // Read the foreign provider inside its own guard — see the file header.
    let entries: LibraryCatalogEntry[];
    let listError: string | undefined;
    try {
      entries = source.listEntries();
    } catch (e) {
      entries = [];
      listError = e instanceof Error ? e.message : String(e);
    }

    const cards: ProjectSectionCard[] = entries
      .filter(e => match(e.name))
      .map(e => ({
        key: `${providerId}:${source.id}:${e.id}`,
        entry: e,
        // A bundled catalog ships with the deploy; everything else the user
        // attached themselves. The tier is the badge, not the permission.
        tier: source.kind === 'bundled' ? ('bundled' as const) : ('user' as const),
        onSelect: () => onSelect({ providerId, sourceId: source.id, assetId: e.id }),
        selected: selectedAsset !== null
          && selectedAsset.providerId === providerId
          && selectedAsset.sourceId === source.id
          && selectedAsset.assetId === e.id,
        thumbnailKey: {
          projectId: thumbProjectId,
          providerId,
          sourceId: source.id,
          assetId: e.id,
        },
        resolveThumbnail: async () => {
          const resolved = await source.resolveAsset(e.id, 'thumbnail');
          return { url: resolved.url, release: resolved.revokeUrl };
        },
      }));

    if (searchActive && cards.length === 0) continue;

    groups.push({
      groupKey: assetGroupKey(providerId, source.id),
      providerId,
      sourceId: source.id,
      label: source.label,
      kind: source.kind,
      writable: source.writable,
      loaded: source.loaded,
      needsPermission: source.needsPermission ?? false,
      error: listError ?? source.error ?? undefined,
      removable: typeof source.remove === 'function',
      refreshable: typeof source.refresh === 'function',
      cards,
      totalCount: entries.length,
    });
  }

  return groups;
}
