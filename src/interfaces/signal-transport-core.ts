// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-transport-core — protocol + coalescing engine for the WebSocket
 * Realtime v2 transport that runs inside a Web Worker.
 *
 * This module is deliberately UI-free and DOM-free so it can run both inside
 * a `Worker` (via signal-transport.worker.ts) and directly on the main thread
 * (fallback when Workers are unavailable, and for unit tests). All environment
 * dependencies — the WebSocket constructor, the timer functions and the
 * message-out callback — are injected, so the class is fully testable without a
 * real Worker or a real socket.
 *
 * Responsibilities (Plan 235, Phase B4 / F8 / F10):
 *   - Own the WebSocket connection incl. the v2 handshake
 *     (init → import_request → import_answer → subscribe → snapshot → data).
 *   - Reconnect with exponential backoff.
 *   - Heartbeat that keeps the connection alive in a background tab
 *     (worker `setInterval` is not throttled like a main-thread timer).
 *   - Coalesce incoming `data` deltas in a Map (last value wins) and flush
 *     them once per ~16 ms — taking JSON.parse + GC off the render thread.
 *   - Forward `import_answer`, `snapshot` and `model_changed` to the host.
 *   - Send outgoing signals (viewer → PLC) over the same socket.
 */

// ── Wire protocol (matches SignalTransportData.cs WsMessage) ───────────────

/** A single message on the rv WebSocket Realtime v2 wire. */
export interface WsMessage {
  type: string;
  version?: number;
  name?: string;
  signals?: Record<string, unknown>;
  signalTypes?: Record<string, string>;
  subscribe?: string[];
  config?: Record<string, unknown>;
  success?: boolean;
  message?: string;
  /** `model_changed`: file name of the published model, e.g. `Fuellstation.glb`. */
  model?: string;
  /** `model_changed`: the URL the model is actually served under (mode-dependent — never rebuilt). */
  url?: string;
  /** `model_changed`: per-model counter, bumped on every publish. */
  revision?: string;
}

// ── Worker ⇄ Main protocol ─────────────────────────────────────────────────

/** Settings the host passes to the worker to open a connection. */
export interface TransportConnectSettings {
  /** Fully built WebSocket URL (scheme + host + port + path + `?apikey=`). */
  url: string;
  /** Host part of the target (echoed back for the same-origin model-reload check). */
  host: string;
  /** Port of the target. */
  port: number;
  /** Whether the transport should reconnect automatically on unexpected close. */
  autoReconnect: boolean;
}

/** Messages sent from the main thread INTO the worker. */
export type TransportInboundMessage =
  | { type: 'connect'; settings: TransportConnectSettings }
  | { type: 'disconnect' }
  | { type: 'discover' }
  | { type: 'outgoing'; signals: Record<string, boolean | number> }
  | { type: 'visible' }; // resync-on-visibilitychange (F10)

/** Messages the worker posts OUT to the main thread. */
export type TransportOutboundMessage =
  | { type: 'open' }
  | { type: 'closed'; reason: string }
  | { type: 'error'; error: string }
  | { type: 'delta'; signals: Record<string, boolean | number> }
  | { type: 'import_answer'; signals: Record<string, unknown>; signalTypes: Record<string, string> }
  | { type: 'import_error'; error: string }
  /**
   * A gateway announced a published model. The worker forwards WHAT changed instead of
   * discarding it (plan-365 Phase 2): without the URL the host cannot tell whether the
   * published model is the one on screen, and its only remaining option is the page reload
   * this plan removes.
   *
   * `model`/`url`/`revision` are optional on purpose — a gateway older than plan-365 sends
   * only `message`, from which `url` is recovered; it has no revision at all.
   */
  | {
      type: 'model_changed';
      host: string;
      port: number;
      model?: string;
      url?: string;
      revision?: string;
    };

/** Function that posts a message from the worker to the main thread. */
export type PostFn = (msg: TransportOutboundMessage) => void;

/** Minimal WebSocket surface the transport needs (native or mock). */
export interface WebSocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Factory that creates a WebSocket-like object for a given URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

/** Injectable timer functions (worker `self` in production, fakes in tests). */
export interface TransportTimers {
  setInterval: (cb: () => void, ms: number) => number;
  clearInterval: (handle: number) => void;
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (handle: number) => void;
  now: () => number;
}

/** Options for the SignalTransport (all injectable for testing). */
export interface SignalTransportOptions {
  createSocket: WebSocketFactory;
  post: PostFn;
  timers?: TransportTimers;
  /** Flush interval in ms (default ≈16 ms, one delta per frame). */
  flushIntervalMs?: number;
  /** Heartbeat interval in ms (default 25 000; below CONNECT ZombieTimeout 90 s). */
  heartbeatIntervalMs?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

const WS_OPEN = 1;
const WS_CONNECTING = 0;

const DEFAULT_FLUSH_INTERVAL_MS = 16;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;

// ── Default timers (real worker/main-thread globals) ───────────────────────

/** Timer set backed by the real global timer functions. */
export const REAL_TIMERS: TransportTimers = {
  setInterval: (cb, ms) => setInterval(cb, ms) as unknown as number,
  clearInterval: (h) => clearInterval(h),
  setTimeout: (cb, ms) => setTimeout(cb, ms) as unknown as number,
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
};

// ── Coalescer ──────────────────────────────────────────────────────────────

/**
 * Coalesces incoming signal updates so that many fast `data` messages collapse
 * into a single delta (last value wins per signal). This is what keeps the
 * render thread from being flooded: instead of one flush per message, the
 * worker flushes at most once per ~16 ms.
 */
export class Coalescer {
  private readonly pending = new Map<string, boolean | number>();

