// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The contract stub for the share backend (plan-386 §2.6, R1).
 *
 * The server half of this feature lives in another repo, which is exactly the
 * risk R1 names: a contract nobody can run drifts. So the contract is written
 * down (`src/core/share/rv-share-backend-contract.md`) **and** implemented here
 * as an in-memory server the client is tested against. When the real backend
 * disagrees with this file, one of the two is wrong and the tests say which.
 *
 * It implements the state machine for real — ownership, the single-use signed
 * URL, the size/hash binding, idempotency, orphan sweeping, `410` with a reason
 * — because the security assertions in §9.3 are only worth anything if the
 * thing refusing is a server and not a client-side `if`.
 */

export interface ShareBackendStubOptions {
  /** Per-file ceiling; a bigger `create` is `413 too-large`. */
  maxFileBytes?: number;
  /** Per-account total; exceeding it is `507 quota-exceeded`. */
  quotaBytes?: number;
  /** Grace period after which an unconfirmed upload is swept. */
  orphanGraceMs?: number;
}

type UploadState = 'created' | 'uploaded' | 'confirmed' | 'deleted';

interface UploadRecord {
  id: string;
  owner: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  expiry: string;
  allowDownload: boolean;
  terms: { version: string; acceptedAt: string };
  meta: unknown;
  state: UploadState;
  createdAt: number;
  storedBytes?: ArrayBuffer;
  storedSha?: string;
  confirmedAt?: number;
  expiresAt?: string;
  idempotencyKey?: string;
  confirmBody?: unknown;
  goneReason?: 'expired' | 'deleted';
}

export interface RecordedRequest {
  method: string;
  url: string;
  /** Whether an `Authorization` header was present. */
  authorized: boolean;
  /** Byte length when the body was binary; `undefined` otherwise. */
  byteLength?: number;
  /** The JSON body verbatim when there was one. */
  body?: string;
  /** Request headers, lower-cased. */
  headers: Record<string, string>;
}

const EXPIRY_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 };

export class ShareBackendStub {
  readonly apiBase = 'https://share.example.test/api/share';
  readonly storageBase = 'https://storage.example.test/o';

  readonly requests: RecordedRequest[] = [];

  private readonly maxFileBytes: number;
  private readonly quotaBytes: number;
  private readonly orphanGraceMs: number;

  /** one-time magic tokens, by token */
  private magic = new Map<string, { email: string; used: boolean }>();
  /** live sessions, by bearer token */
  private sessions = new Map<string, { email: string; expiresAt: number }>();
  private uploads = new Map<string, UploadRecord>();
  /** signature id → { uploadId, used } */
  private signatures = new Map<string, { uploadId: string; used: boolean }>();

  private seq = 0;

  constructor(opts?: ShareBackendStubOptions) {
    this.maxFileBytes = opts?.maxFileBytes ?? 100 * 1024 * 1024;
    this.quotaBytes = opts?.quotaBytes ?? 1024 * 1024 * 1024;
    this.orphanGraceMs = opts?.orphanGraceMs ?? 60_000;
  }

  /** Drop-in for `fetch`, bound so it can be handed straight to `configureShareApi`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = normaliseHeaders(init?.headers);
    const body = init?.body;

    this.requests.push({
      method,
      url,
      authorized: Boolean(headers.authorization),
      byteLength: body instanceof ArrayBuffer ? body.byteLength
        : ArrayBuffer.isView(body) ? body.byteLength : undefined,
      ...(typeof body === 'string' ? { body } : {}),
      headers,
    });

    if (url.startsWith(this.storageBase)) return this.storage(url, method, body);
    if (url.startsWith(this.apiBase)) {
      const path = url.slice(this.apiBase.length).split('?')[0] ?? '';
      return this.api(path, method, headers, body);
    }
    return json(404, { error: { code: 'not-found', message: `stub has no route for ${url}` } });
  };

  // ─── test helpers ────────────────────────────────────────────────────────

  /** The token the mail would have carried, for the most recent request. */
  lastMagicToken(email: string): string | undefined {
    let found: string | undefined;
    for (const [token, rec] of this.magic) if (rec.email === email) found = token;
    return found;
  }

