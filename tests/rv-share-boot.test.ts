// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.2 — consumer boot and trust.
 *
 * Two kinds of assertion live here, and the split is deliberate.
 *
 * **Behavioural**, wherever the behaviour is reachable: the boot module, the
 * trust wrapper on `RVViewer.loadModel` (invoked as the real function against a
 * minimal receiver — no 400-line load, but the shipped code), the interface
 * auto-connect gate, the store, and the card.
 *
 * **Source guards** for the three facts that live in `main.ts`'s boot
 * sequence — parameter precedence, the planner-mode fallback, and the
 * active-scene resume bypass. Booting `main.ts` in a unit test is not possible
 * (it builds a renderer, a project store and thirty plugins), and the
 * established precedent in this suite for "this line must keep saying this" is
 * a `?raw` import — see `historian-trend-plugin.test.ts`. Each guard below
 * pins the exact expression whose absence caused, or would cause, a known
 * defect.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { Object3D } from 'three';

import mainSource from '../src/main.ts?raw';
import viewerSource from '../src/core/rv-viewer.ts?raw';
import {
  withLoadTrust,
  TRUSTED_LOAD,
  type LoadTrustContext,
} from '../src/core/rv-load-trust';
import { bootSharedGlb, type ShareBootViewer } from '../src/core/share/rv-share-boot';
import { setShareIdResolver } from '../src/core/share/rv-share-target';
import {
  getSharedGlbSnapshot,
  clearSharedGlb,
} from '../src/core/share/rv-share-store';
import { SharePlugin } from '../src/core/share/share-plugin';
import { SharedGlbInfoCard } from '../src/core/share/SharedGlbInfoCard';
import { buildSharedGlbInfo } from '../src/core/share/rv-share-meta';
import { InterfaceManager } from '../src/interfaces/interface-manager';
import { listMetas } from '../src/core/hmi/scene/rv-scene-storage';

const LS_KEY_MODEL = 'rv-webviewer-last-model';
const SHARE_URL = 'https://files.example.org/pick-and-place.glb';

const RV_SHARE = {
  v: 1,
  name: 'Pick & Place Cell',
  author: 'Thomas Strigl',
  license: 'CC-BY-4.0',
  level: 'assembly',
  expiresAt: '2026-09-04T00:00:00.000Z',
};

/** A GLB "root" carrying scenes[0].extras exactly as GLTFLoader restores it. */
function rootWithShareBlock(block: unknown = RV_SHARE): Object3D {
  const root = new Object3D();
  root.userData = { rv_share: block };
  return root;
}

interface FakeViewer extends ShareBootViewer {
  calls: { url: string; options: { data: ArrayBuffer; modelName?: string; trust: LoadTrustContext } }[];
  currentModelUrl: string | null;
}

function makeViewer(root: Object3D | null = rootWithShareBlock()): FakeViewer {
  const v: FakeViewer = {
    calls: [],
    currentModelUrl: null,
    loadModel: vi.fn(async (url, options) => {
      v.calls.push({ url, options });
      return root ? { root } : undefined;
    }),
  };
  return v;
}

/** A streamed 200 with `bytes` of body. */
function okFetch(bytes = 512): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(bytes).fill(3)); c.close(); },
  }))) as unknown as typeof fetch;
}

beforeEach(() => {
  localStorage.clear();
  clearSharedGlb();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearSharedGlb();
});

// ─── Loading ────────────────────────────────────────────────────────────

