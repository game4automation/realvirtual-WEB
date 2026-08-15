// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.3 — upload, sign-in, retention and inventory control.
 *
 * Every case runs against `ShareBackendStub`, which implements the contract in
 * `src/core/share/rv-share-backend-contract.md` for real: ownership, the
 * single-use signed URL, the size/hash binding, idempotency, orphan sweeping,
 * `410` with a reason. That matters most for the security cases — "a foreign
 * account cannot delete my share" is only worth asserting if the thing refusing
 * is a server rather than an `if` in the client that an attacker never runs.
 *
 * The backend itself lives in another repo (R1). The stub is what keeps this
 * client and that server describing the same protocol; when they diverge, these
 * tests are where it shows.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

import sessionSource from '../src/core/share/rv-share-session.ts?raw';
import uploadSource from '../src/core/share/rv-share-upload.ts?raw';
import dialogSource from '../src/core/share/ShareDialog.tsx?raw';
import panelSource from '../src/core/share/MySharesPanel.tsx?raw';

import {
  SHARE_TERMS_VERSION,
  SHARE_SESSION_KEY,
  SHARE_DRAFT_KEY,
  ShareApiError,
  clearShareDraft,
  clearShareSession,
  configureShareApi,
  consumeMagicLinkFromUrl,
  exchangeMagicLinkToken,
  getShareSession,
  loadShareDraft,
  requestMagicLink,
  resetShareSessionCache,
  saveShareDraft,
  setShareSession,
  shareApiRequest,
  type MagicLinkSession,
  type ShareTermsAcceptance,
} from '../src/core/share/rv-share-session';
import {
  deleteShare,
  installShareIdResolver,
  listMyShares,
  resolveShareDownloadUrl,
  sha256Hex,
  uploadSharedGlb,
} from '../src/core/share/rv-share-upload';
import { buildShareViewerLink, parseGlbParam } from '../src/core/share/rv-share-target';
import { ShareFetchError } from '../src/core/share/rv-share-fetch';
import { buildSharedGlbInfo } from '../src/core/share/rv-share-meta';
import { ShareDialog } from '../src/core/share/ShareDialog';
import { SharedGlbInfoCardHost } from '../src/core/share/share-plugin';
import { setSharedGlb, clearSharedGlb } from '../src/core/share/rv-share-store';
import { ShareBackendStub } from './helpers/rv-share-backend-stub';

const LINK_BASE = 'https://web.realvirtual.test/';

const TERMS: ShareTermsAcceptance = {
  version: SHARE_TERMS_VERSION,
  acceptedAt: '2026-08-08T09:00:00.000Z',
};

const META = { v: 1 as const, name: 'Pick & Place Cell', author: 'Thomas Strigl', level: 'assembly' as const };

function glbBytes(size = 2048, fill = 7): ArrayBuffer {
  const a = new Uint8Array(size);
  a.fill(fill);
  return a.buffer;
}

let stub: ShareBackendStub;
let restoreApi: () => void;

function useStub(opts?: ConstructorParameters<typeof ShareBackendStub>[0]): ShareBackendStub {
  restoreApi?.();
  stub = new ShareBackendStub(opts);
  restoreApi = configureShareApi({ baseUrl: stub.apiBase, fetchImpl: stub.fetch });
  return stub;
}

/** Sign in through the stub and install the session the way the app would. */
function signedIn(email = 'thomas@realvirtual.test'): MagicLinkSession {
  const session = stub.signIn(email);
  setShareSession(session);
  return session;
}

beforeEach(() => {
  localStorage.removeItem(SHARE_SESSION_KEY);
  localStorage.removeItem(SHARE_DRAFT_KEY);
  resetShareSessionCache();
  clearSharedGlb();
  useStub();
});

afterEach(() => {
  cleanup();
  clearShareSession();
  clearShareDraft();
  resetShareSessionCache();
  restoreApi?.();
});

// ─── Gates that run before anything is transferred ─────────────────────────

