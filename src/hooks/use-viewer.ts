// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React context + hook for accessing the RVViewer instance.
 *
 * Usage:
 *   // In your app root:
 *   <RVViewerProvider value={viewer}><App /></RVViewerProvider>
 *
 *   // In any component:
 *   const viewer = useViewer();
 *   viewer.signalStore?.get('addr');
 */

import { createContext, useContext } from 'react';
import type { RVViewer } from '../core/rv-viewer';

const ViewerContext = createContext<RVViewer | null>(null);

/** Provider component — wrap your app root with this. */
export const RVViewerProvider = ViewerContext.Provider;

/** Access the RVViewer instance. Throws if used outside a provider. */
export function useViewer(): RVViewer {
  const viewer = useContext(ViewerContext);
  if (!viewer) {
    throw new Error('useViewer() must be used inside <RVViewerProvider>');
  }
  return viewer;
}

/**
 * The RVViewer if there is one, `null` if there is not.
 *
 * For the handful of components that mount OUTSIDE any viewer — the storage
 * notice banner is one: it reports on browser storage, which is true whether or
 * not a scene ever loaded. Likewise for a component that only *enriches* itself
 * with the viewer — a card that would generate a thumbnail if it could — and
 * must still render in a tree that has no provider above it, which is every
 * unit test of that component. Throwing at them would make an absent viewer a
 * rendering error rather than the ordinary condition it is.
 */
export function useOptionalViewer(): RVViewer | null {
  return useContext(ViewerContext);
}
