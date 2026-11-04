// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVTransportManager } from '../engine/rv-transport-manager';
import { progressNodeId } from './rv-population-sources';
import type { WaitEdge, WaitEdgeSource } from './rv-wait-registry';

// Binding can precede ProgressWiring. Keep the registrations on the viewer lifetime,
// with explicit unbind and clearModel cleanup, and pull them through one source.
const sources = new WeakMap<object, Map<object, WaitEdgeSource>>();
export function registerBehaviorWaitSource(viewer: object, binding: object, source: WaitEdgeSource): void {
  let registered = sources.get(viewer);
  if (!registered) { registered = new Map(); sources.set(viewer, registered); }
  registered.set(binding, source);
}
export function removeBehaviorWaitSource(viewer: object, binding: object): void {
  sources.get(viewer)?.delete(binding);
}
export function clearBehaviorWaitSources(viewer: object): void { sources.delete(viewer); }
export function behaviorWaitSource(viewer: object, activeMode?: () => string): WaitEdgeSource {
  return { id: 'behaviors', kinds: () => ['conveyor-interlock', 'chain-transfer'], edges: now => {
    const out: WaitEdge[] = [];
    for (const [binding, source] of sources.get(viewer) ?? []) {
      if (activeMode && (binding as { mode?: string }).mode !== activeMode()) continue;
      out.push(...source.edges(now));
    }
    return out;
  } };
}

/** Resolve continuous readers to the existing surface progress units on demand. */
export function behaviorWaitEdges(host: { viewer: unknown; root: Object3D; mode: string },
  target: Object3D | null, resourceId: string, kind: string, multipleOutputs = false): WaitEdge[] {
  const manager = (host.viewer as { transportManager?: RVTransportManager | null }).transportManager;
  const under = (node: Object3D, root: Object3D): boolean => {
    for (let p: Object3D | null = node; p; p = p.parent) if (p === root) return true;
    return false;
  };
  const path = (node: Object3D): string => {
    const parts: string[] = [];
    for (let p: Object3D | null = node; p?.parent; p = p.parent) parts.push(p.name);
    return parts.reverse().join('/') || node.name;
  };
  const ids = (root: Object3D): string[] => host.mode === 'des' ? [`des:${path(root)}`]
    : (manager?.surfaces ?? []).filter(s => under(s.node, root)).map(s => progressNodeId(s.node, 'surface'));
  const owners = target ? ids(target) : [];
  return ids(host.root).map(waiterId => ({ waiterId, resourceId, ownerIds: owners,
    kind, sinceSimSec: NaN,
    // Alternative outputs are an OR wait; the simple cycle probe assumes AND.
    analysed: !multipleOutputs && !owners.includes(waiterId),
    ...(multipleOutputs ? { notAnalysedReason: 'alternative-outputs' as const }
      : owners.includes(waiterId) ? { notAnalysedReason: 'shared-unit' as const } : {}) }));
}