describe('share boot — loading', () => {
  it('share_GlbParam_LoadsInViewer: the shared GLB is loaded, untrusted, and the URL is left alone', async () => {
    const before = window.location.href;
    const viewer = makeViewer();

    const result = await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });

    expect(result.ok).toBe(true);
    expect(viewer.calls).toHaveLength(1);
    expect(viewer.calls[0].url).toBe(SHARE_URL);
    expect(viewer.calls[0].options.data.byteLength).toBe(512);
    // F17: the load is marked foreign, with the origin recorded for the badge.
    expect(viewer.calls[0].options.trust).toEqual({ trusted: false, sourceOrigin: 'files.example.org' });
    // The card model comes out of the file, not out of a sidecar.
    expect(getSharedGlbSnapshot().info?.name).toBe('Pick & Place Cell');
    // F18: the canonical URL stays `?glb=` — nothing here rewrites history.
    expect(window.location.href).toBe(before);
  });

  it('falls back to the filename when the GLB carries no rv_share block', async () => {
    const viewer = makeViewer(new Object3D());
    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });

    const info = getSharedGlbSnapshot().info!;
    expect(info.name).toBe('pick-and-place');
    // The origin row is the security measure, so it survives the absence of
    // every other field — the card shrinks, it does not vanish.
    expect(info.originHost).toBe('files.example.org');
    expect(info.meta).toBeNull();
  });

  it('ignores a malformed rv_share block instead of failing the whole link', async () => {
    const viewer = makeViewer(rootWithShareBlock({ v: 99, name: 12345 }));
    const result = await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });

    expect(result.ok).toBe(true);
    expect(getSharedGlbSnapshot().info?.meta).toBeNull();
    expect(getSharedGlbSnapshot().info?.name).toBe('pick-and-place');
  });

  it('share_OpaqueId_ResolvesToSignedUrl: `s:<id>` is resolved before the fetch', async () => {
    // Phase 1 ships the seam, not the backend call — so this exercises the
    // registered-resolver contract that Phase 2 will satisfy for real.
    const resolve = vi.fn(async (id: string) => `https://signed.example.org/${id}?sig=abc`);
    const restore = setShareIdResolver(resolve);
    try {
      const viewer = makeViewer();
      const result = await bootSharedGlb(viewer, 's:sh_1234', { fetch: { fetchImpl: okFetch() } });

      expect(result.ok).toBe(true);
      expect(resolve).toHaveBeenCalledWith('sh_1234');
      expect(viewer.calls[0].url).toBe('https://signed.example.org/sh_1234?sig=abc');
    } finally {
      restore();
    }
  });

  it('refuses an opaque id when no resolver is installed, and never guesses a URL', async () => {
    const viewer = makeViewer();
    const result = await bootSharedGlb(viewer, 's:sh_1234', { fetch: { fetchImpl: okFetch() } });

    expect(result.ok).toBe(false);
    expect(viewer.calls).toHaveLength(0);
    expect(getSharedGlbSnapshot().error).toMatch(/cannot resolve/i);
  });

  it('rejects a resolver that returns a non-http target', async () => {
    const restore = setShareIdResolver(async () => 'javascript:alert(1)');
    try {
      const viewer = makeViewer();
      const result = await bootSharedGlb(viewer, 's:evil', { fetch: { fetchImpl: okFetch() } });
      expect(result.ok).toBe(false);
      expect(viewer.calls).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('share_Gone410_DistinguishesExpiredFromDeleted: the reason is shown when given, never invented', async () => {
    const viewer = makeViewer();

    const gone = (reason?: string) => (async () => new Response(null, {
      status: 410,
      ...(reason ? { headers: { 'x-rv-share-reason': reason } } : {}),
    })) as unknown as typeof fetch;

    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: gone('expired') } });
    expect(getSharedGlbSnapshot().error).toMatch(/expired/i);

    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: gone('deleted') } });
    expect(getSharedGlbSnapshot().error).toMatch(/deleted/i);

    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: gone() } });
    expect(getSharedGlbSnapshot().error).toMatch(/no longer available/i);
    expect(getSharedGlbSnapshot().error).not.toMatch(/expired|deleted/i);

    // Nothing was loaded in any of the three cases.
    expect(viewer.calls).toHaveLength(0);
  });
});

// ─── F7: no side effects on the visitor ─────────────────────────────────

