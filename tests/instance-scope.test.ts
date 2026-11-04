// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import {
  instanceScope, instanceScopeNode, placementScopeNode, scopeSignalName,
} from '../src/core/engine/rv-instance-scope';

function placedRoot(name: string): Object3D {
  const o = new Object3D();
  o.name = name;
  o.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'c', Locked: false } };
  return o;
}

describe('instanceScope', () => {
  it('returns the nearest LayoutObject root name for any descendant (self included)', () => {
    const root = placedRoot('RollConveyor2m_2');
    const child = new Object3D(); child.name = 'Sensor'; root.add(child);
    const grandchild = new Object3D(); child.add(grandchild);
    expect(instanceScope(root)).toBe('RollConveyor2m_2');
    expect(instanceScope(child)).toBe('RollConveyor2m_2');
    expect(instanceScope(grandchild)).toBe('RollConveyor2m_2');
  });

  it("returns '' when not inside a LayoutObject (standalone asset)", () => {
    const root = new Object3D(); root.name = 'Scene';
    const child = new Object3D(); root.add(child);
    expect(instanceScope(child)).toBe('');
  });
});

describe('scopeSignalName', () => {
  it('prefixes with the scope using the dot-symbol separator', () => {
    expect(scopeSignalName('Inst', 'Flow.Run')).toBe('Inst.Flow.Run');
    expect(scopeSignalName('RollConveyor-1m', 'Flow.Occupied')).toBe('RollConveyor-1m.Flow.Occupied');
  });
  it('passes through unchanged when scope is empty', () => {
    expect(scopeSignalName('', 'Flow.Run')).toBe('Flow.Run');
  });
  it('treats a leading "/" as a global signal (strips it, never prefixes)', () => {
    expect(scopeSignalName('Inst', '/Machine.EStop')).toBe('Machine.EStop');
    expect(scopeSignalName('', '/Machine.EStop')).toBe('Machine.EStop');
  });
});

// plan-559 Phase 2a — the `InstanceScope` marker of an embedded copy.
function named(name: string, parent?: Object3D): Object3D {
  const o = new Object3D(); o.name = name; parent?.add(o); return o;
}
function marked(name: string, parent: Object3D, prefix?: unknown): Object3D {
  const o = named(name, parent);
  o.userData.realvirtual = { InstanceScope: prefix === undefined ? {} : { PrefixNode: prefix } };
  return o;
}

describe('instanceScope — InstanceScope marker (plan-559 Phase 2a)', () => {
  it('a marker without PrefixNode scopes with its own node name', () => {
    const doc = named('Factory');
    const cart = marked('CartA', doc);
    const leaf = named('Run', named('Signals', cart));
    expect(instanceScope(leaf)).toBe('CartA');
    expect(instanceScopeNode(leaf)).toBe(cart);
    expect(placementScopeNode(leaf)).toBeNull();
  });

  it('PrefixNode names the prefix — relative, root-inclusive, `_N`-deduplicated or as a bare string', () => {
    const doc = named('Factory');
    named('Vehicle7_1', named('Labels', doc));
    const a = marked('A', doc, { type: 'ComponentReference', path: 'Labels/Vehicle7' });
    const b = marked('B', doc, { type: 'ComponentReference', path: 'Factory/Labels/Vehicle7_1' });
    const c = marked('C', doc, 'Labels/Vehicle7_1');
    for (const m of [a, b, c]) expect(instanceScope(named('Leaf', m))).toBe('Vehicle7_1');
  });

  it('an unresolved PrefixNode falls back to the marker node name', () => {
    const doc = named('Factory');
    const m = marked('CartZ', doc, { type: 'ComponentReference', path: 'Nowhere/Node' });
    expect(instanceScope(named('Leaf', m))).toBe('CartZ');
  });

  it('inside a placement the marker is one more link of the chain; a disabled marker is ignored', () => {
    const placed = placedRoot('Line_1');
    const cart = marked('CartA', placed);
    const off = marked('Off', cart);
    (off.userData.realvirtual as Record<string, Record<string, unknown>>).InstanceScope._enabled = false;
    const leaf = named('Run', off);
    expect(instanceScope(leaf)).toBe('Line_1.CartA');
    expect(placementScopeNode(leaf)).toBe(placed);
    expect(instanceScopeNode(leaf)).toBe(cart);
  });

  it('without a marker the result is unchanged', () => {
    const doc = named('Factory');
    expect(instanceScope(named('Run', named('CartA', doc)))).toBe('');
  });
});