  /** Sign in without the mail round trip — for tests that are about something else. */
  signIn(email: string, ttlMs = 3600_000): { token: string; email: string; expiresAt: string } {
    const token = `sess-${++this.seq}`;
    const expiresAt = Date.now() + ttlMs;
    this.sessions.set(token, { email, expiresAt });
    return { token, email, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Make a live session answer `401` — expiry or revocation, same effect. */
  revokeSession(token: string): void {
    this.sessions.delete(token);
  }

  /** Run what the server's sweep would do: unconfirmed records disappear. */
  runOrphanCleanup(nowMs = Date.now()): string[] {
    const swept: string[] = [];
    for (const [id, rec] of this.uploads) {
      if (rec.state === 'created' || rec.state === 'uploaded') {
        if (nowMs - rec.createdAt >= this.orphanGraceMs) {
          this.uploads.delete(id);
          swept.push(id);
        }
      }
    }
    return swept;
  }

  /** Run what the TTL job would do to one share. */
  expireShare(id: string): void {
    const rec = this.uploads.get(id);
    if (!rec) return;
    rec.state = 'deleted';
    rec.goneReason = 'expired';
    rec.storedBytes = undefined;
  }

  /** Id of the most recently created upload — the handle a failed flow never returns. */
  lastCreatedId(): string | undefined {
    let last: string | undefined;
    for (const id of this.uploads.keys()) last = id;
    return last;
  }

  stateOf(id: string): UploadState | 'absent' {
    return this.uploads.get(id)?.state ?? 'absent';
  }

  /** The consent the server recorded for a share — version and timestamp (F9c). */
  termsOf(id: string): { version: string; acceptedAt: string } | undefined {
    return this.uploads.get(id)?.terms;
  }

  confirmedCount(): number {
    let n = 0;
    for (const rec of this.uploads.values()) if (rec.state === 'confirmed') n++;
    return n;
  }

  /** Requests that carried binary bodies — used to prove where the bytes went. */
  binaryRequests(): RecordedRequest[] {
    return this.requests.filter(r => r.byteLength !== undefined);
  }

  // ─── routing ─────────────────────────────────────────────────────────────

  private async api(
    path: string,
    method: string,
    headers: Record<string, string>,
    body: BodyInit | null | undefined,
  ): Promise<Response> {
    const payload = parseJsonBody(body);

    if (path === '/auth/request' && method === 'POST') {
      const email = String((payload as { email?: string })?.email ?? '');
      const token = `magic-${++this.seq}`;
      this.magic.set(token, { email, used: false });
      return json(202, { requestId: `req-${this.seq}`, expiresInSec: 900 });
    }

    if (path === '/auth/exchange' && method === 'POST') {
      const token = String((payload as { token?: string })?.token ?? '');
      const rec = this.magic.get(token);
      if (!rec || rec.used) {
        return json(401, { error: { code: 'unauthenticated', message: 'This sign-in link is no longer valid.' } });
      }
      rec.used = true;                       // one-time means one time
      return json(200, { session: this.signIn(rec.email) });
    }

    const session = this.sessionOf(headers);

    if (path === '/auth/session' && method === 'GET') {
      if (!session) return unauthorized();
      return json(200, { email: session.email, expiresAt: new Date(session.expiresAt).toISOString() });
    }

    if (path === '/auth/logout' && method === 'POST') {
      if (headers.authorization) this.sessions.delete(bearer(headers));
      return new Response(null, { status: 204 });
    }

    if (path === '/uploads' && method === 'POST') return this.createUpload(session, payload);

    const confirm = /^\/uploads\/([^/]+)\/confirm$/.exec(path);
    if (confirm && method === 'POST') {
      return this.confirmUpload(session, decodeURIComponent(confirm[1]!), payload, headers);
    }

    const abandon = /^\/uploads\/([^/]+)$/.exec(path);
    if (abandon && method === 'DELETE') {
      if (!session) return unauthorized();
      const rec = this.uploads.get(decodeURIComponent(abandon[1]!));
      if (rec && rec.owner === session.email && rec.state !== 'confirmed') {
        this.uploads.delete(rec.id);
      }
      return new Response(null, { status: 204 });
    }

    if (path === '/shares' && method === 'GET') {
      if (!session) return unauthorized();
      const shares = [...this.uploads.values()]
        .filter(r => r.state === 'confirmed' && r.owner === session.email)
        .map(r => ({
          id: r.id,
          name: r.filename.replace(/\.glb$/i, ''),
          sizeBytes: r.size,
          createdAt: new Date(r.createdAt).toISOString(),
          ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}),
          allowDownload: r.allowDownload,
          expired: false,
        }));
      return json(200, { shares });
    }

    const download = /^\/shares\/([^/]+)\/download-url$/.exec(path);
    if (download && method === 'GET') return this.downloadUrl(decodeURIComponent(download[1]!));

    const share = /^\/shares\/([^/]+)$/.exec(path);
    if (share && method === 'DELETE') {
      if (!session) return unauthorized();
      const rec = this.uploads.get(decodeURIComponent(share[1]!));
      if (!rec || rec.state !== 'confirmed') {
        return json(404, { error: { code: 'not-found', message: 'No such share.' } });
      }
      if (rec.owner !== session.email) {
        return json(403, { error: { code: 'forbidden', message: 'This share belongs to a different account.' } });
      }
      rec.state = 'deleted';
      rec.goneReason = 'deleted';
      rec.storedBytes = undefined;
      return new Response(null, { status: 204 });
    }

    return json(404, { error: { code: 'not-found', message: `stub has no route for ${method} ${path}` } });
  }

