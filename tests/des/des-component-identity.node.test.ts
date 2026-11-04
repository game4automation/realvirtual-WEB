// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2059 Phase 1 — the DES component id: plan-769 node address + '@' + type.
 *
 * Binds real scenes through `bindSceneToRunner` with a real `NodeRegistry`
 * (addresses registered exactly like the loader / placement instancer do:
 * `registerNodeId(node, occurrence)`), and checks the id each runner instance
 * carries.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  desComponentId,
  desComponentIdForNode,
  parseDesComponentId,
  findUnaddressable,
} from '../../src/plugins/des/rv-des-identity';
import { DESRunner } from '../../src/plugins/des/des-runner';
import { bindSceneToRunner } from '../../src/plugins/des/des-scene-binding';
import { registerMaterialFlow, _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { childOccurrence, ROOT_OCCURRENCE, RV_NODE_ID_KEY } from '../../src/core/engine/rv-node-id';
import { RV_SEEDED_NODE_ID_KEY } from '../../src/core/engine/rv-authored-keys';
import { seedNodeId } from '../../src/core/engine/rv-node-id-seed.mjs';
import Downtime from '../../src/plugins/des/material-flow/Downtime';
import Station from '../../src/plugins/des/material-flow/Station';

const NID_A = '11111111-1111-4111-8111-111111111111';
const NID_B = '22222222-2222-4222-8222-222222222222';
const REF_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REF_COPY = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function host(registry: NodeRegistry | null): BindContextHost {
  return {
    signalStore: new SignalStore(), registry, drives: [],
    on: () => () => {}, contextMenu: new ContextMenuStore(),
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
}

function withNodeId(node: Object3D, id: string): Object3D {
  node.userData.realvirtual = { ...(node.userData.realvirtual ?? {}), [RV_NODE_ID_KEY]: id };
  return node;
}

/** A node discovered by NAME only (placed LayoutObject, asset name matches `*Downtime*`). */
function nameOnlyNode(name: string, nodeId: string): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { LayoutObject: {} };
  return withNodeId(n, nodeId);
}

/** A node discovered by PAYLOAD only (carries `Downtime` extras, name says nothing). */
function payloadOnlyNode(name: string, nodeId: string): Object3D {
  const n = new Object3D();
  n.name = name;
  n.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 5 } };
  return withNodeId(n, nodeId);
}

function bindIds(scene: Scene, registry: NodeRegistry | null): Array<string | null> {
  scene.updateMatrixWorld(true);
  const runner = new DESRunner({ subMode: 'animated' });
  bindSceneToRunner(runner, scene, host(registry));
  const ids = runner.desIdentity().entries.map((e) => e.desId);
  runner.dispose();
  return ids;
}

beforeEach(() => {
  _resetMaterialFlowRegistry();
  registerMaterialFlow(Downtime as unknown as MaterialFlowDefinition);
});

describe('plan-2059 P1: desComponentId()', () => {
  it('is address + "@" + type and parses back', () => {
    expect(desComponentId(`#${NID_A}`, 'Conveyor')).toBe(`#${NID_A}@Conveyor`);
    expect(parseDesComponentId(`${REF_1}#${NID_A}@Conveyor`)).toEqual({ address: `${REF_1}#${NID_A}`, type: 'Conveyor' });
    expect(parseDesComponentId('no-type@')).toBeNull();
  });

  it('refuses an empty address/type and a type containing "@"', () => {
    expect(() => desComponentId('', 'Conveyor')).toThrow();
    expect(() => desComponentId('#x', '')).toThrow();
    expect(() => desComponentId('#x', 'A@B')).toThrow();
  });

  it('has no fallback: a node without address is unaddressable (null)', () => {
    expect(desComponentIdForNode(null, new Object3D(), 'Conveyor')).toBeNull();
    expect(desComponentIdForNode({ getAddressForNode: () => null }, new Object3D(), 'Conveyor')).toBeNull();
  });

  it('findUnaddressable reports missing ids and BOTH holders of a duplicate', () => {
    const out = findUnaddressable([
      { desId: 'a@T', type: 'T', label: 'x' },
      { desId: null, type: 'T', label: 'y' },
      { desId: 'a@T', type: 'T', label: 'z' },
      { desId: 'b@T', type: 'T', label: 'w' },
    ]);
    expect(out.map((u) => `${u.reason}:${u.label}`).sort()).toEqual(['duplicate:x', 'duplicate:z', 'missing:y']);
  });
});

