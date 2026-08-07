// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSocketRealtimeInterface worker-facade tests (Plan 235, Phase B4).
 *
 * Validates the MAIN-THREAD facade around the transport worker WITHOUT a real
 * Worker: a mock TransportPort captures inbound messages and lets the test
 * drive outbound messages back in.
 *
 * Checks:
 *   - doConnect starts the port, sends `connect`, resolves on `open`.
 *   - Worker `delta` → existing bufferIncoming() (pendingIncoming) path.
 *   - sendSignals (viewer → PLC) → `outgoing` posted to the worker.
 *   - Discovery: `discover` posted, `import_answer` resolves discovery.
 *   - buildUrl appends `?apikey=` when an auth token is set (A0 gate), except
 *     same-origin, where the session cookie carries it (plan-366) — with the
 *     query key coming back once a cookie-only attempt failed.
 *   - Public connection-state / disconnect behavior is preserved.
 */

import { describe, it, expect } from 'vitest';
import {
  WebSocketRealtimeInterface,
  isSameOriginWsTarget,
} from '../src/interfaces/websocket-realtime-interface';
import type { SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import type {
  TransportInboundMessage,
  TransportOutboundMessage,
} from '../src/interfaces/signal-transport-core';
import { INTERFACE_DEFAULTS, type InterfaceSettings } from '../src/interfaces/interface-settings-store';

// ── Mock TransportPort ──────────────────────────────────────────────────────

class MockPort {
  inbound: TransportInboundMessage[] = [];
  terminated = false;
  private handler: ((msg: TransportOutboundMessage) => void) | null = null;

  postMessage(msg: TransportInboundMessage): void { this.inbound.push(msg); }
  terminate(): void { this.terminated = true; }
  onMessage(cb: (msg: TransportOutboundMessage) => void): void { this.handler = cb; }

  /** Simulate the worker posting a message back to the main thread. */
  emit(msg: TransportOutboundMessage): void { this.handler?.(msg); }

  inboundOfType<T extends TransportInboundMessage['type']>(
    type: T,
  ): Extract<TransportInboundMessage, { type: T }>[] {
    return this.inbound.filter((m) => m.type === type) as Extract<TransportInboundMessage, { type: T }>[];
  }
}

/** Test subclass that injects the mock port instead of a real Worker. */
class TestWsInterface extends WebSocketRealtimeInterface {
  readonly port = new MockPort();
  protected override createPort() {
    return this.port;
  }
}

function settings(overrides?: Partial<InterfaceSettings>): InterfaceSettings {
  return { ...INTERFACE_DEFAULTS, activeType: 'websocket-realtime', wsAddress: 'localhost', wsPort: 7000, ...overrides };
}

/** Access a protected method for direct invocation in a test. */
function priv<T>(obj: unknown, key: string): T {
  return (obj as Record<string, T>)[key];
}

// ── doConnect / open ────────────────────────────────────────────────────────

describe('WebSocketRealtimeInterface facade — connect', () => {
  it('starts the port, sends connect, and resolves on open', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);

    const promise = doConnect(settings());
    // connect message was posted to the worker
    expect(iface.port.inboundOfType('connect')).toHaveLength(1);
    const conn = iface.port.inboundOfType('connect')[0];
    expect(conn.settings.url).toBe('ws://localhost:7000/');
    expect(conn.settings.autoReconnect).toBe(false); // base class owns reconnect

    // Simulate the worker's open — the promise resolves.
    iface.port.emit({ type: 'open' });
    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects the connect promise if the worker reports closed before open', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);

    const promise = doConnect(settings());
    iface.port.emit({ type: 'closed', reason: 'refused' });
    await expect(promise).rejects.toThrow('refused');
  });
});

// ── delta → bufferIncoming ──────────────────────────────────────────────────

