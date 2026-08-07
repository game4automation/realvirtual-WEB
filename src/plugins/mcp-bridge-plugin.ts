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
import { lastPathSegment } from '../core/engine/rv-constants';
import type { RVLogicStep } from '../core/engine/rv-logic-step';
import {
  McpTool,
  McpParam,
  generateToolSchemasMulti,
  buildMultiDispatcher,
} from '../core/engine/rv-mcp-tools';
import { McpViewTools } from './mcp-bridge/rv-mcp-view-tools';
import { McpObserveTools } from './mcp-bridge/rv-mcp-observe-tools';
import { McpEditorTools } from './mcp-bridge/rv-mcp-editor-tools';
import { McpHelpTool } from './mcp-bridge/rv-mcp-help-tool';
import { getLastLogs, queryLogs } from '../core/engine/rv-debug';
import type { LogLevel } from '../core/engine/rv-debug';
import { Box3, MeshBasicMaterial, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { LayoutPlannerPlugin } from './layout-planner';
import type { RvExtrasEditorPlugin } from '../core/hmi/rv-extras-editor';
import { clearBySource } from '../core/hmi/instruction-store';
import { setAiActivity } from '../core/hmi/ai-activity-store';
import type { SnapPointPlugin } from './snap-point';
import type { SnapPoint } from '../core/engine/rv-snap-point-registry';
import type { LibraryCatalogEntry } from './layout-planner/rv-layout-store';
import { oppositeDirection } from './snap-point/snap-name-parser';
import { findCompatibleLibraryAssets } from './snap-point/library-snap-index';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';
import { getDriveSpeedOverride, setDriveSpeedOverride } from '../core/engine/rv-speed-override';
import { ObjectAnalyzer } from './mcp-bridge/rv-object-analyzer';
import { clampTileSize, parsePathsParam } from './mcp-bridge/rv-object-analyzer-math';
import { captureFrameCanvas, canvasToRvImage } from './mcp-bridge/rv-frame-capture';
import { enforceEnvelopeBudget } from './mcp-bridge/rv-image-budget';
import { matchMaterialFlows } from '../core/material-flow/registry';
import { getViewerMode } from '../core/hmi/connect-store';
import { getPlcControl } from '../core/plc-control';
import { physicsDiagnostics } from '../core/engine/rv-physics-registry';
import { loadInterfaceSettings } from '../interfaces/interface-settings-store';

// Vite raw import — embeds the .md content as a string at build time
import MCP_INSTRUCTIONS from '../../webviewer.mcp.md?raw';

/** Serialize any object's own enumerable properties (primitives + shallow). */
function serializeProps(obj: unknown, maxDepth = 2): Record<string, unknown> {
  if (obj === null || obj === undefined || typeof obj !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('_')) continue;
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined || val === null) { result[key] = val; continue; }
    if (typeof val === 'function') continue;
    if (typeof val === 'number') { result[key] = +val.toFixed(4); continue; }
    if (typeof val === 'boolean' || typeof val === 'string') { result[key] = val; continue; }
    if (Array.isArray(val)) continue;
    if (typeof val === 'object') {
      if (maxDepth > 0) result[key] = serializeProps(val, maxDepth - 1);
      continue;
    }
  }
  return result;
}

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

/** Default bridge port: realvirtual CONNECT (plan-327 AP5). CONNECT is the standard
 *  `web_*` transport — it needs neither Node nor Vite and is the only path that works
 *  for a static WebViewer delivery. A profile that still carries a Node port (18714 /
 *  18715) keeps it: that counts as an explicitly pinned port, so the emergency
 *  fallback survives the default change instead of being silently taken away. */
export const DEFAULT_BRIDGE_PORT = '5100';

/** The Node bridge's historic default port — kept only as the documented fallback
 *  (see `doc-ai-integration.md` → *Falling back to the Node bridge*). */
