// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-store.ts — Zustand-style pub/sub store for the realvirtual CONNECT panel.
 *
 * Manages CONNECT server URL, connection state, configured interfaces,
 * discovery results, and all REST API calls against the CONNECT gateway.
 *
 * Uses module-level state with subscribe/getSnapshot for React useSyncExternalStore.
 */

import { createStore } from './create-store';
import { deriveWireType, type S7Tag, type ParsedTopic } from '../import/s7-tag-table';
import { connectRestFetch } from './connect-rest';
import { clearLicenseStatus, fetchLicenseStatus } from './license-store';
import { fetchConnectNews } from '../news-store';
import { getProjectStore } from '../project/project-store';
import { getOpenDocumentBase } from '../editor/active-asset-store';
import { subscribeActiveDocumentView } from '../editor/active-document-view';
import {
  createGenerationGuard,
  createTrailingEdgeDebounce,
} from '../../plugins/diagnose/debounce';

// ── Types ──────────────────────────────────────────────────────────────

export type ConnectState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ConnectInterfaceSignal {
  protocolAddress: string;
  name: string;
  type: string;
  /** Siemens data type for ProcessImage signals (Bool/Word/Int/...). Optional for legacy signals. */
  dataType?: string;
  /** Free-text comment from the imported tag table (column 4). Shown in the signal browse list. */
  comment?: string;
  record: boolean;
}

/** MQTT topic config — one topic carries either a Single scalar or a ProcessImage byte array. */
export interface ConnectMqttTopic {
  topic: string;
  mode: string; // 'Single' | 'ProcessImage'
  /** MQTT QoS level (CONNECT `MqttTopicConfig.Qos`). Default 1. */
  qos?: number;
  /** MQTT retained flag (CONNECT `MqttTopicConfig.Retained`). Default true. */
  retained?: boolean;
  signals?: ConnectInterfaceSignal[];
}

// ── Interface Types & Nested Protocol Settings (plan-243 parity) ────────
//
// GET /config/interfaces and the ASP.NET Core minimal-API JSON default both
// use camelCase (System.Text.Json's default naming policy for minimal APIs),
// so every field below — including the nested settings blocks' own field
// names — mirrors `ProtocolSettings.cs`/`InterfaceConfig.cs` with the first
// letter of each identifier lowercased (`TwinCat.NetId` → `twinCat.netId`).

/** All interface types the CONNECT gateway can host (mirrors `InterfaceConfig.Type`, case-insensitive on the wire). */
export type ConnectInterfaceType =
  | 'MQTT'
  | 'OpcUa'
  | 'S7'
  | 'TwinCat'
  | 'Modbus'
  | 'ModbusServer'
  | 'EthernetIp'
  | 'CtrlX'
  | 'CtrlXDataLayer'
  | 'Keba'
  | 'Festo'
  | 'Fanuc'
  | 'Denso'
  | 'AbbRobotStudio'
  | 'SHM';

/**
 * Per-type signal-authoring schema from `GET /interface-types` (`SignalSchemaInfo` on the gateway).
 * Drives the generic add/edit-signal dialog: which types can browse, what the address field is
 * called per protocol, example addresses, and the allowed DataType values. The gateway is the
 * single source of truth — an older gateway without the field leaves `signals` undefined and the
 * UI falls back to legacy behavior (no manual add, hardcoded browse list).
 */
export interface ConnectSignalSchema {
  /** Worker implements IDiscoveryCapable — show the Browse button. */
  supportsDiscovery: boolean;
  /** Signals may be created/edited by hand (MQTT: Single-mode only; ProcessImage stays import-only). */
  supportsManualAdd: boolean;
  /** POST /signals/validate fully parses this type's addresses (S7, Modbus, FANUC, Denso, MQTT topic). */
  addressValidatable: boolean;
  /** The address itself implies the direction (S7 area, FANUC prefix) — prefill from effectiveType. */
  directionFromAddress: boolean;
  /** Address field label: "Address" | "Topic" | "NodeId" | "Symbol" | "Tag" | "Signal name". */
  addressLabel: string;
  /** One-line syntax hint shown under the address field. */
  addressHint: string;
  /** Clickable example addresses. */
  addressExamples: string[];
  /** Allowed DataType values; empty = free/optional (protocol is self-typed). */
  dataTypes: string[];
}

/** Response of `POST /signals/validate` (`AddressValidation.Result` on the gateway). */
export interface SignalValidationResult {
  /** A real protocol parser ran. False = only a non-empty check; never block saving on it. */
  checked: boolean;
  valid: boolean;
  error?: string | null;
  /** The rv wire type the worker would register (e.g. "PLCInputBool"); prefill the direction from it. */
  effectiveType?: string | null;
  /** Canonical form of the address (FANUC lower-case, Denso upper-case prefix). */
  normalizedAddress?: string | null;
}

/** Beckhoff TwinCAT ADS update mode (`TwinCatUpdateMode` on the gateway). */
export type TwinCatUpdateMode = 'SumCommand' | 'OnChange' | 'Cyclic';

/** TwinCAT ADS connection settings — mirrors `TwinCatSettings` (ProtocolSettings.cs). */
export interface TwinCatSettings {
  netId: string;
  adsPort: number;
  mode: TwinCatUpdateMode;
  routeHostIp?: string | null;
  maxSubCommands: number;
  writeAllInputsOnStart: boolean;
  readAllOutputsOnStart: boolean;
  useEmbeddedRouter: boolean;
  routerLocalNetId?: string | null;
  regExImportSignals: string[];
  regExSkipSignals: string[];
  regExSymbolIsInput: string[];
}

/** Modbus multi-register (32/64-bit) word order (`ModbusWordOrder`). */
export type ModbusWordOrder = 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';

/** Modbus wire transport (`ModbusTransport`) — only `Tcp` is implemented by the worker. */
export type ModbusTransport = 'Tcp' | 'Rtu';

/** Modbus TCP/RTU connection settings — mirrors `ModbusSettings`. Used by both `Modbus` (client) and `ModbusServer`. */
export interface ModbusSettings {
  host: string;
  port: number;
  unitId: number;
  isServer: boolean;
  wordOrder: ModbusWordOrder;
  transport: ModbusTransport;
}

/** Allen-Bradley/Rockwell PLC family (`EipPlcType`) — the CIP dialect used to talk to the gateway. */
export type EipPlcType =
  | 'ControlLogix'
  | 'Plc5'
  | 'Slc500'
  | 'LogixPccc'
  | 'Micro800'
  | 'MicroLogix'
  | 'Omron';

/** EtherNet/IP (Allen-Bradley / Omron) tag access settings — mirrors `EthernetIpSettings`. */
export interface EthernetIpSettings {
  gateway: string;
  path: string;
  plcType: EipPlcType;
  timeoutMs: number;
}

/** Bosch Rexroth ctrlX tunnel settings — mirrors `CtrlXSettings`. */
export interface CtrlXSettings {
  address: string;
  useSsl: boolean;
  username?: string | null;
  password?: string | null;
  bridgePath: string;
  directPort: number;
  tokenTtlMinutes: number;
}

/** Bosch Rexroth ctrlX native Data Layer settings — mirrors `CtrlXDataLayerSettings`. */
export interface CtrlXDataLayerSettings {
  address: string;
  port: number;
  username: string | null;
  password: string | null;
  allowUntrustedCertificate: boolean;
  useStatelessSubscription: boolean;
  publishIntervalMs: number;
  keepaliveIntervalMs: number;
  errorIntervalMs: number;
  samplingIntervalUs: number;
  queueSize: number;
  queueBehaviour: 'DiscardOldest' | 'DiscardNewest';
  valueChange: 'Status' | 'StatusValue' | 'StatusValueTimestamp';
  browseRootPaths: string[];
  maxSubscriptionNodes: number;
  stableConnectionSec: number;
  tokenTtlMinutes: number;
}

/** Keba Kemro X variable-service settings — mirrors `KebaSettings` (ProtocolSettings.cs). */
export interface KebaSettings {
  host: string;
  httpPort: number;
  wsPort: number;
  username?: string | null;
  password?: string | null;
  importRootPaths: string[];
  cycleTimeMs: number;
  useOnChange: boolean;
  usePatternMatching: boolean;
  inputPatterns: string[];
  outputPatterns: string[];
}

/** Festo AX / PLCnext RSC settings — mirrors `FestoSettings` (ProtocolSettings.cs). */
export interface FestoSettings {
  host: string;
  port: number;
  useTls: boolean;
  username?: string | null;
  password?: string | null;
  useSubscription: boolean;
  subscriptionCycleMs: number;
}

/** FANUC Robot-IF (SNPX) settings — mirrors `FanucSettings`. */
export interface FanucSettings {
  address: string;
  port: number;
  axisCount: number;
}

/** Denso controller generation (`DensoControllerType`). */
export type DensoControllerType = 'RC8' | 'RC9';

/** Denso b-CAP / WinCaps VRC settings — mirrors `DensoSettings`. */
export interface DensoSettings {
  host: string;
  controllerType: DensoControllerType;
  controllerName: string;
  wincapsProject: string;
  connectRealRobot: boolean;
  timeoutMs: number;
  retry: number;
  watchdogMs: number;
  axisCount: number;
}

/** ABB RobotStudio SIMIT shared-memory settings — mirrors `AbbRobotStudioSettings`. */
export interface AbbRobotStudioSettings {
  sharedMemoryName: string;
}

export interface ConnectInterface {
  id: string;
  type: ConnectInterfaceType;
  enabled: boolean;
  /** MQTT per-topic config (ProcessImage signals live here, not in `signals`). */
  topics?: ConnectMqttTopic[];
  /** Nested protocol settings — only the block matching `type` is present (plan-243 §2.3). */
  twinCat?: TwinCatSettings;
  modbus?: ModbusSettings;
  ethernetIp?: EthernetIpSettings;
  ctrlX?: CtrlXSettings;
  ctrlXDataLayer?: CtrlXDataLayerSettings;
  keba?: KebaSettings;
  festo?: FestoSettings;
  fanuc?: FanucSettings;
  denso?: DensoSettings;
  abbRobotStudio?: AbbRobotStudioSettings;
  /** Protocol-specific connection settings (endpoint, ipAddress, brokerUrl, updateCycleMs, allowWebToPlc, etc.) */
  [key: string]: unknown;
  signals: ConnectInterfaceSignal[];
}

export interface DiscoveredSignal {
  protocolAddress: string;
  displayName: string;
  dataType: string;
  direction: 'input' | 'output' | 'unknown';
  browsePath: string;
  currentValue?: unknown;
  /** UI selection state (not from server). */
  selected?: boolean;
}

/**
 * A per-signal configuration/decode problem reported by the gateway worker (LOP #51/#52 hardening):
 * the signal is registered and looks alive in the panel, but the gateway KNOWS it can never decode
 * a value for it (bad address, tag outside the received payload).
 */
export interface ConnectSignalIssue {
  signal: string;
  /** Stable machine-readable kind: "AddressParseError" | "OutOfBounds". */
  kind: string;
  message: string;
  /** Owning topic for topic-based interfaces (MQTT ProcessImage), otherwise null/undefined. */
  topic?: string | null;
}

/** Live per-interface worker connection status from CONNECT's /status endpoint. */
export interface ConnectInterfaceStatus {
  /** "Connected" | "Connecting" | "Reconnecting" | "Error" | "Stopped" | "Disabled" */
  status: string;
  error?: string;
  /** Per-signal problems — undefined/empty when the worker reports none (incl. older gateways). */
  signalIssues?: ConnectSignalIssue[];
}

/** Index lifecycle reported by CONNECT's /diagnose/status (plan-284). */
export type RagIndexState =
  | 'uninitialized' | 'loading' | 'indexing' | 'ready' | 'empty' | 'faulted';
/** Reranker lifecycle reported by CONNECT (lowercase of the server's RerankStatus enum). */
export type RagRerankState = 'disabled' | 'loading' | 'ready' | 'missing' | 'faulted';

export interface RagChatProvider {
  name: string;
  status: string;
  detail?: string;
}

/**
 * AI-diagnosis (RAG/LLM) status from CONNECT's authenticated `GET /diagnose/status` (plan-284),
 * shown in the WEB settings tab next to the MCP bridge. Discriminated on `supported`:
 * `{ supported: false }` = an old gateway without the endpoint (404 or SPA-fallback 200 text/html),
 * which must read distinctly from a gateway that has the feature turned off (`enabled: false`).
 * `undefined` on the snapshot means "connected, first poll still pending".
 */
export type RagStatus =
  | { supported: false }
  | {
      supported: true;
      enabled: boolean;
      indexState: RagIndexState;
      rerankState: RagRerankState;
      providers?: { embedding: string; rerank: string; chat: string };
      chatProviders?: RagChatProvider[];
      chatTimeoutSeconds?: number;
      model?: string;
      embeddingModel?: string;
      docs?: number;
      chunks?: number;
      dim?: number;
      apiKeyConfigured?: boolean;
      lastSuccessfulSyncUtc?: string | null;
      lastSyncError?: string | null;
    };

