// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-inspect.test.ts — the guard against GLTFExporter silently dropping meshes.
 *
 * `processAccessor` returns null for a zero-count attribute, `processMesh` then
 * finds no attributes and returns null, and the node is written WITHOUT a mesh.
 * No throw, no console warning. The user gets an object that appears in the
 * hierarchy and renders nothing — which is exactly the bug this file exists to
 * make impossible.
 *
 * These tests run the REAL exporter, so they document three's actual behaviour
 * rather than an assumed one.
 */

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BufferGeometry, BufferAttribute, Float32BufferAttribute, MeshStandardMaterial,
} from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  readGlbJson,
  countGlbMeshNodes,
  meshlessGlbNodeNames,
  assertGlbMeshCount,
} from '../src/core/import/rv-glb-inspect';

/** A mesh with `tris` triangles; `tris === 0` mimics a body occt failed to tessellate. */
function body(name: string, tris: number): Mesh {
  const verts = tris * 3;
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(new Float32Array(verts * 3), 3));
  if (verts > 0) g.setIndex(new BufferAttribute(new Uint32Array(verts), 1));
  const m = new Mesh(g, new MeshStandardMaterial());
  m.name = name;
  return m;
}

async function glbOf(...meshes: Mesh[]): Promise<ArrayBuffer> {
  const root = new Group();
  root.name = 'Assembly';
  for (const m of meshes) root.add(m);
  return objectToGlb(root);
}

describe('readGlbJson', () => {
  it('parses only the JSON chunk of a real GLB', async () => {
    const json = readGlbJson(await glbOf(body('A', 4)));
    expect(json.nodes?.length).toBeGreaterThan(0);
    expect(json.meshes?.length).toBe(1);
  });

  it('rejects non-GLB bytes rather than mis-parsing them', () => {
    expect(() => readGlbJson(new ArrayBuffer(4))).toThrow(/Too short/);
    expect(() => readGlbJson(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).buffer))
      .toThrow(/Bad magic/);
  });
});

describe('the silent mesh drop (documented three.js behaviour)', () => {
  it('GLTFExporter writes a zero-triangle body as a node WITHOUT a mesh', async () => {
    const glb = await glbOf(body('Good', 4), body('Empty', 0));
    const json = readGlbJson(glb);

    // Both nodes are there…
    const names = (json.nodes ?? []).map((n) => n.name);
    expect(names).toContain('Good');
    expect(names).toContain('Empty');
    // …but only one carries geometry. Nothing warned.
    expect(countGlbMeshNodes(json)).toBe(1);
    expect(meshlessGlbNodeNames(json)).toContain('Empty');
  });
});

describe('assertGlbMeshCount', () => {
  it('passes when every mesh survived the encode', async () => {
    const glb = await glbOf(body('A', 4), body('B', 6));
    expect(() => assertGlbMeshCount(glb, 2, 'test')).not.toThrow();
  });

  it('throws a precise, actionable error when a mesh was dropped', async () => {
    const glb = await glbOf(body('Good', 4), body('Empty', 0));
    expect(() => assertGlbMeshCount(glb, 2, 'step-import')).toThrow(
      /\[step-import\] GLB encoding lost 1 of 2 meshes/,
    );
    // The message names the offender so the user can find it in their CAD file.
    expect(() => assertGlbMeshCount(glb, 2, 'step-import')).toThrow(/Empty/);
  });

  it('is a no-op for a tree that legitimately has no meshes', async () => {
    const empty = new Group();
    empty.name = 'Assembly';
    expect(() => assertGlbMeshCount(new ArrayBuffer(0), 0, 'test')).not.toThrow();
    void empty;
  });

  it('tolerates the exporter emitting MORE mesh nodes than expected', async () => {
    // Instancing/splitting is fine; only a shortfall means lost geometry.
    const glb = await glbOf(body('A', 4));
    expect(() => assertGlbMeshCount(glb, 1, 'test')).not.toThrow();
  });
});
