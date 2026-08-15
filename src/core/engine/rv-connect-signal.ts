// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';
import { createSignalWriter, type SignalStore, type SignalWriter } from './rv-signal-store';
import { isSignalLiveControlled, subscribeLiveControl } from './rv-slot-authority';
import { wireValueSignal } from './rv-signal-wiring';

/**
 * RVConnectSignal — TypeScript port of ConnectSignal.cs
 *
 * One-way signal bridge: subscribes to a source signal (ConnectedSignal)
 * and copies its value to this node's own signal path each time it changes.
 *
 * Uses init() to wire up the subscription after all signals are registered.
 *
 * **Live-control interlock (plan-418).** Since a raw PLC signal node can be
 * bound to an external CONNECT tag, this relay and an external binding can
 * target the SAME signal — two permanent writers racing every tick. The relay
 * therefore respects the same gate the built-in LogicSteps respect
 * (`isSignalLiveControlled`, rv-logic-step.ts): while the target is externally
 * controlled it writes nothing, so "the PLC writes, local logic stays silent"
 * holds here too, and the shadow write gate sees no `authority-bound` reject.
 *
 * The gate alone would not be enough. The relay only writes when its SOURCE
 * changes, so after an unbind it would keep serving a value that went stale
 * during the suppression — until the source happened to move again. It
 * therefore subscribes to the live-control TRANSITION of its target and
 * re-copies the current source value once on `true → false`.
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
  private _store: SignalStore | null = null;
  private _sourceAddr: string | null = null;
  private _thisPath = '';
  /** Store NAME of this node's own signal — the key the live-control gate uses. */
  private _targetName: string | null = null;
  private _liveControlUnsub: (() => void) | null = null;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    const sourceAddr = this.ConnectedSignal;
    if (!sourceAddr) return;

    const thisPath = NodeRegistry.computeNodePath(this.node);
    this._store = context.signalStore;
    this._sourceAddr = sourceAddr;
    this._thisPath = thisPath;
    // The gate is keyed by signal NAME, the relay writes by PATH — resolve once
    // here rather than per write. A node without a registered signal simply has
    // no gate to respect (and nothing external could bind it either).
    this._targetName = context.signalStore.nameForPath(thisPath) ?? null;
    this._writer = createSignalWriter(
      context.signalStore,
      `component:ConnectSignal:${thisPath}`,
      'component',
      { slotContext: thisPath },
    );

    // Copy the source onto this node's signal — on the initial read, on every
    // change, and (plan-427) on every re-apply after reset/reconnect. The RAW
    // helper: a ConnectSignal forwards bools AND numbers verbatim, so neither
    // the bool nor the number coercion may touch the value. Skipping an
    // unresolved source is the helper's contract and matches the hand-written
    // `if (initial !== undefined)` guard this replaces.
    this._unsubscribe = wireValueSignal(context.signalStore, sourceAddr, (value) => {
      if (this._isSuppressed()) return;
      this._writer?.setByPath(thisPath, value);
    }, undefined, context.reapply).unsubscribe;

    // Resynchronise the moment an external binding lets go: read the CURRENT
    // source value (not a cached one) so the target never keeps a value the
    // source abandoned while it was suppressed.
    if (this._targetName) {
      this._liveControlUnsub = subscribeLiveControl(this._targetName, (controlled) => {
        if (controlled) return;
        const current = this._store?.getByPath(this._sourceAddr ?? '');
        if (current !== undefined) this._writer?.setByPath(this._thisPath, current);
      });
    }

    debug('loader', `  ConnectSignal: ${this.node.name} copies "${sourceAddr}" → "${thisPath}"`);
  }

  /** True while an external binding owns this node's signal. */
  private _isSuppressed(): boolean {
    return this._targetName !== null && isSignalLiveControlled(this._targetName);
  }

  dispose(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._liveControlUnsub) {
      this._liveControlUnsub();
      this._liveControlUnsub = null;
    }
    this._writer = null;
    this._store = null;
    this._sourceAddr = null;
    this._targetName = null;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'ConnectSignal',
  schema: RVConnectSignal.schema,
  capabilities: {},
  create: (node) => new RVConnectSignal(node),
});
