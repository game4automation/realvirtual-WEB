// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-web-diagnostics.test.ts — GLB round-trip of the WebDiagnostics rv_extras
 * marker (plan-253, §9.8). SKIPPED until the Unity exporter ships
 * `WebDiagnostics.cs` and tests.glb is re-exported with a WebDiagnostics node.
 * Template: glb-custom-runtime-instruction.test.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Scene, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const gltfLoader = new GLTFLoader();

interface RVNode { rv: Record<string, Record<string, unknown>>; }
const nodes: RVNode[] = [];

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

function diagnostics(): Record<string, unknown>[] {
  return nodes.filter((n) => n.rv.WebDiagnostics != null).map((n) => n.rv.WebDiagnostics);
}

describe.skip('GLB WebDiagnostics round-trip (needs Unity WebDiagnostics.cs + re-exported tests.glb)', () => {
  it('rv_extras.WebDiagnostics is parsed', () => {
    const d = diagnostics()[0];
    expect(d).toBeDefined();
  });

  it('string fields survive the round-trip', () => {
    const d = diagnostics()[0] as Record<string, unknown>;
    expect(typeof (d.DocFilter ?? '')).toBe('string');
    expect(typeof (d.ErrorId ?? '')).toBe('string');
    expect(typeof (d.Label ?? '')).toBe('string');
  });

  it('signal references are ComponentReference objects or absent', () => {
    const d = diagnostics()[0] as Record<string, unknown>;
    for (const key of ['SignalBool', 'SignalInt'] as const) {
      const ref = d[key];
      if (ref != null) expect(typeof ref).toBe('object');
    }
  });
});
