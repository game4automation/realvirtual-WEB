// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * renderer-settings-gating.node.test.ts — plan-271 test 9.9 (node).
 *
 * Source-level assertions (private-internal-gate pattern):
 *
 *  VisualTab.tsx:
 *   - the 'webgpu-gl' renderer option is `__RV_INTERNAL__`-gated (never ships
 *     in customer builds)
 *   - the 'webgpu-gl' option carries NO `disabled={!navigator.gpu}` — the
 *     forceWebGL path is exactly for devices WITHOUT a WebGPU adapter
 *     (plan-271 review finding 4)
 *   - the existing 'webgpu' option keeps its navigator.gpu gate (unchanged)
 *
 *  main.ts:
 *   - parses the renderer selection three-way ('webgpu' | 'webgpu-gl')
 *   - unknown/legacy values fall back to 'webgl' (review finding 13)
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VISUAL_TAB = resolve(__dirname, '../src/core/hmi/settings/VisualTab.tsx');
const MAIN = resolve(__dirname, '../src/main.ts');

describe('VisualTab renderer options (plan-271)', () => {
  const src = readFileSync(VISUAL_TAB, 'utf-8');

  /** The JSX expression container that renders the webgpu-gl MenuItem. */
  function webgpuGlBlock(): string {
    const idx = src.indexOf('value="webgpu-gl"');
    expect(idx, 'VisualTab.tsx must offer a webgpu-gl renderer option').toBeGreaterThan(-1);
    // The MenuItem element around the value attribute
    const start = src.lastIndexOf('<MenuItem', idx);
    const end = src.indexOf('</MenuItem>', idx);
    const menuItem = src.slice(start, end >= 0 ? end : idx + 200);
    return menuItem;
  }

  it('webgpu-gl option is __RV_INTERNAL__-gated', () => {
    const idx = src.indexOf('value="webgpu-gl"');
    expect(idx).toBeGreaterThan(-1);
    // The gate must sit between the Select opening and the webgpu-gl item,
    // in the same JSX expression: {__RV_INTERNAL__ && ( <MenuItem value="webgpu-gl" ... )}
    const before = src.slice(Math.max(0, idx - 400), idx);
    expect(/__RV_INTERNAL__\s*&&/.test(before)).toBe(true);
  });

  it('webgpu-gl option is NEVER disabled on !navigator.gpu (finding 4)', () => {
    const menuItem = webgpuGlBlock();
    expect(menuItem.includes('disabled')).toBe(false);
    expect(menuItem.includes('navigator.gpu')).toBe(false);
  });

  it('existing webgpu option keeps its navigator.gpu disabled-gate (unchanged)', () => {
    expect(/value="webgpu"\s+disabled=\{!navigator\.gpu\}/.test(src)).toBe(true);
  });
});

describe('main.ts renderer parsing (plan-271)', () => {
  const src = readFileSync(MAIN, 'utf-8');

  it('parses three-way: accepts webgpu AND webgpu-gl', () => {
    expect(/rendererParam\s*===\s*'webgpu'\s*\|\|\s*rendererParam\s*===\s*'webgpu-gl'/.test(src)).toBe(true);
  });

  it('falls back to webgl for unknown values (finding 13)', () => {
    // The whitelist-ternary must end in the 'webgl' default — anything not in
    // the accepted set (including legacy/unknown localStorage values) lands there.
    expect(/\?\s*rendererParam\s*:\s*'webgl'/.test(src)).toBe(true);
    // No legacy boolean parsing left
    expect(src.includes('const useWebGPU')).toBe(false);
  });

  it('passes the parsed kind into RVViewer.create via options.renderer', () => {
    expect(/RVViewer\.create\([^)]*renderer:\s*rendererKind/.test(src)).toBe(true);
  });
});
