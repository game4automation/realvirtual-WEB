// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-bridge-failure.test.ts — plan-541 § 9.3: why the AI Bridge is not
 * connected, told from REAL browser event sequences.
 *
 * - "connected" = READY = the first `status` frame; a transport `open` is not
 *   enough, because CONNECT accepts a socket whose origin awaits approval and
 *   closes it with 4401 at once.
 * - Pairing close codes (4401/4403/4405/4406/4429/4430) map to causes whether or
 *   not the socket opened; 4401 retries every 2 s for at most 90 s.
 * - A bare 1006 is diagnosed by ONE `/health` probe against the gateway the WS
 *   URL points at; stale results (port change, disable) are dropped.
 * - A hosted page (no marker cookie, not loopback, not dev) asks its OWN origin
 *   for `/health` once, lazily, to tell a cookie-less remote HMI from a CDN.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  McpBridgePlugin,
  PAIRING_RETRY_MS,
  healthBaseFromBridgeTarget,
  redactBridgeTarget,
  type McpBridgeFailure,
} from '../src/plugins/mcp-bridge-plugin';
import { installFakeWebSocket, type FakeWebSocketInstall } from './helpers/fake-websocket';

// ── Rig ──

interface PageContext {
  protocol: string; host: string; origin: string;
  isDevServer: boolean; markerCookie: boolean; isLoopbackPage: boolean;
}

/** The demo on the CDN: not served by CONNECT, not loopback, a production build. */
const HOSTED: PageContext = {
  protocol: 'https:', host: 'web.realvirtual.io', origin: 'https://web.realvirtual.io',
  isDevServer: false, markerCookie: false, isLoopbackPage: false,
};
/** A page CONNECT served itself (marker cookie) on a LAN address. */
const EMBEDDED: PageContext = {
  protocol: 'http:', host: '10.0.0.5:5100', origin: 'http://10.0.0.5:5100',
  isDevServer: false, markerCookie: true, isLoopbackPage: false,
};
const LOOPBACK: PageContext = {
  protocol: 'http:', host: 'localhost:15363', origin: 'http://localhost:15363',
  isDevServer: false, markerCookie: false, isLoopbackPage: true,
};
const DEV: PageContext = { ...LOOPBACK, isDevServer: true };

type Internals = {
  _reconnectDelay: number;
  _reconnectAttempt: number;
  _reconnectTimer: ReturnType<typeof setTimeout> | null;
  _cookieAuthFailed: boolean;
  _connect: () => void;
  _pageContext: () => PageContext;
};

function setup(page: PageContext = HOSTED) {
  const plugin = new McpBridgePlugin();
  const viewer = { emit: vi.fn(), on: vi.fn(() => () => {}) };
  (plugin as unknown as { viewer: unknown }).viewer = viewer;
  const p = plugin as unknown as Internals;
  vi.spyOn(p, '_pageContext').mockReturnValue(page);
  return { plugin, p, viewer };
}

/** A `fetch` Response stand-in whose body resolves on the microtask queue only
 *  (real `Response` bodies can settle on a task, which fake timers never run). */
function fakeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ 'content-type': contentType }),
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

interface FetchCall { url: string }

function stubFetch(respond: (url: string) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push({ url });
    return respond(url);
  }));
  return calls;
}

/** Drain the microtask queue (the probe chain is several awaits deep). */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

const STATUS = {
  type: 'status',
  status: {
    pid: 7, port: 5100, uptimeMs: 1, clientName: null, clientVersion: null,
    clientConnected: false, lastRequestAgoMs: null,
  },
};

let ws: FakeWebSocketInstall;

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  ws = installFakeWebSocket();
});

afterEach(() => {
  vi.useRealTimers();
  ws.restore();
  vi.restoreAllMocks();
});

// ── Pairing close codes ──

