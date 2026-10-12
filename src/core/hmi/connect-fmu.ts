// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-fmu — the REST client of CONNECT's `/fmu` routes (plan-498 Phase 3).
 *
 * One function per route, each with an `AbortSignal`, each over the shared
 * authenticated transport (`connectRestFetch`, API key included). Failures are
 * TYPED: every non-2xx answer becomes a {@link ConnectFmuError} carrying the
 * HTTP status and the gateway's machine-readable `reason` (`package-missing`,
 * `browser-origin-required`, `package-referenced`, `fmu-signal-mismatch`,
 * `lease-unknown`, …), so the provisioning plugin branches on codes, never on
 * human text.
 *
 * The contract is CONNECT's `Api/FmuEndpoints.cs` (plan-498 Phase 2):
 *  - `GET  /fmu/{sha}`               → package info, 404 `package-missing`
 *  - `POST /fmu` (raw body, `?sha256=`) → 201 created / 200 cache hit, 422 reasons, 413
 *  - `POST|DELETE /fmu/{sha}/trust`  → needs a browser Origin (403 otherwise)
 *  - `POST /fmu/instances`           → `{interfaceId, leaseId, created}`, 422 `fmu-signal-mismatch`,
 *                                      422 `fmu-override-invalid` (plan-502: `details[]{variable, value, reason}`)
 *  - `POST /fmu/leases/{id}/renew`, `DELETE /fmu/leases/{id}` → 404 `lease-unknown`
 * The trust routes rely on the BROWSER setting `Origin` — this module never
 * sets it; a non-browser caller (the live smoke) passes it through `headers`.
 */

import { connectRestFetch } from './connect-rest';
import { getConnectSnapshot } from './connect-store';

// ─── Types ──────────────────────────────────────────────────────────────

/** One variable of CONNECT's own `modelDescription.xml` parse. */
export interface ConnectFmuVariable {
  name: string;
  valueReference: number;
  causality: string;
  variability?: string | null;
  type: string;
  start?: string | null;
  unit?: string | null;
  description?: string | null;
  /** CONNECT maps it to a signal. */
  supported: boolean;
  /** `PLCInputFloat` … when supported. */
  wireType?: string | null;
  /** `Real` | `Integer` | `Boolean` when supported. */
  dataType?: string | null;
  direction?: 'input' | 'output' | null;
  unsupportedReason?: string | null;
  /** plan-502 (meta v2) — FMI `initial`, range, declared type and enumeration items. */
  initial?: string | null;
  min?: number | null;
  max?: number | null;
  declaredType?: string | null;
  enumItems?: Array<{ name: string; value: number }> | null;
  /** plan-502 — a start-value override is accepted for this variable. */
  overrideAllowed?: boolean;
  /** plan-502 — a changed override of this variable restarts the worker. */
  restartRequired?: boolean;
}

/** `GET /fmu/{sha}` / `POST /fmu` answer. */
export interface ConnectFmuPackage {
  sha256: string;
  /** `POST /fmu` only: true = uploaded now, false = cache hit. */
  created?: boolean | null;
  trusted: boolean;
  trustedAt?: string | null;
  refCount: number;
  meta: {
    modelName: string;
    guid: string;
    fmiVersion: string;
    modelIdentifier?: string | null;
    generationTool?: string | null;
    generationDateAndTime?: string | null;
    byteLength: number;
  };
  variables: ConnectFmuVariable[];
}

/** One signal of `POST /fmu/instances`: the viewer's registered wire name and its FMI variable. */
export interface ConnectFmuSignalRequest {
  name: string;
  valueReference: number;
  /** `Real` | `Integer` | `Boolean` — checked by CONNECT against its parse. */
  dataType: string;
  direction: 'input' | 'output';
}

/** Body of `POST /fmu/instances`. */
export interface ConnectFmuInstanceRequest {
  instanceKey: string;
  sha256: string;
  signals: ConnectFmuSignalRequest[];
  allowWebToPlc: boolean;
  stepSize?: number;
  tolerance?: number;
  /**
   * plan-502 — the COMPLETE map of start-value overrides (variable name → value
   * as string). CONNECT validates it (422 `fmu-override-invalid`), applies it at
   * initialisation and decides restart (a fixed parameter changed) vs. in-place
   * update (only live-writable variables changed).
   */
  startOverrides?: Record<string, string>;
}

/** Answer of `POST /fmu/instances`. */
export interface ConnectFmuInstance {
  interfaceId: string;
  leaseId: string;
  /** True when this call created the interface (201), false = it existed (200). */
  created: boolean;
  leaseTtlSeconds?: number;
  expiresAt?: string;
  trusted?: boolean;
}

/** Answer of `POST /fmu/leases/{id}/renew`. */
export interface ConnectFmuLease {
  leaseId: string;
  interfaceId: string;
  expiresAt?: string;
}