describe('share boot — no receiver side effects (F7)', () => {
  it('share_DoesNotWriteAnyKey: pre-filled scene keys and the last-model entry survive untouched', async () => {
    // The guard has to run against POPULATED keys: an assertion that an empty
    // localStorage is still empty would pass even if the boot wrote a null.
    localStorage.setItem('rv-scenes/active', JSON.stringify({ id: 'scn_visitor' }));
    localStorage.setItem('rv-scenes/scn_visitor', JSON.stringify({
      id: 'scn_visitor', name: 'My Line', schemaVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z', modifiedAt: '2026-01-01T00:00:00.000Z',
      base: { kind: 'empty' }, edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    }));
    localStorage.setItem('rv-scenes/draft/empty', JSON.stringify({ name: 'visitor draft' }));
    localStorage.setItem('rv-scenes/scene-draft/scn_visitor', JSON.stringify({ name: 'visitor scene draft' }));
    localStorage.setItem(LS_KEY_MODEL, 'models/VisitorsOwnModel.glb');

    const snapshotBefore = JSON.stringify(
      Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])),
    );
    const metasBefore = listMetas();

    const viewer = makeViewer();
    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });

    const snapshotAfter = JSON.stringify(
      Object.fromEntries(Object.keys(localStorage).sort().map(k => [k, localStorage.getItem(k)])),
    );
    expect(snapshotAfter).toBe(snapshotBefore);
    expect(listMetas()).toEqual(metasBefore);
    // Belt and braces on the two sources R4 identified by name.
    expect(localStorage.getItem(LS_KEY_MODEL)).toBe('models/VisitorsOwnModel.glb');
    expect(JSON.parse(localStorage.getItem('rv-scenes/active')!)).toEqual({ id: 'scn_visitor' });
  });

  it('writes nothing on the failure path either', async () => {
    localStorage.setItem(LS_KEY_MODEL, 'models/VisitorsOwnModel.glb');
    const viewer = makeViewer();

    await bootSharedGlb(viewer, SHARE_URL, {
      fetch: { fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch },
    });

    expect(localStorage.getItem(LS_KEY_MODEL)).toBe('models/VisitorsOwnModel.glb');
    expect(Object.keys(localStorage)).toEqual([LS_KEY_MODEL]);
  });

  it('does not persist the share itself — a reload without the parameter leaves no trace', async () => {
    const viewer = makeViewer();
    await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });
    expect(Object.keys(localStorage)).toHaveLength(0);
  });
});

// ─── main.ts routing (source guards) ────────────────────────────────────

describe('share boot — main.ts routing', () => {
  it('share_Precedence_SceneBeatsGlbBeatsModel: ?scene= wins, then ?glb=, then ?model=', () => {
    const glbBranch = mainSource.indexOf('if (!sceneRouted && urlGlb)');
    const sceneBranch = mainSource.indexOf("const urlScene = params.get('scene')");
    const modelBranch = mainSource.indexOf("const urlModel = params.get('model')");

    expect(sceneBranch, '?scene= resolution must exist').toBeGreaterThan(-1);
    expect(glbBranch, '?glb= branch must exist and be guarded by !sceneRouted').toBeGreaterThan(-1);
    expect(modelBranch, '?model= resolution must exist').toBeGreaterThan(-1);

    // Ordering IS the precedence: `?scene=` resolves first and sets
    // sceneRouted, the guarded `?glb=` branch runs next, and `?model=` only
    // gets a turn afterwards.
    expect(sceneBranch).toBeLessThan(glbBranch);
    expect(glbBranch).toBeLessThan(modelBranch);
    expect(mainSource).toContain('sceneRouted = true;');
  });

  it('share_GlbWithPlannerMode_NotOverriddenByEmpty: the planner fallback excludes ?glb= (Finding 15)', () => {
    // Without `!urlGlb` here, `?glb=…&mode=planner` synthesises `scene=empty`,
    // the empty scene wins on precedence, and the shared content never
    // arrives. The defect is invisible in every other combination, which is
    // exactly why it needs a pinned assertion.
    expect(mainSource).toMatch(
      /const urlScene = params\.get\('scene'\)\s*\?\?\s*\(plannerMode && !params\.get\('model'\) && !urlGlb \? 'empty' : null\)/,
    );
  });

  it('share_SkipsActiveSceneResume: a shared link never opens in the visitor\'s last scene', async () => {
    // Two halves: the boot reports success (so main.ts sets sceneRouted) …
    const viewer = makeViewer();
    const result = await bootSharedGlb(viewer, SHARE_URL, { fetch: { fetchImpl: okFetch() } });
    expect(result.ok).toBe(true);

    // … and the resume block is gated on exactly that flag.
    const resumeGuard = mainSource.indexOf('if (!sceneRouted) {');
    const glbBranch = mainSource.indexOf('if (!sceneRouted && urlGlb)');
    expect(resumeGuard).toBeGreaterThan(glbBranch);
    expect(mainSource.slice(resumeGuard, resumeGuard + 400)).toContain('readActiveId()');
  });

  it('share_PluginRegistered: the info-card plugin is passed to .use() and owns an overlay slot', () => {
    // R13: a plugin that is written and never registered looks finished and
    // shows nothing.
    expect(mainSource).toContain('.use(new SharePlugin(), \'core\')');

    const plugin = new SharePlugin();
    expect(plugin.id).toBe('share');
    expect(plugin.slots.map(s => s.slot)).toContain('overlay');
  });
});

