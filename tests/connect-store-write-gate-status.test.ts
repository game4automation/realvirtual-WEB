// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-562 §9.6 — the `/status` parser and the atomic gate endpoint.
 *
 * Two contracts are pinned here.
 *
 * The parser: CONNECT's `/status` projection is ONE anonymous type, so a field
 * that carries no information arrives as JSON `null` rather than being omitted
 * (exactly as `error` and `signalIssues` always have). `null`, `undefined` and
 * "absent" must therefore all read as `undefined` — anything else would make the
 * write-gate overlay trigger on a gateway that never blocked a single write.
 *
 * The endpoint: `setAllowWebToPlc` maps 200 / 404+code / 409 / 404-without-code /
 * 405 / a network failure onto the five outcomes the overlay has sentences for,
 * and it NEVER falls back to `PUT /config/interfaces/{id}`. That fallback was cut
 * deliberately (plan review round 2, finding 5): the replace-the-whole-interface
 * route would let a one-click "Allow writes" silently revert whatever another
 * client changed in the meantime.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectToServer,
  fetchStatus,
  getConnectSnapshot,
  parseInterfaceStatusRow,
  setAllowWebToPlc,
  setServerUrl,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';

const SERVER = 'http://write-gate-store.test:5100';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

/** Every URL the stub saw, so "never PUT /config/interfaces/{id}" is checkable. */
let calls: Array<{ url: string; method: string; body: string }> = [];

interface GatewayOptions {
  statusInterfaces?: Array<Record<string, unknown>>;
  /** Answer of the gate endpoint. */
  gate?: () => Response;
  /** Make the gate endpoint fail at the network level. */
  gateThrows?: boolean;
}

function installGateway(opts: GatewayOptions = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    if (url.endsWith('/health')) return json({ status: 'ok', version: '6.3.47', build: 1 });
    if (url.endsWith('/interface-types')) return json({ types: [] });
    if (url.endsWith('/allow-web-to-plc')) {
      if (opts.gateThrows) throw new TypeError('Failed to fetch');
      return opts.gate ? opts.gate() : json({ ok: true });
    }
    if (url.endsWith('/config/interfaces')) {
      return json([{ id: 'PLCSIM_1', type: 'PlcSimAdvanced', enabled: true, signals: [] }]);
    }
    if (new URL(url).pathname === '/status') {
      return json({ interfaces: opts.statusInterfaces ?? [] });
    }
    return new Response('', { status: 404 });
  }));
}

beforeEach(() => {
  calls = [];
  localStorage.clear();
  _resetConnectStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetConnectStore();
  localStorage.clear();
});

describe('/status parser — the plan-562 fields (§9.6)', () => {
  it('reads configRevision, writesBlockedByGate, blockedSignals and readHealth', async () => {
    installGateway({
      statusInterfaces: [{
        id: 'PLCSIM_1',
        status: 'Connected',
        configRevision: 'rev-abc',
        writesBlockedByGate: 4,
        blockedSignals: ['BT2_OpMode', 'BT2_Start'],
        readHealth: {
          boundReadTags: 42, tagsWithValidValue: 40, progress: 117,
          workerGeneration: 2, progressIsPeriodic: true,
        },
      }],
    });
    setServerUrl(SERVER);
    await connectToServer();
    await fetchStatus();

    const status = getConnectSnapshot().interfaceStatus['PLCSIM_1'];
    expect(status.configRevision).toBe('rev-abc');
    expect(status.writesBlockedByGate).toBe(4);
    expect(status.blockedSignals).toEqual(['BT2_OpMode', 'BT2_Start']);
    expect(status.readHealth).toEqual({
      boundReadTags: 42, tagsWithValidValue: 40, progress: 117,
      workerGeneration: 2, progressIsPeriodic: true,
    });
  });

  it('treats JSON null exactly like an absent field (the projection cannot omit members)', () => {
    const nulled = parseInterfaceStatusRow({
      id: 'A', status: 'Connected',
      error: null, signalIssues: null, configRevision: null,
      writesBlockedByGate: null, blockedSignals: null, readHealth: null,
    });
    const absent = parseInterfaceStatusRow({ id: 'A', status: 'Connected' });
    for (const status of [nulled, absent]) {
      expect(status.configRevision).toBeUndefined();
      expect(status.writesBlockedByGate).toBeUndefined();
      expect(status.blockedSignals).toBeUndefined();
      expect(status.readHealth).toBeUndefined();
      expect(status.signalIssues).toBeUndefined();
      expect(status.error).toBeUndefined();
    }
  });

  it('zero blocked writes stays zero, and an empty blocked list reads as undefined', () => {
    const status = parseInterfaceStatusRow({
      id: 'A', status: 'Connected', writesBlockedByGate: 0, blockedSignals: [],
    });
    // 0 is information ("the gateway counts, nothing blocked"), [] is not.
    expect(status.writesBlockedByGate).toBe(0);
    expect(status.blockedSignals).toBeUndefined();
  });

  it('fills a partial readHealth defensively instead of handing undefined to the watch', () => {
    const status = parseInterfaceStatusRow({
      id: 'A', status: 'Connected', readHealth: { boundReadTags: 7 },
    });
    expect(status.readHealth).toEqual({
      boundReadTags: 7, tagsWithValidValue: 0, progress: 0,
      workerGeneration: 0, progressIsPeriodic: false,
    });
  });
});

