// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-update-store — the CONNECT self-update state machine, outside React (plan-343 Phase 3).
 *
 * Deliberately NOT part of `connect-store.ts`: that store is read simultaneously by
 * `ConnectPanel.tsx`, `connect-plugin.tsx` and `ConnectOptionsWindow.tsx`, and its snapshot
 * contract is not meant for a long-running operation that outlives the component that started it.
 *
 * Two different lifetimes, handled differently on purpose:
 *   - **Unmount** (settings window closed, tab switched) leaves the in-memory state untouched and
 *     keeps polling while an operation is in flight — closing a window must not abandon a program
 *     swap that is already under way.
 *   - **Full browser reload** discards it, and the store rehydrates *exclusively* from
 *     `GET /update/status`. Nothing is persisted client-side; the server is the only truth.
 *
 * Two rules this module exists to enforce:
 *   1. **Success is a commit, never a `/health`.** A reachable `/health` after the restart means
 *      only "the connection is back". The operation is successful when — and only when —
 *      `/update/status` reports the terminal state `succeeded` (plan-343 section 2.4).
 *   2. **No raw transport error ever reaches the operator.** Every failure is one reason out of
 *      the closed set the gateway publishes (`UpdateReasons.All`), translated to exactly one
 *      sentence by {@link updateReasonSentence}.
 */

import { createStore } from './create-store';
import { connectRestFetch } from './connect-rest';
import { getConnectSnapshot } from './connect-store';

// ── Wire contract (mirrors src/Connect/Update + Api/UpdateEndpoints.cs) ──────

/** Release identity of a build: `{ semver, channel, build }` as `/health` and `/update/status` report it. */
export interface UpdateRelease {
  semver: string;
  channel: string;
  build: number | null;
}

/**
 * The unit of confirmation — the whole artifact identity, not just a version number.
 * Handed out by `/update/status` and passed back unchanged to `/update/apply`, which re-reads the
 * manifest and rejects any deviation with `manifest-changed`.
 */
export interface UpdateCandidate {
  channel: string;
  semver: string;
  build: number | null;
  sha256: string;
  url: string;
}

/** One channel's offer. `sizeBytes: null` means "size unknown" — no manifest form carries a size. */
export interface UpdateChannelOffer {
  candidate: UpdateCandidate;
  buildDate: string | null;
  sizeBytes: number | null;
  isNewer: boolean;
  isDowngrade: boolean;
  isCurrent: boolean;
  isChannelSwitch: boolean;
}

/** Download progress; `totalBytes: null` when the server sent no `Content-Length`. */
export interface UpdateProgress {
  receivedBytes: number;
  totalBytes: number | null;
  fraction: number | null;
}

/**
 * The states an update job passes through. Mirrors `UpdateStates` in C#.
 *
 * `downloaded` is the terminal success of the download-only flow: the verified new program file
 * lies beside the running one and the operator installs it by stopping CONNECT and starting the
 * downloaded file. `staging`/`restarting`/`verifying-health`/`succeeded`/`rolled-back` remain in
 * the vocabulary for gateways older than this build, which still perform the background swap.
 */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'downloaded'
  | 'staging'
  | 'restarting'
  | 'verifying-health'
  | 'succeeded'
  | 'failed'
  | 'rolled-back';

/** True when no further work is pending for a job in this state. */
export function isTerminalPhase(phase: UpdatePhase): boolean {
  return phase === 'downloaded' || phase === 'succeeded' || phase === 'failed' || phase === 'rolled-back';
}

/** True while the gateway is carrying an operation out (nothing may be offered meanwhile). */
export function isBusyPhase(phase: UpdatePhase): boolean {
  return phase === 'downloading' || phase === 'verifying' || phase === 'staging'
    || phase === 'restarting' || phase === 'verifying-health';
}

/**
 * Feature detection result from `/health`.
 *   - `unknown`    — not probed yet.
 *   - `unsupported`— the gateway does not know the `updateSupported` flag at all: an older build,
 *                    which must show no update surface whatsoever (plan-343 Phase 3, T25).
 *   - `supported`  — the gateway knows the feature; whether it may update *right now* is a
 *                    separate question answered by `supported` + `reason`.
 */
export type UpdateGateway = 'unknown' | 'unsupported' | 'supported';

