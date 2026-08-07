// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { createSignalWriter, type SignalWriter } from './rv-signal-store';

/**
 * RVConnectSignal — TypeScript port of ConnectSignal.cs
 *
 * One-way signal bridge: subscribes to a source signal (ConnectedSignal)
 * and copies its value to this node's own signal path each time it changes.
 *
 * Uses init() to wire up the subscription after all signals are registered.
 */
export class RVConnectSignal implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('ConnectSignal');

  readonly node: Object3D;
  isOwner = true;

  /** Source signal address (resolved from ConnectedSignal componentRef) */
  ConnectedSignal: string | null = null;

  /** Unsubscribe function for cleanup */
  private _unsubscribe: (() => void) | null = null;
  private _writer: SignalWriter | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const sourceAddr = this.ConnectedSignal;
    if (!sourceAddr) return;

    const thisPath = NodeRegistry.computeNodePath(this.node);
    this._writer = createSignalWriter(
      context.signalStore,
      `component:ConnectSignal:${thisPath}`,
      'component',
      { slotContext: thisPath },
    );

    // Subscribe: when ConnectedSignal changes, copy to this node's signal
    this._unsubscribe = context.signalStore.subscribeByPath(sourceAddr, (value) => {
      this._writer?.setByPath(thisPath, value);
    });

    // Also copy initial value
    const initial = context.signalStore.getByPath(sourceAddr);
    if (initial !== undefined) {
      this._writer.setByPath(thisPath, initial);
    }

    debug('loader', `  ConnectSignal: ${this.node.name} copies "${sourceAddr}" → "${thisPath}"`);
  }

  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._writer = null;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'ConnectSignal',
  schema: RVConnectSignal.schema,
  capabilities: {},
  create: (node) => new RVConnectSignal(node),
});