  /** Merge one incoming signal batch — last value wins per name. */
  merge(signals: Record<string, boolean | number>): void {
    for (const name in signals) {
      this.pending.set(name, signals[name]);
    }
  }

  /** Number of distinct signals currently buffered. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Drain the buffer into a plain object and clear it.
   * Returns null when nothing is pending (so the caller can skip the post).
   */
  drain(): Record<string, boolean | number> | null {
    if (this.pending.size === 0) return null;
    const out: Record<string, boolean | number> = {};
    for (const [name, value] of this.pending) out[name] = value;
    this.pending.clear();
    return out;
  }
}

/**
 * Parse a raw `data`/`snapshot` message's `signals` map into a normalized
 * `{ name: boolean | number }` object. Strings are coerced the same way the
 * old main-thread handler did (so behavior is byte-for-byte preserved).
 */
export function parseSignalValues(
  signals: Record<string, unknown> | undefined,
): Record<string, boolean | number> {
  const out: Record<string, boolean | number> = {};
  if (!signals) return out;
  for (const name in signals) {
    const value = signals[name];
    if (typeof value === 'boolean' || typeof value === 'number') {
      out[name] = value;
    } else if (typeof value === 'string') {
      if (value === 'true' || value === 'True') out[name] = true;
      else if (value === 'false' || value === 'False') out[name] = false;
      else {
        const num = Number(value);
        if (!isNaN(num)) out[name] = num;
      }
    }
  }
  return out;
}

// Backoff policy shared with the main-thread interfaces (worker-safe module).
import { reconnectDelay } from './reconnect-policy';
export { reconnectDelay } from './reconnect-policy';

// ── SignalTransport ─────────────────────────────────────────────────────────

/**
 * Owns one WebSocket Realtime v2 connection and its lifecycle. Lives inside the
 * Web Worker in production; instantiated directly in tests and in the
 * no-Worker fallback path.
 */
export class SignalTransport {
  private readonly createSocket: WebSocketFactory;
  private readonly post: PostFn;
  private readonly timers: TransportTimers;
  private readonly flushIntervalMs: number;
  private readonly heartbeatIntervalMs: number;

  private ws: WebSocketLike | null = null;
  private settings: TransportConnectSettings | null = null;

  private readonly coalescer = new Coalescer();
  private flushHandle: number | null = null;
  private heartbeatHandle: number | null = null;
  private reconnectHandle: number | null = null;
  private reconnectAttempt = 0;

  /** Set once the host asked to disconnect — suppresses reconnect. */
  private closedByHost = false;
  /** Whether a discovery (import_request) has been requested by the host. */
  private discoverPending = false;

  constructor(opts: SignalTransportOptions) {
    this.createSocket = opts.createSocket;
    this.post = opts.post;
    this.timers = opts.timers ?? REAL_TIMERS;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  }

  /** Dispatch a message received from the main thread. */
  handleInbound(msg: TransportInboundMessage): void {
    switch (msg.type) {
      case 'connect':
        this.connect(msg.settings);
        break;
      case 'disconnect':
        this.disconnect();
        break;
      case 'discover':
        this.requestDiscovery();
        break;
      case 'outgoing':
        this.sendData(msg.signals);
        break;
      case 'visible':
        this.onVisible();
        break;
    }
  }

  // ── Connection lifecycle ──

  private connect(settings: TransportConnectSettings): void {
    this.closedByHost = false;
    this.settings = settings;
    this.openSocket();
  }

  private openSocket(): void {
    if (!this.settings) return;
    this.teardownSocket();

    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.settings.url);
    } catch (err) {
      this.post({ type: 'error', error: `Failed to create WebSocket: ${err}` });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // v2 handshake: identify the client.
      this.wsSend({ type: 'init', version: 2, name: 'WebViewer' });
      this.startFlush();
      this.startHeartbeat();
      this.post({ type: 'open' });
      // If the host already asked to discover, kick it off now.
      if (this.discoverPending) {
        this.wsSend({ type: 'import_request', version: 2 });
      }
    };

    ws.onmessage = (ev) => {
      this.handleWireMessage(ev.data);
    };

