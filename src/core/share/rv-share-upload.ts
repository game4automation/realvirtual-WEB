// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The upload half of "Share" (plan-386 §2.6).
 *
 * ## Three steps, and why not one
 *
 * ```
 *   POST /uploads          →  created    (server binds size, sha256, content-type)
 *   PUT  <signed url>      →  uploaded   (bytes go DIRECTLY to storage)
 *   POST /uploads/:id/confirm → confirmed (server verifies the binding)
 * ```
 *
 * A single "post the file to our API" would be simpler to write and worse in
 * every way that matters: the GLB would travel through an application server
 * that has no business touching it, the server would pay for the bandwidth
 * twice, and there would be no point at which "the bytes that arrived" can be
 * checked against "the bytes that were announced". The three-step shape is what
 * makes `upload_TamperedBytes_RejectedByHash` a server-side fact rather than a
 * client-side promise, and it is the shape our Firebase signed-upload
 * infrastructure already has.
 *
 * **Only `confirmed` is visible.** A creation that never gets its bytes, or
 * bytes that never get confirmed, is an orphan: never reachable through a link,
 * never listed under "my shared links", swept up by the server after a short
 * grace period. That is what `upload_FailureLeavesNoHalfState` is about — a
 * failed share must not leave the sender with a link he cannot explain.
 *
 * ## The token goes to us, never to storage
 *
 * The signed URL belongs to a storage provider. Attaching our session token to
 * that PUT would hand a credential to a third party for no reason at all. The
 * PUT therefore carries exactly the headers the server bound the signature to
 * and nothing else — see `upload_PutsBytesDirectlyToSignedUrl`.
 *
 * ## What the sender gets back
 *
 * An **opaque** viewer link, `?glb=s:<id>` — not the storage URL (§2.1,
 * `share_OpaqueId_DoesNotLeakStorageUrl`). What is forwarded in a mail is a
 * realvirtual WEB link, which buys revocation, a reason code on `410` and
 * access counts. It is a hurdle and a product decision, not DRM: the browser
 * must load the bytes eventually.
 *
 * The full HTTP contract this client is written against — payloads, state
 * machine, error codes — is `rv-share-backend-contract.md`, next to this file.
 * That document is the hand-off to the backend repo (§2.6, R1).
 */

import {
  ShareApiError,
  requireShareSession,
  shareApiRequest,
  shareApiErrorFrom,
  getShareApiConfig,
  SHARE_TERMS_VERSION,
  type MagicLinkSession,
  type ShareExpiry,
  type ShareTermsAcceptance,
} from './rv-share-session';
import { ShareFetchError, type ShareGoneReason } from './rv-share-fetch';
import { setShareIdResolver } from './rv-share-target';
import type { RvShareMeta } from './rv-share-meta';

export type { ShareExpiry, ShareTermsAcceptance, MagicLinkSession };

/** Content type the server binds the signature to. */
export const SHARE_CONTENT_TYPE = 'model/gltf-binary';

/** Where the upload is, for a progress display that can say something true. */
export type ShareUploadPhase = 'creating' | 'uploading' | 'confirming' | 'done';

export interface ShareUploadProgress {
  phase: ShareUploadPhase;
  /** Bytes handed to the network so far. Coarse — see the note on `onProgress`. */
  sentBytes: number;
  totalBytes: number;
}

export interface UploadSharedGlbOptions {
  /** The sender. Required — there is no anonymous upload (F9). */
  session: MagicLinkSession;
  /** Consent, with version and timestamp. Required (F9c). */
  terms: ShareTermsAcceptance;
  /** Default `'never'`: a link in an offer should still work in six months (§2.7). */
  expiry?: ShareExpiry;
  /** `false` hides the receiver's download button (F14). Default: allowed. */
  allowDownload?: boolean;
  /** Filename shown in "my shared links" and used for the receiver's download. */
  filename?: string;
  /**
   * Coarse phase progress.
   *
   * `fetch` cannot report bytes as they leave; byte-level progress needs an
   * `XMLHttpRequest` upload listener, which would add an untested second
   * transport for a progress bar. The dialog therefore shows an indeterminate
   * bar during `'uploading'` rather than a number that would be a guess.
   */
  onProgress?: (p: ShareUploadProgress) => void;
  signal?: AbortSignal;
  /** Supplied by tests; otherwise generated. Makes `confirm` retry-safe (F9a). */
  idempotencyKey?: string;
}

/** What `uploadSharedGlb` resolves to — the §2.6 client contract. */
export interface SharedUploadResult {
  /** The storage URL. Internal: it is deliberately NOT what gets shared. */
  url: string;
  /** Opaque share id — the thing that goes into the link, and into deletion. */
  id: string;
  /** ISO 8601. Present **only** when an expiry was chosen (F10). */
  expiresAt?: string;
}