export const NODE_FALLBACK_PORT = '18714';

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
  private readonly _viewTools = new McpViewTools(() => this.viewer ?? undefined);
  private readonly _observeTools = new McpObserveTools(() => this.viewer ?? undefined);
  private readonly _editorTools = new McpEditorTools(() => this.viewer ?? undefined);
  private readonly _helpTool = new McpHelpTool();

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

  private _sendDiscover(): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    const instances = [this, this._viewTools, this._observeTools, this._editorTools, this._helpTool];
    const schemas = generateToolSchemasMulti(instances);
    this._dispatcher = buildMultiDispatcher(instances);
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

    try {
      const method = (entry.instance as Record<string, Function>)[entry.methodKey];
      if (typeof method !== 'function') {
        this._sendResult(id, undefined, `Method not found: ${entry.methodKey}`);
        return;
      }

      // Build ordered arguments from named params
      const orderedArgs = entry.paramNames.map(name => args[name]);
      await this._prepareEditorChoreography(tool, args ?? {});
      const result = await method.apply(entry.instance, orderedArgs);
      this._sendResult(id, result);
      this._applyEditorFeedback(tool, args, result);
    } catch (e) {
      this._sendResult(id, undefined, String(e));
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

  @McpTool('List all drives: current/target position, speed, running/jog flags, direction, limits. First stop when diagnosing why something does not move.', { readOnly: true })
  async webDriveList(): Promise<string> {
    return JSON.stringify(this.drives.map(d => ({
      name: d.name,
      currentPosition: +d.currentPosition.toFixed(3),
      targetPosition: +d.targetPosition.toFixed(3),
      targetSpeed: +d.targetSpeed.toFixed(3),
      isRunning: d.isRunning,
      jogForward: d.jogForward,
      jogBackward: d.jogBackward,
      direction: d.Direction,
      upperLimit: d.UpperLimit,
      lowerLimit: d.LowerLimit,
      acceleration: d.Acceleration,
    })));
  }

  @McpTool('List all PLC signals with current values. For direction/forced/live-vs-stale diagnosis use web_signal_status instead.', { readOnly: true })
  async webSignalList(): Promise<string> {
    const all = this.signals?.getAll();
    if (!all) return JSON.stringify([]);
    const result: Array<{ name: string; value: boolean | number; type: string }> = [];
    for (const [name, value] of all) {
      result.push({
        name,
        value,
        type: typeof value,
      });
    }
    return JSON.stringify(result);
  }

  @McpTool('List PLC signals with full status: value, type, direction, forced state, live/stale activity, address/comment metadata. Use to diagnose whether signals actually update (live) vs stale/no-source. Filters: name substring, activeOnly, limit.', { readOnly: true })
  async webSignalStatus(
    @McpParam('filter', 'Only signals whose name contains this substring (case-insensitive). Empty = all.', 'string', false) filter?: string,
    @McpParam('activeOnly', 'Only signals currently live or supplied (drop stale / no-source).', 'boolean', false) activeOnly?: boolean,
    @McpParam('limit', 'Maximum number of signals returned (default 200).', 'number', false) limit?: number,
  ): Promise<string> {
    const store = this.signals;
    if (!store) return JSON.stringify({ error: 'No signal store available' });
    const all = store.getAll();
    const now = Date.now();
    const mode = getViewerMode();
    const q = (filter ?? '').toLowerCase();
    const max = limit && limit > 0 ? limit : 200;

    const activityCounts: Record<string, number> = {};
    const signals: Array<Record<string, unknown>> = [];
    let matched = 0;

    for (const [name, value] of all) {
      if (q && !name.toLowerCase().includes(q)) continue;
      const activity = store.getActivity(name, now, mode);
      activityCounts[activity] = (activityCounts[activity] ?? 0) + 1;
      if (activeOnly && (activity === 'stale' || activity === 'no-source')) continue;
      matched++;
      if (signals.length >= max) continue;
      const plcType = store.getType(name) ?? '';
      const forced = store.isForced(name);
      const meta = store.getSignalMeta(name);
      const ts = store.getLastUpdateTs(name);
      signals.push({
        name,
        value,
        plcType,
        direction: plcType.startsWith('PLCOutput') ? 'output'
          : plcType.startsWith('PLCInput') ? 'input' : 'unknown',
        activity,
        ageMs: ts !== undefined ? now - ts : null,
        forced,
        forcedValue: forced ? store.getForcedValue(name) : undefined,
        address: meta?.address,
        comment: meta?.comment,
        source: meta?.source,
      });
    }

    return JSON.stringify({
      mode,
      total: all.size,
      matched,
      returned: signals.length,
      truncated: matched > signals.length,
      activityCounts,
      signals,
    });
  }

  @McpTool('Write a boolean PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list.', { readOnly: false })
  async webSignalSetBool(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Boolean value to set', 'boolean') value: boolean,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signalWriter?.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Write a float PLC signal in the browser SignalStore. Fails when the signal does not exist — find names with web_signal_list.', { readOnly: false })
  async webSignalSetFloat(
    @McpParam('name', 'Signal name') name: string,
    @McpParam('value', 'Float value to set', 'number') value: number,
  ): Promise<string> {
    if (!this.signals) return JSON.stringify({ error: 'No signal store available' });
    const current = this.signals.get(name);
    if (current === undefined) return JSON.stringify({ error: `Signal "${name}" not found` });
    this.signalWriter?.set(name, value);
    return JSON.stringify({ name, value, previous: current });
  }

  @McpTool('Jog a runtime drive forward or backward (sets jog flags; drive names from web_drive_list). Stop with web_drive_stop. For authored drives in the asset editor use web_editor_verify_drive instead.', { readOnly: false })
  async webDriveJog(
    @McpParam('name', 'Drive name') name: string,
    @McpParam('forward', 'true for forward, false for backward', 'boolean', false) forward: boolean,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    const dir = forward !== false;  // default to true if not specified
    drive.jogForward = dir;
    drive.jogBackward = !dir;
    return JSON.stringify({ name, jogForward: dir, jogBackward: !dir });
  }

  @McpTool('Play or pause the simulation. Pass paused=true/false, or omit to toggle. Returns all active pause reasons.', { readOnly: false })
  async webSimPlayPause(
    @McpParam('paused', 'true to pause, false to play; omit to toggle', 'boolean', false) paused: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const userPaused = this.viewer.simulationPauseReasons.includes('user');
    const next = paused === undefined || paused === null ? !userPaused : paused;
    this.viewer.setSimulationPaused('user', next);
    return JSON.stringify({
      paused: this.viewer.isSimulationPaused,
      userPaused: next,
      reasons: [...this.viewer.simulationPauseReasons],
    });
  }

  @McpTool('Show or hide the floor markers (ring + label) under every Source. Persists in localStorage. Useful to locate spawn points in screenshots.', { readOnly: false })
  async webViewSourceMarkers(
    @McpParam('visible', 'true to show, false to hide', 'boolean', true) visible: boolean,
  ): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    this.viewer.setSourceMarkersVisible(visible);
    const sources = this.transportManager?.sources ?? [];
    return JSON.stringify({
      ok: true,
      visible,
      affectedSources: sources.length,
    });
  }

  @McpTool('Reset the simulation: clears MUs, resets LogicStep states and snaps every drive back to its authored StartPosition. Signals are untouched.', { readOnly: false })
  async webSimReset(): Promise<string> {
    if (!this.viewer) return JSON.stringify({ error: 'No viewer' });
    const before = {
      mus: this.transportManager?.mus.length ?? 0,
      totalSpawned: this.transportManager?.totalSpawned ?? 0,
    };
    this.viewer.resetSimulation();
    return JSON.stringify({
      ok: true,
      before,
      after: {
        mus: this.transportManager?.mus.length ?? 0,
        totalSpawned: this.transportManager?.totalSpawned ?? 0,
      },
    });
  }

  @McpTool('Stop a drive: clears jog flags and halts motion. Drive names from web_drive_list.', { readOnly: false })
  async webDriveStop(
    @McpParam('name', 'Drive name') name: string,
  ): Promise<string> {
    const drive = this.drives.find(d => d.name === name);
    if (!drive) return JSON.stringify({ error: `Drive "${name}" not found` });
    drive.jogForward = false;
    drive.jogBackward = false;
    drive.stop();
    return JSON.stringify({ name, stopped: true });
  }

  @McpTool('Master speed factor scaling ALL drives (1 = normal, 0.5 = half, 2 = double, 0 = stopped; relative speeds preserved). Omit factor to read the current value.', { readOnly: false })
  async webDriveSpeedOverride(
    @McpParam('factor', 'Master speed factor (1 = normal). Omit to read the current value.', 'number', false) factor: number,
  ): Promise<string> {
    if (factor === undefined || factor === null) {
      return JSON.stringify({ factor: getDriveSpeedOverride() });
    }
    return JSON.stringify({ factor: setDriveSpeedOverride(factor) });
  }

  @McpTool('List all sensors with occupancy state, mode and their occupied/not-occupied signal names.', { readOnly: true })
  async webSensorList(): Promise<string> {
    return JSON.stringify(this.sensors.map(s => ({
      name: s.node.name,
      occupied: s.occupied,
      mode: s.mode,
      signalOccupied: s.SensorOccupied,
      signalNotOccupied: s.SensorNotOccupied,
    })));
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

  @McpTool('Get material-flow status: spawned/consumed/active MU counts, blocked and physics-owned MUs, per-source and per-sink stats. Use when parts are missing, jammed or not spawning.', { readOnly: true })
  async webTransportStatus(): Promise<string> {
    const tm = this.transportManager;
    if (!tm) return JSON.stringify({ error: 'No transport manager' });
    let physicsOwnedCount = 0;
    for (const mu of tm.mus) if (mu.physicsOwned) physicsOwnedCount++;
    return JSON.stringify({
      totalSpawned: tm.totalSpawned,
      totalConsumed: tm.totalConsumed,
      activeMUs: tm.mus.length,
      // MUs currently jam-blocked by the accumulation gap clamp (plan-255).
      blockedMuCount: tm.blockedMuCount,
      // MUs currently simulated as free rigid bodies (plan-276 physics zones).
      physicsOwnedCount,
      // Dynamic bodies in the physics provider world (0 when physics is off).
      physicsBodies: physicsDiagnostics.bodies,
      mus: tm.mus.map(mu => ({
        name: mu.getName(),
        ...serializeProps(mu, 1),
      })),
      sources: tm.sources.map(src => ({
        name: src.node.name,
        ...serializeProps(src, 1),
      })),
      sinks: tm.sinks.map(sink => ({
        name: sink.node.name,
        ...serializeProps(sink, 1),
      })),
    });
  }

  @McpTool('Get the LogicStep sequence hierarchy with per-step state and progress. Use to see where an automation sequence is stuck.', { readOnly: true })
  async webLogicFlow(): Promise<string> {
    const engine = this.viewer?.logicEngine;
    if (!engine) return JSON.stringify({ error: 'No logic engine' });

    const mapStep = (step: RVLogicStep): object => {
      const props = serializeProps(step, 1);
      const base: Record<string, unknown> = {
        name: step.name,
        type: step.constructor.name,
        state: step.state,
        progress: step.progress,
        ...props,
      };
      if ('children' in step) {
        base.children = (step as { children: RVLogicStep[] }).children.map(mapStep);
      }
      return base;
    };

    return JSON.stringify({
      stats: engine.stats,
      roots: engine.roots.map(mapStep),
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // DES (Discrete Event Simulation) Tools — inspect + drive the event-based
  // material-flow simulation (plan-194). Only live in DES mode (?mode=des or
  // web_mode_set); return a clear hint otherwise.
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('DES status: kernel mode, sub-mode, sim time and processed/pending event counts. The first check for "is the DES simulation running and advancing?" — if pending=0 and nextEventTime is null/Infinity the run has stalled or finished.', { readOnly: true })
  async webDesStatus(): Promise<string> {
    const kernel = this.viewer?.simulationKernel;
    if (!kernel) return JSON.stringify({ error: 'No simulation kernel' });
    const ctl = kernel.desControl?.();
    if (!ctl) {
      return JSON.stringify({ kernelMode: kernel.mode, des: false, hint: 'Not in DES mode — open ?mode=des or call web_mode_set("des").' });
    }
    const stats = ctl.eventStats?.() ?? null;
    return JSON.stringify({
      kernelMode: kernel.mode,
      des: true,
      subMode: ctl.subMode,
      multiplier: ctl.multiplier,
      simTime: ctl.simTime,
      events: stats,
      ffProgress: ctl.ffProgress ?? null,
    });
  }

  @McpTool('DES component states: per material-flow component the load / in-transit / blocked counts and the next/prev wiring. The go-to tool for diagnosing why parts are not flowing (deadlocks, full zones, missing or wrong connections). Pass busyOnly=true to list only components currently holding/transiting/blocking an MU.', { readOnly: true })
  async webDesComponents(
    @McpParam('busyOnly', 'Only list components currently holding/transiting/blocking an MU', 'boolean', false) busyOnly: boolean,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.componentStates) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    let states = ctl.componentStates();
    const total = states.length;
    if (busyOnly) states = states.filter(s => s.load > 0 || s.inTransit > 0 || s.blocked > 0);
    return JSON.stringify({ total, shown: states.length, components: states });
  }

  @McpTool('DES per-component statistics: utilization (Working/Setup/Blocked/Empty/Failure %), output/h, current state and totalProcessed — in MATERIAL-FLOW order (sources first, sinks last) — plus aggregate mean utilization and throughput. Use to analyze line balance and where time is lost.', { readOnly: true })
  async webDesStats(): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    return JSON.stringify(ctl.statistics());
  }

  @McpTool('Identify the DES bottleneck — the constraining component (highest Working%). Upstream of it parts pile up (Blocked); downstream they starve (Empty). Returns the bottleneck, the mean utilization, the throughput and a short diagnosis of how many upstream components are blocked vs downstream starved.', { readOnly: true })
  async webDesBottleneck(): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const st = ctl.statistics();
    if (!st.bottleneck) {
      return JSON.stringify({ bottleneck: null, hint: 'No flow components, or nothing has run yet — play the simulation first.' });
    }
    const idx = st.components.findIndex((c) => c.path === st.bottleneck!.path);
    const blockedUpstream = st.components.slice(0, idx).filter((c) => c.blocked > 30).length;
    const starvedDownstream = st.components.slice(idx + 1).filter((c) => c.empty > 50).length;
    return JSON.stringify({
      bottleneck: st.bottleneck,
      meanUtilization: st.meanUtilization,
      throughputPerHour: st.throughputPerHour,
      diagnosis: `'${st.bottleneck.name}' is the bottleneck — working ${st.bottleneck.working}% of the time. `
        + `${blockedUpstream} upstream component(s) are blocked behind it; ${starvedDownstream} downstream component(s) are starved.`,
    });
  }

  @McpTool('Advance the DES simulation by exactly N events (default 1) and return the new status. Use to step through the event queue when diagnosing flow — each step processes one scheduled event (arrival/generate/transfer).', { readOnly: false })
  async webDesStep(
    @McpParam('count', 'Number of events to step (default 1)', 'integer', false) count: number,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const n = Math.max(1, count || 1);
    let stepped = 0;
    for (let i = 0; i < n; i++) { if (!ctl.step()) break; stepped++; }
    return JSON.stringify({ stepped, events: ctl.eventStats?.() ?? null });
  }

  @McpTool('Set the DES sub-mode: animated (1x real-time), hybrid (Nx), fastforward (max speed), step (manual). Optionally set the hybrid speed multiplier.', { readOnly: false })
  async webDesSetMode(
    @McpParam('subMode', 'animated | hybrid | fastforward | step') subMode: string,
    @McpParam('multiplier', 'Hybrid speed multiplier (>= 1)', 'number', false) multiplier: number,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const valid = ['animated', 'hybrid', 'fastforward', 'step'];
    if (!valid.includes(subMode)) return JSON.stringify({ error: `Invalid subMode '${subMode}'`, valid });
    ctl.setSubMode(subMode as 'animated' | 'hybrid' | 'fastforward' | 'step');
    if (multiplier !== undefined && multiplier !== null && !Number.isNaN(multiplier)) {
      ctl.setMultiplier(multiplier);
    }
    return JSON.stringify({ subMode: ctl.subMode, multiplier: ctl.multiplier });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Virtual PLC tools — talk to the browser-side IEC 61131-3 soft PLC
  // exclusively through the public PlcControl surface (core/plc-control.ts).
  // The runtime ships only in internal dev builds; when it is absent the
  // tools answer with a clear not-available error.
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Virtual PLC status: run state (stopped/running/error), scan time in ms, last error, and the online watch values (VAR_EXTERNAL variables plus function-block outputs like tDelay.Q as of the last scan). Returns an error when the PLC runtime is not part of this build.', { readOnly: true })
  async webPlcStatus(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    return JSON.stringify({
      state: plc.state,
      scanTimeMs: +plc.scanTimeMs.toFixed(3),
      lastError: plc.lastError,
      watch: Object.fromEntries(plc.watch()),
    });
  }

  @McpTool('Deploy an IEC 61131-3 Structured Text program to the virtual PLC: compile + COLD load (fresh function-block states and memory). Returns all diagnostics (compile errors/warnings + signal-binding warnings); with error diagnostics nothing is loaded and the PLC enters the error state. Deploying never starts scanning — call web_plc_run afterwards.', { readOnly: false })
  async webPlcDeploy(
    @McpParam('code', 'IEC 61131-3 Structured Text source (PROGRAM ... END_PROGRAM)') code: string,
  ): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    const diagnostics = await plc.deploy(code);
    return JSON.stringify({
      state: plc.state,
      errorCount: diagnostics.filter(d => d.severity === 'error').length,
      warningCount: diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics,
    });
  }

  @McpTool('Start cyclic PLC scanning (one scan per 60 Hz sim tick: input snapshot → program pass → output batch write). After an error state this performs a COLD restart with a fresh sandbox and fresh function-block states.', { readOnly: false })
  async webPlcRun(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    await plc.run();
    return JSON.stringify({ state: plc.state, lastError: plc.lastError });
  }

  @McpTool('Stop cyclic PLC scanning (WARM stop — program memory and function-block states are kept; outputs keep their last written values).', { readOnly: false })
  async webPlcStop(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    plc.stop();
    return JSON.stringify({ state: plc.state });
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

  // ═══════════════════════════════════════════════════════════════════
  // Generic Component & Node Tools
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Find scene nodes by name AND/OR geometric filters. term = case-insensitive substring of node name or component type (empty term + filters = pure geometric search). Filters: sizeMin/sizeMax (largest AABB dim, m), region ("minX,minY,minZ,maxX,maxY,maxZ" world box the node center must lie in), color (hex like "#c00", tolerance-matched against mesh material color), hasComponent (rv type key, e.g. "Drive"), meshesOnly. Returns full paths + types + size — the paths every other tool takes. When names are meaningless CAD junk, filter by size/region/color instead, or use web_render mode=idmask / web_scene_query.', { readOnly: true })
  async webNodeFind(
    @McpParam('term', 'Name/component-type substring (may be empty when filters are given)', 'string', false) term: string,
    @McpParam('sizeMin', 'Minimum largest-AABB-dimension in meters', 'number', false) sizeMin?: number,
    @McpParam('sizeMax', 'Maximum largest-AABB-dimension in meters', 'number', false) sizeMax?: number,
    @McpParam('region', 'World box "minX,minY,minZ,maxX,maxY,maxZ" the node bounds-center must lie in', 'string', false) region?: string,
    @McpParam('color', 'Material color to match, hex (e.g. "#cc0000")', 'string', false) color?: string,
    @McpParam('hasComponent', 'Only nodes carrying this rv component key (e.g. "Drive", "Kinematic")', 'string', false) hasComponent?: string,
    @McpParam('meshesOnly', 'Only nodes that are meshes themselves (default false)', 'boolean', false) meshesOnly?: boolean,
    @McpParam('limit', 'Max results (default 100)', 'number', false) limit?: number,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No registry available' });
    const hasFilters = sizeMin != null || sizeMax != null || !!region || !!color || !!hasComponent || !!meshesOnly;
    if (!term?.trim() && !hasFilters) return JSON.stringify({ error: 'Give a term and/or at least one filter' });

    if (!hasFilters) {
      const results = reg.search(term);
      return JSON.stringify(results.map(r => ({
        path: r.path,
        name: lastPathSegment(r.path),
        types: r.types,
      })));
    }

    // Geometric search over the shared scene snapshot (O(N), plain data).
    const { buildSceneSnapshot } = await import('./mcp-bridge/rv-scene-snapshot');
    const snapshot = buildSceneSnapshot(v);
    let box: number[] | null = null;
    if (region) {
      box = region.split(',').map((s) => Number(s.trim()));
      if (box.length !== 6 || box.some(Number.isNaN)) {
        return JSON.stringify({ error: 'region must be "minX,minY,minZ,maxX,maxY,maxZ"' });
      }
    }
    let want: { r: number; g: number; b: number } | null = null;
    if (color) {
      try {
        const c = new (await import('three')).Color(color);
        want = { r: c.r, g: c.g, b: c.b };
      } catch {
        return JSON.stringify({ error: `Unparseable color "${color}"` });
      }
    }
    const lower = (term ?? '').trim().toLowerCase();
    const matches = snapshot.filter((n) => {
      if (lower && !n.name.toLowerCase().includes(lower)
        && !n.components.some((t) => t.toLowerCase().includes(lower))) return false;
      if (meshesOnly && !n.isMesh) return false;
      if (hasComponent && !n.components.some((t) => t.toLowerCase() === hasComponent.toLowerCase())) return false;
      const dim = n.bounds ? Math.max(...n.bounds.size) : 0;
      if (sizeMin != null && dim < sizeMin) return false;
      if (sizeMax != null && dim > sizeMax) return false;
      if (box) {
        if (!n.bounds) return false;
        const [cx, cy, cz] = n.bounds.center;
        if (cx < box[0] || cy < box[1] || cz < box[2] || cx > box[3] || cy > box[4] || cz > box[5]) return false;
      }
      if (want) {
        if (!n.material?.color) return false;
        const m = parseInt(n.material.color.slice(1), 16);
        const dr = ((m >> 16) & 255) / 255 - want.r;
        const dg = ((m >> 8) & 255) / 255 - want.g;
        const db = (m & 255) / 255 - want.b;
        if (Math.sqrt(dr * dr + dg * dg + db * db) > 0.25) return false;
      }
      return true;
    });
    const cap = Math.max(1, Math.min(500, Math.round(limit ?? 100)));
    return JSON.stringify({
      total: matches.length,
      ...(matches.length > cap ? { truncated: true } : {}),
      results: matches.slice(0, cap).map((n) => ({
        path: n.path,
        name: n.name,
        types: n.components,
        size: n.bounds?.size ?? null,
        ...(n.material?.color ? { color: n.material.color } : {}),
      })),
    });
  }

  @McpTool('Get the scene-graph tree from a root path (or the whole scene) with component types per node. Use to understand structure before selecting/kinematizing; depth defaults to 3. includeBounds adds per-node world AABB size [x,y,z] (m) + subtree meshCount — one call sizes a whole CAD assembly instead of N web_node_bounds calls.', { readOnly: true })
  async webNodeTree(
    @McpParam('root', 'Root path to start from (empty = entire scene)', 'string', false) root: string,
    @McpParam('depth', 'Max depth to traverse (default 3)', 'integer', false) depth: number,
    @McpParam('includeBounds', 'Add sizeM [x,y,z] + center + meshCount per node (default false)', 'boolean', false) includeBounds?: boolean,
  ): Promise<string> {
    const v = this.viewer;
    const reg = v?.registry;
    if (!v || !reg) return JSON.stringify({ error: 'No registry available' });

    const maxDepth = depth || 3;
    const scene = v.scene;
    if (!scene) return JSON.stringify({ error: 'No scene loaded' });

    let startNode = root ? reg.getNode(root) : scene;
    if (!startNode) return JSON.stringify({ error: `Node not found: "${root}"` });

    // One O(N) snapshot pass joins bounds + mesh counts into the tree.
    let geo: Map<string, { size: [number, number, number]; center: [number, number, number]; meshCount: number }> | null = null;
    if (includeBounds) {
      const { buildSceneSnapshot } = await import('./mcp-bridge/rv-scene-snapshot');
      geo = new Map();
      for (const s of buildSceneSnapshot(v, root || undefined)) {
        if (s.bounds) geo.set(s.path, { size: s.bounds.size, center: s.bounds.center, meshCount: s.meshCount });
        else geo.set(s.path, { size: [0, 0, 0], center: [0, 0, 0], meshCount: 0 });
      }
    }

    const buildTree = (node: import('three').Object3D, d: number): object | null => {
      const path = reg.getPathForNode(node);
      const types = path ? reg.getComponentTypes(path) : [];
      const entry: Record<string, unknown> = {
        name: node.name,
        path: path ?? node.name,
        types,
      };
      if (geo && path) {
        const g = geo.get(path);
        if (g && g.meshCount > 0) {
          entry.sizeM = g.size;
          entry.center = g.center;
          entry.meshCount = g.meshCount;
        }
      }
      if (d < maxDepth && node.children.length > 0) {
        entry.children = node.children
          .map(c => buildTree(c, d + 1))
          .filter(Boolean);
      } else if (node.children.length > 0) {
        entry.childCount = node.children.length;
      }
      return entry;
    };

    return JSON.stringify(buildTree(startNode, 0));
  }

  @McpTool('Get all components on one node with their properties. Node paths from web_node_find / web_node_tree.', { readOnly: true })
  async webComponentGetAll(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const node = reg.getNode(path);
    if (!node) return JSON.stringify({ error: `Node not found: "${path}"` });

    const nodePath = reg.getPathForNode(node) ?? path;
    const entries = reg.getComponentsAt(nodePath);
    if (entries.length === 0) {
      return JSON.stringify({ path: nodePath, components: [] });
    }

    const components = entries.map(([type, instance]) => ({
      type,
      properties: serializeProps(instance, 2),
    }));
    return JSON.stringify({ path: nodePath, components });
  }

  @McpTool('Get one component on a node by path and type (e.g. Drive, Sensor, TransportSurface). Returns its properties.', { readOnly: true })
  async webComponentGet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const instance = reg.getByPath(type, path);
    if (!instance) return JSON.stringify({ error: `Component "${type}" not found at "${path}"` });

    return JSON.stringify({
      path,
      type,
      properties: serializeProps(instance, 2),
    });
  }

  @McpTool('List all components of one type across the scene with paths + properties. Unknown type returns the available types.', { readOnly: true })
  async webComponentList(
    @McpParam('type', 'Component type name (e.g. Drive, Sensor, TransportSurface, Source, Sink, Grip, GripTarget)') type: string,
  ): Promise<string> {
    const reg = this.viewer?.registry;
    if (!reg) return JSON.stringify({ error: 'No registry available' });

    const all = reg.getAll(type);
    if (all.length === 0) {
      // List available types for discoverability
      const stats = reg.size;
      return JSON.stringify({
        error: `No components of type "${type}" found`,
        availableTypes: stats.types,
      });
    }

    return JSON.stringify(all.map(({ path, instance }) => ({
      path,
      name: lastPathSegment(path),
      properties: serializeProps(instance, 1),
    })));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Authoring tools — BUILD layouts (not just inspect/run). They wrap the
  // mode manager, the layout-planner and the extras-editor. Typical flow:
  // web_mode_set('planner') -> web_library_list -> web_layout_place -> web_layout_move /
  // web_component_set -> web_sim_play_pause -> web_scene_save.
  // ═══════════════════════════════════════════════════════════════════

  /** Resolve the layout-planner plugin (helper — not an MCP tool). */
  private _planner(): LayoutPlannerPlugin | undefined {
    return this.viewer?.getPlugin<LayoutPlannerPlugin>('layout-planner');
  }

  /** Resolve a library entry to its behavior definition (for description/docs).
   *  Matches by the entry name + a de-spaced variant + the id, so e.g. "Chain
   *  Transfer Left" resolves to the ChainTransfer behavior (model glob `*ChainTransfer*`). */
  private _behaviorForEntry(entry: LibraryCatalogEntry): ReturnType<typeof matchMaterialFlows>[number] | undefined {
    for (const c of [entry.name, entry.name.replace(/\s+/g, ''), entry.id]) {
      const m = matchMaterialFlows(c);
      if (m.length) return m[0];
    }
    return undefined;
  }

  @McpTool('Switch the workspace mode: hmi (operate/monitor), planner (build layouts — required before web_layout_place), des (event simulation). For the asset editor use web_editor_open instead of setting mode directly.', { readOnly: false })
  async webModeSet(
    @McpParam('mode', 'Target mode: hmi | planner | des') mode: string,
  ): Promise<string> {
    const modes = this.viewer?.modes;
    if (!modes) return JSON.stringify({ error: 'No viewer' });
    if (!modes.has(mode)) {
      return JSON.stringify({ error: `Unknown mode "${mode}"`, available: modes.list().map(m => m.id) });
    }
    modes.setMode(mode);
    return JSON.stringify({ mode: modes.activeMode, available: modes.list().map(m => m.id) });
  }

  @McpTool('List the parts catalog: catalogId, name, category, footprintMm [x,z], short description. Pass catalogId to web_layout_place / web_layout_snap_attach; full build docs via web_library_describe.', { readOnly: true })
  async webLibraryList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const out: Array<{ catalogId: string; name: string; category: string; footprintMm: [number, number] | null; description: string | null }> = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      for (const e of cat.entries) {
        out.push({
          catalogId: e.id, name: e.name, category: e.category,
          footprintMm: e.footprintMm ?? null,
          description: this._behaviorForEntry(e)?.description ?? null,
        });
      }
    }
    return JSON.stringify(out);
  }

  @McpTool('Describe one library component for building: purpose, material-flow direction, snap connections, key config. catalogId from web_library_list.', { readOnly: true })
  async webLibraryDescribe(
    @McpParam('catalogId', 'Library entry id (from web_library_list)') catalogId: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });
    const def = this._behaviorForEntry(entry);
    return JSON.stringify({
      catalogId,
      name: entry.name,
      category: entry.category,
      footprintMm: entry.footprintMm ?? null,
      behaviorType: def?.type ?? null,
      description: def?.description ?? null,
      docs: def?.mcpDocs ?? null,
    });
  }

  @McpTool('Place a library component on the ground plane (planner mode; catalogId from web_library_list). Returns the placement id. y is IGNORED — parts drop to the ground; set height afterwards with web_layout_move (conveyor-height rules: web_help topic "layout").', { readOnly: false })
  async webLayoutPlace(
    @McpParam('catalogId', 'Library entry id (from web_library_list)') catalogId: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters. NOTE: ignored on place — parts drop to the ground plane. Set height afterwards with web_layout_move (e.g. a pallet onto the conveyor transport surface).', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    let entry: import('./layout-planner/rv-layout-store').LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const found = cat.entries.find(e => e.id === catalogId);
      if (found) { entry = found; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });
    const id = await planner.placeComponent(entry, [x, y, z]);
    return JSON.stringify({
      id, catalogId, position: [x, y, z],
      next: 'Chain connected parts with web_layout_snap_attach; heights via web_layout_move',
    });
  }

  @McpTool('Move/rotate a placement (position meters, rotation degrees XYZ). Unlike web_layout_place this DOES set the y height — use it to lift a pallet/MU onto a conveyor transport surface (height rules: web_help topic "layout"). id from web_layout_list.', { readOnly: false })
  async webLayoutMove(
    @McpParam('id', 'Placement id (from web_layout_place / web_layout_list)') id: string,
    @McpParam('x', 'X position in meters', 'number') x: number,
    @McpParam('y', 'Y position in meters', 'number') y: number,
    @McpParam('z', 'Z position in meters', 'number') z: number,
    @McpParam('rx', 'X rotation in degrees (optional)', 'number', false) rx: number,
    @McpParam('ry', 'Y rotation in degrees (optional)', 'number', false) ry: number,
    @McpParam('rz', 'Z rotation in degrees (optional)', 'number', false) rz: number,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const rot: [number, number, number] = [rx ?? 0, ry ?? 0, rz ?? 0];
    planner.applyTransformById(id, [x, y, z], rot, [1, 1, 1]);
    return JSON.stringify({ id, position: [x, y, z], rotation: rot });
  }

  @McpTool('Remove a placed component by id (from web_layout_list).', { readOnly: false })
  async webLayoutRemove(
    @McpParam('id', 'Placement id (from web_layout_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    planner.removePlacementById(id);
    return JSON.stringify({ id, removed: true });
  }

  @McpTool('List placed layout components: id, catalogId, label, position (m), rotation (deg), world bounds (center + size). The id source for web_layout_move / web_layout_remove / web_layout_snap_*.', { readOnly: true })
  async webLayoutList(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const snap = planner.snapshotPlacements();
    const box = new Box3();
    const center = new Vector3();
    const size = new Vector3();
    const round3 = (v: Vector3): [number, number, number] => [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)];
    return JSON.stringify(snap.placements.map(p => {
      let bounds: { center: [number, number, number]; size: [number, number, number] } | null = null;
      const root = planner.getPlacedRootById(p.id);
      if (root) {
        box.setFromObject(root);
        if (!box.isEmpty()) {
          box.getCenter(center);
          box.getSize(size);
          bounds = { center: round3(center), size: round3(size) };
        }
      }
      return {
        id: p.id,
        catalogId: p.catalogId,
        label: p.label,
        position: p.position,
        rotation: p.rotation,
        bounds,
      };
    }));
  }

  @McpTool('Save the current layout as a persisted scene. With name: saves a NEW named scene (returns id); without: saves the active scene in place. Reopen via web_scene_open; raw JSON via web_scene_export.', { readOnly: false })
  async webSceneSave(
    @McpParam('name', 'Scene name (optional — omit to save the active scene in place)', 'string', false) name: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try {
      if (name && name.trim()) {
        const id = await store.saveAs(name.trim());
        return JSON.stringify({ saved: true, id, name: name.trim() });
      }
      await store.save();
      return JSON.stringify({ saved: true });
    } catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('Create a new empty scene (clears the current layout to a fresh draft). The clean reset before building a new layout.', { readOnly: false })
  async webSceneNew(): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try { await store.newEmpty(); return JSON.stringify({ ok: true }); }
    catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('Open a saved scene by id (from web_scene_list).', { readOnly: false })
  async webSceneOpen(
    @McpParam('id', 'Saved scene id (from web_scene_list)') id: string,
  ): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    try { await store.openScene(id); return JSON.stringify({ ok: true, id }); }
    catch (e) { return JSON.stringify({ error: String(e) }); }
  }

  @McpTool('List scenes: saved (id, name — pass id to web_scene_open) plus built-ins.', { readOnly: true })
  async webSceneList(): Promise<string> {
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    return JSON.stringify({
      saved: store.listScenes().map(s => ({ id: s.id, name: s.name, baseKind: s.baseKind })),
      builtins: store.listBuiltins().map(b => ({ url: b.url, label: b.label })),
    });
  }

  @McpTool('Export the current layout as raw JSON (placements + catalogs + grid) without persisting a scene.', { readOnly: true })
  async webSceneExport(): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    return JSON.stringify(planner.snapshotAsLayoutFile('Untitled'));
  }

  @McpTool('Set config properties on an existing component (rv_extras overrides, e.g. drive TargetSpeed, source spawn interval). props = JSON object of fieldName -> value. In the asset editor prefer web_editor_set_field (undoable).', { readOnly: false })
  async webComponentSet(
    @McpParam('path', 'Full hierarchy path of the node') path: string,
    @McpParam('type', 'Component type (e.g. Drive, Source, Sensor, TransportSurface)') type: string,
    @McpParam('props', 'JSON object of fieldName -> value, e.g. {"TargetSpeed": 500}') props: string,
  ): Promise<string> {
    const editor = this.viewer?.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    if (!editor) return JSON.stringify({ error: 'Extras editor not available' });
    let parsed: unknown;
    try { parsed = JSON.parse(props); }
    catch { return JSON.stringify({ error: 'props must be a JSON object string, e.g. {"TargetSpeed": 500}' }); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return JSON.stringify({ error: 'props must be a JSON object' });
    }
    const applied: Record<string, unknown> = {};
    const rejected: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (editor.updateOverlayField(path, type, field, value)) applied[field] = value;
      else rejected[field] = value;
    }
    return JSON.stringify({ path, type, applied, rejected });
  }

  // (web_component_add was removed — superseded by web_editor_add_component,
  // which adds type validation and the editor-mode guard.)

  // ── Snap-attach helpers/tools (connect a matching next component) ──

  /** Resolve a target snap from a free-snap list by name, or auto-pick the only
   *  one (helper — not an MCP tool). Mirrors the UI's free-snap derivation. */
  private _pickSnap(free: readonly SnapPoint[], name?: string):
    { snap: SnapPoint } | { error: string; available: string[] } {
    const available = free.map(s => s.object3D.name);
    if (name) {
      const s = free.find(sp => sp.object3D.name === name);
      return s ? { snap: s } : { error: `Snap "${name}" not free or not found`, available };
    }
    if (free.length === 1) return { snap: free[0] };
    if (free.length === 0) return { error: 'No free snap points on this component', available };
    return { error: 'Ambiguous — pass targetSnapName (multiple free snaps)', available };
  }

  /** Free, live snaps of a placed root (the UI's own "open ports" derivation). */
  private _freeSnaps(root: import('three').Object3D): readonly SnapPoint[] {
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return [];
    return reg.getByOwnerRoot(root).filter(s => !s.occupied && s.object3D.parent);
  }

  @McpTool('List the free (unoccupied) snap points of a placement (id from web_layout_list): snapName, typeId, flow, axis, dirCode per open port. Feed snapName + id into web_layout_snap_attach.', { readOnly: true })
  async webLayoutSnapList(
    @McpParam('id', 'Placement id (from web_layout_place / web_layout_list)') id: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(id);
    if (!root) return JSON.stringify({ error: `No placement "${id}". Use web_layout_list.` });
    const reg = this.viewer?.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    if (!reg) return JSON.stringify({ error: 'Snap-point system not available' });
    const snaps = reg.getByOwnerRoot(root);
    const free = snaps.filter(s => !s.occupied && s.object3D.parent);
    return JSON.stringify({
      id,
      label: root.name,
      freeSnaps: free.map(s => ({
        snapName: s.object3D.name,
        typeId: s.typeId,
        flow: s.flow ?? 'bidi',
        axis: s.dir.axis,
        dirCode: s.dir.code,
      })),
      occupiedCount: snaps.filter(s => s.occupied).length,
    });
  }

  @McpTool('Suggest library components compatible with a free snap (same typeId + compatible flow). Returns [{catalogId, name, ownSnapName}] — pass catalogId into web_layout_snap_attach.', { readOnly: true })
  async webLayoutSnapSuggest(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_layout_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_layout_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;
    const entries: LibraryCatalogEntry[] = [];
    for (const cat of planner.store.getSnapshot().catalogs.values()) entries.push(...cat.entries);
    const compat = await findCompatibleLibraryAssets(entries, target.typeId, oppositeDirection(target.dir), target.flow);
    return JSON.stringify({
      targetId,
      targetSnapName: target.object3D.name,
      typeId: target.typeId,
      flow: target.flow ?? 'bidi',
      suggestions: compat.map(m => ({ catalogId: m.entry.id, name: m.entry.name, ownSnapName: m.ownSnapName })),
    });
  }

  @McpTool('Attach a library component onto a free snap of a placement, auto-aligned — THE way to build connected conveyor lines. targetId from web_layout_list, catalogId from web_library_list / web_layout_snap_suggest; targetSnapName optional (defaults to the only free snap). Returns the new placement id. Planner mode.', { readOnly: false })
  async webLayoutSnapAttach(
    @McpParam('targetId', 'Placement id to attach onto') targetId: string,
    @McpParam('catalogId', 'Library entry id to attach (from web_library_list / web_layout_snap_suggest)') catalogId: string,
    @McpParam('targetSnapName', 'Target snap node name (from web_layout_snap_list); omit to auto-pick the only free snap', 'string', false) targetSnapName: string,
  ): Promise<string> {
    const planner = this._planner();
    if (!planner) return JSON.stringify({ error: 'Layout planner not available — call web_mode_set(\"planner\") first' });
    const root = planner.getPlacedRootById(targetId);
    if (!root) return JSON.stringify({ error: `No placement "${targetId}". Use web_layout_list.` });
    const picked = this._pickSnap(this._freeSnaps(root), targetSnapName);
    if ('error' in picked) return JSON.stringify(picked);
    const target = picked.snap;

    let entry: LibraryCatalogEntry | undefined;
    for (const cat of planner.store.getSnapshot().catalogs.values()) {
      const f = cat.entries.find(e => e.id === catalogId);
      if (f) { entry = f; break; }
    }
    if (!entry) return JSON.stringify({ error: `No library entry "${catalogId}". Use web_library_list.` });

    const matches = await findCompatibleLibraryAssets([entry], target.typeId, oppositeDirection(target.dir), target.flow);
    const chosen = matches.find(m => m.entry.id === catalogId);
    if (!chosen) {
      return JSON.stringify({ error: `"${catalogId}" has no snap compatible with typeId=${target.typeId}, flow=${target.flow ?? 'bidi'}` });
    }

    const newId = await planner.placeAtSnap(entry, target, chosen.ownSnapName);
    if (!newId) return JSON.stringify({ error: 'Placement rejected (snap occupied, non-uniform scale, or own-snap not found)' });
    return JSON.stringify({
      id: newId,
      catalogId,
      attachedTo: { placementId: targetId, snapName: target.object3D.name, typeId: target.typeId },
      ownSnapName: chosen.ownSnapName,
    });
  }
}