describe('pairing close codes (CONNECT accepts, then closes)', () => {
  it('open → close(4401): pairing-pending, never connected, backoff kept, retry after 2 s', () => {
    const { plugin, p } = setup(LOOPBACK);
    p._reconnectDelay = 8000;
    p._connect();
    const first = ws.last;
    first.open();
    expect(plugin.getSnapshot().connected).toBe(false);
    first.serverClose(4401, 'pairing-pending');

    const snap = plugin.getSnapshot();
    expect(snap.failure).toBe('pairing-pending');
    expect(snap.connected).toBe(false);
    expect(p._reconnectDelay).toBe(8000); // NOT reset by the open, NOT grown by the retry

    vi.advanceTimersByTime(PAIRING_RETRY_MS - 1);
    expect(ws.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ws.instances).toHaveLength(2);
  });

  it.each<[number, McpBridgeFailure]>([
    [4403, 'pairing-denied'],
    [4405, 'pairing-unavailable'],
    [4406, 'origin-not-pairable'],
    [4429, 'pairing-cooldown'],
    [4430, 'pairing-busy'],
  ])('open → close(%i) → %s with the normal backoff', (code, failure) => {
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.open();
    ws.last.serverClose(code, failure);
    expect(plugin.getSnapshot().failure).toBe(failure);
    expect(p._reconnectDelay).toBe(2000); // 1000 → doubled: the normal backoff ran
  });

  it('a pairing close is read even when the socket never opened', () => {
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.serverClose(4403, 'pairing-denied');
    expect(plugin.getSnapshot().failure).toBe('pairing-denied');
  });

  it('a 4401 run longer than 90 s falls back to the normal backoff', () => {
    const { p } = setup(LOOPBACK);
    p._connect();
    ws.last.open();
    ws.last.serverClose(4401);
    expect(p._reconnectDelay).toBe(1000);

    vi.advanceTimersByTime(PAIRING_RETRY_MS); // retry fires
    vi.setSystemTime(Date.now() + 90_000);
    ws.last.open();
    ws.last.serverClose(4401);
    expect(p._reconnectDelay).toBe(2000); // backoff took over (1000 → doubled)
  });

  it('a 4401 retry is the fixed 2 s, not the (jittered) backoff', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const { p } = setup(LOOPBACK);
    p._reconnectDelay = 1000;
    p._connect();
    ws.last.open();
    ws.last.serverClose(4401);
    vi.advanceTimersByTime(1000); // the backoff delay would have fired here
    expect(ws.instances).toHaveLength(1);
    vi.advanceTimersByTime(PAIRING_RETRY_MS - 1000);
    expect(ws.instances).toHaveLength(2);
  });

  it('a pairing close does not flag the session cookie as failed', () => {
    localStorage.setItem('rv-interface-settings', JSON.stringify({ wsAuthToken: 'key' }));
    const { p } = setup(EMBEDDED);
    p._connect();
    expect(ws.last.url).not.toContain('apikey'); // embedded: cookie preferred
    ws.last.open();
    ws.last.serverClose(4401);
    expect(p._cookieAuthFailed).toBe(false);
  });
});

// ── Ready = first status frame ──

