// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { InstancedMovingUnit, RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSource } from '../src/core/engine/rv-source';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { muNode, preplacedMU, PART } from './_mu-preplaced-fixture';

type MU = RVMovingUnit | InstancedMovingUnit;
const managers: RVTransportManager[] = [];
afterEach(() => { for (const tm of managers.splice(0)) tm.reset(true); });

function fixture() {
  const tm = new RVTransportManager();
  tm.scene = new Scene();
  managers.push(tm);
  const make = (name: string, x: number) => {
    const node = new Object3D();
    node.name = name;
    node.position.set(x, 1, 0);
    tm.scene!.add(node);
    return new RVMovingUnit(node, '', new Vector3(.05, .05, .05));
  };
  const a = make('a', 0), b = make('b', 2), c = make('c', 4);
  tm.activateMU(a); tm.activateMU(b); tm.activateMU(c);
  return { tm, a, b, c };
}

// Read the companion BEFORE hasMU can repair it. Check identity, duplicates and order.
function expectSynchronized(tm: RVTransportManager, order: MU[]) {
  const set = (tm as any)._muSet as Set<MU>;
  expect(set).toBeInstanceOf(Set);
  expect(set.size).toBe(tm.mus.length);
  expect(set).toEqual(new Set(tm.mus));
  expect(tm.mus.map(mu => mu.id)).toEqual(order.map(mu => mu.id));
  order.forEach((mu, i) => expect(tm.mus[i]).toBe(mu));
}

// Same standalone Source setup as source-instanced-child-transform.test.ts;
// no loader init, ghost rendering or DOM is needed.
function addSource(tm: RVTransportManager) {
  const node = new Object3D(); node.name = 'Source'; node.position.set(10, 1, 0);
  const template = new Mesh(new BoxGeometry(.2, .3, .4), new MeshBasicMaterial());
  template.name = 'Part';
  tm.scene!.add(node, template);
  tm.scene!.updateMatrixWorld(true);
  const source = new RVSource(node);
  source.muName = template.name;
  source.sourceIsTemplate = false;
  source.spawnParent = tm.scene;
  source.spawnMode = 'Interval';
  source.spawnInterval = .01;
  (source as any)._buildMarker = () => {}; // marker needs a DOM canvas; irrelevant here
  source.setTemplate(template);
  tm.sources.push(source);
  return source;
}

describe('transport MU companion membership', () => {
  it('update removal maintains swap-and-pop and deletes membership immediately', () => {
    const { tm, a, b, c } = fixture();
    b.markedForRemoval = true;
    tm.update(1 / 60);
    expectSynchronized(tm, [a, c]);
    expect(tm.hasMU(b)).toBe(false);
    expect(tm.hasMU(a)).toBe(true);
  });

  it('removeMU maintains swap-and-pop and deletes membership immediately', () => {
    const { tm, a, b, c } = fixture();
    tm.removeMU(a);
    expectSynchronized(tm, [c, b]);
    expect(tm.hasMU(a)).toBe(false);
  });

  it('deactivateMU maintains swap-and-pop without disposing the MU', () => {
    const { tm, a, b, c } = fixture();
    tm.deactivateMU(a);
    expectSynchronized(tm, [c, b]);
    expect(tm.hasMU(a)).toBe(false);
    expect(a.node.parent).toBe(tm.scene);
  });

  it('restorePreplaced removes only preplaced MUs with swap-and-pop', () => {
    const { tm, a, b, c } = fixture();
    const node = muNode('Preplaced', PART, [8, 0, 0]); tm.scene!.add(node);
    const pre = preplacedMU(node);
    tm.registerPreplaced(pre, tm.scene!);
    tm.deactivateMU(c); tm.activateMU(pre); tm.activateMU(c);
    expectSynchronized(tm, [a, b, pre, c]);
    tm.restorePreplaced(false);
    expectSynchronized(tm, [a, b, c]);
    expect(tm.hasMU(pre)).toBe(false);
  });

  it('promoteInstancedMU replaces membership in place without changing length', () => {
    const { tm, a, b, c } = fixture();
    tm.preferCloneMU = false;
    const source = addSource(tm);
    tm.update(.02);
    const inst = tm.mus[3];
    expect(inst).toBeInstanceOf(InstancedMovingUnit);
    expectSynchronized(tm, [a, b, c, inst]);
    const clone = tm.promoteInstancedMU(inst as InstancedMovingUnit);
    expect(clone).not.toBeNull();
    expectSynchronized(tm, [a, b, c, clone!]);
    expect(tm.hasMU(inst)).toBe(false);
    expect(tm.hasMU(clone!)).toBe(true);
  });

  it('reset clears both collections', () => {
    const { tm, a, b, c } = fixture();
    tm.reset();
    expectSynchronized(tm, []);
    for (const mu of [a, b, c]) expect(tm.hasMU(mu)).toBe(false);
  });

  it('registerSourceMU via source spawn appends membership immediately', () => {
    const { tm, a, b, c } = fixture();
    const source = addSource(tm);
    tm.preferCloneMU = true;
    const spawned = tm.spawnFromSource(source)!;
    expect(spawned).toBeInstanceOf(RVMovingUnit);
    expectSynchronized(tm, [a, b, c, spawned]);
    expect(tm.hasMU(spawned)).toBe(true);
    expect(tm.hasMU(new RVMovingUnit(new Object3D(), ''))).toBe(false);
  });

  it('activatePreplaced appends once and keeps existing order', () => {
    const { tm, a, b, c } = fixture();
    const node = muNode('Preplaced', PART, [8, 0, 0]); tm.scene!.add(node);
    const pre = preplacedMU(node);
    tm.registerPreplaced(pre, tm.scene!);
    expect(tm.hasMU(pre)).toBe(false);
    expect(tm.activatePreplaced()).toBe(1);
    expectSynchronized(tm, [a, b, c, pre]);
    expect(tm.hasMU(pre)).toBe(true);
    expect(tm.activatePreplaced()).toBe(0);
    expectSynchronized(tm, [a, b, c, pre]);
  });

  it('activateMU is idempotent and restores a deactivated MU at the end', () => {
    const { tm, a, b, c } = fixture();
    tm.deactivateMU(b);
    expectSynchronized(tm, [a, c]);
    expect(tm.hasMU(b)).toBe(false);
    tm.activateMU(b);
    expectSynchronized(tm, [a, c, b]);
    tm.activateMU(b);
    expectSynchronized(tm, [a, c, b]);
    expect(tm.hasMU(b)).toBe(true);
  });

  for (const action of ['activateMU', 'deactivateMU', 'removeMU'] as const) {
    it(`repairs external push immediately before ${action}, without a preceding query`, () => {
      const { tm, a, b, c } = fixture();
      tm.deactivateMU(b);
      expectSynchronized(tm, [a, c]);
      tm.mus.push(b);
      tm[action](b);
      expectSynchronized(tm, action === 'activateMU' ? [a, c, b] : [a, c]);
      expect(tm.hasMU(b)).toBe(action === 'activateMU');
    });
  }

  it('hasMU repairs an external size-changing splice', () => {
    const { tm, a, b, c } = fixture();
    tm.mus.splice(1, 1);
    expect(tm.hasMU(b)).toBe(false);
    expectSynchronized(tm, [a, c]);
    expect(tm.hasMU(a)).toBe(true);
    expect(tm.hasMU(c)).toBe(true);
  });
});