describe('plan-386 §9.3 — gates', () => {
  it('upload_RequiresLogin', async () => {
    const err = await uploadSharedGlb(glbBytes(), META, {
      session: null as unknown as MagicLinkSession,
      terms: TERMS,
    }).catch(e => e);

    expect(err).toBeInstanceOf(ShareApiError);
    expect((err as ShareApiError).code).toBe('unauthenticated');
    // The gate is BEFORE the upload, not a rejection after it: nothing at all
    // reached the network, so no bytes were paid for and no record exists.
    expect(stub.requests).toHaveLength(0);
  });

  it('upload_RequiresTermsAcceptance', async () => {
    const session = signedIn();

    const err = await uploadSharedGlb(glbBytes(), META, {
      session,
      terms: undefined as unknown as ShareTermsAcceptance,
    }).catch(e => e);
    expect((err as ShareApiError).code).toBe('terms-required');
    expect(stub.requests).toHaveLength(0);

    // An acceptance of a *previous* version is not an acceptance.
    const stale = await uploadSharedGlb(glbBytes(), META, {
      session,
      terms: { version: '1999-01-01', acceptedAt: TERMS.acceptedAt },
    }).catch(e => e);
    expect((stale as ShareApiError).code).toBe('terms-required');

    // With consent it goes through — and the server records WHEN and WHICH,
    // which is the whole point of F9c.
    const result = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS });
    expect(stub.termsOf(result.id)).toEqual(TERMS);

    const create = stub.requests.find(r => r.method === 'POST' && r.url.endsWith('/uploads'));
    expect(JSON.parse(create!.body!).terms).toEqual(TERMS);
  });

  it('upload_ExpiredOrReplayedSession_Rejected', async () => {
    // (a) locally expired — refused without asking anyone.
    const expired: MagicLinkSession = {
      token: 'stale', email: 'x@y.test', expiresAt: '2020-01-01T00:00:00.000Z',
    };
    const local = await uploadSharedGlb(glbBytes(), META, { session: expired, terms: TERMS }).catch(e => e);
    expect((local as ShareApiError).code).toBe('unauthenticated');
    expect(stub.requests).toHaveLength(0);

    // (b) revoked server-side — 401, and the dead token is dropped so the UI
    // stops claiming the user is signed in.
    const session = signedIn();
    stub.revokeSession(session.token);
    const remote = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS }).catch(e => e);
    expect((remote as ShareApiError).code).toBe('unauthenticated');
    expect(getShareSession()).toBeNull();

    // (c) a replayed magic-link token is refused the second time.
    await requestMagicLink('replay@realvirtual.test');
    const token = stub.lastMagicToken('replay@realvirtual.test')!;
    await exchangeMagicLinkToken(token);
    const replay = await exchangeMagicLinkToken(token).catch(e => e);
    expect((replay as ShareApiError).code).toBe('unauthenticated');
  });
});

// ─── The state machine ─────────────────────────────────────────────────────

