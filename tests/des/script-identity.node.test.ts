// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { RVWebComponentRegistry, parseWebComponent } from '../../src/core/engine/rv-web-component-registry';
import type { RVScriptHost } from '../../src/core/engine/rv-script-host';
import type { RVScriptComponentAdapter } from '../../src/core/sdk/rv-script-component-adapter';

it('same-named script hosts in two occurrences have distinct, bind-order-independent ids', () => {
  const nodes = [new Object3D(), new Object3D()];
  const nodeId = '11111111-1111-4111-8111-111111111111';
  const occurrences = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  const addresses = new NodeRegistry();
  // Two placements of the same file carry the same authored NodeId.
  nodes.forEach((n, i) => {
    n.name = 'Script'; n.userData.realvirtual = { NodeId: nodeId };
    addresses.registerNodeId(n, occurrences[i]);
  });
  const collect = (order: number[]) => {
    const registry = new RVWebComponentRegistry({ host: {} as RVScriptHost,
      buildEnv: () => { throw new Error('inactive fixture creates no VM'); },
      getAddressForNode: n => addresses.getAddressForNode(n) });
    for (const i of order) {
      const inst = registry.create('placement-' + i, nodes[i], parseWebComponent({ Active: false, Code: 'bound source' })!);
      // Only VM construction is stubbed; exercise the real registry listing and identity path.
      inst.adapter = {} as RVScriptComponentAdapter;
    }
    const rows = registry.listScriptComponents();
    expect(rows.map(r => r.node)).toHaveLength(2);
    expect(rows.every(r => r.source === 'bound source')).toBe(true);
    return rows.map(r => r.desId).sort();
  };
  const ids = collect([0, 1]);
  expect(new Set(ids).size).toBe(2);
  expect(ids).toEqual(occurrences.map(o => o + '#' + nodeId + '@WebComponent'));
  expect(collect([1, 0])).toEqual(ids);
});