// ─── Trust (F17) ────────────────────────────────────────────────────────

/**
 * `withLoadTrust` is the real, shipped implementation of the install/restore
 * rule — `RVViewer.loadModel` and `loadScene` are three-line delegations to it.
 * Exercising it here tests the actual control flow, including the `finally`,
 * without importing the viewer (which would pull three.js, the renderer and
 * thirty subsystems into a unit test).
 */
function trustHolder() {
  let current: LoadTrustContext = TRUSTED_LOAD;
  const seen: LoadTrustContext[] = [];
  return {
    slot: { get: () => current, set: (n: LoadTrustContext) => { current = n; } },
    seen,
    observe: () => { seen.push(current); },
    get current() { return current; },
  };
}

describe('share boot — load trust (F17)', () => {
  it('trust_ContextResetAfterSuccess: the untrusted window closes when the load returns', async () => {
    const h = trustHolder();

    await withLoadTrust(h.slot, { trusted: false, sourceOrigin: 'files.example.org' }, async () => {
      h.observe();
    });

    // Untrusted DURING the load — that is where the side effects happen …
    expect(h.seen[0]).toEqual({ trusted: false, sourceOrigin: 'files.example.org' });
    // … and trusted again the moment it is over.
    expect(h.current).toBe(TRUSTED_LOAD);
  });

  it('trust_ContextResetAfterFailure: a thrown load still restores the context', async () => {
    const h = trustHolder();

    await expect(withLoadTrust(h.slot, { trusted: false }, async () => {
      throw new Error('parse failed');
    })).rejects.toThrow('parse failed');

    // The dangerous shape is the opposite of the obvious one: a viewer stuck
    // in "untrusted" after a failed foreign load would silently refuse to
    // auto-connect for every legitimate model afterwards — a defect that
    // breaks nothing loudly, it just makes things quietly stop happening.
    expect(h.current).toBe(TRUSTED_LOAD);
  });

  it('trust_NormalLoadAfterShareIsTrusted: the next ordinary load is trusted again', async () => {
    const h = trustHolder();

    await withLoadTrust(h.slot, { trusted: false }, async () => { h.observe(); });
    await withLoadTrust(h.slot, undefined, async () => { h.observe(); });

    expect(h.seen[0].trusted).toBe(false);
    expect(h.seen[1].trusted).toBe(true);
    expect(h.current).toBe(TRUSTED_LOAD);
  });

  it('defaults to trusted so every pre-existing caller is unchanged', async () => {
    const h = trustHolder();
    await withLoadTrust(h.slot, undefined, async () => { h.observe(); });
    expect(h.seen[0]).toBe(TRUSTED_LOAD);
  });

  it('the viewer routes both load entry points through that one rule', () => {
    // Two call sites, one implementation — the guard that keeps a future edit
    // from reintroducing a hand-rolled try/finally that forgets the restore.
    expect(viewerSource).toContain(
      'return withLoadTrust(this._trustSlot, options?.trust, () => this._loadModelInner(url, options));',
    );
    expect(viewerSource).toContain(
      'return withLoadTrust(this._trustSlot, trust, () => this._loadSceneInner(scene, trust, opts));',
    );
    // And the gates that read it.
    expect(viewerSource).toContain('this._plannerSignalLinking && this._loadTrust.trusted');
  });

  it('share_NeverAutoConnectsInterface: no interface is activated or fed for an untrusted load', async () => {
    const manager = new InterfaceManager();
    const activate = vi.spyOn(manager, 'activate');
    const ifaceOnModelLoaded = vi.fn();
    // An interface that is ALREADY active is the sharper case: the connection
    // exists, and handing a stranger's model to it is the side effect to stop.
    vi.spyOn(manager, 'getActive').mockReturnValue(
      { onModelLoaded: ifaceOnModelLoaded } as never,
    );

    const untrusted = { loadTrust: { trusted: false, sourceOrigin: 'files.example.org' } };
    manager.onModelLoaded({} as never, untrusted as never);

    expect(activate).not.toHaveBeenCalled();
    expect(ifaceOnModelLoaded).not.toHaveBeenCalled();

    // Control: the same call on a trusted load DOES reach the interface, so
    // the assertions above are measuring the gate and not a broken fixture.
    manager.onModelLoaded({} as never, { loadTrust: TRUSTED_LOAD } as never);
    expect(ifaceOnModelLoaded).toHaveBeenCalledTimes(1);
  });
});

