// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Who the sender is, and what survives him leaving the page (plan-386 §2.6).
 *
 * ## Why a login at all
 *
 * Uploading to us is the default path of "Share", and we keep the file until
 * somebody says otherwise. Hosting other people's content indefinitely without
 * knowing whose content it is has no defensible answer to "take this down" —
 * and no way to offer the one control that makes indefinite hosting
 * responsible in the first place, "my shared links" (F11). So: **no anonymous
 * upload** (F9). The path that hosts nothing at ours — "use my own URL" —
 * needs no login, because there is nothing to attribute (Finding 14).
 *
 * ## Why magic link
 *
 * Passwordless: no reset flow, no breach surface, no support load — and the
 * reset would run over the same mailbox anyway. The infrastructure exists
 * (portal magic link + nodemailer). This module is the client half of it.
 *
 * ## Why the *draft* lives here too
 *
 * A magic link means the sender leaves the page mid-dialog. Everything he had
 * typed — author, licence, expiry, the ticked consent — has to be there when he
 * comes back, or the login reads as a punishment for wanting to share
 * (`magicLink_SessionSurvivesMailRoundTrip`). Session and draft are the same
 * concern seen twice: *what has to survive the round trip*. They are stored
 * next to each other so nobody has to guess where the other half went.
 *
 * The bytes are the one thing that cannot survive: a GLB does not belong in
 * localStorage. The draft restores the **form**; the caller re-supplies the
 * geometry it still holds in memory.
 *
 * ## What this module never does
 *
 * It never puts a credential in the bundle (`upload_NoCredentialsInClient`).
 * The only secret it ever holds is the session token the server minted for
 * this user, and that token goes to our API and **nowhere else** — in
 * particular never onto the signed storage URL, which belongs to a third
 * party.
 */

/** Version of the terms the sender agrees to. Bumping it re-asks (F9c). */
export const SHARE_TERMS_VERSION = '2026-08-08';

/** Same-origin by default; a deploy whose API lives elsewhere calls {@link configureShareApi}. */
export const DEFAULT_SHARE_API_BASE = '/api/share';

/** Query parameter the magic-link mail comes back on. */
export const MAGIC_LINK_PARAM = 'sharetoken';

/** localStorage key holding the sender's session. */
export const SHARE_SESSION_KEY = 'rv-share-session';
/** localStorage key holding the in-progress share dialog form. */
export const SHARE_DRAFT_KEY = 'rv-share-draft';

/** How long a share link lives. `'never'` is the default (§2.7, F10). */
export type ShareExpiry = 'never' | '7d' | '30d' | '90d';

/** Proof that the sender accepted the terms, with when and which (F9c). */
export interface ShareTermsAcceptance {
  version: string;
  /** ISO 8601 — the moment the box was ticked, not the moment of upload. */
  acceptedAt: string;
}

export interface MagicLinkSession {
  /** Bearer token for our API. Never sent to a storage host. */
  token: string;
  email: string;
  /** ISO 8601. A session past this is treated as absent without asking. */
  expiresAt: string;
}

// ─── Errors ────────────────────────────────────────────────────────────────

/**
 * Everything the share API can refuse, in terms a message can be built from.
 *
 * Deliberately mirrors the server's `error.code` one-to-one: a client that
 * re-derives meaning from status codes drifts from the backend the first time
 * somebody adds a case. The status is the fallback, not the source.
 */
export type ShareApiErrorCode =
  | 'unauthenticated'
  | 'terms-required'
  | 'forbidden'
  | 'not-found'
  | 'gone'
  | 'too-large'
  | 'quota-exceeded'
  | 'not-uploaded'
  | 'hash-mismatch'
  | 'conflict'
  | 'bad-request'
  | 'aborted'
  | 'network'
  | 'server';

export class ShareApiError extends Error {
  readonly code: ShareApiErrorCode;
  readonly status?: number;

  constructor(code: ShareApiErrorCode, message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ShareApiError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
  }
}

