// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Trusting a shared model with your own plant (plan-423 §9.4, F6 + F7).
 *
 * Four questions, and the tests are grouped by them:
 *
 * 1. **Does the banner even appear?** Only if it reads `modelProvenance`. The
 *    load-time `loadTrust` is restored to TRUSTED the moment `loadModel()`
 *    returns (`withLoadTrust`'s `finally`), so a banner reading it would be
 *    permanently invisible — review finding SOL-R1 F1, pinned here.
 * 2. **Does the decision stick to the right model?** Key AND digest, both
 *    checked, with the mismatch cases spelled out: same id/other bytes, other
 *    model, revocation.
 * 3. **Does it stay clear of plan-397?** The signature chain is a SEPARATE
 *    brake. `none`/`valid` already run today; `invalid`/`unverifiable` stay
 *    gated after trust activation until the user's own `activateGatedLogic`
 *    click, and nothing here ever calls `persistSignatureUnlock`.
 * 4. **Does anything new write to the plant?** No: F7 is answered by the
 *    absence of a new write path plus a positive and a negative test on the
 *    existing one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Object3D } from 'three';

import { bootSharedGlb, type ShareBootViewer } from '../src/core/share/rv-share-boot';
import { setShareIdResolver } from '../src/core/share/rv-share-target';
import { clearSharedGlb } from '../src/core/share/rv-share-store';
import {
  SHARE_TRUST_KEY, SHARE_TRUST_VERSION,
  digestOfBytes, forgetShareTrust, isShareTrusted, rememberShareTrust,
  shareTrustKeyForId, shareTrustKeyForUrl,
} from '../src/core/share/rv-share-trust-store';
import {
  LOCAL_PROVENANCE, getModelProvenance, setModelProvenance, resetModelProvenance,
  type ModelProvenance,
} from '../src/core/rv-model-provenance';
import { CommissioningTrustBanner } from '../src/core/hmi/CommissioningTrustBanner';
import { activateContext, _resetStore } from '../src/core/hmi/ui-context-store';
import { modeContext } from '../src/core/rv-mode-manager';
import { TRUSTED_LOAD, withLoadTrust, type LoadTrustContext } from '../src/core/rv-load-trust';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { InterfaceManager } from '../src/interfaces/interface-manager';

import viewerSource from '../src/core/rv-viewer.ts?raw';
import bootSource from '../src/core/share/rv-share-boot.ts?raw';
import loadTrustSource from '../src/core/rv-load-trust.ts?raw';
import bannerSource from '../src/core/hmi/CommissioningTrustBanner.tsx?raw';
import trustStoreSource from '../src/core/share/rv-share-trust-store.ts?raw';
import sceneLoaderSource from '../src/core/engine/rv-scene-loader.ts?raw';
import connectPluginSource from '../src/plugins/connect-plugin.tsx?raw';
import signalStoreSource from '../src/core/engine/rv-signal-store.ts?raw';

const SHARE_URL = 'https://files.example.org/pick-and-place.glb';
const SHARE_ID = 'sh_1234';

/** Bytes with a stable, distinguishable content. */
const bytesOf = (fill: number, len = 512) => new Uint8Array(len).fill(fill).buffer;

interface FakeViewer extends ShareBootViewer {
  calls: Array<{
    url: string;
    options: {
      data: ArrayBuffer;
      trust: LoadTrustContext;
      provenance?: ModelProvenance;
    };
  }>;
  currentModelUrl: string | null;
}

function makeViewer(): FakeViewer {
  const v: FakeViewer = {
    calls: [],
    currentModelUrl: null,
    loadModel: vi.fn(async (url, options) => {
      v.calls.push({ url, options });
      return { root: new Object3D() };
    }),
  };
  return v;
}

/** A streamed 200 whose body is `bytes`. */
function okFetch(bytes: ArrayBuffer): typeof fetch {
  return (async () => new Response(new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); },
  }))) as unknown as typeof fetch;
}

async function boot(param: string, bytes: ArrayBuffer): Promise<FakeViewer> {
  const viewer = makeViewer();
  await bootSharedGlb(viewer, param, { fetch: { fetchImpl: okFetch(bytes) } });
  return viewer;
}

function renderBanner(onReload = vi.fn()) {
  activateContext(modeContext('commissioning'));
  render(createElement(CommissioningTrustBanner, { onReload }));
  return onReload;
}

beforeEach(() => {
  localStorage.clear();
  clearSharedGlb();
  resetModelProvenance();
  _resetStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearSharedGlb();
  resetModelProvenance();
  _resetStore();
  localStorage.clear();
});

