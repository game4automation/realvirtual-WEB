// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.5 / §9.5 — opening a project model owns every URL it mints.
 *
 * The leak this pins shut: `resolveAssetUrl` handed the dashboard an object URL
 * and dropped the backend's `release()`, with a comment explaining that nobody
 * could know when the model stopped being looked at. Blob data lives until its
 * URL is revoked, so every model opened from a project left its bytes resident
 * for the life of the tab.
 *
 * Two assertions, one per stage of the fix:
 *
 *  1. A self-contained GLB — the normal shape here — reaches the loader as
 *     BYTES. `URL.createObjectURL` is spied and must not be called at all.
 *     Counting the spy rather than checking a return value is deliberate: this
 *     has to fail if any layer between the backend and the loader reintroduces
 *     a wrapper, not only if the top one does.
 *  2. A GLB that names sibling files still needs a URL, and that URL is
 *     released EXACTLY ONCE when the store is disposed — not zero times (the
 *     old leak) and not twice (a double revoke on a shared slot).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { RVViewer } from '../src/core/rv-viewer';
import { getProjectStore } from '../src/core/project/project-store';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import {
  isSelfContainedGlb,
  projectAssetUrl,
} from '../src/core/project/rv-project-asset-source';

// ─── GLB fixtures ─────────────────────────────────────────────────────────

/** Build a binary GLB around `doc`, with an optional BIN chunk. */
function glb(doc: unknown, bin?: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonPad = (json.byteLength + 3) & ~3;
  const binPad = bin ? (bin.byteLength + 3) & ~3 : 0;
  const total = 12 + 8 + jsonPad + (bin ? 8 + binPad : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);      // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);     // 'JSON'
  out.fill(0x20, 20, 20 + jsonPad);         // JSON pads with spaces
  out.set(json, 20);
  if (bin) {
    const at = 20 + jsonPad;
    view.setUint32(at, binPad, true);
    view.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
    out.set(bin, at + 8);
  }
  return out;
}

const SELF_CONTAINED = glb(
  {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Machine' }],
    buffers: [{ byteLength: 4 }],
    images: [{ bufferView: 0 }],
  },
  new Uint8Array([1, 2, 3, 4]),
);

const EXTERNAL_TEXTURE = glb(
  {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Machine' }],
    buffers: [{ byteLength: 4 }],
    images: [{ uri: 'skin.png' }],     // a sibling file — needs a base URL
  },
  new Uint8Array([1, 2, 3, 4]),
);

// ─── Harness ──────────────────────────────────────────────────────────────

function makeViewer() {
  const v = {
    loadCalls: [] as { scene: RvScene; opts?: { identityUrl?: string; data?: ArrayBuffer } }[],
    availableModels: [] as unknown[],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    registry: { getGltfNodeIndex: () => 0, getGltfNodeNames: () => [], getNode: () => undefined },
    loadScene: vi.fn(async (
      scene: RvScene,
      _trust?: unknown,
      opts?: { identityUrl?: string; data?: ArrayBuffer },
    ) => {
      v.loadCalls.push({ scene, opts });
      v.currentScene = scene;
    }),
    loadEmptyScene: vi.fn(async () => {}),
    getPlugin: () => undefined,
  };
  return v;
}

/** A backend that serves ONE asset and counts what it was asked for. */
function fakeBackend(bytes: Uint8Array) {
  const released: string[] = [];
  const backend = {
    kind: 'browser', id: 'test', writable: true, isActive: true,
    listModels: async () => [],
    readBlobBytes: async (relPath: string) =>
      relPath === PATH ? (bytes.buffer.slice(0) as ArrayBuffer) : null,
    readBlobUrl: async (relPath: string) => {
      if (relPath !== PATH) return null;
      const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
      return { url, release: () => { released.push(url); URL.revokeObjectURL(url); } };
    },
  } as unknown as ProjectBackend;
  return { backend, released };
}

const PATH = 'models/Belt.glb';

function setBackend(backend: ProjectBackend | null): void {
  (getProjectStore() as unknown as { _backend: ProjectBackend | null })._backend = backend;
}

describe('isSelfContainedGlb', () => {
  it('accepts an embedded GLB and rejects one naming a sibling file', () => {
    expect(isSelfContainedGlb(SELF_CONTAINED.buffer as ArrayBuffer)).toBe(true);
    expect(isSelfContainedGlb(EXTERNAL_TEXTURE.buffer as ArrayBuffer)).toBe(false);
  });

  it('rejects anything that is not a version-2 binary GLB', () => {
    // A `.gltf` JSON file: its buffers are separate files by construction.
    const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
    expect(isSelfContainedGlb(json.buffer as ArrayBuffer)).toBe(false);
    expect(isSelfContainedGlb(new ArrayBuffer(4))).toBe(false);
  });

  it('treats a data: URI as embedded — it names no file', () => {
    const embedded = glb({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [] }],
      buffers: [{ uri: 'data:application/octet-stream;base64,AQID', byteLength: 3 }],
    });
    expect(isSelfContainedGlb(embedded.buffer as ArrayBuffer)).toBe(true);
  });
});

describe('opening a project model', () => {
  let store: SceneStore;
  let viewer: ReturnType<typeof makeViewer>;
  let createSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    viewer = makeViewer();
    store = new SceneStore(viewer as unknown as RVViewer);
    createSpy = vi.spyOn(URL, 'createObjectURL');
  });

  afterEach(() => {
    createSpy.mockRestore();
    setBackend(null);
  });

  it('mints no object URL for a self-contained GLB and loads it from bytes', async () => {
    const { backend } = fakeBackend(SELF_CONTAINED);
    setBackend(backend);

    await store.openBuiltin(projectAssetUrl(PATH), 'Belt');

    expect(createSpy).not.toHaveBeenCalled();
    const call = viewer.loadCalls.at(-1);
    expect(call?.opts?.data).toBeInstanceOf(ArrayBuffer);
    // The sentinel is the identity: stable across opens, unlike the random
    // UUID of the object URL it replaces.
    expect(call?.opts?.identityUrl).toBe(projectAssetUrl(PATH));
  });

  it('releases the URL of a GLB with external resources exactly once, on dispose', async () => {
    const { backend, released } = fakeBackend(EXTERNAL_TEXTURE);
    setBackend(backend);

    await store.openBuiltin(projectAssetUrl(PATH), 'Belt');

    // Stage 2: a URL WAS needed — the loader has to resolve `skin.png`.
    expect(createSpy).toHaveBeenCalledTimes(1);
    const call = viewer.loadCalls.at(-1);
    expect(call?.opts?.data).toBeUndefined();
    expect(call?.scene.base.kind === 'builtin' && call.scene.base.url.startsWith('blob:')).toBe(true);
    expect(released).toEqual([]);        // still on screen — nothing released yet

    store.dispose();
    expect(released).toHaveLength(1);

    // Idempotent: a second dispose must not double-revoke a shared slot.
    store.dispose();
    expect(released).toHaveLength(1);
  });

  it('reports a model it cannot read instead of loading nothing', async () => {
    const { backend } = fakeBackend(SELF_CONTAINED);
    setBackend(backend);

    await expect(store.openBuiltin(projectAssetUrl('models/Gone.glb'), 'Gone'))
      .rejects.toThrow(/could not be read from this project/);
  });
});
