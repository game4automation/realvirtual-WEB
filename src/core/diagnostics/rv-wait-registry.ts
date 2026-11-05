// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export interface WaitEdge {
  readonly waiterId: string;
  readonly resourceId: string;
  readonly ownerIds: readonly string[];
  readonly kind: string;
  /** NaN means the source does not know the wait start (including passive waits). */
  readonly sinceSimSec: number;
  readonly analysed: boolean;
  readonly notAnalysedReason?: 'capacity>1' | 'external-holder' | 'holder-only' | 'shared-unit' | 'alternative-outputs';
  readonly nodePath?: string;
  readonly ownerMUs?: boolean;
}
export interface WaitEdgeSource {
  readonly id: string;
  edges(now: number): readonly WaitEdge[];
  /** Optional vocabulary; exposing it does not collect the wait graph. */
  kinds?(): readonly string[];
  readonly vehicles?: boolean;
}

const same = (id: string): string => id;

/** Pull-only diagnostics: registration never samples a source or schedules work. */
export class WaitRegistry {
  private readonly kinds = new Set(['charge', 'setup', 'failure', 'empty', 'fleet:standstill', 'fleet:charge',
    'fleet:exit', 'fleet:fork', 'fleet:target', 'zone-holder', 'zone-fifo', 'reservation', 'des-exit']);
  knownWaitKinds(): readonly string[] {
    return [...new Set([...this.kinds, ...[...this.registered].flatMap(s => s.kinds?.() ?? [])])].sort();
  }
  private readonly registered = new Set<WaitEdgeSource>();
  addSource(src: WaitEdgeSource): () => void {
    this.registered.add(src);
    return () => { this.registered.delete(src); };
  }
  unitOf = same;
  collect(now: number, readOnly = false): readonly WaitEdge[] {
    const edges: WaitEdge[] = [];
    const sources = [...this.registered].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const source of sources) for (const edge of source.edges(now)) {
      const u = source.vehicles ? this.unitOf : same;
      if (!readOnly) this.kinds.add(edge.kind);
      edges.push({ ...edge, waiterId: u(edge.waiterId), ownerIds: edge.ownerIds.map(edge.ownerMUs ? same : u).sort() });
    }
    const key = (e: WaitEdge): string => JSON.stringify([
      e.waiterId, e.resourceId, e.kind, e.ownerIds, e.analysed, String(e.sinceSimSec), e.nodePath ?? '',
    ]);
    return edges.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  }
  sources(): readonly string[] { return [...this.registered].map(s => s.id).sort(); }
  clear(): void { this.registered.clear(); }
}

/** Resolve the active kernel authority on every pull, including after mode switches. */
export function zoneWaitSource(authority: () => {
  zoneWaitEdges(opts: { holders: 'all' }): WaitEdge[];
  followWaitEdges?(): WaitEdge[];
}): WaitEdgeSource {
  return { id: 'zones', vehicles: true, kinds: () => ['zone-holder', 'zone-fifo', 'follow'], edges: () => {
    const current = authority();
    return [...current.zoneWaitEdges({ holders: 'all' }), ...(current.followWaitEdges?.() ?? [])];
  } };
}