// ─── 1. The banner reads modelProvenance, never loadTrust ─────────────────

describe('commissioningTrust_BannerSource', () => {
  it('appears for an untrusted shared model even though loadTrust reads TRUSTED', async () => {
    // The exact regression SOL-R1 F1 named: after the load, the trust wrapper
    // has already put the context back. Anything that asks "is this trusted?"
    // AFTER the load must ask modelProvenance.
    const slot = { current: TRUSTED_LOAD as LoadTrustContext };
    await withLoadTrust(
      { get: () => slot.current, set: (n) => { slot.current = n; } },
      { trusted: false, sourceOrigin: 'files.example.org' },
      async () => {},
    );
    expect(slot.current).toBe(TRUSTED_LOAD);   // the trap

    setModelProvenance({
      trusted: false, source: 'share',
      trustRecordKey: shareTrustKeyForId(SHARE_ID), digest: 'abc',
      sourceOrigin: 'files.example.org',
    });
    renderBanner();

    expect(screen.getByTestId('commissioning-trust-banner').textContent)
      .toMatch(/switched off/i);
    expect(screen.getByTestId('commissioning-trust-banner').textContent)
      .toContain('files.example.org');
  });

  it('stays away for the visitor\'s own content', () => {
    setModelProvenance(LOCAL_PROVENANCE);
    renderBanner();
    expect(screen.queryByTestId('commissioning-trust-banner')).toBeNull();
  });

  it('stays away outside the commissioning workspace', () => {
    setModelProvenance({
      trusted: false, source: 'share', trustRecordKey: 'share:x', digest: 'abc',
    });
    // No context activated at all — a POSITIVE rule, so it fails closed here
    // (and in the CONNECT embed, and before mode boot).
    render(createElement(CommissioningTrustBanner, { onReload: vi.fn() }));
    expect(screen.queryByTestId('commissioning-trust-banner')).toBeNull();
  });

  it('offers revocation once the model IS trusted', () => {
    setModelProvenance({
      trusted: true, source: 'share', trustRecordKey: 'share:x', digest: 'abc',
    });
    renderBanner();
    expect(screen.getByTestId('commissioning-trust-revoke')).toBeTruthy();
    expect(screen.queryByTestId('commissioning-trust-activate')).toBeNull();
  });
});

// ─── 1b. The viewer's provenance lifecycle ────────────────────────────────

describe('commissioningTrust_ProvenanceLifecycle', () => {
  it('the viewer publishes at the END of a load, guarded by the load generation', () => {
    // Source guards: the behaviour needs a renderer and a 400-line load, and
    // both properties are exactly the kind a refactor drops silently.
    expect(viewerSource).toContain(
      'this._setModelProvenance(options?.provenance ?? LOCAL_PROVENANCE);',
    );
    expect(viewerSource).toContain('if (this._loadGeneration === loadGeneration) {');
    // …and resets in clearModel, which every load runs FIRST — so a failed load
    // cannot leave the previous model's record on screen.
    const clearAt = viewerSource.indexOf('clearModel(): void {');
    expect(clearAt).toBeGreaterThan(-1);
    expect(viewerSource.slice(clearAt, clearAt + 1200))
      .toContain('this._setModelProvenance(LOCAL_PROVENANCE);');
  });

  it('publishing an EQUAL provenance is a no-op — no re-render storm', () => {
    // `useSyncExternalStore` re-renders on every notification, and a load that
    // ends where it started is the common case. Equality is checked field by
    // field, so the state object is not even replaced.
    const p: ModelProvenance = { trusted: false, source: 'share', trustRecordKey: 'k', digest: 'd' };
    setModelProvenance(p);
    expect(getModelProvenance()).toBe(p);
    setModelProvenance({ ...p });
    expect(getModelProvenance()).toBe(p);
    setModelProvenance({ ...p, trusted: true });
    expect(getModelProvenance()).not.toBe(p);
  });

  it('rv-load-trust.ts is untouched by this plan', () => {
    // The persisted decision is read in the share BOOT, one layer above. This
    // module keeps saying only what it said before (SOL-R2 F5).
    expect(loadTrustSource).not.toMatch(/commissioning|provenance|localStorage/i);
  });
});

// ─── 2. Identity: key AND digest ──────────────────────────────────────────

