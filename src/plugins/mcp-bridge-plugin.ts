// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * McpBridgePlugin — WebSocket bridge connecting the browser to the local MCP bridge server.
 *
 * On start, connects to the bridge WebSocket and sends a `discover`
 * message containing tool schemas (generated from @McpTool decorators) and the
 * webviewer.mcp.md instructions file. The bridge server registers these as
 * `web_*` MCP tools. When Claude calls a web_* tool, the bridge forwards the
 * call via WebSocket and this plugin dispatches it to the decorated method.
 *
 * The bridge server also streams its own log lines back (type `log`); this plugin
 * buffers them and re-emits `mcp-bridge-log` for the UI. Control messages
 * (type `control`: pause / resume / shutdown) let the UI steer the server.
 *
 * The target is resolved by {@link resolveMcpBridgeTarget}: when the HMI is
 * served BY CONNECT (same-origin, not the Vite dev server, no explicit port),
 * it is derived from window.location (`ws(s)://<host>/webviewer`); otherwise it
 * is `ws://localhost:<port>/webviewer` — realvirtual CONNECT on the default port
 * 5100, or the Node bridge when its port is pinned. Either way the configured
 * auth token travels as `?apikey=` (plan-327 AP5).
 *
 * Auto-reconnects with exponential backoff (1s -> 30s max).
 * DEV-only OR gated behind ?mcp=1 URL param.
 */

import { RVBehavior } from '../core/rv-behavior';
import type { RVViewer } from '../core/rv-viewer';
import {
  McpTool,
  McpParam,
  generateToolSchemasMulti,
  buildMultiDispatcher,
} from '../core/engine/rv-mcp-tools';
import { createMcpDelegates } from './mcp-bridge/rv-mcp-instances';
import { installMcpDialogPolicy, withDialogReport } from './mcp-bridge/rv-mcp-dialog-policy';
import {
  DELTA_PROBES, mergeDelta, parseResult, releaseCall, safeProbe,
} from './mcp-bridge/rv-mcp-delta-probes';
import { getLastLogs, queryLogs } from '../core/engine/rv-debug';
import type { LogLevel } from '../core/engine/rv-debug';
import { MeshBasicMaterial } from 'three';
import type { Object3D } from 'three';
import { clearBySource } from '../core/hmi/instruction-store';
import { setAiActivity } from '../core/hmi/ai-activity-store';
import { ObjectAnalyzer } from './mcp-bridge/rv-object-analyzer';
import { clampTileSize, parsePathsParam } from './mcp-bridge/rv-object-analyzer-math';
import { captureFrameCanvas, canvasToRvImage } from './mcp-bridge/rv-frame-capture';
import { enforceEnvelopeBudget } from './mcp-bridge/rv-image-budget';
import { loadInterfaceSettings } from '../interfaces/interface-settings-store';

// Vite raw import — embeds the .md content as a string at build time
import MCP_INSTRUCTIONS from '../../webviewer.mcp.md?raw';

// ── Types ──

interface CallMessage {
  type: 'call';
  id: number;
  tool: string;
  arguments: Record<string, unknown>;
}

/** Live health of the bridge SERVER process, pushed over the WebSocket. Lets the
 *  UI show the full chain (browser ⟷ bridge ⟷ AI client) instead of only the WS
 *  leg. Null until the bridge sends its first status frame — CONNECT and the Node
 *  bridge both do, the legacy Python bridge never does, so the UI hides these rows
 *  for it. */
export interface BridgeServerStatus {
  pid: number;
  port: number;
  uptimeMs: number;
  clientName: string | null;
  clientVersion: string | null;
  clientConnected: boolean;
  lastRequestAgoMs: number | null;
}

/** Snapshot of the MCP bridge state, emitted on every state transition. */
export interface McpBridgeSnapshot {
  connected: boolean;
  port: string;
  toolCount: number;
  toolNames: string[];
  enabled: boolean;
  reconnectAttempt: number;
  reconnectDelay: number;
  /** Bridge-server health (browser ⟷ bridge ⟷ AI client). Null if none received. */
  serverStatus: BridgeServerStatus | null;
}

/** A log line streamed from the MCP bridge server (shown in the UI). */
export interface McpServerLogLine {
  level: string;
  ts: number;
  msg: string;
}

/** server → browser log frame. */
interface LogMessage {
  type: 'log';
  lines: McpServerLogLine[];
}

/** server → browser status frame (full-chain health). */
interface StatusMessage {
  type: 'status';
  status: BridgeServerStatus;
}

/** Max server log lines retained in the browser ring buffer. */
const MAX_SERVER_LOG = 200;

// ── Persistence ──

const STORAGE_KEY = 'rv-ai-bridge';

/**
 * Both port constants now live in `mcp-bridge/rv-mcp-bridge-ports.ts` and are
 * re-exported here so existing importers keep working. The move is the plan-713
 * NF3 fix: `use-mcp-bridge.ts` imported `DEFAULT_BRIDGE_PORT` as a VALUE from
 * this module, which pulled the entire ~168 kB MCP cluster into the eager entry
 * bundle even though `main.ts` loads the bridge lazily. That importer points at
 * the leaf module now; this re-export is for everyone else.
 */
export { DEFAULT_BRIDGE_PORT, NODE_FALLBACK_PORT } from './mcp-bridge/rv-mcp-bridge-ports';
import { DEFAULT_BRIDGE_PORT } from './mcp-bridge/rv-mcp-bridge-ports';

interface AiBridgeSettings {
  enabled: boolean;
  port: string;
}

function loadSettings(): AiBridgeSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { enabled: false, port: DEFAULT_BRIDGE_PORT };
    const parsed = JSON.parse(raw) as Partial<AiBridgeSettings>;
    return {
      enabled: parsed.enabled === true,
      port: parsed.port || DEFAULT_BRIDGE_PORT,
    };
  } catch { return { enabled: false, port: DEFAULT_BRIDGE_PORT }; }
}

function saveSettings(settings: AiBridgeSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
  catch { /* quota exceeded */ }
}

// ── WebSocket target resolution (plan-286 Phase 4) ──

/** Inputs for {@link resolveMcpBridgeTarget}, kept pure/injectable so the
 *  derivation is unit-testable without a real `window`. */
export interface McpBridgeTargetContext {
  /** `window.location.protocol` (e.g. `'https:'`). */
  protocol: string;
  /** `window.location.host` — host incl. port (e.g. `'plant.example.com:8443'`). */
  host: string;
  /** True when running under the Vite dev server (dev workflow, NOT embedded). */
  isDevServer: boolean;
  /** True when a bridge port was explicitly pinned (via `?mcpPort=` or a
   *  non-default saved/UI port) — forces an explicit `localhost:<port>` target
   *  instead of same-origin derivation. */
  explicitPort: boolean;
  /** Target port for the explicit localhost case: CONNECT (5100, the default) or
   *  the Node bridge (18714 / 18715) when its port is pinned. */
  bridgePort: string;
  /** Auth token appended as `?apikey=` — same source the WS Realtime interface
   *  uses (`loadInterfaceSettings().wsAuthToken`). Empty/undefined = no query. */
  authToken?: string;
  /** Prefer CONNECT's session cookie over a key in the URL where the browser
   *  actually sends it — the embedded (same-origin) case. Set to false after a
   *  cookie-only handshake failed, which puts the query key back. */
  preferCookieAuth?: boolean;
}

