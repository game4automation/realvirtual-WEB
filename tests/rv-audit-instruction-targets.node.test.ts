// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-734 F5 — the audit script has a CI hook.
 *
 * `scripts/validate-project.mjs` is the precedent this script copies, and the
 * reason it is copied all the way down to its test: an offline checker nobody
 * can import tends never to be wired into a pipeline, and one without a test
 * quietly rots until the day it is trusted.
 *
 * The fixtures are hand-written glTF JSON packed into GLB bytes rather than
 * `GLTFExporter` output: the script reads the JSON chunk directly, so this
 * exercises exactly the surface it has — and it lets the dedup case be authored
 * deliberately instead of hoping the exporter produces one.
 *
 * Runs under `npm run test:node` (`vitest.node.config.ts`).
 */

import { describe, it, expect } from 'vitest';
import { PropertyBinding } from 'three';

import {
  auditGlb,
  readGlbJson,
  sanitizeLikeThree,
  collectInstructionTargets,
  buildPathTable,
} from '../scripts/rv-audit-instruction-targets.mjs';

// ─── GLB packing ─────────────────────────────────────────────────────────

/** Pack a glTF JSON object into minimal GLB container bytes. */
function toGlbBytes(gltf: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const padded = (json.length + 3) & ~3;
  const chunk = new Uint8Array(padded).fill(0x20);
  chunk.set(json);

  const out = new Uint8Array(12 + 8 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(chunk, 20);
  return out;
}

/**
 * A two-branch model in which the SAME raw part name (containing a space and a
 * `:`) occurs twice — Three.js sanitizes both to `A_B1` and appends `_1` to the
 * second, so only the second needs the alias. One instruction targets each.
 */
function collidingModel(): unknown {
  const nodes = [
    { name: 'Zweig1', children: [1] },
    { name: 'A B:1', children: [2] },
    { name: 'Volumen' },
    { name: 'Zweig2', children: [4] },
    { name: 'A B:1', children: [5] },
    { name: 'Volumen' },
    {
      name: 'Panel',
      extras: {
        realvirtual: {
          CustomRuntimeInstruction: {
            type: 'Maintenance',
            steps: [
              { instruction: 'Grease the first one', targetObjects: ['Zweig1/A B:1/Volumen'] },
              { instruction: 'Grease the second one', targetObjects: ['Zweig2/A B:1/Volumen'] },
            ],
          },
        },
      },
    },
  ];
  return { asset: { version: '2.0' }, scenes: [{ nodes: [0, 3, 6] }], scene: 0, nodes };
}

describe('rv-audit-instruction-targets (plan-734 F5)', () => {
  it('reads the JSON chunk back out of GLB bytes', () => {
    const gltf = readGlbJson(toGlbBytes(collidingModel())) as { nodes: { name: string }[] };
    expect(gltf.nodes).toHaveLength(7);
    expect(gltf.nodes[1].name).toBe('A B:1');
  });

  it('rejects bytes that are not a GLB', () => {
    expect(() => readGlbJson(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a GLB/);
  });

  // The script cannot import the TypeScript `sanitizeLikeThree`, so its copy is
  // pinned against the REAL Three.js rule here — the same guard
  // `tests/three-name-sanitize.test.ts` puts on the TypeScript original.
  it('its sanitizer copy matches THREE.PropertyBinding.sanitizeNodeName', () => {
    for (const name of [
      'A B:1', 'MC04.01I00W', '-Kettenrad 201-201-026-STD-005333:1',
      'Volumenkörper1', 'a[0].b/c', 'plain', ' leading and trailing ',
    ]) {
      expect(sanitizeLikeThree(name)).toBe(PropertyBinding.sanitizeNodeName(name));
    }
  });

  it('collects targets from targetObjects AND the legacy targetObject', () => {
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{
        name: 'Panel',
        extras: {
          realvirtual: {
            CustomRuntimeInstruction: {
              // Legacy numeric-keyed object form, as pre-export-fix GLBs carry.
              steps: { 0: { instruction: 'x', targetObjects: ['A'], targetObject: 'B' } },
            },
          },
        },
      }],
    };
    const targets = collectInstructionTargets(gltf) as { path: string }[];
    expect(targets.map((t) => t.path)).toEqual(['A', 'B']);
  });

  it('de-duplicates a path listed in BOTH target fields of one step', () => {
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{
        name: 'Panel',
        extras: {
          realvirtual: {
            CustomRuntimeInstruction: {
              steps: [{ instruction: 'x', targetObjects: ['A'], targetObject: 'A' }],
            },
          },
        },
      }],
    };
    expect(collectInstructionTargets(gltf)).toHaveLength(1);
  });

  it('marks the deduped+sanitized target as broken before the fix and fixed after', () => {
    const result = auditGlb(toGlbBytes(collidingModel())) as {
      ok: boolean; targets: number; unresolvable: number; unresolvableLegacy: number;
      dedupedNodes: number; dedupedAndSanitized: number;
      findings: { path: string; status: string; resolvableBefore: boolean; culprit: string | null }[];
    };

    expect(result.targets).toBe(2);
    // Zweig2's part carries the `_1` suffix → exactly one broken target before.
    expect(result.unresolvableLegacy).toBe(1);
    expect(result.unresolvable).toBe(0);
    expect(result.ok).toBe(true);

    const broken = result.findings.find((f) => !f.resolvableBefore)!;
    expect(broken.path).toBe('Zweig2/A B:1/Volumen');
    expect(broken.status).toBe('resolvable');
    expect(broken.culprit).toBe('A B:1');

    // Zweig1 wins the clean name and was never affected.
    expect(result.findings.find((f) => f.path === 'Zweig1/A B:1/Volumen')!.resolvableBefore)
      .toBe(true);
  });

  it('reports a target that is not in the GLB at all', () => {
    const model = collidingModel() as { nodes: { name: string; extras?: never }[] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (model.nodes[6] as any).extras.realvirtual.CustomRuntimeInstruction.steps = [
      { instruction: 'ghost', targetObjects: ['Nowhere/At/All'] },
    ];
    const result = auditGlb(toGlbBytes(model)) as {
      ok: boolean; unresolvable: number; findings: { status: string; inGlb: boolean }[];
    };
    expect(result.ok).toBe(false);
    expect(result.unresolvable).toBe(1);
    expect(result.findings[0].status).toBe('path not in GLB');
    expect(result.findings[0].inGlb).toBe(false);
  });

  it('models the loader: mesh names share the dedup namespace with node names', () => {
    // A mesh named `Part` claims the name first, so the equally-named NODE is
    // pushed to `Part_1` even though no other node is called `Part`.
    const gltf = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      meshes: [{ name: 'Part' }],
      nodes: [
        { name: 'Root', mesh: 0, children: [1] },
        { name: 'Part' },
      ],
    };
    const table = buildPathTable(gltf) as { canonicalPath: string[] };
    expect(table.canonicalPath[1]).toBe('Root/Part_1');
  });

  it('a model without any instruction is trivially ok', () => {
    const result = auditGlb(toGlbBytes({
      asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ name: 'Solo' }],
    })) as { ok: boolean; targets: number };
    expect(result.ok).toBe(true);
    expect(result.targets).toBe(0);
  });
});
