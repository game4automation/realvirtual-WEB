// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * snap-registry-version.node.test.ts — plan-644 § 9.1.
 *
 * `SnapPointRegistry.version` is the change detector of the DES port cache:
 * every one of the seven mutators raises it, no reader does, and `markFree`
 * on a paired snap raises it while freeing both ends.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { SnapPointRegistry, type SnapPoint } from '../src/core/engine/rv-snap-point-registry';

function snap(id: string, owner: Object3D, flow: 'in' | 'out' = 'out'): SnapPoint {
  const o = new Object3D();
  o.name = `Snap-XP-T-${id}`;
  owner.add(o);
  return {
    id, object3D: o, dir: { axis: 'X', sign: 'P', code: 'XP' } as SnapPoint['dir'], typeId: 'T', flow,
    ownerRoot: owner, scenePath: `${owner.name}/${o.name}`, occupied: false,
  };
}

describe('SnapPointRegistry.version', () => {
  let reg: SnapPointRegistry;
  let ownerA: Object3D;
  let ownerB: Object3D;

  beforeEach(() => {
    reg = new SnapPointRegistry();
    ownerA = new Object3D(); ownerA.name = 'A';
    ownerB = new Object3D(); ownerB.name = 'B';
  });

  it('starts at 0', () => {
    expect(reg.version).toBe(0);
  });

  it('each of the seven mutators raises it', () => {
    const a = snap('a', ownerA);
    const b = snap('b', ownerB, 'in');
    const c = snap('c', ownerB, 'in');
    let v = reg.version;
    const raised = (label: string): void => {
      expect(reg.version, label).toBeGreaterThan(v);
      v = reg.version;
    };
    reg.register(a); raised('register');
    reg.register(b); raised('register b');
    reg.register(c); raised('register c');
    reg.markOccupied('a', 'p1'); raised('markOccupied');
    reg.pair('a', 'b'); raised('pair');
    reg.markFree('a'); raised('markFree');
    reg.unregister('c'); raised('unregister');
    reg.unregisterUnder(ownerB); raised('unregisterUnder');
    reg.clear(); raised('clear');
  });

  it('readers never raise it', () => {
    const a = snap('a', ownerA);
    const b = snap('b', ownerB, 'in');
    reg.register(a);
    reg.register(b);
    reg.pair('a', 'b');
    const v = reg.version;
    reg.getAll();
    reg.getById('a');
    reg.getByOwnerRoot(ownerA);
    reg.getCompatible('T', undefined, a);
    reg.getOwnerRoots();
    reg.walkChain(ownerA);
    void reg.size;
    expect(reg.version).toBe(v);
  });

  it('markFree on a paired snap raises it and frees BOTH ends', () => {
    const a = snap('a', ownerA);
    const b = snap('b', ownerB, 'in');
    reg.register(a);
    reg.register(b);
    reg.markOccupied('a', 'pB');
    reg.markOccupied('b', 'pA');
    reg.pair('a', 'b');
    const v = reg.version;
    reg.markFree('a');
    expect(reg.version).toBeGreaterThan(v);
    const ga = reg.getById('a');
    const gb = reg.getById('b');
    expect(ga).toBeDefined();
    expect(gb).toBeDefined();
    expect(ga!.pairedSnapId).toBeUndefined();
    expect(gb!.pairedSnapId).toBeUndefined();
    expect(ga!.occupied).toBe(false);
    expect(gb!.occupied).toBe(false);
  });

  it('no-op calls on unknown ids leave it unchanged', () => {
    const v = reg.version;
    reg.unregister('nope');
    reg.markOccupied('nope', 'x');
    reg.markFree('nope');
    reg.pair('nope', 'nada');
    reg.unregisterUnder(new Object3D());
    expect(reg.version).toBe(v);
  });
});
