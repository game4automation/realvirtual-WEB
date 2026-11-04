// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * parametric-assembly-export.node.test.ts — plan-650 phase 3 measurement:
 * does `GLTFExporter` write the shared geometry of duplicated instances as ONE
 * glTF mesh (+ one accessor set), or one per instance? The answer decides
 * whether instances must be merged before the editor's GLB export (phase 4).
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { assemble } from '../src/core/engine/rv-parametric-assembly';

// Same minimal FileReader shim as bake-published-scenes.node.test.ts (GLTFExporter reads its blob through it).
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onload: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private _finish(value: ArrayBuffer | string): void {
      this.result = value;
      this.onload?.();
      this.onloadend?.();
    }
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then(b => this._finish(b)).catch(e => this.onerror?.(e));
    }
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer()
        .then(b => this._finish(`data:${blob.type};base64,${Buffer.from(b).toString('base64')}`))
        .catch(e => this.onerror?.(e));
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

function glbJson(buf: ArrayBuffer): { meshes: unknown[]; accessors: unknown[]; nodes: { mesh?: number }[] } {
  const view = new DataView(buf);
  const len = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, len)));
}

describe('GLB export of an assembled variant (plan-650 phase 3 measurement)', () => {
  it('writes N instances of one shared geometry as ONE glTF mesh referenced by N nodes', async () => {
    const parts = new Group();
    parts.name = '_Parts';
    const mat = new MeshStandardMaterial({ name: 'black' });
    for (const [name, geom] of [['Roller', new CylinderGeometry(25, 25, 420, 16)], ['Profile', new BoxGeometry(100, 20, 60).translate(50, 0, 0)]] as const) {
      const part = new Group(); part.name = name;
      const m = new Mesh(geom, mat); m.name = `${name}-mesh`;
      part.add(m); parts.add(part);
    }
    const res = assemble(parts, {
      instances: [
        ...Array.from({ length: 24 }, (_, i) => ({ part: 'Roller', positionMm: [50 + i * 90, 0, 30] as [number, number, number] })),
        { part: 'Profile', name: 'SideL', positionMm: [0, -220, 0], stretch: [{ axis: 'x', atMm: 50, byMm: 2060 }] },
        { part: 'Profile', name: 'SideR', positionMm: [0, 220, 0], stretch: [{ axis: 'x', atMm: 50, byMm: 2060 }] },
      ],
      nodes: [], components: [], messages: [],
    });
    if (!res.ok) throw new Error(res.error.message);
    const glb = (await new GLTFExporter().parseAsync(res.root, { binary: true })) as ArrayBuffer;
    const json = glbJson(glb);
    // 24 rollers → 1 mesh, 2 stretched sides (one derived geometry) → 1 mesh.
    expect(json.meshes.length).toBe(2);
    const refs = json.nodes.filter((n) => n.mesh !== undefined).map((n) => n.mesh);
    expect(refs.length).toBe(26);
    expect(new Set(refs).size).toBe(2);
  });
});