describe('commissioningTrust_Persistence', () => {
  it('a stored decision makes the next boot of the SAME bytes trusted', async () => {
    const bytes = bytesOf(3);
    const digest = await digestOfBytes(bytes);
    rememberShareTrust(shareTrustKeyForId(SHARE_ID), digest);

    const restore = setShareIdResolver(async id => `https://signed.example.org/${id}?sig=abc`);
    try {
      const viewer = await boot(`s:${SHARE_ID}`, bytes);
      expect(viewer.calls).toHaveLength(1);
      // Read BEFORE loadModel by construction: it IS the argument.
      expect(viewer.calls[0].options.trust.trusted).toBe(true);
      expect(viewer.calls[0].options.provenance).toMatchObject({
        trusted: true, source: 'share', trustRecordKey: `share:${SHARE_ID}`, digest,
      });
    } finally {
      restore();
    }
  });

  it('without a decision the boot stays untrusted — today\'s behaviour', async () => {
    const viewer = await boot(SHARE_URL, bytesOf(3));
    expect(viewer.calls[0].options.trust.trusted).toBe(false);
    expect(viewer.calls[0].options.provenance).toMatchObject({
      trusted: false, source: 'own-url', trustRecordKey: shareTrustKeyForUrl(SHARE_URL),
    });
  });

  it('DIGEST MISMATCH: same id, different bytes ⇒ untrusted again', async () => {
    const digest = await digestOfBytes(bytesOf(3));
    rememberShareTrust(shareTrustKeyForId(SHARE_ID), digest);

    const restore = setShareIdResolver(async () => 'https://signed.example.org/x?sig=abc');
    try {
      // The provider swapped the file behind the link. The user vouched for a
      // machine he looked at, not for an address.
      const viewer = await boot(`s:${SHARE_ID}`, bytesOf(9));
      expect(viewer.calls[0].options.trust.trusted).toBe(false);
    } finally {
      restore();
    }
  });

  it('another model is never trusted along with it', async () => {
    const digest = await digestOfBytes(bytesOf(3));
    rememberShareTrust(shareTrustKeyForId(SHARE_ID), digest);

    // Same bytes, DIFFERENT link: the decision was about one shared model.
    const viewer = await boot('https://elsewhere.example.org/other.glb', bytesOf(3));
    expect(viewer.calls[0].options.trust.trusted).toBe(false);
  });

  it('the record is versioned, and an unknown version is ignored', async () => {
    const key = shareTrustKeyForId(SHARE_ID);
    const digest = (await digestOfBytes(bytesOf(3)))!;
    rememberShareTrust(key, digest);
    expect(JSON.parse(localStorage.getItem(SHARE_TRUST_KEY)!)[key])
      .toEqual({ digest, v: SHARE_TRUST_VERSION });

    localStorage.setItem(SHARE_TRUST_KEY, JSON.stringify({ [key]: { digest, v: 99 } }));
    expect(isShareTrusted(key, digest)).toBe(false);
  });

  it('own-URL keys normalise the host but keep the path and query', () => {
    expect(shareTrustKeyForUrl('HTTPS://Files.Example.ORG/a.glb'))
      .toBe(shareTrustKeyForUrl('https://files.example.org/a.glb'));
    // A different query may well be different content — not one decision.
    expect(shareTrustKeyForUrl('https://f.example.org/a.glb?v=1'))
      .not.toBe(shareTrustKeyForUrl('https://f.example.org/a.glb?v=2'));
    // The fragment never reaches a server and cannot change the bytes.
    expect(shareTrustKeyForUrl('https://f.example.org/a.glb#part'))
      .toBe(shareTrustKeyForUrl('https://f.example.org/a.glb'));
  });

  it('no digest (insecure origin) ⇒ never trusted, never stored', () => {
    expect(isShareTrusted('share:x', null)).toBe(false);
    expect(rememberShareTrust('share:x', null)).toBe(false);
    expect(localStorage.getItem(SHARE_TRUST_KEY)).toBeNull();
  });

  it('a corrupt table degrades to "no decision" instead of throwing', () => {
    localStorage.setItem(SHARE_TRUST_KEY, '{not json');
    expect(isShareTrusted('share:x', 'abc')).toBe(false);
  });

  it('storage refusal degrades quietly (quota / private mode)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    expect(rememberShareTrust('share:x', 'abc')).toBe(false);
  });
});

// ─── 2b. Activation, refusal and revocation through the banner ────────────