/** User-facing sentence for any failure of the share API. */
export function describeShareApiError(e: unknown): string {
  if (e instanceof ShareApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ─── Transport ─────────────────────────────────────────────────────────────

export interface ShareApiConfig {
  /** Base URL without a trailing slash, e.g. `https://api.example.org/share/v1`. */
  baseUrl: string;
  /** Injectable for tests and for hosts that wrap fetch. */
  fetchImpl?: typeof fetch;
}

let config: ShareApiConfig = { baseUrl: DEFAULT_SHARE_API_BASE };

/** Point the client at a backend. Returns a restore function (tests, hot reload). */
export function configureShareApi(next: Partial<ShareApiConfig>): () => void {
  const previous = config;
  config = { ...config, ...next };
  return () => { config = previous; };
}

export function getShareApiConfig(): Readonly<ShareApiConfig> {
  return config;
}

function apiUrl(path: string): string {
  const base = config.baseUrl.replace(/\/+$/, '');
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

function currentFetch(): typeof fetch {
  return config.fetchImpl ?? globalThis.fetch.bind(globalThis);
}

const STATUS_CODES: Readonly<Record<number, ShareApiErrorCode>> = {
  400: 'bad-request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  410: 'gone',
  413: 'too-large',
  422: 'bad-request',
  429: 'quota-exceeded',
  507: 'quota-exceeded',
};

const KNOWN_CODES = new Set<string>([
  'unauthenticated', 'terms-required', 'forbidden', 'not-found', 'gone',
  'too-large', 'quota-exceeded', 'not-uploaded', 'hash-mismatch', 'conflict',
  'bad-request', 'server',
]);

/** Turn a non-2xx response into a `ShareApiError`, preferring the server's own code. */
export async function shareApiErrorFrom(resp: Response): Promise<ShareApiError> {
  let code: ShareApiErrorCode | undefined;
  let message: string | undefined;
  try {
    const body = await resp.clone().json() as { error?: { code?: unknown; message?: unknown } };
    const raw = body?.error?.code;
    if (typeof raw === 'string' && KNOWN_CODES.has(raw)) code = raw as ShareApiErrorCode;
    if (typeof body?.error?.message === 'string') message = body.error.message;
  } catch {
    // Not a JSON error envelope (gateway page, empty body) — status it is.
  }
  const resolved = code ?? STATUS_CODES[resp.status] ?? (resp.status >= 500 ? 'server' : 'network');
  return new ShareApiError(resolved, message ?? defaultMessage(resolved, resp.status), {
    status: resp.status,
  });
}

function defaultMessage(code: ShareApiErrorCode, status: number): string {
  switch (code) {
    case 'unauthenticated': return 'Your sign-in has expired. Request a new link and try again.';
    case 'terms-required': return 'The terms have to be accepted before sharing.';
    case 'forbidden': return 'This share belongs to a different account.';
    case 'not-found': return 'This share no longer exists.';
    case 'gone': return 'This shared link is no longer available.';
    case 'too-large': return 'The file is larger than the upload limit.';
    case 'quota-exceeded': return 'Your storage quota is used up. Delete a shared file and try again.';
    case 'not-uploaded': return 'The file was not fully uploaded, so it was not published.';
    case 'hash-mismatch': return 'The uploaded file did not match what was announced and was rejected.';
    case 'conflict': return 'The upload was already completed.';
    case 'bad-request': return 'The upload request was rejected as invalid.';
    case 'server': return 'The share service is unavailable right now. Please try again later.';
    default: return `The share service answered ${status}.`;
  }
}

export interface ShareApiRequest {
  method?: string;
  path: string;
  body?: unknown;
  session?: MagicLinkSession | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * One request against our share API.
 *
 * The session token is attached here and only here, so there is a single place
 * to check that it never travels anywhere else.
 */
export async function shareApiRequest<T>(req: ShareApiRequest): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';
  if (req.session) headers.Authorization = `Bearer ${req.session.token}`;

  let resp: Response;
  try {
    resp = await currentFetch()(apiUrl(req.path), {
      method: req.method ?? 'GET',
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: req.signal,
      cache: 'no-store',
    });
  } catch (e) {
    if (req.signal?.aborted) throw new ShareApiError('aborted', 'Sharing was cancelled.', { cause: e });
    throw new ShareApiError('network', 'The share service could not be reached.', { cause: e });
  }

  if (resp.status === 401) {
    // A rejected token is a dead token: drop it rather than let every later
    // call fail the same way and leave the UI claiming the user is signed in.
    clearShareSession();
  }
  if (!resp.ok) throw await shareApiErrorFrom(resp);
  if (resp.status === 204) return undefined as T;

  try {
    return await resp.json() as T;
  } catch (e) {
    throw new ShareApiError('server', 'The share service returned an unreadable answer.', { cause: e });
  }
}

// ─── Session state ─────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: MagicLinkSession | null | undefined;

function notify(): void {
  for (const l of listeners) l();
}

function isExpired(s: MagicLinkSession): boolean {
  const t = Date.parse(s.expiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

function readStored(): MagicLinkSession | null {
  try {
    const raw = localStorage.getItem(SHARE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<MagicLinkSession>;
    if (typeof parsed?.token !== 'string' || typeof parsed?.email !== 'string') return null;
    const session: MagicLinkSession = {
      token: parsed.token,
      email: parsed.email,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : '',
    };
    return isExpired(session) ? null : session;
  } catch {
    // Storage disabled or corrupt entry — same answer either way: not signed in.
    return null;
  }
}

/** The sender's session, or `null`. Expired sessions read as `null` (F9/§9.3 replay). */
export function getShareSession(): MagicLinkSession | null {
  if (cached === undefined) cached = readStored();
  return cached;
}

export function subscribeShareSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setShareSession(session: MagicLinkSession | null): void {
  cached = session;
  try {
    if (session) localStorage.setItem(SHARE_SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SHARE_SESSION_KEY);
  } catch {
    // Private mode: the in-memory value still carries this tab.
  }
  notify();
}

export function clearShareSession(): void {
  setShareSession(null);
}

/** Throw unless there is a usable session — the gate that runs *before* any upload (F9). */
export function requireShareSession(session?: MagicLinkSession | null): MagicLinkSession {
  const s = session ?? getShareSession();
  if (!s || isExpired(s)) {
    throw new ShareApiError('unauthenticated', 'Sign in with your e-mail before sharing.');
  }
  return s;
}

// ─── Magic link flow ───────────────────────────────────────────────────────

export interface MagicLinkRequestResult {
  /** Correlation id for support; never required to complete the flow. */
  requestId: string;
  expiresInSec: number;
}

/**
 * Ask for a sign-in mail.
 *
 * `returnUrl` is where the mail should send the sender back to. Defaults to the
 * current page **with the token parameter stripped**, so a second round trip
 * cannot stack two tokens in one URL.
 */
export async function requestMagicLink(
  email: string,
  opts?: { returnUrl?: string; signal?: AbortSignal },
): Promise<MagicLinkRequestResult> {
  const address = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new ShareApiError('bad-request', 'That does not look like an e-mail address.');
  }
  return shareApiRequest<MagicLinkRequestResult>({
    method: 'POST',
    path: '/auth/request',
    body: { email: address, returnUrl: opts?.returnUrl ?? currentReturnUrl() },
    signal: opts?.signal,
  });
}

function currentReturnUrl(): string | undefined {
  if (typeof location === 'undefined') return undefined;
  try {
    const u = new URL(location.href);
    u.searchParams.delete(MAGIC_LINK_PARAM);
    return u.href;
  } catch {
    return undefined;
  }
}

/** Exchange a token from the mail for a session. */
export async function exchangeMagicLinkToken(token: string): Promise<MagicLinkSession> {
  const body = await shareApiRequest<{ session: MagicLinkSession }>({
    method: 'POST',
    path: '/auth/exchange',
    body: { token },
  });
  const session = body?.session;
  if (!session || typeof session.token !== 'string') {
    throw new ShareApiError('server', 'The sign-in link could not be redeemed.');
  }
  setShareSession(session);
  return session;
}

/**
 * Redeem a `?sharetoken=` the mail link brought back, and take it out of the URL.
 *
 * Returns `null` when there is no token — the normal case on every other page
 * load. The parameter is removed with `replaceState` whether or not the
 * exchange succeeded: a one-time token left in the address bar gets copied,
 * bookmarked and mailed on, and it is a credential.
 */
export async function consumeMagicLinkFromUrl(href?: string): Promise<MagicLinkSession | null> {
  const source = href ?? (typeof location !== 'undefined' ? location.href : undefined);
  if (!source) return null;

  let url: URL;
  try { url = new URL(source); } catch { return null; }

  const token = url.searchParams.get(MAGIC_LINK_PARAM);
  if (!token) return null;

  url.searchParams.delete(MAGIC_LINK_PARAM);
  // Rewrite the address bar only when the address bar is what we read. A
  // caller that hands in some other href wants the token redeemed, not the
  // page's history rewritten under it.
  if (typeof location !== 'undefined' && source === location.href) {
    try {
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
    } catch {
      // No history (embedded host) — the exchange still matters.
    }
  }

  try {
    return await exchangeMagicLinkToken(token);
  } catch {
    // An expired or replayed link is not an error the boot has to survive
    // loudly; the dialog will simply still show the sign-in step.
    return null;
  }
}

/** End the session locally and, best effort, on the server. */
export async function signOutShare(): Promise<void> {
  const session = getShareSession();
  clearShareSession();
  if (!session) return;
  try {
    await shareApiRequest<void>({ method: 'POST', path: '/auth/logout', session });
  } catch {
    // The local session is already gone, which is what the user asked for.
  }
}

// ─── The dialog draft (survives the mail round trip) ───────────────────────

export interface ShareDialogDraft {
  name?: string;
  author?: string;
  license?: string;
  /** `'upload'` hosts with us; `'own-url'` hosts nowhere and needs no login. */
  target: 'upload' | 'own-url';
  ownUrl?: string;
  expiry: ShareExpiry;
  allowDownload: boolean;
  /** Present exactly when the sender ticked the consent box (F9c). */
  terms?: ShareTermsAcceptance;
  savedAt: string;
}

/** How long an abandoned draft is still offered back. */
const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function saveShareDraft(draft: Omit<ShareDialogDraft, 'savedAt'>): void {
  try {
    localStorage.setItem(SHARE_DRAFT_KEY, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
  } catch {
    // Without storage the round trip loses the form — annoying, never fatal.
  }
}

/**
 * The form the sender left behind, or `null`.
 *
 * A draft whose accepted terms are of an older version comes back **without**
 * the acceptance: consent to a text that has since changed is not consent
 * (F9c). Everything else he typed is kept, so he re-ticks one box rather than
 * refilling the dialog.
 */
export function loadShareDraft(): ShareDialogDraft | null {
  try {
    const raw = localStorage.getItem(SHARE_DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<ShareDialogDraft>;
    if (!d || typeof d !== 'object') return null;

    const savedAt = typeof d.savedAt === 'string' ? d.savedAt : '';
    const age = Date.now() - Date.parse(savedAt);
    if (!Number.isFinite(age) || age > DRAFT_MAX_AGE_MS) return null;

    const terms = d.terms && d.terms.version === SHARE_TERMS_VERSION ? d.terms : undefined;
    return {
      name: typeof d.name === 'string' ? d.name : undefined,
      author: typeof d.author === 'string' ? d.author : undefined,
      license: typeof d.license === 'string' ? d.license : undefined,
      target: d.target === 'own-url' ? 'own-url' : 'upload',
      ownUrl: typeof d.ownUrl === 'string' ? d.ownUrl : undefined,
      expiry: isExpiryValue(d.expiry) ? d.expiry : 'never',
      allowDownload: d.allowDownload !== false,
      terms,
      savedAt,
    };
  } catch {
    return null;
  }
}

export function clearShareDraft(): void {
  try { localStorage.removeItem(SHARE_DRAFT_KEY); } catch { /* nothing stored */ }
}

function isExpiryValue(v: unknown): v is ShareExpiry {
  return v === 'never' || v === '7d' || v === '30d' || v === '90d';
}

/** Test seam: forget the cached session so the next read hits storage again. */
export function resetShareSessionCache(): void {
  cached = undefined;
}