/** Per-call options: gateway base URL (default: the CONNECT panel's), abort, extra headers. */
export interface ConnectFmuCallOptions {
  baseUrl?: string;
  signal?: AbortSignal;
  /** Extra request headers — the live smoke sets `Origin` here; a browser sets it itself. */
  headers?: Record<string, string>;
}

/** A typed failure of a `/fmu` route. */
export class ConnectFmuError extends Error {
  /** HTTP status (0 = network failure before any answer). */
  readonly status: number;
  /** The gateway's machine-readable reason (`package-missing`, `fmu-signal-mismatch`, …) or null. */
  readonly code: string | null;
  /** `details` of a 422 `fmu-signal-mismatch` (per-signal reasons), else undefined. */
  readonly details?: unknown;

  constructor(message: string, status: number, code: string | null, details?: unknown) {
    super(message);
    this.name = 'ConnectFmuError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isNotFound(): boolean { return this.status === 404; }
  get isForbidden(): boolean { return this.status === 403; }
  get isConflict(): boolean { return this.status === 409; }
  get isUnprocessable(): boolean { return this.status === 422; }
}

/** True for an abort of the caller's `AbortSignal` (never a gateway failure). */
export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

// ─── Transport ──────────────────────────────────────────────────────────

function baseOf(opts?: ConnectFmuCallOptions): string {
  const base = opts?.baseUrl ?? getConnectSnapshot().serverUrl;
  return base.replace(/\/+$/, '');
}

function shaSegment(sha: string): string {
  return encodeURIComponent(sha.trim().toLowerCase());
}

/**
 * Decode a failed answer into a {@link ConnectFmuError}. The gateway speaks
 * three shapes: `{reason, message, details?}` (the `/fmu` routes),
 * `{error}` (400) and a problem+json `{code, detail}` (413).
 */
async function errorOf(response: Response, what: string): Promise<ConnectFmuError> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json() as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON: status only.
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const code = str(body.reason) ?? str(body.code) ?? null;
  const text = str(body.message) ?? str(body.detail) ?? str(body.error)
    ?? `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  return new ConnectFmuError(`${what}: ${text}`, response.status, code, body.details);
}

async function call(path: string, init: RequestInit, opts: ConnectFmuCallOptions | undefined, what: string): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(opts?.headers ?? {})) headers.set(k, v);
  let response: Response;
  try {
    response = await connectRestFetch(`${baseOf(opts)}${path}`, { ...init, headers, signal: opts?.signal });
  } catch (e) {
    if (isAbortError(e)) throw e;
    throw new ConnectFmuError(`${what}: ${(e as Error)?.message ?? String(e)}`, 0, 'network');
  }
  if (!response.ok) throw await errorOf(response, what);
  return response;
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

// ─── Routes ─────────────────────────────────────────────────────────────

/** `GET /fmu/{sha}` — the package as CONNECT knows it, or null when it was never uploaded (404). */
export async function getPackage(sha: string, opts?: ConnectFmuCallOptions): Promise<ConnectFmuPackage | null> {
  try {
    return await json<ConnectFmuPackage>(await call(`/fmu/${shaSegment(sha)}`, { method: 'GET' }, opts, 'FMU lookup'));
  } catch (e) {
    if (e instanceof ConnectFmuError && e.isNotFound) return null;
    throw e;
  }
}

/**
 * `POST /fmu` — upload the raw `.fmu` bytes. CONNECT verifies `sha` against the
 * bytes, unpacks with limits and answers 201 (new) or 200 (cache hit). Never
 * trusts the package.
 */
export async function uploadPackage(
  bytes: Uint8Array, sha: string, fileName: string, opts?: ConnectFmuCallOptions,
): Promise<ConnectFmuPackage> {
  const query = `?sha256=${shaSegment(sha)}&fileName=${encodeURIComponent(fileName)}`;
  const body = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer as ArrayBuffer
    : bytes.slice().buffer as ArrayBuffer;
  return json<ConnectFmuPackage>(await call(`/fmu${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Fmu-Sha256': sha },
    body,
  }, opts, 'FMU upload'));
}

/** `POST /fmu/{sha}/trust` — the person's decision; the browser's Origin is what CONNECT checks. */
export async function trust(sha: string, opts?: ConnectFmuCallOptions): Promise<void> {
  await call(`/fmu/${shaSegment(sha)}/trust`, { method: 'POST' }, opts, 'FMU trust');
}

/** `DELETE /fmu/{sha}/trust` — revoke; CONNECT stops the interfaces running the package. */
export async function revokeTrust(sha: string, opts?: ConnectFmuCallOptions): Promise<void> {
  await call(`/fmu/${shaSegment(sha)}/trust`, { method: 'DELETE' }, opts, 'FMU trust revoke');
}

/** `POST /fmu/instances` — atomic find-or-create of this instance's interface plus a new lease. */
export async function createInstance(
  req: ConnectFmuInstanceRequest, opts?: ConnectFmuCallOptions,
): Promise<ConnectFmuInstance> {
  return json<ConnectFmuInstance>(await call('/fmu/instances', {
    method: 'POST',
    body: JSON.stringify(req),
  }, opts, 'FMU instance'));
}