export interface ConnectUpdateSnapshot {
  gateway: UpdateGateway;
  /** `updateSupported` from the gateway: may this installation update itself right now? */
  supported: boolean;
  /** Structural reason why it may not (`no-api-key`, `not-supported`, …), else null. */
  reason: string | null;
  current: UpdateRelease | null;
  selectedChannel: string;
  /** Offers keyed by channel. A channel is absent when it offers nothing (404 = no build). */
  channels: Record<string, UpdateChannelOffer>;
  phase: UpdatePhase;
  /** Reason belonging to a `failed` / `rolled-back` phase. */
  jobReason: string | null;
  progress: UpdateProgress | null;
  /** Where the finished download lies (phase `downloaded`) — the file the operator has to start. */
  downloadedPath: string | null;
  pinWillChange: boolean;
  pinPath: string | null;
  /** True while the gateway is restarting and the viewer is re-establishing the connection. */
  reconnecting: boolean;
  reconnectAttempt: number;
  /** A `POST /update/apply` is in flight (button disabled, no second confirmation). */
  applying: boolean;
  /** The candidate the operator confirmed — the reference for the post-restart health check. */
  expected: UpdateCandidate | null;
  /** Client-side failure reason (transport / version mismatch), already in the closed vocabulary. */
  clientReason: string | null;
}

// ── Reasons ─────────────────────────────────────────────────────────────────

/**
 * Reasons the *client* can produce. They extend the gateway's closed set rather than replacing it,
 * so every path through the UI still ends in exactly one known sentence.
 */
export const CLIENT_REASONS = {
  /** After the restart `/health` answers, but with a release other than the confirmed one. */
  VersionMismatch: 'version-mismatch',
  /** The gateway could not be reached at all while nothing was being updated. */
  Unreachable: 'unreachable',
} as const;

/**
 * Exactly one plain sentence per reason (plan-343 section 3.4). Never a raw HTTP error, never a
 * stack trace. Kept in one place so the closed set and its translation cannot drift apart — the
 * accompanying test walks the gateway's `UpdateReasons.All` and asserts full coverage.
 */
const REASON_SENTENCES: Record<string, string> = {
  // ── gateway reasons (UpdateReasons.All) ──
  'no-network': 'The download was blocked. This happens in company networks with a proxy. The version can also be installed by hand.',
  'manifest-invalid': 'The update information from the server could not be read. Please try again later.',
  'manifest-changed': 'A different build is being offered than the one you confirmed. Please check again and confirm the new one.',
  'checksum-mismatch': 'The downloaded file does not match its checksum and was discarded. CONNECT was not changed.',
  'signature-invalid': 'The downloaded file does not carry a valid realvirtual signature and was discarded. CONNECT was not changed.',
  'signature-unverifiable': 'The signature could not be checked because the revocation service was unreachable. This usually happens behind a proxy. CONNECT was not changed.',
  'no-write-permission': 'CONNECT may not change its own program directory. Please move the installation to a writable directory.',
  'other-instance-running': 'A second CONNECT instance is still running from the same program file. Please close it first.',
  'update-in-progress': 'An update is already running. Please wait until it has finished.',
  'swap-failed': 'The program file could not be replaced. The previous version is running again.',
  'restart-failed': 'The new version could not be started. The previous version is running again.',
  'health-timeout': 'The new version did not start. The previous version is running again.',
  'pin-write-failed': 'The project file connect.lock.json could not be written, so the update was rolled back. The previous version is running again.',
  'no-api-key': 'An API key must be set in CONNECT for updates.',
  'not-supported': 'This installation does not offer updates.',
  // ── client reasons ──
  [CLIENT_REASONS.VersionMismatch]: 'After the restart CONNECT reports a different version than the one confirmed. Please check the installation.',
  [CLIENT_REASONS.Unreachable]: 'CONNECT could not be reached. Please check the connection.',
};

/**
 * Translates a reason into its one sentence. An unknown reason — which the closed set is meant to
 * prevent — still yields a sentence rather than leaking a raw token to the operator.
 */
export function updateReasonSentence(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REASON_SENTENCES[reason]
    ?? 'The update could not be completed. The previous version is running unchanged.';
}

/** Every reason this module can translate — the test asserts it covers the gateway's closed set. */
export function knownUpdateReasons(): string[] {
  return Object.keys(REASON_SENTENCES);
}

// ── Timings ─────────────────────────────────────────────────────────────────