  private createUpload(
    session: { email: string; expiresAt: number } | null,
    payload: unknown,
  ): Response {
    if (!session) return unauthorized();

    const p = payload as {
      filename?: string; contentType?: string; size?: number; sha256?: string;
      expiry?: string; allowDownload?: boolean;
      terms?: { version?: string; acceptedAt?: string }; meta?: unknown;
    } | null;

    if (!p?.terms?.version || !p.terms.acceptedAt) {
      return json(422, { error: { code: 'terms-required', message: 'The terms have to be accepted before sharing.' } });
    }
    const size = Number(p.size);
    if (!Number.isFinite(size) || size <= 0 || typeof p.sha256 !== 'string') {
      return json(400, { error: { code: 'bad-request', message: 'size and sha256 are required.' } });
    }
    if (size > this.maxFileBytes) {
      return json(413, {
        error: {
          code: 'too-large',
          message: `The file is larger than the ${Math.round(this.maxFileBytes / (1024 * 1024))} MB upload limit.`,
        },
      });
    }
    const used = [...this.uploads.values()]
      .filter(r => r.owner === session.email && r.state === 'confirmed')
      .reduce((sum, r) => sum + r.size, 0);
    if (used + size > this.quotaBytes) {
      return json(507, {
        error: { code: 'quota-exceeded', message: 'Your storage quota is used up. Delete a shared file and try again.' },
      });
    }

    const id = `sh${++this.seq}`;
    const sig = `sig${this.seq}`;
    this.signatures.set(sig, { uploadId: id, used: false });
    this.uploads.set(id, {
      id,
      owner: session.email,
      filename: p.filename ?? 'shared-model.glb',
      contentType: p.contentType ?? 'model/gltf-binary',
      size,
      sha256: p.sha256,
      expiry: p.expiry ?? 'never',
      allowDownload: p.allowDownload !== false,
      terms: { version: p.terms.version, acceptedAt: p.terms.acceptedAt },
      meta: p.meta,
      state: 'created',
      createdAt: Date.now(),
    });

    return json(201, {
      id,
      uploadUrl: `${this.storageBase}/${id}?sig=${sig}`,
      uploadHeaders: { 'Content-Type': p.contentType ?? 'model/gltf-binary' },
      uploadMethod: 'PUT',
      uploadExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  }

  private async confirmUpload(
    session: { email: string; expiresAt: number } | null,
    id: string,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<Response> {
    if (!session) return unauthorized();
    const rec = this.uploads.get(id);
    if (!rec) return json(404, { error: { code: 'not-found', message: 'No such upload.' } });
    if (rec.owner !== session.email) {
      return json(403, { error: { code: 'forbidden', message: 'This upload belongs to a different account.' } });
    }

    const key = headers['idempotency-key'];
    if (rec.state === 'confirmed') {
      if (key && key === rec.idempotencyKey) return json(200, rec.confirmBody);
      return json(409, { error: { code: 'conflict', message: 'The upload was already completed.' } });
    }
    if (rec.state !== 'uploaded') {
      return json(409, { error: { code: 'not-uploaded', message: 'The file was not uploaded yet.' } });
    }

    const p = payload as { sha256?: string; size?: number } | null;
    const storedSize = rec.storedBytes?.byteLength ?? 0;
    // Verified against what the STORAGE holds, not against what the client
    // repeats — otherwise the check would be a formality.
    if (rec.storedSha !== rec.sha256 || storedSize !== rec.size
        || p?.sha256 !== rec.sha256 || Number(p?.size) !== rec.size) {
      rec.state = 'deleted';
      rec.goneReason = 'deleted';
      return json(422, {
        error: { code: 'hash-mismatch', message: 'The uploaded file did not match what was announced and was rejected.' },
      });
    }

    rec.state = 'confirmed';
    rec.confirmedAt = Date.now();
    rec.idempotencyKey = key;
    const days = EXPIRY_DAYS[rec.expiry];
    if (days) rec.expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    rec.confirmBody = {
      id: rec.id,
      url: `${this.storageBase}/${rec.id}`,
      ...(rec.expiresAt ? { expiresAt: rec.expiresAt } : {}),
    };
    return json(200, rec.confirmBody);
  }

  private downloadUrl(id: string): Response {
    const rec = this.uploads.get(id);
    if (!rec || rec.state === 'deleted') {
      const reason = rec?.goneReason;
      return new Response(
        JSON.stringify({ error: { code: 'gone', message: 'gone' }, ...(reason ? { reason } : {}) }),
        {
          status: 410,
          headers: {
            'Content-Type': 'application/json',
            ...(reason ? { 'X-Rv-Share-Reason': reason } : {}),
          },
        },
      );
    }
    if (rec.state !== 'confirmed') {
      // Never reachable through a link before confirm (F9a).
      return json(404, { error: { code: 'not-found', message: 'No such share.' } });
    }
    return json(200, {
      url: `${this.storageBase}/${rec.id}?dl=${++this.seq}`,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  }

  private async storage(
    url: string,
    method: string,
    body: BodyInit | null | undefined,
  ): Promise<Response> {
    if (method !== 'PUT') return new Response(null, { status: 405 });

    const sig = new URL(url).searchParams.get('sig') ?? '';
    const entry = this.signatures.get(sig);
    if (!entry) return json(403, { error: { code: 'forbidden', message: 'Invalid signature.' } });
    if (entry.used) {
      return json(403, { error: { code: 'forbidden', message: 'This upload URL was already used.' } });
    }

    const rec = this.uploads.get(entry.uploadId);
    if (!rec) return json(404, { error: { code: 'not-found', message: 'No such upload.' } });

    const bytes = toArrayBuffer(body);
    entry.used = true;
    rec.storedBytes = bytes;
    rec.storedSha = await sha256Hex(bytes);
    rec.state = 'uploaded';
    return new Response(null, { status: 200 });
  }

  private sessionOf(headers: Record<string, string>): { email: string; expiresAt: number } | null {
    const token = bearer(headers);
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { this.sessions.delete(token); return null; }
    return s;
  }
}

// ─── small helpers ─────────────────────────────────────────────────────────

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body ?? {}), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(): Response {
  return json(401, { error: { code: 'unauthenticated', message: 'Sign in with your e-mail before sharing.' } });
}

function bearer(headers: Record<string, string>): string {
  const raw = headers.authorization ?? '';
  return raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

function normaliseHeaders(init: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  if (init instanceof Headers) {
    init.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(init)) {
    for (const [k, v] of init) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(init)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function parseJsonBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return null;
  try { return JSON.parse(body); } catch { return null; }
}

function toArrayBuffer(body: BodyInit | null | undefined): ArrayBuffer {
  if (body instanceof ArrayBuffer) return body;
  if (ArrayBuffer.isView(body)) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  }
  if (typeof body === 'string') return new TextEncoder().encode(body).buffer as ArrayBuffer;
  return new ArrayBuffer(0);
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}