/** `POST /fmu/leases/{id}/renew` — 404 (`lease-unknown`) = expired; provision again. */
export async function renewLease(leaseId: string, opts?: ConnectFmuCallOptions): Promise<ConnectFmuLease> {
  return json<ConnectFmuLease>(await call(`/fmu/leases/${encodeURIComponent(leaseId)}/renew`, {
    method: 'POST',
  }, opts, 'FMU lease renew'));
}

/** `DELETE /fmu/leases/{id}` — release THIS tab's claim; the last one removes the interface. */
export async function releaseLease(leaseId: string, opts?: ConnectFmuCallOptions): Promise<void> {
  try {
    await call(`/fmu/leases/${encodeURIComponent(leaseId)}`, { method: 'DELETE' }, opts, 'FMU lease release');
  } catch (e) {
    // Already gone (expired / reaped) is what a release wanted anyway.
    if (e instanceof ConnectFmuError && e.isNotFound) return;
    throw e;
  }
}

/** Answer of `POST /fmu/leases/{id}/restart` (plan-502). */
export interface ConnectFmuRestart {
  interfaceId: string;
  /**
   * false = not restarted: the instance (re)started less than 1 s ago (`reason: 'debounced'`), or — for
   * `cause: 'signal'` — another tab's lease leads the restart loop (`reason: 'other-lease'`).
   */
  restarted: boolean;
  reason?: string;
  /** Start generation BEFORE the restart — the viewer waits for `/status` to report another one. */
  startGeneration?: number;
}

/**
 * Why a restart is asked for: `signal` = a `Restart` edge (a LogicStep loop — CONNECT follows ONE tab's
 * loop), `reset` = an explicit Play/Reset (always restarts, debounce aside).
 */
export type FmuRestartCause = 'signal' | 'reset';

/**
 * `POST /fmu/leases/{id}/restart` (plan-502) — restart the interface THIS lease holds, from its current
 * configuration, without touching any lease (works while other tabs hold leases too). 404 with
 * `lease-unknown` = the lease is gone; a 404 WITHOUT that reason = a gateway older than the route.
 */
export async function restartInstance(
  leaseId: string, opts?: ConnectFmuCallOptions, cause: FmuRestartCause = 'signal',
): Promise<ConnectFmuRestart> {
  return json<ConnectFmuRestart>(await call(`/fmu/leases/${encodeURIComponent(leaseId)}/restart?cause=${cause}`, {
    method: 'POST',
  }, opts, 'FMU restart'));
}

/** Worker state of one interface from `GET /status` (the path `connect-store.ts` polls). */
export interface ConnectFmuWorkerStatus {
  /** `Connected` | `Connecting` | `Reconnecting` | `Error` | `Stopped` | `Disabled` | … */
  status: string;
  error?: string | null;
  /** plan-502 — FMI worker starts of this interface (`details.startGeneration`); undefined on older gateways. */
  startGeneration?: number;
  /** plan-502 — simulation time of the FMU in seconds (`details.simTime`). */
  simTime?: number;
}

/** `GET /status` reduced to `{ interfaceId → worker status }`. */
export async function fetchWorkerStatuses(opts?: ConnectFmuCallOptions): Promise<Record<string, ConnectFmuWorkerStatus>> {
  const body = await json<{
    interfaces?: Array<{ id: string; status: string; error?: string | null; details?: Record<string, unknown> | null }>;
  }>(await call('/status', { method: 'GET' }, opts, 'CONNECT status'));
  const map: Record<string, ConnectFmuWorkerStatus> = {};
  for (const i of body.interfaces ?? []) {
    const st: ConnectFmuWorkerStatus = { status: i.status, error: i.error ?? null };
    const d = i.details && typeof i.details === 'object' ? i.details : null;
    if (d && typeof d.startGeneration === 'number') st.startGeneration = d.startGeneration;
    if (d && typeof d.simTime === 'number') st.simTime = d.simTime;
    map[i.id] = st;
  }
  return map;
}

/** The `/fmu` client as one object — the provisioning plugin's injectable seam. */
export interface ConnectFmuApi {
  getPackage: typeof getPackage;
  uploadPackage: typeof uploadPackage;
  trust: typeof trust;
  revokeTrust: typeof revokeTrust;
  createInstance: typeof createInstance;
  renewLease: typeof renewLease;
  releaseLease: typeof releaseLease;
  /** plan-502 — optional so a test double without it exercises the release + re-create fallback. */
  restartInstance?: typeof restartInstance;
  fetchWorkerStatuses: typeof fetchWorkerStatuses;
}

/** The production client. */
export const connectFmuApi: ConnectFmuApi = {
  getPackage, uploadPackage, trust, revokeTrust, createInstance, renewLease, releaseLease, restartInstance,
  fetchWorkerStatuses,
};
