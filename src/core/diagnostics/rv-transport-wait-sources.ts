// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVTransportManager } from '../engine/rv-transport-manager';
import { progressNodeId } from './rv-population-sources';
import type { WaitEdge, WaitEdgeSource } from './rv-wait-registry';

/** Build the MU index only on demand, never in the transport tick. */
export function surfaceWaitSource(transport: Pick<RVTransportManager, 'mus'>): WaitEdgeSource {
  return { id: 'surfaces', kinds: () => ['surface'], edges: () => {
    const live = new Map(transport.mus.filter(mu => !mu.markedForRemoval).map(mu => [mu.id, mu]));
    const out: WaitEdge[] = [];
    for (const mu of live.values()) {
      if (!mu.blocked || mu.blockedBy == null || !mu.currentSurface) continue;
      const leader = live.get(mu.blockedBy);
      if (!leader) continue;
      const waiterId = progressNodeId(mu.currentSurface.node, 'surface');
      const owner = leader.currentSurface ? progressNodeId(leader.currentSurface.node, 'surface') : null;
      // Several MUs share one progress unit. Their internal queue is not a deadlock.
      out.push({ waiterId, resourceId: `mu:${leader.id}`, ownerIds: owner ? [owner] : [],
        kind: 'surface', sinceSimSec: NaN, analysed: owner !== waiterId,
        ...(owner === waiterId ? { notAnalysedReason: 'shared-unit' as const } : {}) });
    }
    return out;
  } };
}

export function gripWaitSource(transport: Partial<Pick<RVTransportManager, 'grips'>>): WaitEdgeSource {
  return { id: 'grips', kinds: () => ['grip'], edges: () =>
    (transport.grips ?? []).flatMap(grip => grip.waitEdges()) };
}