// ─── The card (F5/F14) ──────────────────────────────────────────────────

describe('share boot — info card', () => {
  it('share_CardShowsOriginAndExpiry: origin always, expiry only when one was set', () => {
    const info = buildSharedGlbInfo({ url: SHARE_URL, userData: { rv_share: RV_SHARE } });
    render(createElement(SharedGlbInfoCard, { info }));

    expect(screen.getByTestId('shared-glb-origin').textContent).toContain('files.example.org');
    expect(screen.getByTestId('shared-glb-expiry').textContent).toMatch(/expires on/i);
    expect(screen.getByText(/Pick & Place Cell/)).toBeTruthy();
    expect(screen.getByText(/assembly · Thomas Strigl · CC-BY-4\.0/)).toBeTruthy();

    cleanup();

    // No deadline set → no expiry row at all. A permanent "expires: never"
    // line would train visitors to ignore the row that matters.
    const noExpiry = buildSharedGlbInfo({
      url: SHARE_URL,
      userData: { rv_share: { v: 1, name: 'Portal Axis' } },
    });
    render(createElement(SharedGlbInfoCard, { info: noExpiry }));
    expect(screen.getByTestId('shared-glb-origin')).toBeTruthy();
    expect(screen.queryByTestId('shared-glb-expiry')).toBeNull();
  });

  it('hides the download button when the provider switched downloads off (F14)', () => {
    const off = buildSharedGlbInfo({
      url: SHARE_URL,
      userData: { rv_share: { ...RV_SHARE, allowDownload: false } },
    });
    expect(off.downloadAllowed).toBe(false);

    render(createElement(SharedGlbInfoCard, { info: off, onDownload: undefined }));
    expect(screen.queryByTestId('shared-glb-download')).toBeNull();

    cleanup();

    const on = buildSharedGlbInfo({ url: SHARE_URL, userData: { rv_share: RV_SHARE } });
    expect(on.downloadAllowed).toBe(true);
    render(createElement(SharedGlbInfoCard, { info: on, onDownload: () => {} }));
    expect(screen.getByTestId('shared-glb-download')).toBeTruthy();
  });

  it('shows the failure sentence instead of an empty viewport', () => {
    render(createElement(SharedGlbInfoCard, { info: null, error: 'This shared link has expired.' }));
    expect(screen.getByTestId('shared-glb-error').textContent).toMatch(/expired/i);
  });
});