export interface ConnectSnapshot {
  serverUrl: string;
  state: ConnectState;
  errorMessage: string;
  /** Server version string (from /health `version`, else legacy `appVersion`). */
  serverVersion: string;
  /** Server build number (from /health `build`). Empty for older gateways. */
  serverBuild: string;
  /** Server build date (from /health buildDate). */
  serverBuildDate: string;
  /**
   * True while `state === 'connected'` but the last {@link STATUS_FAIL_THRESHOLD}
   * consecutive /status polls failed at the network level — the gateway process is
   * gone or the machine is unreachable. The UI must show this distinctly instead of
   * keeping the green "Connected"; it auto-clears on the next successful poll.
   */
  gatewayUnreachable: boolean;
  /** Epoch ms of the last successful gateway response (health or /status poll). 0 = never. */
  lastStatusUpdate: number;
  interfaces: ConnectInterface[];
  /** Live worker status keyed by interface id (from /status). */
  interfaceStatus: Record<string, ConnectInterfaceStatus>;
  /**
   * Name of the gateway's active configuration profile (from /status). Kept in the poll because
   * profiles can switch server-side (model binding). Null = unnamed live set or older gateway
   * without the field — the UI hides the profile line then.
   */
  activeProfile: string | null;
  /** GLB model binding of the active profile, null when unbound or unknown. */
  activeProfileModel: string | null;
  /**
   * Interface types the CONNECTED gateway itself advertises (`GET /interface-types`), so the
   * Add-Interface list always matches what the running EXE can actually create — a newer WebUI
   * never offers a type an older gateway lacks, and a new gateway type shows up without a WebUI
   * release. `null` = not fetched / older gateway without the endpoint → callers fall back to the
   * static `CONNECT_INTERFACE_TYPES` registry.
   */
  availableTypes: ConnectInterfaceTypeDef[] | null;
  activeInterfaceId: string | null;
  discoveredSignals: DiscoveredSignal[];
  discoveryLoading: boolean;
  /**
   * May the connected gateway update itself right now (`updateSupported` from `/health`)? Read
   * here — and not from `connect-update-store` — so the ConnectPanel's update hint costs no extra
   * request: plan-343 T26 pins that panel to zero `/update/` calls, open or closed.
   */
  updateSupported: boolean;
  /**
   * Why it may not, as a token from the gateway's closed `UpdateReasons` set (plan-363 Phase 8);
   * `null` when it can, or when the gateway is old enough not to send the field at all.
   */
  updateReason: string | null;
  /**
   * Can the connected gateway open a project path in the host's file manager
   * (`revealSupported` from `/health`, plan-446 F1)?
   *
   * False for every gateway that omits the flag — an older CONNECT, one running headless on Linux,
   * or one serving no project at all. It is a CAPABILITY, not a permission: whether the verb may be
   * shown also depends on the page origin ({@link canRevealInExplorer}), because a remotely opened
   * viewer would otherwise open a window on somebody else's desk.
   */
  revealSupported: boolean;
  /**
   * AI-diagnosis (RAG/LLM) status from `GET /diagnose/status` (plan-284). `undefined` until the
   * first poll completes; `{ supported: false }` for gateways without the endpoint.
   */
  rag?: RagStatus;
}

// ── Constants ──────────────────────────────────────────────────────────

const LS_KEY_URL = 'rv-connect-url';

/**
 * Set when the user disconnected explicitly in the CONNECT panel. Without it the page-load
 * auto-probe (ConnectPlugin.init) reconnects on the next reload, which reads as "Disconnect does
 * nothing". Cleared on every explicit connect attempt.
 */
const LS_KEY_AUTOCONNECT_OPTOUT = 'rv-connect-autoconnect-optout';

/**
 * Set once the user pressed Connect in the CONNECT panel AND the connection succeeded. The
 * page-load auto-probe requires it before touching a LOCAL gateway target from a hosted (public)
 * origin: Chrome's Local Network Access prompt must appear at most once, at the moment the user
 * explicitly asked for the connection — never unprompted on a page load. A fresh browser
 * therefore never sees the prompt automatically, whatever `canSilentlyProbeGateway` concludes.
 */
const LS_KEY_USER_CONNECTED = 'rv-connect-user-connected';

/**
 * Gateway URL for a browser whose page origin says nothing useful — a hosted deploy, or an origin
 * without an http(s) scheme. 5100 is CONNECT's own default port.
 */
export const FALLBACK_GATEWAY_URL = 'http://localhost:5100';

/** The part of `window.location` {@link deriveDefaultGatewayUrl} reads — injectable for tests. */
export interface GatewayOriginLocation {
  protocol: string;
  hostname: string;
  origin: string;
}

/**
 * Name of the cookie CONNECT sets on every document it serves itself (plan-426).
 *
 * It carries no secret — the value is the constant `1` — and it is deliberately not httpOnly,
 * because this code is its only consumer. Frozen together with the C# side
 * (`RemoteHmiLink.OriginMarkerCookieName`): an older CONNECT simply never sets it, and an older
 * viewer simply never looks, so both mixed combinations behave exactly like before this existed.
 */
export const ORIGIN_MARKER_COOKIE = 'rv_connect_origin';

/** `document.cookie`, or an empty string wherever there is no document to ask. */
function readDocumentCookie(): string {
  try {
    return typeof document === 'undefined' ? '' : document.cookie;
  } catch {
    return '';
  }
}

/**
 * True when this page was served BY a CONNECT gateway — which makes the page origin the gateway.
 *
 * Only CONNECT itself can set this marker, which is the whole point: "the page origin is the
 * gateway" and "the page is hosted somewhere else and the gateway is elsewhere" are otherwise
 * indistinguishable from inside the browser, and guessing wrong breaks one of the two groups.
 *
 * @param cookie Cookie string to read instead of `document.cookie` — for tests.
 */
export function isServedByConnectOrigin(cookie?: string): boolean {
  const source = cookie ?? readDocumentCookie();
  return source
    .split(';')
    .some((entry) => entry.trim() === `${ORIGIN_MARKER_COOKIE}=1`);
}

/**
 * Default gateway URL for a browser that has never been told one.
 *
 * Since plan-363 CONNECT is the only local web server: it either serves the HMI itself (embedded)
 * or proxies the Vite dev server under its OWN port, so a loopback page origin *is* the gateway —
 * and it is the only thing that knows which port that is. The former hard-coded `localhost:5100`
 * was wrong for every instance running elsewhere (worktree sessions put CONNECT on 15363 / 15365),
 * which are exactly the installations where nobody should have to type a URL first.
 *
 * A non-loopback origin keeps the localhost fallback: a hosted WEB (user group 4) talks to a
 * CONNECT on the operator's own machine, never to itself.
 *
 * One consequence worth knowing: in the documented Node-bridge emergency fallback, where Vite is
 * started bare on 5173 instead of through CONNECT, this derives `localhost:5173` — which answers
 * with the viewer, not with a gateway. {@link connectToServer} recovers from that on its own: an
 * HTML answer on `/health` is recognised as "no gateway here", CONNECT's default port is asked
 * once, and a healthy answer there is adopted and persisted. Only a URL the user typed is left
 * untouched — see {@link shouldAdoptFallbackGateway}.
 *
 * @param servedByConnect Whether CONNECT served this very page (plan-426). When it did, the page
 *   origin IS the gateway whatever the hostname says — that is the second device on the LAN, which
 *   reaches the gateway at `http://192.168.x.y:5100` and would otherwise look for it on its own
 *   localhost. The parameter stays an argument rather than a DOM read so this function remains
 *   pure; {@link defaultGatewayUrl} is the one place that consults the browser.
 */
export function deriveDefaultGatewayUrl(
  loc: GatewayOriginLocation, servedByConnect: boolean,
): string {
  if (!/^https?:$/.test(loc.protocol)) return FALLBACK_GATEWAY_URL;
  if (servedByConnect) return loc.origin;
  return isLoopbackHostname(loc.hostname) ? loc.origin : FALLBACK_GATEWAY_URL;
}

/** The gateway URL for this browser, marker cookie included. Never throws. */
export function defaultGatewayUrl(): string {
  try {
    return deriveDefaultGatewayUrl(window.location, isServedByConnectOrigin());
  } catch {
    return FALLBACK_GATEWAY_URL;
  }
}

// ── Module-level Store ─────────────────────────────────────────────────

type Listener = () => void;

/**
 * The gateway URL the store boots with: a remembered one wins, otherwise the derived default.
 *
 * Split out from {@link _readInitialUrl} so the bootstrap seam itself is testable (plan-426): the
 * marker cookie only helps if it is consulted at THIS moment — module load — which is why the
 * asynchronously delivered app config could not carry it.
 */
export function resolveInitialGatewayUrl(
  stored: string | null, loc: GatewayOriginLocation, servedByConnect: boolean,
): string {
  return stored || deriveDefaultGatewayUrl(loc, servedByConnect);
}

function _readInitialUrl(): string {
  try {
    return resolveInitialGatewayUrl(
      localStorage.getItem(LS_KEY_URL), window.location, isServedByConnectOrigin());
  } catch {
    return defaultGatewayUrl();
  }
}

const _store = createStore<ConnectSnapshot>({
  serverUrl: _readInitialUrl(),
  state: 'disconnected',
  errorMessage: '',
  serverVersion: '',
  serverBuild: '',
  serverBuildDate: '',
  gatewayUnreachable: false,
  lastStatusUpdate: 0,
  interfaces: [],
  interfaceStatus: {},
  activeProfile: null,
  activeProfileModel: null,
  availableTypes: null,
  activeInterfaceId: null,
  discoveredSignals: [],
  discoveryLoading: false,
  updateSupported: false,
  updateReason: null,
  revealSupported: false,
});

// ── React Integration (useSyncExternalStore) ───────────────────────────

export function subscribeConnectStore(listener: Listener): () => void {
  return _store.subscribe(listener);
}

export function getConnectSnapshot(): ConnectSnapshot {
  return _store.getSnapshot();
}

// ── Viewer mode + source→connected heuristic (plan-234 §10-B) ──────────

/**
 * Viewer operating mode as consumed by {@link SignalStore.getActivity}.
 * Derived here (there is no global `mode` getter in the code): the CONNECT
 * gateway is a Direct REST/MQTT path to the PLC (no Unity in the loop), so a
 * connected gateway means `'direct'`; nothing connected means `'standalone'`.
 * (`'live'` — a WebSocket-Realtime link to a running Unity — is reported by the
 * interface layer via {@link deriveViewerMode} when an interface manager is
 * involved; this pure helper only knows the CONNECT snapshot.)
 */
export function deriveViewerModeFromConnect(snap: ConnectSnapshot): 'standalone' | 'direct' {
  return snap.state === 'connected' && !snap.gatewayUnreachable ? 'direct' : 'standalone';
}

/** Live convenience wrapper around {@link deriveViewerModeFromConnect}. */
export function getViewerMode(): 'standalone' | 'live' | 'direct' {
  return deriveViewerModeFromConnect(_store.getSnapshot());
}

/**
 * Map a `SignalMeta.source` label (as written by `mirrorConnectSignalMeta`,
 * e.g. `"MQTT"`, `"S7 · DB1"`, `"MQTT · Data_I_1"`) to whether its supplying
 * interface is currently connected.
 *
 * Pure so it can be unit-tested against a snapshot (plan-234 §9 / §10-B).
 *
 * Heuristic (documented, robust against source→interface ambiguity):
 *   1. If the gateway is not `connected` at all → not connected.
 *   2. Otherwise look for an enabled interface whose `type` (`MQTT`/`S7`/`OpcUa`)
 *      appears in the source string. This is the "type-in-source" heuristic from
 *      the plan — the source label always starts with `iface.type`.
 *   3. If a per-interface worker status is known, require it to be `"Connected"`.
 *      When no `/status` map is available (older gateways) fall back to the
 *      enabled flag + gateway-level connected state (conservative: prefer
 *      "supplied" over a false "no-source", plan-234 §5.4 R11).
 *   4. No matching interface but the gateway is connected → conservatively
 *      treat the source as connected (a legacy/unknown label from a connected
 *      gateway is more likely supplied than dead).
 */
export function isSourceConnected(snap: ConnectSnapshot, source: string): boolean {
  if (snap.state !== 'connected') return false;
  // A dead gateway supplies nothing — never report its sources as connected.
  if (snap.gatewayUnreachable) return false;
  if (!source) return false;

  const matching = snap.interfaces.filter(
    (iface) => iface.enabled !== false && source.includes(iface.type),
  );
  if (matching.length === 0) {
    // Connected gateway, unrecognized source label → assume supplied (conservative).
    return true;
  }
  // Connected if ANY matching interface reports a live "Connected" worker status,
  // or (no /status map) is simply enabled on a connected gateway.
  return matching.some((iface) => {
    const st = snap.interfaceStatus[iface.id]?.status;
    if (st === undefined) return true;             // no per-interface status → gateway-level connected
    return st === 'Connected';
  });
}

