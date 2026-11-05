// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * contract-node-identity R4 — a STORED signal reference (a `ComponentReference` to a
 * PLC signal in a decoded file) that the file's migration does not resolve stays
 * unbound. Before, `NodeRegistry.resolve` handed its raw path on, and the
 * SignalStore's space / suffix matching bound it to whatever registered path ends
 * that way — here `Cell/Signals/Start` for the written `Signals/Start` of a cell that
 * was never in the file. A typed path (plugin API, no referrer, no scope) keeps the
 * documented raw-path pass-through (doc-node-paths § 5.4).
 */

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { decodeIdentity } from '../src/core/engine/rv-decode-identity';
import { ROOT_OCCURRENCE } from '../src/core/engine/rv-node-id';
import { SignalStore } from '../src/core/engine/rv-signal-store';

const SIG = (path: string) => ({ type: 'ComponentReference' as const, path, componentType: 'realvirtual.PLCOutputBool' });

function load() {
  const json = {
    scene: 0,
    scenes: [{ name: 'Plant', nodes: [0, 3] }],
    nodes: [
      { name: 'Cell', children: [1] }, // 0
      { name: 'Signals', children: [2] }, // 1
      { name: 'Start', extras: { realvirtual: { PLCOutputBool: { Name: 'Cell.Start' } } } }, // 2
      { // 3 — the referrer; the file carries both references
        name: 'Gate',
        extras: { realvirtual: { ConnectSignal: { ConnectedSignal: SIG('Signals/Start') }, LogicStep_WaitForSignalBool: { Signal: SIG('Cell/Signals/Start') } } },
      },
    ],
  };
  const scene = new Object3D();
  scene.name = 'Plant';
  const objs = json.nodes.map((n) => {
    const o = new Object3D();
    o.name = n.name;
    Object.assign(o.userData, (n as { extras?: Record<string, unknown> }).extras ?? {});
    return o;
  });
  const attach = (parent: Object3D, list: number[] | undefined): void => {
    for (const i of list ?? []) {
      parent.add(objs[i]!);
      attach(objs[i]!, (json.nodes[i] as { children?: number[] }).children);
    }
  };
  attach(scene, json.scenes[0]!.nodes);
  const associations = new Map<Object3D, { nodes?: number }>(objs.map((o, i) => [o, { nodes: i }]));
  const identity = decodeIdentity({ scene, parser: { json, associations } } as never, { fileKey: 'plant' });
  const registry = new NodeRegistry();
  scene.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  registry.registerDocument(scene, ROOT_OCCURRENCE, identity);
  const store = new SignalStore();
  store.register('Cell.Start', NodeRegistry.computeNodePath(objs[2]!), false, 'PLCOutputBool');
  store.buildIndex();
  return { registry, store, scene, gate: objs[3]!, start: objs[2]! };
}

describe('stored signal reference — no raw-path guess on a file miss', () => {
  it('a written path the file does not have stays unbound (no raw path for the store to suffix-match)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry, store, scene, gate } = load();
    const res = registry.resolve(SIG('Signals/Start'), scene, gate);
    expect(res.signalAddress).toBeUndefined();
    // What the old raw path would have bound: the store's suffix match lands on `Cell/Signals/Start`.
    store.set('Cell.Start', true);
    expect(store.getByPath('Signals/Start')).toBe(true);
    warn.mockRestore();
  });

  it('a written path the file has resolves exactly', () => {
    const { registry, scene, gate, start } = load();
    const res = registry.resolve(SIG('Cell/Signals/Start'), scene, gate);
    expect(res.signalAddress).toBe(registry.getPathForNode(start));
  });

  it('a typed path without referrer and scope keeps the raw-path pass-through (§ 5.4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { registry } = load();
    expect(registry.resolve(SIG('Nowhere/Start')).signalAddress).toBe('Nowhere/Start');
    warn.mockRestore();
  });
});
