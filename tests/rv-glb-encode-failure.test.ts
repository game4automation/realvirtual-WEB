// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-encode-failure.test.ts — the two ways GLTFExporter fails on a huge tree,
 * neither of which is an exception.
 *
 * three assembles a binary GLB by materialising the whole binary chunk as a Blob,
 * reading it back into an ArrayBuffer, building a SECOND Blob for the container,
 * and reading that back too. Under memory pressure:
 *
 *   - the SECOND read fails → `onDone(null)` → `parseAsync` resolves `null`;
 *   - the FIRST read fails  → `getPaddedArrayBuffer(null)` throws
 *     `TypeError: Cannot read properties of null (reading 'byteLength')` INSIDE a
 *     FileReader event handler, where no promise can observe it → `parseAsync`
 *     never settles and the import hangs forever.
 *
 * Both were reproduced against real Chrome. `objectToGlb` must turn each into a
 * prompt, typed, actionable error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Group, Mesh, BufferGeometry, BufferAttribute, Float32BufferAttribute, MeshStandardMaterial } from 'three';

/** Controls what the stubbed exporter does. */
const mode = vi.hoisted(() => ({ current: 'ok' as 'ok' | 'resolves-null' | 'first-read-throws' }));

vi.mock('three/examples/jsm/exporters/GLTFExporter.js', () => ({
  GLTFExporter: class {
    parseAsync(): Promise<unknown> {
      if (mode.current === 'resolves-null') return Promise.resolve(null);
      if (mode.current === 'first-read-throws') {
        // Mimic the uncaught TypeError three throws inside reader.onloadend.
        setTimeout(() => {
          window.dispatchEvent(new ErrorEvent('error', {
            error: new TypeError("Cannot read properties of null (reading 'byteLength')"),
            message: "Cannot read properties of null (reading 'byteLength')",
            cancelable: true, // real window 'error' events are cancelable
          }));
        }, 0);
        return new Promise(() => { /* never settles — the upstream hang */ });
      }
      return Promise.resolve(new ArrayBuffer(20));
    }
  },
}));

import { objectToGlb, GlbEncodingTooLargeError } from '../src/core/import/rv-import-object';

function tree(meshCount: number, trisEach: number): Group {
  const root = new Group();
  root.name = 'Assembly';
  for (let i = 0; i < meshCount; i++) {
    const verts = trisEach * 3;
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(verts * 3), 3));
    g.setIndex(new BufferAttribute(new Uint32Array(verts), 1));
    const m = new Mesh(g, new MeshStandardMaterial());
    m.name = `Body${i}`;
    root.add(m);
  }
  return root;
}

beforeEach(() => { mode.current = 'ok'; });

describe('objectToGlb encode failures', () => {
  it('returns the buffer on the happy path', async () => {
    await expect(objectToGlb(tree(2, 10))).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('turns `onDone(null)` into a typed, actionable error (was: "did not return binary GLB")', async () => {
    mode.current = 'resolves-null';
    await expect(objectToGlb(tree(3, 100))).rejects.toBeInstanceOf(GlbEncodingTooLargeError);
  });

  it('reports the triangle and mesh counts so the user can act on them', async () => {
    mode.current = 'resolves-null';
    let err: GlbEncodingTooLargeError | null = null;
    try {
      await objectToGlb(tree(3, 100));
    } catch (e) {
      err = e as GlbEncodingTooLargeError;
    }
    expect(err).toBeInstanceOf(GlbEncodingTooLargeError);
    expect(err!.meshes).toBe(3);
    expect(err!.triangles).toBe(300);
    expect(err!.message).toMatch(/coarser tessellation quality/);
  });

  it('rejects instead of hanging when the exporter throws inside its FileReader callback', async () => {
    mode.current = 'first-read-throws';
    // Without the window-error guard this promise never settles and the whole
    // import hangs — a 600 s timeout is how it first showed up.
    await expect(objectToGlb(tree(4, 50))).rejects.toBeInstanceOf(GlbEncodingTooLargeError);
  });

  it('removes its window listener afterwards (no leak, no cross-talk)', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await objectToGlb(tree(1, 10));
    expect(add).toHaveBeenCalledWith('error', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function));
    add.mockRestore();
    remove.mockRestore();
  });

  it('ignores unrelated window errors (the guard is narrow, not a catch-all)', async () => {
    mode.current = 'ok';
    // Swallow it ourselves so the runner does not report it — the guard must NOT
    // preventDefault an error that is none of its business.
    const swallow = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener('error', swallow);
    try {
      const p = objectToGlb(tree(1, 10));
      window.dispatchEvent(new ErrorEvent('error', {
        error: new TypeError('something else entirely'),
        cancelable: true,
      }));
      await expect(p).resolves.toBeInstanceOf(ArrayBuffer);
    } finally {
      window.removeEventListener('error', swallow);
    }
  });
});
