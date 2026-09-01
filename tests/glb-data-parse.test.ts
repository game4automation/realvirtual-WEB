// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * loadAndPrepareGLTF — pre-downloaded ArrayBuffer ("data") path.
 *
 * The model loader (main.ts) now downloads the GLB itself — with progress, a
 * timeout and retries — and hands the bytes to the loader via the `data` option
 * instead of the previous blob-URL detour (which double-buffered the file and
 * caused out-of-memory blank scenes on mobile). This test verifies the
 * `parseAsync(data)` path produces the same scene graph as the `loadAsync(url)`
 * path, so the memory-saving change is behaviourally transparent.
 *
 * Needs the demo GLB at ../realvirtual-WebViewer-Private~/projects/Development/fixtures/tests.glb (served by the vitest browser
 * server). When absent the test no-ops with a warning, matching glb-extras.test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Scene, Object3D } from 'three';
import { loadAndPrepareGLTF } from '../src/core/engine/rv-scene-loader';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

// plan-395: everything in `DEV_GLB` lives in the private Development project
// and is absent from a public checkout. The suites below must then report
// `skipped` rather than `passed` - a probe-and-return would leave this file
// green while it checked nothing. The probe tests the CONTENT TYPE, not
// `res.ok`: without the private sibling nothing claims `/private-assets/`, so
// the dev server answers it with the SPA fallback, a 200 text/html.
const DEV_ASSETS = await devAssetAvailable(DEV_GLB.tests);

const GLB_URL = DEV_GLB.tests;
let available = false;
let bytes: ArrayBuffer | null = null;

beforeAll(async () => {
  try {
    const head = await fetch(GLB_URL, { method: 'HEAD' });
    if (!head.ok) return;
    const len = parseInt(head.headers.get('content-length') || '0', 10);
    if (len < 100) return; // empty placeholder
    bytes = await (await fetch(GLB_URL)).arrayBuffer();
    available = bytes.byteLength > 100;
  } catch {
    available = false;
  }
}, 30000);

function countNodes(root: Object3D): number {
  let n = 0;
  root.traverse(() => { n++; });
  return n;
}

describe.skipIf(!DEV_ASSETS)('loadAndPrepareGLTF data (ArrayBuffer) path', () => {
  it('parses pre-downloaded bytes into a non-empty scene graph', async () => {
    if (!available || !bytes) {
      console.warn(`${GLB_URL} not available — skipping data-parse test`);
      return;
    }
    const scene = new Scene();
    const { root } = await loadAndPrepareGLTF(GLB_URL, scene, bytes);
    expect(root).toBeTruthy();
    expect(countNodes(root)).toBeGreaterThan(1);
    // The root must actually be attached to the target scene.
    expect(scene.children).toContain(root);
  }, 30000);

  it('produces the same node count as the URL (loadAsync) path', async () => {
    if (!available || !bytes) {
      console.warn(`${GLB_URL} not available — skipping parity test`);
      return;
    }
    const sceneUrl = new Scene();
    const viaUrl = await loadAndPrepareGLTF(GLB_URL, sceneUrl);

    const sceneData = new Scene();
    const viaData = await loadAndPrepareGLTF(GLB_URL, sceneData, bytes);

    expect(countNodes(viaData.root)).toBe(countNodes(viaUrl.root));
  }, 60000);
});
