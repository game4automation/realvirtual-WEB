// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readGlb, writeGlb } from '../scripts/lib/rv-glb.mjs';

const { patchDemoMotionTrail, MOTION_TRAIL, TRAIL_NODE_PATH, TCP_MOTION_TRAIL, TCP_TRAIL_NODE_PATH } = await import(
  new URL('../scripts/patch-demo-motion-trail.mjs', import.meta.url).href
) as { patchDemoMotionTrail: (b: Buffer) => { buffer: Buffer; changed: boolean }; MOTION_TRAIL: Record<string, unknown>; TRAIL_NODE_PATH: string; TCP_MOTION_TRAIL: Record<string, unknown>; TCP_TRAIL_NODE_PATH: string };

const shipped = readFileSync(new URL('../public/demo-realvirtual/DemoRealvirtualWeb.glb', import.meta.url));
type Node = { name: string; children?: number[]; extras?: { realvirtual?: Record<string, any> } };

function nodeAt(json: { nodes: Node[] }, path: string): Node | undefined {
  const parent: Record<number, number> = {};
  json.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => { parent[c] = i; }));
  return json.nodes.find((_, i) => {
    const p: string[] = [];
    for (let k: number | undefined = i; k !== undefined; k = parent[k]) p.unshift(json.nodes[k].name);
    return p.join('/') === path;
  });
}

describe('demo GLB motion trail', () => {
  it('ships robot ghosts and a TCP band with recording gated by a signal that starts false', () => {
    const { json } = readGlb(shipped);
    expect(nodeAt(json, TRAIL_NODE_PATH)?.extras?.realvirtual?.MotionTrail).toEqual(MOTION_TRAIL);
    expect(nodeAt(json, TCP_TRAIL_NODE_PATH)?.extras?.realvirtual?.MotionTrail).toEqual(TCP_MOTION_TRAIL);
    expect(MOTION_TRAIL.Mode).toBe('Ghosts'); expect(TCP_MOTION_TRAIL.Mode).toBe('Band');
    for (const name of ['MotionTrailRecord']) {
      const sig = nodeAt(json, `Robot/${name}`)?.extras?.realvirtual?.PLCOutputBool;
      expect(sig?.Status.Value).toBe(false);
    }
  });

  it('is idempotent and keeps the binary chunk byte-identical', () => {
    expect(patchDemoMotionTrail(shipped).changed).toBe(false);
    const original = readGlb(shipped);
    const copy = structuredClone(original.json);
    delete nodeAt(copy, TRAIL_NODE_PATH)!.extras!.realvirtual!.MotionTrail;
    delete nodeAt(copy, TCP_TRAIL_NODE_PATH)!.extras!.realvirtual!.MotionTrail;
    const result = patchDemoMotionTrail(writeGlb(copy, original.rest));
    expect(result.changed).toBe(true);
    expect(patchDemoMotionTrail(result.buffer).changed).toBe(false);
    expect(readGlb(result.buffer).rest.equals(original.rest)).toBe(true);
    expect(readGlb(result.buffer).json).toEqual(original.json);
  });

  it('keeps the project manifest size/sha in sync', () => {
    const project = JSON.parse(readFileSync(new URL('../public/demo-realvirtual/project.json', import.meta.url), 'utf8'));
    const doc = project.documents.find((d: { path: string }) => d.path === 'DemoRealvirtualWeb.glb');
    expect(doc.sizeBytes).toBe(shipped.length);
    expect(doc.sha256).toBe(createHash('sha256').update(shipped).digest('hex'));
  });
});
