// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebSocketRealtimeInterface — WebSocket Realtime v2 protocol implementation.
 *
 * Connects to the realvirtual WebSocket Realtime server (Unity/CONNECT-side)
 * using the v2 flat-JSON protocol:
 *   1. init    → identify client
 *   2. import_request / import_answer → signal discovery
 *   3. subscribe → request signal updates
 *   4. snapshot  → initial values after subscribe
 *   5. data     → bidirectional delta updates
 *
 * Transport lives in a Web Worker (Plan 235, Phase B4). The worker owns the
 * WebSocket, the v2 handshake, the heartbeat and the incoming coalescing —
 * JSON.parse and GC therefore happen off the render thread, and the connection
 * (plus heartbeat) keeps running in a background tab where a rAF-driven loop
 * would freeze. This class is the MAIN-THREAD facade: it starts the worker,
 * forwards outgoing signals into it and turns the worker's coalesced `delta`
 * posts into the existing `bufferIncoming()` buffer/flush path — so
 * base-industrial-interface.ts (onFixedUpdatePre/Post, dirtyOutgoing, echo
 * guard) is unchanged.
 *
 * Reconnect is owned by the base class (`scheduleReconnect` → `connect()` →
 * fresh worker); the worker's own reconnect is disabled so the two engines do
 * not fight. A resync-on-`visibilitychange` handler (F10) nudges the worker to
 * reconnect immediately when the tab returns to the foreground.
 *
 * Also used as base class for ctrlX (same protocol, different auth/URL).
 */

import {
  BaseIndustrialInterface,
  parseSignalType,
  defaultValueForType,
  type SignalDescriptor,
} from './base-industrial-interface';
import type { InterfaceSettings } from './interface-settings-store';
import { emitModelChanged } from '../core/rv-model-update-coordinator';
import {
  SignalTransport,
  REAL_TIMERS,
  type TransportInboundMessage,
  type TransportOutboundMessage,
  type TransportConnectSettings,
  type WebSocketLike,
} from './signal-transport-core';

/**
 * Minimal port surface shared by a real `Worker` and the in-thread fallback.
 * The facade only ever posts inbound messages and receives outbound ones.
 */
interface TransportPort {
  postMessage(msg: TransportInboundMessage): void;
  terminate(): void;
  onMessage(cb: (msg: TransportOutboundMessage) => void): void;
}

/** The page location a same-origin comparison is made against (injectable for tests). */
export interface WsOriginLocation {
  /** `window.location.protocol`, e.g. `'https:'`. */
  protocol: string;
  /** `window.location.hostname` — host WITHOUT port. */
  hostname: string;
  /** `window.location.port` — empty string for the scheme's default port. */
  port: string;
}

/**
 * True when a WebSocket target is the very origin that served this page — the
 * only case in which the browser attaches CONNECT's `SameSite=Strict` session
 * cookie to the handshake (plan-366 Phase 3).
 *
 * Deliberately strict: it compares scheme, host AND port, because a cookie is
 * not the point here, being *provably* same-origin is. Cookies are in fact not
 * port-isolated (RFC 6265 §8.5), so a looser check would sometimes work — and
 * silently not work the rest of the time, which is the worse failure.
 */
export function isSameOriginWsTarget(
  scheme: string,
  address: string,
  port: number,
  location: WsOriginLocation | undefined =
    typeof window === 'undefined' ? undefined : window.location,
): boolean {
  if (!location) return false;
  const expectedProtocol = scheme === 'wss' ? 'https:' : 'http:';
  if (location.protocol !== expectedProtocol) return false;
  if (location.hostname.toLowerCase() !== address.toLowerCase()) return false;
  const pagePort = location.port !== '' ? Number(location.port)
    : location.protocol === 'https:' ? 443 : 80;
  return pagePort === port;
}

/**
 * Read scheme, host and port back out of a fully built WebSocket URL, falling
 * back to the requested values when it cannot be parsed. Subclasses are free to
 * rewrite the URL (ctrlX does), and the same-origin check has to judge the
 * address that is really being dialled.
 */
export function parseWsTarget(
  url: string,
  fallbackScheme: string,
  fallbackHost: string,
  fallbackPort: number,
): { scheme: string; host: string; port: number } {
  try {
    const parsed = new URL(url);
    const scheme = parsed.protocol.replace(/:$/, '');
    const port = parsed.port !== ''
      ? Number(parsed.port)
      : scheme === 'wss' || scheme === 'https' ? 443 : 80;
    return { scheme, host: parsed.hostname, port };
  } catch {
    return { scheme: fallbackScheme, host: fallbackHost, port: fallbackPort };
  }
}

