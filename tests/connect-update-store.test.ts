// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-343 Phase 3 — the CONNECT self-update state machine in the viewer.
 *
 * Covers T22 (state machine incl. reconnect backoff and timeout), T23a (unmount keeps the state),
 * T23b (a full reload rebuilds it from `/update/status` alone), T24 (a different version after the
 * restart is a failure, not a success) and T24b (a matching `/health` alone is never success; a
 * rollback after a failed pin commit is shown as a rollback).
 *
 * The one rule almost every assertion here exists to protect: **success is the terminal
 * `succeeded` state and nothing else.** A reachable `/health` says only that the connection is
 * back — the gateway still has to commit pin and job.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectUpdateStore,
  __resetConnectUpdateStore,
  __setConnectUpdateTimings,
  updateReasonSentence,
  knownUpdateReasons,
  CLIENT_REASONS,
  type UpdateCandidate,
} from '../src/core/hmi/connect-update-store';
import { setServerUrl } from '../src/core/hmi/connect-store';

const SERVER = 'http://update.test:5100';

/** The gateway's closed reason set — the C# side is `UpdateReasons.All`. */
const GATEWAY_REASONS = [
  'no-network', 'manifest-invalid', 'manifest-changed', 'checksum-mismatch', 'signature-invalid',
  'signature-unverifiable', 'no-write-permission', 'other-instance-running', 'update-in-progress',
  'swap-failed', 'restart-failed', 'health-timeout', 'pin-write-failed', 'no-api-key',
  'not-supported',
];

const STABLE_CANDIDATE: UpdateCandidate = {
  channel: 'stable',
  semver: '0.3.0',
  build: 31,
  sha256: 'a'.repeat(64),
  url: 'https://web.realvirtual.io/download/versions/connect-0.3.0.exe',
};

/** Mutable gateway stub — every test drives the state machine by editing this. */
interface Gateway {
  healthDown: boolean;
  statusDown: boolean;
  /** `undefined` = an older gateway that does not know the flag at all. */
  updateSupported: boolean | undefined;
  release: { semver: string; channel: string; build: number | null };
  status: Record<string, unknown>;
  applyStatus: number;
  applyBody: Record<string, unknown>;
  calls: { health: number; status: number; apply: number };
}

let gw: Gateway;

function freshGateway(): Gateway {
  return {
    healthDown: false,
    statusDown: false,
    updateSupported: true,
    release: { semver: '0.2.0', channel: 'stable', build: 25 },
    status: {
      updateSupported: true,
      reason: null,
      current: { semver: '0.2.0', channel: 'stable', build: 25 },
      selectedChannel: 'stable',
      state: 'available',
      jobReason: null,
      progress: null,
      pinWillChange: false,
      pinPath: null,
      channels: {
        stable: {
          candidate: STABLE_CANDIDATE,
          buildDate: '2026-07-31',
          sizeBytes: 25_000_000,
          isNewer: true,
          isDowngrade: false,
          isCurrent: false,
          isChannelSwitch: false,
        },
      },
    },
    applyStatus: 200,
    applyBody: { ok: true, state: 'downloading' },
    calls: { health: 0, status: 0, apply: 0 },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installGateway(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

    if (url.endsWith('/health')) {
      gw.calls.health++;
      if (gw.healthDown) throw new TypeError('Failed to fetch');
      const body: Record<string, unknown> = { status: 'ok', version: gw.release.semver, release: gw.release };
      if (gw.updateSupported !== undefined) body.updateSupported = gw.updateSupported;
      return json(body);
    }
    if (url.endsWith('/update/status')) {
      gw.calls.status++;
      if (gw.statusDown) throw new TypeError('Failed to fetch');
      return json(gw.status);
    }
    if (url.endsWith('/update/apply')) {
      gw.calls.apply++;
      return json(gw.applyBody, gw.applyStatus);
    }
    return new Response('', { status: 404 });
  }));
}

