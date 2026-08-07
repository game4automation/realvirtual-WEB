// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { Logger } from './log.js';
import type {
  BridgeStatus,
  BrowserMessage,
  CallMessage,
  ControlAction,
  LogLine,
  ServerMessage,
  ToolSchema,
} from './protocol.js';
import { DEFAULT_WEB_PORT } from './protocol.js';

/** A tool call awaiting its result from the browser. */
interface PendingCall {
  resolve: (result: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WebBridgeOptions {
  port?: number;
  host?: string;
  /** Fail when the requested port is busy instead of drifting upward. */
  strictPort?: boolean;
  callTimeoutMs?: number;
  logger: Logger;
  /** Same-port EADDRINUSE retries before drifting to the next port (default 12). */
  bindRetries?: number;
  /** Delay between same-port retries, ms (default 300). */
  bindRetryDelayMs?: number;
  /** How many ports above the requested one to probe before degrading (default 20). */
  maxPortDrift?: number;
}

export interface WebBridgeEvents {
  /** Browser announced its tool set + instructions. */
  discover: (tools: ToolSchema[], instructions: string) => void;
  /** Browser requested a control action. */
  control: (action: ControlAction) => void;
  /** Active browser disconnected (genuine close, not a single-tab replacement). */
  disconnect: () => void;
}

/**
 * WebSocket server that bridges a single browser tab to the MCP layer.
 *
 * Ported 1:1 from the Python `WebViewerBridge` (unity_mcp_server.py), with
 * Node-specific hardening: single-tab close-race guard, EADDRINUSE graceful
 * degradation, per-call timeout cleanup, and a log mirror to the browser.
 */
export class WebBridge {
  private readonly _host: string;
  private _port: number;
  private readonly _callTimeoutMs: number;
  private readonly _log: Logger;
  private readonly _strictPort: boolean;
  private readonly _bindRetries: number;
  private readonly _bindRetryDelayMs: number;
  private readonly _maxPortDrift: number;

  private _wss: WebSocketServer | null = null;
  private _browser: WebSocket | null = null;
  private _cmdId = 0;
  private readonly _pending = new Map<number, PendingCall>();
  private _paused = false;
  private _bindFailed = false;
  private readonly _emitter = new EventEmitter();

  constructor(opts: WebBridgeOptions) {
    this._host = opts.host ?? '127.0.0.1';
    this._port = opts.port ?? DEFAULT_WEB_PORT;
    this._callTimeoutMs = opts.callTimeoutMs ?? 15000;
    this._log = opts.logger;
    this._strictPort = opts.strictPort ?? false;
    this._bindRetries = opts.bindRetries ?? 12;
    this._bindRetryDelayMs = opts.bindRetryDelayMs ?? 300;
    this._maxPortDrift = opts.maxPortDrift ?? 20;
  }

  on<E extends keyof WebBridgeEvents>(event: E, cb: WebBridgeEvents[E]): void {
    this._emitter.on(event, cb as (...args: unknown[]) => void);
  }

  /** Actual bound port (resolves an ephemeral `0` after `start()`). */
  get port(): number {
    return this._port;
  }

  get connected(): boolean {
    return this._browser?.readyState === WebSocket.OPEN;
  }

  /** True if the WS server could not bind (e.g. port already in use). */
  get bindFailed(): boolean {
    return this._bindFailed;
  }

  /**
   * Start the WS server. Idempotent. Resolves once listening or — only after
   * exhausting both the same-port retries and the port-drift range — on a
   * graceful bind failure.
   *
   * Two distinct EADDRINUSE causes are handled in order:
   *
   * 1. A bridge from a *just-killed* host session has not finished releasing the
   *    canonical port yet (TIME_WAIT / async close). Retrying the SAME port with
   *    a short backoff lets the previous owner free it within a few hundred ms,
   *    so the reconnecting session keeps its canonical port (e.g. 18715). This
   *    combines with the host-death exit in index.ts into a self-healing delay.
   *
   * 2. The canonical port is held by a *live concurrent* session (a second
   *    Claude client). Retrying never helps, so instead of degrading to 0 tools
   *    we DRIFT to the next free port and bind there: this session still gets a
   *    fully working bridge (tools register normally); only the browser must be
   *    pointed at the new port (WebViewer ▸ Settings ▸ AI Bridge). The bound port
   *    is surfaced via `get port()` and the status frame.
   */
  async start(): Promise<void> {
    if (this._wss) return;
    const requestedPort = this._port;

    // Phase 1 — the canonical port, with backoff (self-heal a dying predecessor).
    for (let attempt = 0; attempt <= this._bindRetries; attempt++) {
      const outcome = await this._bindOnce(requestedPort);
      if (outcome === 'listening') return;
      if (outcome !== 'inuse') { this._failBind(`WebSocket server bind error: ${outcome.error.message}`); return; }
      if (attempt < this._bindRetries) {
        this._log.warn(
          `Port ${requestedPort} busy (EADDRINUSE) — retry ${attempt + 1}/${this._bindRetries} in ` +
            `${this._bindRetryDelayMs}ms (a previous bridge may still be releasing the port).`,
        );
        await this._delay(this._bindRetryDelayMs);
      }
    }

    if (this._strictPort) {
      this._bindFailed = true;
      throw new Error(
        `Strict WebViewer bridge port ${requestedPort} is already in use. ` +
          'Stop the owning process or choose another --web-port; port drift is disabled.',
      );
    }

    // Phase 2 — a live concurrent session owns the canonical port: drift upward
    // to the next free port instead of degrading to 0 tools.
    for (let offset = 1; offset <= this._maxPortDrift; offset++) {
      const port = requestedPort + offset;
      const outcome = await this._bindOnce(port);
      if (outcome === 'listening') {
        this._log.warn(
          `Port ${requestedPort} is owned by another live WebViewer bridge (concurrent session). ` +
            `This session bound the next free port ${port} instead — point the browser at ${port} ` +
            `(WebViewer ▸ Settings ▸ AI Bridge) to connect it.`,
        );
        return;
      }
      if (outcome !== 'inuse') { this._failBind(`WebSocket server bind error on port ${port}: ${outcome.error.message}`); return; }
    }

    // Both phases exhausted — degrade.
    this._failBind(
      `No free WebViewer bridge port in ${requestedPort}..${requestedPort + this._maxPortDrift} — ` +
        `web_* tools will report "not connected". Close some sessions or set a distinct --web-port.`,
    );
  }

  /** One bind attempt. Resolves 'listening' (fully wired up), 'inuse', or a hard error. */
  private _bindOnce(port: number): Promise<'listening' | 'inuse' | { error: Error }> {
    return new Promise((resolve) => {
      let settled = false;
      const wss = new WebSocketServer({ host: this._host, port });
      this._wss = wss;

      wss.on('listening', () => {
        settled = true;
        const addr = wss.address() as AddressInfo;
        this._port = addr.port;
        this._bindFailed = false;
        this._log.info(`WebSocket bridge listening on ws://${this._host}:${this._port}/webviewer`);
        resolve('listening');
      });

      wss.on('connection', (ws) => this._onConnection(ws));

      wss.on('error', (err: NodeJS.ErrnoException) => {
        if (!settled) {
          settled = true;
          this._wss = null;
          resolve(err.code === 'EADDRINUSE' ? 'inuse' : { error: err });
        } else {
          this._log.error(`WebSocket server runtime error: ${err.message}`);
        }
      });
    });
  }

  private _failBind(message: string): void {
    this._bindFailed = true;
    this._log.error(message);
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _onConnection(ws: WebSocket): void {
    if (this._paused) {
      this._log.warn('Bridge paused — rejecting new browser connection.');
      try { ws.close(1013, 'Bridge paused'); } catch { /* ignore */ }
      return;
    }

    // Single-tab: kick the previous browser, then adopt the new one. Remove the
    // old socket's listeners first so its close handler does not fire (the new
    // tab re-discovers, so this is a replacement, not a registry-clearing close).
    if (this._browser && this._browser !== ws) {
      const old = this._browser;
      this._log.info('New browser connected — closing previous tab (code 1008).');
      try { old.removeAllListeners(); old.close(1008, 'Another tab connected'); } catch { /* ignore */ }
      this._rejectAllPending('Replaced by another tab');
    }

    this._browser = ws;

    // Seed the new client with the buffered log backlog, then announce.
    const backlog = this._log.buffer;
    if (backlog.length > 0) this._send({ type: 'log', lines: backlog });
    this._log.info('Browser connected.');

    ws.on('message', (data: RawData) => this._onMessage(data));
    ws.on('close', () => {
      // Two-tab race guard: ws.close() is async, so the old socket's close
      // fires AFTER we already adopted the new one. Only clean up if we are
      // still the active socket — otherwise we would null the new browser.
      if (this._browser !== ws) return;
      this._browser = null;
      this._rejectAllPending('Browser disconnected');
      this._log.info('Browser disconnected.');
      this._emitter.emit('disconnect');
    });
    ws.on('error', () => { /* the close handler performs cleanup */ });
  }

  private _onMessage(data: RawData): void {
    let msg: BrowserMessage;
    try {
      msg = JSON.parse(data.toString()) as BrowserMessage;
    } catch {
      this._log.warn('Ignoring malformed (non-JSON) message from browser.');
      return;
    }
    if (!msg || typeof (msg as { type?: unknown }).type !== 'string') {
      this._log.warn('Ignoring message without a string "type".');
      return;
    }
    switch (msg.type) {
      case 'discover':
        this._onDiscover(msg);
        break;
      case 'result':
        this._onResult(msg);
        break;
      case 'control':
        this._emitter.emit('control', msg.action);
        break;
      default:
        this._log.warn(`Unknown message type: ${(msg as { type: string }).type}`);
    }
  }

  private _onDiscover(msg: Extract<BrowserMessage, { type: 'discover' }>): void {
    const tools = Array.isArray(msg.tools) ? msg.tools : [];
    const instructions = typeof msg.instructions === 'string' ? msg.instructions : '';
    this._log.info(`Discover: ${tools.length} tool(s) (schema ${msg.schema_version ?? '?'}).`);
    this._emitter.emit('discover', tools, instructions);
  }

  private _onResult(msg: Extract<BrowserMessage, { type: 'result' }>): void {
    const entry = this._pending.get(msg.id);
    if (!entry) return; // late or duplicate result — ignore
    clearTimeout(entry.timer);
    this._pending.delete(msg.id);
    if (typeof msg.error === 'string') entry.reject(new Error(msg.error));
    else entry.resolve(typeof msg.result === 'string' ? msg.result : '');
  }

  /** Send a tool call to the browser and await its result string. */
  callBrowser(tool: string, args: Record<string, unknown>, timeoutMs?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this._browser || this._browser.readyState !== WebSocket.OPEN) {
        reject(new Error('WebViewer not connected'));
        return;
      }
      const id = ++this._cmdId;
      const limit = timeoutMs ?? this._callTimeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Tool call "${tool}" timed out after ${limit}ms`));
      }, limit);
      this._pending.set(id, { resolve, reject, timer });
      const call: CallMessage = { type: 'call', id, tool, arguments: args };
      try {
        this._browser.send(JSON.stringify(call));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Mirror log lines to the connected browser (used as the Logger sink). */
  sendLog(lines: LogLine[]): void {
    if (lines.length === 0) return;
    this._send({ type: 'log', lines });
  }

  /** Push a live status frame to the connected browser (drives the UI's
   *  full-chain view: browser ⟷ bridge ⟷ AI client). No-op if no browser. */
  sendStatus(status: BridgeStatus): void {
    this._send({ type: 'status', status });
  }

  /** Pause/resume accepting browser connections. Pausing closes the current tab. */
  setPaused(paused: boolean): void {
    this._paused = paused;
    this._log.info(`Bridge ${paused ? 'paused' : 'resumed'}.`);
    if (paused && this._browser) {
      try { this._browser.close(1013, 'Bridge paused'); } catch { /* ignore */ }
    }
  }

  /** Graceful shutdown: reject pending calls, close the browser and the WS server. */
  async close(): Promise<void> {
    this._rejectAllPending('Bridge shutting down');
    if (this._browser) {
      try { this._browser.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
    this._browser = null;
    const wss = this._wss;
    this._wss = null;
    if (!wss) return;
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }

  private _send(msg: ServerMessage): void {
    if (!this._browser || this._browser.readyState !== WebSocket.OPEN) return;
    try { this._browser.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  private _rejectAllPending(reason: string): void {
    // Snapshot then clear, so a late result arriving during the reject reactions
    // cannot touch the map mid-iteration.
    const entries = [...this._pending.values()];
    this._pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }
}
