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

import { describe, it, expect, vi } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
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

// ── runtime-added signals (CONNECT auto-map → Apply while connected) ────────

describe('WebSocketRealtimeInterface facade — signal list grows while connected', () => {
  /** Connect through the public API and answer the first discovery with `types`. */
  async function connectWith(iface: TestWsInterface, types: Record<string, string>): Promise<void> {
    const cp = iface.connect(settings());
    iface.port.emit({ type: 'open' });
    await vi.waitFor(() => expect(iface.port.inboundOfType('discover')).toHaveLength(1));
    iface.port.emit({ type: 'import_answer', signals: Object.fromEntries(Object.keys(types).map((n) => [n, false])), signalTypes: types });
    await cp;
  }

  it('re-reads the list on an unknown incoming signal so a viewer write reaches it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      const store = new SignalStore();
      (iface as unknown as { signalStore: SignalStore }).signalStore = store;
      await connectWith(iface, { A: 'PLCInputBool' });

      // CONNECT broadcasts the value of a signal an interface added after the handshake.
      iface.port.emit({ type: 'delta', signals: { B: false } });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.port.emit({ type: 'import_answer', signals: { A: false, B: false }, signalTypes: { A: 'PLCInputBool', B: 'PLCInputBool' } });
      await vi.waitFor(() => expect(iface.discoveredSignals.map((s) => s.name)).toContain('B'));

      iface.onFixedUpdatePre(0); // one sim tick commits the incoming buffer (echo guard)
      store.set('B', true);
      iface.onFixedUpdatePost(0);
      expect(iface.port.inboundOfType('outgoing').at(-1)?.signals).toEqual({ B: true });
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs one re-read at a time and picks up names that arrived meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      (iface as unknown as { signalStore: SignalStore }).signalStore = new SignalStore();
      await connectWith(iface, { A: 'PLCInputBool' });

      iface.port.emit({ type: 'delta', signals: { B: false } });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      // C arrives while the B re-read is still unanswered — no second request in flight.
      iface.port.emit({ type: 'delta', signals: { C: false } });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.port.emit({ type: 'import_answer', signals: { A: false, B: false }, signalTypes: { A: 'PLCInputBool', B: 'PLCInputBool' } });
      await vi.waitFor(() => expect(iface.discoveredSignals).toHaveLength(2));
      // ... and only afterwards for C.
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(3);
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies nothing from a re-read answered after a disconnect', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      (iface as unknown as { signalStore: SignalStore }).signalStore = new SignalStore();
      await connectWith(iface, { A: 'PLCInputBool' });
      iface.port.emit({ type: 'delta', signals: { B: false } });
      await vi.advanceTimersByTimeAsync(300);
      const rediscover = iface.rediscover();
      iface.port.emit({ type: 'import_answer', signals: { A: false, B: false }, signalTypes: { A: 'PLCInputBool', B: 'PLCInputBool' } });
      iface.disconnect();
      await rediscover.catch(() => {});
      expect(iface.isConnected).toBe(false);
      expect(priv<unknown[]>(iface, '_outgoingSubscriptions')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not echo a received PLC input back to the remote', async () => {
    const iface = new TestWsInterface();
    const store = new SignalStore();
    const viewer = { signalStore: store, emit: () => {} } as unknown as Parameters<TestWsInterface['onModelLoaded']>[1];
    iface.onModelLoaded({} as Parameters<TestWsInterface['onModelLoaded']>[0], viewer);
    await connectWith(iface, { A: 'PLCInputBool' });

    iface.port.emit({ type: 'delta', signals: { A: true } });
    iface.onFixedUpdatePre(0);
    expect(store.get('A')).toBe(true);
    iface.onFixedUpdatePost(0);
    expect(iface.port.inboundOfType('outgoing')).toHaveLength(0);
    iface.disconnect();
  });

  it('rediscover() called twice shares one request', async () => {
    const iface = new TestWsInterface();
    (iface as unknown as { signalStore: SignalStore }).signalStore = new SignalStore();
    await connectWith(iface, { A: 'PLCInputBool' });

    const first = iface.rediscover();
    const second = iface.rediscover();
    expect(iface.port.inboundOfType('discover')).toHaveLength(2); // connect + ONE re-read
    iface.port.emit({ type: 'import_answer', signals: { A: false }, signalTypes: { A: 'PLCInputBool' } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    iface.disconnect();
  });

  it('does not re-read again for a name the remote still does not list', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      (iface as unknown as { signalStore: SignalStore }).signalStore = new SignalStore();
      await connectWith(iface, { A: 'PLCInputBool' });

      iface.port.emit({ type: 'delta', signals: { Ghost: 1 } });
      await vi.advanceTimersByTimeAsync(300);
      iface.port.emit({ type: 'import_answer', signals: { A: false }, signalTypes: { A: 'PLCInputBool' } });
      await vi.waitFor(() => expect(iface.discoveredSignals).toHaveLength(1));

      iface.port.emit({ type: 'delta', signals: { Ghost: 2 } });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── PLC-input start values (plan-563) ───────────────────────────────────────

describe('WebSocketRealtimeInterface facade — model values for unset PLC inputs', () => {
  type Answer = { signals: Record<string, boolean | number>; types: Record<string, string>; uninitialized?: string[] };

  function answer(a: Answer): TransportOutboundMessage {
    return {
      type: 'import_answer',
      signals: a.signals,
      signalTypes: a.types,
      ...(a.uninitialized !== undefined ? { uninitialized: a.uninitialized } : {}),
    };
  }

  async function connectAnswering(iface: TestWsInterface, a: Answer): Promise<void> {
    const cp = iface.connect(settings());
    iface.port.emit({ type: 'open' });
    await vi.waitFor(() => expect(iface.port.inboundOfType('discover')).toHaveLength(1));
    iface.port.emit(answer(a));
    await cp;
  }

  /** A store holding model signals (scene paths) — what a loaded GLB provides. */
  function modelStore(values: Record<string, boolean | number>): SignalStore {
    const store = new SignalStore();
    for (const [name, value] of Object.entries(values)) {
      store.register(name, `Station/${name}`, value, typeof value === 'boolean' ? 'PLCInputBool' : 'PLCInputFloat');
    }
    return store;
  }

  function withStore(iface: TestWsInterface, store: SignalStore): void {
    (iface as unknown as { signalStore: SignalStore }).signalStore = store;
  }

  it('offers the model value of an uninitialized input after discovery', async () => {
    const iface = new TestWsInterface();
    withStore(iface, modelStore({ BT2: true }));
    await connectAnswering(iface, {
      signals: { BT2: false },
      types: { BT2: 'PLCInputBool' },
      uninitialized: ['BT2'],
    });

    const offers = iface.port.inboundOfType('init_values');
    expect(offers).toHaveLength(1);
    expect(offers[0].signals).toEqual({ BT2: true });
    expect(iface.discoveredSignals.find((s) => s.name === 'BT2')?.uninitialized).toBe(true);
    iface.disconnect();
  });

  it('does not offer __iface__-only signals', async () => {
    const iface = new TestWsInterface();
    withStore(iface, modelStore({ Model: 3.5 }));
    await connectAnswering(iface, {
      signals: { IfaceOnly: false, Model: 0, Out: false },
      types: { IfaceOnly: 'PLCInputBool', Model: 'PLCInputFloat', Out: 'PLCOutputBool' },
      uninitialized: ['IfaceOnly', 'Model'],
    });

    const offers = iface.port.inboundOfType('init_values');
    expect(offers).toHaveLength(1);
    // IfaceOnly has no scene node (registered as __iface__/IfaceOnly): there is no model value.
    expect(offers[0].signals).toEqual({ Model: 3.5 });
    iface.disconnect();
  });

  it('does not offer without an uninitialized field (old CONNECT)', async () => {
    const iface = new TestWsInterface();
    withStore(iface, modelStore({ BT2: true }));
    await connectAnswering(iface, { signals: { BT2: false }, types: { BT2: 'PLCInputBool' } });

    expect(iface.port.inboundOfType('init_values')).toHaveLength(0);
    iface.disconnect();
  });

  it('catalog_changed triggers exactly one rediscovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      withStore(iface, modelStore({ BT1: true }));
      await connectAnswering(iface, { signals: {}, types: {}, uninitialized: [] });

      // An interface apply that adds only inputs: no value moves, only the notice arrives (twice).
      iface.port.emit({ type: 'catalog_changed' });
      iface.port.emit({ type: 'catalog_changed' });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);

      iface.port.emit(answer({ signals: { BT1: false }, types: { BT1: 'PLCInputBool' }, uninitialized: ['BT1'] }));
      await vi.waitFor(() => expect(iface.port.inboundOfType('init_values')).toHaveLength(1));
      expect(iface.port.inboundOfType('init_values')[0].signals).toEqual({ BT1: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('catalog_changed during a running discovery runs one follow-up and offers every new input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      withStore(iface, modelStore({ ESTOP1: true, ESTOP2: true }));
      await connectAnswering(iface, { signals: {}, types: {}, uninitialized: [] });

      iface.port.emit({ type: 'catalog_changed' });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);

      // The catalog moves again while the re-read is unanswered: no second request in flight ...
      iface.port.emit({ type: 'catalog_changed' });
      iface.port.emit({ type: 'catalog_changed' });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);

      // ... the (stale) answer lists only ESTOP1 ...
      iface.port.emit(answer({ signals: { ESTOP1: false }, types: { ESTOP1: 'PLCInputBool' }, uninitialized: ['ESTOP1'] }));
      await vi.waitFor(() => expect(iface.port.inboundOfType('init_values')).toHaveLength(1));
      expect(iface.port.inboundOfType('init_values')[0].signals).toEqual({ ESTOP1: true });

      // ... and exactly one follow-up picks up ESTOP2.
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(3);
      iface.port.emit(answer({
        signals: { ESTOP1: true, ESTOP2: false },
        types: { ESTOP1: 'PLCInputBool', ESTOP2: 'PLCInputBool' },
        uninitialized: ['ESTOP2'],
      }));
      await vi.waitFor(() => expect(iface.port.inboundOfType('init_values')).toHaveLength(2));
      expect(iface.port.inboundOfType('init_values')[1].signals).toEqual({ ESTOP2: true });

      await vi.advanceTimersByTimeAsync(1000);
      expect(iface.port.inboundOfType('discover')).toHaveLength(3);
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a catalog_changed and an unknown incoming name share one re-read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const iface = new TestWsInterface();
      withStore(iface, new SignalStore());
      await connectAnswering(iface, { signals: { A: false }, types: { A: 'PLCInputBool' }, uninitialized: [] });

      iface.port.emit({ type: 'catalog_changed' });
      iface.port.emit({ type: 'delta', signals: { Out: 1 } });
      await vi.advanceTimersByTimeAsync(300);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.port.emit(answer({ signals: { A: false, Out: 1 }, types: { A: 'PLCInputBool', Out: 'PLCOutputInt' }, uninitialized: [] }));
      await vi.waitFor(() => expect(iface.discoveredSignals).toHaveLength(2));
      await vi.advanceTimersByTimeAsync(1000);
      expect(iface.port.inboundOfType('discover')).toHaveLength(2);
      iface.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});