describe('ready = first status frame', () => {
  it('open → status: connected, failure none, backoff reset', async () => {
    const { plugin, p } = setup(LOOPBACK);
    p._reconnectDelay = 8000;
    p._reconnectAttempt = 4;
    p._connect();
    ws.last.open();
    expect(p._reconnectDelay).toBe(8000); // open alone resets nothing (both former sites)
    ws.last.message(STATUS);
    await flush();
    const snap = plugin.getSnapshot();
    expect(snap.connected).toBe(true);
    expect(snap.failure).toBe('none');
    expect(p._reconnectDelay).toBe(1000);
    expect(p._reconnectAttempt).toBe(0);
  });

  it('open → log → status: only the status frame sets connected', async () => {
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.open();
    ws.last.message({ type: 'log', lines: [{ level: 'info', ts: 1, msg: 'backlog' }] });
    await flush();
    expect(plugin.getSnapshot().connected).toBe(false);
    ws.last.message(STATUS);
    await flush();
    expect(plugin.getSnapshot().connected).toBe(true);
  });

  it('Node fallback order: open → discover sent → status → connected (no hang)', async () => {
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.open();
    expect(ws.last.sentTypes()).toContain('discover');
    expect(plugin.getSnapshot().connected).toBe(false);
    ws.last.message(STATUS);
    await flush();
    expect(plugin.getSnapshot().connected).toBe(true);
  });

  it('the WebSocket constructor throwing → browser-blocked, reconnect scheduled', () => {
    const { plugin, p } = setup(HOSTED);
    stubFetch(() => fakeResponse(404, 'not found', 'text/plain'));
    ws.throwOnConstruct = new DOMException('blocked', 'SecurityError');
    // hosted → probe first; resolve it, then the constructor throws
    p._connect();
    return flush().then(() => {
      expect(ws.throws).toBe(1);
      expect(plugin.getSnapshot().failure).toBe('browser-blocked');
      expect(p._reconnectTimer).not.toBeNull();
    });
  });
});

// ── 1006 diagnosis ──

describe('1006 diagnosis via /health', () => {
  it.each<[string, () => Response | Promise<Response>, McpBridgeFailure]>([
    ['network failure', () => Promise.reject(new TypeError('Failed to fetch')), 'unreachable'],
    ['status starting', () => fakeResponse(200, { status: 'starting', bridgeEnabled: true }), 'starting'],
    ['bridgeEnabled false', () => fakeResponse(200, { status: 'ok', bridgeEnabled: false }), 'bridge-disabled'],
    ['bridgeEnabled missing', () => fakeResponse(200, { status: 'ok', version: '1.2.3' }), 'connect-outdated'],
    ['bridgeEnabled true', () => fakeResponse(200, { status: 'ok', bridgeEnabled: true }), 'refused'],
  ])('%s → %s', async (_name, respond, failure) => {
    stubFetch(respond);
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.refuse();
    await flush();
    expect(plugin.getSnapshot().failure).toBe(failure);
  });

  it('probes the gateway the WS URL points at (ws://localhost:5200 → http://localhost:5200/health)', async () => {
    const calls = stubFetch(() => fakeResponse(200, { status: 'ok', bridgeEnabled: true }));
    const { plugin, p } = setup(LOOPBACK);
    plugin.setPort('5200');
    p._connect();
    expect(ws.last.url).toBe('ws://localhost:5200/webviewer');
    ws.last.refuse();
    await flush();
    expect(calls.map((c) => c.url)).toContain('http://localhost:5200/health');
    expect(healthBaseFromBridgeTarget('wss://plant.example.com:8443/webviewer?apikey=x'))
      .toBe('https://plant.example.com:8443');
  });

  it('one /health probe per failure series once the cause is final', async () => {
    const calls = stubFetch(() => fakeResponse(200, { status: 'ok', bridgeEnabled: true }));
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.refuse();
    await flush();
    vi.runOnlyPendingTimers(); // next attempt
    ws.last.refuse();
    await flush();
    expect(calls).toHaveLength(1);
    expect(plugin.getSnapshot().failure).toBe('refused');
  });

  it('a transient cause (unreachable) is probed again on the next failed attempt', async () => {
    const calls = stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const { p } = setup(LOOPBACK);
    p._connect();
    ws.last.refuse();
    await flush();
    vi.runOnlyPendingTimers();
    ws.last.refuse();
    await flush();
    expect(calls).toHaveLength(2);
  });

  it('a probe result that arrives after a port change is dropped', async () => {
    let resolve!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => { resolve = r; }));
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.refuse();
    await flush();
    plugin.setPort('5300');
    resolve(fakeResponse(200, { status: 'ok', bridgeEnabled: true }));
    await flush();
    expect(plugin.getSnapshot().failure).toBe('none');
  });

  it('a probe result that arrives after disabling the bridge is dropped', async () => {
    let resolve!: (r: Response) => void;
    stubFetch(() => new Promise<Response>((r) => { resolve = r; }));
    const { plugin, p } = setup(LOOPBACK);
    p._connect();
    ws.last.refuse();
    await flush();
    plugin.setEnabled(false);
    resolve(fakeResponse(200, { status: 'ok', bridgeEnabled: false }));
    await flush();
    expect(plugin.getSnapshot().failure).toBe('none');
  });
});

