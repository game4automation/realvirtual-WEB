// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A resolved body is a source of BYTES, never the model's IDENTITY.
 *
 * When a workspace resumes from a stored GLB body, `SceneStore._resolveLoad`
 * hands the viewer a scene whose base points at a `blob:` object URL with a
 * random UUID. Everything downstream that asks "which model is this?" — the
 * model-plugin lookup, the camera-preset key, the model selector, `?option=`,
 * `LS_KEY_MODEL`, the loading overlay's caption — used to read that UUID,
 * because the identity stopped at the seam and only the bytes travelled on.
 *
 * The visible damage was total and silent: `?scene=builtin:DemoRealvirtualWeb.glb`
 * reloaded after the first autosave with the geometry intact and not one of its
 * HMI plugins registered, captioned with the UUID. It looked like a stale cache,
 * which is why it survived so long — the one thing it was not is a cache.
 *
 * Transparent saving makes this sharper, not softer: the better the autosave,
 * the more reliably every user has a body, and the more reliably the demo lost
 * its HMI. So the rule is pinned here at the seam that produces it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const readSceneGlbBody = vi.fn(async (_slot: string) => null as { glb: Uint8Array; revision: string } | null);

vi.mock('../src/core/hmi/scene/rv-scene-glb-io', () => ({
  readSceneGlbBody: (slot: string) => readSceneGlbBody(slot),
  writeSceneGlbBody: vi.fn(async () => ({ revision: 'rev1', target: 'opfs' })),
  dropSceneGlbBody: vi.fn(async () => undefined),
  sceneGlbBodyRevision: vi.fn(async () => null),
}));

vi.mock('../src/core/hmi/scene/rv-scene-glb-bake', () => ({
  bakeIntoGlb: vi.fn(async () => ({ glb: new Uint8Array([1, 2, 3, 4]), warnings: [] })),
  makeRegistryBakeResolver: vi.fn(() => ({})),
  bakeRequiresFullPath: vi.fn(() => false),
}));

vi.mock('../src/core/hmi/scene/rv-scene-executors', () => ({
  applyForward: vi.fn(async () => undefined),
  applyInverse: vi.fn(async () => undefined),
  writeUserDataField: vi.fn(),
  deleteUserDataField: vi.fn(),
  reapplySchemaForComponent: vi.fn(),
}));

import { SceneStore } from '../src/core/hmi/scene/scene-store';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import { resolveModelName } from '../src/core/rv-model-plugin-manager';
import {
  getOpenDocumentBase,
  sameDocumentBase,
  sceneDocumentBase,
  setOpenDocumentBase,
} from '../src/core/editor/active-asset-store';

const MODEL_URL = '/models/DemoRealvirtualWeb.glb';
const MODEL_LABEL = 'DemoRealvirtualWeb';
/** What `_bodySlots()` names the per-base draft of that built-in. */
const DRAFT_SLOT = `draft/builtin:${encodeURIComponent(MODEL_URL)}`;
/** A minimal stand-in body — nothing parses it, the fake viewer just records it. */
const A_BODY = { glb: new Uint8Array([0x67, 0x6c, 0x54, 0x46]), revision: 'rev7' };

interface LoadCall { scene: RvScene; opts?: { identityUrl?: string } }

function makeViewer(calls: LoadCall[]) {
  return {
    loaded: [] as RvScene[],
    availableModels: [{ url: MODEL_URL, label: MODEL_LABEL }],
    availablePublishedScenes: [],
    currentScene: null as RvScene | null,
    currentModelUrl: null as string | null,
    currentModelRoot: null,
    registry: { getGltfNodeNames: () => [], getGltfNodeIndex: () => -1 },
    lastLoadResult: null,
    modes: { has: () => true, setMode: vi.fn() },
    getPlugin: () => undefined,
    loadScene: vi.fn(async (scene: RvScene, _trust?: unknown, opts?: { identityUrl?: string }) => {
      calls.push({ scene, opts });
    }),
  };
}

function makeStore(viewer: ReturnType<typeof makeViewer>): SceneStore {
  return new SceneStore(viewer as unknown as ConstructorParameters<typeof SceneStore>[0]);
}

