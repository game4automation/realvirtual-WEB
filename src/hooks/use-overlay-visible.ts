// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React bindings for the overlay-visibility store (plan-250).
 *
 * The store itself (`src/core/overlay-visibility-store.ts`) is vanilla and
 * react-free so engine code can import it. This is the ONLY place that pulls
 * `useSyncExternalStore` into the overlay-visibility feature.
 */

import { useSyncExternalStore } from 'react';
import {
  subscribeOverlayVisibility,
  getOverlaySnapshot,
  type OverlayCategory,
  type OverlayVisibilityState,
} from '../core/overlay-visibility-store';

/** Full snapshot — rerenders on any hidden OR present change (via version). */
export function useOverlayVisibilityState(): OverlayVisibilityState {
  return useSyncExternalStore(subscribeOverlayVisibility, getOverlaySnapshot);
}

/** True when the given overlay category is currently visible. */
export function useOverlayVisible(cat: OverlayCategory): boolean {
  return !useOverlayVisibilityState().hidden.has(cat);
}