describe('setAllowWebToPlc — the atomic gate endpoint (§9.6)', () => {
  async function connect(opts: GatewayOptions): Promise<void> {
    installGateway(opts);
    setServerUrl(SERVER);
    await connectToServer();
    calls = [];
  }

  /** The gate call, if any — the assertion subject of every case below. */
  function gateCall(): { url: string; method: string; body: string } | undefined {
    return calls.find((c) => c.url.endsWith('/allow-web-to-plc'));
  }

  it('sends the revision of the shown snapshot and reports ok on 200', async () => {
    await connect({ gate: () => json({ ok: true }) });
    const result = await setAllowWebToPlc('PLCSIM_1', 'rev-abc');
    expect(result).toEqual({ kind: 'ok' });
    const call = gateCall();
    expect(call?.method).toBe('PUT');
    expect(call?.url).toBe(`${SERVER}/config/interfaces/PLCSIM_1/allow-web-to-plc`);
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ allow: true, revision: 'rev-abc' });
  });

  it('maps 409 revision-mismatch to "changed"', async () => {
    await connect({ gate: () => json({ code: 'revision-mismatch' }, 409) });
    expect(await setAllowWebToPlc('PLCSIM_1', 'rev-old')).toEqual({ kind: 'changed' });
  });

  it('maps 404 interface-not-found to "gone"', async () => {
    await connect({ gate: () => json({ code: 'interface-not-found' }, 404) });
    expect(await setAllowWebToPlc('PLCSIM_1', 'rev-abc')).toEqual({ kind: 'gone' });
  });

  it('maps a 404 without a code and a 405 to "unsupported" (gateway too old)', async () => {
    await connect({ gate: () => new Response('<!doctype html>', { status: 404 }) });
    expect(await setAllowWebToPlc('PLCSIM_1', 'rev-abc')).toEqual({ kind: 'unsupported' });

    _resetConnectStore();
    await connect({ gate: () => new Response('', { status: 405 }) });
    expect(await setAllowWebToPlc('PLCSIM_1', 'rev-abc')).toEqual({ kind: 'unsupported' });
  });

  it('maps 400 revision-required to an error — it must not happen in normal operation', async () => {
    await connect({ gate: () => json({ code: 'revision-required' }, 400) });
    const result = await setAllowWebToPlc('PLCSIM_1', '');
    expect(result.kind).toBe('error');
  });

  it('maps a network failure to "error" with its message', async () => {
    await connect({ gateThrows: true });
    const result = await setAllowWebToPlc('PLCSIM_1', 'rev-abc');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toContain('Failed to fetch');
  });

  it('never sends PUT /config/interfaces/{id} — the replace route stays out of this', async () => {
    const answers: Array<() => Response> = [
      () => json({ ok: true }),
      () => json({ code: 'revision-mismatch' }, 409),
      () => json({ code: 'interface-not-found' }, 404),
      () => new Response('<!doctype html>', { status: 404 }),
      () => new Response('', { status: 405 }),
    ];
    for (const gate of answers) {
      _resetConnectStore();
      await connect({ gate });
      await setAllowWebToPlc('PLCSIM_1', 'rev-abc');
      const replaces = calls.filter((c) => c.method === 'PUT' && !c.url.endsWith('/allow-web-to-plc'));
      expect(replaces).toEqual([]);
    }
  });
});
