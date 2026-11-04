// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 — a minimal world for SignalConnector tests: a Scene, a
 * NodeRegistry, a SignalStore, signal nodes and connectors built directly
 * (fields set as the loader's schema pass + resolveRefs would leave them).
 */

import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { SignalReapplyRegistry } from '../../src/core/engine/rv-signal-reapply-registry';
import { RVSignalConnector } from '../../src/core/engine/rv-signal-connector';
import { RVConnectSignal } from '../../src/core/engine/rv-connect-signal';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';

export type PlcType =
  | 'PLCOutputBool' | 'PLCOutputInt' | 'PLCOutputFloat'
  | 'PLCInputBool' | 'PLCInputInt' | 'PLCInputFloat';

export interface ConnectorFields {
  Mode?: RVSignalConnector['Mode'];
  Enabled?: boolean;
  SourceBool?: string | null;
  SourceInt?: string | null;
  SourceFloat?: string | null;
  TargetBool?: string | null;
  TargetInt?: string | null;
  TargetFloat?: string | null;
  Condition?: RVSignalConnector['Condition'];
  CompareValue?: number;
  TrueValue?: number;
  FalseValue?: number;
  Bit?: number;
  Width?: RVSignalConnector['Width'];
  Signed?: boolean;
  Factor?: number;
  Offset?: number;
  Rounding?: RVSignalConnector['Rounding'];
  Invert?: boolean;
}

const SLOTS = ['SourceBool', 'SourceInt', 'SourceFloat', 'TargetBool', 'TargetInt', 'TargetFloat'] as const;

export function makeConnectorWorld() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  const reapply = new SignalReapplyRegistry();
  registry.registerNode('Cell', root);
  const ctx = { registry, signalStore: store, scene, root, reapply } as unknown as ComponentContext;
  const connectors: RVSignalConnector[] = [];

  /** Register a signal node `Cell/<name>` of a PLC type. */
  function signal(name: string, type: PlcType, initial?: boolean | number): string {
    const node = new Object3D();
    node.name = name;
    root.add(node);
    const path = `Cell/${name}`;
    registry.registerNode(path, node);
    store.register(name, path, initial ?? (type.endsWith('Bool') ? false : 0), type);
    store.buildIndex();
    return path;
  }

  /**
   * Build and init a connector on node `Cell/<name>`. Slot values are signal
   * paths (as resolved) or `{ unresolved: '<text>' }` for a reference that
   * did not resolve.
   */
  function connector(
    name: string,
    fields: ConnectorFields & { unresolved?: Partial<Record<(typeof SLOTS)[number], string>> },
    opts: {
      occurrence?: string; nodeId?: string; parent?: Object3D;
      /** Slots whose authored path the loader could NOT resolve yet (field null, extras keep the path). */
      unresolvedAtLoad?: (typeof SLOTS)[number][];
    } = {},
  ): RVSignalConnector {
    const node = new Object3D();
    node.name = name;
    (opts.parent ?? root).add(node);
    const raw: Record<string, unknown> = {};
    for (const slot of SLOTS) {
      const v = fields[slot];
      if (typeof v === 'string') raw[slot] = { type: 'ComponentReference', path: v };
      const u = fields.unresolved?.[slot];
      if (u) raw[slot] = { type: 'ComponentReference', unresolvedPath: u, reason: 'missing' };
    }
    node.userData.realvirtual = { SignalConnector: raw };
    if (opts.nodeId) setNodeId(node, opts.nodeId);
    registry.registerNode(NodeRegistry.computeNodePath(node), node);
    if (opts.nodeId) registry.registerNodeId(node, opts.occurrence ?? '');
    const c = new RVSignalConnector(node);
    const { unresolved: _u, ...rest } = fields;
    Object.assign(c, rest);
    for (const slot of opts.unresolvedAtLoad ?? []) c[slot] = null;
    c.init(ctx);
    connectors.push(c);
    return c;
  }

  /** A ConnectSignal on `Cell/<targetName>` (that node must be a registered signal). */
  function connectSignal(targetPath: string, sourcePath: string): RVConnectSignal {
    const node = registry.getNode(targetPath)!;
    const relay = new RVConnectSignal(node);
    relay.ConnectedSignal = sourcePath;
    relay.init(ctx);
    return relay;
  }

  /** Edit fields of a live connector as the editor does (setField → reapplyConfig). */
  function edit(c: RVSignalConnector, fields: ConnectorFields): void {
    const raw = (c.node.userData.realvirtual as Record<string, Record<string, unknown>>).SignalConnector;
    for (const slot of SLOTS) {
      if (!(slot in fields)) continue;
      const v = fields[slot];
      if (typeof v === 'string') raw[slot] = { type: 'ComponentReference', path: v };
      else delete raw[slot];
    }
    Object.assign(c, fields);
    c.reapplyConfig();
  }

  function dispose(): void {
    for (const c of connectors) c.dispose();
  }

  return { scene, root, registry, store, reapply, ctx, signal, connector, connectSignal, edit, dispose };
}