    ws.onclose = (ev) => {
      this.stopFlush();
      this.stopHeartbeat();
      const reason = ev.reason || `WebSocket closed (code ${ev.code})`;
      this.post({ type: 'closed', reason });
      if (!this.closedByHost) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose fires afterwards and handles reconnect.
      this.post({ type: 'error', error: 'WebSocket error' });
    };
  }

  private disconnect(): void {
    this.closedByHost = true;
    this.discoverPending = false;
    this.cancelReconnect();
    this.stopFlush();
    this.stopHeartbeat();
    this.coalescer.drain(); // discard buffered
    this.teardownSocket();
    this.settings = null;
  }

  /** Detach handlers and close the socket without emitting a reconnect. */
  private teardownSocket(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    if (ws.readyState === WS_OPEN || ws.readyState === WS_CONNECTING) {
      try {
        ws.close(1000, 'Client disconnect');
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  // ── Discovery ──

  private requestDiscovery(): void {
    this.discoverPending = true;
    if (this.ws && this.ws.readyState === WS_OPEN) {
      this.wsSend({ type: 'import_request', version: 2 });
    }
  }

  // ── Wire message handling (runs off the render thread) ──

  private handleWireMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: WsMessage;
    try {
      msg = JSON.parse(raw) as WsMessage;
    } catch {
      this.post({ type: 'error', error: `Invalid JSON: ${raw.substring(0, 100)}` });
      return;
    }

    switch (msg.type) {
      case 'import_answer':
        this.discoverPending = false;
        this.post({
          type: 'import_answer',
          signals: msg.signals ?? {},
          signalTypes: msg.signalTypes ?? {},
        });
        // Subscribe to everything the server offered.
        this.wsSend({ type: 'subscribe', version: 2, subscribe: Object.keys(msg.signals ?? {}) });
        break;

      case 'snapshot':
      case 'data': {
        // Coalesce into the map — do NOT post per message. A background-tab
        // worker keeps parsing; the flush interval bounds how often we post.
        const values = parseSignalValues(msg.signals);
        if (Object.keys(values).length > 0) this.coalescer.merge(values);
        break;
      }

      case 'model_changed':
        if (this.settings) {
          // Backwards compatible: pre-plan-365 gateways put the URL in `message` and send
          // nothing else, so `url` falls back to it and `revision` simply stays undefined.
          const url = msg.url ?? msg.message;
          this.post({
            type: 'model_changed',
            host: this.settings.host,
            port: this.settings.port,
            ...(msg.model !== undefined ? { model: msg.model } : {}),
            ...(url !== undefined ? { url } : {}),
            ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
          });
        }
        break;

      case 'config_answer':
      case 'config_result':
      default:
        // Not used / unknown — ignore.
        break;
    }
  }

  // ── Outgoing (viewer → PLC) ──

  private sendData(signals: Record<string, boolean | number>): void {
    if (!signals || Object.keys(signals).length === 0) return;
    this.wsSend({ type: 'data', version: 2, signals: signals as Record<string, unknown> });
  }

  private wsSend(msg: WsMessage): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      /* socket race — dropped, reconnect heals */
    }
  }

  // ── Flush loop (coalesced delta → main thread, ~1×/frame) ──

  private startFlush(): void {
    if (this.flushHandle !== null) return;
    this.flushHandle = this.timers.setInterval(() => this.flush(), this.flushIntervalMs);
  }

  private stopFlush(): void {
    if (this.flushHandle !== null) {
      this.timers.clearInterval(this.flushHandle);
      this.flushHandle = null;
    }
  }

  /** Drain the coalesced buffer and post a single delta if non-empty. */
  flush(): void {
    const delta = this.coalescer.drain();
    if (delta) this.post({ type: 'delta', signals: delta });
  }

  // ── Heartbeat (keeps background-tab socket alive; avoids Zombie kill) ──

  private startHeartbeat(): void {
    if (this.heartbeatHandle !== null) return;
    this.heartbeatHandle = this.timers.setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatHandle !== null) {
      this.timers.clearInterval(this.heartbeatHandle);
      this.heartbeatHandle = null;
    }
  }

  private sendHeartbeat(): void {
    // A lightweight init keeps the server-side ZombieTimeout from tripping.
    // The server ignores repeated inits; it only needs traffic on the socket.
    this.wsSend({ type: 'init', version: 2, name: 'WebViewer' });
  }

  // ── Resync on visibility (F10) ──

  /**
   * Called when the tab becomes visible again. If the socket looks dead,
   * reconnect immediately instead of waiting for the TCP timeout. CONNECT
   * sends a full snapshot on (re)connect so the stale state is healed.
   */
  private onVisible(): void {
    if (!this.settings || this.closedByHost) return;
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      this.cancelReconnect();
      this.reconnectAttempt = 0;
      this.openSocket();
    }
  }

  // ── Reconnect ──

  private scheduleReconnect(): void {
    if (!this.settings || !this.settings.autoReconnect || this.closedByHost) return;
    this.cancelReconnect();
    const delay = reconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    this.reconnectHandle = this.timers.setTimeout(() => {
      this.reconnectHandle = null;
      if (this.closedByHost) return;
      this.openSocket();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.timers.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }
}