interface CreateUploadResponse {
  id: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  uploadMethod?: string;
  uploadExpiresAt?: string;
}

interface ConfirmUploadResponse {
  id: string;
  url: string;
  expiresAt?: string;
}

/**
 * Upload a GLB and get back the identifiers for a shareable link.
 *
 * Order is load-bearing: the login gate and the consent gate run **before** a
 * single byte is read, so a sender who is not signed in never uploads and then
 * gets told no (`upload_RequiresLogin`, `upload_RequiresTermsAcceptance`).
 */
export async function uploadSharedGlb(
  bytes: ArrayBuffer,
  meta: RvShareMeta,
  opts: UploadSharedGlbOptions,
): Promise<SharedUploadResult> {
  const session = requireShareSession(opts.session);
  const terms = requireTerms(opts.terms);

  const expiry: ShareExpiry = opts.expiry ?? 'never';
  const allowDownload = opts.allowDownload !== false;
  const totalBytes = bytes.byteLength;
  const filename = normaliseFilename(opts.filename ?? meta.name ?? 'shared-model');

  opts.onProgress?.({ phase: 'creating', sentBytes: 0, totalBytes });

  const sha256 = await sha256Hex(bytes);

  const created = await shareApiRequest<CreateUploadResponse>({
    method: 'POST',
    path: '/uploads',
    session,
    signal: opts.signal,
    body: {
      filename,
      contentType: SHARE_CONTENT_TYPE,
      size: totalBytes,
      sha256,
      expiry,
      allowDownload,
      terms,
      // The metadata the receiver's card reads is also stamped into the GLB
      // itself (§2.4). It is sent here as well so "my shared links" can show a
      // name without downloading every file it lists.
      meta: { ...meta, allowDownload },
    },
  });

  if (!created?.id || !created?.uploadUrl) {
    throw new ShareApiError('server', 'The share service did not return an upload target.');
  }

  try {
    opts.onProgress?.({ phase: 'uploading', sentBytes: 0, totalBytes });
    await putBytes(created, bytes, opts.signal);
    opts.onProgress?.({ phase: 'uploading', sentBytes: totalBytes, totalBytes });

    opts.onProgress?.({ phase: 'confirming', sentBytes: totalBytes, totalBytes });
    const confirmed = await shareApiRequest<ConfirmUploadResponse>({
      method: 'POST',
      path: `/uploads/${encodeURIComponent(created.id)}/confirm`,
      session,
      signal: opts.signal,
      headers: { 'Idempotency-Key': opts.idempotencyKey ?? newIdempotencyKey() },
      body: { sha256, size: totalBytes },
    });

    opts.onProgress?.({ phase: 'done', sentBytes: totalBytes, totalBytes });
    return {
      url: confirmed.url,
      id: confirmed.id ?? created.id,
      ...(confirmed.expiresAt ? { expiresAt: confirmed.expiresAt } : {}),
    };
  } catch (e) {
    // Best-effort tidy-up so the sender's quota is not held by a corpse. The
    // server's orphan sweep is the real guarantee; this is the polite version
    // of it (`upload_FailureLeavesNoHalfState`).
    await abandonUpload(session, created.id);
    throw e;
  }
}

