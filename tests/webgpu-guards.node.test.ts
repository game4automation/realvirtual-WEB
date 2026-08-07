// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * webgpu-guards.node.test.ts — plan-271 PR#0 (F4) guard regression test.
 *
 * Four engine locations create GL-only constructs (onBeforeCompile GLSL
 * patches / PMREMGenerator) that are silently ignored or misrender under the
 * existing `?renderer=webgpu` opt-in. Each must guard its GL-only code path
 * behind an isWebGPU check (pattern: rv-post-processing.ts) with a one-time
 * console.warn. Source-regex assertions in the style of
 * private-internal-gate.node.test.ts.
 *
 * Runs in the Node environment (vitest.node.config.ts).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC = resolve(__dirname, '../src');

const read = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf-8');

/** Assert that `guardRe` matches and its FIRST match sits BEFORE the first
 *  match of `glOnlyRe` — i.e. the guard precedes the GL-only code path. */
function expectGuardBefore(src: string, guardRe: RegExp, glOnlyRe: RegExp): void {
  const guard = src.search(guardRe);
  const glOnly = src.search(glOnlyRe);
  expect(guard, `guard ${guardRe} not found`).toBeGreaterThanOrEqual(0);
  expect(glOnly, `GL-only path ${glOnlyRe} not found`).toBeGreaterThanOrEqual(0);
  expect(guard, 'isWebGPU guard must precede the GL-only path').toBeLessThan(glOnly);
}

describe('webgpu guards (plan-271 PR#0 / F4)', () => {
  it('rv-uber-material.ts guards the onBeforeCompile rmPacked patch', () => {
    const src = read('core/engine/rv-uber-material.ts');
    expectGuardBefore(src, /if\s*\(\s*isWebGPU\s*\)\s*\{/, /this\.onBeforeCompile\s*=/);
    // Guard path warns once
    expect(/warnUberWebGPUOnce\s*\(\s*\)/.test(src)).toBe(true);
  });

  it('rv-uber-material.ts keeps vertexColors: true on the uber material', () => {
    const src = read('core/engine/rv-uber-material.ts');
    // The contract: merged-mesh base colors stay correct under WebGPU because
    // the material itself (not the GLSL patch) carries vertexColors: true —
    // it must be part of the super() options, so the guarded early-return in
    // the constructor can never skip it.
    expect(/super\(\{[\s\S]*?vertexColors:\s*true[\s\S]*?\}\);/.test(src)).toBe(true);
  });

  it('rv-mu-dissolve.ts guards the onBeforeCompile clip patch', () => {
    const src = read('core/engine/rv-mu-dissolve.ts');
    expectGuardBefore(src, /if\s*\(\s*isWebGPU\s*\)\s*\{/, /onBeforeCompile\s*=/);
    expect(/warnDissolveWebGPUOnce\s*\(\s*\)/.test(src)).toBe(true);
  });

  it('rv-pipe-flow.ts guards the onBeforeCompile ring patch', () => {
    const src = read('core/engine/rv-pipe-flow.ts');
    expectGuardBefore(src, /if\s*\(\s*this\._isWebGPU\s*\)/, /onBeforeCompile\s*=/);
    expect(/warnPipeFlowWebGPUOnce\s*\(\s*\)/.test(src)).toBe(true);
  });

  it('rv-visual-settings-manager.ts guards PMREMGenerator in loadEnvMap()', () => {
    const src = read('core/rv-visual-settings-manager.ts');
    expectGuardBefore(src, /if\s*\(\s*this\.state\.isWebGPU\s*\)\s*\{/, /new\s+PMREMGenerator\s*\(/);
    expect(/warnEnvMapWebGPUOnce\s*\(\s*\)/.test(src)).toBe(true);
  });

  it('callers pass isWebGPU through to the guarded functions', () => {
    const loader = read('core/engine/rv-scene-loader.ts');
    expect(/applyUberMaterial\s*\(\s*root,\s*dedupResult\.uniqueMaterials,\s*options\?\.isWebGPU/.test(loader)).toBe(true);
    expect(/manager\.isWebGPU\s*=\s*options\?\.isWebGPU/.test(loader)).toBe(true);

    const transport = read('core/engine/rv-transport-manager.ts');
    expect(/createMUGrow\s*\([^)]*this\.isWebGPU\s*\)/.test(transport)).toBe(true);
    expect(/createMUDissolve\s*\([^)]*this\.isWebGPU\s*\)/.test(transport)).toBe(true);

    const viewer = read('core/rv-viewer.ts');
    expect(/new\s+PipeFlowManager\s*\([^)]*this\.isWebGPU\s*\)/.test(viewer)).toBe(true);
    expect(/get isWebGPU\(\)\s*\{\s*return self\.isWebGPU;\s*\}/.test(viewer)).toBe(true);
  });
});
