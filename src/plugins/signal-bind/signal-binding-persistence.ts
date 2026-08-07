// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../../core/rv-viewer';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import type { SignalBindTarget } from './signal-bind-target';
import { persistFieldOp } from '../../core/hmi/scene/scene-field-ops';
import { noteSignalMappingsWritten } from './first-link-notice';

export interface SignalBindingPersistenceAdapter {
  read(): SignalMapping[];
  write(mappings: SignalMapping[]): void;
  subscribe(listener: () => void): () => void;
}

interface PlannerLike {
  id: string;
  store: {
    getSnapshot: () => { placed: { id: string; signalMappings?: SignalMapping[] }[] };
    updateSignalMappings: (id: string, mappings: SignalMapping[]) => void;
    subscribe: (listener: () => void) => () => void;
  };
}

const nodeMappings = new WeakMap<object, SignalMapping[]>();
const nodeListeners = new WeakMap<object, Set<() => void>>();

function legacyNodeMappings(target: SignalBindTarget): SignalMapping[] {
  if (target.kind !== 'node') return [];
  const rv = target.node.userData?.realvirtual as Record<string, unknown> | undefined;
  const links = rv?.SignalLinks as { Mappings?: unknown } | undefined;
  return Array.isArray(links?.Mappings) ? (links!.Mappings as SignalMapping[]).map((mapping) => ({ ...mapping })) : [];
}

/**
 * Planner mappings keep their existing store. GLB-node mappings are recorded as
 * SignalLinks/Mappings setField ops; the source GLB is never mutated.
 */
export function createSignalBindingPersistence(
  viewer: RVViewer,
  target: SignalBindTarget,
): SignalBindingPersistenceAdapter {
  if (target.kind === 'placed') {
    const planner = viewer.getPlugin<PlannerLike>('layout-planner');
    const readPlaced = () => planner?.store.getSnapshot().placed
      .find((p) => p.id === target.placedId)?.signalMappings?.map((m) => ({ ...m })) ?? [];
    return {
      read: readPlaced,
      write: (mappings) => {
        const prevCount = readPlaced().length;
        planner?.store.updateSignalMappings(target.placedId, mappings.map((m) => ({ ...m })));
        noteSignalMappingsWritten(prevCount, mappings.length);
      },
      subscribe: (listener) => planner?.store.subscribe(listener) ?? (() => {}),
    };
  }

  if (!nodeMappings.has(target.node)) nodeMappings.set(target.node, legacyNodeMappings(target));
  return {
    read: () => (nodeMappings.get(target.node) ?? []).map((mapping) => ({ ...mapping })),
    write: (mappings) => {
      const prev = (nodeMappings.get(target.node) ?? legacyNodeMappings(target))
        .map((mapping) => ({ ...mapping }));
      const next = mappings.map((mapping) => ({ ...mapping }));
      syncNodeSignalBindingPersistence(target.node, next);
      persistFieldOp(target.nodePath, 'SignalLinks', 'Mappings', next, prev);
      noteSignalMappingsWritten(prev.length, next.length);
    },
    subscribe: (listener) => {
      let listeners = nodeListeners.get(target.node);
      if (!listeners) { listeners = new Set(); nodeListeners.set(target.node, listeners); }
      listeners.add(listener);
      return () => { listeners!.delete(listener); };
    },
  };
}

export function clearNodeSignalBindingPersistence(): void {
  // WeakMap entries follow model node lifetime. This hook documents the lifecycle
  // boundary and is intentionally a no-op until the scene-op overlay owns restore.
}

/** Keep the runtime adapter coherent when scene ops are applied, undone or redone. */
export function syncNodeSignalBindingPersistence(
  node: object,
  mappings: readonly SignalMapping[],
): void {
  nodeMappings.set(node, mappings.map((mapping) => ({ ...mapping })));
  for (const listener of nodeListeners.get(node) ?? []) listener();
}