describe('plan-386 §9.3 — upload state machine', () => {
  it('upload_PutsBytesDirectlyToSignedUrl', async () => {
    const session = signedIn();
    await uploadSharedGlb(glbBytes(4096), META, { session, terms: TERMS });

    const binary = stub.binaryRequests();
    expect(binary).toHaveLength(1);
    expect(binary[0]!.method).toBe('PUT');
    expect(binary[0]!.url.startsWith(stub.storageBase)).toBe(true);
    // No byte ever went to the API host …
    expect(binary.every(r => !r.url.startsWith(stub.apiBase))).toBe(true);
    // … and our session token was never handed to the storage provider.
    expect(binary[0]!.authorized).toBe(false);
    expect(JSON.stringify(binary[0]!.headers)).not.toContain(session.token);
  });

  it('upload_ConfirmBeforePut_Rejected', async () => {
    const session = signedIn();
    const inner = stub.fetch;
    const restore = configureShareApi({
      // Swallow the PUT: the server never sees bytes, so the confirm arrives
      // for a record that is still `created`.
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.startsWith(stub.storageBase)) return new Response(null, { status: 200 });
        return inner(input, init);
      },
    });

    const err = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS }).catch(e => e);
    restore();

    expect((err as ShareApiError).code).toBe('not-uploaded');
    expect(await listMyShares(session)).toHaveLength(0);
    expect(stub.confirmedCount()).toBe(0);
  });

  it('upload_TamperedBytes_RejectedByHash', async () => {
    const session = signedIn();
    const inner = stub.fetch;
    const restore = configureShareApi({
      // Put *other* bytes than the ones whose hash was announced.
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.startsWith(stub.storageBase) && (init?.method ?? 'GET') === 'PUT') {
          return inner(input, { ...init, body: glbBytes(2048, 99) });
        }
        return inner(input, init);
      },
    });

    const err = await uploadSharedGlb(glbBytes(2048, 7), META, { session, terms: TERMS }).catch(e => e);
    restore();

    expect((err as ShareApiError).code).toBe('hash-mismatch');
    expect(await listMyShares(session)).toHaveLength(0);
  });

  it('upload_CrossOwnerConfirmOrDelete_403', async () => {
    const alice = signedIn('alice@realvirtual.test');
    const share = await uploadSharedGlb(glbBytes(), META, { session: alice, terms: TERMS });

    const bob = stub.signIn('bob@realvirtual.test');

    // Bob may not delete Alice's share …
    const del = await deleteShare(bob, share.id).catch(e => e);
    expect((del as ShareApiError).code).toBe('forbidden');

    // … nor confirm one of her uploads.
    setShareSession(alice);
    const created = await shareApiRequest<{ id: string; uploadUrl: string }>({
      method: 'POST', path: '/uploads', session: alice,
      body: {
        filename: 'x.glb', contentType: 'model/gltf-binary', size: 16,
        sha256: await sha256Hex(glbBytes(16)), expiry: 'never', allowDownload: true, terms: TERMS,
      },
    });
    await stub.fetch(created.uploadUrl, { method: 'PUT', body: glbBytes(16) });

    const confirm = await shareApiRequest({
      method: 'POST', path: `/uploads/${created.id}/confirm`, session: bob,
      headers: { 'Idempotency-Key': 'k' }, body: { sha256: await sha256Hex(glbBytes(16)), size: 16 },
    }).catch(e => e);
    expect((confirm as ShareApiError).code).toBe('forbidden');

    // Alice's own share is untouched by any of it.
    expect(await listMyShares(alice)).toHaveLength(1);
  });

  it('upload_SignedUrlNotReusable', async () => {
    const session = signedIn();
    await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS });

    const put = stub.requests.find(r => r.method === 'PUT')!;
    const second = await stub.fetch(put.url, { method: 'PUT', body: glbBytes() });
    expect(second.status).toBe(403);
  });

  it('upload_ConfirmIsIdempotent', async () => {
    const session = signedIn();
    const bytes = glbBytes(1024);
    const key = 'fixed-idempotency-key';

    const first = await uploadSharedGlb(bytes, META, { session, terms: TERMS, idempotencyKey: key });

    // The retry a flaky network would produce: same key, same answer, no second share.
    const repeat = await shareApiRequest<{ id: string; url: string }>({
      method: 'POST', path: `/uploads/${first.id}/confirm`, session,
      headers: { 'Idempotency-Key': key },
      body: { sha256: await sha256Hex(bytes), size: bytes.byteLength },
    });

    expect(repeat.id).toBe(first.id);
    expect(repeat.url).toBe(first.url);
    expect(stub.confirmedCount()).toBe(1);
    expect(await listMyShares(session)).toHaveLength(1);
  });

  it('upload_OrphanCleanedUp', async () => {
    const session = signedIn();
    const inner = stub.fetch;
    // Confirm fails AND the client's polite cleanup fails too — the record is
    // left exactly as a crashed browser would leave it, which is what the
    // server-side sweep exists for.
    const restore = configureShareApi({
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.includes('/confirm')) throw new TypeError('connection lost');
        if (method === 'DELETE' && url.includes('/uploads/')) throw new TypeError('connection lost');
        return inner(input, init);
      },
    });

    const err = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS }).catch(e => e);
    restore();
    expect((err as ShareApiError).code).toBe('network');

    // Before the sweep it already exists in storage — and is still unreachable
    // through a link, because only `confirmed` is ever served.
    const id = stub.lastCreatedId()!;
    expect(stub.stateOf(id)).toBe('uploaded');
    await expect(resolveShareDownloadUrl(id)).rejects.toBeInstanceOf(ShareFetchError);
    expect(await listMyShares(session)).toHaveLength(0);

    // The sweep removes it for good.
    expect(stub.runOrphanCleanup(Date.now() + 120_000)).toContain(id);
    expect(stub.stateOf(id)).toBe('absent');
  });

  it('upload_FailureLeavesNoHalfState', async () => {
    const session = signedIn();
    const inner = stub.fetch;
    const restore = configureShareApi({
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : String(input);
        if (url.includes('/confirm')) throw new TypeError('connection lost');
        return inner(input, init);
      },
    });

    const err = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS }).catch(e => e);
    restore();

    expect(err).toBeInstanceOf(ShareApiError);
    // No link, and nothing in "my shared links" a sender could not explain.
    expect(await listMyShares(session)).toHaveLength(0);
    expect(stub.confirmedCount()).toBe(0);
  });
});

// ─── Retention, opacity and the receiver's download switch ─────────────────

