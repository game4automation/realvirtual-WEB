// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-transport-core tests (Plan 235, Phase B4).
 *
 * Validates the Web Worker transport engine WITHOUT a real Worker:
 *   - Coalescing: many fast `data` messages collapse into ONE delta (last wins).
 *   - Handshake: init on open, import_request → import_answer → subscribe.
 *   - Outgoing (viewer → PLC): `outgoing` inbound → single `data` frame on the socket.
 *   - Heartbeat keeps the socket fed on its own interval (background-tab robustness).
 *   - Reconnect is disabled when autoReconnect is false; resync-on-visible reconnects.
 *
 * A manual timer set (setInterval/setTimeout registry) is used instead of
 * vitest fake timers, which interact poorly with the Playwright browser provider.
 */

import { describe, it, expect } from 'vitest';
import {
  Coalescer,
  parseSignalValues,
  reconnectDelay,
  SignalTransport,
  type TransportOutboundMessage,
  type TransportTimers,
  type WebSocketLike,
} from '../src/interfaces/signal-transport-core';

// ── Manual timer harness ───────────────────────────────────────────────────

interface TimerEntry {
  id: number;
  cb: () => void;
  ms: number;
  repeat: boolean;
}

class FakeTimers implements TransportTimers {
  private next = 1;
  private timers = new Map<number, TimerEntry>();
  private clock = 0;

  setInterval = (cb: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { id, cb, ms, repeat: true });
    return id;
  };
  clearInterval = (h: number): void => { this.timers.delete(h); };
  setTimeout = (cb: () => void, ms: number): number => {
    const id = this.next++;
    this.timers.set(id, { id, cb, ms, repeat: false });
    return id;
  };
  clearTimeout = (h: number): void => { this.timers.delete(h); };
  now = (): number => this.clock;

  /** Fire all currently-registered interval callbacks once (a "frame tick"). */
  tickIntervals(): void {
    for (const t of [...this.timers.values()]) {
      if (t.repeat) t.cb();
    }
  }

  /** Fire and remove the first pending timeout (e.g. reconnect). */
  fireNextTimeout(): boolean {
    for (const t of [...this.timers.values()]) {
      if (!t.repeat) {
        this.timers.delete(t.id);
        t.cb();
        return true;
      }
    }
    return false;
  }

  hasInterval(): boolean {
    return [...this.timers.values()].some((t) => t.repeat);
  }
  hasTimeout(): boolean {
    return [...this.timers.values()].some((t) => !t.repeat);
  }
}

// ── Mock WebSocket ──────────────────────────────────────────────────────────

class MockSocket implements WebSocketLike {
  static readonly OPEN = 1;
  readyState = 0; // CONNECTING
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  sent: string[] = [];
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; this.readyState = 3; }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Parsed frames sent by the transport. */
  frames(): Array<{ type: string; [k: string]: unknown }> {
    return this.sent.map((s) => JSON.parse(s));
  }
  framesOfType(type: string): Array<{ type: string; [k: string]: unknown }> {
    return this.frames().filter((f) => f.type === type);
  }
}

// ── Harness ─────────────────────────────────────────────────────────────────

interface Harness {
  transport: SignalTransport;
  timers: FakeTimers;
  posts: TransportOutboundMessage[];
  sockets: MockSocket[];
  socket: () => MockSocket;
}

function makeHarness(opts?: { autoReconnect?: boolean }): Harness {
  const timers = new FakeTimers();
  const posts: TransportOutboundMessage[] = [];
  const sockets: MockSocket[] = [];

  const transport = new SignalTransport({
    createSocket: (_url: string): WebSocketLike => {
      const s = new MockSocket();
      sockets.push(s);
      return s;
    },
    post: (msg) => posts.push(msg),
    timers,
    flushIntervalMs: 16,
    heartbeatIntervalMs: 1000,
  });

  transport.handleInbound({
    type: 'connect',
    settings: {
      url: 'ws://localhost:7000/',
      host: 'localhost',
      port: 7000,
      autoReconnect: opts?.autoReconnect ?? false,
    },
  });

  return {
    transport,
    timers,
    posts,
    sockets,
    socket: () => sockets[sockets.length - 1],
  };
}

// ── Coalescer ───────────────────────────────────────────────────────────────

