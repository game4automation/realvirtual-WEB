// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * React hook for transport statistics from TransportStatsPlugin.
 *
 * Polls the plugin's ring buffer at a configurable interval (default 200ms).
 *
 * Usage:
 *   const { spawned, consumed } = useTransportStats();
 */

import { useState, useEffect } from 'react';
import { usePlugin } from './use-plugin';
import type { TransportStatsPlugin } from '../plugins/transport-stats-plugin';

export function useTransportStats(refreshMs = 200): { spawned: number; consumed: number } {
  const plugin = usePlugin<TransportStatsPlugin>('transport-stats');
  const [stats, setStats] = useState({ spawned: 0, consumed: 0 });

  useEffect(() => {
    if (!plugin) return;
    const id = setInterval(() => {
      const spawned = plugin.spawnedBuffer.last() ?? 0;
      const consumed = plugin.consumedBuffer.last() ?? 0;
      setStats(prev =>
        prev.spawned === spawned && prev.consumed === consumed ? prev : { spawned, consumed },
      );
    }, refreshMs);
    return () => clearInterval(id);
  }, [plugin, refreshMs]);

  return stats;
}