/** Poll periods and the reconnect backoff. Overridable in tests via {@link __setConnectUpdateTimings}. */
export interface ConnectUpdateTimings {
  /** Poll period while nothing is happening (the window is open but idle). */
  idlePollMs: number;
  /** Poll period while the gateway is working on an operation. */
  activePollMs: number;
  /** First reconnect delay after the gateway went away. */
  reconnectBaseMs: number;
  /** Upper bound of the exponential reconnect backoff. */
  reconnectMaxMs: number;
  /** Total budget for re-establishing the connection before giving up with `health-timeout`. */
  reconnectTimeoutMs: number;
}

const DEFAULT_TIMINGS: ConnectUpdateTimings = {
  idlePollMs: 60_000,
  activePollMs: 1_000,
  reconnectBaseMs: 500,
  reconnectMaxMs: 4_000,
  reconnectTimeoutMs: 180_000,
};

let timings: ConnectUpdateTimings = { ...DEFAULT_TIMINGS };

/** Test seam: shorten the timings so the state machine can be driven deterministically. */
export function __setConnectUpdateTimings(partial: Partial<ConnectUpdateTimings>): void {
  timings = { ...timings, ...partial };
}

// ── Store ───────────────────────────────────────────────────────────────────

function initialSnapshot(): ConnectUpdateSnapshot {
  return {
    gateway: 'unknown',
    supported: false,
    reason: null,
    current: null,
    selectedChannel: 'stable',
    channels: {},
    phase: 'idle',
    jobReason: null,
    progress: null,
    downloadedPath: null,
    pinWillChange: false,
    pinPath: null,
    reconnecting: false,
    reconnectAttempt: 0,
    applying: false,
    expected: null,
    clientReason: null,
  };
}

const _store = createStore<ConnectUpdateSnapshot>(initialSnapshot());

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let reconnectDeadline = 0;
/** The gateway URL the current capability verdict was established for. */
let probedUrl = '';
/** True from an accepted `apply` until the job reaches a terminal state — keeps the loop alive
 *  even with no watcher left, so closing the window cannot abandon a running program swap. */
let operationActive = false;

function set(partial: Partial<ConnectUpdateSnapshot>): void {
  _store.set(partial);
}

function snapshot(): ConnectUpdateSnapshot {
  return _store.getSnapshot();
}

function baseUrl(): string {
  return getConnectSnapshot().serverUrl.replace(/\/$/, '');
}

// ── Polling loop ────────────────────────────────────────────────────────────

function shouldRun(): boolean {
  return watchers > 0 || operationActive;
}

function nextDelay(): number {
  const snap = snapshot();
  if (snap.reconnecting) {
    const backoff = timings.reconnectBaseMs * 2 ** Math.max(0, snap.reconnectAttempt - 1);
    return Math.min(backoff, timings.reconnectMaxMs);
  }
  return operationActive || isBusyPhase(snap.phase) ? timings.activePollMs : timings.idlePollMs;
}

function schedule(delayMs: number): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void tick();
  }, delayMs);
}

async function tick(): Promise<void> {
  if (!shouldRun()) return;
  try {
    await pollOnce();
  } catch {
    // pollOnce translates everything it can; a throw here must still not break the loop.
  }
  if (shouldRun()) schedule(nextDelay());
}

async function pollOnce(): Promise<void> {
  if (snapshot().reconnecting) {
    await probeHealthDuringReconnect();
    return;
  }
  // The capability verdict belongs to one gateway. Pointing the window at a different server (or
  // reconnecting to an upgraded one) has to re-open the question instead of inheriting the answer.
  if (probedUrl !== baseUrl()) {
    probedUrl = baseUrl();
    set({ gateway: 'unknown', channels: {}, supported: false, reason: null });
  }
  if (snapshot().gateway === 'unknown') await probeGateway();
  // An older gateway has no update endpoint at all — it is never asked for a status, neither on
  // this tick nor on any later one.
  if (snapshot().gateway !== 'supported') return;
  await fetchStatus();
}

/**
 * Starts (or joins) the polling loop and returns the detach function.
 *
 * Detaching is *not* a stop: an operation in flight keeps the loop running so that closing the
 * settings window mid-update does not orphan the job (plan-343 T23a).
 */
