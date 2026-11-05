// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { AgvHandle } from '../engine/rv-agv-fleet';
import type { RVTransportManager } from '../engine/rv-transport-manager';
import type { RVSink } from '../engine/rv-sink';

export type UnitKind = 'vehicle' | 'surface' | 'sink' | 'des' | 'other';
export interface PopulationSource {
  readonly id: string;
  readonly kind: UnitKind;
  expected(): readonly string[];
  seed?(): void;
}

/** Hierarchy paths match the node registry; a suffix distinguishes components on one node. */
interface PathNode { name: string; parent: PathNode | null }

const nodeIds = new WeakMap<PathNode, Partial<Record<'surface' | 'sink', string>>>();

export function progressNodeId(node: PathNode, kind: 'surface' | 'sink'): string {
  let ids = nodeIds.get(node);
  if (!ids) { ids = {}; nodeIds.set(node, ids); }
  if (ids[kind] !== undefined) return ids[kind]!;
  const parts: string[] = [];
  let current: typeof node | null = node;
  while (current?.parent) { parts.push(current.name); current = current.parent; }
  return ids[kind] = `${parts.reverse().join('/') || node.name}:${kind}`;
}

export interface CoreProgressModel {
  fleet: { all(): readonly AgvHandle[] };
  transport: Pick<RVTransportManager, 'surfaces' | 'sinks' | 'mus'> & Partial<Pick<RVTransportManager, 'grips'>>;
  expectFlow?: (sink: RVSink) => boolean;
}

export function createCorePopulationSources(model: CoreProgressModel): readonly PopulationSource[] {
  return [
    { id: 'fleet', kind: 'vehicle', expected: () => model.fleet.all().filter(h => h.kernel !== 'des').map(h => h.id).sort() },
    { id: 'surfaces', kind: 'surface', expected: () => model.transport.surfaces.map(s => progressNodeId(s.node, 'surface')).sort() },
    { id: 'sinks', kind: 'sink', expected: () => model.transport.sinks
      .filter(s => s.DeleteMus === true && (model.expectFlow?.(s) ?? false))
      .map(s => progressNodeId(s.node, 'sink')).sort() },
  ];
}
