// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for type-safe plugin access.
 *
 * Usage:
 *   const stats = usePlugin<TransportStatsPlugin>('transport-stats');
 *   if (stats) console.log(stats.consumedBuffer.last());
 */

import { useViewer } from './use-viewer';
import type { RVViewerPlugin } from '../core/rv-plugin';

/** Returns the plugin instance with the given ID, or undefined. */
export function usePlugin<T extends RVViewerPlugin>(id: string): T | undefined {
  const viewer = useViewer();
  return viewer.getPlugin<T>(id);
}
