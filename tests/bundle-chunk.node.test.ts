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
  });
});