export class WebSocketRealtimeInterface extends BaseIndustrialInterface {
  readonly id: string = 'websocket-realtime';
  readonly protocolName: string = 'WebSocket Realtime';

  private _port: TransportPort | null = null;
  private _openResolve: (() => void) | null = null;
  private _openReject: ((err: Error) => void) | null = null;
  private _connectTimeout: ReturnType<typeof setTimeout> | null = null;

  private _importResolve: ((signals: SignalDescriptor[]) => void) | null = null;
  private _importReject: ((err: Error) => void) | null = null;
  private _importTimeout: ReturnType<typeof setTimeout> | null = null;

  // Target of the current connection, for the same-origin check on `model_changed`.
  // Read back from the URL that was actually built, not from the settings: a
  // subclass may rewrite scheme, host and port (CtrlXInterface pins 443 / 8080),
  // and comparing the settings against the page origin would then be comparing
  // against an address nothing ever connected to.
  private _wsScheme = 'ws';
  private _wsHost = '';
  private _wsPort = 0;

  // Cookie-preferred auth (plan-366 Phase 3). `_usedCookieAuth` describes the
  // attempt in flight, `_cookieAuthFailed` is the latch that puts the query key
  // back for good once a cookie-only handshake did not come up.
  private _usedCookieAuth = false;
  private _cookieAuthFailed = false;

  private _visibilityHandler: (() => void) | null = null;

  // ── Protocol Implementation ──

  protected async doConnect(settings: InterfaceSettings): Promise<void> {
    const scheme = settings.wsUseSSL ? 'wss' : 'ws';
    const path = settings.wsPath.startsWith('/') ? settings.wsPath : '/' + settings.wsPath;
    const url = this.buildUrl(scheme, settings.wsAddress, settings.wsPort, path, settings);
    const target = parseWsTarget(url, scheme, settings.wsAddress, settings.wsPort);
    this._wsScheme = target.scheme;
    this._wsHost = target.host;
    this._wsPort = target.port;
    // A configured token that is NOT in the URL means this attempt rides on the
    // session cookie — which is what a failure below has to fall back from.
    this._usedCookieAuth = !!settings.wsAuthToken && !url.includes('apikey=');

    const transportSettings: TransportConnectSettings = {
      url,
      host: settings.wsAddress,
      port: settings.wsPort,
      // Reconnect is owned by the base class — the worker must not run a second
      // reconnect engine, or two workers would race.
      autoReconnect: false,
    };

    return new Promise<void>((resolve, reject) => {
      this._openResolve = resolve;
      this._openReject = reject;

      try {
        this._port = this.createPort();
      } catch (err) {
        this._openResolve = null;
        this._openReject = null;
        reject(new Error(`Failed to start signal transport: ${err}`));
        return;
      }

      this._port.onMessage((msg) => this.handleTransportMessage(msg));

      this._connectTimeout = setTimeout(() => {
        this._connectTimeout = null;
        const rej = this._openReject;
        this._openResolve = null;
        this._openReject = null;
        this.teardownPort();
        this.noteConnectFailed();
        rej?.(new Error(`Connection to ${url} timed out (5s)`));
      }, 5000);

      this._port.postMessage({ type: 'connect', settings: transportSettings });
    });

    // Note: the returned promise resolves on the worker's `open` message.
  }

