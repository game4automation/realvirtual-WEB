// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared fixture for the plan-325 inline signal-linking UI tests: a minimal
 * viewer stub around a REAL SignalStore + NodeRegistry + SignalBindingManager
 * and one GLB-style Drive_Simple node ("Axis") whose Forward slot is wired to
 * the model signal `Axis.Forward` while Backward is an unwired direct-command
 * slot. `ModelSig` is a free internal model signal for internal-source picks.
 */
import { Object3D } from 'three';
// Side effect: registers the Drive_* behavior schemas for the generic resolver.
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { RVViewer } from '../src/core/rv-viewer';

export interface InlineSlotFixture {
  viewer: RVViewer;
  store: SignalStore;
  registry: NodeRegistry;
  mgr: SignalBindingManager;
  node: Object3D;
  nodePath: string;
}

export function makeInlineSlotFixture(options?: { withManager?: boolean }): InlineSlotFixture {
  const withManager = options?.withManager ?? true;
  const store = new SignalStore();
  const registry = new NodeRegistry();
  store.register('Axis.Forward', 'Axis/Forward', false, 'PLCOutputBool');
  store.register('ModelSig', 'Cell/ModelSig', false, 'PLCOutputBool');

  const node = new Object3D();
  node.name = 'Axis';
  node.userData.realvirtual = { Drive_Simple: { Forward: { type: 'ComponentReference', path: 'Axis/Forward', componentType: 'PLCOutputBool' } } };
  registry.registerNode('Axis', node);
  registry.register('Drive_Simple', 'Axis', {
    Forward: 'Axis.Forward',
    Backward: null,
    commandBackward: (_v: boolean | number) => { /* command sink */ },
    neutralizeBackward: () => { /* neutral */ },
  });
  registry.register('Drive', 'Axis', { stop: () => { /* handover */ }, isOwner: true });

  const mgr = withManager ? new SignalBindingManager(store, registry) : null;

  const viewer = {
    registry,
    signalStore: store,
    signalBindingManager: mgr,
    getPlugin: () => undefined,
    behaviors: { getActiveBinds: () => [] },
  } as unknown as RVViewer;

  return { viewer, store, registry, mgr: mgr as SignalBindingManager, node, nodePath: 'Axis' };
}