describe('Coalescer', () => {
  it('coalesces multiple values per name — last value wins', () => {
    const c = new Coalescer();
    c.merge({ A: 1, B: true });
    c.merge({ A: 2 });
    c.merge({ A: 3, C: 5 });

    expect(c.size).toBe(3);
    const drained = c.drain();
    expect(drained).toEqual({ A: 3, B: true, C: 5 });
  });

  it('drain clears the buffer and returns null when empty', () => {
    const c = new Coalescer();
    expect(c.drain()).toBeNull();
    c.merge({ A: 1 });
    expect(c.drain()).toEqual({ A: 1 });
    expect(c.drain()).toBeNull();
    expect(c.size).toBe(0);
  });
});

describe('parseSignalValues', () => {
  it('passes through booleans and numbers, coerces strings', () => {
    expect(parseSignalValues({ a: true, b: 3.5, c: 'true', d: 'False', e: '42', f: 'nope' }))
      .toEqual({ a: true, b: 3.5, c: true, d: false, e: 42 });
  });
  it('returns empty object for undefined', () => {
    expect(parseSignalValues(undefined)).toEqual({});
  });
});

describe('reconnectDelay', () => {
  it('grows exponentially and caps', () => {
    expect(reconnectDelay(0)).toBe(500);
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(2)).toBe(2000);
    expect(reconnectDelay(20)).toBe(30_000); // capped
  });
});

// ── SignalTransport ─────────────────────────────────────────────────────────

describe('SignalTransport — handshake', () => {
  it('sends init on open and posts open', () => {
    const h = makeHarness();
    h.socket().open();

    expect(h.socket().framesOfType('init')).toHaveLength(1);
    expect(h.posts.find((p) => p.type === 'open')).toBeTruthy();
  });

  it('discovery: import_request → import_answer post → subscribe', () => {
    const h = makeHarness();
    h.socket().open();

    h.transport.handleInbound({ type: 'discover' });
    expect(h.socket().framesOfType('import_request')).toHaveLength(1);

    h.socket().message({
      type: 'import_answer',
      signals: { Start: false, Speed: 100 },
      signalTypes: { Start: 'PLCInputBool', Speed: 'PLCOutputFloat' },
    });

    const answer = h.posts.find((p) => p.type === 'import_answer');
    expect(answer).toMatchObject({
      type: 'import_answer',
      signals: { Start: false, Speed: 100 },
    });

    const sub = h.socket().framesOfType('subscribe')[0];
    expect(sub.subscribe).toEqual(['Start', 'Speed']);
  });

  it('discover before open is deferred until open', () => {
    const h = makeHarness();
    h.transport.handleInbound({ type: 'discover' });
    // Not open yet — no import_request sent.
    expect(h.socket().framesOfType('import_request')).toHaveLength(0);

    h.socket().open();
    expect(h.socket().framesOfType('import_request')).toHaveLength(1);
  });
});

