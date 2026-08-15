// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Fetching a shared GLB from a host we do not control (plan-386 §2.8).
 *
 * Three things make this different from `downloadGlb()`, which serves our own
 * deploy:
 *
 * 1. **The URL is attacker-controlled.** It arrives in a query parameter, so
 *    the scheme is validated before anything touches the network — `data:`,
 *    `blob:`, `file:` and `javascript:` are refused outright (F15/§9.1
 *    `fetch_RejectsNonHttpScheme`).
 * 2. **The size is unknown and unverifiable.** `Content-Length` is a *hint*: it
 *    is absent under chunked transfer, wrong behind a rewriting proxy, and can
 *    simply lie. The budget is therefore enforced on the streamed body, byte by
 *    byte, and a redirect changes nothing about it (F16/R9).
 * 3. **Failure needs a sentence, not a stack.** A missing CORS header currently
 *    surfaces as an opaque `TypeError` and an empty viewport. Every failure
 *    here is classified so the card can say what happened (F15).
 *
 * The buffer is fetched **once** and handed back to the caller, which reuses it
 * for parsing, for the info card and for the download button — no second
 * network round trip for "download this GLB" (F14/§9.1
 * `fetch_BufferReusedForDownload`).
 */

/** 250 MB. Generous for a plant model, far below "blocks the tab". */
export const DEFAULT_SHARE_BYTE_BUDGET = 250 * 1024 * 1024;

/** What went wrong, in terms a user-facing message can be built from. */
export type ShareFetchErrorKind =
  /** Not an absolute http(s) URL. */
  | 'invalid-url'
  /** Network-level rejection with no response — in practice almost always CORS. */
  | 'cors'
  /** The link is gone: expired or deleted (HTTP 410). */
  | 'gone'
  /** Any other non-2xx response. */
  | 'http'
  /** Byte budget exceeded — the transfer was aborted mid-stream. */
  | 'too-large'
  /** Caller-supplied signal aborted the transfer. */
  | 'aborted'
  /** Anything else. */
  | 'network';

/**
 * Why a `410` came back, when the server said (F10a).
 *
 * `undefined` means the server gave no reason — and then the viewer says
 * "no longer available" rather than inventing "expired". Claiming a cause we
 * were not told is exactly the kind of small lie that erodes trust in an
 * error message.
 */
export type ShareGoneReason = 'expired' | 'deleted' | undefined;

export class ShareFetchError extends Error {
  readonly kind: ShareFetchErrorKind;
  readonly status?: number;
  readonly reason?: ShareGoneReason;

  constructor(kind: ShareFetchErrorKind, message: string, opts?: {
    status?: number;
    reason?: ShareGoneReason;
    cause?: unknown;
  }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ShareFetchError';
    this.kind = kind;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.reason !== undefined) this.reason = opts.reason;
  }
}

/**
 * Validate a shared-link target.
 *
 * Whitelist, not blacklist: only `http:` and `https:` pass. A blacklist would
 * have to enumerate every scheme a browser might grow.
 */