/** Serve the draft slot a body; every other slot stays empty. */
function withStoredBody(): void {
  readSceneGlbBody.mockImplementation(async (slot: string) => (slot === DRAFT_SLOT ? A_BODY : null));
}

describe('resumed scene body — identity vs. bytes', () => {
  beforeEach(() => {
    localStorage.clear();
    readSceneGlbBody.mockReset();
    readSceneGlbBody.mockResolvedValue(null);
  });

  it('carries the built-in URL as identity when a stored body supplies the bytes', async () => {
    withStoredBody();

    const calls: LoadCall[] = [];
    const store = makeStore(makeViewer(calls));
    await store.openBuiltin(MODEL_URL, MODEL_LABEL);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // The bytes are the draft's...
    expect(call.scene.base.kind).toBe('builtin');
    expect((call.scene.base as { url: string }).url).toMatch(/^blob:/);
    // ...and the identity is still the model the workspace was opened from.
    expect(call.opts?.identityUrl).toBe(MODEL_URL);
  });

  it('passes no identity when there is no stored body — the plain path is unchanged', async () => {
    const calls: LoadCall[] = [];
    const store = makeStore(makeViewer(calls));
    await store.openBuiltin(MODEL_URL, MODEL_LABEL);

    expect(calls).toHaveLength(1);
    expect((calls[0].scene.base as { url: string }).url).toBe(MODEL_URL);
    expect(calls[0].opts?.identityUrl).toBeUndefined();
  });

  it('is the difference between finding the model plugin pack and not', async () => {
    withStoredBody();

    const calls: LoadCall[] = [];
    const store = makeStore(makeViewer(calls));
    await store.openBuiltin(MODEL_URL, MODEL_LABEL);

    const bytesUrl = (calls[0].scene.base as { url: string }).url;
    // This is the lookup ModelPluginManager performs. Reading it off the body
    // URL is what dropped the DemoRealvirtualWeb pack on every drafted reload.
    expect(resolveModelName(calls[0].opts!.identityUrl!)).toBe(MODEL_LABEL);
    expect(resolveModelName(bytesUrl)).not.toBe(MODEL_LABEL);
  });

  /**
   * The same rule, one level up — the DOCUMENT identity (plan-716 §9.0, §2.6).
   *
   * The three cases above pin the seam for a SOURCE (`builtinModel`, keyed by
   * its URL), which the Phase-4 collapse deliberately left standing. What the
   * collapse does change is the identity carried for OWNED content, and the
   * same "bytes are not identity" rule has to hold there: a workspace resuming
   * from a blob-backed body must still answer with the document it is, not with
   * the random UUID its bytes happen to be served under.
   *
   * Without this, `sameDocumentBase` would compare a fresh UUID on every reload
   * and the plan-711 bind — the whole reason the identity exists — would fail
   * exactly for documents that HAVE an autosaved body, i.e. the common case.
   */
  it('a resumed DOCUMENT answers with its documentId, never with the blob URL', async () => {
    withStoredBody();

    const calls: LoadCall[] = [];
    const store = makeStore(makeViewer(calls));
    await store.openBuiltin(MODEL_URL, MODEL_LABEL);

    // Publish a document identity the way the first save does, then resume.
    const identity = sceneDocumentBase('doc_plant', 'Plant');
    setOpenDocumentBase(identity);

    const bytesUrl = (calls[0].scene.base as { url: string }).url;
    expect(bytesUrl).toMatch(/^blob:/);

    const published = getOpenDocumentBase();
    expect(published).toEqual({
      kind: 'document', documentId: 'doc_plant', path: '', name: 'Plant',
    });
    // The identity is the document, and it does not contain the bytes URL in
    // any field — the confusion this whole file exists to prevent.
    expect(JSON.stringify(published)).not.toContain('blob:');
    // …and it still recognises itself, which is what the bind reads.
    expect(sameDocumentBase(published, sceneDocumentBase('doc_plant', 'renamed'))).toBe(true);
  });
});
