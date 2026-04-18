// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVTank } from '../src/core/engine/rv-tank';

function makeNode(name = 'Tank1'): Object3D {
  const n = new Object3D();
  n.name = name;
  return n;
}

describe('RVTank', () => {
  it('applies schema from GLB extras', () => {
    const node = makeNode();
    const tank = new RVTank(node, {
      resourceName: 'Milk', capacity: 1000, amount: 500, pressure: 1.2, temperature: 4,
    });
    expect(tank.resourceName).toBe('Milk');
    expect(tank.capacity).toBe(1000);
    expect(tank.amount).toBe(500);
    expect(tank.pressure).toBe(1.2);
    expect(tank.temperature).toBe(4);
  });

  it('attaches instance, sets _rvType to Tank, syncs _rvTank userData', () => {
    const node = makeNode();
    const tank = new RVTank(node, { capacity: 500, amount: 100 });
    expect(node.userData._rvComponentInstance).toBe(tank);
    expect(node.userData._rvType).toBe('Tank');
    expect(node.userData._rvTank.capacity).toBe(500);
    expect(node.userData._rvTank.amount).toBe(100);
  });

  it('setAmount clamps to [0, capacity]', () => {
    const node = makeNode();
    const tank = new RVTank(node, { capacity: 100, amount: 50 });

    tank.setAmount(150);
    expect(tank.amount).toBe(100);

    tank.setAmount(-10);
    expect(tank.amount).toBe(0);

    tank.setAmount(75);
    expect(tank.amount).toBe(75);
  });

  it('addAmount applies delta with clamping', () => {
    const node = makeNode();
    const tank = new RVTank(node, { capacity: 100, amount: 50 });
    tank.addAmount(30);
    expect(tank.amount).toBe(80);
    tank.addAmount(50); // clamp to 100
    expect(tank.amount).toBe(100);
    tank.addAmount(-200); // clamp to 0
    expect(tank.amount).toBe(0);
  });

  it('setResource updates state + userData view', () => {
    const node = makeNode();
    const tank = new RVTank(node, {});
    tank.setResource('Beer');
    expect(tank.resourceName).toBe('Beer');
    expect(node.userData._rvTank.resourceName).toBe('Beer');
  });

  it('getTooltipData returns tank-typed data', () => {
    const node = makeNode();
    const tank = new RVTank(node, {});
    const data = tank.getTooltipData();
    expect(data.type).toBe('tank');
  });
});
