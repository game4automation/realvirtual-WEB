// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GLB round-trip test for CustomRuntimeInstruction (plan-228 §9.5).
 *
 * Verifies the generic nested-Serializable-list export fix: `steps` must be a
 * JSON ARRAY (not a numeric-keyed object), and each `step.targetObject` must be a
 * relative node-path STRING.
 *
 * SKIPPED until the Phase-1 C# export (realvirtualExportPlugin.cs nested-list
 * branch + CustomRuntimeInstruction.cs fields) ships and tests.glb is re-exported
 * with a CustomRuntimeInstruction block in node extras. The current tests.glb has
 * no such block, so enabling these would fail for the wrong reason. Re-enable
 * (remove `.skip`) after re-exporting tests.glb from Unity.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Scene, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

interface RVNode { rv: Record<string, Record<string, unknown>>; }
let nodes: RVNode[] = [];

beforeAll(async () => {
  const scene = new Scene();
  try {
    const gltf = await gltfLoader.loadAsync(DEV_GLB.tests);
    scene.add(gltf.scene);
    scene.traverse((n: Object3D) => {
      const rv = n.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv) nodes.push({ rv });
    });
  } catch { /* model unavailable — tests are skipped anyway */ }
});

function instructions(): Record<string, unknown>[] {
  return nodes.filter((n) => n.rv.CustomRuntimeInstruction != null).map((n) => n.rv.CustomRuntimeInstruction);
}

describe.skip('GLB CustomRuntimeInstruction round-trip (needs re-exported tests.glb)', () => {
  it('steps is a JSON array, not a numeric-keyed object', () => {
    const c = instructions()[0];
    expect(c).toBeDefined();
    expect(Array.isArray((c as Record<string, unknown>).steps)).toBe(true);
  });

  it('step.targetObject is a node-path string', () => {
    const c = instructions()[0] as Record<string, unknown>;
    const steps = c.steps as Array<Record<string, unknown>>;
    const withTarget = steps.find((s) => s.targetObject != null && s.targetObject !== '');
    if (withTarget) expect(typeof withTarget.targetObject).toBe('string');
  });
});
