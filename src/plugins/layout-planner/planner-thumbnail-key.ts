// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * planner-thumbnail-key — the panel's preview cache key, in a module of its
 * own so BOTH sides can import it without coupling their chunks: the panel
 * (code-split, enqueues under this key) and the plugin core (always loaded,
 * forgets this key when `document-saved` invalidates the asset).
 *
 * Entry ids are unique across the planner's catalogs, which is what the
 * previous glbUrl-wide lookup already relied on. Phase 10 replaces this with
 * the real (providerId, sourceId) pair from the source registry.
 */

import { buildThumbnailKey } from '../../core/thumbnails/thumbnail-key';
import { getProjectStore } from '../../core/project/project-store';

/** The preview cache key of one planner catalog entry. */
export function plannerThumbnailKey(entryId: string): string {
  return buildThumbnailKey({
    projectId: getProjectStore().getProject()?.id ?? '',
    providerId: 'layout-planner',
    sourceId: 'catalogs',
    assetId: entryId,
  });
}