/**
 * Resolve the MCP bridge WebSocket URL.
 *
 * Embedded case (HMI served BY CONNECT, same-origin) — no explicit port pinned
 * AND not the Vite dev server: CONNECT hosts the bridge WebSocket on its own
 * origin at `/webviewer`, so derive host + port + scheme from `window.location`
 * (`wss` under https, else `ws`) instead of hard-coding `ws://localhost:<port>`.
 *
 * Explicit / dev case — `ws://localhost:<bridgePort>/webviewer`. That is CONNECT
 * on the default port 5100, or the Node bridge when 18714 / 18715 is pinned.
 * Since plan-363 a dev session is normally served THROUGH CONNECT's proxy, so
 * this branch aims at a gateway on the default port rather than at the page
 * origin; a CONNECT listening elsewhere (worktree sessions) is reached by
 * pinning its port with `?mcpPort=`.
 *
 * The auth token is **transport-independent** (plan-327 AP5): it must be able to
 * travel on BOTH branches, mirroring `websocket-realtime-interface.ts::buildUrl`.
 * It used to be tied to the same-origin branch, which silently made the Vite-dev
 * browser unable to reach a key-protected CONNECT — the handshake was rejected
 * with 401 and CONNECT could therefore not be the dev default. A browser cannot
 * set headers on a WebSocket, so the query parameter is the only channel; the
 * Node bridge does not read it and ignores the extra query harmlessly.
 *
 * Since plan-366 the embedded branch **prefers CONNECT's session cookie** and
 * leaves the key out of the URL. That branch is same-origin by construction (it
 * derives host and scheme from `window.location`), so the `SameSite=Strict`
 * cookie CONNECT issues on the one-time `?apikey=` link travels with the
 * handshake, and a credential does not have to sit in something every proxy
 * logs. It is a preference, not a removal: the explicit/dev branch is
 * cross-origin and keeps the query key, and `preferCookieAuth: false` brings it
 * back on the embedded branch after a cookie-only handshake failed — an expired
 * cookie must not strand a running HMI.
 *
 * Note that this is auth only. The AP2 Origin gate is a separate, server-side
 * check: `localhost:5173 → localhost:5100` passes it because loopback origins are
 * always allowed, but a WebViewer hosted on a *foreign* origin is rejected with
 * 403 unless that origin is listed in CONNECT's `AllowedOrigins`.
 */
export function resolveMcpBridgeTarget(ctx: McpBridgeTargetContext): string {
  const embedded = !ctx.explicitPort && !ctx.isDevServer;
  const base = embedded
    ? `${ctx.protocol === 'https:' ? 'wss' : 'ws'}://${ctx.host}/webviewer`
    : `ws://localhost:${ctx.bridgePort}/webviewer`;
  if (!ctx.authToken) return base;
  if (embedded && ctx.preferCookieAuth !== false) return base;
  return `${base}?apikey=${encodeURIComponent(ctx.authToken)}`;
}

// ── Plugin ──

export class McpBridgePlugin extends RVBehavior {
  readonly id = 'mcp-bridge';
  readonly order = 990;

  // Delegate tool classes — their @McpTool methods are merged with this
  // plugin's own via the multi-instance dispatcher (see rv-mcp-tools.ts).
  // The list itself lives in rv-mcp-instances.ts (plan-713): it used to be
  // written out here AND in three test files, and those four copies drifted.
  private readonly _delegates = createMcpDelegates(() => this.viewer ?? undefined);

  // WebSocket state
  private _ws: WebSocket | null = null;
  // Latch: a cookie-only handshake did not come up, so the query key goes back
  // into the URL for the rest of this session (plan-366 Phase 3).
  private _cookieAuthFailed = false;
  private _dispatcher: Map<string, { instance: object; methodKey: string; paramNames: string[] }> | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectDelay = 1000;
  private _maxReconnectDelay = 30000;
  private _destroyed = false;
  private _currentPort = DEFAULT_BRIDGE_PORT;
  /** True once a bridge port is explicitly pinned (via `?mcpPort=` or the UI /
   *  a non-default saved port). Forces an explicit `localhost:<port>` target even
   *  when same-origin embedding would otherwise be inferred (plan-286 Phase 4).
   *  The CONNECT default port is deliberately NOT "explicit": picking it returns
   *  to the standard resolution, so a remote HMI served by CONNECT keeps deriving
   *  its own origin instead of being pinned to localhost (plan-327 AP5). */
  private _explicitPort = false;
  private _reconnectAttempt = 0;
  private _serverLog: McpServerLogLine[] = [];
  private _serverStatus: BridgeServerStatus | null = null;
  /** Lazily created multi-view mosaic renderer for web_screenshot_analyze. */
  private _objectAnalyzer: ObjectAnalyzer | null = null;
  /** plan-435: the bridge was live when the user switched the plugin off, so
   *  `onActivate` must reconnect. Kept separate from the persisted `enabled`
   *  setting — a plugin toggle is not a change of the user's bridge preference. */
  private _reconnectOnActivate = false;

  // ── Public getters ──

  get mcpConnected(): boolean { return this._ws?.readyState === WebSocket.OPEN; }
  get mcpPort(): string { return this._currentPort; }
  get mcpToolCount(): number { return this._dispatcher?.size ?? 0; }
  get mcpEnabled(): boolean { return !this._destroyed; }
  /** Buffered log lines streamed from the bridge server. */
  get serverLog(): McpServerLogLine[] { return this._serverLog; }
  /** Last full-chain status pushed by the bridge server (null until received). */
  get serverStatus(): BridgeServerStatus | null { return this._serverStatus; }

  // ── State emission ──

  /** Current bridge state snapshot. Used to seed the UI on mount so a restored
   *  (persisted) enabled/port state shows immediately, before the next event. */
  getSnapshot(): McpBridgeSnapshot {
    return {
      connected: this.mcpConnected,
      port: this._currentPort,
      toolCount: this.mcpToolCount,
      toolNames: this.mcpToolNames,
      enabled: this.mcpEnabled,
      reconnectAttempt: this._reconnectAttempt,
      reconnectDelay: this._reconnectDelay,
      serverStatus: this._serverStatus,
    };
  }

  private _emitChanged(): void {
    this.emit('mcp-bridge-changed', this.getSnapshot());
  }

  // ── Public API for UI ──