  protected doDisconnect(): void {
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }
    this.clearImportPromise();
    this._openResolve = null;
    this._openReject = null;
    this.removeVisibilityHandler();
    this.teardownPort();
  }

  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    return new Promise<SignalDescriptor[]>((resolve, reject) => {
      this._importResolve = resolve;
      this._importReject = reject;

      // Timeout for discovery — null out _importReject first so clearImportPromise
      // doesn't reject with 'Discovery cancelled' before our explicit timeout error
      this._importTimeout = setTimeout(() => {
        this._importReject = null;
        this.clearImportPromise();
        reject(new Error('Signal discovery timed out (10s)'));
      }, 10_000);

      this._port?.postMessage({ type: 'discover' });
    });
  }

  protected sendSignals(signals: Record<string, boolean | number>): void {
    if (!this._port) return;
    this._port.postMessage({ type: 'outgoing', signals });
  }

  // ── Transport (worker) message handling ──

  private handleTransportMessage(msg: TransportOutboundMessage): void {
    switch (msg.type) {
      case 'open':
        this.onTransportOpen();
        break;

      case 'closed':
        this.onTransportClosed(msg.reason);
        break;

      case 'error':
        // Transport-level error — surfaced only if we're still connecting;
        // otherwise the following `closed` drives reconnect via the base class.
        this.onProtocolError(msg.error);
        break;

      case 'delta':
        // Already coalesced by the worker — feed the existing buffer/flush path.
        if (Object.keys(msg.signals).length > 0) this.bufferIncoming(msg.signals);
        break;

      case 'import_answer':
        this.handleImportAnswer(msg.signals, msg.signalTypes);
        break;

      case 'import_error':
        this.handleImportError(msg.error);
        break;

      case 'model_changed':
        this.handleModelChanged(msg.host, msg.port, {
          ...(msg.model !== undefined ? { model: msg.model } : {}),
          ...(msg.url !== undefined ? { url: msg.url } : {}),
          ...(msg.revision !== undefined ? { revision: msg.revision } : {}),
        });
        break;
    }
  }

  private onTransportOpen(): void {
    if (this._connectTimeout) {
      clearTimeout(this._connectTimeout);
      this._connectTimeout = null;
    }
    const resolve = this._openResolve;
    this._openResolve = null;
    this._openReject = null;
    this.installVisibilityHandler();
    resolve?.();
  }

  private onTransportClosed(reason: string): void {
    // If we were still waiting on the initial open, reject that promise so the
    // base class treats it as a failed connect (and schedules a reconnect).
    if (this._openReject) {
      if (this._connectTimeout) {
        clearTimeout(this._connectTimeout);
        this._connectTimeout = null;
      }
      const rej = this._openReject;
      this._openResolve = null;
      this._openReject = null;
      // A handshake CONNECT refused (401) closes without ever opening — that is
      // exactly the shape an expired session cookie produces, so the next
      // attempt carries the query key again.
      this.noteConnectFailed();
      rej(new Error(reason));
      return;
    }
    // Established connection dropped — let the base class reconnect.
    if (this.isConnected) {
      this.onConnectionLost(reason);
    }
  }

  // ── Message payload handling ──

  private handleImportAnswer(
    values: Record<string, unknown>,
    types: Record<string, string>,
  ): void {
    if (!this._importResolve) return;

    const signals: SignalDescriptor[] = [];

    for (const name in values) {
      // Default unknown-typed signals to a PLC output (PLC writes, viewer reads = display-only).
      const plcType = types[name] ?? 'PLCOutputFloat';
      const { type, direction } = parseSignalType(plcType);
      const rawValue = values[name];

      let initialValue: boolean | number;
      if (typeof rawValue === 'boolean') {
        initialValue = rawValue;
      } else if (typeof rawValue === 'number') {
        initialValue = rawValue;
      } else {
        initialValue = defaultValueForType(type);
      }

      signals.push({ name, type, direction, initialValue });
    }

    // Resolve the discovery promise — null out reject first to prevent
    // clearImportPromise from rejecting a successfully resolved discovery
    const resolve = this._importResolve;
    this._importReject = null;
    this.clearImportPromise();
    resolve(signals);
    // (The worker sends the `subscribe` message itself after import_answer.)
  }

  private handleImportError(error: string): void {
    if (!this._importReject) return;
    const reject = this._importReject;
    this._importResolve = null;
    this.clearImportPromise();
    reject(new Error(error));
  }

  /**
   * Report a model the serving gateway just published (plan-365 Phase 3).
   *
   * This used to reload the whole page, which threw away the camera, the mode
   * and any unsaved work — and did so no matter which model had been published.
   * The transport now only says *what* changed; a single viewer-side coordinator
   * decides whether anything happens at all, and deduplicates the same
   * announcement arriving over the two-or-three sockets a page can hold.
   *
   * The origin check stays, because a foreign gateway has no business steering
   * this page's model. It uses `isSameOriginWsTarget`, which compares scheme,
   * host and port including the implicit ones — the previous inline comparison
   * looked at `location.port`, which is empty on HTTPS/443, and never at the
   * scheme at all.
   */
  private handleModelChanged(_host: number | string, _port: number, payload?: {
    model?: string;
    url?: string;
    revision?: string;
  }): void {
    if (!isSameOriginWsTarget(this._wsScheme, this._wsHost, this._wsPort)) return;
    emitModelChanged({
      ...(payload?.model !== undefined ? { name: payload.model } : {}),
      ...(payload?.url !== undefined ? { url: payload.url } : {}),
      ...(payload?.revision !== undefined ? { revision: payload.revision } : {}),
      source: this.id,
    });
  }

  // ── Resync on visibilitychange (F10) ──

  private installVisibilityHandler(): void {
    if (typeof document === 'undefined' || this._visibilityHandler) return;
    this._visibilityHandler = () => {
      if (!document.hidden) {
        // Nudge the worker to verify the socket and reconnect if it is dead —
        // don't wait for the TCP timeout. CONNECT re-sends a full snapshot.
        this._port?.postMessage({ type: 'visible' });
      }
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  private removeVisibilityHandler(): void {
    if (typeof document === 'undefined' || !this._visibilityHandler) return;
    document.removeEventListener('visibilitychange', this._visibilityHandler);
    this._visibilityHandler = null;
  }

  // ── Port / worker management ──

  /**
   * Create the transport port. Uses a real Web Worker when available; falls
   * back to an in-thread SignalTransport (same protocol) when Workers are not
   * available (SSR, restricted CSP, unit tests). Overridable in tests.
   */
  protected createPort(): TransportPort {
    if (typeof Worker !== 'undefined') {
      try {
        return this.createWorkerPort();
      } catch {
        // Fall through to the in-thread fallback below.
      }
    }
    return this.createInlinePort();
  }

  /** Real Web Worker port. */
  private createWorkerPort(): TransportPort {
    const worker = new Worker(
      new URL('./signal-transport.worker.ts', import.meta.url),
      { type: 'module' },
    );
    let handler: ((msg: TransportOutboundMessage) => void) | null = null;
    worker.onmessage = (ev: MessageEvent) => handler?.(ev.data as TransportOutboundMessage);
    return {
      postMessage: (msg) => worker.postMessage(msg),
      terminate: () => {
        worker.onmessage = null;
        worker.terminate();
      },
      onMessage: (cb) => { handler = cb; },
    };
  }

  /** In-thread fallback port — a SignalTransport driven on the main thread. */
  private createInlinePort(): TransportPort {
    let handler: ((msg: TransportOutboundMessage) => void) | null = null;
    const transport = new SignalTransport({
      createSocket: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
      post: (msg) => handler?.(msg),
      timers: REAL_TIMERS,
    });
    return {
      postMessage: (msg) => transport.handleInbound(msg),
      terminate: () => transport.handleInbound({ type: 'disconnect' }),
      onMessage: (cb) => { handler = cb; },
    };
  }

  private teardownPort(): void {
    if (this._port) {
      try {
        this._port.postMessage({ type: 'disconnect' });
      } catch {
        /* ignore */
      }
      try {
        this._port.terminate();
      } catch {
        /* ignore */
      }
      this._port = null;
    }
  }

  // ── Helpers ──

  /**
   * Build the WebSocket URL. Override in subclasses for custom URL schemes.
   * When an auth token is configured it is appended as `?apikey=` — matching
   * the CONNECT `/ws` auth gate (Plan 235, Phase A0).
   *
   * Since plan-366 the key is **left out for a same-origin target**: CONNECT
   * hands the browser an httpOnly session cookie when the gateway is opened
   * once with `?apikey=`, and that cookie travels with the handshake by itself.
   * Keeping a credential in a URL that lands in every proxy and server log is
   * worth avoiding where something else already proves the request.
   *
   * The query key is **not** removed, only skipped: cross-origin it is the sole
   * workable proof (a browser cannot set headers on a handshake and a
   * `SameSite=Strict` cookie is not sent cross-site), and same-origin it comes
   * back the moment a cookie-only attempt fails — an expired cookie must not
   * strand a running HMI.
   */
  protected buildUrl(
    scheme: string,
    address: string,
    port: number,
    path: string,
    settings: InterfaceSettings,
  ): string {
    const base = `${scheme}://${address}:${port}${path}`;
    if (!settings.wsAuthToken) return base;
    if (!this._cookieAuthFailed && isSameOriginWsTarget(scheme, address, port)) return base;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}apikey=${encodeURIComponent(settings.wsAuthToken)}`;
  }

  /**
   * Remember that a connection attempt which relied on the session cookie did
   * not come up, so every later attempt carries the query key again. Not reset
   * on success: once the cookie has been shown to be insufficient, the key is
   * the cheaper certainty for the rest of the session.
   */
  private noteConnectFailed(): void {
    if (this._usedCookieAuth) this._cookieAuthFailed = true;
  }

  private clearImportPromise(): void {
    if (this._importTimeout) {
      clearTimeout(this._importTimeout);
      this._importTimeout = null;
    }
    // Reject any pending discovery promise before clearing.
    if (this._importReject) {
      this._importReject(new Error('Discovery cancelled'));
    }
    this._importResolve = null;
    this._importReject = null;
  }
}