describe('plan-2059 P1: ids assigned at bind (real NodeRegistry)', () => {
  it('name-only, payload-only and combined discovery give the same id form (slot = type)', () => {
    for (const make of [nameOnlyNode, payloadOnlyNode]) {
      const scene = new Scene();
      const node = make('Line_Downtime', NID_A);
      scene.add(node);
      const reg = new NodeRegistry();
      reg.registerNodeId(node, ROOT_OCCURRENCE);
      expect(bindIds(scene, reg)).toEqual([`#${NID_A}@Downtime`]);
    }
    // Combined: LayoutObject named *Downtime* AND Downtime payload → still ONE instance, same id.
    const scene = new Scene();
    const node = payloadOnlyNode('Line_Downtime', NID_A);
    node.userData.realvirtual.LayoutObject = {};
    scene.add(node);
    const reg = new NodeRegistry();
    reg.registerNodeId(node, ROOT_OCCURRENCE);
    expect(bindIds(scene, reg)).toEqual([`#${NID_A}@Downtime`]);
  });

  it('registration order of the definitions does not change the id', () => {
    const scene = new Scene();
    const node = payloadOnlyNode('D', NID_A);
    scene.add(node);
    const reg = new NodeRegistry();
    reg.registerNodeId(node, ROOT_OCCURRENCE);
    _resetMaterialFlowRegistry();
    registerMaterialFlow(Station as unknown as MaterialFlowDefinition);
    registerMaterialFlow(Downtime as unknown as MaterialFlowDefinition);
    const first = bindIds(scene, reg);
    _resetMaterialFlowRegistry();
    registerMaterialFlow(Downtime as unknown as MaterialFlowDefinition);
    registerMaterialFlow(Station as unknown as MaterialFlowDefinition);
    expect(bindIds(scene, reg)).toEqual(first);
    expect(first).toEqual([`#${NID_A}@Downtime`]);
  });

  it('the same asset placed twice gives two ids (occurrence chain); a copied placement gives new ids', () => {
    const build = (refs: string[]): Array<string | null> => {
      const scene = new Scene();
      const reg = new NodeRegistry();
      for (const ref of refs) {
        const placement = withNodeId(new Object3D(), ref);
        const inner = payloadOnlyNode('D', NID_A); // same asset → same inner NodeId
        placement.add(inner);
        scene.add(placement);
        reg.registerNodeId(placement, ROOT_OCCURRENCE);
        reg.registerNodeId(inner, childOccurrence(ROOT_OCCURRENCE, ref));
      }
      return bindIds(scene, reg);
    };
    const two = build([REF_1, REF_2]);
    expect(two).toEqual([`${REF_1}#${NID_A}@Downtime`, `${REF_2}#${NID_A}@Downtime`]);
    expect(new Set(two).size).toBe(2);
    const copied = build([REF_1, REF_COPY]);
    expect(copied[1]).toBe(`${REF_COPY}#${NID_A}@Downtime`);
    expect(copied[1]).not.toBe(two[1]);
  });

  it('reload (same file content) gives the same ids', () => {
    const once = (): Array<string | null> => {
      const scene = new Scene();
      const a = payloadOnlyNode('A', NID_A);
      const b = payloadOnlyNode('B', NID_B);
      scene.add(a, b);
      const reg = new NodeRegistry();
      reg.registerNodeId(a, ROOT_OCCURRENCE);
      reg.registerNodeId(b, ROOT_OCCURRENCE);
      return bindIds(scene, reg);
    };
    expect(once()).toEqual(once());
  });

  it('renaming a node of a Unity export (seeded id from the authored path) gives a new id', () => {
    const idFor = (authoredPath: string): string | null => {
      const scene = new Scene();
      const node = new Object3D();
      node.name = authoredPath.split('/').pop()!;
      node.userData.realvirtual = { Downtime: { MTBF: 100, MTTR: 5 } };
      node.userData[RV_SEEDED_NODE_ID_KEY] = seedNodeId(authoredPath);
      scene.add(node);
      const reg = new NodeRegistry();
      reg.registerNodeId(node, ROOT_OCCURRENCE);
      return bindIds(scene, reg)[0];
    };
    const before = idFor('Line/Downtime_1');
    expect(before).toMatch(/@Downtime$/);
    expect(idFor('Line/Downtime_1')).toBe(before);           // deterministic per file
    expect(idFor('Line/Downtime_renamed')).not.toBe(before); // rename → new seeded id
  });

  it('without a registry the instance is bound but unaddressable (no refusal in Phase 1)', () => {
    const scene = new Scene();
    scene.add(payloadOnlyNode('D', NID_A));
    scene.updateMatrixWorld(true);
    const runner = new DESRunner({ subMode: 'animated' });
    expect(bindSceneToRunner(runner, scene, host(null))).toBe(1);
    const { entries, unaddressable } = runner.desIdentity();
    expect(entries.map((e) => e.desId)).toEqual([null]);
    expect(unaddressable.map((u) => u.reason)).toEqual(['missing']);
    runner.dispose();
  });

  it('a programmatic instance takes an explicit id; bindPose records the local pose at add', () => {
    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D();
    node.position.set(1, 2, 3);
    const def = Downtime as unknown as MaterialFlowDefinition;
    const self = { prop: {}, root: node } as never;
    runner.addInstance(def, self, node, undefined, { desId: 'gen#x@Downtime' });
    runner.addInstance(def, self, new Object3D()); // no id → unaddressable
    const [inst, anon] = runner.liveInstances;
    expect(inst.desId).toBe('gen#x@Downtime');
    expect(inst.adapter.desId).toBe('gen#x@Downtime'); // plan-2061: the RNG stream key follows the explicit id
    expect((anon.adapter as { desId: string | null }).desId).toBeNull();
    expect(inst.bindPose.slice(12, 15)).toEqual([1, 2, 3]);
    expect(anon.desId).toBeNull();
    expect(runner.desIdentity().unaddressable.map((u) => u.reason)).toEqual(['missing']);
    runner.dispose();
  });
});
