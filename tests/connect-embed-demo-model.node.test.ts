// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface GlbNode { name?: string; children?: number[]; extras?: unknown }

function parseGlbJson(path: string): { nodes: GlbNode[]; scenes: Array<{ nodes?: number[] }>; scene?: number } {
  const data = readFileSync(path);
  expect(data.toString('ascii', 0, 4)).toBe('glTF');
  const jsonLength = data.readUInt32LE(12);
  return JSON.parse(data.toString('utf8', 20, 20 + jsonLength).replace(/[\u0000 ]+$/, ''));
}

describe('CONNECT embedded reference demo', () => {
  it('contains the verified ConveyorEntry1 Drive_Simple.Forward bind target', () => {
    const gltf = parseGlbJson(resolve(__dirname, '../public/DemoRealvirtualWeb.glb'));
    const paths = new Map<number, string>();
    const visit = (index: number, parent = ''): void => {
      const node = gltf.nodes[index];
      const path = parent ? `${parent}/${node.name}` : (node.name ?? '');
      paths.set(index, path);
      for (const child of node.children ?? []) visit(child, path);
    };
    const scene = gltf.scenes[gltf.scene ?? 0];
    for (const root of scene.nodes ?? []) visit(root);

    const entry = [...paths].find(([, path]) => path === 'DemoCell/Conveyors/ConveyorEntry1');
    expect(entry).toBeDefined();
    const extras = gltf.nodes[entry![0]].extras as {
      realvirtual?: { Drive_Simple?: { Forward?: { type?: string; path?: string } } };
    };
    expect(extras.realvirtual?.Drive_Simple?.Forward).toEqual({
      type: 'ComponentReference',
      path: 'DemoCell/PLCInterface/--- Entry and Exit Conveyor  ----/EntryConveyorStart',
      componentType: 'realvirtual.PLCOutputBool',
      componentIndex: 0,
    });
  });
});
