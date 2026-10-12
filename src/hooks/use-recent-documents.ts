// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useRecentDocuments — React binding for the recent-documents ring (plan-478).
 *
 * `useSyncExternalStore` over the vanilla store, the same shape
 * `overlay-visibility-store` is consumed with. The store memoises its snapshot
 * array and only replaces it on a real write, so the identity check React does
 * on every render is the cheap one — no `useMemo`, no copy per render.
 *
 * The cross-tab `storage` listener is attached HERE rather than at module load
 * (see `attachRecentsStorageSync`): it exists to keep a rendered list fresh, so
 * it should live exactly as long as something renders one.
 */

import { useEffect, useSyncExternalStore } from 'react';
import {
  attachRecentsStorageSync,
  readRecents,
  subscribeRecents,
} from '../core/project/rv-project-recents-store';
import type { RecentDocumentEntry } from '../core/project/rv-project-recents';

export function useRecentDocuments(): readonly RecentDocumentEntry[] {
  useEffect(() => attachRecentsStorageSync(), []);
  return useSyncExternalStore(subscribeRecents, readRecents);
}
