// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The energy-chain skin keeps the uber material's per-vertex data through the
 * bend subdivision (2026-09-24).
 *
 * A baked chain element carries its colour as normalized Uint8 `color` and its
 * (roughness, metalness) as normalized Uint8 `rmPacked`. three's
 * `TessellateModifier` copies `color` raw (byte 3 → float 3.0 → white) and drops
 * `rmPacked` (→ roughness 0 → mirror). Symptom: white, shiny chains on every
 * baked model. `tessellateKeepingUberAttributes` carries both through.
 */
import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { tessellateKeepingUberAttributes } from '../src/core/engine/rv-energy-chain';

function longQuad(): BufferGeometry {
  // Two long triangles, 2 m × 0.1 m — the CAD straight face the bend needs split.
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    0, 0, 0, 2, 0, 0, 2, 0.1, 0,
    0, 0, 0, 2, 0.1, 0, 0, 0.1, 0,
  ]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(18).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(12), 2));
  return g;
}

describe('tessellateKeepingUberAttributes', () => {
  it('turns a normalized Uint8 colour into 0..1 floats on every new vertex and keeps rmPacked', () => {
    const g = longQuad();
    g.setAttribute('color', new BufferAttribute(new Uint8Array(18).fill(3), 3, true));     // near-black link
    g.setAttribute('rmPacked', new BufferAttribute(new Uint8Array(12).fill(0).map((_, i) => (i % 2 === 0 ? 230 : 25)), 2, true)); // rough, non-metal

    const out = tessellateKeepingUberAttributes(g, 0.2);

    const count = out.getAttribute('position').count;
    expect(count).toBeGreaterThan(6);
    const color = out.getAttribute('color') as BufferAttribute;
    const rm = out.getAttribute('rmPacked') as BufferAttribute;
    expect(color.count).toBe(count);
    expect(rm.count).toBe(count);
    for (let v = 0; v < count; v++) {
      expect(color.getX(v)).toBeCloseTo(3 / 255, 5);
      expect(color.getY(v)).toBeCloseTo(3 / 255, 5);
      expect(rm.getX(v)).toBeCloseTo(230 / 255, 5);
      expect(rm.getY(v)).toBeCloseTo(25 / 255, 5);
    }
    expect(out.getAttribute('uv1')).toBeUndefined();
    // The source geometry is untouched.
    expect(g.getAttribute('rmPacked')).toBeDefined();
    expect((g.getAttribute('color') as BufferAttribute).normalized).toBe(true);
  });

  it('leaves float colours and a geometry without uber attributes alone', () => {
    const g = longQuad();
    g.setAttribute('color', new BufferAttribute(new Float32Array(18).fill(0.25), 3));
    const out = tessellateKeepingUberAttributes(g, 0.2);
    const color = out.getAttribute('color') as BufferAttribute;
    expect(color.getX(0)).toBeCloseTo(0.25, 5);
    expect(out.getAttribute('rmPacked')).toBeUndefined();

    const plain = tessellateKeepingUberAttributes(longQuad(), 0.2);
    expect(plain.getAttribute('color')).toBeUndefined();
    expect(plain.getAttribute('rmPacked')).toBeUndefined();
  });

  it('keeps an authored uv1 and rebuilds rmPacked flat from vertex 0', () => {
    const g = longQuad();
    g.setAttribute('uv1', new BufferAttribute(new Float32Array(12).fill(0.5), 2));
    g.setAttribute('rmPacked', new BufferAttribute(new Uint8Array(12).fill(128), 2, true));
    const out = tessellateKeepingUberAttributes(g, 0.2);
    const count = out.getAttribute('position').count;
    expect((out.getAttribute('uv1') as BufferAttribute).getX(0)).toBeCloseTo(0.5, 5);
    const rm = out.getAttribute('rmPacked') as BufferAttribute;
    expect(rm.count).toBe(count);
    expect(rm.getX(count - 1)).toBeCloseTo(128 / 255, 5);
  });
});
