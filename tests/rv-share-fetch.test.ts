// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.1 — fetching a shared GLB from a host we do not control.
 *
 * The theme running through every case: nothing the remote host says about the
 * transfer may be taken as a promise. Not the size it declares, not the number
 * of hops it takes, not the fact that it answered at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchSharedGlb,
  validateShareUrl,
  downloadSharedGlb,
  ShareFetchError,
} from '../src/core/share/rv-share-fetch';

/** A streamed Response — the shape a real GLB download has. */
function streamResponse(chunks: Uint8Array[], init?: ResponseInit & { url?: string }): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  const resp = new Response(body, init);
  if (init?.url) Object.defineProperty(resp, 'url', { value: init.url, configurable: true });
  return resp;
}

function chunk(bytes: number, fill = 7): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

/** Await a call that must reject with a classified share error. */
async function rejection(p: Promise<unknown>): Promise<ShareFetchError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ShareFetchError);
    return e as ShareFetchError;
  }
  throw new Error('expected the fetch to reject with a ShareFetchError');
}

const REMOTE = 'https://files.example.org/cell.glb';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rv-share-fetch — byte budget', () => {
  it('fetch_AbortsOverByteBudget: aborts over the limit even without Content-Length', async () => {
    // Four 1 KB chunks, no size header at all — the only way to know the
    // transfer is too big is to count what actually arrives.
    const fetchImpl = vi.fn(async () => streamResponse([
      chunk(1024), chunk(1024), chunk(1024), chunk(1024),
    ]));

    const err = await rejection(
      fetchSharedGlb(REMOTE, { byteBudget: 2048, fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(err.kind).toBe('too-large');
  });

  it('fetch_WrongContentLength_StillAborts: a lying header does not rescue an oversize file', async () => {
    // Declares 10 bytes, delivers 5 KB. If the budget trusted the header this
    // would sail through — which is exactly the hole the streamed check closes.
    const fetchImpl = vi.fn(async () => streamResponse(
      [chunk(5 * 1024)],
      { headers: { 'content-length': '10' } },
    ));

    const err = await rejection(
      fetchSharedGlb(REMOTE, { byteBudget: 1024, fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(err.kind).toBe('too-large');
  });

  it('fetch_FollowsRedirect_BudgetStillApplies: a redirect does not widen the budget', async () => {
    // The browser follows redirects transparently, so what reaches us is the
    // FINAL response — with a different `url`. The budget lives downstream of
    // every hop, so it applies unchanged.
    const fetchImpl = vi.fn(async () => streamResponse(
      [chunk(4096)],
      { url: 'https://cdn.elsewhere.example/redirected.glb' },
    ));

    const err = await rejection(
      fetchSharedGlb(REMOTE, { byteBudget: 1024, fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(err.kind).toBe('too-large');
  });

  it('keeps the post-redirect URL as the payload identity when the transfer succeeds', async () => {
    const fetchImpl = vi.fn(async () => streamResponse(
      [chunk(64)],
      { url: 'https://cdn.elsewhere.example/redirected.glb' },
    ));

    const payload = await fetchSharedGlb(REMOTE, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(payload.finalUrl).toBe('https://cdn.elsewhere.example/redirected.glb');
    expect(payload.bytes.byteLength).toBe(64);
  });
});

describe('rv-share-fetch — failure classification', () => {
  it('fetch_CorsFailure_ClassifiedMessage: a missing CORS header gets its own sentence', async () => {
    // A blocked cross-origin fetch rejects with a bare TypeError and no
    // response. Today that lands in the console as an opaque network error and
    // the viewport stays empty; F15 wants a sentence naming the actual cause.
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch'); });

    const err = await rejection(fetchSharedGlb(REMOTE, { fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(err.kind).toBe('cors');
    expect(err.message).toContain('files.example.org');
    expect(err.message).toContain('CORS');
  });

  it('fetch_Gone410_ShowsExpiredMessage: an expired link reads as an announcement, not a fault', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 410,
      headers: { 'x-rv-share-reason': 'expired' },
    }));

    const err = await rejection(fetchSharedGlb(REMOTE, { fetchImpl: fetchImpl as unknown as typeof fetch }));

    expect(err.kind).toBe('gone');
    expect(err.reason).toBe('expired');
    expect(err.message).toMatch(/expired/i);
  });

  it('reports 410 "deleted" distinctly, and stays neutral when the server gives no reason', async () => {
    const deleted = await rejection(fetchSharedGlb(REMOTE, {
      fetchImpl: (async () => new Response(JSON.stringify({ reason: 'deleted' }), {
        status: 410,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    }));
    expect(deleted.reason).toBe('deleted');
    expect(deleted.message).toMatch(/deleted/i);

    // No header, no body: we were not told why, so we do not claim to know.
    // "Expired" would be a small lie that costs a support ticket.
    const unknownReason = await rejection(fetchSharedGlb(REMOTE, {
      fetchImpl: (async () => new Response(null, { status: 410 })) as unknown as typeof fetch,
    }));
    expect(unknownReason.reason).toBeUndefined();
    expect(unknownReason.message).toMatch(/no longer available/i);
    expect(unknownReason.message).not.toMatch(/expired|deleted/i);
  });

  it('classifies an ordinary HTTP failure with its status', async () => {
    const err = await rejection(fetchSharedGlb(REMOTE, {
      fetchImpl: (async () => new Response(null, { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch,
    }));

    expect(err.kind).toBe('http');
    expect(err.status).toBe(404);
  });
});

describe('rv-share-fetch — URL validation', () => {
  it('fetch_RejectsNonHttpScheme: only http(s) reaches the network', async () => {
    // Whitelist, not blacklist. The parameter is attacker-controlled and a
    // blacklist would have to keep pace with every scheme a browser grows.
    const hostile = [
      'javascript:alert(1)',
      'data:model/gltf-binary;base64,AAAA',
      'file:///C:/secrets/plant.glb',
      'blob:https://web.realvirtual.io/1234',
      'not a url at all',
    ];

    for (const url of hostile) {
      expect(() => validateShareUrl(url)).toThrowError(ShareFetchError);
      const err = await rejection(fetchSharedGlb(url));
      expect(err.kind, url).toBe('invalid-url');
    }

    expect(validateShareUrl('https://files.example.org/a.glb').href)
      .toBe('https://files.example.org/a.glb');
    expect(validateShareUrl('http://localhost:8080/a.glb').protocol).toBe('http:');
  });

  it('never touches the network for a rejected scheme', async () => {
    const fetchImpl = vi.fn();
    await fetchSharedGlb('javascript:alert(1)', { fetchImpl: fetchImpl as unknown as typeof fetch })
      .catch(() => { /* expected */ });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('rv-share-fetch — buffer reuse', () => {
  it('fetch_BufferReusedForDownload: downloading costs no second request', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([chunk(2048)]));
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    // The anchor click would ask headless Chromium for a real download.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const payload = await fetchSharedGlb(REMOTE, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(payload.bytes.byteLength).toBe(2048);

    downloadSharedGlb(payload, 'Pick & Place Cell');

    // One transfer for the whole session: parse, card and download all read
    // the same buffer (F14/F16).
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('appends the .glb extension only when the name lacks one', () => {
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(this.download);
    });
    const payload = { bytes: new ArrayBuffer(8), finalUrl: REMOTE, contentType: null };

    downloadSharedGlb(payload, 'Cell');
    downloadSharedGlb(payload, 'Cell.glb');

    expect(clicks).toEqual(['Cell.glb', 'Cell.glb']);
  });
});