describe('SignalTransport — coalescing to a single delta', () => {
  it('collapses many fast data messages into ONE delta (last value wins)', () => {
    const h = makeHarness();
    h.socket().open();

    // Several fast incoming messages BEFORE a flush tick.
    h.socket().message({ type: 'data', signals: { A: 1 } });
    h.socket().message({ type: 'data', signals: { A: 2, B: true } });
    h.socket().message({ type: 'data', signals: { A: 3 } });

    // No delta posted yet — coalesced in the map.
    expect(h.posts.filter((p) => p.type === 'delta')).toHaveLength(0);

    // One flush tick → exactly one delta with the last values.
    h.timers.tickIntervals();

    const deltas = h.posts.filter((p): p is Extract<TransportOutboundMessage, { type: 'delta' }> => p.type === 'delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].signals).toEqual({ A: 3, B: true });
  });

  it('does not post a delta when nothing changed', () => {
    const h = makeHarness();
    h.socket().open();
    h.timers.tickIntervals();
    expect(h.posts.filter((p) => p.type === 'delta')).toHaveLength(0);
  });

  it('snapshot messages are coalesced like data', () => {
    const h = makeHarness();
    h.socket().open();
    h.socket().message({ type: 'snapshot', signals: { X: 7 } });
    h.socket().message({ type: 'data', signals: { X: 9 } });
    h.timers.tickIntervals();

    const deltas = h.posts.filter((p): p is Extract<TransportOutboundMessage, { type: 'delta' }> => p.type === 'delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].signals).toEqual({ X: 9 });
  });
});

describe('SignalTransport — outgoing (viewer → PLC)', () => {
  it('posts outgoing signals as a single data frame on the socket', () => {
    const h = makeHarness();
    h.socket().open();

    h.transport.handleInbound({ type: 'outgoing', signals: { Start: true, Speed: 250 } });

    const dataFrames = h.socket().framesOfType('data');
    expect(dataFrames).toHaveLength(1);
    expect(dataFrames[0].signals).toEqual({ Start: true, Speed: 250 });
    expect(dataFrames[0].version).toBe(2);
  });

  it('drops outgoing when the socket is not open', () => {
    const h = makeHarness();
    // never opened
    h.transport.handleInbound({ type: 'outgoing', signals: { Start: true } });
    expect(h.socket().framesOfType('data')).toHaveLength(0);
  });
});

describe('SignalTransport — heartbeat', () => {
  it('sends periodic init frames after open (background-tab keep-alive)', () => {
    const h = makeHarness();
    h.socket().open();

    const before = h.socket().framesOfType('init').length; // 1 (handshake)
    h.timers.tickIntervals(); // fires flush + heartbeat intervals
    const after = h.socket().framesOfType('init').length;

    expect(after).toBeGreaterThan(before);
  });
});

describe('SignalTransport — close / reconnect', () => {
  it('posts closed on server close and does NOT reconnect when autoReconnect=false', () => {
    const h = makeHarness({ autoReconnect: false });
    h.socket().open();
    h.socket().serverClose(1006, 'gone');

    expect(h.posts.find((p) => p.type === 'closed')).toMatchObject({ type: 'closed', reason: 'gone' });
    // no reconnect timeout scheduled
    expect(h.timers.hasTimeout()).toBe(false);
    // stops the flush/heartbeat intervals on close
    expect(h.timers.hasInterval()).toBe(false);
  });

  it('reconnects with backoff when autoReconnect=true', () => {
    const h = makeHarness({ autoReconnect: true });
    h.socket().open();
    h.socket().serverClose(1006, 'gone');

    expect(h.timers.hasTimeout()).toBe(true);
    const socketsBefore = h.sockets.length;
    h.timers.fireNextTimeout(); // reconnect fires → opens a new socket
    expect(h.sockets.length).toBe(socketsBefore + 1);
  });

  it('disconnect from host stops everything and closes the socket', () => {
    const h = makeHarness({ autoReconnect: true });
    h.socket().open();
    h.transport.handleInbound({ type: 'disconnect' });

    expect(h.socket().closed).toBe(true);
    expect(h.timers.hasInterval()).toBe(false);
    expect(h.timers.hasTimeout()).toBe(false);
  });
});

describe('SignalTransport — resync on visibility (F10)', () => {
  it('reconnects immediately when visible and the socket is dead', () => {
    const h = makeHarness({ autoReconnect: false });
    h.socket().open();
    h.socket().serverClose(1006, 'idle-kill'); // silent-stale: socket dead

    const socketsBefore = h.sockets.length;
    h.transport.handleInbound({ type: 'visible' });
    expect(h.sockets.length).toBe(socketsBefore + 1); // new connection opened
  });

  it('does nothing when visible and the socket is healthy', () => {
    const h = makeHarness();
    h.socket().open();
    const socketsBefore = h.sockets.length;
    h.transport.handleInbound({ type: 'visible' });
    expect(h.sockets.length).toBe(socketsBefore); // no new socket
  });
});

// ── model_changed forwarding ────────────────────────────────────────────────

describe('SignalTransport — model_changed', () => {
  it('forwards model_changed with the connected host/port', () => {
    const h = makeHarness();
    h.socket().open();
    h.socket().message({ type: 'model_changed' });

    expect(h.posts.find((p) => p.type === 'model_changed')).toMatchObject({
      type: 'model_changed',
      host: 'localhost',
      port: 7000,
    });
  });

  it('carries name, url and version through the worker boundary', () => {
    const h = makeHarness();
    h.socket().open();
    h.socket().message({
      type: 'model_changed',
      model: 'Fuellstation.glb',
      url: 'models/Fuellstation.glb',
      revision: '12',
    });

    // Without these three the host cannot tell WHICH model was published, and
    // its only remaining option is the page reload plan-365 removes.
    expect(h.posts.find((p) => p.type === 'model_changed')).toMatchObject({
      type: 'model_changed',
      model: 'Fuellstation.glb',
      url: 'models/Fuellstation.glb',
      revision: '12',
    });
  });

  it('recovers the url from `message` for a gateway older than plan-365', () => {
    const h = makeHarness();
    h.socket().open();
    h.socket().message({ type: 'model_changed', message: 'models/Legacy.glb' });

    const post = h.posts.find((p) => p.type === 'model_changed');
    expect(post).toMatchObject({ type: 'model_changed', url: 'models/Legacy.glb' });
    expect(post && 'revision' in post ? post.revision : undefined).toBeUndefined();
  });
});