// ── Hosted detection + target through the REAL _resolveTarget ──

describe('target through the real plugin (_resolveTarget)', () => {
  it('embedded (marker cookie) → same-origin, no probe', () => {
    const calls = stubFetch(() => fakeResponse(500, ''));
    const { plugin, p } = setup(EMBEDDED);
    p._connect();
    expect(ws.last.url).toBe('ws://10.0.0.5:5100/webviewer');
    expect(plugin.getSnapshot().target).toBe('ws://10.0.0.5:5100/webviewer');
    expect(calls).toHaveLength(0);
  });

  it('loopback page → same-origin, no probe', () => {
    const calls = stubFetch(() => fakeResponse(500, ''));
    const { p } = setup(LOOPBACK);
    p._connect();
    expect(ws.last.url).toBe('ws://localhost:15363/webviewer');
    expect(calls).toHaveLength(0);
  });

  it('dev server → localhost CONNECT on the default port, no probe', () => {
    const calls = stubFetch(() => fakeResponse(500, ''));
    const { p } = setup(DEV);
    p._connect();
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
    expect(calls).toHaveLength(0);
  });

  it('hosted + same-origin /health 404 → localhost:5100', async () => {
    const calls = stubFetch(() => fakeResponse(404, 'Not Found', 'text/plain'));
    const { plugin, p } = setup(HOSTED);
    p._connect();
    expect(ws.instances).toHaveLength(0); // waits for the probe
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['https://web.realvirtual.io/health']);
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
    expect(plugin.getSnapshot().target).toBe('ws://localhost:5100/webviewer');
  });

  it('hosted + same-origin /health 200 HTML (SPA fallback) → still hosted', async () => {
    stubFetch(() => fakeResponse(200, '<!doctype html><html></html>', 'text/html'));
    const { p } = setup(HOSTED);
    p._connect();
    await flush();
    expect(ws.last.url).toBe('ws://localhost:5100/webviewer');
  });

  it('no marker but same-origin /health has the CONNECT signature → embedded (cookie-less remote HMI)', async () => {
    stubFetch(() => fakeResponse(200, { status: 'ok', version: '1.0.0' }));
    const { p } = setup({ ...HOSTED, protocol: 'http:', host: '192.168.1.20:5100', origin: 'http://192.168.1.20:5100' });
    p._connect();
    await flush();
    expect(ws.last.url).toBe('ws://192.168.1.20:5100/webviewer');
  });

  it('the same-origin probe runs once per page load', async () => {
    const calls = stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    const { plugin, p } = setup(HOSTED);
    p._connect();
    await flush();
    plugin.reconnect();
    await flush();
    expect(calls.filter((c) => c.url.endsWith('web.realvirtual.io/health'))).toHaveLength(1);
    expect(ws.instances).toHaveLength(2);
  });

  it('no probe while the bridge is disabled (never on page load)', async () => {
    const calls = stubFetch(() => fakeResponse(404, 'x', 'text/plain'));
    const { plugin } = setup(HOSTED);
    (plugin as unknown as { init: (v: unknown) => void }).init(
      (plugin as unknown as { viewer: unknown }).viewer,
    );
    plugin.getSnapshot();
    await flush();
    expect(plugin.mcpEnabled).toBe(false);
    expect(calls).toHaveLength(0);
    expect(ws.instances).toHaveLength(0);
  });

  it('the snapshot target never carries the key', () => {
    expect(redactBridgeTarget('ws://localhost:5100/webviewer?apikey=sec%20ret'))
      .toBe('ws://localhost:5100/webviewer');
  });
});