/** Polls until `predicate` holds — the store is driven by real (very short) timers. */
async function until(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const snap = () => connectUpdateStore.getSnapshot();

/** Records every phase the store passes through, so "was never successful" is assertable. */
function recordPhases(): string[] {
  const seen: string[] = [];
  connectUpdateStore.subscribe(() => {
    const phase = snap().phase;
    if (seen[seen.length - 1] !== phase) seen.push(phase);
  });
  return seen;
}

beforeEach(() => {
  __resetConnectUpdateStore();
  gw = freshGateway();
  installGateway();
  setServerUrl(SERVER);
  __setConnectUpdateTimings({
    idlePollMs: 20,
    activePollMs: 10,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    reconnectTimeoutMs: 300,
  });
});

afterEach(() => {
  __resetConnectUpdateStore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── T22 ─────────────────────────────────────────────────────────────────────

describe('T22 — the update state machine', () => {
  it('walks available → downloading → verifying → restarting → verifying-health → succeeded', async () => {
    const phases = recordPhases();
    const detach = connectUpdateStore.attach();

    await until(() => snap().phase === 'available', 'the stable offer to arrive');
    expect(snap().channels.stable.candidate.semver).toBe('0.3.0');
    expect(snap().supported).toBe(true);

    // Confirming hands the whole candidate back — not just a version number.
    gw.status = { ...gw.status, state: 'downloading', progress: { receivedBytes: 10, totalBytes: 100, fraction: 0.1 } };
    expect(await connectUpdateStore.apply(STABLE_CANDIDATE)).toBe(true);
    const applyBody = JSON.parse((vi.mocked(fetch).mock.calls.find(
      (c) => String(c[0]).endsWith('/update/apply'),
    )![1] as RequestInit).body as string);
    expect(applyBody.candidate).toEqual(STABLE_CANDIDATE);

    await until(() => snap().phase === 'downloading', 'the download to start');
    // The apply answer already carries the state; the progress arrives with the first poll after it.
    await until(() => snap().progress?.fraction != null, 'download progress to be polled');
    expect(snap().progress?.fraction).toBeCloseTo(0.1);

    gw.status = { ...gw.status, state: 'verifying', progress: null };
    await until(() => snap().phase === 'verifying', 'signature verification');

    // The gateway hands over to the helper and disappears.
    gw.status = { ...gw.status, state: 'restarting' };
    await until(() => snap().phase === 'restarting', 'the restart phase');
    gw.statusDown = true;
    gw.healthDown = true;
    await until(() => snap().reconnecting, 'the reconnect phase to begin');

    // The new version answers /health — which is NOT yet success.
    gw.release = { semver: '0.3.0', channel: 'stable', build: 31 };
    gw.status = { ...gw.status, state: 'verifying-health', current: gw.release };
    gw.healthDown = false;
    gw.statusDown = false;
    await until(() => snap().phase === 'verifying-health', 'health verification');
    expect(snap().reconnecting).toBe(false);

    gw.status = { ...gw.status, state: 'succeeded' };
    await until(() => snap().phase === 'succeeded', 'the terminal success');

    expect(phases).toContain('downloading');
    expect(phases).toContain('restarting');
    expect(phases).toContain('verifying-health');
    // Success came last and exactly once — never before the commit.
    expect(phases[phases.length - 1]).toBe('succeeded');
    expect(phases.filter((p) => p === 'succeeded')).toHaveLength(1);
    detach();
  });

  it('backs off between reconnect probes and gives up with health-timeout', async () => {
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.status = { ...gw.status, state: 'restarting' };
    await connectUpdateStore.apply(STABLE_CANDIDATE);
    await until(() => snap().phase === 'restarting', 'the restart phase');

    // The gateway never comes back at all.
    gw.statusDown = true;
    gw.healthDown = true;
    await until(() => snap().reconnecting, 'the reconnect phase');

    // The backoff grows: several probes are attempted before the budget runs out.
    await until(() => snap().reconnectAttempt >= 3, 'repeated reconnect attempts');

    await until(() => snap().phase === 'failed', 'the reconnect budget to run out');
    expect(snap().jobReason).toBe('health-timeout');
    expect(updateReasonSentence(snap().jobReason)).toMatch(/did not start/i);
    detach();
  });

  it('rejects an apply with the gateway reason, never a raw HTTP status', async () => {
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.applyStatus = 409;
    gw.applyBody = { ok: false, reason: 'manifest-changed', state: 'idle' };
    expect(await connectUpdateStore.apply(STABLE_CANDIDATE)).toBe(false);

    expect(snap().jobReason).toBe('manifest-changed');
    expect(updateReasonSentence(snap().jobReason)).not.toMatch(/HTTP|409/);
    detach();
  });
});

// ── T23a / T23b ─────────────────────────────────────────────────────────────

describe('T23a — closing the window does not abandon the update', () => {
  it('keeps the in-memory state and keeps polling after unmount', async () => {
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.status = { ...gw.status, state: 'downloading' };
    await connectUpdateStore.apply(STABLE_CANDIDATE);
    await until(() => snap().phase === 'downloading', 'the download');

    // The settings window is closed mid-update.
    detach();

    expect(snap().phase).toBe('downloading');
    expect(snap().expected).toEqual(STABLE_CANDIDATE);

    // The operation keeps being followed with no component mounted.
    const before = gw.calls.status;
    await until(() => gw.calls.status > before + 1, 'polling to continue without a watcher');

    gw.status = { ...gw.status, state: 'succeeded' };
    await until(() => snap().phase === 'succeeded', 'the update to finish unattended');
  });

  it('stops polling once nothing is in flight and the last watcher leaves', async () => {
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');
    detach();

    const before = gw.calls.status;
    await new Promise((r) => setTimeout(r, 80));
    expect(gw.calls.status).toBe(before);
  });
});

describe('T23b — a full reload rebuilds the state from /update/status alone', () => {
  it('starts empty after a reload and reconstructs everything from the server', async () => {
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');
    detach();

    // A reload drops everything in memory.
    __resetConnectUpdateStore();
    __setConnectUpdateTimings({ idlePollMs: 20, activePollMs: 10 });
    expect(snap().phase).toBe('idle');
    expect(snap().gateway).toBe('unknown');
    expect(snap().channels).toEqual({});

    // Nothing about the update lives in localStorage — the server is the only truth.
    const keys = Object.keys(localStorage);
    expect(keys.filter((k) => /update/i.test(k))).toEqual([]);

    // The gateway is mid-update; the freshly loaded viewer learns that from the status alone.
    gw.status = {
      ...gw.status,
      state: 'downloading',
      progress: { receivedBytes: 50, totalBytes: 100, fraction: 0.5 },
      pinWillChange: true,
      pinPath: 'C:/ws/connect.lock.json',
    };

    const detach2 = connectUpdateStore.attach();
    await until(() => snap().phase === 'downloading', 'the state to be rebuilt from /update/status');
    expect(snap().progress?.fraction).toBeCloseTo(0.5);
    expect(snap().pinWillChange).toBe(true);
    expect(snap().pinPath).toBe('C:/ws/connect.lock.json');
    detach2();
  });
});

// ── T24 / T24b ──────────────────────────────────────────────────────────────

describe('T24 — a different version after the restart is a failure', () => {
  it('reports an error instead of success when /health returns an unexpected release', async () => {
    const phases = recordPhases();
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.status = { ...gw.status, state: 'restarting' };
    await connectUpdateStore.apply(STABLE_CANDIDATE);
    await until(() => snap().phase === 'restarting', 'the restart phase');

    gw.statusDown = true;
    gw.healthDown = true;
    await until(() => snap().reconnecting, 'the reconnect phase');

    // Something came back — but not what was confirmed (0.3.0 build 31).
    gw.release = { semver: '0.2.0', channel: 'stable', build: 25 };
    gw.healthDown = false;
    await until(() => snap().phase === 'failed', 'the mismatch to be detected');

    expect(snap().jobReason).toBe(CLIENT_REASONS.VersionMismatch);
    expect(updateReasonSentence(snap().jobReason)).toMatch(/different version/i);
    expect(phases).not.toContain('succeeded');
    detach();
  });
});

describe('T24b — a matching /health is never success on its own', () => {
  it('shows no success while /update/status is still verifying-health', async () => {
    const phases = recordPhases();
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.status = { ...gw.status, state: 'restarting' };
    await connectUpdateStore.apply(STABLE_CANDIDATE);
    await until(() => snap().phase === 'restarting', 'the restart phase');
    gw.statusDown = true;
    gw.healthDown = true;
    await until(() => snap().reconnecting, 'the reconnect phase');

    // The new version is up and /health matches exactly — but the job is not committed yet.
    gw.release = { semver: '0.3.0', channel: 'stable', build: 31 };
    gw.status = { ...gw.status, state: 'verifying-health', current: gw.release };
    gw.healthDown = false;
    gw.statusDown = false;

    await until(() => snap().phase === 'verifying-health', 'the health-verification phase');
    const statusCalls = gw.calls.status;
    await until(() => gw.calls.status > statusCalls + 2, 'several further status polls');

    // Health has been matching for several polls and STILL nothing claims success.
    expect(snap().phase).toBe('verifying-health');
    expect(phases).not.toContain('succeeded');
    detach();
  });

  it('shows the rollback when the pin commit fails after a matching /health', async () => {
    const phases = recordPhases();
    const detach = connectUpdateStore.attach();
    await until(() => snap().phase === 'available', 'the offer');

    gw.status = { ...gw.status, state: 'restarting' };
    await connectUpdateStore.apply(STABLE_CANDIDATE);
    await until(() => snap().phase === 'restarting', 'the restart phase');
    gw.statusDown = true;
    gw.healthDown = true;
    await until(() => snap().reconnecting, 'the reconnect phase');

    gw.release = { semver: '0.3.0', channel: 'stable', build: 31 };
    gw.status = { ...gw.status, state: 'verifying-health', current: gw.release };
    gw.healthDown = false;
    gw.statusDown = false;
    await until(() => snap().phase === 'verifying-health', 'the health-verification phase');

    // The pin could not be committed, so the helper rolled everything back.
    gw.release = { semver: '0.2.0', channel: 'stable', build: 25 };
    gw.status = { ...gw.status, state: 'rolled-back', jobReason: 'pin-write-failed', current: gw.release };
    await until(() => snap().phase === 'rolled-back', 'the rollback to be reported');

    expect(snap().jobReason).toBe('pin-write-failed');
    expect(updateReasonSentence(snap().jobReason)).toMatch(/rolled back/i);
    // Not once, at any point, was success claimed.
    expect(phases).not.toContain('succeeded');
    detach();
  });
});

// ── Reason vocabulary (T17, viewer half) ────────────────────────────────────

describe('every gateway reason becomes exactly one sentence', () => {
  it('covers the closed set from UpdateReasons.All', () => {
    for (const reason of GATEWAY_REASONS) {
      expect(knownUpdateReasons(), `reason '${reason}' has no sentence`).toContain(reason);
      const sentence = updateReasonSentence(reason)!;
      expect(sentence.length).toBeGreaterThan(10);
      // No raw transport detail ever reaches the operator.
      expect(sentence).not.toMatch(/HTTP|\bstack\b|undefined|\b[45]\d\d\b/);
    }
  });

  it('gives distinct sentences to restart-failed and health-timeout', () => {
    // Two different things (plan-343 section 2.4) that must never be conflated.
    expect(updateReasonSentence('restart-failed')).not.toBe(updateReasonSentence('health-timeout'));
  });

  it('never leaks an unknown reason token to the operator', () => {
    const sentence = updateReasonSentence('something-we-never-defined')!;
    expect(sentence).not.toMatch(/something-we-never-defined/);
    expect(sentence.length).toBeGreaterThan(10);
  });
});