describe('plan-386 §9.3 — retention and opacity', () => {
  it('upload_DefaultExpiry_IsNever', async () => {
    const session = signedIn();
    const result = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS });

    expect(result.expiresAt).toBeUndefined();
    const create = stub.requests.find(r => r.method === 'POST' && r.url.endsWith('/uploads'))!;
    expect(JSON.parse(create.body!).expiry).toBe('never');

    const listed = await listMyShares(session);
    expect(listed[0]!.expiresAt).toBeUndefined();
  });

  it('upload_ChosenExpiry_SetsExpiresAt', async () => {
    const session = signedIn();
    const result = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS, expiry: '30d' });

    expect(result.expiresAt).toBeTruthy();
    const days = (Date.parse(result.expiresAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('share_OpaqueId_DoesNotLeakStorageUrl', async () => {
    const session = signedIn();
    const result = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS });

    const link = buildShareViewerLink(result.id, { base: LINK_BASE });

    // What gets forwarded is a viewer link. The storage address the upload
    // returned appears nowhere in it — not the URL, not the host.
    expect(link).toContain('glb=s%3A');
    expect(link).not.toContain(result.url);
    expect(link).not.toContain('storage.example.test');
    expect(parseGlbParam(new URL(link).searchParams.get('glb')!))
      .toEqual({ kind: 'opaque', id: result.id });

    // And the opaque form still resolves to something loadable.
    const restore = installShareIdResolver();
    try {
      expect(await resolveShareDownloadUrl(result.id)).toContain(stub.storageBase);
    } finally {
      restore();
    }
  });

  it('upload_NoCredentialsInClient', () => {
    const sources = [sessionSource, uploadSource, dialogSource, panelSource].join('\n');
    // Anything that would let this bundle talk to storage on its own account
    // rather than on the one the server signed for.
    for (const pattern of [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /\bAKIA[0-9A-Z]{16}\b/,
      /"type"\s*:\s*"service_account"/,
      /\bclient_secret\b/i,
      /\bprivateKey\s*[:=]\s*['"][^'"]+['"]/i,
      /\b(?:apiKey|accessKey|secretKey)\s*[:=]\s*['"][A-Za-z0-9_\-]{12,}['"]/i,
    ]) {
      expect(sources).not.toMatch(pattern);
    }
    // The only secret this client ever holds is the session the server minted,
    // and the one request that leaves our own API must not carry it: the PUT
    // goes to a third-party storage host. Guard the function, not a comment.
    const putBlock = uploadSource
      .slice(
        uploadSource.indexOf('async function putBytes'),
        uploadSource.indexOf('async function abandonUpload'),
      )
      .replace(/\/\/.*$/gm, '');            // the prose may say "Authorization"; the code may not
    expect(putBlock.length).toBeGreaterThan(100);
    expect(putBlock).not.toMatch(/Authorization|session\.token|Bearer/);
  });

  it('share_DownloadDisabled_HidesButton', async () => {
    const session = signedIn();
    const bytes = glbBytes();
    await uploadSharedGlb(bytes, META, { session, terms: TERMS, allowDownload: false });

    // The switch travels in the metadata; the receiver's card obeys it.
    const create = stub.requests.find(r => r.method === 'POST' && r.url.endsWith('/uploads'))!;
    const sentMeta = JSON.parse(create.body!).meta;
    expect(sentMeta.allowDownload).toBe(false);

    const payload = { bytes, finalUrl: 'https://files.example.test/x.glb', contentType: null };
    setSharedGlb(
      buildSharedGlbInfo({ url: payload.finalUrl, userData: { rv_share: { ...sentMeta, v: 1 } } }),
      payload,
    );
    render(createElement(SharedGlbInfoCardHost));
    expect(screen.queryByTestId('shared-glb-download')).toBeNull();

    // Sanity: with the switch on, the button is there — otherwise this test
    // would pass for the wrong reason forever.
    cleanup();
    setSharedGlb(
      buildSharedGlbInfo({ url: payload.finalUrl, userData: { rv_share: { ...sentMeta, v: 1, allowDownload: true } } }),
      payload,
    );
    render(createElement(SharedGlbInfoCardHost));
    expect(screen.getByTestId('shared-glb-download')).toBeTruthy();
  });

  it('upload_OversizeRejectedWithMessage', async () => {
    useStub({ maxFileBytes: 1024 });
    const session = signedIn();

    const err = await uploadSharedGlb(glbBytes(4096), META, { session, terms: TERMS }).catch(e => e);
    expect((err as ShareApiError).code).toBe('too-large');
    expect((err as ShareApiError).message).toMatch(/larger than/i);
    // Refused at `create`, so the oversized body was never transferred.
    expect(stub.binaryRequests()).toHaveLength(0);
  });

  it('upload_QuotaExceeded_Message', async () => {
    useStub({ quotaBytes: 3000 });
    const session = signedIn();

    await uploadSharedGlb(glbBytes(2048), META, { session, terms: TERMS });
    const err = await uploadSharedGlb(glbBytes(2048), META, { session, terms: TERMS }).catch(e => e);

    expect((err as ShareApiError).code).toBe('quota-exceeded');
    expect((err as ShareApiError).message).toMatch(/quota/i);
  });
});

