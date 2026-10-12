// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 2b (F10) — the sidecar policy of a PLACED asset.
 *
 * `loadGLB` applies each composed frame's own `<glb>.kin.json` sidecar to an
 * UNSIGNED referenced file and none to a signed one (`applyFrameSidecars`).
 * Since Phase 2b a reference is never composed at runtime — it is decoded by
 * `ModelCache`, which therefore has to follow the same rule in `_decode`:
 *
 *  - unsigned file + adjacent sidecar → the spec is applied to the master
 *    BEFORE the recipe (the Drive it declares becomes a mover of the bake);
 *  - `loadKinematicsSidecar: () => false` → self-contained, nothing fetched;
 *  - the probe is negative-cached (one 404 per url, not one per placement);
 *  - an ABSENT sidecar is silent, whatever shape the server gives it: a 404,
 *    or — the everyday case — a dev server's SPA fallback / a static host
 *    answering `200 index.html`. One probe (`tryFetchSidecarSpec`) for the
 *    main model and every placement, so "absent" never reaches the console.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { ModelCache } from '../src/core/engine/rv-model-cache';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { resetSidecarProbeCache } from '../src/core/engine/rv-scene-loader';
import { group, uberMesh } from './fixtures/bake-fixture';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';

const uber = new RVUberMaterial(false);
const GLB_URL = 'http://rv-test.invalid/sidecar/machine.glb';
const SIDECAR_URL = 'http://rv-test.invalid/sidecar/machine.kin.json';
const SPEC = JSON.stringify({ drives: [{ target: 'Arm', direction: 'LinearX', speed: 100 }] });

/** What the "server" answers for the sidecar url — a test picks one before it loads. */
type SidecarAnswer = 'json' | 'html' | '404';
let sidecarAnswer: SidecarAnswer = 'json';
function sidecarResponse(): Response {
  switch (sidecarAnswer) {
    case 'json':
      return new Response(SPEC, { status: 200, headers: { 'content-type': 'application/json' } });
    case 'html':
      // Vite's SPA fallback and most static hosts: a missing path is 200 + the app shell.
      return new Response('<!DOCTYPE html>\n<html><head><title>realvirtual WEB</title></head><body></body></html>', {
        status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    case '404':
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
}

/** Machine: frame + a bare `Arm` mesh — the sidecar turns `Arm` into a Drive. */
async function machineBytes(): Promise<ArrayBuffer> {
  const root = group('Machine');
  root.add(uberMesh(uber, 'frame', [0, 0.5, 0]));
  root.add(uberMesh(uber, 'Arm', [2, 0.5, 0]));
  return objectToGlb(root);
}

const realFetch = globalThis.fetch;
let sidecarProbes = 0;
let bytes: ArrayBuffer;

beforeEach(async () => {
  resetSidecarProbeCache();
  sidecarProbes = 0;
  sidecarAnswer = 'json';
  bytes = await machineBytes();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === GLB_URL) return new Response(bytes.slice(0), { status: 200, headers: { 'content-type': 'model/gltf-binary' } });
    if (url === SIDECAR_URL) {
      sidecarProbes++;
      return sidecarResponse();
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; resetSidecarProbeCache(); vi.restoreAllMocks(); });

function cache(opts?: { sidecar?: boolean }): ModelCache {
  return new ModelCache(gltfLoader as unknown as GLTFLoader, {
    uber: () => uber,
    pickPort: () => createPickBuildPort({ createWorker: () => null }),
    ...(opts?.sidecar === false ? { loadKinematicsSidecar: () => false } : {}),
  });
}

describe('ModelCache applies the placed asset\'s own .kin.json sidecar (F10)', () => {
  it('an unsigned asset gets its sidecar: the declared Drive is a mover of the bake, probed once', async () => {
    const c = cache();
    const baked = await c.getOrLoadBaked(GLB_URL, undefined);
    const arm = baked.template.getObjectByName('Arm');
    expect(arm, 'Arm survived the bake as a component node').toBeTruthy();
    expect((arm!.userData.realvirtual as { Drive?: unknown })?.Drive, 'the sidecar Drive is on the node').toBeTruthy();
    expect(baked.chunks.some((c) => c.owner === arm), 'the Drive is a chunk boundary (mover)').toBe(true);
    expect(sidecarProbes).toBe(1);
    // A second cache asks again (fresh decode) — the probe cache answers, no second fetch.
    const again = await cache().getOrLoadBaked(GLB_URL, undefined);
    expect(again.template.getObjectByName('Arm')).toBeTruthy();
    expect(sidecarProbes).toBe(1);
    c.dispose();
  });

  it('loadKinematicsSidecar: false — self-contained, nothing fetched, Arm stays a bare mesh (merged away)', async () => {
    const c = cache({ sidecar: false });
    const baked = await c.getOrLoadBaked(GLB_URL, undefined);
    expect(sidecarProbes).toBe(0);
    expect(baked.template.getObjectByName('Arm'), 'a bare mesh has no survival reason').toBeFalsy();
    c.dispose();
  });
});

describe('an ABSENT sidecar is silent on the placement path', () => {
  it('200 + HTML (SPA fallback): absent — no warn, no error, Arm merged away, probed once', async () => {
    sidecarAnswer = 'html';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = cache();
    const baked = await c.getOrLoadBaked(GLB_URL, undefined);
    expect(sidecarProbes).toBe(1);
    expect(baked.template.getObjectByName('Arm'), 'no sidecar → no Drive → no survival reason').toBeFalsy();
    expect(warn.mock.calls, 'no console.warn for an absent sidecar').toEqual([]);
    expect(error.mock.calls, 'no console.error for an absent sidecar').toEqual([]);
    c.dispose();
  });

  it('404: absent — silent, Arm merged away', async () => {
    sidecarAnswer = '404';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = cache();
    const baked = await c.getOrLoadBaked(GLB_URL, undefined);
    expect(sidecarProbes).toBe(1);
    expect(baked.template.getObjectByName('Arm')).toBeFalsy();
    expect(warn.mock.calls).toEqual([]);
    expect(error.mock.calls).toEqual([]);
    c.dispose();
  });
});