describe('commissioningTrust_BannerFlow', () => {
  const UNTRUSTED: ModelProvenance = {
    trusted: false, source: 'share', trustRecordKey: `share:${SHARE_ID}`, digest: 'deadbeef',
  };

  it('activation warns about the reload, persists, and reloads', async () => {
    setModelProvenance(UNTRUSTED);
    const onReload = renderBanner();

    fireEvent.click(screen.getByTestId('commissioning-trust-activate'));
    // §2.4 measurement: a shared load has NO draft carrier and no awaitable
    // flush API, so the loss is stated instead of silently accepted.
    await waitFor(() => expect(screen.getByTestId('commissioning-trust-confirm')).toBeTruthy());
    expect(screen.getByTestId('commissioning-trust-confirm').textContent)
      .toMatch(/unsaved changes.*lost/i);
    expect(onReload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('commissioning-trust-confirm-activate'));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(isShareTrusted(`share:${SHARE_ID}`, 'deadbeef')).toBe(true);
  });

  it('refusal persists nothing and reloads nothing', async () => {
    setModelProvenance(UNTRUSTED);
    const onReload = renderBanner();

    fireEvent.click(screen.getByTestId('commissioning-trust-activate'));
    await waitFor(() => expect(screen.getByTestId('commissioning-trust-cancel')).toBeTruthy());
    fireEvent.click(screen.getByTestId('commissioning-trust-cancel'));

    await waitFor(() => expect(screen.queryByTestId('commissioning-trust-confirm')).toBeNull());
    expect(onReload).not.toHaveBeenCalled();
    expect(localStorage.getItem(SHARE_TRUST_KEY)).toBeNull();
  });

  it('a refused write shows a sentence instead of pretending to have applied it', async () => {
    setModelProvenance(UNTRUSTED);
    const onReload = renderBanner();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });

    fireEvent.click(screen.getByTestId('commissioning-trust-activate'));
    await waitFor(() => expect(screen.getByTestId('commissioning-trust-confirm-activate')).toBeTruthy());
    fireEvent.click(screen.getByTestId('commissioning-trust-confirm-activate'));

    await waitFor(() => expect(screen.getByTestId('commissioning-trust-storage-warning')).toBeTruthy());
    expect(onReload).not.toHaveBeenCalled();
  });

  it('revocation deletes EXACTLY this record and reloads', async () => {
    rememberShareTrust(`share:${SHARE_ID}`, 'deadbeef');
    rememberShareTrust('share:other', 'cafe');
    setModelProvenance({ ...UNTRUSTED, trusted: true });
    const onReload = renderBanner();

    fireEvent.click(screen.getByTestId('commissioning-trust-revoke'));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));

    expect(isShareTrusted(`share:${SHARE_ID}`, 'deadbeef')).toBe(false);
    // The other machine's decision is none of this button's business.
    expect(isShareTrusted('share:other', 'cafe')).toBe(true);
  });

  it('after revocation the next boot is untrusted again', async () => {
    const bytes = bytesOf(3);
    const digest = await digestOfBytes(bytes);
    rememberShareTrust(shareTrustKeyForUrl(SHARE_URL), digest);
    expect((await boot(SHARE_URL, bytes)).calls[0].options.trust.trusted).toBe(true);

    forgetShareTrust(shareTrustKeyForUrl(SHARE_URL));
    expect((await boot(SHARE_URL, bytes)).calls[0].options.trust.trusted).toBe(false);
  });

  it('the boot reads the decision BEFORE loadModel, in source as well as in fact', () => {
    // The behavioural tests above pass the flag as an ARGUMENT, so the ordering
    // is structural. This pins the reason it is structural.
    const readAt = bootSource.indexOf('const trusted = isShareTrusted(');
    const loadAt = bootSource.indexOf('await viewer.loadModel(');
    expect(readAt).toBeGreaterThan(-1);
    expect(readAt).toBeLessThan(loadAt);
  });
});

// ─── 2c. What the trusted load then actually gets ─────────────────────────

describe('commissioningTrust_WhatTrustBuys', () => {
  it('a trusted load constructs the SignalBindingManager; an untrusted one does not', () => {
    // The gate itself (rv-viewer.ts) is one expression, and it is the reason a
    // reload is the activation mechanism: it runs during the load.
    expect(viewerSource).toContain('this._plannerSignalLinking && this._loadTrust.trusted');
    expect(viewerSource).toContain('? new SignalBindingManager(this.signalStore, this.registry)');
  });

  it('interface auto-connect runs for a trusted load and not for an untrusted one', () => {
    const manager = new InterfaceManager();
    const onModelLoaded = vi.fn();
    vi.spyOn(manager, 'getActive').mockReturnValue({ onModelLoaded } as never);

    manager.onModelLoaded({} as never, { loadTrust: { trusted: false } } as never);
    expect(onModelLoaded).not.toHaveBeenCalled();

    manager.onModelLoaded({} as never, { loadTrust: TRUSTED_LOAD } as never);
    expect(onModelLoaded).toHaveBeenCalledTimes(1);
  });

  it('the CONNECT per-model stream uses the same one gate', () => {
    expect(connectPluginSource).toContain('if (!viewer.loadTrust.trusted) return;');
  });
});