export function validateShareUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ShareFetchError('invalid-url', `Not a valid link: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new ShareFetchError(
      'invalid-url',
      `Only http(s) links can be shared — "${u.protocol}" is not allowed.`,
    );
  }
  return u;
}

export interface SharedGlbPayload {
  /** The bytes. Fetched once, reused for parse, card and download (F14). */
  bytes: ArrayBuffer;
  /** URL after redirects where the platform exposes it, else the request URL. */
  finalUrl: string;
  contentType: string | null;
}

export interface FetchSharedGlbOptions {
  /** Hard ceiling on transferred bytes. Defaults to {@link DEFAULT_SHARE_BYTE_BUDGET}. */
  byteBudget?: number;
  /** Caller cancellation (page navigation, user cancel). */
  signal?: AbortSignal;
  /** Progress in bytes received so far; total is deliberately not promised. */
  onProgress?: (received: number) => void;
  /** Injectable for tests. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/** Header carrying the `410` reason code; also accepted as a JSON body field. */
const GONE_REASON_HEADER = 'x-rv-share-reason';

function goneReasonOf(value: string | null | undefined): ShareGoneReason {
  const v = value?.trim().toLowerCase();
  if (v === 'expired' || v === 'deleted') return v;
  return undefined;
}

/**
 * Stream a shared GLB into one buffer, enforcing the byte budget as it goes.
 *
 * The budget is checked against the running sum of *received* chunk lengths.
 * `Content-Length` is consulted only to fail fast on an honest oversize
 * declaration — it can never make an over-budget transfer succeed
 * (§9.1 `fetch_WrongContentLength_StillAborts`), and a redirect cannot slip
 * past it either because the check lives downstream of every hop
 * (`fetch_FollowsRedirect_BudgetStillApplies`).
 */
export async function fetchSharedGlb(
  url: string,
  options?: FetchSharedGlbOptions,
): Promise<SharedGlbPayload> {
  const target = validateShareUrl(url);
  const budget = options?.byteBudget ?? DEFAULT_SHARE_BYTE_BUDGET;
  const doFetch = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);

  // Own controller so the budget can cut the stream even when the caller
  // passed no signal; the caller's signal is chained onto it.
  const controller = new AbortController();
  const external = options?.signal;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  let resp: Response;
  try {
    resp = await doFetch(target.href, { signal: controller.signal, cache: 'no-store' });
  } catch (e) {
    if (external?.aborted) {
      throw new ShareFetchError('aborted', 'Loading was cancelled.', { cause: e });
    }
    // A rejected fetch with no response is the CORS shape: the browser refuses
    // to let us see whether the server answered at all. Same-origin failures
    // are genuine network errors, so the message differs by origin.
    const sameOrigin = typeof location !== 'undefined' && target.origin === location.origin;
    throw sameOrigin
      ? new ShareFetchError('network', `The shared file could not be loaded from ${target.host}.`, { cause: e })
      : new ShareFetchError(
          'cors',
          `${target.host} did not allow this page to read the file (CORS). `
          + 'The host must send an Access-Control-Allow-Origin header.',
          { cause: e },
        );
  } finally {
    external?.removeEventListener('abort', onExternalAbort);
  }

  if (resp.status === 410) {
    let reason = goneReasonOf(resp.headers.get(GONE_REASON_HEADER));
    if (!reason) {
      // Second source: some gateways answer with a small JSON body instead of
      // a custom header. Never fatal — an unreadable body just means no reason.
      try {
        const body = await resp.clone().json() as { reason?: unknown };
        reason = goneReasonOf(typeof body?.reason === 'string' ? body.reason : null);
      } catch { /* no reason available */ }
    }
    throw new ShareFetchError('gone', goneMessage(reason), { status: 410, reason });
  }

  if (!resp.ok) {
    throw new ShareFetchError(
      'http',
      `${target.host} answered ${resp.status}${resp.statusText ? ` ${resp.statusText}` : ''}.`,
      { status: resp.status },
    );
  }

  const declared = Number(resp.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > budget) {
    controller.abort();
    throw new ShareFetchError('too-large', tooLargeMessage(budget), { status: resp.status });
  }

  const bytes = await readWithBudget(resp, budget, controller, options?.onProgress);

  return {
    bytes,
    finalUrl: resp.url || target.href,
    contentType: resp.headers.get('content-type'),
  };
}

async function readWithBudget(
  resp: Response,
  budget: number,
  controller: AbortController,
  onProgress?: (received: number) => void,
): Promise<ArrayBuffer> {
  // No stream available (some mocks, some very old environments): fall back to
  // arrayBuffer() and check afterwards. Weaker — the bytes are already in
  // memory — but never weaker than not checking at all.
  if (!resp.body) {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > budget) throw new ShareFetchError('too-large', tooLargeMessage(budget));
    onProgress?.(buf.byteLength);
    return buf;
  }

  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > budget) {
        // Cut the transfer instead of draining it — the point of the budget is
        // to stop paying for the bytes, not to measure them after the fact.
        controller.abort();
        await reader.cancel().catch(() => { /* already torn down */ });
        throw new ShareFetchError('too-large', tooLargeMessage(budget));
      }
      chunks.push(value);
      onProgress?.(received);
    }
  } catch (e) {
    if (e instanceof ShareFetchError) throw e;
    if (controller.signal.aborted) {
      throw new ShareFetchError('aborted', 'Loading was cancelled.', { cause: e });
    }
    throw new ShareFetchError('network', 'The transfer failed before the file was complete.', { cause: e });
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out.buffer;
}

function tooLargeMessage(budget: number): string {
  return `The shared file is larger than the ${Math.round(budget / (1024 * 1024))} MB limit and was not loaded.`;
}

function goneMessage(reason: ShareGoneReason): string {
  if (reason === 'expired') return 'This shared link has expired.';
  if (reason === 'deleted') return 'This shared link was deleted by its owner.';
  return 'This shared link is no longer available.';
}

/** User-facing sentence for any failure of this module. */
export function describeShareFetchError(e: unknown): string {
  if (e instanceof ShareFetchError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Hand the already-downloaded bytes to the browser as a file (F14).
 *
 * Deliberately takes the payload rather than the URL: a second `fetch` would
 * pay for the transfer twice and could fail (or 410) after the user has been
 * looking at the model for ten minutes.
 */
export function downloadSharedGlb(payload: SharedGlbPayload, filename: string): void {
  const name = /\.glb$/i.test(filename) ? filename : `${filename}.glb`;
  const blob = new Blob([payload.bytes], { type: 'model/gltf-binary' });
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next turn — revoking synchronously races the click in
    // some browsers and yields a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(href), 0);
  }
}
