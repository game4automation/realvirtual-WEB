// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * launch-viewer-agent.node.test.ts — plan-564 Phase 3: the pure core of
 * `npm run viewer:agent` (scripts/launch-viewer-chrome.mjs), run against fakes.
 * Chrome, CDP and CONNECT are not started: URL construction, the origin-bound
 * init script, the consent contract, the flag rules and the wait/timeout logic
 * (own claim + roundtrip in the same generation) are what decide whether the
 * launcher reports the RIGHT tab.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script without type declarations
import * as launcher from '../scripts/launch-viewer-chrome.mjs';
import { AI_BRIDGE_CONSENT_VERSION } from '../src/core/hmi/ai-consent-store';
import { AI_BRIDGE_CONSENT_KEY } from '../src/core/hmi/rv-storage-keys';

interface ActiveInfo { claimId: string | null; tools: number; visible?: boolean; legacy?: boolean }
interface Status { clients: number; generation: number; active: ActiveInfo | null; standby: unknown[] }

const {
  buildAgentUrl, buildInitScript, parseLauncherArgs, readConsentContract, waitForOwnClaim, describeBridgeStatus,
} = launcher as {
  buildAgentUrl: (url: string, token: string, doc?: string | null) => string;
  buildInitScript: (o: { origin: string; bridgePort: string; consentKey: string; consentVersion: string }) => string;
  parseLauncherArgs: (argv: string[]) => Record<string, unknown>;
  readConsentContract: () => { version: string; key: string };
  waitForOwnClaim: (o: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string; diagnosis?: string }>;
  describeBridgeStatus: (s: Status | null, claimId: string) => string;
};

/** Run the init script in a fake page of the given origin; returns what it stored. */
function runInitScript(script: string, origin: string): Map<string, string> {
  const store = new Map<string, string>();
  const localStorage = { setItem: (k: string, v: string) => { store.set(k, v); } };
  new Function('location', 'localStorage', script)({ origin }, localStorage);
  return store;
}