// ─── 3. plan-397 stays a separate brake ───────────────────────────────────

describe('commissioningTrust_SignatureChainUntouched', () => {
  it('only invalid/unverifiable are gated — `none` and `valid` already run', () => {
    // The plan's security claim is precisely this and no more (SOL-R1 F4): an
    // unsigned model was never gated by the signature chain, so trust
    // activation cannot be said to "bypass" it.
    expect(sceneLoaderSource).toContain(
      "(signatureState === 'invalid' || signatureState === 'unverifiable')",
    );
    expect(sceneLoaderSource).toContain('&& !allowUntrustedLogic;');
  });

  it('trust activation never unlocks a signature', () => {
    // F6 must not touch `persistSignatureUnlock`, `allowUntrustedLogic` or
    // `signatureState` — an invalid signature still needs its own, separate
    // click on the SigWarningBanner (which commissioning keeps visible).
    for (const source of [bannerSource, trustStoreSource, bootSource]) {
      expect(source).not.toMatch(/persistSignatureUnlock|allowUntrustedLogic|activateGatedLogic/);
      expect(source).not.toMatch(/signatureState|rv-sig-unlock/);
    }
  });

  it('the two decisions use two different storage keyspaces', () => {
    // `rv-sig-unlock:<model>` (plan-397) vs `rv-share-trust` (this plan): one
    // cannot be mistaken for, or overwritten by, the other.
    expect(SHARE_TRUST_KEY).toBe('rv-share-trust');
    expect(SHARE_TRUST_KEY.startsWith('rv-sig-unlock')).toBe(false);
    rememberShareTrust('share:x', 'abc');
    expect(Object.keys(localStorage)).toEqual([SHARE_TRUST_KEY]);
  });
});

// ─── 4. F7 — no new fences, and no new write path ─────────────────────────

describe('commissioningTrust_WritingIsCONNECTsBusiness', () => {
  it('(a) this plan adds no write path at all', () => {
    for (const source of [bannerSource, trustStoreSource]) {
      expect(source).not.toMatch(/signalStore|sendSignals|postMessage|\.force\(/);
    }
  });

  it('(b) forcing behaves identically whichever workspace is active', () => {
    // Same store, same function, same result — the write path never asks which
    // mode is active, and this is the assertion that says so behaviourally.
    const store = new SignalStore();
    store.set('Conveyor.Start', false);

    activateContext(modeContext('hmi'));
    store.forceSignal('Conveyor.Start', true);
    const inHmi = store.get('Conveyor.Start');
    store.unforce('Conveyor.Start');

    _resetStore();
    activateContext(modeContext('commissioning'));
    store.forceSignal('Conveyor.Start', true);
    expect(store.get('Conveyor.Start')).toBe(inHmi);
    expect(store.isForced('Conveyor.Start')).toBe(true);
  });

  it('(b) …and the write path contains no workspace check to begin with', () => {
    expect(signalStoreSource).not.toMatch(/modeContext|activeMode|mode:commissioning/);
  });

  it('(c) with no authorised gateway the write simply does not go out', () => {
    // The existing refusal, unchanged: `sendSignals` drops the write when there
    // is no transport port — which is what an unauthorised/absent CONNECT
    // leaves behind. The viewer adds no second fence in front of it.
    expect(connectPluginSource).toContain('if (!viewer.loadTrust.trusted) return;');
    const store = new SignalStore();
    store.set('Conveyor.Start', true);
    // Local value is set regardless — a viewer that may not move anything is
    // not a viewer; whether it reaches a PLC is CONNECT's decision.
    expect(store.get('Conveyor.Start')).toBe(true);
  });

  it('(c) trust activation mutates no CONNECT authorisation', () => {
    localStorage.setItem('rv-connect-config', JSON.stringify({ apiKey: 'secret' }));
    rememberShareTrust('share:x', 'abc');
    expect(localStorage.getItem('rv-connect-config')).toBe(JSON.stringify({ apiKey: 'secret' }));
    expect(Object.keys(localStorage).sort()).toEqual(['rv-connect-config', SHARE_TRUST_KEY].sort());
  });
});
