// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVPipe } from '../src/core/engine/rv-pipe';

function makeNode(name = 'Pipe1'): Object3D {
  const n = new Object3D();
  n.name = name;
  return n;
}

describe('RVPipe', () => {
  it('applies schema from GLB extras', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, { resourceName: 'Water', flowRate: 12.5, uvDirection: 1 });
    expect(pipe.resourceName).toBe('Water');
    expect(pipe.flowRate).toBe(12.5);
    expect(pipe.uvDirection).toBe(1);
  });

  it('applies schema defaults when fields are missing', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, {});
    expect(pipe.resourceName).toBe('');
    expect(pipe.flowRate).toBe(0);
    expect(pipe.uvDirection).toBe(1);
  });

  it('attaches itself to node.userData._rvComponentInstance', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, {});
    expect(node.userData._rvComponentInstance).toBe(pipe);
    expect(node.userData._rvType).toBe('Pipe');
  });

  it('syncs legacy _rvPipe userData view', () => {
    const node = makeNode();
    new RVPipe(node, { resourceName: 'Oil', flowRate: 5 });
    expect(node.userData._rvPipe.resourceName).toBe('Oil');
    expect(node.userData._rvPipe.flowRate).toBe(5);
  });

  it('setFlow mutates state AND userData view', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, { flowRate: 0 });
    pipe.setFlow(-20);
    expect(pipe.flowRate).toBe(-20);
    expect(node.userData._rvPipe.flowRate).toBe(-20);
  });

  it('setResource mutates state AND userData view', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, {});
    pipe.setResource('Coolant');
    expect(pipe.resourceName).toBe('Coolant');
    expect(node.userData._rvPipe.resourceName).toBe('Coolant');
  });

  it('getTooltipData returns shape expected by the tooltip resolver', () => {
    const node = makeNode('MyPipe');
    const pipe = new RVPipe(node, {});
    const data = pipe.getTooltipData();
    expect(data.type).toBe('pipe');
    expect(typeof data.nodePath).toBe('string');
  });

  it('extracts source/destination component ref paths', () => {
    const node = makeNode();
    const pipe = new RVPipe(node, {
      source: { type: 'ComponentReference', path: 'Plant/TankA' },
      destination: { type: 'ComponentReference', path: 'Plant/PumpB' },
    });
    expect(pipe.sourcePath).toBe('Plant/TankA');
    expect(pipe.destinationPath).toBe('Plant/PumpB');
  });
});