/** A deterministic clock: sleep advances time instead of waiting. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

const status = (active: ActiveInfo | null, generation = 3): Status =>
  ({ clients: active ? 2 : 0, generation, active, standby: active ? [{}] : [] });

describe('agent URL and flags', () => {
  it('adds claim, session decline and document, keeping existing parameters', () => {
    const url = new URL(buildAgentUrl('http://localhost:5100/?project=demo', 'tok/+=', 'cell-7'));
    expect(url.origin).toBe('http://localhost:5100');
    expect(url.searchParams.get('project')).toBe('demo');
    expect(url.searchParams.get('mcpClaim')).toBe('tok/+=');
    expect(url.searchParams.get('consent')).toBe('decline');
    expect(url.searchParams.get('doc')).toBe('cell-7');
    expect(new URL(buildAgentUrl('http://localhost:5100/', 't', null)).searchParams.has('doc')).toBe(false);
  });

  it('--agent with --no-debug-port is an error; the agent gets its own profile', () => {
    expect(parseLauncherArgs(['--agent', '--no-debug-port']).error).toMatch(/--agent needs the DevTools port/);
    const agent = parseLauncherArgs(['--agent', '--doc', 'x']);
    const plain = parseLauncherArgs([]);
    expect(agent).toMatchObject({ agent: true, doc: 'x', debugPort: '9222', timeoutMs: 60_000 });
    expect(String(agent.profileDir)).toMatch(/rv-viewer-agent-profile$/);
    expect(String(plain.profileDir)).toMatch(/rv-viewer-chrome-profile$/);
    expect(parseLauncherArgs(['--debug-port', 'abc']).error).toMatch(/Invalid --debug-port/);
    expect(parseLauncherArgs(['--agent', '--connect', 'http://127.0.0.1:5101/']).connect).toBe('http://127.0.0.1:5101');
  });
});

describe('init script (seeded only on the viewer origin)', () => {
  const consent = readConsentContract();

  it('reads the consent version and key from the viewer source', () => {
    expect(consent).toEqual({ version: AI_BRIDGE_CONSENT_VERSION, key: AI_BRIDGE_CONSENT_KEY });
  });

  it('switches the bridge on and records the consent on the target origin', () => {
    const script = buildInitScript({
      origin: 'http://localhost:5100', bridgePort: '5100', consentKey: consent.key, consentVersion: consent.version,
    });
    const stored = runInitScript(script, 'http://localhost:5100');
    expect(JSON.parse(stored.get('rv-ai-bridge')!)).toEqual({ enabled: true, port: '5100' });
    expect(stored.get(AI_BRIDGE_CONSENT_KEY)).toBe(AI_BRIDGE_CONSENT_VERSION);
  });

  it('touches nothing on any other origin', () => {
    const script = buildInitScript({
      origin: 'http://localhost:5100', bridgePort: '5100', consentKey: consent.key, consentVersion: consent.version,
    });
    for (const other of ['https://evil.example', 'http://localhost:5173', 'http://127.0.0.1:5100', 'null']) {
      expect(runInitScript(script, other).size).toBe(0);
    }
  });
});

describe('waiting for OUR claim and a roundtrip', () => {
  it('ready only when our claim owns the bridge with tools AND the ping is in the same generation', async () => {
    const clock = fakeClock();
    const sequence: Status[] = [
      status(null),
      status({ claimId: null, tools: 40, visible: false, legacy: false }), // a foreign, unclaimed owner
      status({ claimId: 'c-other', tools: 40 }),                           // a competing launcher
      status({ claimId: 'c-ours', tools: 0 }),                             // ours, catalog not yet in
      status({ claimId: 'c-ours', tools: 40 }, 7),
    ];
    let pings = 0;
    const result = await waitForOwnClaim({
      claimId: 'c-ours',
      timeoutMs: 60_000,
      ...clock,
      fetchStatus: async () => sequence.shift() ?? status({ claimId: 'c-ours', tools: 40 }, 7),
      ping: async () => { pings++; return { ok: true, claimId: 'c-ours', generation: 7 }; },
    });
    expect(result.ok).toBe(true);
    expect(pings).toBe(1);
  });

  it('a roundtrip that landed in another generation does not count', async () => {
    const clock = fakeClock();
    let pingGeneration = 6; // the owner switched between status and ping once
    const result = await waitForOwnClaim({
      claimId: 'c-ours',
      timeoutMs: 60_000,
      ...clock,
      fetchStatus: async () => status({ claimId: 'c-ours', tools: 40 }, 7),
      ping: async () => ({ ok: true, claimId: 'c-ours', generation: pingGeneration++ }),
    });
    expect(result.ok).toBe(true);
    expect(pingGeneration).toBe(8); // 6 rejected, 7 accepted
  });

  it('times out with a diagnosis naming who owns the bridge instead', async () => {
    const clock = fakeClock();
    const result = await waitForOwnClaim({
      claimId: 'c-ours',
      timeoutMs: 60_000,
      ...clock,
      fetchStatus: async () => status({ claimId: 'c-other', tools: 40 }),
      ping: async () => { throw new Error('must not ping a foreign owner'); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(result.diagnosis).toMatch(/another claim \(c-other\)/);
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });

  it('a status endpoint that keeps failing ends in a timeout, not a crash', async () => {
    const clock = fakeClock();
    const result = await waitForOwnClaim({
      claimId: 'c-ours', timeoutMs: 5_000, ...clock,
      fetchStatus: async () => { throw new Error('HTTP 404'); },
      ping: async () => ({ ok: true }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'timeout' });
    expect(result.diagnosis).toMatch(/HTTP 404/);
  });

  it('a redirect to another origin fails at once', async () => {
    const clock = fakeClock();
    const result = await waitForOwnClaim({
      claimId: 'c-ours', timeoutMs: 60_000, ...clock,
      checkOrigin: async () => ({ ok: false, actual: 'https://login.example' }),
      fetchStatus: async () => status({ claimId: 'c-ours', tools: 40 }),
      ping: async () => ({ ok: true, claimId: 'c-ours', generation: 3 }),
    });
    expect(result).toMatchObject({ ok: false, reason: 'redirect' });
    expect(result.diagnosis).toMatch(/login\.example/);
    expect(clock.now()).toBe(0);
  });

  it('describes the states a timeout can end in', () => {
    expect(describeBridgeStatus(null, 'c')).toBe('no bridge status yet');
    expect(describeBridgeStatus(status(null), 'c')).toMatch(/no tab owns the bridge/);
    expect(describeBridgeStatus(status({ claimId: 'c', tools: 3 }), 'c')).toMatch(/OUR claimed tab, 3 tools/);
  });
});
