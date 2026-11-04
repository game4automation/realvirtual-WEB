// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readGlb, writeGlb } from '../scripts/lib/rv-glb.mjs';
const { patchTurbineCollider } = await import(
  new URL('../scripts/patch-demo-turbine-collider.mjs', import.meta.url).href
) as { patchTurbineCollider: (buffer: Buffer) => { buffer: Buffer; changed: boolean } };

const shipped = readFileSync(new URL('../public/demo-realvirtual/DemoRealvirtualWeb.glb', import.meta.url));
const expectedCollider = {
  type: 'BoxCollider', isTrigger: false, enabled: true,
  center: { x: -0.020749867, y: 0.0272840261, z: -7.75143528 },
  size: { x: 38.2475, y: 38.4586, z: 15.9788342 },
};

describe('demo turbine body collider', () => {
  it('ships exactly the body collider on Turbine-cut below Turbine', () => {
    const { json } = readGlb(shipped);
    const parents = json.nodes.filter((n: { name: string }) => n.name === 'Turbine');
    expect(parents).toHaveLength(1);
    const children = parents[0].children.map((i: number) => json.nodes[i])
      .filter((n: { name: string }) => n.name === 'Turbine-cut');
    expect(children).toHaveLength(1);
    expect(children[0].extras.realvirtual.colliders).toEqual([expectedCollider]);
  });

  it('restores only the missing collider, preserving nodes, all other JSON and binary bytes', () => {
    const original = readGlb(shipped);
    const copy = structuredClone(original.json);
    delete copy.nodes.find((n: { name: string }) => n.name === 'Turbine-cut').extras.realvirtual.colliders;
    const input = writeGlb(copy, original.rest);
    const snapshot = Buffer.from(input);
    const result = patchTurbineCollider(input);
    expect(result.changed).toBe(true);
    expect(input.equals(snapshot)).toBe(true);
    const patched = readGlb(result.buffer);
    expect(patched.rest.equals(original.rest)).toBe(true);
    expect(patched.json.nodes).toHaveLength(original.json.nodes.length);
    expect(patched.json).toEqual(original.json);
    const again = patchTurbineCollider(result.buffer);
    expect(again.changed).toBe(false);
    expect(again.buffer.equals(result.buffer)).toBe(true);
  });

  it('leaves the shipped GLB byte-identical on repeat', () => {
    const result = patchTurbineCollider(Buffer.from(shipped));
    expect(result.changed).toBe(false);
    expect(result.buffer.equals(shipped)).toBe(true);
  });

  it.each([0, 2])('rejects %i matching target nodes', count => {
    const json = { nodes: [{ name: 'Turbine', children: Array.from({ length: count }, (_, i) => i + 1) },
      ...Array.from({ length: count }, () => ({ name: 'Turbine-cut' }))] };
    expect(() => patchTurbineCollider(writeGlb(json))).toThrow('Expected exactly one');
  });

  it('matches the project document hash and byte size', () => {
    const project = JSON.parse(readFileSync(new URL('../public/demo-realvirtual/project.json', import.meta.url), 'utf8'));
    const docs = project.documents.filter((doc: { path: string }) => doc.path === 'DemoRealvirtualWeb.glb');
    expect(docs).toHaveLength(1);
    expect(docs[0].sizeBytes).toBe(shipped.length);
    expect(docs[0].sha256).toBe(createHash('sha256').update(shipped).digest('hex'));
  });
});