/** Live convenience wrapper around {@link isSourceConnected}. */
export function isSourceConnectedLive(source: string): boolean {
  return isSourceConnected(_store.getSnapshot(), source);
}

// ── URL Management ─────────────────────────────────────────────────────

/**
 * True when this browser holds an explicitly configured gateway URL
 * (the user connected via the ConnectPanel at least once).
 */
export function hasStoredServerUrl(): boolean {
  try {
    return !!localStorage.getItem(LS_KEY_URL);
  } catch {
    return false;
  }
}

/**
 * True when the user disconnected explicitly and has not connected again since. The page-load
 * auto-probe honours this, so a Disconnect survives a reload.
 */
export function hasAutoConnectOptOut(): boolean {
  try {
    return localStorage.getItem(LS_KEY_AUTOCONNECT_OPTOUT) === '1';
  } catch {
    return false;
  }
}

function _setAutoConnectOptOut(optOut: boolean): void {
  try {
    if (optOut) localStorage.setItem(LS_KEY_AUTOCONNECT_OPTOUT, '1');
    else localStorage.removeItem(LS_KEY_AUTOCONNECT_OPTOUT);
  } catch { /* ignore */ }
}

/**
 * True once the user connected explicitly (Connect button / Enter in the URL field) with
 * success at least once in this browser. See {@link LS_KEY_USER_CONNECTED} for why the
 * auto-probe insists on this before contacting a local gateway from a hosted origin.
 */
export function hasUserConnectedBefore(): boolean {
  try {
    return localStorage.getItem(LS_KEY_USER_CONNECTED) === '1';
  } catch {
    return false;
  }
}

function _recordUserConnected(): void {
  try {
    localStorage.setItem(LS_KEY_USER_CONNECTED, '1');
  } catch { /* ignore */ }
}

/** Loopback host names, in the spellings a URL or `window.location` can carry. */
function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1'
    || hostname === '::1' || hostname === '[::1]';
}

/**
 * True when the page itself is served from a loopback origin — since plan-363 that means CONNECT
 * served it, either from its embedded build or through its dev-server proxy. Only such origins may
 * silently probe a local gateway; a hosted deploy (web.realvirtual.io) probing localhost would
 * trigger Chrome's Local Network Access permission prompt on every customer visit.
 */
export function isLoopbackOrigin(): boolean {
  return isLoopbackHostname(window.location.hostname);
}

/**
 * True when the given gateway URL targets localhost or a private/link-local
 * address — exactly the targets Chrome's Local Network Access permission
 * ("Auf andere Apps und Dienste auf diesem Gerät zugreifen") applies to.
 *
 * ⚠️ This is **not** a leftover of the two-server era that plan-363 ended. It serves user group 4
 * — a WEB hosted on a public origin driving a CONNECT on the operator's own machine — which is the
 * one supported arrangement where page origin and gateway are genuinely different hosts. Deleting
 * it would put the browser's permission prompt back on every page load for those installations.
 */
export function isLocalGatewayTarget(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
    return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  } catch {
    return false;
  }
}

// ── "Show in Explorer" (plan-446 F1/F3) ────────────────────────────────

/** The part of `window.location` {@link canRevealInExplorer} reads — injectable for tests. */
export interface RevealPageLocation {
  hostname: string;
  origin: string;
}

/**
 * May the "Show in Explorer" verb be offered right now?
 *
 * ## Two independent conditions, and the second is not about permission
 *
 * The gateway's `revealSupported` says the ACTION exists (a file manager, a project root). It says
 * nothing about *whose screen* the window would appear on — and that is the failure this rule
 * exists for: CONNECT refuses every non-loopback PEER, but a viewer opened over Tailscale on a
 * tablet still reaches its CONNECT through a locally-forwarded port and would get a 204 for a
 * window that opens on the machine in the plant. So the page itself must be local too:
 *
 * - `location.hostname` is `localhost` / `127.0.0.1` — the page runs on the gateway's machine, or
 * - the gateway origin IS the page origin — CONNECT served this very page, which is the plan-363
 *   embedded/dev-proxy arrangement and the same machine by construction.
 *
 * Deliberately NOT {@link isLocalGatewayTarget}: that predicate answers "does Chrome's Local
 * Network Access prompt apply", and it says yes for a whole `192.168.x` LAN — every one of which
 * is a different desk.
 */
export function canRevealInExplorer(
  revealSupported: boolean,
  gatewayUrl: string,
  loc: RevealPageLocation,
): boolean {
  if (!revealSupported) return false;
  if (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1') return true;
  try {
    return new URL(gatewayUrl).origin === loc.origin;
  } catch {
    return false;
  }
}

/** {@link canRevealInExplorer} against the live snapshot and the live page origin. */
export function canRevealInExplorerNow(): boolean {
  const snap = _store.getSnapshot();
  if (snap.state !== 'connected') return false;
  try {
    return canRevealInExplorer(snap.revealSupported, snap.serverUrl, window.location);
  } catch {
    return false;
  }
}

/**
 * Ask the gateway to open `path` (project-relative) in the host's file manager.
 *
 * ## Every refusal retires the verb, and none of them opens a dialog
 *
 * A reveal is a convenience, so a failure may cost the user nothing but the entry disappearing
 * (plan-446 Phase 2). Any answer other than 204 therefore clears {@link ConnectSnapshot.revealSupported}
 * — 403 (the page moved to a remote origin between render and click), 404 (an older gateway with no
 * such route, or a file that is gone), 409 (the project root was dropped). The flag comes back on
 * the next `/health`, which is what makes this a probe rather than a permanent opt-out.
 *
 * A NETWORK failure is deliberately not one of those cases: it says nothing about the capability,
 * and the gateway-unreachable state already has an owner.
 *
 * @returns true when the gateway confirmed the reveal.
 */
export async function revealInExplorer(path: string): Promise<boolean> {
  const baseUrl = _store.getSnapshot().serverUrl;
  let resp: Response;
  try {
    resp = await connectRestFetch(`${baseUrl}/project/reveal`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  } catch {
    return false;
  }
  if (resp.status === 204) return true;
  _store.set({ revealSupported: false });
  return false;
}

/**
 * True when the page-load auto-probe of the stored gateway URL cannot surface
 * Chrome's Local Network Access permission prompt: loopback page origin,
 * non-local gateway target, a browser without the LNA permission gate, or the
 * permission already granted. While the permission is undecided ('prompt') the
 * silent probe must be skipped — it would fire the browser prompt on every
 * page load; the explicit Connect action in the CONNECT panel stays the one
 * place where the browser may ask.
 *
 * ⚠️ Still load-bearing after plan-363. The single-launcher work removed the *second local server*,
 * not the hosted-WEB arrangement: for user group 4 the page origin stays public while the gateway
 * stays on localhost, so this is the live path — not dead code awaiting removal. The loopback
 * fast path on the first line is what makes every local mode (group 1–3) skip the question
 * entirely, because there CONNECT is both the page origin and the gateway.
 */
export async function canSilentlyProbeGateway(): Promise<boolean> {
  if (isLoopbackOrigin()) return true;
  if (!isLocalGatewayTarget(_store.getSnapshot().serverUrl)) return true;
  try {
    const status = await navigator.permissions.query(
      { name: 'local-network-access' as PermissionName },
    );
    return status.state === 'granted';
  } catch {
    // Permission name unknown → this browser has no LNA gate, probing is silent.
    return true;
  }
}

export function setServerUrl(url: string): void {
  try {
    localStorage.setItem(LS_KEY_URL, url);
  } catch { /* ignore */ }
  if (_store.getSnapshot().serverUrl !== url) {
    clearLicenseStatus();
    // A different gateway gets its own verdict on the active-document route,
    // and owes the card nothing the previous one reported.
    _activeDocumentUnsupported = false;
    clearActiveDocumentState();
  }
  _store.set({ serverUrl: url });
}

// ── REST API Helpers ───────────────────────────────────────────────────

/**
 * A URL answered 200 with something that is not JSON — so whatever sits there, it is not a
 * CONNECT gateway.
 *
 * The case that matters is the documented Node-bridge fallback: Vite started bare on 5173, the
 * customer opens `localhost:5173`, {@link deriveDefaultGatewayUrl} derives that same origin as
 * the gateway, and `/health` is answered by Vite's SPA fallback with `index.html`. Blindly
 * calling `resp.json()` then surfaced the raw parser text ("Unexpected token '<' …"), which
 * names neither the state nor the cure.
 */
export class NonGatewayResponseError extends Error {
  /** Base URL that answered like a web server instead of a gateway. */
  readonly baseUrl: string;
  constructor(baseUrl: string, contentType: string) {
    super(`${baseUrl} answered with ${contentType || 'a non-JSON body'} instead of JSON`);
    this.name = 'NonGatewayResponseError';
    this.baseUrl = baseUrl;
  }
}

/**
 * Decode a gateway response, telling "not JSON" apart from "broken JSON".
 *
 * Detection is by payload, not by guessing: a JSON content-type takes the direct path, anything
 * else is read as text and only accepted when it actually parses. That covers every web server
 * that can end up on the configured port (bare Vite, a static host serving `dist/`, a reverse
 * proxy), which a probe of the dev-server-only `/__api/rv-devserver` identity endpoint would not.
 */
async function _readGatewayJson<T>(resp: Response, baseUrl: string): Promise<T> {
  const contentType = resp.headers.get('content-type') ?? '';
  if (/\bjson\b/i.test(contentType)) return await resp.json() as T;
  const body = await resp.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new NonGatewayResponseError(baseUrl, contentType);
  }
}

async function _fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const baseUrl = _store.getSnapshot().serverUrl;
  const resp = await connectRestFetch(`${baseUrl}${path}`, init);
  if (!resp.ok) throw new Error(await _errorMessage(resp));
  return _readGatewayJson<T>(resp, baseUrl);
}

interface ConnectErrorBody {
  error?: string;
  code?: string;
  message?: string;
  limit?: number;
  maxSignals?: number;
  admitted?: number;
  admittedSignals?: number;
  inUse?: number;
  /** How many NEW signal names the rejected request asked for (DiscoveryEndpoints bind 400). */
  requestedSignals?: number;
  /** The signal names that did not fit — its length is the fallback for `requestedSignals`. */
  rejected?: string[];
  collisions?: Array<{ signal?: string; existingInterfaceId?: string }>;
  /** Mirror/mapping validation errors from MirrorResolver.Validate. */
  details?: string[];
}

type ConnectErrorFormatter = (body: ConnectErrorBody) => string;

/** Operator-facing copy for stable backend error codes. Keep the recovery action beside the code. */
const CONNECT_ERROR_MESSAGES: Readonly<Record<string, ConnectErrorFormatter>> = {
  LICENSE_REQUIRED: () =>
    'This gateway needs a license before it serves signals - open License in the CONNECT panel.',
  SIGNAL_LIMIT_REACHED: (body) => {
    const limit = [body.limit, body.maxSignals].find((value) => Number.isFinite(value));
    const inUse = [body.admittedSignals, body.admitted, body.inUse]
      .find((value) => Number.isFinite(value));
    // A rejected bind knows how many names it asked for, so say it: admission is all-or-nothing,
    // and "27 selected, 20 free" is the only phrasing that tells the operator nothing was bound
    // and by how much to trim. Requests without that count keep the older, shorter copy.
    const requested = [body.requestedSignals, body.rejected?.length]
      .find((value) => Number.isFinite(value));
    if (limit !== undefined && inUse !== undefined && requested !== undefined) {
      const free = Math.max(0, limit - inUse);
      return `Signal limit reached: ${requested} new signals selected, only ${free} of ${limit} free`
        + ' - upgrade the license or select fewer.';
    }
    return limit !== undefined && inUse !== undefined
      ? `Signal limit reached (${inUse} of ${limit} in use) - upgrade or remove signals.`
      : 'Signal limit reached - upgrade or remove signals.';
  },
};

/** Convert a backend code (or a message beginning with one) into actionable operator copy. */
export function humanizeConnectError(error: string, body: ConnectErrorBody = {}): string {
  const code = body.code ?? error.match(/^[A-Z][A-Z0-9_]+/)?.[0];
  const formatter = code ? CONNECT_ERROR_MESSAGES[code] : undefined;
  return formatter ? formatter(body) : error;
}

const CONNECT_WORKER_STATUS_LABELS: Readonly<Record<string, string>> = {
  SignalLimitExceeded: 'Signal limit',
};

/** Human-readable worker status for tooltips and accessible names; raw status stays available for logic. */
export function humanizeConnectWorkerStatus(status: string): string {
  return CONNECT_WORKER_STATUS_LABELS[status] ?? status;
}

