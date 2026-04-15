// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';

/**
 * RVConnectSignal — TypeScript port of ConnectSignal.cs
 *
 * One-way signal bridge: subscribes to a source signal (ConnectedSignal)
 * and copies its value to this node's own signal path each time it changes.
 *
 * Uses init() to wire up the subscription after all signals are registered.
 */
export class RVConnectSignal implements RVComponent {
  static readonly schema: ComponentSchema = {
    ConnectedSignal: { type: 'componentRef' },
  };

  readonly node: Object3D;
  isOwner = true;

  /** Source signal address (resolved from ConnectedSignal componentRef) */
  ConnectedSignal: string | null = null;

  /** Unsubscribe function for cleanup */
  private _unsubscribe: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const sourceAddr = this.ConnectedSignal;
    if (!sourceAddr) return;

    const thisPath = NodeRegistry.computeNodePath(this.node);

    // Subscribe: when ConnectedSignal changes, copy to this node's signal
    this._unsubscribe = context.signalStore.subscribeByPath(sourceAddr, (value) => {
      context.signalStore.setByPath(thisPath, value);
    });

    // Also copy initial value
    const initial = context.signalStore.getByPath(sourceAddr);
    if (initial !== undefined) {
      context.signalStore.setByPath(thisPath, initial);
    }

    debug('loader', `  ConnectSignal: ${this.node.name} copies "${sourceAddr}" → "${thisPath}"`);
  }

  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'ConnectSignal',
  schema: RVConnectSignal.schema,
  capabilities: {},
  create: (node) => new RVConnectSignal(node),
});
