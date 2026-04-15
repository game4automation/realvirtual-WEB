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