/**
 * Build a readable error from a failed response. The gateway's structured error bodies
 * (notably the 409 signal-name collision from `SignalNameCollision.BuildErrorResponse`:
 * `{ error, collisions: [{ signal, existingInterfaceId }] }`) are flattened into one line
 * so dialogs can show WHICH name collides with WHICH interface instead of "HTTP 409".
 */
async function _errorMessage(resp: Response): Promise<string> {
  const fallback = `HTTP ${resp.status}: ${resp.statusText}`;
  try {
    const body = (await resp.json()) as ConnectErrorBody;
    if (!body?.error) return fallback;
    const mapped = humanizeConnectError(body.error, body);
    if (mapped !== body.error) return mapped;
    const details = (body.collisions ?? [])
      .map(c => `'${c.signal}' (already bound to interface '${c.existingInterfaceId}')`)
      .concat(body.details ?? [])
      .join(', ');
    return details ? `${body.error}: ${details}` : body.error;
  } catch {
    return fallback;
  }
}

// ── Actions ────────────────────────────────────────────────────────────

/**
 * Turn a fetch failure into an operator-readable message. Network-level failures
 * ("Failed to fetch" / "NetworkError…") name the likely cause and the next step
 * instead of leaking the browser's internal wording.
 */
function _friendlyError(err: unknown, serverUrl: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof NonGatewayResponseError) {
    return `${err.baseUrl} served the viewer, not the realvirtual CONNECT gateway. `
      + `CONNECT is probably running on a different port - enter its address under the settings gear, `
      + `for example ${FALLBACK_GATEWAY_URL}.`;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return `No gateway answered at ${serverUrl} within ${HEALTH_TIMEOUT_MS / 1000} s. `
      + 'Start realvirtual CONNECT on that machine, then connect again.';
  }
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
    return `No gateway answered at ${serverUrl}. Start realvirtual CONNECT on that machine, then connect again.`;
  }
  return humanizeConnectError(msg);
}

interface GatewayHealth {
  status: string;
  /** New gateways: semantic version "X.Y.Z". */
  version?: string;
  /** New gateways: build number. */
  build?: number | string;
  /** Legacy gateways: full version "X.Y.Z.BUILD" (still sent for compatibility). */
  appVersion?: string;
  buildDate?: string;
  /** May this gateway update itself right now (plan-343 F12)? Absent on older gateways. */
  updateSupported?: boolean;
  /** Why it may not — a token from the closed `UpdateReasons` set (plan-363 Phase 8). */
  updateReason?: string | null;
  /**
   * Can this gateway reveal a project path in the host's file manager (plan-446 F1)? Absent on
   * every gateway older than that plan, and false on one without a project root.
   */
  revealSupported?: boolean;
}

/**
 * Abort a /health probe after this long. A silently dropped connection (firewall eats SYNs
 * without RST) otherwise parks `connectToServer` in 'connecting' for the OS default timeout —
 * and while the boot probe is in flight, `retryInFlight` blocks even the visibility/online
 * wake trigger (debug-026).
 */
const HEALTH_TIMEOUT_MS = 5000;

/** Read `/health` from one base URL and insist the answer is a healthy gateway's. */
async function _fetchGatewayHealth(baseUrl: string): Promise<GatewayHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await connectRestFetch(`${baseUrl}/health`, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!resp.ok) throw new Error(await _errorMessage(resp));
  const health = await _readGatewayJson<GatewayHealth>(resp, baseUrl);
  if (health.status !== 'ok') throw new Error(`Server reports status: ${health.status}`);
  return health;
}

/**
 * May the failing gateway URL be swapped for CONNECT's default port, or was it the user's choice?
 *
 * Only a *derived* URL may be replaced silently. A URL the user entered stays untouched even when
 * nothing answers there — connecting somewhere else than what the settings dialog shows would be
 * worse than the error. The stored value is the discriminator: absent means nothing was ever
 * chosen, and a stored value equal to the derived one is indistinguishable from the derivation
 * (and equally safe to re-derive).
 *
 * A hosted (non-loopback) origin derives {@link FALLBACK_GATEWAY_URL} already, so the first
 * condition also keeps that case from asking the same port twice.
 *
 * Pure and exported for tests: the page origin cannot be stubbed in browser-mode vitest.
 */
export function shouldAdoptFallbackGateway(
  attemptedUrl: string,
  derivedUrl: string,
  storedUrl: string | null,
): boolean {
  if (attemptedUrl === FALLBACK_GATEWAY_URL) return false;
  if (attemptedUrl !== derivedUrl) return false;
  return storedUrl === null || storedUrl === attemptedUrl;
}

/** {@link shouldAdoptFallbackGateway} against the live page origin and `localStorage`. */
function _mayAdoptFallbackGateway(attemptedUrl: string): boolean {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(LS_KEY_URL);
  } catch { /* ignore */ }
  return shouldAdoptFallbackGateway(attemptedUrl, defaultGatewayUrl(), stored);
}

/**
 * Connect to CONNECT server: check /health, then load interfaces.
 *
 * `explicit: true` marks a connect the user asked for (Connect button / Enter in the URL
 * field) as opposed to the page-load auto-probe. Only an explicit success records
 * {@link hasUserConnectedBefore}, which is what later allows the auto-probe to touch a
 * local gateway from a hosted origin.
 */
export async function connectToServer(opts?: { explicit?: boolean }): Promise<void> {
  _setAutoConnectOptOut(false);
  _store.set({ state: 'connecting', errorMessage: '' });

  try {
    const attemptedUrl = _store.getSnapshot().serverUrl;
    let health: GatewayHealth;
    try {
      health = await _fetchGatewayHealth(attemptedUrl);
    } catch (err) {
      // Exactly one recovery attempt, and only for the one diagnosable case: the derived URL
      // belongs to a web server that is not CONNECT (bare Vite on 5173). CONNECT's own default
      // port is the only other place worth asking. Anything else — including a failing fallback —
      // is reported against the URL the user can see.
      if (!(err instanceof NonGatewayResponseError)
        || !_mayAdoptFallbackGateway(attemptedUrl)) throw err;
      health = await _fetchGatewayHealth(FALLBACK_GATEWAY_URL).catch(() => { throw err; });
      setServerUrl(FALLBACK_GATEWAY_URL);
    }
    // Prefer the new version/build fields; fall back to legacy appVersion for older gateways.
    const version = health.version ?? health.appVersion ?? '';
    const build = health.build != null ? String(health.build) : '';
    _statusFailCount = 0;
    _store.set({
      state: 'connected',
      errorMessage: '',
      serverVersion: version,
      serverBuild: build,
      serverBuildDate: health.buildDate ?? '',
      gatewayUnreachable: false,
      lastStatusUpdate: Date.now(),
      updateSupported: health.updateSupported === true,
      updateReason: health.updateReason ?? null,
      // Strict `=== true`, like `updateSupported` beside it: an older gateway omits the field, and
      // `undefined` must read as "cannot", never as "unknown, try anyway".
      revealSupported: health.revealSupported === true,
    });

    if (opts?.explicit) _recordUserConnected();

    // Load interfaces + the gateway's own type catalog after successful connect
    await fetchInterfaces();
    await fetchInterfaceTypes();
    queueConnectNewsFetch();
  } catch (err) {
    _store.set({
      state: 'error',
      errorMessage: _friendlyError(err, _store.getSnapshot().serverUrl),
      interfaces: [],
    });
  }
}

let hasFetchedConnectThisSession = false;
let connectNewsFetchInFlight = false;

/** Starts the non-critical gateway news request without delaying connection success. */
function queueConnectNewsFetch(): void {
  if (hasFetchedConnectThisSession || connectNewsFetchInFlight) return;
  connectNewsFetchInFlight = true;
  const serverUrl = _store.getSnapshot().serverUrl;
  void fetchConnectNews(serverUrl)
    .then((succeeded) => {
      if (succeeded) hasFetchedConnectThisSession = true;
    })
    .finally(() => {
      connectNewsFetchInFlight = false;
    });
}

/**
 * Fetch the gateway's own interface-type catalog (`GET /interface-types`). Non-fatal: an older
 * gateway without the endpoint simply leaves `availableTypes` at `null`, and the Add-Interface
 * list falls back to the static {@link CONNECT_INTERFACE_TYPES} registry.
 */
export async function fetchInterfaceTypes(): Promise<void> {
  try {
    const resp = await _fetchJson<{ types: {
      type: string;
      label: string;
      description: string;
      defaults: Record<string, unknown>;
      /** Signal-authoring schema — absent on older gateways (pre manual-signal support). */
      signals?: ConnectSignalSchema;
    }[] }>(
      '/interface-types',
    );
    if (Array.isArray(resp.types) && resp.types.length > 0) {
      _store.set({
        availableTypes: resp.types.map(t => ({
          type: t.type as ConnectInterfaceType,
          label: t.label,
          description: t.description,
          defaults: t.defaults ?? {},
          ...(t.signals ? { signals: t.signals } : {}),
        })),
      });
    }
  } catch {
    // Older gateway without /interface-types — keep null, callers use the static registry.
    _store.set({ availableTypes: null });
  }
}

/**
 * Signal-authoring schema for an interface type, or null when the connected gateway does not
 * advertise one (older gateway → no manual signal editing, legacy browse behavior).
 */
export function getSignalSchema(type: ConnectInterfaceType | string): ConnectSignalSchema | null {
  const def = _store.getSnapshot().availableTypes?.find(t => t.type === type);
  return def?.signals ?? null;
}

/**
 * The interface types to offer in the Add-Interface flow: the connected gateway's own catalog
 * when it advertises one, else the static compile-time registry (older gateways).
 */
export function getAvailableInterfaceTypes(): ConnectInterfaceTypeDef[] {
  return _store.getSnapshot().availableTypes ?? CONNECT_INTERFACE_TYPES;
}

/** Disconnect from CONNECT server. */
export function disconnectFromServer(): void {
  _statusFailCount = 0;
  _setAutoConnectOptOut(true);
  clearLicenseStatus();
  // The "no such route" latch belongs to a gateway, not to the session: the next
  // connect may be to an updated one, and it deserves to be asked again.
  _activeDocumentUnsupported = false;
  clearActiveDocumentState();
  _store.set({
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    gatewayUnreachable: false,
    lastStatusUpdate: 0,
    interfaces: [],
    interfaceStatus: {},
    activeProfile: null,
    activeProfileModel: null,
    availableTypes: null,
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
    updateSupported: false,
    updateReason: null,
    revealSupported: false,
  });
}

/** Fetch the list of configured interfaces from the CONNECT REST API. */
export async function fetchInterfaces(): Promise<void> {
  try {
    const ifaces = await _fetchJson<ConnectInterface[]>('/config/interfaces');
    _store.set({ interfaces: ifaces });
  } catch (err) {
    console.error('[connect-store] Failed to fetch interfaces:', err);
  }
}

/** Consecutive network-level /status failures before the gateway counts as unreachable. */
const STATUS_FAIL_THRESHOLD = 3;
let _statusFailCount = 0;

/**
 * Fetch live per-interface worker status (/status) and update the snapshot map.
 *
 * Status truthfulness: a network-level fetch failure means the gateway process
 * itself is gone — after {@link STATUS_FAIL_THRESHOLD} consecutive failures the
 * snapshot flips to `gatewayUnreachable` so the UI never keeps showing a green
 * "Connected" for a dead gateway. The next successful poll clears it again.
 * An HTTP error (e.g. 404 on older gateways without /status) still proves the
 * gateway is alive and only leaves the per-interface map untouched.
 */
export async function fetchStatus(): Promise<void> {
  const serverUrl = _store.getSnapshot().serverUrl;
  // License status shares this established 2 s poll. Starting both requests
  // together avoids a second timer and keeps neither endpoint behind the other.
  const licensePoll = fetchLicenseStatus(serverUrl);
  let resp: Response;
  try {
    resp = await fetch(`${serverUrl}/status`);
  } catch {
    _statusFailCount++;
    if (_statusFailCount >= STATUS_FAIL_THRESHOLD && !_store.getSnapshot().gatewayUnreachable) {
      _store.set({ gatewayUnreachable: true });
    }
    await licensePoll;
    return;
  }
  _statusFailCount = 0;
  if (!resp.ok) {
    // Older gateways without /status — gateway alive, leave the map untouched.
    _store.set({ gatewayUnreachable: false, lastStatusUpdate: Date.now() });
    await licensePoll;
    return;
  }
  try {
    const data = (await resp.json()) as {
      activeProfile?: string | null;
      activeProfileModel?: string | null;
      interfaces: Array<{
        id: string; status: string; error?: string | null;
        signalIssues?: ConnectSignalIssue[] | null;
      }>;
    };
    const map: Record<string, ConnectInterfaceStatus> = {};
    for (const i of data.interfaces) {
      map[i.id] = {
        status: i.status,
        error: i.error ? humanizeConnectError(i.error) : undefined,
        signalIssues: i.signalIssues?.length ? i.signalIssues : undefined,
      };
    }
    _store.set({
      interfaceStatus: map,
      activeProfile: data.activeProfile ?? null,
      activeProfileModel: data.activeProfileModel ?? null,
      gatewayUnreachable: false,
      lastStatusUpdate: Date.now(),
    });
  } catch {
    // Malformed body — still a live gateway.
    _store.set({ gatewayUnreachable: false, lastStatusUpdate: Date.now() });
  }
  await licensePoll;
}