describe('WebSocketRealtimeInterface facade — incoming delta', () => {
  it('feeds worker delta into the pendingIncoming buffer (unchanged flush path)', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);
    const promise = doConnect(settings());
    iface.port.emit({ type: 'open' });
    await promise;

    iface.port.emit({ type: 'delta', signals: { A: 3, B: true } });

    const pending = priv<Map<string, boolean | number>>(iface, 'pendingIncoming');
    expect(pending.get('A')).toBe(3);
    expect(pending.get('B')).toBe(true);
  });
});

// ── sendSignals → outgoing ──────────────────────────────────────────────────

describe('WebSocketRealtimeInterface facade — outgoing', () => {
  it('posts sendSignals to the worker as an outgoing message', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);
    const promise = doConnect(settings());
    iface.port.emit({ type: 'open' });
    await promise;

    const sendSignals = priv<(s: Record<string, boolean | number>) => void>(iface, 'sendSignals').bind(iface);
    sendSignals({ Start: true, Speed: 250 });

    const outgoing = iface.port.inboundOfType('outgoing');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].signals).toEqual({ Start: true, Speed: 250 });
  });
});

// ── discovery ───────────────────────────────────────────────────────────────

describe('WebSocketRealtimeInterface facade — discovery', () => {
  it('posts discover and resolves with parsed descriptors on import_answer', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);
    const cp = doConnect(settings());
    iface.port.emit({ type: 'open' });
    await cp;

    const doDiscover = priv<() => Promise<SignalDescriptor[]>>(iface, 'doDiscoverSignals').bind(iface);
    const discPromise = doDiscover();

    expect(iface.port.inboundOfType('discover')).toHaveLength(1);

    iface.port.emit({
      type: 'import_answer',
      signals: { Start: false, Speed: 100 },
      signalTypes: { Start: 'PLCInputBool', Speed: 'PLCOutputFloat' },
    });

    const signals = await discPromise;
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.name === 'Start')).toMatchObject({
      type: 'bool', direction: 'input', initialValue: false,
    });
    expect(signals.find((s) => s.name === 'Speed')).toMatchObject({
      type: 'float', direction: 'output', initialValue: 100,
    });
  });
});

// ── buildUrl auth (A0) + cookie preference (plan-366 Phase 3) ───────────────

type BuildUrl = (s: string, a: string, p: number, path: string, set: InterfaceSettings) => string;

/** The current page as a WS target — the one case where the session cookie is sent. */
function selfTarget(): { scheme: string; hostname: string; port: number } {
  const { protocol, hostname, port } = window.location;
  return {
    scheme: protocol === 'https:' ? 'wss' : 'ws',
    hostname,
    port: port !== '' ? Number(port) : protocol === 'https:' ? 443 : 80,
  };
}

describe('WebSocketRealtimeInterface facade — buildUrl', () => {
  it('appends ?apikey= for a cross-origin target when an auth token is configured', () => {
    const iface = new TestWsInterface();
    const buildUrl = priv<BuildUrl>(iface, 'buildUrl').bind(iface);
    const url = buildUrl('ws', 'host', 7000, '/', settings({ wsAuthToken: 'secret key' }));
    expect(url).toBe('ws://host:7000/?apikey=secret%20key');
  });

  it('omits ?apikey= when no token', () => {
    const iface = new TestWsInterface();
    const buildUrl = priv<BuildUrl>(iface, 'buildUrl').bind(iface);
    const url = buildUrl('ws', 'host', 7000, '/', settings({ wsAuthToken: '' }));
    expect(url).toBe('ws://host:7000/');
  });

  // plan-366: a same-origin handshake carries CONNECT's SameSite=Strict session
  // cookie by itself, so the credential does not belong in a URL that every proxy
  // and server on the way writes to a log.
  it('leaves the key out of a same-origin URL and relies on the session cookie', () => {
    const iface = new TestWsInterface();
    const buildUrl = priv<BuildUrl>(iface, 'buildUrl').bind(iface);
    const { scheme, hostname, port } = selfTarget();

    const url = buildUrl(scheme, hostname, port, '/ws', settings({ wsAuthToken: 'secret key' }));

    expect(url).toBe(`${scheme}://${hostname}:${port}/ws`);
  });

  // ... and it is a preference, not a removal: a cookie that expired mid-session
  // closes the handshake without opening, and the retry has to carry the key.
  it('puts the key back after a cookie-only attempt failed', () => {
    const iface = new TestWsInterface();
    const buildUrl = priv<BuildUrl>(iface, 'buildUrl').bind(iface);
    const { scheme, hostname, port } = selfTarget();
    const keyed = settings({ wsAuthToken: 'secret key', wsAddress: hostname, wsPort: port });

    // First attempt: same-origin, cookie-only — then the socket closes unopened.
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);
    const attempt = doConnect(keyed);
    iface.port.emit({ type: 'closed', reason: 'refused' });
    return attempt.catch(() => {
      expect(buildUrl(scheme, hostname, port, '/ws', keyed))
        .toBe(`${scheme}://${hostname}:${port}/ws?apikey=secret%20key`);
    });
  });
});

