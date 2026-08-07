// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * embed-spike.node.test.ts — plan-326 AP1 dist guards for the rv-embed
 * library build (`vite.embed.config.ts` → `dist-embed/`).
 *
 * Runs against an existing embed build; skipped when `dist-embed/` is absent
 * (same pattern as tests/bundle-chunk.node.test.ts against `dist/`). Arm with:
 *   npx vite build --config vite.embed.config.ts
 *
 * Validates the AP1 Go/No-Go evidence:
 *  1. Entry static closure (rv-embed.js + statically imported chunks)
 *     stays ≤ 2 MB gzip (plan NFR; warn threshold 1.6 MB).
 *  2. TSL / three-webgpu code is NOT in the static closure (the
 *     material-factory dynamic-import boundary survives the lib build —
 *     plan 3.1 P.3).
 *  3. No React / MUI / Monaco / stats-gl markers anywhere in the output.
 *  4. AGPL + corresponding-source banner is present (plan 3.1 P.4).
 *
 * NOTE plan-326 head: distinct from the `connect-embed-*` tests — those cover
 * the CONNECT embed mode INSIDE the main React app, not this library build.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist-embed');
const entryPath = join(distDir, 'rv-embed.js');
const hasDist = existsSync(entryPath);

/** Marker that only occurs inside the three/webgpu WGSL compiler (same
 *  rationale as tests/bundle-chunk.node.test.ts). */
const TSL_MARKERS = ['WGSLNodeBuilder'];

/** Markers for HMI-stack libraries that must never reach the embed bundle. */
const FORBIDDEN_MARKERS = [
  'react-dom',
  'MuiButtonBase',
  '@mui/material',
  'monaco-editor',
  'stats-gl',
];

/** All .js files in dist-embed (chunks + workers). */
function allJsFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  };
  walk(distDir);
  return out;
}

/**
 * Resolve the STATIC import closure of the entry: follow `import ... from "..."`
 * (excluding dynamic `import("...")`) transitively. Only these chunks load when
 * a page imports rv-embed.js — dynamic chunks (BVH worker port, sig worker,
 * future TSL) load on demand and do not count against the entry budget.
 */
function staticClosure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    // static: `import ... from"./x.js"` / `import"./x.js"` / `export ... from"./x.js"`
    // dynamic imports are `import("./x.js")` — excluded by the (?!\() guard.
    const re = /(?:import|export)\s*(?:[^;'"()]*?from\s*)?["']([^"']+\.js)["']/g;
    for (const m of code.matchAll(re)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      queue.push(join(dirname(file), spec));
    }
  }
  return [...seen];
}

describe.skipIf(!hasDist)('rv-embed dist guards (plan-326 AP1)', () => {
  it('entry static closure stays within the 2 MB gzip budget', () => {
    const files = staticClosure(entryPath);
    expect(files.length).toBeGreaterThan(0);
    let totalGzip = 0;
    for (const f of files) {
      totalGzip += gzipSync(readFileSync(f), { level: 9 }).length;
    }
    if (totalGzip > 1.6 * 1024 * 1024) {
      console.warn(`[rv-embed] entry closure gzip ${totalGzip} bytes exceeds the 1.6 MB warning threshold`);
    }
    expect(totalGzip, `entry static closure gzip ${totalGzip} bytes`).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it('keeps TSL/webgpu code out of the entry static closure', () => {
    for (const f of staticClosure(entryPath)) {
      const code = readFileSync(f, 'utf8');
      for (const marker of TSL_MARKERS) {
        expect(code.includes(marker), `${f} must not contain "${marker}"`).toBe(false);
      }
    }
  });

  it('contains no React/MUI/Monaco/stats-gl code anywhere in the output', () => {
    for (const f of allJsFiles()) {
      const code = readFileSync(f, 'utf8');
      for (const marker of FORBIDDEN_MARKERS) {
        expect(code.includes(marker), `${f} must not contain "${marker}"`).toBe(false);
      }
    }
  });

  it('carries the AGPL + corresponding-source banner in the entry', () => {
    const code = readFileSync(entryPath, 'utf8');
    expect(code).toContain('AGPL-3.0-only');
    expect(code).toContain('Corresponding Source:');
  });
});