function _isProviders(v: unknown): v is { embedding: string; rerank: string; chat: string } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.embedding === 'string' && typeof o.rerank === 'string' && typeof o.chat === 'string';
}

function _chatProviders(v: unknown): RagChatProvider[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const providers: RagChatProvider[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const provider = item as Record<string, unknown>;
    if (typeof provider.name !== 'string' || typeof provider.status !== 'string') continue;
    providers.push({
      name: provider.name,
      status: provider.status,
      ...(typeof provider.detail === 'string' ? { detail: provider.detail } : {}),
    });
  }
  return providers;
}

/**
 * Map a `GET /diagnose/status` response into a {@link RagStatus} (plan-284). Legacy detection:
 * an HTTP 404 OR a non-JSON body (CONNECT answers unknown routes with a 200 text/html SPA fallback)
 * both mean "old gateway without the endpoint" → `{ supported: false }`, which reads distinctly from
 * a gateway that merely has the feature disabled (`supported: true, enabled: false`). Exported so the
 * mapping is unit-testable without a live server.
 */
export function mapDiagnoseStatus(
  status: number,
  json: unknown,
  contentType: string | null = 'application/json',
): RagStatus {
  if (status === 404) return { supported: false };
  if (!contentType || !contentType.includes('application/json')) return { supported: false };
  const d = json as Record<string, unknown> | null;
  if (!d || typeof d !== 'object' || d.supported !== true) return { supported: false };
  return {
    supported: true,
    enabled: d.enabled === true,
    indexState: (typeof d.indexState === 'string' ? d.indexState : 'uninitialized') as RagIndexState,
    rerankState: (typeof d.rerankState === 'string' ? d.rerankState : 'disabled') as RagRerankState,
    providers: _isProviders(d.providers) ? d.providers : undefined,
    chatProviders: _chatProviders(d.chatProviders),
    chatTimeoutSeconds: typeof d.chatTimeoutSeconds === 'number'
      && Number.isFinite(d.chatTimeoutSeconds) && d.chatTimeoutSeconds > 0
      ? d.chatTimeoutSeconds
      : undefined,
    model: typeof d.model === 'string' ? d.model : undefined,
    embeddingModel: typeof d.embeddingModel === 'string' ? d.embeddingModel : undefined,
    docs: typeof d.docs === 'number' ? d.docs : undefined,
    chunks: typeof d.chunks === 'number' ? d.chunks : undefined,
    dim: typeof d.dim === 'number' ? d.dim : undefined,
    apiKeyConfigured: typeof d.apiKeyConfigured === 'boolean' ? d.apiKeyConfigured : undefined,
    lastSuccessfulSyncUtc: typeof d.lastSuccessfulSyncUtc === 'string' ? d.lastSuccessfulSyncUtc : null,
    lastSyncError: typeof d.lastSyncError === 'string' ? d.lastSyncError : null,
  };
}

/**
 * Poll CONNECT's authenticated `GET /diagnose/status` and update `snapshot.rag` (plan-284). Reuses
 * the same 2 s cadence as {@link fetchStatus} (driven by the RAG settings section while it is shown).
 *
 * Robustness (SOL RC9): an {@link AbortController} with a timeout bounds each request; the server URL
 * captured at request start guards against a late/overlapping response overwriting the snapshot after
 * a disconnect or URL change.
 */
export async function fetchDiagnoseStatus(): Promise<void> {
  const url = _store.getSnapshot().serverUrl;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  let resp: Response;
  try {
    resp = await fetch(`${url}/diagnose/status`, { signal: controller.signal });
  } catch {
    return; // network error / abort — keep the last value; connection state drives "offline"
  } finally {
    clearTimeout(timeout);
  }

  // Guard: drop a response that arrived after the URL changed or we disconnected.
  const now = _store.getSnapshot();
  if (now.serverUrl !== url || now.state !== 'connected') return;

  const contentType = resp.headers.get('content-type');
  let json: unknown = null;
  if (resp.ok && contentType && contentType.includes('application/json')) {
    try {
      json = await resp.json();
    } catch {
      json = null;
    }
  }
  _store.set({ rag: mapDiagnoseStatus(resp.status, json, contentType) });
}

/**
 * Add a new interface via REST API. Returns the server-created interface (with its real `id`).
 *
 * `id` is optional: pass one to request a human-readable id (e.g. via {@link nextInterfaceId}),
 * or omit it to let the gateway generate a short GUID (`POST /config/interfaces` fills in
 * `Id` server-side when the field is empty).
 */
export async function addInterface(
  iface: Omit<ConnectInterface, 'id' | 'signals'> & { id?: string },
): Promise<ConnectInterface> {
  try {
    const created = await _fetchJson<ConnectInterface>('/config/interfaces', {
      method: 'POST',
      body: JSON.stringify(iface),
    });
    _store.set(prev => ({ ...prev, interfaces: [...prev.interfaces, created] }));
    return created;
  } catch (err) {
    console.error('[connect-store] Failed to add interface:', err);
    throw err;
  }
}

// ── Interface Type Registry (single source of truth for the Add-flow list ──
// ── and the Edit form's default seeding) ─────────────────────────────────

export interface ConnectInterfaceTypeDef {
  type: ConnectInterfaceType;
  label: string;
  description: string;
  /** Minimal default fields for a freshly-added interface of this type (merged onto `{ id, type, enabled: false }`). */
  defaults: Record<string, unknown>;
  /**
   * Signal-authoring schema from the gateway (`GET /interface-types` → `signals`). Undefined on the
   * static fallback registry and on older gateways — manual signal editing is then unavailable.
   */
  signals?: ConnectSignalSchema;
}

/** Backend default `TwinCatSettings` (ProtocolSettings.cs) — also the Edit-form seed for legacy/partial configs. */
export const TWINCAT_SETTINGS_DEFAULTS: TwinCatSettings = {
  netId: '',
  adsPort: 851,
  mode: 'SumCommand',
  routeHostIp: null,
  maxSubCommands: 1000,
  writeAllInputsOnStart: false,
  readAllOutputsOnStart: false,
  useEmbeddedRouter: true,
  routerLocalNetId: null,
  regExImportSignals: [],
  regExSkipSignals: [],
  regExSymbolIsInput: [],
};

/** Backend default `ModbusSettings` for a `Modbus` (client) interface. */
export const MODBUS_SETTINGS_DEFAULTS: ModbusSettings = {
  host: '',
  port: 502,
  unitId: 1,
  isServer: false,
  wordOrder: 'ABCD',
  transport: 'Tcp',
};

/** Same `ModbusSettings` shape, seeded for a `ModbusServer` (listener) interface. */
export const MODBUS_SERVER_SETTINGS_DEFAULTS: ModbusSettings = {
  host: '0.0.0.0',
  port: 502,
  unitId: 1,
  isServer: true,
  wordOrder: 'ABCD',
  transport: 'Tcp',
};

/** Backend default `EthernetIpSettings`. */
export const ETHERNETIP_SETTINGS_DEFAULTS: EthernetIpSettings = {
  gateway: '',
  path: '1,0',
  plcType: 'ControlLogix',
  timeoutMs: 5000,
};

/** Backend default `CtrlXSettings`. */
export const CTRLX_SETTINGS_DEFAULTS: CtrlXSettings = {
  address: '',
  useSsl: true,
  username: null,
  password: null,
  bridgePath: '/ctrlx-rv-bridge/ws',
  directPort: 8080,
  tokenTtlMinutes: 10,
};

/** Backend default `CtrlXDataLayerSettings`. */
export const CTRLXDATALAYER_SETTINGS_DEFAULTS: CtrlXDataLayerSettings = {
  address: '',
  port: 443,
  username: null,
  password: null,
  allowUntrustedCertificate: false,
  useStatelessSubscription: false,
  publishIntervalMs: 100,
  keepaliveIntervalMs: 60000,
  errorIntervalMs: 10000,
  samplingIntervalUs: 0,
  queueSize: 100,
  queueBehaviour: 'DiscardOldest',
  valueChange: 'StatusValue',
  browseRootPaths: [],
  maxSubscriptionNodes: 500,
  stableConnectionSec: 30,
  tokenTtlMinutes: 10,
};

/** Backend default `KebaSettings`. */
export const KEBA_SETTINGS_DEFAULTS: KebaSettings = {
  host: '',
  httpPort: 80,
  wsPort: 80,
  username: 'Administrator',
  password: null,
  importRootPaths: ['SYS'],
  cycleTimeMs: 100,
  useOnChange: true,
  usePatternMatching: true,
  inputPatterns: ['input'],
  outputPatterns: ['output'],
};

/** Backend default `FestoSettings`. */
export const FESTO_SETTINGS_DEFAULTS: FestoSettings = {
  host: '',
  port: 41100,
  useTls: true,
  username: 'admin',
  password: null,
  useSubscription: true,
  subscriptionCycleMs: 100,
};

/** Backend default `FanucSettings`. */
export const FANUC_SETTINGS_DEFAULTS: FanucSettings = {
  address: '127.0.0.1',
  port: 60008,
  axisCount: 6,
};

/** Backend default `DensoSettings`. */
export const DENSO_SETTINGS_DEFAULTS: DensoSettings = {
  host: '127.0.0.1',
  controllerType: 'RC8',
  controllerName: 'Robot1',
  wincapsProject: '',
  connectRealRobot: false,
  timeoutMs: 3000,
  retry: 3,
  watchdogMs: 400,
  axisCount: 6,
};

/** Backend default `AbbRobotStudioSettings`. */
export const ABB_ROBOTSTUDIO_SETTINGS_DEFAULTS: AbbRobotStudioSettings = {
  sharedMemoryName: 'SIMITShared Memory',
};

/**
 * All interface types the "Add Interface" list offers, in display order. This is the single
 * source of truth for both the Add-flow list (label + description) and the minimal default
 * payload posted when a type is picked (plan-243 §2.6 "WebUI form").
 */
export const CONNECT_INTERFACE_TYPES: ConnectInterfaceTypeDef[] = [
  {
    type: 'MQTT',
    label: 'MQTT Broker',
    description: 'Topics or Siemens process image via broker',
    defaults: { brokerUrl: 'mqtt://localhost:1883' },
  },
  {
    type: 'OpcUa',
    label: 'OPC UA',
    description: 'Browse and subscribe to an OPC UA server',
    defaults: { endpoint: 'opc.tcp://localhost:4840' },
  },
  {
    type: 'S7',
    label: 'Siemens S7',
    description: 'S7comm to S7-300/400/1200/1500 and PLCSIM Advanced',
    defaults: { ipAddress: '192.168.1.50', rack: 0, slot: 1 },
  },
  {
    type: 'TwinCat',
    label: 'Beckhoff TwinCAT ADS',
    description: 'Symbolic access, embedded AMS router',
    defaults: { twinCat: { ...TWINCAT_SETTINGS_DEFAULTS } },
  },
  {
    type: 'Modbus',
    label: 'Modbus TCP Client',
    description: 'Read/write coils and registers of a Modbus device',
    defaults: { modbus: { ...MODBUS_SETTINGS_DEFAULTS } },
  },
  {
    type: 'ModbusServer',
    label: 'Modbus TCP Server',
    description: 'CONNECT acts as slave; PLCs connect to CONNECT',
    defaults: { allowWebToPlc: true, modbus: { ...MODBUS_SERVER_SETTINGS_DEFAULTS } },
  },
  {
    type: 'EthernetIp',
    label: 'EtherNet/IP',
    description: 'Allen-Bradley ControlLogix/CompactLogix/Micro800 tags',
    defaults: { ethernetIp: { ...ETHERNETIP_SETTINGS_DEFAULTS } },
  },
  {
    type: 'CtrlX',
    label: 'Bosch Rexroth ctrlX',
    description: 'Tunnel to the ctrlx-rv-bridge snap on a ctrlX CORE',
    defaults: { ctrlX: { ...CTRLX_SETTINGS_DEFAULTS } },
  },
  {
    type: 'CtrlXDataLayer',
    label: 'Bosch Rexroth ctrlX (Data Layer)',
    description: 'Native REST/SSE connection to the ctrlX Data Layer',
    defaults: {
      ctrlXDataLayer: {
        ...CTRLXDATALAYER_SETTINGS_DEFAULTS,
        browseRootPaths: [...CTRLXDATALAYER_SETTINGS_DEFAULTS.browseRootPaths],
      },
    },
  },
  {
    type: 'Keba',
    label: 'Keba Kemro X',
    description: 'Variable service via WebSocket topics and write_vars',
    defaults: { keba: { ...KEBA_SETTINGS_DEFAULTS } },
  },
  {
    type: 'Festo',
    label: 'Festo AX (PLCnext)',
    description: 'RSC data access with subscription or polling',
    defaults: { festo: { ...FESTO_SETTINGS_DEFAULTS } },
  },
  {
    type: 'Fanuc',
    label: 'FANUC (RoboGuide / Robot-IF)',
    description: 'SNPX signals (do/di/ui/…) and joint positions',
    defaults: { fanuc: { ...FANUC_SETTINGS_DEFAULTS } },
  },
  {
    type: 'Denso',
    label: 'Denso (b-CAP / WinCaps VRC)',
    description: 'IO/I/F/S variables and joint positions via b-CAP',
    defaults: { denso: { ...DENSO_SETTINGS_DEFAULTS } },
  },
  {
    type: 'AbbRobotStudio',
    label: 'ABB RobotStudio (SIMIT SHM)',
    description: 'Shared-memory exchange with RobotStudio on this machine',
    defaults: { abbRobotStudio: { ...ABB_ROBOTSTUDIO_SETTINGS_DEFAULTS } },
  },
  {
    type: 'SHM',
    label: 'Shared Memory (SIMIT)',
    description: 'SIMIT-layout shared memory for a Unity/SIMIT consumer on this machine',
    defaults: { sharedMemory: { sharedMemoryName: 'realvirtualSHM', useGlobalNamespace: false } },
  },
];