describe('isSameOriginWsTarget', () => {
  const page = { protocol: 'https:', hostname: 'plant.example.com', port: '8443' };

  it('matches scheme, host and port', () => {
    expect(isSameOriginWsTarget('wss', 'plant.example.com', 8443, page)).toBe(true);
  });

  it('rejects a different port, host or scheme', () => {
    expect(isSameOriginWsTarget('wss', 'plant.example.com', 5100, page)).toBe(false);
    expect(isSameOriginWsTarget('wss', 'other.example.com', 8443, page)).toBe(false);
    expect(isSameOriginWsTarget('ws', 'plant.example.com', 8443, page)).toBe(false);
  });

  it('resolves the implicit default port of a page URL without one', () => {
    const implicitHttps = { protocol: 'https:', hostname: 'hmi.example', port: '' };
    expect(isSameOriginWsTarget('wss', 'hmi.example', 443, implicitHttps)).toBe(true);
    const implicitHttp = { protocol: 'http:', hostname: 'hmi.example', port: '' };
    expect(isSameOriginWsTarget('ws', 'hmi.example', 80, implicitHttp)).toBe(true);
  });

  //! No page at all (worker, SSR, node test) is not same-origin — the cookie
  //! preference must never be assumed where it cannot be observed.
  it('is false without a location', () => {
    expect(isSameOriginWsTarget('ws', 'localhost', 5100, undefined)).toBe(false);
  });
});

// ── disconnect ──────────────────────────────────────────────────────────────

describe('WebSocketRealtimeInterface facade — disconnect', () => {
  it('terminates the port on doDisconnect', async () => {
    const iface = new TestWsInterface();
    const doConnect = priv<(s: InterfaceSettings) => Promise<void>>(iface, 'doConnect').bind(iface);
    const promise = doConnect(settings());
    iface.port.emit({ type: 'open' });
    await promise;

    const doDisconnect = priv<() => void>(iface, 'doDisconnect').bind(iface);
    doDisconnect();

    expect(iface.port.inboundOfType('disconnect').length).toBeGreaterThanOrEqual(1);
    expect(iface.port.terminated).toBe(true);
  });

  it('public disconnect() sets state to disconnected and does not throw', async () => {
    const iface = new TestWsInterface();
    // Auto-drive the worker responses: `connect`→open, `discover`→empty import_answer.
    // This mirrors the real worker reacting to inbound messages so the full
    // connect() flow (doConnect → doDiscoverSignals) completes without racing.
    const origPost = iface.port.postMessage.bind(iface.port);
    iface.port.postMessage = (msg) => {
      origPost(msg);
      if (msg.type === 'connect') queueMicrotask(() => iface.port.emit({ type: 'open' }));
      if (msg.type === 'discover') queueMicrotask(() => iface.port.emit({ type: 'import_answer', signals: {}, signalTypes: {} }));
    };

    await iface.connect(settings());

    expect(iface.connectionState).toBe('connected');
    iface.disconnect();
    expect(iface.connectionState).toBe('disconnected');
    expect(() => iface.disconnect()).not.toThrow();
  });
});