export function attachConnectUpdates(): () => void {
  watchers++;
  schedule(0);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    watchers = Math.max(0, watchers - 1);
    if (!shouldRun() && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

/** Forces one immediate refresh from the gateway (used on window open and after an apply). */
export async function refreshConnectUpdates(): Promise<void> {
  await pollOnce();
}

// ── Gateway probes ──────────────────────────────────────────────────────────

interface HealthBody {
  status?: string;
  updateSupported?: boolean;
  release?: { semver?: string; channel?: string; build?: number | null };
}

/**
 * Feature detection over `/health`, the same mechanism the viewer already uses for `stepImport`
 * and `jtImport`. A gateway that does not send `updateSupported` at all is an older build and gets
 * no update surface — not an error message, simply nothing (T25).
 */
async function probeGateway(): Promise<void> {
  let health: HealthBody;
  try {
    const response = await connectRestFetch(`${baseUrl()}/health`);
    if (!response.ok) return; // transient — stay 'unknown' and try again on the next tick
    health = await response.json() as HealthBody;
  } catch {
    return; // not reachable right now; nothing is claimed about the gateway's capabilities
  }
  if (typeof health.updateSupported !== 'boolean') {
    set({ gateway: 'unsupported', supported: false });
    return;
  }
  set({ gateway: 'supported' });
}

interface StatusBody {
  updateSupported?: boolean;
  reason?: string | null;
  current?: { semver?: string; channel?: string; build?: number | null };
  selectedChannel?: string;
  state?: string;
  jobReason?: string | null;
  progress?: { receivedBytes?: number; totalBytes?: number | null; fraction?: number | null } | null;
  downloadedPath?: string | null;
  pinWillChange?: boolean;
  pinPath?: string | null;
  channels?: Record<string, UpdateChannelOffer>;
}

/** Reads `/update/status` and installs it as the new truth. */
async function fetchStatus(): Promise<void> {
  let body: StatusBody;
  try {
    const response = await connectRestFetch(`${baseUrl()}/update/status`);
    if (!response.ok) {
      // 404 = the endpoint does not exist (older gateway); 401 = the key is not accepted. Neither
      // is something the operator can be told in this surface, so it simply shows nothing.
      if (response.status === 404) set({ gateway: 'unsupported', supported: false });
      return;
    }
    body = await response.json() as StatusBody;
  } catch {
    // The gateway went away. While an operation is in flight that is the expected restart, not an
    // error — anything else keeps the last known state and retries.
    if (operationActive || isBusyPhase(snapshot().phase)) enterReconnect();
    return;
  }

  const phase = (body.state ?? 'idle') as UpdatePhase;
  set({
    supported: body.updateSupported === true,
    reason: body.reason ?? null,
    current: body.current
      ? {
        semver: body.current.semver ?? '',
        channel: body.current.channel ?? 'stable',
        build: body.current.build ?? null,
      }
      : null,
    selectedChannel: body.selectedChannel ?? 'stable',
    channels: body.channels ?? {},
    phase,
    jobReason: body.jobReason ?? null,
    progress: body.progress
      ? {
        receivedBytes: body.progress.receivedBytes ?? 0,
        totalBytes: body.progress.totalBytes ?? null,
        fraction: body.progress.fraction ?? null,
      }
      : null,
    downloadedPath: body.downloadedPath ?? null,
    pinWillChange: body.pinWillChange === true,
    pinPath: body.pinPath ?? null,
  });

  if (isTerminalPhase(phase)) {
    operationActive = false;
    set({ reconnecting: false, reconnectAttempt: 0 });
  }
}

// ── Restart window ──────────────────────────────────────────────────────────

function enterReconnect(): void {
  if (snapshot().reconnecting) return;
  reconnectDeadline = Date.now() + timings.reconnectTimeoutMs;
  set({ reconnecting: true, reconnectAttempt: 0 });
}

function releaseMatches(release: HealthBody['release'], expected: UpdateCandidate | null): boolean {
  if (!expected) return true; // nothing to compare against (e.g. after a reload) — trust the status
  if (!release) return false;
  if (release.semver !== expected.semver) return false;
  // The build is only compared when the confirmed candidate carried one.
  return expected.build == null || (release.build ?? null) === expected.build;
}

/**
 * Polls `/health` across the restart with a bounded exponential backoff.
 *
 * A reachable `/health` is **not** success — it only ends the reconnect phase and hands back to
 * `/update/status`, where only the terminal `succeeded` counts (plan-343 section 2.4, T24b). A
 * `/health` that answers with a release other than the confirmed one is a failure, not a success
 * (T24).
 */
async function probeHealthDuringReconnect(): Promise<void> {
  let health: HealthBody;
  try {
    const response = await connectRestFetch(`${baseUrl()}/health`);
    if (!response.ok) throw new Error('not ok');
    health = await response.json() as HealthBody;
  } catch {
    set({ reconnectAttempt: snapshot().reconnectAttempt + 1 });
    if (Date.now() >= reconnectDeadline) failClient('health-timeout');
    return;
  }

  if (!releaseMatches(health.release, snapshot().expected)) {
    failClient(CLIENT_REASONS.VersionMismatch);
    return;
  }

  // Connection is back. Success still has to be earned by a terminal `succeeded`.
  set({ reconnecting: false, reconnectAttempt: 0 });
  await fetchStatus();
}

/** Ends the operation client-side with a reason from the closed vocabulary. */
function failClient(reason: string): void {
  operationActive = false;
  set({
    phase: 'failed',
    reconnecting: false,
    reconnectAttempt: 0,
    clientReason: reason,
    jobReason: reason,
    progress: null,
  });
}

// ── Apply ───────────────────────────────────────────────────────────────────

/**
 * Confirms a candidate and hands it to `POST /update/apply`.
 *
 * The confirmed candidate is stored as the expected release: it is what the post-restart `/health`
 * is checked against. A rejection carries the gateway's machine-readable reason, never the HTTP
 * status — which is why this does not go through `connectRestJson` (whose error path would flatten
 * `{ ok, reason, state }` into "HTTP 409").
 */
export async function applyConnectUpdate(candidate: UpdateCandidate): Promise<boolean> {
  if (snapshot().applying) return false;
  set({ applying: true, clientReason: null, jobReason: null });

  try {
    const response = await connectRestFetch(`${baseUrl()}/update/apply`, {
      method: 'POST',
      body: JSON.stringify({ candidate }),
    });

    let body: { ok?: boolean; reason?: string | null; state?: string } = {};
    try {
      body = await response.json() as typeof body;
    } catch {
      // A body-less answer is judged by its status alone.
    }

    if (!response.ok || body.ok !== true) {
      set({
        applying: false,
        phase: 'failed',
        jobReason: body.reason ?? CLIENT_REASONS.Unreachable,
        clientReason: body.reason ? null : CLIENT_REASONS.Unreachable,
      });
      return false;
    }

    operationActive = true;
    set({
      applying: false,
      expected: candidate,
      phase: (body.state ?? 'downloading') as UpdatePhase,
      jobReason: null,
      clientReason: null,
    });
    schedule(timings.activePollMs);
    return true;
  } catch {
    set({ applying: false, phase: 'failed', jobReason: CLIENT_REASONS.Unreachable, clientReason: CLIENT_REASONS.Unreachable });
    return false;
  }
}

// ── Public store handle ─────────────────────────────────────────────────────

/**
 * There is deliberately no "dismiss": the gateway remembers how the last attempt ended and reports
 * it on every status read, so a client-side dismissal would be undone by the next poll. The outcome
 * disappears when the gateway itself stops reporting one.
 */
export const connectUpdateStore = {
  subscribe: _store.subscribe,
  getSnapshot: _store.getSnapshot,
  attach: attachConnectUpdates,
  refresh: refreshConnectUpdates,
  apply: applyConnectUpdate,
};

/**
 * Test seam: the equivalent of a full browser reload. Everything in memory is dropped; the next
 * refresh has to reconstruct the state from `/update/status` alone (plan-343 T23b).
 */
export function __resetConnectUpdateStore(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  watchers = 0;
  operationActive = false;
  reconnectDeadline = 0;
  probedUrl = '';
  timings = { ...DEFAULT_TIMINGS };
  _store.set(() => initialSnapshot());
}

// ── Formatting helpers (shared by the section and the dialog) ───────────────

/** Human-readable download size, or "Size unknown" when the server sent no `Content-Length`. */
export function formatUpdateSize(sizeBytes: number | null | undefined): string {
  if (sizeBytes == null || sizeBytes <= 0) return 'Size unknown';
  const mb = sizeBytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** `0.3.0 · build 31 · 2026-07-31`, dropping the parts the gateway did not report. */
export function formatUpdateRelease(semver: string, build: number | null, buildDate?: string | null): string {
  const parts = [semver];
  if (build != null) parts.push(`build ${build}`);
  if (buildDate) parts.push(buildDate);
  return parts.join(' · ');
}

/** `stable` → `Stable`. The channel is always named in full; a beta is never implied. */
export function channelLabel(channel: string): string {
  return channel === 'beta' ? 'Beta' : 'Stable';
}