/** Lowercase, hyphenated slug used to build a human-readable default interface id (e.g. "twincat-1"). */
function _typeSlug(type: ConnectInterfaceType): string {
  switch (type) {
    case 'MQTT': return 'mqtt';
    case 'OpcUa': return 'opcua';
    case 'S7': return 's7';
    case 'TwinCat': return 'twincat';
    case 'Modbus': return 'modbus';
    case 'ModbusServer': return 'modbus-server';
    case 'EthernetIp': return 'ethernetip';
    case 'CtrlX': return 'ctrlx';
    case 'CtrlXDataLayer': return 'ctrlx-datalayer';
    case 'Keba': return 'keba';
    case 'Festo': return 'festo';
    case 'Fanuc': return 'fanuc';
    case 'Denso': return 'denso';
    case 'AbbRobotStudio': return 'abb-robotstudio';
    default: return 'iface';
  }
}

/** Next free human-readable id for a new interface of `type` (e.g. "twincat-1", "twincat-2", ...). */
export function nextInterfaceId(type: ConnectInterfaceType): string {
  const slug = _typeSlug(type);
  const existing = new Set(_store.getSnapshot().interfaces.map(i => i.id));
  let n = 1;
  while (existing.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

/**
 * Update an existing interface via REST API.
 *
 * CONNECT's `PUT /config/interfaces/{id}` REPLACES the whole interface, so any field
 * absent from the body resets to its server-side default — most damagingly `Type → ""`,
 * which makes the WorkerManager start no worker (no connection, no decoded signals).
 * We therefore merge the partial `patch` onto the current interface and always send the
 * complete object.
 */
export async function updateInterface(id: string, patch: Partial<ConnectInterface>): Promise<void> {
  try {
    const existing = _store.getSnapshot().interfaces.find(i => i.id === id);
    const body: Partial<ConnectInterface> = existing ? { ...existing, ...patch, id } : { ...patch, id };
    await _fetchJson<unknown>(`/config/interfaces/${id}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    // Refresh from server
    await fetchInterfaces();
  } catch (err) {
    console.error('[connect-store] Failed to update interface:', err);
    throw err;
  }
}

/** Remove an interface via REST API. */
export async function removeInterface(id: string): Promise<void> {
  try {
    await fetch(`${_store.getSnapshot().serverUrl}/config/interfaces/${id}`, { method: 'DELETE' });
    _store.set(prev => {
      const interfaces = prev.interfaces.filter(i => i.id !== id);
      const cleared = prev.activeInterfaceId === id;
      return {
        ...prev,
        interfaces,
        activeInterfaceId: cleared ? null : prev.activeInterfaceId,
        discoveredSignals: cleared ? [] : prev.discoveredSignals,
      };
    });
  } catch (err) {
    console.error('[connect-store] Failed to remove interface:', err);
    throw err;
  }
}

/** Set the active interface for the signal browser. */
export function setActiveInterface(id: string | null): void {
  _store.set({
    activeInterfaceId: id,
    discoveredSignals: [],
    discoveryLoading: false,
  });
}

/** Start signal discovery for the active interface. */
export async function startDiscovery(interfaceId: string): Promise<void> {
  _store.set({ discoveryLoading: true, discoveredSignals: [] });

  try {
    // POST runs discovery (subscribe to '#' for a window) and returns the signals directly.
    // The gateway's DiscoveredSignal uses name/browsePath (no protocolAddress) — map it here.
    const resp = await _fetchJson<{
      signals?: Array<{ name?: string; displayName?: string; dataType?: string; direction?: string; browsePath?: string; currentValue?: unknown }>;
    }>(`/discover/${interfaceId}/start`, { method: 'POST' });

    const discovered: DiscoveredSignal[] = (resp.signals ?? []).map(s => {
      const addr = s.browsePath || s.name || '';
      const dir: DiscoveredSignal['direction'] =
        s.direction === 'input' || s.direction === 'output' ? s.direction : 'unknown';
      return {
        protocolAddress: addr,
        displayName: s.displayName || s.name || addr,
        dataType: s.dataType || '',
        direction: dir,
        browsePath: s.browsePath || addr,
        currentValue: s.currentValue,
        selected: false,
      };
    });

    _store.set({ discoveredSignals: discovered, discoveryLoading: false });
  } catch (err) {
    console.error('[connect-store] Discovery failed:', err);
    _store.set({ discoveryLoading: false });
  }
}

/** Toggle selection of a discovered signal. */
export function toggleSignalSelection(protocolAddress: string): void {
  _store.set(prev => ({
    ...prev,
    discoveredSignals: prev.discoveredSignals.map(s =>
      s.protocolAddress === protocolAddress ? { ...s, selected: !s.selected } : s,
    ),
  }));
}

/** Select or deselect all discovered signals. */
export function selectAllSignals(selected: boolean): void {
  _store.set(prev => ({
    ...prev,
    discoveredSignals: prev.discoveredSignals.map(s => ({ ...s, selected })),
  }));
}

/**
 * The signal name a discovered signal binds under. Exported because the browse window has to
 * count NEW names against the license budget exactly the way the gateway does — a preventive
 * check that derives the name differently would disable the button on already-bound signals.
 */
export function discoveredSignalName(displayName: string): string {
  return displayName.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Bind selected discovered signals to the active interface. */
export async function bindSelectedSignals(interfaceId: string): Promise<void> {
  const selected = _store.getSnapshot().discoveredSignals.filter(s => s.selected);
  if (selected.length === 0) return;

  const bindings = selected.map(s => ({
    protocolAddress: s.protocolAddress,
    signalName: discoveredSignalName(s.displayName),
    type: `PLC${s.direction === 'input' ? 'Input' : 'Output'}${s.dataType === 'Bool' ? 'Bool' : s.dataType === 'Int' ? 'Int' : 'Float'}`,
    // Persist the discovered data type (plan-352 F9). Without it the gateway stores `""` and a
    // later direction change in the signal dialog has no type left to preserve.
    ...(s.dataType ? { dataType: s.dataType } : {}),
    record: false,
  }));

  try {
    await _fetchJson<unknown>(`/discover/${interfaceId}/bind`, {
      method: 'POST',
      body: JSON.stringify(bindings),
    });
    // Refresh interfaces to reflect new signals
    await fetchInterfaces();
    // Clear discovery state
    _store.set({ discoveredSignals: [] });
  } catch (err) {
    console.error('[connect-store] Bind failed:', err);
    throw err;
  }
}

// ── Manual Signal Editing ────────────────────────────────────────────────
//
// Signals are part of the interface object; CONNECT has no dedicated signal CRUD endpoint.
// All three actions therefore merge the interface's `signals` array and write through
// `updateInterface` → `PUT /config/interfaces/{id}` — the same path discovery-bind and the
// tag-table import use, so the collision check (409), atomic config save and worker hot-reload
// apply identically. A renamed/deleted signal's old store entry is pruned gateway-side on reload.

/** Add a manually created signal to an interface. Throws with a readable message on a 409 name collision. */
export async function addSignal(interfaceId: string, signal: ConnectInterfaceSignal): Promise<void> {
  const iface = _store.getSnapshot().interfaces.find(i => i.id === interfaceId);
  if (!iface) throw new Error(`Interface '${interfaceId}' not found`);
  await updateInterface(interfaceId, { signals: [...(iface.signals ?? []), signal] });
}

/**
 * Update (or rename) an existing signal on an interface. `originalName` identifies the signal —
 * pass the pre-edit name so renames replace the old entry instead of duplicating it.
 */
export async function updateSignal(
  interfaceId: string,
  originalName: string,
  signal: ConnectInterfaceSignal,
): Promise<void> {
  const iface = _store.getSnapshot().interfaces.find(i => i.id === interfaceId);
  if (!iface) throw new Error(`Interface '${interfaceId}' not found`);
  const signals = (iface.signals ?? []).map(s => (s.name === originalName ? signal : s));
  await updateInterface(interfaceId, { signals });
}

/** Remove a signal from an interface. */
export async function removeSignal(interfaceId: string, name: string): Promise<void> {
  const iface = _store.getSnapshot().interfaces.find(i => i.id === interfaceId);
  if (!iface) throw new Error(`Interface '${interfaceId}' not found`);
  const signals = (iface.signals ?? []).filter(s => s.name !== name);
  await updateInterface(interfaceId, { signals });
}

/**
 * Validate a protocol address server-side (`POST /signals/validate`) using the same parsers the
 * worker runs at connect time. Returns `null` when the gateway does not support the endpoint
 * (older gateway → the dialog silently skips live validation).
 */
export async function validateSignalAddress(
  interfaceType: ConnectInterfaceType | string,
  protocolAddress: string,
  dataType?: string,
  signalType?: string,
): Promise<SignalValidationResult | null> {
  try {
    return await _fetchJson<SignalValidationResult>('/signals/validate', {
      method: 'POST',
      body: JSON.stringify({ interfaceType, protocolAddress, dataType, signalType }),
    });
  } catch {
    return null; // endpoint missing (404 on older gateways) or network hiccup — never block the dialog
  }
}

// ── Tag Table Import ─────────────────────────────────────────────────────

export interface ImportTagTableParams {
  /** Imported and validated tags. */
  tags: S7Tag[];
  /** MQTT broker URL for the target interface. */
  brokerUrl: string;
  /** MQTT topic carrying the ProcessImage byte array. */
  topic: string;
  /**
   * Target interface id, or null to create a new interface.
   * When set and the interface exists, it is updated (PUT) and the same-named
   * topic is replaced. Otherwise a new interface is added (POST).
   */
  targetInterfaceId?: string | null;
}

/** Build one CONNECT signal config entry from a parsed tag and its (already resolved) wire type. */
function _tagToSignalConfig(t: S7Tag, type: string): ConnectInterfaceSignal {
  return {
    protocolAddress: t.address,
    name: t.name,
    type,
    dataType: t.dataType,
    ...(t.comment ? { comment: t.comment } : {}),
    record: false,
  };
}

/** Convert parsed S7 tags into CONNECT signal config entries (wire type derived from area). */
function _tagsToSignals(tags: S7Tag[]): ConnectInterfaceSignal[] {
  return tags.map(t => _tagToSignalConfig(t, deriveWireType(t.dataType, t.area)));
}

/**
 * Push an imported tag table to CONNECT as an MQTT ProcessImage topic.
 *
 * Update-vs-New: if `targetInterfaceId` names an existing interface, the
 * interface is updated via PUT and the same-named topic is replaced (no
 * duplicate); otherwise a new MQTT interface is created via POST.
 */
export async function importTagTable(params: ImportTagTableParams): Promise<void> {
  const { tags, brokerUrl, topic } = params;
  const signals = _tagsToSignals(tags);
  const newTopic: ConnectMqttTopic = { topic, mode: 'ProcessImage', signals };

  const existing = params.targetInterfaceId
    ? _store.getSnapshot().interfaces.find(i => i.id === params.targetInterfaceId)
    : undefined;

  if (existing) {
    // Replace the same-named topic in place; keep all other topics untouched.
    const prevTopics = existing.topics ?? [];
    const topics = prevTopics.some(t => t.topic === topic)
      ? prevTopics.map(t => (t.topic === topic ? newTopic : t))
      : [...prevTopics, newTopic];
    await updateInterface(existing.id, { brokerUrl, topics });
  } else {
    await addInterface({
      type: 'MQTT',
      enabled: true,
      brokerUrl,
      topics: [newTopic],
    } as Omit<ConnectInterface, 'id' | 'signals'>);
  }
}

/**
 * Push an imported tag table onto an existing **S7** interface as its flat
 * `signals` list (no MQTT topic, no broker). Used for TIA `.sdf` / csv symbol
 * tables whose addresses are process-image / flag addresses (`%Q…`, `%M…`,
 * `%I…`) read directly by the CONNECT S7 worker.
 *
 * REPLACING and idempotent: the complete `signals` array is sent via
 * `updateInterface` (which merges onto the current interface and PUTs the whole
 * object), so a re-import replaces the previous signals rather than accumulating.
 * The wire type (direction + value kind) is derived from the address area exactly
 * as for the MQTT path, so import and gateway agree on direction.
 */
export async function importS7TagTable(interfaceId: string, tags: S7Tag[]): Promise<void> {
  const signals = _tagsToSignals(tags);
  await updateInterface(interfaceId, { signals });
}

// ── Multi-Tab Tag Table Import ───────────────────────────────────────────────

/**
 * Convert one parsed topic's signals into CONNECT signal config entries. The wire
 * type is already final (direction + value kind), set in the parser so that
 * forceAllAsOutput takes effect at exactly one place.
 */
function _topicSignalsToConfig(topic: ParsedTopic): ConnectInterfaceSignal[] {
  return topic.signals.map(s => _tagToSignalConfig(s, s.wireType));
}

/**
 * Push a Multi-Tab Excel import (one MQTT topic per tab) to CONNECT as a single
 * `InterfaceConfig` whose `Topics` array carries every parsed topic.
 *
 * Idempotent and REPLACING (F10): the complete `Topics` array is sent via
 * `PUT /config/interfaces/{id}` and replaces whatever the interface had before —
 * topics removed in this import disappear, nothing accumulates. CONNECT's PUT
 * replaces the whole interface, so a stable `interfaceId` keeps re-imports from
 * duplicating. Push failures surface as a thrown error (F16), never a silent
 * no-op. The caller should `fetchInterfaces()` afterwards to refresh the UI.
 *
 * Precondition: the interface list should already be loaded (`fetchInterfaces()`)
 * so any existing interface's `enabled` flag and protocol settings are preserved
 * in the replaced config.
 */
export async function importMultiTabTagTable(
  topics: ParsedTopic[],
  params: { interfaceId: string; brokerUrl: string },
): Promise<void> {
  const { interfaceId, brokerUrl } = params;

  const mqttTopics: ConnectMqttTopic[] = topics.map(t => ({
    topic: t.topic,
    mode: 'ProcessImage',
    qos: 1,
    retained: true,
    signals: _topicSignalsToConfig(t),
  }));

  const existing = _store.getSnapshot().interfaces.find(i => i.id === interfaceId);

  // Build the complete InterfaceConfig; the whole Topics array replaces the old one.
  const body: Record<string, unknown> = {
    ...(existing ?? {}),
    id: interfaceId,
    type: 'MQTT',
    enabled: existing?.enabled ?? true,
    brokerUrl,
    topics: mqttTopics,
  };

  const resp = await fetch(`${_store.getSnapshot().serverUrl}/config/interfaces/${interfaceId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Failed to push interface "${interfaceId}": ${await _errorMessage(resp)}`);
  }
}

// ── Bridges: mirror rules & signal mappings (plan-254 backend / plan-257 UI) ──

/**
 * Auto-mirror rule: bridge ALL signals of a source interface (matching `signalPattern`)
 * into a sink interface (MQTT or SHM). Direction-preserving — out stays out, in stays in;
 * the signal name is kept identical (protocol converter semantics).
 */
export interface ConnectMirrorRule {
  enabled: boolean;
  sourceInterfaceId: string;
  targetInterfaceId: string;
  /** Glob (`*`/`?`) over source signal names. Default `*` = all. */
  signalPattern: string;
  /** MQTT sinks only: topic prefix prepended to the signal name. */
  topicPrefix?: string;
}

/** Manual 1:1 bridge: the value of `sourceSignal` is written to `destSignal` of another interface. */
export interface ConnectSignalMapping {
  enabled: boolean;
  sourceSignal: string;
  destSignal: string;
  /** 'Strict' = identical value kinds only; 'Coerce' = safe widenings (bool↔int, int→float). */
  coercion?: 'Strict' | 'Coerce';
}

export async function fetchMirrors(): Promise<ConnectMirrorRule[]> {
  return _fetchJson<ConnectMirrorRule[]>('/config/mirrors');
}

/** Replace ALL mirror rules. The gateway validates (sink types, patterns) and returns 400 with details on invalid rules. */
export async function putMirrors(mirrors: ConnectMirrorRule[]): Promise<void> {
  await _fetchJson<{ success: boolean }>('/config/mirrors', {
    method: 'PUT',
    body: JSON.stringify(mirrors),
  });
}

export async function fetchMappings(): Promise<ConnectSignalMapping[]> {
  return _fetchJson<ConnectSignalMapping[]>('/config/mappings');
}

/** Replace ALL signal mappings (validated by the gateway). */
export async function putMappings(mappings: ConnectSignalMapping[]): Promise<void> {
  await _fetchJson<{ success: boolean }>('/config/mappings', {
    method: 'PUT',
    body: JSON.stringify(mappings),
  });
}

// ── Signal-config profiles (plan-258) ────────────────────────────────────

/** Summary of one signal-config profile (full snapshots stay server-side). */
export interface ConnectProfileInfo {
  name: string;
  /**
   * plan-718: the project-relative path of the file this profile lives in — the value a
   * `documents[].connectRef` points at. Absent for a gateway without a project root.
   */
  connectRef?: string | null;
  /**
   * plan-718: the manifest documents bound to this profile. More than one is the normal N:1 case
   * (two models sharing one CONNECT configuration). Empty without a project root.
   */
  documents?: string[];
  /**
   * @deprecated plan-718 — the legacy GLB file-name binding. Still served for one release
   * generation; use {@link connectRef}/{@link documents}, which survive renaming the model.
   */
  model?: string | null;
  interfaceCount: number;
  mirrorCount: number;
  mappingCount: number;
}

/** What `GET /config/profiles` answers. `projectScoped` is absent on an older gateway. */
export interface ConnectProfileList {
  active: string | null;
  projectScoped?: boolean;
  profiles: ConnectProfileInfo[];
}

/**
 * The binding to show for a profile, in the order the reference model prefers it: the bound
 * documents first, then the connect file, then the deprecated model name — and nothing at all when
 * the profile is unbound.
 */
export function describeProfileBinding(profile: ConnectProfileInfo): string | null {
  if (profile.documents && profile.documents.length > 0) return profile.documents.join(', ');
  if (profile.connectRef) return profile.connectRef;
  return profile.model || null;
}

export async function fetchProfiles(): Promise<ConnectProfileList> {
  const res = await _fetchJson<ConnectProfileList>('/config/profiles');
  // An older gateway answers without the new fields; normalising here keeps every caller from
  // having to know which generation it is talking to.
  return {
    active: res.active ?? null,
    projectScoped: res.projectScoped ?? false,
    profiles: (res.profiles ?? []).map((p) => ({ ...p, documents: p.documents ?? [] })),
  };
}

/** Snapshot the CURRENT live config as a (new or overwritten) profile, optionally bound to a model. */
export async function saveProfile(name: string, model?: string): Promise<void> {
  await _fetchJson<{ success: boolean }>('/config/profiles', {
    method: 'POST',
    body: JSON.stringify({ name, model: model || null }),
  });
}

/** Rename a profile and/or change its model binding (does not touch the snapshot). */
export async function updateProfile(name: string, patch: { name?: string; model?: string | null }): Promise<void> {
  await _fetchJson<{ success: boolean }>(`/config/profiles/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export async function deleteProfile(name: string): Promise<void> {
  await _fetchJson<{ success: boolean }>(`/config/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

/** Activate a profile (lossless — the live set is written back into the previous profile first),
 *  then refresh the interface list so the UI shows the swapped set. */
export async function activateProfile(name: string): Promise<void> {
  await _fetchJson<{ success: boolean }>(`/config/profiles/${encodeURIComponent(name)}/activate`, { method: 'POST' });
  await fetchInterfaces();
  await fetchStatus();
}

/** The model the gateway HMI currently auto-loads (e.g. "models/CellA.glb"), or null. */
export async function fetchActiveModel(): Promise<string | null> {
  const res = await _fetchJson<{ model: string | null }>('/model');
  return res.model ?? null;
}

// ── Gateway Log ──────────────────────────────────────────────────────────

/** One gateway log line from CONNECT's /logs endpoint. */
export interface ConnectLogEntry {
  seq: number;
  time: string;
  level: string;
  category: string;
  message: string;
  /** Interface/worker name the entry belongs to (e.g. "S7-plc1"), if attributable. */
  iface?: string | null;
}

/**
 * Fetch recent gateway log entries. Pass the previous `latest` as `since` for
 * incremental polling (only entries newer than `since` are returned). `level`
 * is the minimum level (e.g. "Debug" | "Warning" | "Error"); `iface` restricts
 * to one interface. `interfaces` lists all interface names seen in the buffer.
 */
export async function fetchLogs(
  since: number,
  count = 500,
  level?: string,
  iface?: string,
): Promise<{ latest: number; interfaces?: string[]; entries: ConnectLogEntry[] }> {
  const params = new URLSearchParams({ since: String(since), count: String(count) });
  if (level) params.set('level', level);
  if (iface) params.set('iface', iface);
  return _fetchJson<{ latest: number; interfaces?: string[]; entries: ConnectLogEntry[] }>(`/logs?${params.toString()}`);
}

// ── Active document → live configuration (plan-725 §2.7) ───────────────

/** `POST /project/active-document` route, as one constant both halves read. */
const ACTIVE_DOCUMENT_ROUTE = '/project/active-document';

/**
 * How long a burst of manifest writes has to come to rest before CONNECT is
 * told. Long enough that a drag, a rename or an adopt run is one call; short
 * enough that a hero drop feels immediate (plan-725 §2.7).
 */
export const ACTIVE_DOCUMENT_DEBOUNCE_MS = 400;

/** What the gateway names when it refuses to cut a live plant's connection (F13). */
export interface ConnectPendingActivation {
  profile: string;
  connectRef: string;
  connectedInterfaces: string[];
}

/** The 200 body of `POST /project/active-document` (plan-725 §2.3). */
export interface ConnectActiveDocumentResult {
  activeProfile: string | null;
  connectRef: string | null;
  /** A configuration CONNECT created beside this document — the viewer writes the ref back (F4). */
  created: string | null;
  reloaded: boolean;
  pending: ConnectPendingActivation | null;
  activationError: string | null;
}

/**
 * Every way the call can end — and NONE of them is a thrown error.
 *
 * The caller is the tail of a write the user is waiting on (F12), so the result
 * type carries the failure instead of the control flow. `unsupported` is the
 * one that matters for compatibility: an older gateway has no such route (404),
 * and a bare Vite dev server answers the SPA's `index.html` with a 200 — both
 * mean "this feature is not there", not "something went wrong".
 */
export type ConnectActiveDocumentOutcome =
  | { kind: 'ok'; result: ConnectActiveDocumentResult }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'mismatch'; servedProject: string | null; message: string }
  | { kind: 'error'; message: string };

/** The request body (plan-725 §2.3). */
export interface ConnectActiveDocumentRequest {
  projectId: string | null;
  /** `documents[].id` of the open document. **null never deactivates anything.** */
  id: string | null;
  path?: string | null;
  /** Switch even though interfaces are connected — the F13 confirmation. */
  force?: boolean;
}

/**
 * Tell the gateway which document is open, and let it re-read the project.
 *
 * A trigger, not a data channel: the body names an identity and nothing else,
 * and every value that matters is read from disk on the other side.
 *
 * ## Nothing here throws
 *
 * 404 (older gateway), a `text/html` 200 (a web server on the configured port),
 * 401 (no key configured yet) and 503 (`CONFIG_BUSY`) are all reported as
 * outcomes, because none of them is a reason to fail the manifest write this
 * call is trailing (F9, F12). A network failure is the same.
 */
export async function postActiveDocument(
  request: ConnectActiveDocumentRequest,
): Promise<ConnectActiveDocumentOutcome> {
  const baseUrl = _store.getSnapshot().serverUrl;
  let resp: Response;
  try {
    resp = await connectRestFetch(`${baseUrl}${ACTIVE_DOCUMENT_ROUTE}`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: request.projectId,
        id: request.id,
        path: request.path ?? null,
        force: request.force ?? false,
      }),
    });
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  if (resp.status === 404) {
    return { kind: 'unsupported', reason: 'This gateway is older than the active-document endpoint.' };
  }
  if (resp.status === 401 || resp.status === 403) {
    return { kind: 'error', message: `The gateway refused the call (HTTP ${resp.status}).` };
  }

  let body: Record<string, unknown>;
  try {
    body = await _readGatewayJson<Record<string, unknown>>(resp, baseUrl);
  } catch (e) {
    // A non-JSON body on THIS route means whatever answered is not a gateway.
    // Treating it as "unsupported" rather than as an error is what keeps a
    // bare-Vite dev session from reporting a failure once per write.
    if (e instanceof NonGatewayResponseError) return { kind: 'unsupported', reason: e.message };
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }

  if (resp.status === 409) {
    const code = typeof body.code === 'string' ? body.code
      : typeof body.error === 'string' ? body.error : '';
    // NO_PROJECT is the projectless gateway — the supported standard install,
    // not a fault. PROJECT_MISMATCH is a real disagreement and must be seen (F6).
    if (code === 'PROJECT_MISMATCH') {
      return {
        kind: 'mismatch',
        servedProject: typeof body.servedProject === 'string' ? body.servedProject : null,
        message: typeof body.message === 'string'
          ? body.message
          : 'This gateway serves a different project than the one this page has open.',
      };
    }
    return { kind: 'unsupported', reason: code || 'This gateway serves no project.' };
  }
  if (!resp.ok) {
    const message = typeof body.message === 'string' ? body.message
      : typeof body.error === 'string' ? body.error
        : `HTTP ${resp.status}: ${resp.statusText}`;
    return { kind: 'error', message };
  }

  const pending = body.pending as Record<string, unknown> | null | undefined;
  return {
    kind: 'ok',
    result: {
      activeProfile: typeof body.activeProfile === 'string' ? body.activeProfile : null,
      connectRef: typeof body.connectRef === 'string' ? body.connectRef : null,
      created: typeof body.created === 'string' ? body.created : null,
      reloaded: body.reloaded === true,
      pending: pending && typeof pending.profile === 'string'
        ? {
          profile: pending.profile,
          connectRef: typeof pending.connectRef === 'string' ? pending.connectRef : '',
          connectedInterfaces: Array.isArray(pending.connectedInterfaces)
            ? (pending.connectedInterfaces as unknown[]).filter((s): s is string => typeof s === 'string')
            : [],
        }
        : null,
      activationError: typeof body.activationError === 'string' ? body.activationError : null,
    },
  };
}

/**
 * What the hero card has to SAY about the last notify — and nothing else.
 *
 * Three states, all of which would otherwise be silence: a switch the gateway
 * held back (F13), a gateway serving a different project (F6), and a `created`
 * configuration whose binding could not be written back (F4). The last one is
 * the reason this is surfaced at all: without it a file appears in the project
 * that nothing points at and whose origin the operator cannot reconstruct.
 */
export interface ConnectActiveDocumentState {
  pending: (ConnectPendingActivation & { documentId: string | null }) | null;
  /** Set while the confirmation is being sent, so the button can say so. */
  confirming: boolean;
  mismatch: string | null;
  writeBackError: string | null;
}

const _activeDocStore = createStore<ConnectActiveDocumentState>({
  pending: null,
  confirming: false,
  mismatch: null,
  writeBackError: null,
});

export function subscribeActiveDocumentState(listener: () => void): () => void {
  return _activeDocStore.subscribe(listener);
}

export function getActiveDocumentState(): ConnectActiveDocumentState {
  return _activeDocStore.getSnapshot();
}

/** Dismiss whatever the card is currently reporting. */
export function clearActiveDocumentState(): void {
  _activeDocStore.set({ pending: null, confirming: false, mismatch: null, writeBackError: null });
}

/**
 * The identity of what is open — read synchronously, from the same two seams
 * the hero card reads (plan-725 §2.7). Null when nothing is open, which is a
 * legitimate call: it asks for the rescan without naming a document.
 */
function _activeDocumentIdentity(): { projectId: string | null; id: string | null; path: string | null } {
  const snapshot = getProjectStore().getSnapshot();
  const projectId = snapshot.project?.id ?? null;
  const base = getOpenDocumentBase();
  if (!base || base.kind !== 'document') return { projectId, id: null, path: null };
  const doc = snapshot.documents.find(d => d.id === base.documentId)
    ?? (base.path ? snapshot.documents.find(d => d.path === base.path) : undefined);
  return {
    projectId,
    id: typeof doc?.id === 'string' && doc.id !== '' ? doc.id : base.documentId ?? null,
    path: doc?.path ?? base.path ?? null,
  };
}

/**
 * True once this gateway has told us the route is not there.
 *
 * Latched rather than re-probed per write: an older gateway would otherwise
 * collect one 404 per burst for the rest of the session. Cleared on disconnect
 * and on a server-URL change, which is what makes it a latch and not an opt-out.
 */
let _activeDocumentUnsupported = false;

/** Suppresses the notify the `created` write-back would otherwise trigger. */
let _writingBackCreatedRef = false;

const _activeDocumentGuard = createGenerationGuard();

const _activeDocumentDebounce = createTrailingEdgeDebounce<void>(
  ACTIVE_DOCUMENT_DEBOUNCE_MS,
  () => { void _sendActiveDocument({}); },
);

/**
 * May anything go on the wire right now?
 *
 * The `connected` gate is F12's other half: it is what keeps a notify from
 * firing at a gateway that is not there — and it is also what makes the roughly
 * ten existing ProjectStore write-path tests, which run with no gateway and no
 * `fetch` mock, into no-ops instead of real requests against a dead URL.
 */
function _mayNotifyConnect(): boolean {
  if (_activeDocumentUnsupported) return false;
  return _store.getSnapshot().state === 'connected';
}

async function _sendActiveDocument(opts: { force?: boolean }): Promise<void> {
  if (!_mayNotifyConnect()) return;
  const identity = _activeDocumentIdentity();
  const generation = _activeDocumentGuard.next();
  const outcome = await postActiveDocument({ ...identity, force: opts.force ?? false });
  // An answer that a newer notify has already overtaken describes a state that
  // is no longer the one on disk — applying it would undo the newer one.
  if (!_activeDocumentGuard.isCurrent(generation)) return;

  if (outcome.kind === 'unsupported') {
    _activeDocumentUnsupported = true;
    return;
  }
  if (outcome.kind === 'error') {
    console.info('[connect] active-document notify did not reach the gateway:', outcome.message);
    return;
  }
  if (outcome.kind === 'mismatch') {
    _activeDocStore.set({ pending: null, confirming: false, mismatch: outcome.message });
    return;
  }

  const result = outcome.result;
  _activeDocStore.set({
    mismatch: null,
    confirming: false,
    pending: result.pending ? { ...result.pending, documentId: identity.id } : null,
  });
  if (result.activeProfile !== undefined) {
    _store.set({ activeProfile: result.activeProfile });
  }
  if (result.activationError) {
    console.warn(
      `[connect] the configuration bound to the open document was not activated: ${result.activationError}`);
  }
  if (result.created) await _writeBackCreatedRef(identity.id, result.created);
}

/**
 * Answer a `created` by writing `documents[].connectRef` — CONNECT may not
 * write `project.json` itself (plan-718 F1/R1, plan-725 §2.6).
 *
 * A failure here is REPORTED, never swallowed: the file exists on disk and
 * nothing points at it, and an operator who is not told has no way to tell that
 * configuration apart from one they created by hand and forgot to bind.
 */
async function _writeBackCreatedRef(documentId: string | null, created: string): Promise<void> {
  if (!documentId) {
    _activeDocStore.set({
      writeBackError:
        `CONNECT created "${created}", but no open document could take the binding — bind it by hand.`,
    });
    return;
  }
  _writingBackCreatedRef = true;
  try {
    await getProjectStore().setDocumentConnectRef(documentId, created);
    _activeDocStore.set({ writeBackError: null });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    _activeDocStore.set({
      writeBackError: `CONNECT created "${created}", but the binding could not be saved: ${why}`,
    });
  } finally {
    _writingBackCreatedRef = false;
  }
}

/**
 * The callback the project store calls after a config-bearing write.
 *
 * Debounced on the TRAILING edge on purpose: the point is to describe the state
 * a burst of writes left behind, and a leading call would describe the state
 * before the last one landed.
 */
function _onProjectChanged(): void {
  // The write-back of a `created` ref is itself a manifest write; without this
  // the answer to a notify would schedule the next one, forever one round-trip
  // behind. CONNECT already knows about that file — it made it.
  if (_writingBackCreatedRef) return;
  if (!_mayNotifyConnect()) return;
  _activeDocumentDebounce.schedule(undefined);
}

/**
 * Push a pending notify out before the page goes away (F10).
 *
 * `sendBeacon` rather than a `fetch`, because it is the only transport the
 * browser promises to finish after the document is gone. It cannot carry the
 * `X-API-Key` header — which is exactly why this is a best-effort flush of
 * something already scheduled and never the normal path: on a loopback gateway
 * the peer rule admits it, and anywhere else the worst case is the state the
 * missing notify would have left anyway.
 *
 * `pagehide` and `visibilitychange`, explicitly NOT `beforeunload`/`unload` —
 * those two are unreliable on mobile and are the documented wrong choice (MDN).
 */
function _flushActiveDocumentOnHide(): void {
  if (!_activeDocumentDebounce.hasPending()) return;
  _activeDocumentDebounce.cancel();
  if (!_mayNotifyConnect()) return;
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') return;
  const identity = _activeDocumentIdentity();
  try {
    navigator.sendBeacon(
      `${_store.getSnapshot().serverUrl}${ACTIVE_DOCUMENT_ROUTE}`,
      new Blob([JSON.stringify({ ...identity, force: false })], { type: 'application/json' }),
    );
  } catch {
    // A refused beacon costs a rescan the next notify will do anyway.
  }
}

const _onPageHide = (): void => { _flushActiveDocumentOnHide(); };
const _onVisibilityChange = (): void => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    _flushActiveDocumentOnHide();
  }
};

let _notifierInstalled = false;
let _unsubscribeDocumentView: (() => void) | null = null;

/**
 * The open document changed — the second trigger beside the write paths (F2).
 *
 * Debounced through the same window rather than sent at once: opening a
 * document republishes this seam several times (the base, then the view), and
 * a burst of identical notifications is what the trailing edge is for.
 */
function _onOpenDocumentChanged(): void {
  if (!_mayNotifyConnect()) return;
  _activeDocumentDebounce.schedule(undefined);
}

/**
 * Wire the project store's change notifier to this gateway — the HMI half of
 * the dependency inversion in `project-store.setProjectChangeNotifier`.
 *
 * Called from the CONNECT plugin's `init()`, which is where both halves are
 * already known. Idempotent, and returns its own undo.
 */
export function installConnectActiveDocumentNotifier(): () => void {
  if (!_notifierInstalled) {
    getProjectStore().setProjectChangeNotifier(_onProjectChanged);
    _unsubscribeDocumentView = subscribeActiveDocumentView(_onOpenDocumentChanged);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', _onPageHide);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', _onVisibilityChange);
    }
    _notifierInstalled = true;
  }
  return uninstallConnectActiveDocumentNotifier;
}

export function uninstallConnectActiveDocumentNotifier(): void {
  if (!_notifierInstalled) return;
  getProjectStore().setProjectChangeNotifier(null);
  _unsubscribeDocumentView?.();
  _unsubscribeDocumentView = null;
  if (typeof window !== 'undefined') window.removeEventListener('pagehide', _onPageHide);
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _onVisibilityChange);
  }
  _activeDocumentDebounce.cancel();
  _notifierInstalled = false;
}

/** Repeat the held-back switch with `force: true` — the hero card's confirm (F13). */
export async function confirmPendingActivation(): Promise<void> {
  if (!_activeDocStore.getSnapshot().pending) return;
  _activeDocStore.set({ confirming: true });
  _activeDocumentDebounce.cancel();
  await _sendActiveDocument({ force: true });
  _activeDocStore.set({ confirming: false });
}

// ── Test Helpers ───────────────────────────────────────────────────────

/** @internal Reset store state (for testing only). */
export function _resetConnectStore(): void {
  _activeDocumentUnsupported = false;
  _writingBackCreatedRef = false;
  _activeDocumentGuard.invalidate();
  _activeDocumentDebounce.cancel();
  clearActiveDocumentState();
  _statusFailCount = 0;
  hasFetchedConnectThisSession = false;
  connectNewsFetchInFlight = false;
  _store.set({
    serverUrl: defaultGatewayUrl(),
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    gatewayUnreachable: false,
    lastStatusUpdate: 0,
    interfaces: [],
    interfaceStatus: {},
    activeProfile: null,
    activeProfileModel: null,
    availableTypes: null,
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
    updateSupported: false,
    updateReason: null,
    revealSupported: false,
  });
}
