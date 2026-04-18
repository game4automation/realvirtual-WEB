// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVPump } from '../src/core/engine/rv-pump';

function makeNode(name = 'Pump1'): Object3D {
  const n = new Object3D();
  n.name = name;
  return n;
}

describe('RVPump', () => {
  it('applies schema from GLB extras', () => {
    const node = makeNode();
    const pump = new RVPump(node, { flowRate: 25 });
    expect(pump.flowRate).toBe(25);
  });

  it('attaches instance, sets _rvType to Pump, syncs _rvPump userData', () => {
    const node = makeNode();
    const pump = new RVPump(node, { flowRate: 10 });
    expect(node.userData._rvComponentInstance).toBe(pump);
    expect(node.userData._rvType).toBe('Pump');
    expect(node.userData._rvPump.flowRate).toBe(10);
  });

  it('start/stop mutates state', () => {
    const node = makeNode();
    const pump = new RVPump(node, {});
    expect(pump.isRunning).toBe(false);

    pump.start(40);
    expect(pump.flowRate).toBe(40);
    expect(pump.isRunning).toBe(true);

    pump.stop();
    expect(pump.flowRate).toBe(0);
    expect(pump.isRunning).toBe(false);
  });

  it('start negates negative rates (magnitude only)', () => {
    const node = makeNode();
    const pump = new RVPump(node, {});
    pump.start(-30);
    expect(pump.flowRate).toBe(30);
  });

  it('extracts pipe component ref path', () => {
    const node = makeNode();
    const pump = new RVPump(node, {
      pipe: { type: 'ComponentReference', path: 'Plant/PipeX' },
    });
    expect(pump.pipePath).toBe('Plant/PipeX');
  });

  it('getTooltipData returns pump-typed data', () => {
    const node = makeNode();
    const pump = new RVPump(node, {});
    const data = pump.getTooltipData();
    expect(data.type).toBe('pump');
  });
});