  /** Reconnect to MCP server, optionally changing port. */
  reconnect(port?: string): void {
    if (port) this._applyPort(port);
    this._disconnect();
    this._reconnectAttempt = 0;
    this._reconnectDelay = 1000;
    this._destroyed = false;
    this._connect();
    this._saveSettings();
  }

  /** Set the target port without connecting (stored; applied on the next enable/reconnect). */
  setPort(port: string): void {
    this._applyPort(port);
    this._saveSettings();
    this._emitChanged();
  }

  /** Store a port and derive whether it pins the target. Selecting the CONNECT
   *  default un-pins it, so the standard (same-origin where applicable) resolution
   *  applies again — the same rule `init()` uses for a restored setting. */
  private _applyPort(port: string): void {
    this._currentPort = port;
    this._explicitPort = port !== DEFAULT_BRIDGE_PORT;
  }

  /** Ask the bridge server to shut down (the process exits — it can only be
   *  restarted by the MCP host / Claude, not from the browser). */
  shutdownServer(): void { this._sendControl('shutdown'); }

  /** Ask the bridge server to stop accepting browser connections. */
  pauseServer(): void { this._sendControl('pause'); }

  /** Resume accepting browser connections. */
  resumeServer(): void { this._sendControl('resume'); }

  private _sendControl(action: 'pause' | 'resume' | 'shutdown'): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._ws.send(JSON.stringify({ type: 'control', action }));
  }

  /** Enable or disable the MCP bridge. */
  setEnabled(enabled: boolean): void {
    if (enabled && this._destroyed) {
      this._destroyed = false;
      this._connect();
    } else if (!enabled && !this._destroyed) {
      this._destroyed = true;
      if (this._reconnectTimer !== null) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this._disconnect();
    }
    this._saveSettings();
    this._emitChanged();
  }

  private _saveSettings(): void {
    saveSettings({ enabled: !this._destroyed, port: this._currentPort });
  }

  // ── Lifecycle ──

  /** Called once at registration (viewer.use), BEFORE any model load — unlike
   *  onStart/onModelLoaded which never fire for an empty (model-less) scene
   *  (e.g. authoring in an empty Layout Planner). The bridge is viewer-lifetime
   *  infrastructure, so it captures the viewer and initialises its connection
   *  here, independent of model loading. This also fixes the enable toggle: a
   *  disabled bridge now correctly starts with `_destroyed = true`, so
   *  `setEnabled(true)` actually calls `_connect()` instead of no-op'ing. */
  init(viewer: RVViewer): void {
    this.viewer = viewer;
    const saved = loadSettings();
    const urlPort = new URLSearchParams(window.location.search).get('mcpPort');
    this._currentPort = urlPort || saved.port;
    // A port is "explicit" (→ pinned `localhost:<port>` target) when set via
    // ?mcpPort= or via a saved port other than the CONNECT default. Otherwise,
    // when CONNECT serves the HMI same-origin, the WS target is derived from
    // window.location. `?mcpPort=18714` (or 18715) is therefore the one-step
    // route back to the Node bridge; `?mcpPort=5100` pins CONNECT explicitly.
    this._explicitPort = urlPort !== null || saved.port !== DEFAULT_BRIDGE_PORT;
    this._destroyed = !saved.enabled;
    if (saved.enabled) {
      this._connect();
    }
    this._emitChanged();
  }

  /** Keep the viewer + connection alive across model load/clear — the bridge is
   *  not a per-model behavior. (Base RVBehavior.onModelCleared would null the
   *  viewer and run onDestroy, tearing down the MCP connection on every model
   *  change.) Final teardown happens in dispose() when the viewer is destroyed. */
  onModelCleared(): void { /* intentionally no-op: bridge spans the viewer lifetime */ }

  /**
   * plan-435: the bridge defines no meaningful `onModelCleared` (above) and
   * never enters the model bookkeeping, so the fallback teardown would do
   * nothing at all and the WebSocket would stay open behind a switched-off
   * plugin. Close it here — but do NOT persist "disabled": the toggle is a
   * diagnostic action, not a change of the user's bridge preference.
   */
  onDeactivate(): void {
    this._reconnectOnActivate = !this._destroyed;
    if (this._destroyed) return;
    this._destroyed = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._disconnect();
    this._emitChanged();
  }

  /** Reopen the connection {@link onDeactivate} closed, if it was open then. */
  onActivate(): void {
    if (!this._reconnectOnActivate || !this._destroyed) return;
    this._reconnectOnActivate = false;
    this._destroyed = false;
    this._connect();
    this._emitChanged();
  }

  protected onDestroy(): void {
    this._destroyed = true;
    // Clear reconnect timer to prevent leak (review fix #4)
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    clearBySource('mcp-bridge');
    this._disconnect();
    this._objectAnalyzer?.dispose();
    this._objectAnalyzer = null;
  }

  // ── WebSocket Connection ──

  /** Resolve the WebSocket target for the current environment (plan-286 Phase 4,
   *  plan-327 AP5). Embedded (CONNECT same-origin) → derived from window.location;
   *  otherwise `localhost:<port>` — CONNECT on 5100 by default, the Node bridge
   *  when its port is pinned. The token comes from the same store the WS Realtime
   *  interface uses (`wsAuthToken`); embedded it stays out of the URL and rides on
   *  CONNECT's session cookie until that is shown not to work (plan-366). */
  private _resolveTarget(): string {
    return resolveMcpBridgeTarget({
      protocol: window.location.protocol,
      host: window.location.host,
      // Vite injects import.meta.env.DEV, which is true for every dev build and is therefore the
      // whole answer. The `window.location.port === '5173'` companion this used to carry was
      // removed with plan-363 Phase 7: since CONNECT proxies the dev server under its own port,
      // the browser never sees 5173 in the one case the check was meant for, so it could only
      // ever have fired on a PRODUCTION build that happened to be served from that port.
      isDevServer: import.meta.env.DEV,
      explicitPort: this._explicitPort,
      bridgePort: this._currentPort,
      authToken: loadInterfaceSettings().wsAuthToken || undefined,
      preferCookieAuth: !this._cookieAuthFailed,
    });
  }

  private _connect(): void {
    if (this._destroyed) return;
    const target = this._resolveTarget();
    // A configured token that is not in the URL means this attempt relies on
    // CONNECT's session cookie — see the fallback in onclose below.
    const usedCookieAuth = !target.includes('apikey=')
      && !!loadInterfaceSettings().wsAuthToken;
    let opened = false;
    try {
      this._ws = new WebSocket(target);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this._ws.onopen = () => {
      console.debug('[McpBridge] Connected to', target);
      opened = true;
      this._reconnectAttempt = 0;
      this._reconnectDelay = 1000;
      this._sendDiscover();
      this._emitChanged();
    };
    this._ws.onmessage = (e) => { this._handleMessage(e.data); };
    this._ws.onerror = () => {};  // suppress console noise; onclose handles reconnect
    this._ws.onclose = (ev) => {
      console.debug(`[McpBridge] Connection closed: code=${ev.code} reason="${ev.reason}"`);
      // Closed without ever opening is the shape a refused handshake has — an
      // expired or absent session cookie among them. Put the query key back for
      // the rest of the session rather than reconnect-looping on a 401.
      if (!opened && usedCookieAuth) this._cookieAuthFailed = true;
      this._emitChanged();
      // Code 1008 = "Another tab connected" — server kicked us because a newer tab took over.
      // Do NOT reconnect: the other tab is the active client now.
      if (ev.code === 1008) {
        console.debug('[McpBridge] Another tab took over, stopping reconnect');
        this._destroyed = true;
        return;
      }
      this._scheduleReconnect();
    };
  }

  private _disconnect(): void {
    if (this._ws) {
      this._ws.onclose = null;  // prevent reconnect on intentional close
      this._ws.onerror = null;
      this._ws.onmessage = null;
      this._ws.close();
      this._ws = null;
    }
    this._dispatcher = null;
    this._serverStatus = null;
  }

  private _scheduleReconnect(): void {
    if (this._destroyed) return;
    this._ws = null;
    this._serverStatus = null; // stale once the link drops
    this._reconnectAttempt++;

    // Exponential backoff with jitter
    const jitter = Math.random() * 1000;
    const delay = Math.min(this._reconnectDelay + jitter, this._maxReconnectDelay);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxReconnectDelay);
    this._emitChanged();
  }

  /**
   * Every decorated instance whose tools are announced — this plugin first, then
   * the delegates. Public so the tests read the SAME list the bridge announces
   * instead of maintaining a parallel guess at it (plan-713 Phase 1).
   */
  get mcpToolInstances(): readonly object[] {
    return [this, ...Object.values(this._delegates)];
  }

  private _sendDiscover(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const instances = this.mcpToolInstances;
    let schemas;
    try {
      schemas = generateToolSchemasMulti(instances);
      this._dispatcher = buildMultiDispatcher(instances);
    } catch (e) {
      // R9 — both builders throw on a duplicate tool name, and this runs inside
      // `ws.onopen`. Unguarded, one collision took down the ENTIRE catalogue,
      // silently, on every reconnect for the rest of the session. A loud log and
      // an aborted discover leave the socket usable and the cause findable;
      // `rv-mcp-delegate-split.test.ts` is what stops it reaching a user at all.
      console.error('[McpBridge] Tool discovery failed — no tools announced:', e);
      this._dispatcher = null;
      this._emitChanged();
      return;
    }
    this._ws.send(JSON.stringify({
      type: 'discover',
      tools: schemas,
      instructions: MCP_INSTRUCTIONS,
      schema_version: '1.0.0',
    }));
    // Reset backoff on successful connection
    this._reconnectDelay = 1000;
    this._emitChanged();
  }

  // ── Message Handling ──

  private async _handleMessage(raw: string): Promise<void> {
    // Review fix: wrap entire body in try/catch to prevent UnhandledPromiseRejection
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'call') {
        await this._handleCall(msg as CallMessage);
      } else if (msg.type === 'log') {
        this._handleLog(msg as LogMessage);
      } else if (msg.type === 'status') {
        this._serverStatus = (msg as StatusMessage).status;
        this._emitChanged();
      }
    } catch (e) {
      console.warn('[McpBridge] Failed to handle message:', e);
    }
  }

  /** Append server log lines to the ring buffer and notify the UI. */
  private _handleLog(msg: LogMessage): void {
    if (!Array.isArray(msg.lines)) return;
    this._serverLog = this._serverLog.concat(msg.lines).slice(-MAX_SERVER_LOG);
    this.emit('mcp-bridge-log', this._serverLog);
  }

  /** Show a brief in-scene indicator that the AI is interacting. Reuses the
   *  standard Instruction overlay (canvas-centered pill, auto-clearing). A fixed
   *  id means rapid calls replace (never stack) and refresh the auto-clear timer. */
  private _showActivity(tool: string): void {
    // Feed the persistent AI-activity overlay (AiActivityOverlay) with a readable
    // label, e.g. "web_snap_attach" -> "Snap attach". The overlay shows the robot
    // icon whenever the bridge is connected and appends this text during a call.
    const label = tool.replace(/^web_/, '').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());
    setAiActivity(label);
  }

  /** Human-like PRE-execution choreography for web_editor_* calls: select the
   *  target nodes, open the owning panel and simulate a real click on the
   *  equivalent button (hover → press → release). AWAITED — the tool executes
   *  at the release, like a real click. Loaded lazily; never throws. */
  private async _prepareEditorChoreography(tool: string, args: Record<string, unknown>): Promise<void> {
    if (!tool.startsWith('web_editor_')) return;
    const v = this.viewer;
    if (!v) return;
    try {
      const m = await import('./mcp-bridge/rv-mcp-editor-feedback');
      await m.prepareEditorChoreography(v, tool, args ?? {});
    } catch { /* choreography must never break the call */ }
  }

  /** Fire-and-forget visual feedback for successful web_editor_* calls:
   *  select result-addressed nodes, keep the owning panel open, frame
   *  offscreen targets. Loaded lazily so the asset-editor stores stay out
   *  of the eager bundle. */
  private _applyEditorFeedback(tool: string, args: Record<string, unknown>, result: unknown): void {
    if (!tool.startsWith('web_editor_') || typeof result !== 'string') return;
    const v = this.viewer;
    if (!v) return;
    void import('./mcp-bridge/rv-mcp-editor-feedback')
      .then((m) => m.applyEditorFeedback(v, tool, args ?? {}, result))
      .catch(() => { /* feedback must never break the call */ });
  }

  private async _handleCall(msg: CallMessage): Promise<void> {
    const { id, tool, arguments: args } = msg;

    if (!this._dispatcher) {
      this._sendResult(id, undefined, 'Dispatcher not ready');
      return;
    }

    const entry = this._dispatcher.get(tool);
    if (!entry) {
      this._sendResult(id, undefined, `Unknown tool: ${tool}`);
      return;
    }

    this._showActivity(tool);

    // The editor's modal dialogs settle on a CLICK. Nobody is going to click
    // during an MCP call, so a raised dialog would block until the bridge
    // timeout and stay on screen poisoning the next call too. The policy
    // answers the safe ones and reports what it answered; see
    // rv-mcp-dialog-policy.ts for the per-dialog reasoning.
    const releaseDialogs = await installMcpDialogPolicy();
    try {
      const method = (entry.instance as Record<string, Function>)[entry.methodKey];
      if (typeof method !== 'function') {
        this._sendResult(id, undefined, `Method not found: ${entry.methodKey}`);
        return;
      }

      // Build ordered arguments from named params
      const orderedArgs = entry.paramNames.map(name => args[name]);
      await this._prepareEditorChoreography(tool, args ?? {});

      // ── Effect verification (plan-707 part c) ──
      // One table lookup, two guarded hooks around the SAME `method.apply` the
      // choreography already brackets. Every probe half runs inside safeProbe,
      // and mergeDelta returns the original string on any doubt, so nothing
      // here can turn a working tool call into a failing one (F9/R1).
      const probe = DELTA_PROBES[tool] ?? null;
      const pctx = probe && this.viewer ? { viewer: this.viewer, tool, callId: id } : null;
      const snap = probe && pctx ? safeProbe(() => probe.before(pctx, args ?? {})) : undefined;

      const result = await method.apply(entry.instance, orderedArgs);
      const reported = withDialogReport(result, releaseDialogs()) as string;

      // parseResult lives INSIDE the closure: a non-JSON result (an image)
      // yields null there and can never damage the call.
      const delta = probe && pctx
        ? safeProbe(() => probe.after(pctx, args ?? {}, snap, parseResult(reported))) ?? null
        : null;
      this._sendResult(id, mergeDelta(reported, delta));
      this._applyEditorFeedback(tool, args, reported);
    } catch (e) {
      const answered = releaseDialogs();
      const note = answered.length > 0
        ? ` (dialogs auto-answered: ${answered.map(a => `${a.kind}=${a.answer}`).join(', ')})`
        : '';
      this._sendResult(id, undefined, String(e) + note);
    } finally {
      // Idempotent: releasing twice just returns an empty log the second time.
      releaseDialogs();
      // The probe's own `after` releases the scope on the happy path, but it
      // never runs when the tool body throws — and a call left in the registry
      // makes every later call on that scope report `ambiguous` forever.
      safeProbe(() => releaseCall(id));
    }
  }

  /**
   * Send one result frame, never larger than the bridge frame budget.
   *
   * The peer enforces its 2 MiB message limit by CLOSING the socket, so an oversized
   * frame does not fail one call — it drops the bridge and every other pending call
   * with it. Image tools already budget their payload (rv-image-budget.ts); this is
   * the backstop for everything else, and for whatever the payload reserve
   * underestimates. Over budget = a defined error under the same call id.
   */
  private _sendResult(id: number, result?: string, error?: string): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const msg: Record<string, unknown> = { type: 'result', id };
    if (error !== undefined) {
      msg.error = error;
    } else {
      msg.result = result;
    }
    this._ws.send(enforceEnvelopeBudget(JSON.stringify(msg), id));
  }

  /** Get tool names registered via @McpTool decorators. */
  get mcpToolNames(): string[] {
    return this._dispatcher ? [...this._dispatcher.keys()] : [];
  }

  // ═══════════════════════════════════════════════════════════════════
  // @McpTool Definitions
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Get viewer status: connection state, FPS, loaded model, drive/signal/sensor/MU counts. Call first to orient in any session.', { readOnly: true })
  async webStatus(): Promise<string> {
    return JSON.stringify({
      connected: true,
      fps: this.viewer?.currentFps ?? 0,
      renderer: (this.viewer?.renderer as { isWebGPURenderer?: boolean } | undefined)?.isWebGPURenderer
        ? 'webgpu' : 'webgl',
      connectionState: this.viewer?.connectionState ?? 'unknown',
      model: this.viewer?.currentModelUrl ?? null,
      loadInfo: this.viewer?.lastLoadInfo ?? null,
      driveCount: this.drives.length,
      sensorCount: this.sensors.length,
      signalCount: this.signals?.size ?? 0,
      muCount: this.transportManager?.mus.length ?? 0,
      logicRoots: this.viewer?.logicEngine?.roots.length ?? 0,
      render: this.renderDiagnostics(),
    });
  }

  /** Render-path diagnostics for web_status: root visibility chain + batch
   *  arena instance visibility. Cheap; explains "loaded but nothing visible". */
  private renderDiagnostics(): Record<string, unknown> | null {
    const viewer = this.viewer;
    if (!viewer) return null;
    const root = viewer.currentModelRoot as
      | { visible: boolean; parent: { visible: boolean; parent: unknown } | null }
      | null;
    let chainVisible = root ? root.visible : false;
    for (
      let p = root?.parent ?? null;
      p && chainVisible;
      p = p.parent as { visible: boolean; parent: unknown } | null
    ) {
      chainVisible = p.visible !== false;
    }
    let arenas = 0, arenaInstances = 0, arenaVisible = 0, arenaMaskedOut = 0, arenaHidden = 0;
    let meshes = 0, meshesMasked = 0, meshesEffVisible = 0;
    const scene = viewer.scene as unknown as {
      traverse(cb: (o: unknown) => void): void;
    } | null;
    scene?.traverse((o) => {
      const n = o as {
        isBatchedMesh?: boolean; isMesh?: boolean; visible: boolean; name: string;
        layers: { mask: number }; instanceCount?: number;
        getVisibleAt?(i: number): boolean;
        parent: { visible: boolean; parent: unknown } | null;
        userData?: Record<string, unknown>;
      };
      if (n.isBatchedMesh) {
        arenas++;
        if (!n.visible) arenaHidden++;
        if (n.layers.mask === 0) arenaMaskedOut++;
        const count = n.instanceCount ?? 0;
        for (let i = 0; i < count; i++) {
          arenaInstances++;
          if (n.getVisibleAt!(i)) arenaVisible++;
        }
        return;
      }
      if (!n.isMesh || n.name.startsWith('__raycastBVH') || n.userData?.['_rvRaycastBVH']) return;
      meshes++;
      if (n.layers.mask === 0) { meshesMasked++; return; }
      let eff = n.visible;
      for (let p = n.parent; p && eff; p = p.parent as { visible: boolean; parent: unknown } | null) {
        eff = p.visible !== false;
      }
      if (eff) meshesEffVisible++;
    });
    const cam = (viewer as unknown as { camera?: { layers?: { mask: number }; position?: { x: number; y: number; z: number } } }).camera;
    const maskHistogram: Record<string, number> = {};
    (viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void } | null)?.traverse((o) => {
      const n = o as { isMesh?: boolean; isBatchedMesh?: boolean; name: string; layers: { mask: number } };
      if (!n.isMesh && !n.isBatchedMesh) return;
      if (n.name.startsWith('__raycastBVH')) return;
      const key = (n.isBatchedMesh ? 'arena:' : 'mesh:') + n.layers.mask;
      maskHistogram[key] = (maskHistogram[key] ?? 0) + 1;
    });
    return {
      rootVisible: root?.visible ?? null,
      rootChainVisible: chainVisible,
      maskHistogram,
      drawTest: (() => {
        try {
          const r = viewer.renderer as unknown as {
            render(s: unknown, c: unknown): void;
            getRenderTarget?(): { width: number; height: number; texture?: { name?: string } } | null;
            info?: { render?: { calls: number; triangles: number }; autoReset?: boolean };
          };
          const rt = r.getRenderTarget?.() ?? null;
          const rr = r as unknown as {
            state?: { reset(): void };
            domElement?: HTMLCanvasElement;
            getContext?(): WebGL2RenderingContext;
          };
          const sample = (): { avg: number; variance: number } | null => {
            try {
              const gl = rr.getContext?.();
              const canvas = rr.domElement;
              if (!gl || !canvas) return null;
              const w = 64, h = 64;
              const px = new Uint8Array(w * h * 4);
              gl.readPixels(
                Math.floor((canvas.width - w) / 2), Math.floor((canvas.height - h) / 2),
                w, h, gl.RGBA, gl.UNSIGNED_BYTE, px,
              );
              let sum = 0, sum2 = 0;
              const n = w * h;
              for (let i = 0; i < n; i++) {
                const lum = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
                sum += lum; sum2 += lum * lum;
              }
              const avg = sum / n;
              return { avg: Math.round(avg), variance: Math.round(sum2 / n - avg * avg) };
            } catch { return null; }
          };
          r.render(viewer.scene, viewer.camera);
          const info = r.info?.render;
          const beforeReset = sample();
          rr.state?.reset();
          r.render(viewer.scene, viewer.camera);
          const afterReset = sample();
          // Bisect: flat red unlit override, no depth test — if even this stays
          // invisible, fragments never reach the default framebuffer at all.
          let overrideRed: { avg: number; variance: number } | null = null;
          try {
            const sc = viewer.scene as unknown as { overrideMaterial: unknown };
            const mat = new MeshBasicMaterial({ color: 0xff0000, depthTest: false, depthWrite: false });
            sc.overrideMaterial = mat;
            r.render(viewer.scene, viewer.camera);
            overrideRed = sample();
            sc.overrideMaterial = null;
            mat.dispose();
          } catch { /* ignore */ }
          return {
            calls: info?.calls ?? null, triangles: info?.triangles ?? null,
            boundRenderTarget: rt ? { w: rt.width, h: rt.height, name: rt.texture?.name ?? '' } : null,
            beforeReset, afterReset, overrideRed,
            canvas: rr.domElement ? { w: rr.domElement.width, h: rr.domElement.height, inDom: rr.domElement.isConnected } : null,
            submitProbe: (() => {
              try {
                const scn = viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void };
                const tracked: { name: string; kind: string; n: { onAfterRender: unknown }; hit: boolean }[] = [];
                scn.traverse((o) => {
                  const n = o as { isMesh?: boolean; isBatchedMesh?: boolean; name: string; layers: { mask: number }; onAfterRender: unknown };
                  if (n.isBatchedMesh && tracked.filter(t => t.kind === 'arena').length < 4) {
                    tracked.push({ name: n.name, kind: 'arena', n, hit: false });
                  } else if (n.isMesh && !n.isBatchedMesh && n.layers.mask === 1 && n.name && tracked.filter(t => t.kind === 'mesh').length < 4) {
                    tracked.push({ name: n.name, kind: 'mesh', n, hit: false });
                  }
                });
                const prev = tracked.map(t => t.n.onAfterRender);
                tracked.forEach(t => { t.n.onAfterRender = () => { t.hit = true; }; });
                (viewer.renderer as unknown as { render(s: unknown, c: unknown): void }).render(viewer.scene, viewer.camera);
                tracked.forEach((t, i) => { t.n.onAfterRender = prev[i]; });
                return tracked.map(t => ({ name: t.name, kind: t.kind, drawn: t.hit }));
              } catch (e) { return { error: String(e) }; }
            })(),
            cullProbe: (() => {
              try {
                const scn = viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void };
                const touched: { n: { frustumCulled: boolean }; prev: boolean }[] = [];
                scn.traverse((o) => {
                  const n = o as { isMesh?: boolean; isBatchedMesh?: boolean; frustumCulled: boolean; perObjectFrustumCulled?: boolean };
                  if (!n.isMesh && !n.isBatchedMesh) return;
                  touched.push({ n, prev: n.frustumCulled });
                  n.frustumCulled = false;
                });
                (viewer.renderer as unknown as { render(s: unknown, c: unknown): void }).render(viewer.scene, viewer.camera);
                const s1 = sample();
                for (const t of touched) t.n.frustumCulled = t.prev;
                return { noCullSample: s1 };
              } catch (e) { return { error: String(e) }; }
            })(),
            ghostProbe: (() => {
              try {
                const scn = viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void };
                const suspects: { name: string; node: { visible: boolean; matrixWorld: { elements: number[] }; parent: { name?: string } | null }; radius: number }[] = [];
                scn.traverse((o) => {
                  const n = o as { isMesh?: boolean; name: string; visible: boolean; geometry?: { boundingSphere?: { radius: number } | null }; matrixWorld: { elements: number[] }; parent: { name?: string } | null };
                  if (!n.isMesh) return;
                  const rad = n.geometry?.boundingSphere?.radius ?? 0;
                  if (rad > 20 && n.visible) suspects.push({ name: n.name || '(unnamed)', node: n, radius: rad });
                });
                const info = suspects.map((s) => {
                  const e = s.node.matrixWorld.elements;
                  const sx = Math.hypot(e[0], e[1], e[2]);
                  return {
                    name: s.name, parent: s.node.parent?.name ?? '', geoRadius: Math.round(s.radius * 10) / 10,
                    worldScale: Math.round(sx * 10000) / 10000,
                    worldRadius: Math.round(s.radius * sx * 100) / 100,
                    worldPos: [e[12], e[13], e[14]].map((v) => Math.round(v * 100) / 100),
                  };
                });
                // Render once with all suspects hidden; sample.
                const prev = suspects.map((s) => s.node.visible);
                for (const s of suspects) s.node.visible = false;
                (viewer.renderer as unknown as { render(s: unknown, c: unknown): void }).render(viewer.scene, viewer.camera);
                const hiddenSample = sample();
                suspects.forEach((s, i) => { s.node.visible = prev[i]; });
                return { suspects: info, hiddenSample };
              } catch (e) { return { error: String(e) }; }
            })(),
            oddMeshes: (() => {
              const odd: unknown[] = [];
              (viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void }).traverse((o) => {
                const n = o as {
                  isMesh?: boolean; name: string; renderOrder?: number; visible?: boolean;
                  layers: { mask: number };
                  material?: { depthTest?: boolean; depthWrite?: boolean; name?: string; type?: string } | unknown[];
                  geometry?: { boundingSphere?: { radius: number } | null };
                };
                if (!n.isMesh || odd.length > 25) return;
                const mat = Array.isArray(n.material) ? undefined : n.material as { depthTest?: boolean; depthWrite?: boolean; name?: string; type?: string } | undefined;
                const big = (n.geometry?.boundingSphere?.radius ?? 0) > 50;
                if ((n.renderOrder ?? 0) !== 0 || mat?.depthTest === false || n.layers.mask === 8 || big) {
                  odd.push({
                    name: n.name, mask: n.layers.mask, order: n.renderOrder, visible: n.visible,
                    depthTest: mat?.depthTest, depthWrite: mat?.depthWrite, matType: mat?.type,
                    radius: Math.round((n.geometry?.boundingSphere?.radius ?? 0) * 10) / 10,
                  });
                }
              });
              return odd;
            })(),
          };
        } catch (e) { return { error: String(e) }; }
      })(),
      fog: (() => {
        const s = viewer.scene as unknown as {
          fog?: { isFog?: boolean; isFogExp2?: boolean; near?: number; far?: number; density?: number; color?: { getHexString(): string } } | null;
          background?: unknown; environment?: unknown; backgroundBlurriness?: number;
          overrideMaterial?: unknown;
        } | null;
        if (!s) return null;
        return {
          fog: s.fog
            ? { type: s.fog.isFogExp2 ? 'exp2' : 'linear', near: s.fog.near, far: s.fog.far, density: s.fog.density, color: s.fog.color?.getHexString() }
            : null,
          hasBackground: !!s.background, hasEnvironment: !!s.environment,
          overrideMaterial: !!s.overrideMaterial,
        };
      })(),
      arenas, arenaInstances, arenaVisible, arenaHidden, arenaMaskedOut,
      meshes, meshesMasked, meshesEffVisible,
      cameraLayersMask: cam?.layers?.mask ?? null,
      camera: (() => {
        const c = viewer.camera as unknown as {
          isPerspectiveCamera?: boolean; isOrthographicCamera?: boolean;
          near?: number; far?: number; fov?: number; zoom?: number;
          projectionMatrix?: { elements: number[] };
          matrixWorld?: { elements: number[] };
        } | null;
        if (!c) return null;
        const finite = (arr?: number[]): boolean => !!arr && arr.every((v) => Number.isFinite(v));
        const cc = c as unknown as {
          matrixAutoUpdate?: boolean; matrixWorldAutoUpdate?: boolean;
          position?: { x: number; y: number; z: number };
          parent?: unknown;
        };
        const mw = c.matrixWorld?.elements;
        return {
          type: c.isPerspectiveCamera ? 'persp' : c.isOrthographicCamera ? 'ortho' : '?',
          near: c.near, far: c.far, fov: c.fov, zoom: c.zoom,
          projFinite: finite(c.projectionMatrix?.elements),
          worldFinite: finite(mw),
          proj: c.projectionMatrix?.elements?.map((v) => Math.round(v * 1000) / 1000),
          worldPos: mw ? [mw[12], mw[13], mw[14]].map((v) => Math.round(v * 100) / 100) : null,
          pos: cc.position ? [cc.position.x, cc.position.y, cc.position.z].map((v) => Math.round(v * 100) / 100) : null,
          matrixAutoUpdate: cc.matrixAutoUpdate, matrixWorldAutoUpdate: cc.matrixWorldAutoUpdate,
          hasParent: !!cc.parent,
        };
      })(),
      cameraPosFinite: cam?.position
        ? Number.isFinite(cam.position.x) && Number.isFinite(cam.position.y) && Number.isFinite(cam.position.z)
        : null,
      clipping: (() => {
        const r = viewer.renderer as unknown as {
          clippingPlanes?: { normal: { x: number; y: number; z: number }; constant: number }[];
          localClippingEnabled?: boolean;
        } | null;
        if (!r) return null;
        return {
          localClippingEnabled: r.localClippingEnabled ?? false,
          planes: (r.clippingPlanes ?? []).map((p) => ({
            n: [p.normal.x, p.normal.y, p.normal.z], c: p.constant,
          })),
        };
      })(),
      sectionClip: (() => {
        try {
          const plugin = (viewer as unknown as { getPlugin?: (id: string) => unknown }).getPlugin?.('clipping') as {
            getState?: () => unknown;
            ['planes']?: { normal: { x: number; y: number; z: number }; constant: number }[];
          } | undefined;
          const planes = (plugin as unknown as { planes?: { normal: { x: number; y: number; z: number }; constant: number }[] })?.planes;
          return {
            state: plugin?.getState?.() ?? null,
            planes: planes?.map((p) => ({ n: [p.normal.x, p.normal.y, p.normal.z], c: p.constant })) ?? null,
          };
        } catch { return null; }
      })(),
      materials: (() => {
        const stats = { total: 0, invisible: 0, opacity0: 0, clipped: 0, nanSphere: 0 };
        const seen = new Set<unknown>();
        (viewer.scene as unknown as { traverse(cb: (o: unknown) => void): void } | null)?.traverse((o) => {
          const m = o as {
            isMesh?: boolean; isBatchedMesh?: boolean; material?: unknown;
            geometry?: { boundingSphere?: { radius: number } | null };
          };
          if (!m.isMesh && !m.isBatchedMesh) return;
          const bs = m.geometry?.boundingSphere;
          if (bs && !Number.isFinite(bs.radius)) stats.nanSphere++;
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          for (const mat of mats) {
            if (!mat || seen.has(mat)) continue;
            seen.add(mat);
            const mm = mat as { visible?: boolean; opacity?: number; transparent?: boolean; clippingPlanes?: unknown[] | null };
            stats.total++;
            if (mm.visible === false) stats.invisible++;
            if (mm.transparent === true && (mm.opacity ?? 1) <= 0.01) stats.opacity0++;
            if (Array.isArray(mm.clippingPlanes) && mm.clippingPlanes.length > 0) stats.clipped++;
          }
        });
        return stats;
      })(),
    };
  }

  /**
   * Render the scene once and return the cropped + downscaled frame as a canvas
   * (shared by `webScreenshot` and `webScreenshotBurst`). Delegates to the
   * shared capture helper in mcp-bridge/rv-frame-capture.ts (also used by the
   * view/editor tool delegates).
   */
  private _captureFrameCanvas(
    path: string, x: number, y: number, w: number, h: number, maxDim = 1400,
  ): { canvas: HTMLCanvasElement; crop: { left: number; top: number; width: number; height: number } } | { error: string } {
    return captureFrameCanvas(this.viewer ?? undefined, { path: path || undefined, x, y, w, h, maxDim });
  }

  @McpTool('Capture a screenshot of the 3D scene as an image. Crop options: `path` frames one node\'s on-screen bounds; x/y/w/h (fractions 0..1) crop a manual rectangle; omit all for the full view. For motion use web_screenshot_burst; for labelled markers web_screenshot_annotated; for multi-view shape analysis web_screenshot_analyze.', { readOnly: true })
  async webScreenshot(
    @McpParam('path', "Node path to frame — crops to this object's on-screen bounding box (e.g. a machine). Omit for the whole view.", 'string', false) path: string,
    @McpParam('x', 'Manual crop: left edge as a fraction 0..1 of canvas width (provide x,y,w,h together; overrides path).', 'number', false) x: number,
    @McpParam('y', 'Manual crop: top edge as a fraction 0..1 of canvas height.', 'number', false) y: number,
    @McpParam('w', 'Manual crop: width as a fraction 0..1 of canvas width.', 'number', false) w: number,
    @McpParam('h', 'Manual crop: height as a fraction 0..1 of canvas height.', 'number', false) h: number,
  ): Promise<string> {
    const r = this._captureFrameCanvas(path, x, y, w, h);
    if ('error' in r) return JSON.stringify({ error: r.error });
    return canvasToRvImage(r.canvas, { crop: r.crop });
  }

  @McpTool('Capture a burst of frames over a time window while the simulation runs, composited into one labelled montage. Use to diagnose MOTION (drive rotation, MU flow) that a single web_screenshot cannot show. count = frames (2..16), durationMs = total span, optional `path` crops each frame to a node.', { readOnly: true, timeoutMs: 60_000 })
  async webScreenshotBurst(
    @McpParam('count', 'Number of frames to capture (2..16).', 'number', false) count: number,
    @McpParam('durationMs', 'Total time window in ms the frames are evenly spread over (e.g. 2000).', 'number', false) durationMs: number,
    @McpParam('path', "Node path to frame each shot (e.g. a machine). Omit for the whole view.", 'string', false) path: string,
  ): Promise<string> {
    const n = Math.max(2, Math.min(16, Math.round(typeof count === 'number' && !Number.isNaN(count) ? count : 6)));
    const span = Math.max(0, typeof durationMs === 'number' && !Number.isNaN(durationMs) ? durationMs : 2000);
    const gap = n > 1 ? span / (n - 1) : 0;
    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    // Capture n frames spaced `gap` ms apart (the sim keeps running between them).
    const frames: HTMLCanvasElement[] = [];
    const NaNv = Number.NaN;
    for (let i = 0; i < n; i++) {
      const r = this._captureFrameCanvas(path, NaNv, NaNv, NaNv, NaNv, 640);
      if ('error' in r) return JSON.stringify({ error: r.error });
      frames.push(r.canvas);
      if (i < n - 1 && gap > 0) await sleep(gap);
    }

    // Composite into a grid montage. Square-ish layout; cells sized to the frame
    // aspect, bounded so the whole montage stays a reasonable payload.
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const aspect = frames[0].height / frames[0].width || 0.5625;
    const cellW = Math.floor(Math.min(640, 1600 / cols));
    const cellH = Math.round(cellW * aspect);
    const mont = document.createElement('canvas');
    mont.width = cols * cellW; mont.height = rows * cellH;
    const ctx = mont.getContext('2d');
    if (!ctx) return JSON.stringify({ error: 'No 2D context' });
    ctx.fillStyle = '#202020'; ctx.fillRect(0, 0, mont.width, mont.height);
    for (let i = 0; i < frames.length; i++) {
      const cx = (i % cols) * cellW, cy = Math.floor(i / cols) * cellH;
      ctx.drawImage(frames[i], cx, cy, cellW, cellH);
      // Per-frame label: index + elapsed ms (top-left, with a readable backing).
      const label = `#${i}  ${Math.round(i * gap)}ms`;
      ctx.font = '600 16px system-ui, sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx + 4, cy + 4, tw + 10, 22);
      ctx.fillStyle = '#fff'; ctx.fillText(label, cx + 9, cy + 20);
    }
    return canvasToRvImage(mont, { frames: n, durationMs: span });
  }

  @McpTool('Analyze objects visually: one labelled 4-view mosaic (scene context far/near with the target highlighted through occluders + two isolated 3/4 views) with bounding-box dimensions in meters. Use to understand SHAPE, ORIENTATION, SIZE and SURROUNDINGS of specific parts; for single shots use web_screenshot. Needs the WebGL renderer.', { readOnly: true })
  async webScreenshotAnalyze(
    @McpParam('paths', 'One or more node paths, comma- or newline-separated.', 'string', true) paths: string,
    @McpParam('includeChildren', 'Include the full subtree (default true). false = only the node and its direct child meshes.', 'boolean', false) includeChildren: boolean,
    @McpParam('tileSize', 'Tile parameter in px (128..512, default 256). Tiles render at 2×tileSize; the mosaic is 4×tileSize wide.', 'number', false) tileSize: number,
  ): Promise<string> {
    const v = this.viewer;
    if (!v?.renderer || !v.scene) return JSON.stringify({ error: 'Renderer not ready' });
    if (v.isWebGPU) {
      return JSON.stringify({ error: 'web_screenshot_analyze requires the classic WebGL renderer — use web_screenshot instead.' });
    }

    const requested = parsePathsParam(paths);
    if (requested.length === 0) return JSON.stringify({ error: 'No node paths given' });
    const resolved: { path: string; node: Object3D }[] = [];
    const unresolved: string[] = [];
    for (const p of requested) {
      const node = v.registry?.getNode(p);
      if (node) resolved.push({ path: p, node });
      else unresolved.push(p);
    }
    if (resolved.length === 0) {
      return JSON.stringify({ error: `Node(s) not found: ${unresolved.join(', ')}` });
    }

    this._objectAnalyzer ??= new ObjectAnalyzer(v);
    const result = this._objectAnalyzer.analyze(resolved.map(r => r.node), {
      includeChildren: includeChildren !== false,
      tileSize: clampTileSize(tileSize),
      pathsLabel: resolved.map(r => r.path).join(', '),
    });
    if ('error' in result) return JSON.stringify({ error: result.error });

    return canvasToRvImage(result.canvas, {
      paths: resolved.map(r => r.path),
      ...(unresolved.length ? { unresolved } : {}),
      boundsM: result.boundsM, center: result.center,
    });
  }

  @McpTool('List active machine errors/alarms with node path and age in seconds.', { readOnly: true })
  async webErrors(): Promise<string> {
    const errors = this.viewer?.errorStore.getActive() ?? [];
    return JSON.stringify({
      errors: errors.map(error => ({
        path: error.path,
        text: error.text,
        sinceSeconds: Math.round((performance.now() - error.since) / 1000),
      })),
      count: errors.length,
    });
  }


  @McpTool('Get recent browser console logs (errors, warnings, debug). Check after any unexpected tool failure or visual glitch.', { readOnly: true })
  async webLogs(
    @McpParam('level', 'Minimum log level: trace|debug|info|warn|error', 'string', false) level: string,
    @McpParam('limit', 'Max number of entries to return', 'integer', false) limit: number,
  ): Promise<string> {
    if (level || limit) {
      return JSON.stringify(queryLogs({
        level: (level as LogLevel) || undefined,
        limit: limit || 100,
      }));
    }
    return JSON.stringify(getLastLogs(100));
  }
}