// ─── Inventory (F11) ───────────────────────────────────────────────────────

describe('plan-386 §9.3 — my shared links', () => {
  it('myShares_ListsOnlyOwnUploads', async () => {
    const alice = signedIn('alice@realvirtual.test');
    await uploadSharedGlb(glbBytes(64), { ...META, name: 'Alice A' }, { session: alice, terms: TERMS });
    await uploadSharedGlb(glbBytes(128), { ...META, name: 'Alice B' }, { session: alice, terms: TERMS });

    const bob = stub.signIn('bob@realvirtual.test');
    setShareSession(bob);
    const bobShare = await uploadSharedGlb(glbBytes(256), { ...META, name: 'Bob' }, { session: bob, terms: TERMS });

    setShareSession(alice);
    const mine = await listMyShares(alice);
    expect(mine).toHaveLength(2);
    expect(mine.map(e => e.id)).not.toContain(bobShare.id);
    expect(mine.map(e => e.name).sort()).toEqual(['Alice A', 'Alice B']);
  });

  it('myShares_DeleteRemovesAndReturns410', async () => {
    const session = signedIn();
    const share = await uploadSharedGlb(glbBytes(), META, { session, terms: TERMS });
    expect(await resolveShareDownloadUrl(share.id)).toBeTruthy();

    await deleteShare(session, share.id);

    expect(await listMyShares(session)).toHaveLength(0);
    const err = await resolveShareDownloadUrl(share.id).catch(e => e);
    expect(err).toBeInstanceOf(ShareFetchError);
    expect((err as ShareFetchError).kind).toBe('gone');
    expect((err as ShareFetchError).status).toBe(410);
    // The reason distinguishes "the owner deleted it" from "it expired" (F10a).
    expect((err as ShareFetchError).reason).toBe('deleted');
    expect((err as ShareFetchError).message).toMatch(/deleted by its owner/i);
  });

  it('myShares_Panel_DeletesImmediately', async () => {
    const session = signedIn();
    const share = await uploadSharedGlb(glbBytes(4096), { ...META, name: 'Portal axis' },
      { session, terms: TERMS });

    const { MySharesPanel } = await import('../src/core/share/MySharesPanel');
    render(createElement(MySharesPanel, { session }));

    await screen.findByTestId(`my-share-${share.id}`);
    fireEvent.click(screen.getByTestId(`my-share-delete-${share.id}`));

    await waitFor(() => expect(screen.queryByTestId(`my-share-${share.id}`)).toBeNull());
    expect(await listMyShares(session)).toHaveLength(0);
  });
});

// ─── The dialog: round trip, own URL, consent gate ─────────────────────────

