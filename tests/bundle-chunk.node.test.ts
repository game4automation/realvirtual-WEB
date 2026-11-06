// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Test 9.8 (plan-271): the TSL material variants (three/webgpu + three/tsl)
 * must NOT end up in the default entry chunk — they are pre-warmed via
 * dynamic import only when a WebGPURenderer kind is active (NFR: no +400KB
 * for default WebGL users).
 *
 * Runs against an existing production build (dist/). Skipped when dist/ is
 * absent so the regular node suite stays build-independent; CI/release runs
 * `npm run build` first, which arms this test.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'dist', 'assets');
const hasDist = existsSync(assetsDir);

// Marker string that only occurs INSIDE the three/webgpu library
// implementation (the WGSL shader compiler). Deliberately NOT export names
// like `MeshStandardNodeMaterial` (appears in the entry as property access on
// the dynamic module namespace) and NOT `WebGPUBackend` (substring of the
// legitimate `isWebGPUBackend` feature check in rv-viewer).
const TSL_MARKERS = ['WGSLNodeBuilder'];

describe.skipIf(!hasDist)('bundle chunking (plan-271 9.8)', () => {
  it('keeps TSL/webgpu code out of the default entry chunk', () => {
    const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    expect(files.length).toBeGreaterThan(0);

    // The entry chunk is referenced by dist/index.html via <script type="module" src=...>
    const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
    const entryMatches = [...html.matchAll(/src="\.?\/?assets\/(index-[^"]+\.js)"/g)].map((m) => m[1]);
    expect(entryMatches.length, 'entry chunk referenced from index.html').toBeGreaterThan(0);

    for (const entry of entryMatches) {
      const code = readFileSync(join(assetsDir, entry), 'utf8');
      for (const marker of TSL_MARKERS) {
        expect(code.includes(marker), `entry chunk ${entry} must not contain "${marker}"`).toBe(false);
      }
    }
  });

  it('ships the TSL code in a separate async chunk', () => {
    const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
    const tslChunks = files.filter((f) => {
      const code = readFileSync(join(assetsDir, f), 'utf8');
      return TSL_MARKERS.some((m) => code.includes(m));
    });
    expect(tslChunks.length, 'at least one async chunk carries the TSL code').toBeGreaterThan(0);
  }, 60_000); // reads every emitted chunk of dist/ — I/O-bound, ~16 s on a dev machine
});

/**
 * Test 9.8 (plan-762): the path-tracer scene data (`PathtracerBVHComputeData`
 * of three-gpu-pathtracer, the ray traced mode's and the cinematic capture's
 * BVH layout) must never reach the entry chunk — it is loaded only through the
 * private adapters' dynamic imports. Checked ONLY when `dist/` stems from a
 * private build (a community build does not contain the tracer at all, so
 * "not in the entry" would hold vacuously and "somewhere else" would fail).
 *
 * The class name itself is mangled by the minifier; the storage-buffer name
 * the class sets (`setName('bvh_materials')`) is a string literal and
 * survives, so it is the second marker. `PathtracerBVHComputeData` stays in
 * the list for unminified builds.
 */
const TRACER_MARKERS = ['PathtracerBVHComputeData', 'bvh_materials'];

/** Chunk-file prefixes only a private build emits (the private feature adapters and
 *  `rv-cinematic-scene`, the shared async chunk of the cinematic renderer and the ray
 *  traced backend that carries the tracer data). */
const PRIVATE_CHUNK_RE = /^(rv-cinematic-renderer|rv-cinematic-scene|cinematic-render\.register|raytraced-render\.register|rv-raytraced-backend)-/;

const privateDist = hasDist && readdirSync(assetsDir).some((f) => PRIVATE_CHUNK_RE.test(f));

describe.skipIf(!privateDist)('bundle chunking — tracer data (plan-762 9.8, private dist only)', () => {
  it('keeps the tracer scene data out of the entry chunk', () => {
    const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
    const entries = [...html.matchAll(/src="\.?\/?assets\/(index-[^"]+\.js)"/g)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const code = readFileSync(join(assetsDir, entry), 'utf8');
      for (const marker of TRACER_MARKERS) {
        expect(code.includes(marker), `entry chunk ${entry} must not contain "${marker}"`).toBe(false);
      }
    }
  });

  it('ships the tracer scene data in a private async chunk', () => {
    const files = readdirSync(assetsDir).filter((f) => PRIVATE_CHUNK_RE.test(f) && f.endsWith('.js'));
    const carriers = files.filter((f) => {
      const code = readFileSync(join(assetsDir, f), 'utf8');
      return TRACER_MARKERS.some((m) => code.includes(m));
    });
    expect(carriers.length, 'a private async chunk carries the tracer data').toBeGreaterThan(0);
  });
});
