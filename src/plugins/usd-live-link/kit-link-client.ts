// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * KitLinkClient — the browser WebSocket to the Kit extension `realvirtual.livesync`
 * (plan-637 F7/F8).
 *
 * - Never connects on its own: the first attempt is {@link start}, which only
 *   the user's click on "Sync to Isaac Sim" calls. Chrome's Local Network
 *   Access prompt belongs to that click (same rule as `connect-plugin`'s
 *   `mayProbe`).
 * - After the socket opened it sends `hello` first; nothing else goes out
 *   before the extension answered `ready`.
 * - A lost connection is retried with the shared `reconnectDelay` backoff.
 *   Every `ready` (first or re-connect) is reported through `onReady` — the
 *   plugin mounts and sends the full state again each time.
 * - Close codes the user has to fix (wrong token 4401, origin 4403) stop the
 *   retries; everything else retries until {@link stop}.
 * - A socket that closes before `open` looks the same in the browser whether
 *   nothing listens on the port or another program refused the upgrade (1006
 *   both times). Once per failure streak the client asks the port over HTTP
 *   ({@link probeLiveSyncPort}): another program answering → stop with a clear
 *   message instead of retrying forever; nothing listening or unsure → retry.
 * - Backpressure: {@link canSendFrame} is false while `bufferedAmount` is
 *   above the limit, so the tracker keeps its deltas for the next tick
 *   instead of piling frames into the socket buffer.
 */

import { reconnectDelay } from '../../interfaces/reconnect-policy';
import { encodeHello, parseAck, type LiveSyncAck } from './livesync-protocol';

/** Close codes the extension uses. */
export const KIT_CLOSE = {
  /** Token missing or wrong. */
  AUTH: 4401,
  /** Origin not on the allowlist. */
  ORIGIN: 4403,
  /** Another client is already connected. */
  BUSY: 4409,
  /** No `hello` within the auth timeout. */
  AUTH_TIMEOUT: 4408,
} as const;

/** Default upper bound of the socket send buffer before frames are skipped. */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type KitLinkPhase = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'waiting-retry' | 'stopped';

export interface KitLinkClientOptions {
  url: string;
  token: string;
  rateHz: number;
  /** `ready` received (first connect and every re-connect); carries the extension's version. */
  onReady(ack: LiveSyncAck): void;
  /** Any other ack (`mounted`, `error`). */
  onAck(ack: LiveSyncAck): void;
  /**
   * The socket is gone. `retrying` = a reconnect is scheduled. `code` is the
   * close code (undefined when the browser refused to open the socket at all).
   */
  onDisconnected(reason: string, retrying: boolean, code?: number): void;
  maxBufferedBytes?: number;
  /** Backoff override (tests). */
  retryDelay?: (attempt: number) => number;
  /**
   * `fetch` for the port probe (tests inject one). `null` switches the probe
   * off. Default: the global `fetch`, when there is one.
   */
  fetch?: typeof fetch | null;
  /** Upper bound of one probe request in milliseconds (default {@link PROBE_TIMEOUT_MS}). */
  probeTimeoutMs?: number;
}

/** Plain-HTTP path the Kit extension answers on its WebSocket port. */
export const LIVESYNC_PROBE_PATH = '/realvirtual-livesync';
/** `service` field of the extension's probe answer. */
export const LIVESYNC_SERVICE = 'realvirtual.livesync';
/** Upper bound of one probe request. */
export const PROBE_TIMEOUT_MS = 2000;

/** What answers on the port: the extension, another program, or nobody / unknown. */
export type PortProbeResult = 'livesync' | 'foreign' | 'none';

/** Status line when another program holds the port. */
export function foreignPortMessage(port: number | string): string {
  return `Port ${port} is used by another program (not realvirtual.livesync). Change the port under USD ▸ ⚙ and the Kit setting /exts/realvirtual.livesync/port to the same value.`;
}

