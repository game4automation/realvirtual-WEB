// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * material-factory.test.ts — plan-271 test 9.1.
 *
 * Verifies the renderer-aware variant selection of the material factory:
 * classic 'webgl' gets the GLSL variant, BOTH WebGPURenderer kinds
 * ('webgpu-gl' AND 'webgpu') get the TSL variant, and the pre-warm caching
 * (dynamic import, warn-once fallback) behaves as specified.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveMaterialVariant,
  createMaterialContext,
  preloadTslMaterials,
  getTslMaterials,
  isTslPreloaded,
  __resetTslMaterialCacheForTests,
  type MaterialContext,
} from '../src/core/engine/materials/material-factory';

describe('material-factory (plan-271 phase 1)', () => {
  beforeEach(() => {
    __resetTslMaterialCacheForTests();
  });
  afterEach(() => {
    __resetTslMaterialCacheForTests();
    vi.restoreAllMocks();
  });

  it('selects GLSL variant for classic webgl', () => {
    const ctx: MaterialContext = { kind: 'webgl', needsTSL: false, hasCompute: false };
    expect(resolveMaterialVariant(ctx)).toBe('glsl');
  });

  it('selects TSL variant for both WebGPURenderer kinds', () => {
    expect(resolveMaterialVariant({ kind: 'webgpu-gl', needsTSL: true, hasCompute: false })).toBe('tsl');
    expect(resolveMaterialVariant({ kind: 'webgpu', needsTSL: true, hasCompute: true })).toBe('tsl');
  });

  it('createMaterialContext derives needsTSL := kind !== webgl and gates hasCompute to real webgpu', () => {
    expect(createMaterialContext('webgl')).toEqual({ kind: 'webgl', needsTSL: false, hasCompute: false });
    // webgpu-gl NEVER has compute — even if a caller claims otherwise (semantics core finding)
    expect(createMaterialContext('webgpu-gl', true)).toEqual({ kind: 'webgpu-gl', needsTSL: true, hasCompute: false });
    expect(createMaterialContext('webgpu', true)).toEqual({ kind: 'webgpu', needsTSL: true, hasCompute: true });
    expect(createMaterialContext('webgpu', false)).toEqual({ kind: 'webgpu', needsTSL: true, hasCompute: false });
  });

  it('preloadTslMaterials is a no-op under classic webgl', async () => {
    await preloadTslMaterials(createMaterialContext('webgl'));
    expect(isTslPreloaded()).toBe(false);
  });

  it('preloadTslMaterials caches the TSL modules under needsTSL; sync access works afterwards', async () => {
    await preloadTslMaterials(createMaterialContext('webgpu-gl'));
    expect(isTslPreloaded()).toBe(true);
    const mod = getTslMaterials();
    expect(mod).not.toBeNull();
    // Phase-2 contract: the flat merged namespace exposes all four ports.
    expect(typeof mod!.createUberMaterialTsl).toBe('function');
    expect(typeof mod!.createToonRecolorStateTsl).toBe('function');
    expect(typeof mod!.createToonMaterialTsl).toBe('function');
    expect(typeof mod!.createMUDissolveTsl).toBe('function');
    expect(typeof mod!.createMUGrowTsl).toBe('function');
    expect(typeof mod!.createPipeFlowMaterialTsl).toBe('function');
  });

  it('createUberMaterialTsl builds the rmPacked node material (Phase 2 port #1)', async () => {
    await preloadTslMaterials(createMaterialContext('webgpu-gl'));
    const mod = getTslMaterials()!;
    const uber = mod.createUberMaterialTsl();
    // Real MeshStandardNodeMaterial with the F4 contract intact:
    expect((uber as unknown as { isMeshStandardNodeMaterial?: boolean }).isMeshStandardNodeMaterial).toBe(true);
    expect(uber.vertexColors).toBe(true);
    expect(uber.name).toBe('__rvUberMaterial');
    expect(uber.userData._rvShared).toBe(true);
    // rmPacked-driven roughness/metalness nodes are wired
    expect(uber.roughnessNode).toBeTruthy();
    expect(uber.metalnessNode).toBeTruthy();
    uber.dispose();
  });

  it('sync access WITHOUT pre-warm returns null and warns exactly once (guard-fallback contract)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(getTslMaterials()).toBeNull();
    expect(getTslMaterials()).toBeNull();
    const factoryWarnings = warn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('[material-factory]'),
    );
    expect(factoryWarnings.length).toBe(1);
  });
});