/** PUT the bytes at the signed URL — our API never sees them. */
async function putBytes(
  created: CreateUploadResponse,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<void> {
  const doFetch = getShareApiConfig().fetchImpl ?? globalThis.fetch.bind(globalThis);
  // Exactly the headers the signature was bound to. No Authorization: the
  // storage host is a third party and our session token is not its business.
  const headers: Record<string, string> = created.uploadHeaders
    ? { ...created.uploadHeaders }
    : { 'Content-Type': SHARE_CONTENT_TYPE };

  let resp: Response;
  try {
    resp = await doFetch(created.uploadUrl, {
      method: created.uploadMethod ?? 'PUT',
      headers,
      body: bytes,
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw new ShareApiError('aborted', 'The upload was cancelled.', { cause: e });
    throw new ShareApiError('network', 'The file could not be uploaded to storage.', { cause: e });
  }

  if (!resp.ok) throw await shareApiErrorFrom(resp);
}

async function abandonUpload(session: MagicLinkSession, id: string): Promise<void> {
  try {
    await shareApiRequest<void>({
      method: 'DELETE',
      path: `/uploads/${encodeURIComponent(id)}`,
      session,
    });
  } catch {
    // The sweep will get it. Never let cleanup mask the original failure.
  }
}

function requireTerms(terms: ShareTermsAcceptance | undefined): ShareTermsAcceptance {
  if (!terms || terms.version !== SHARE_TERMS_VERSION || !terms.acceptedAt) {
    throw new ShareApiError(
      'terms-required',
      'Accept the terms of use before sharing.',
    );
  }
  return terms;
}

function normaliseFilename(name: string): string {
  const trimmed = name.trim() || 'shared-model';
  return /\.glb$/i.test(trimmed) ? trimmed : `${trimmed}.glb`;
}

function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Lowercase hex SHA-256 of the payload — the binding the server verifies (F9a). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── "My shared links" (F11) ───────────────────────────────────────────────

export interface MyShareEntry {
  id: string;
  name: string;
  sizeBytes: number;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601 — only when the sender chose a deadline. */
  expiresAt?: string;
  allowDownload: boolean;
  /** The server's own verdict; the panel does not re-derive it from the clock. */
  expired?: boolean;
}

/**
 * Everything this sender has shared.
 *
 * Because links stay by default, this list — not an expiry policy — is the
 * control that makes indefinite hosting defensible (§2.7). It is scoped by the
 * session server-side; `myShares_ListsOnlyOwnUploads` is the assertion that a
 * second account's uploads never appear here.
 */
export async function listMyShares(session: MagicLinkSession): Promise<MyShareEntry[]> {
  const s = requireShareSession(session);
  const body = await shareApiRequest<{ shares?: MyShareEntry[] }>({ path: '/shares', session: s });
  return Array.isArray(body?.shares) ? body.shares : [];
}

/** Delete one share now. Afterwards the link answers `410` (F11). */
export async function deleteShare(session: MagicLinkSession, id: string): Promise<void> {
  const s = requireShareSession(session);
  await shareApiRequest<void>({
    method: 'DELETE',
    path: `/shares/${encodeURIComponent(id)}`,
    session: s,
  });
}

// ─── Resolving `?glb=s:<id>` (the Phase-1 seam, now connected) ─────────────

interface DownloadUrlResponse {
  url: string;
  expiresAt?: string;
}

/**
 * Turn an opaque share id into a short-lived download URL.
 *
 * No session: a shared link works for anyone who has it, which is the whole
 * point (F3). A `410` is translated into the fetch layer's `ShareFetchError`
 * so the receiver's card shows the same sentence whether the link died at the
 * resolver or at the file (F10a) — including the distinction between expired
 * and deleted when the server volunteers it, and the neutral "no longer
 * available" when it does not.
 */
export async function resolveShareDownloadUrl(id: string): Promise<string> {
  const doFetch = getShareApiConfig().fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = getShareApiConfig().baseUrl.replace(/\/+$/, '');
  const url = `${base}/shares/${encodeURIComponent(id)}/download-url`;

  let resp: Response;
  try {
    resp = await doFetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch (e) {
    throw new ShareFetchError('network', 'The shared link could not be resolved.', { cause: e });
  }

  if (resp.status === 410) {
    const reason = await goneReasonOf(resp);
    throw new ShareFetchError('gone', goneMessage(reason), { status: 410, reason });
  }
  if (resp.status === 404) {
    throw new ShareFetchError('gone', 'This shared link is no longer available.', { status: 404 });
  }
  if (!resp.ok) {
    throw new ShareFetchError('http', `The share service answered ${resp.status}.`, { status: resp.status });
  }

  const body = await resp.json().catch(() => null) as DownloadUrlResponse | null;
  if (!body?.url) {
    throw new ShareFetchError('network', 'The share service returned no download address.');
  }
  return body.url;
}

async function goneReasonOf(resp: Response): Promise<ShareGoneReason> {
  const header = resp.headers.get('x-rv-share-reason')?.trim().toLowerCase();
  if (header === 'expired' || header === 'deleted') return header;
  try {
    const body = await resp.clone().json() as { reason?: unknown; error?: { reason?: unknown } };
    const raw = body?.reason ?? body?.error?.reason;
    if (raw === 'expired' || raw === 'deleted') return raw;
  } catch { /* no reason available */ }
  return undefined;
}

function goneMessage(reason: ShareGoneReason): string {
  if (reason === 'expired') return 'This shared link has expired.';
  if (reason === 'deleted') return 'This shared link was deleted by its owner.';
  return 'This shared link is no longer available.';
}

/**
 * Connect `?glb=s:<id>` to the backend contract.
 *
 * Phase 1 shipped the seam with nothing registered, so an opaque link failed
 * with a sentence rather than a riddle. This is the single call that fills it,
 * and it returns the un-register so a test can put the module back.
 */
export function installShareIdResolver(): () => void {
  return setShareIdResolver(resolveShareDownloadUrl);
}