/** `http://<host>:<port>/realvirtual-livesync` for a `ws://` URL, or null when it cannot be derived. */
export function probeUrlFor(wsUrl: string): string | null {
  try {
    const u = new URL(wsUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    const scheme = u.protocol === 'wss:' ? 'https:' : 'http:';
    return `${scheme}//${u.host}${LIVESYNC_PROBE_PATH}`;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      f(url, { ...init, cache: 'no-store', credentials: 'omit', signal: ctrl?.signal }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { ctrl?.abort(); reject(new Error('probe timeout')); }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Ask a port what answers on it.
 *
 * 1. CORS `GET /realvirtual-livesync`: the extension answers JSON with
 *    `service: 'realvirtual.livesync'` and `Access-Control-Allow-Origin: *` →
 *    `livesync`. Any other readable answer is another program → `foreign`.
 * 2. The CORS request failed (no CORS header, or blocked): an opaque
 *    `no-cors` request. It resolves → a server answered HTTP on the port →
 *    `foreign`; it rejects → nothing listens, or the browser blocked the local
 *    request (Local Network Access, mixed content) → `none`.
 *
 * Anything unexpected is `none`: a blocked request must never be read as a
 * foreign server, because `foreign` stops the retries.
 */
export async function probeLiveSyncPort(url: string, f: typeof fetch, timeoutMs = PROBE_TIMEOUT_MS): Promise<PortProbeResult> {
  try {
    const res = await fetchWithTimeout(f, url, { mode: 'cors' }, timeoutMs);
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    const service = body !== null && typeof body === 'object' ? (body as { service?: unknown }).service : undefined;
    return service === LIVESYNC_SERVICE ? 'livesync' : 'foreign';
  } catch {
    // fall through to the opaque request
  }
  try {
    await fetchWithTimeout(f, url, { mode: 'no-cors' }, timeoutMs);
    return 'foreign';
  } catch {
    return 'none';
  }
}

/** Plain-language reason for a close code. */
export function describeClose(code: number, reason: string): string {
  switch (code) {
    case KIT_CLOSE.AUTH: return 'Isaac Sim refused the access token. Copy the token from the realvirtual Live Sync panel.';
    case KIT_CLOSE.ORIGIN: return `Isaac Sim does not accept connections from this page (${typeof location !== 'undefined' ? location.origin : 'origin'}). Add it to the allowed origins of the extension.`;
    case KIT_CLOSE.BUSY: return 'Another viewer is already connected to Isaac Sim.';
    case KIT_CLOSE.AUTH_TIMEOUT: return 'Isaac Sim closed the connection: no handshake in time.';
    case 1006: return 'Isaac Sim is not reachable. Start Isaac Sim with the realvirtual Live Sync extension enabled (or the browser blocked the local connection).';
    default: return reason ? `Connection closed: ${reason} (${code})` : `Connection closed (${code})`;
  }
}

export class KitLinkClient {
  private ws: WebSocket | null = null;
  private _phase: KitLinkPhase = 'idle';
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBuffered: number;
  /** True once the port was probed in the current failure streak (reset by an `open`). */
  private probedThisStreak = false;
  /** Bumped on every `open` / start / stop: a probe answer of an older streak is ignored. */
  private streak = 0;

  constructor(private readonly opts: KitLinkClientOptions) {
    this.maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  get phase(): KitLinkPhase { return this._phase; }
  get isReady(): boolean { return this._phase === 'ready'; }

  /** First connection attempt — call only from a user gesture. */
  start(): void {
    if (this._phase !== 'idle' && this._phase !== 'stopped') return;
    this.attempt = 0;
    this.streak++;
    this.probedThisStreak = false;
    this.connect();
  }

  /** Close for good (no retry). Idempotent. */
  stop(): void {
    this._phase = 'stopped';
    this.streak++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
      try { ws.close(1000, 'sync off'); } catch { /* already closed */ }
    }
  }

  /** True when a frame may be sent now (connected + send buffer below the limit). */
  canSendFrame(): boolean {
    const ws = this.ws;
    return this._phase === 'ready' && !!ws && ws.readyState === 1 && (ws.bufferedAmount ?? 0) <= this.maxBuffered;
  }

  /** Send now (only while ready). Returns false when nothing was sent. */
  send(data: Uint8Array | string): boolean {
    const ws = this.ws;
    if (this._phase !== 'ready' || !ws || ws.readyState !== 1) return false;
    ws.send(data as unknown as string);
    return true;
  }

  /**
   * Send a large message (mount chunk) once the send buffer drained below the
   * limit. Resolves false when the socket went away or `stillWanted` turned
   * false while waiting.
   */
  async sendWhenDrained(data: Uint8Array, stillWanted: () => boolean): Promise<boolean> {
    for (;;) {
      if (!stillWanted() || this._phase !== 'ready' || !this.ws) return false;
      if ((this.ws.bufferedAmount ?? 0) <= this.maxBuffered) return this.send(data);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private connect(): void {
    this._phase = 'connecting';
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      // Mixed content / SecurityError: no event will ever come, and a retry
      // cannot heal it.
      this._phase = 'stopped';
      this.opts.onDisconnected(`The browser blocked the connection to ${this.opts.url}: ${e instanceof Error ? e.message : String(e)}`, false);
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.streak++;
      this.probedThisStreak = false;
      this._phase = 'authenticating';
      ws.send(encodeHello(this.opts.token, this.opts.rateHz));
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      const ack = parseAck(ev.data);
      if (!ack) return;
      if (ack.type === 'ready') {
        this._phase = 'ready';
        this.attempt = 0;
        this.opts.onReady(ack);
        return;
      }
      this.opts.onAck(ack);
    };
    ws.onerror = () => { /* the close event follows and carries the decision */ };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const fatal = ev.code === KIT_CLOSE.AUTH || ev.code === KIT_CLOSE.ORIGIN;
      const reason = describeClose(ev.code, ev.reason);
      if (fatal || this._phase === 'stopped') {
        this._phase = 'stopped';
        this.opts.onDisconnected(reason, false, ev.code);
        return;
      }
      this._phase = 'waiting-retry';
      const delay = (this.opts.retryDelay ?? reconnectDelay)(this.attempt++);
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this._phase === 'waiting-retry') this.connect();
      }, delay);
      this.opts.onDisconnected(reason, true, ev.code);
      if (!opened && !this.probedThisStreak) {
        this.probedThisStreak = true;
        this.probePort();
      }
    };
  }

  /**
   * Once per failure streak: is it another program on the port? Runs next to
   * the scheduled retry (a probe of a local port answers in milliseconds);
   * only `foreign` changes anything: it cancels the retry and stops.
   */
  private probePort(): void {
    const f = this.opts.fetch === undefined
      ? (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
      : this.opts.fetch;
    if (!f) return;
    const url = probeUrlFor(this.opts.url);
    if (!url) return;
    const streak = this.streak;
    void probeLiveSyncPort(url, f, this.opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS).then((result) => {
      if (result !== 'foreign' || streak !== this.streak || this._phase === 'stopped' || this._phase === 'ready') return;
      let port = '';
      try { port = new URL(this.opts.url).port; } catch { /* keep empty */ }
      this.stop();
      this.opts.onDisconnected(foreignPortMessage(port !== '' ? port : '?'), false);
    });
  }
}