describe('plan-386 §9.3 — dialog and magic link', () => {
  it('magicLink_SessionSurvivesMailRoundTrip', async () => {
    const email = 'roundtrip@realvirtual.test';

    // The sender fills the dialog and asks for a mail. The form is written down
    // BEFORE he leaves — that is the whole trick.
    saveShareDraft({
      name: 'Pick & Place Cell',
      author: 'Thomas Strigl',
      license: 'CC-BY-4.0',
      target: 'upload',
      expiry: '30d',
      allowDownload: false,
      terms: TERMS,
    });
    await requestMagicLink(email);
    const token = stub.lastMagicToken(email)!;

    // He leaves the page: nothing in memory survives.
    resetShareSessionCache();
    expect(getShareSession()).toBeNull();

    // He comes back through the mail link.
    const session = await consumeMagicLinkFromUrl(
      `https://web.realvirtual.test/?glb=x&sharetoken=${token}`,
    );
    expect(session?.email).toBe(email);
    expect(getShareSession()?.token).toBe(session?.token);

    // …and the dialog is exactly as he left it, consent included.
    const draft = loadShareDraft();
    expect(draft).toMatchObject({
      name: 'Pick & Place Cell',
      author: 'Thomas Strigl',
      license: 'CC-BY-4.0',
      expiry: '30d',
      allowDownload: false,
      terms: TERMS,
    });

    // The restored dialog shows it, and shares without asking again.
    render(createElement(ShareDialog, {
      open: true, onClose: () => {}, getBytes: () => glbBytes(), linkBase: LINK_BASE,
    }));
    await waitFor(() => {
      expect((screen.getByTestId('share-name') as HTMLInputElement).value).toBe('Pick & Place Cell');
    });
    expect((screen.getByTestId('share-terms') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('share-identity').textContent).toContain(email);

    fireEvent.click(screen.getByTestId('share-submit'));
    const link = await screen.findByTestId('share-link');
    expect((link as HTMLInputElement).value).toContain('glb=s%3A');
  });

  it('magicLink_ChangedTermsAreAskedAgain', () => {
    saveShareDraft({
      name: 'x', target: 'upload', expiry: 'never', allowDownload: true,
      terms: { version: 'older-text', acceptedAt: TERMS.acceptedAt },
    });
    const draft = loadShareDraft();
    // Everything he typed survives; consent to a text that has since changed
    // does not (F9c).
    expect(draft?.name).toBe('x');
    expect(draft?.terms).toBeUndefined();
  });

  it('shareDialog_TermsGateDisablesShare', async () => {
    signedIn();
    render(createElement(ShareDialog, {
      open: true, onClose: () => {}, getBytes: () => glbBytes(), linkBase: LINK_BASE,
    }));

    // The warning is above the box, and the button is dead until it is ticked.
    const warning = screen.getByTestId('share-nda-warning').textContent ?? '';
    expect(warning).toMatch(/unlisted/);
    // "unlisted" is the word for what this is; the only permitted appearance of
    // "private" is the denial itself, never a description of the share.
    expect(warning.replace(/not private/gi, '')).not.toMatch(/private/i);
    expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId('share-terms'));
    expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(false);

    // Default expiry is "never" and downloads are allowed unless switched off.
    expect((screen.getByTestId('share-expiry-never') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('share-allow-download') as HTMLInputElement).checked).toBe(true);
  });

  it('shareDialog_UnauthenticatedShowsSignInBeforeUpload', async () => {
    render(createElement(ShareDialog, {
      open: true, onClose: () => {}, getBytes: () => glbBytes(), linkBase: LINK_BASE,
    }));

    fireEvent.click(screen.getByTestId('share-terms'));
    fireEvent.click(screen.getByTestId('share-submit'));

    await screen.findByTestId('share-email');
    // Not one byte was offered before the sign-in step (F9).
    expect(stub.requests).toHaveLength(0);
    // And the form was saved so the round trip returns to a filled dialog.
    expect(loadShareDraft()?.terms?.version).toBe(SHARE_TERMS_VERSION);
  });

  it('ownUrl_SkipsUploadEntirely', async () => {
    render(createElement(ShareDialog, {
      open: true, onClose: () => {}, getBytes: () => glbBytes(), linkBase: LINK_BASE,
    }));

    fireEvent.click(screen.getByTestId('share-target-own'));
    fireEvent.change(screen.getByTestId('share-own-url'), {
      target: { value: 'https://raw.githubusercontent.test/me/repo/main/cell.glb' },
    });

    // No login, no consent box, no expiry choice — we host nothing, so there is
    // nothing to attribute, delete or expire (Finding 14).
    expect(screen.queryByTestId('share-terms')).toBeNull();
    expect(screen.queryByTestId('share-expiry-never')).toBeNull();
    expect((screen.getByTestId('share-submit') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('share-submit'));

    const link = await screen.findByTestId('share-link');
    // `&mode=viewer` since plan-423 F5: the dialog now always states which
    // workspace the RECIPIENT should land in, and "View only" is its default.
    // Without it the receiver used to land in whatever workspace his own
    // localStorage last remembered. The rest of the link is unchanged, which is
    // why this assertion stays an exact match.
    expect((link as HTMLInputElement).value)
      .toBe(`${LINK_BASE}?glb=${encodeURIComponent('https://raw.githubusercontent.test/me/repo/main/cell.glb')}&mode=viewer`);
    expect(getShareSession()).toBeNull();
    expect(stub.requests).toHaveLength(0);
    expect(screen.queryByTestId('share-expires')).toBeNull();
  });
});
