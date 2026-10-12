// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
// SPIKE plan-756 — throw-away, not product code

import { Matrix4, TorusGeometry, Vector3, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import type { SegmentIn } from './spike-pick-structure';

export interface Merged {
  label: string;
  position: Float32Array;
  index: Uint32Array;
  perMesh: SegmentIn[];
  meshes: number;
  skippedTransparent: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

/** Deterministic 32-bit PRNG (mulberry32) — copied from src/core/engine/perf/rv-synthetic-line.ts. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boundsOf(position: Float32Array): Merged['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = position[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v;
  }
  return { min, max };
}

interface Part { geometry: BufferGeometry; matrix: Matrix4 }

function mergeParts(label: string, parts: Part[], skippedTransparent: number): Merged {
  let nv = 0, ni = 0;
  for (const p of parts) {
    const pos = p.geometry.getAttribute('position');
    nv += pos.count; ni += p.geometry.index ? p.geometry.index.count : pos.count;
  }
  const position = new Float32Array(nv * 3), index = new Uint32Array(ni);
  const perMesh: SegmentIn[] = [];
  const v = new Vector3();
  let vo = 0, io = 0;
  for (const p of parts) {
    const pos = p.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(p.matrix);
      position[3 * (vo + i)] = v.x; position[3 * (vo + i) + 1] = v.y; position[3 * (vo + i) + 2] = v.z;
    }
    const idx = p.geometry.index;
    const cnt = idx ? idx.count : pos.count;
    const usable = cnt - (cnt % 3);
    if (idx) { const arr = idx.array; for (let i = 0; i < usable; i++) index[io + i] = arr[i] + vo; }
    else for (let i = 0; i < usable; i++) index[io + i] = vo + i;
    perMesh.push({ indexStart: io, indexCount: usable });
    io += usable; vo += pos.count;
  }
  const idxUsed = io === index.length ? index : index.slice(0, io);
  return { label, position, index: idxUsed, perMesh, meshes: parts.length, skippedTransparent, bounds: boundsOf(position) };
}

/** Every opaque THREE.Mesh of a loaded glTF scene → one world-space position + Uint32 index. */
export function mergeScene(label: string, root: Object3D): Merged {
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  let skipped = 0;
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh || !m.geometry?.getAttribute('position')) return;
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as Material[];
    if (mats.some((x) => x && (x.transparent || x.opacity < 1))) { skipped++; return; }
    parts.push({ geometry: m.geometry, matrix: m.matrixWorld });
  });
  return mergeParts(label, parts, skipped);
}

/** Thin, highly tessellated curved sheet: half cylinder r = 1 m, 2 m long, two skins 0.5 mm apart. */
export function makeThinSheet(): Merged {
  const NU = 500, NV = 400, R = 1, GAP = 0.0005, LEN = 2;
  const nvSkin = (NU + 1) * (NV + 1);
  const position = new Float32Array(2 * nvSkin * 3), index = new Uint32Array(2 * NU * NV * 6);
  let io = 0;
  for (let skin = 0; skin < 2; skin++) {
    const r = R + skin * GAP, base = skin * nvSkin;
    for (let j = 0; j <= NV; j++) for (let i = 0; i <= NU; i++) {
      const a = (Math.PI * i) / NU, o = 3 * (base + j * (NU + 1) + i);
      position[o] = r * Math.cos(a); position[o + 1] = r * Math.sin(a); position[o + 2] = (LEN * j) / NV;
    }
    for (let j = 0; j < NV; j++) for (let i = 0; i < NU; i++) {
      const a = base + j * (NU + 1) + i, b = a + 1, c = a + NU + 1, d = c + 1;
      index[io++] = a; index[io++] = b; index[io++] = d; index[io++] = a; index[io++] = d; index[io++] = c;
    }
  }
  return {
    label: 'synthetic thin sheet (2 skins 0.5 mm apart, r=1 m)', position, index,
    perMesh: [{ indexStart: 0, indexCount: index.length / 2 }, { indexStart: index.length / 2, indexCount: index.length / 2 }],
    meshes: 2, skippedTransparent: 0, bounds: boundsOf(position),
  };
}

/** Fillet-dense part: 30 × 30 small tori (R 20 mm, r 5 mm, 1024 tris each) on a pitch of 60 mm. */
export function makeFilletPart(): Merged {
  const torus = new TorusGeometry(0.02, 0.005, 16, 32);
  const parts: Part[] = [];
  const rnd = makeRandom(7561);
  for (let j = 0; j < 30; j++) for (let i = 0; i < 30; i++) {
    const m = new Matrix4().makeRotationX(rnd() * Math.PI).setPosition(i * 0.06, 0.01 * rnd(), j * 0.06);
    parts.push({ geometry: torus, matrix: m });
  }
  const merged = mergeParts('synthetic fillet part (900 tori, 1024 tris each)', parts, 0);
  torus.dispose();
  return merged;
}
