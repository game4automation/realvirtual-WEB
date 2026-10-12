// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FmuProvisioningPlugin — runs the scene's `Fmu` instances in realvirtual
 * CONNECT (plan-498 Phase 3, F9/F10).
 *
 * An FMU is native code; the browser never executes it. When — and only when —
 * the viewer's live transport is CONNECT, this plugin brings every `Fmu`
 * instance up there:
 *
 *   GET /fmu/{sha} ─404→ POST /fmu (upload, once per SHA and gateway)
 *     ─trusted=false→ state `needs-trust` + consent dialog → POST /fmu/{sha}/trust
 *     ─trusted=true→ (auto-start, no dialog)
 *   POST /fmu/instances {instanceKey, signals = the REGISTERED wire names of the
 *     instance's children, allowWebToPlc = AllowViewerToFmu, stepSize, tolerance}
 *     → state `starting` → `GET /status` mirrored → `running` / `error`
 *   lease renewed every 20 s; released on instance dispose, placement removal,
 *   "Stop" and plugin dispose. The viewer never deletes an interface itself —
 *   CONNECT removes it when the LAST lease is gone, so a second tab keeps it.
 *
 * "The transport is CONNECT" means: an interface is CONNECTED and the origin of
 * the target it actually reached equals the (normalised) origin of the CONNECT
 * gateway URL of `connect-store`. Two places can hold that interface — the
 * InterfaceManager's active one (`getActiveEndpoint()`) and the CONNECT
 * plugin's own value stream (`streamEndpoint`), which is what the CONNECT panel
 * connects. An active InterfaceManager interface pointing ANYWHERE else (Unity
 * live) wins: nothing is provisioned, the instances show `standalone`. While a
 * connection is still `connecting` the plugin waits (`idle`). A host or
 * transport change aborts every request in flight; a host change also releases
 * the leases held at the old gateway.
 *
 * Instances come from the module-wide list of `rv-fmu.ts` (main model,
 * placements at any depth, the editor) — `layout-content-added/-removed` only
 * trigger a reconcile, `model-loaded` is never relied on (placements bypass it).
 *
 * Start values and restarts (plan-502):
 *  - every `createInstance` carries the COMPLETE map of applied start-value
 *    overrides (`RVFmu.startOverrides`); CONNECT applies them at initialisation.
 *    The viewer never writes a start value into a running FMU itself.
 *  - `overrides-changed` (from `RVFmu.reapplyConfig`, i.e. every edit, Undo,
 *    Redo, draft replay) re-sends the current map: CONNECT restarts the worker
 *    when a fixed parameter changed, and updates in place otherwise. A request
 *    generation per entry discards answers that a newer map overtook.
 *    A restart is proven by `startGeneration + 1` in `/status`; until then the
 *    instance shows `starting` ("Neustart läuft").
 *  - `Restart` control signal: a rising edge restarts the instance and puts the
 *    signal back to false; `simulation-reset` with `RestartOnReset` does the
 *    same. The restart is ONE gateway call on this tab's lease
 *    (`POST /fmu/leases/{id}/restart`): no lease is released, so a second tab
 *    on the same instance no longer turns it into a silent no-op, and CONNECT
 *    debounces it for 1 s after a start (two edges falling together restart
 *    once). A gateway older than that route falls back to release (awaited) +
 *    provision again. Storm guard: no restart while `starting` and within
 *    {@link FMU_RESTART_GUARD_MS} after `running`. A restart is over when
 *    `/status` reports a start generation OTHER than the one it started from
 *    (a gateway restart resets the counter) — or after
 *    {@link FMU_RESTART_TIMEOUT_MS}, so a lost generation never blocks the
 *    next edge for good.
 *
 * No per-frame work: two timers (lease renew 20 s, status 2 s) run only while
 * this tab holds a lease.
 */

import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { InterfaceManager } from '../interfaces/interface-manager';
import { normalizeEndpointOrigin } from '../interfaces/interface-manager';
import {
  getFmuInstances,
  setFmuDocumentIdProvider,
  subscribeFmuInstances,
  subscribeFmuOverridesChanged,
  subscribeFmuRestartRequests,
  type FmuOverridesChange,
  type RVFmu,
} from '../core/engine/rv-fmu';
import { binaryResources } from '../core/engine/rv-binary-resources';
import {
  connectFmuApi,
  ConnectFmuError,
  isAbortError,
  type ConnectFmuApi,
  type ConnectFmuCallOptions,
  type ConnectFmuInstanceRequest,
  type ConnectFmuPackage,
  type ConnectFmuSignalRequest,
  type ConnectFmuWorkerStatus,
  type FmuRestartCause,
} from '../core/hmi/connect-fmu';
import { getConnectSnapshot, subscribeConnectStore } from '../core/hmi/connect-store';
import { requestFmuTrust, type FmuTrustRequest } from '../core/hmi/fmu-trust-store';
import { FmuTrustDialog } from '../core/hmi/FmuTrustDialog';
import { getOpenDocumentBase } from '../core/editor/active-asset-store';
import { getProjectStore } from '../core/project/project-store';
import { getSceneStore } from '../core/hmi/scene/scene-store-singleton';

// ─── Constants ──────────────────────────────────────────────────────────

/** Lease renew period (CONNECT's TTL is 60 s — three chances per TTL). */
export const FMU_LEASE_RENEW_MS = 20_000;
/** `/status` poll period while a lease is held. */
export const FMU_STATUS_POLL_MS = 2_000;
/** plan-502 — no restart within this time after the instance reached `running` (storm guard). */
export const FMU_RESTART_GUARD_MS = 1_000;
/** plan-502 — give up waiting for the next start generation after this long (never block restarts for good). */
export const FMU_RESTART_TIMEOUT_MS = 15_000;
/**
 * plan-502 — `/status` cadence WHILE a restart waits for its generation. The 2 s
 * poll left a restarted instance "starting" for up to 2 s, and a sequence with a
 * 2 s period then lost every other edge to the storm guard.
 */
export const FMU_RESTART_POLL_MS = 250;

const RESTART_REQUIRED = 'Restart required';

// ─── Seams ──────────────────────────────────────────────────────────────

/** Everything the plugin talks to — injectable for tests. */
export interface FmuProvisioningDeps {
  api?: ConnectFmuApi;
  /** CONNECT gateway URL (default: the CONNECT panel's `serverUrl`). */
  gatewayUrl?: () => string;
  /** Change feed of the gateway URL / panel state (default: `subscribeConnectStore`). */
  subscribeGateway?: (listener: () => void) => () => void;
  /** Ask the person (default: the modal consent dialog). */
  confirmTrust?: (request: FmuTrustRequest, signal: AbortSignal) => Promise<boolean>;
  /** Document id of `RVFmu.instanceKey` (default: {@link fmuDocumentIdOf}). */
  documentId?: (viewer: RVViewer) => string;
  renewIntervalMs?: number;
  statusIntervalMs?: number;
  /** Clock of the restart storm guard (default `Date.now`). */
  now?: () => number;
}

/** What {@link FmuProvisioningPlugin} decided the live transport is. */
export type FmuTransport =
  | { kind: 'connect'; origin: string; baseUrl: string }
  | { kind: 'waiting' }
  | { kind: 'standalone'; reason: 'none' | 'other' };

/** The CONNECT plugin's value stream, as far as this plugin reads it. */
interface ConnectStreamLike {
  readonly streamEndpoint?: URL | null;
  readonly streamConnectionState?: string;
  rediscoverStream?(): Promise<unknown>;
}

/** Whatever carries the live signals — asked to re-read CONNECT's signal list. */
interface SignalCarrier {
  rediscover(): Promise<unknown>;
}

/** Where {@link fmuDocumentIdOf} reads the open document from (injectable for tests). */
export interface FmuDocumentSources {
  /** Scene store present? Then its answer is authoritative, `null` included. */
  readonly sceneStore: { readonly openDocumentId: string | null } | null;
  /** The cross-mode handle — consulted only when no scene store exists. */
  openDocumentBase(): { kind: string; documentId?: string } | null;
  projectId(): string | null;
}

const defaultDocumentSources: FmuDocumentSources = {
  get sceneStore() { return getSceneStore(); },
  openDocumentBase: () => getOpenDocumentBase(),
  projectId: () => getProjectStore().getSnapshot().project?.id ?? null,
};

/**
 * The document part of every instance key: the open project document
 * (`<projectId>/<documentId>`), else the loaded model URL, else `'document'`.
 * Reload-stable for one document — that is what makes CONNECT's find-or-create
 * land on the same interface after a reload.
 *
 * Read from the scene store's workspace, NOT from `getOpenDocumentBase()`: an
 * `RVFmu` reads this once, during `init()`, i.e. INSIDE the load — and the
 * store binds the workspace to its manifest row BEFORE the load, while the
 * cross-mode handle is published only AFTER it. Reading the handle gave every
 * instance the id of the PREVIOUS document (live acceptance 2026-09-26: the
 * FMU demo opened from the demo HMI document asked for
 * `prj_sample/doc_demorealvirtualweb_7l7hfw`). The handle is only a fallback
 * for a viewer without a scene store (embeds, tests).
 */
export function fmuDocumentIdOf(
  viewer: { currentModelUrl?: string | null } | null,
  sources: FmuDocumentSources = defaultDocumentSources,
): string {
  try {
    const store = sources.sceneStore;
    const documentId = store
      ? store.openDocumentId
      : (() => {
        const base = sources.openDocumentBase();
        return base && base.kind === 'document' && base.documentId ? base.documentId : null;
      })();
    if (documentId) {
      const project = sources.projectId();
      return project ? `${project}/${documentId}` : documentId;
    }
  } catch {
    // Stores not booted (tests, embeds) — fall through.
  }
  const url = viewer?.currentModelUrl;
  if (url) return url.replace(/[?#].*$/, '');
  return 'document';
}

function originOf(url: string): string | null {
  try {
    return normalizeEndpointOrigin(new URL(url)).origin;
  } catch {
    return null;
  }
}

/** `PLCInputFloat` → `{ dataType: 'Real', direction: 'input' }` (CONNECT's canonical names). */
export function fmuSignalRequestOf(entry: { name: string; valueReference: number; plcType: string }): ConnectFmuSignalRequest {
  const direction = entry.plcType.startsWith('PLCInput') ? 'input' : 'output';
  const dataType = entry.plcType.endsWith('Bool') ? 'Boolean' : entry.plcType.endsWith('Int') ? 'Integer' : 'Real';
  return { name: entry.name, valueReference: entry.valueReference, dataType, direction };
}

/**
 * Where the viewer's variable list disagrees with CONNECT's parse; null when
 * they agree on every signal the viewer created and on every variable CONNECT
 * would map.
 */
export function describeFmuMetadataDrift(fmu: RVFmu, pkg: ConnectFmuPackage): string | null {
  const issues: string[] = [];
  const remote = pkg.variables ?? [];
  for (const s of fmu.signals) {
    const want = fmuSignalRequestOf(s);
    // FMI 2.0 value references are unique per TYPE only — the name decides.
    const v = remote.find((r) => r.name === s.variable)
      ?? remote.find((r) => r.valueReference === s.valueReference && r.type === fmu.variables.find((x) => x.name === s.variable)?.type);
    if (!v) { issues.push(`${s.variable} (vr ${s.valueReference}) is not in CONNECT's parse`); continue; }
    if (v.name !== s.variable) issues.push(`vr ${s.valueReference} is "${v.name}" in CONNECT, "${s.variable}" in the viewer`);
    if (!v.supported) { issues.push(`${s.variable}: ${v.unsupportedReason ?? 'not mapped by CONNECT'}`); continue; }
    if (v.dataType && v.dataType !== want.dataType) issues.push(`${s.variable}: ${v.dataType} in CONNECT, ${want.dataType} in the viewer`);
    if (v.direction && v.direction !== want.direction) issues.push(`${s.variable}: ${v.direction} in CONNECT, ${want.direction} in the viewer`);
  }
  for (const v of remote) {
    if (!v.supported) continue;
    if (!fmu.signals.some((s) => s.variable === v.name)) {
      issues.push(`${v.name} (vr ${v.valueReference}) has no signal in the viewer`);
    }
  }
  return issues.length > 0 ? `${issues.join('; ')}.` : null;
}

/** `/status` worker state → FMU state (+ error text). */
export function fmuStateOfWorker(st: ConnectFmuWorkerStatus | undefined): { state: RVFmu['state']; error?: string } {
  if (!st) return { state: 'starting' };
  const status = st.status.toLowerCase();
  const error = st.error ?? undefined;
  if (status === 'connected') return { state: 'running' };
  if (error && /restart|one instance per process/i.test(error)) {
    return { state: 'error', error: `${RESTART_REQUIRED} — ${error}` };
  }
  if (status === 'error' || status === 'signallimitexceeded') {
    return { state: 'error', error: error ?? `CONNECT reports the FMU worker as ${st.status}.` };
  }
  if (status === 'stopped' || status === 'disabled') {
    return error ? { state: 'error', error } : { state: 'idle', error: 'The FMU worker is stopped in CONNECT.' };
  }
  return { state: 'starting', error };
}

// ─── Plugin ─────────────────────────────────────────────────────────────

type Phase = 'provisioning' | 'needs-trust' | 'leased' | 'failed';

interface Entry {
  fmu: RVFmu;
  /** Instance key at provisioning time (what CONNECT knows the interface by). */
  key: string;
  origin: string;
  baseUrl: string;
  abort: AbortController;
  phase: Phase;
  leaseId?: string;
  interfaceId?: string;
  /** A failure a later tick may retry (network, 5xx, busy) — never a refusal. */
  retryable?: boolean;
  /** plan-502 — bumped on every `overrides-changed`; an answer to an older generation is discarded. */
  requestGen: number;
  /** plan-502 — the generation CONNECT last acknowledged with a lease. */
  sentGen: number;
  /** plan-502 — an override sync (`createInstance` again) is in flight. */
  syncing?: boolean;
  /** plan-502 — a `POST /fmu/leases/{id}/restart` is in flight. */
  restarting?: boolean;
}

let _active: FmuProvisioningPlugin | null = null;

/** The registered provisioning plugin (inspector actions), or null. */
export function getFmuProvisioning(): FmuProvisioningPlugin | null {
  return _active;
}

export class FmuProvisioningPlugin implements RVViewerPlugin {
  readonly id = 'fmu-provisioning';
  readonly core = true;
  readonly order = 60;

  readonly slots: UISlotEntry[] = [
    // The consent dialog: mounted once, renders only while a question is open.
    { slot: 'overlay', component: FmuTrustDialog, order: 97 },
  ];

  private readonly api: ConnectFmuApi;
  private readonly gatewayUrl: () => string;
  private readonly subscribeGateway: (listener: () => void) => () => void;
  private readonly confirmTrust: (request: FmuTrustRequest, signal: AbortSignal) => Promise<boolean>;
  private readonly documentId: (viewer: RVViewer) => string;
  private readonly renewMs: number;
  private readonly statusMs: number;
  private readonly now: () => number;
  /** plan-502 — the `Restart` control-signal subscription per instance. */
  private readonly restartSubs = new Map<RVFmu, () => void>();
  /** plan-502 — a lease release a restart must see completed before `createInstance`. */
  private readonly pendingRelease = new Map<RVFmu, Promise<void>>();
  /** plan-502 — instances restarted by release + re-create (a found interface = no restart). */
  private readonly restartedByRelease = new WeakSet<RVFmu>();
  /** plan-502 — when the wait for the next start generation began (restart timeout). */
  private readonly restartSince = new Map<RVFmu, number>();

  private viewer: RVViewer | null = null;
  private readonly entries = new Map<RVFmu, Entry>();
  /** Instances the person stopped — not re-provisioned until "Re-provision". */
  private readonly stopped = new WeakSet<RVFmu>();
  /** `<origin>|<sha>` → the package as CONNECT knows it (one GET/upload per SHA and gateway). */
  private readonly packages = new Map<string, Promise<ConnectFmuPackage>>();
  /** `<origin>|<sha>` → a trust grant in flight or done this session. */
  private readonly grants = new Map<string, Promise<void>>();
  private readonly offs: Array<() => void> = [];
  private life = new AbortController();
  /** Aborts the shared per-gateway requests (package GET/upload, trust, status) on a host change. */
  private originCtl = new AbortController();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private statusTimer: ReturnType<typeof setInterval> | null = null;
  private statusInFlight = false;
  private rediscovering = false;
  private rediscoverAgain = false;
  private scheduled = false;
  private lastOrigin: string | null = null;
  private disposed = false;

  constructor(deps: FmuProvisioningDeps = {}) {
    this.api = deps.api ?? connectFmuApi;
    this.gatewayUrl = deps.gatewayUrl ?? (() => getConnectSnapshot().serverUrl);
    this.subscribeGateway = deps.subscribeGateway ?? subscribeConnectStore;
    this.confirmTrust = deps.confirmTrust ?? requestFmuTrust;
    this.documentId = deps.documentId ?? ((viewer) => fmuDocumentIdOf(viewer));
    this.renewMs = deps.renewIntervalMs ?? FMU_LEASE_RENEW_MS;
    this.statusMs = deps.statusIntervalMs ?? FMU_STATUS_POLL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  // ── Lifecycle ──

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.disposed = false;
    this.life = new AbortController();
    this.originCtl = new AbortController();
    _active = this;
    setFmuDocumentIdProvider(() => this.documentId(viewer));
    const on = viewer.on.bind(viewer) as (event: string, cb: (data: unknown) => void) => () => void;
    const again = (): void => this.schedule();
    this.offs.push(
      subscribeFmuInstances(again),
      subscribeFmuOverridesChanged((fmu, change) => this.onOverridesChanged(fmu, change)),
      subscribeFmuRestartRequests((fmu) => { this.requestRestart(fmu, 'reset'); }),
      this.subscribeGateway(again),
      on('layout-content-added', again),
      on('layout-content-removed', (data) => this.onContentRemoved(data)),
      on('interface-connected', again),
      on('interface-disconnected', again),
      on('interface-error', again),
      on('connection-state-changed', again),
    );
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) {
      try { off(); } catch { /* already gone */ }
    }
    for (const e of [...this.entries.values()]) this.drop(e, true);
    for (const off of this.restartSubs.values()) off();
    this.restartSubs.clear();
    this.pendingRelease.clear();
    this.restartSince.clear();
    this.life.abort();
    this.originCtl.abort();
    this.stopTimers();
    this.packages.clear();
    this.grants.clear();
    setFmuDocumentIdProvider(null);
    if (_active === this) _active = null;
    this.viewer = null;
  }

  // ── Public (inspector actions, MCP, tests) ──

  /** What the plugin currently considers the live transport. */
  transport(): FmuTransport {
    return this.resolveTransport().transport;
  }

  /** The transport plus, when it is CONNECT, the interface that carries its signals. */
  private resolveTransport(): { transport: FmuTransport; carrier: SignalCarrier | null } {
    const viewer = this.viewer;
    if (!viewer) return { transport: { kind: 'standalone', reason: 'none' }, carrier: null };
    const gatewayOrigin = originOf(this.gatewayUrl());
    const baseUrl = this.gatewayUrl().replace(/\/+$/, '');
    const connect = (origin: string, carrier: SignalCarrier | null) => (gatewayOrigin && origin === gatewayOrigin
      ? { transport: { kind: 'connect', origin, baseUrl } as FmuTransport, carrier }
      : { transport: { kind: 'standalone', reason: 'other' } as FmuTransport, carrier: null });

    const manager = viewer.getPlugin<InterfaceManager & RVViewerPlugin>('interface-manager');
    const active = manager?.getActive?.() ?? null;
    if (manager && active) {
      const endpoint = manager.getActiveEndpoint();
      if (endpoint) {
        const carrier = typeof (active as Partial<SignalCarrier>).rediscover === 'function'
          ? { rediscover: () => (active as unknown as SignalCarrier).rediscover() }
          : null;
        return connect(endpoint.origin, carrier);
      }
      if (active.connectionState === 'connecting') return { transport: { kind: 'waiting' }, carrier: null };
    }
    const stream = viewer.getPlugin<ConnectStreamLike & RVViewerPlugin>('connect');
    const streamEndpoint = stream?.streamEndpoint ?? null;
    if (streamEndpoint) {
      const carrier = stream && typeof stream.rediscoverStream === 'function'
        ? { rediscover: () => stream.rediscoverStream!() }
        : null;
      return connect(normalizeEndpointOrigin(streamEndpoint).origin, carrier);
    }
    if (stream?.streamConnectionState === 'connecting') return { transport: { kind: 'waiting' }, carrier: null };
    return { transport: { kind: 'standalone', reason: 'none' }, carrier: null };
  }

  /**
   * A new FMU interface adds signals to CONNECT AFTER the value stream was
   * opened; the stream only receives and sends what its discovery saw. So when
   * an instance comes up, the carrier re-reads CONNECT's signal list (the
   * `rediscover()` of the interface: import request → subscribe) — once per
   * batch, never overlapping.
   */
  private requestRediscover(): void {
    if (this.rediscovering) { this.rediscoverAgain = true; return; }
    const carrier = this.resolveTransport().carrier;
    if (!carrier) return;
    this.rediscovering = true;
    carrier.rediscover()
      .catch((err) => console.warn('[fmu-provisioning] signal rediscovery failed:', err))
      .finally(() => {
        this.rediscovering = false;
        if (this.rediscoverAgain && !this.disposed) {
          this.rediscoverAgain = false;
          this.requestRediscover();
        }
      });
  }

  /** The lease this tab holds for an instance (undefined = none). */
  leaseOf(fmu: RVFmu): string | undefined {
    return this.entries.get(fmu)?.leaseId;
  }

  /** "Trust & start" — ask again (dialog) and start. */
  trustAndStart(fmu: RVFmu): void {
    this.restart(fmu, false);
  }

  /** "Re-provision" — release this tab's lease, forget cached package state, provision again. */
  reprovision(fmu: RVFmu): void {
    this.restart(fmu, true);
  }

  /** "Stop" — release this tab's lease; the instance stays `idle` until Re-provision. */
  stop(fmu: RVFmu): void {
    this.stopped.add(fmu);
    const e = this.entries.get(fmu);
    if (e) this.drop(e, true);
    fmu.setState('idle', 'Stopped — use Re-provision to start the FMU in CONNECT again.');
    this.schedule();
  }

  /**
   * Restart a RUNNING instance so the FMU starts again from its (overridden)
   * start values — the `Restart` signal edge and `simulation-reset` land here.
   * One `POST /fmu/leases/{id}/restart` on this tab's lease: CONNECT rebuilds
   * the worker from the current configuration and keeps every lease (other
   * tabs included); within 1 s after a start it answers `restarted: false`
   * (debounced). The new start is proven by a start generation other than the
   * one the restart began from. Returns false when nothing was requested: no
   * leased entry, not `running`, a restart still under way, or within
   * {@link FMU_RESTART_GUARD_MS} after `running` (storm guard).
   */
  requestRestart(fmu: RVFmu, cause: FmuRestartCause = 'signal'): boolean {
    const e = this.entries.get(fmu);
    if (!e || e.phase !== 'leased' || !e.leaseId) return false;
    // A wait that outlived the timeout (e.g. `/status` failing throughout) never blocks the next edge.
    if (fmu.expectedGeneration !== undefined && this.restartTimedOut(fmu)) this.clearExpected(fmu);
    if (fmu.state !== 'running' || fmu.expectedGeneration !== undefined || e.restarting) return false;
    if (fmu.runningSince !== undefined && this.now() - fmu.runningSince < FMU_RESTART_GUARD_MS) return false;
    if (!this.api.restartInstance) {
      this.restartByRelease(e);
      return true;
    }
    e.restarting = true;
    this.expectRestart(fmu, fmu.startGeneration);
    fmu.setState('starting');
    void this.restartViaGateway(e, cause);
    return true;
  }

  /** Wait for the start generation after `base` (undefined = a gateway without generations). */
  private expectRestart(fmu: RVFmu, base: number | undefined): void {
    fmu.expectedGeneration = base !== undefined ? base + 1 : undefined;
    this.restartSince.set(fmu, this.now());
  }

  private restartTimedOut(fmu: RVFmu): boolean {
    const since = this.restartSince.get(fmu);
    return since !== undefined && this.now() - since > FMU_RESTART_TIMEOUT_MS;
  }

  private clearExpected(fmu: RVFmu): void {
    fmu.expectedGeneration = undefined;
    this.restartSince.delete(fmu);
  }

  /** `POST /fmu/leases/{id}/restart`; a gateway without the route falls back to release + re-create. */
  private async restartViaGateway(e: Entry, cause: FmuRestartCause): Promise<void> {
    const { fmu } = e;
    try {
      const result = await this.api.restartInstance!(e.leaseId!, { baseUrl: e.baseUrl, signal: e.abort.signal }, cause);
      if (!this.live(e)) return;
      if (!result.restarted) {
        // Not restarted — 'debounced' (it (re)started < 1 s ago: another tab's
        // edge, or a reset racing the LogicStep) or 'other-lease' (another tab's
        // loop leads the restarts of this shared instance). The worker kept
        // running: nothing to wait for, and no "starting" flicker every period.
        this.clearExpected(fmu);
        if (fmu.state === 'starting') fmu.setState('running', fmu.lastError);
      } else {
        if (typeof result.startGeneration === 'number') this.expectRestart(fmu, result.startGeneration);
        void this.confirmRestart(e);
      }
    } catch (err) {
      if (isAbortError(err) || !this.live(e)) return;
      if (err instanceof ConnectFmuError && err.isNotFound && err.code !== 'lease-unknown') {
        // A gateway older than the restart route.
        e.restarting = false;
        this.restartByRelease(e);
        return;
      }
      this.clearExpected(fmu);
      if (err instanceof ConnectFmuError && err.isNotFound) {
        // The lease is gone (expired, reaped): provision again.
        this.drop(e, false);
        this.schedule();
        return;
      }
      console.warn(`[fmu-provisioning] ${fmu.node.name}: restart failed:`, err);
    } finally {
      e.restarting = false;
    }
    void this.pollStatus();
  }

  /** Poll `/status` every {@link FMU_RESTART_POLL_MS} until the new generation is seen (or the wait ends). */
  private async confirmRestart(e: Entry): Promise<void> {
    const { fmu } = e;
    while (this.live(e) && fmu.expectedGeneration !== undefined && !this.disposed && !this.restartTimedOut(fmu)) {
      await new Promise((r) => setTimeout(r, FMU_RESTART_POLL_MS));
      if (!this.live(e) || fmu.expectedGeneration === undefined) return;
      await this.pollStatus();
    }
  }

  /**
   * The pre-route restart: release this tab's lease (awaited before the next
   * `createInstance`, so CONNECT really drops the interface) and provision
   * again. Only restarts when no other tab holds a lease on the interface.
   */
  private restartByRelease(e: Entry): void {
    const { fmu } = e;
    this.expectRestart(fmu, fmu.startGeneration);
    const leaseId = e.leaseId!;
    this.drop(e, false);
    const release = this.api.releaseLease(leaseId, { baseUrl: e.baseUrl })
      .catch((err) => { console.warn(`[fmu-provisioning] lease ${leaseId} not released for the restart:`, err); });
    this.pendingRelease.set(fmu, release);
    this.restartedByRelease.add(fmu);
    fmu.setState('starting');
    this.schedule();
  }

  /** Run one reconcile now (tests; production goes through {@link schedule}). */
  reconcileNow(): void {
    this.scheduled = false;
    this.reconcile();
  }

  // ── Reconcile ──

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      if (!this.scheduled) return;
      this.scheduled = false;
      this.reconcile();
    });
  }

  private reconcile(): void {
    if (this.disposed || !this.viewer) return;
    const transport = this.transport();
    const origin = transport.kind === 'connect' ? transport.origin : null;
    if (origin !== this.lastOrigin) {
      // Another gateway (or none): cached package/trust answers belong to the old one.
      this.packages.clear();
      this.grants.clear();
      this.originCtl.abort();
      this.originCtl = new AbortController();
      this.lastOrigin = origin;
    }

    const live = new Set(getFmuInstances());
    for (const [fmu, e] of [...this.entries]) {
      if (!live.has(fmu)) this.drop(e, true);
    }
    this.syncRestartSignals(live);

    for (const fmu of live) {
      if (!fmu.embed || !fmu.hasPackage) continue; // `unsupported` belongs to the component
      let e = this.entries.get(fmu);
      if (transport.kind !== 'connect') {
        // Transport gone or not CONNECT: abort, keep no entry. A lease stays at
        // the gateway until its TTL — a WS reconnect within 60 s finds the same
        // interface still running (find-or-create), a real departure lets it lapse.
        if (e) this.drop(e, false);
        const target = transport.kind === 'waiting' ? 'idle' : 'standalone';
        if (fmu.state !== target) fmu.setState(target);
        continue;
      }
      if (e && e.origin !== transport.origin) {
        // Host change: the old gateway's lease is released there.
        this.drop(e, true);
        e = undefined;
      }
      if (e) continue;
      if (this.stopped.has(fmu)) {
        if (fmu.state !== 'idle') fmu.setState('idle', 'Stopped — use Re-provision to start the FMU in CONNECT again.');
        continue;
      }
      this.start(fmu, transport);
    }
    this.syncTimers();
  }

  /** Keep one `Restart` control-signal subscription per live instance. */
  private syncRestartSignals(live: ReadonlySet<RVFmu>): void {
    for (const [fmu, off] of [...this.restartSubs]) {
      if (!live.has(fmu) || !fmu.restartSignalName) { off(); this.restartSubs.delete(fmu); }
    }
    for (const fmu of live) {
      if (this.restartSubs.has(fmu) || !fmu.restartSignalName) continue;
      this.restartSubs.set(fmu, fmu.subscribeRestartSignal((value) => {
        if (!value) return;
        // Consume the edge: back to false (after the current dispatch), so the
        // next `true` — e.g. the next LogicStep loop — is an edge again.
        queueMicrotask(() => fmu.resetRestartSignal());
        this.requestRestart(fmu);
      }));
    }
  }

  /**
   * `overrides-changed`: send the CURRENT map again (CONNECT decides restart vs.
   * in-place). A fixed-parameter change expects the next `startGeneration`.
   */
  private onOverridesChanged(fmu: RVFmu, change: FmuOverridesChange): void {
    const e = this.entries.get(fmu);
    if (!e || this.disposed) return;
    e.requestGen++;
    if (e.phase === 'failed') {
      // E.g. a refused override (422) the author just fixed: provision again with the new map.
      this.drop(e, false);
      this.schedule();
      return;
    }
    if (e.phase !== 'leased') return; // an in-flight createInstance re-sends; a later start reads the map anyway
    if (change.restartRequired.length > 0) {
      this.expectRestart(fmu, fmu.startGeneration);
      fmu.setState('starting');
    }
    void this.syncOverrides(e);
  }

  /** Re-send `createInstance` until CONNECT acknowledged the newest generation; swap the lease. */
  private async syncOverrides(e: Entry): Promise<void> {
    if (e.syncing) return;
    e.syncing = true;
    const opts: ConnectFmuCallOptions = { baseUrl: e.baseUrl, signal: e.abort.signal };
    try {
      while (this.live(e) && e.phase === 'leased' && e.sentGen !== e.requestGen) {
        const gen = e.requestGen;
        const result = await this.api.createInstance(this.instanceRequestOf(e), opts);
        if (!this.live(e)) {
          this.api.releaseLease(result.leaseId, { baseUrl: e.baseUrl }).catch(() => { /* TTL covers it */ });
          return;
        }
        if (gen !== e.requestGen) {
          // Overtaken by a newer map (Undo while in flight): drop this answer.
          this.api.releaseLease(result.leaseId, { baseUrl: e.baseUrl }).catch(() => { /* TTL covers it */ });
          continue;
        }
        this.adoptLease(e, result.leaseId, result.interfaceId);
        e.sentGen = gen;
      }
    } catch (err) {
      if (isAbortError(err) || !this.live(e)) return;
      this.fail(e, err);
    } finally {
      e.syncing = false;
    }
  }

  /** Hold `leaseId` and give the previous lease of the entry back (the new one keeps the interface). */
  private adoptLease(e: Entry, leaseId: string, interfaceId: string): void {
    const previous = e.leaseId;
    e.leaseId = leaseId;
    e.interfaceId = interfaceId;
    e.fmu.leaseId = leaseId;
    e.fmu.interfaceId = interfaceId;
    if (previous && previous !== leaseId) {
      this.api.releaseLease(previous, { baseUrl: e.baseUrl }).catch((err) => {
        console.warn(`[fmu-provisioning] lease ${previous} not released:`, err);
      });
    }
  }

  /** The instance request: signals, write permission, step, and the complete override map. */
  private instanceRequestOf(e: Entry): ConnectFmuInstanceRequest {
    const { fmu } = e;
    return {
      instanceKey: e.key,
      sha256: fmu.sha256,
      signals: fmu.signals.map(fmuSignalRequestOf),
      allowWebToPlc: fmu.AllowViewerToFmu !== false,
      stepSize: fmu.StepSize,
      tolerance: fmu.Tolerance,
      startOverrides: { ...fmu.startOverrides },
    };
  }

  private onContentRemoved(data: unknown): void {
    const root = (data as { root?: Object3D } | undefined)?.root;
    if (root) {
      for (const e of [...this.entries.values()]) {
        if (isUnder(e.fmu.node, root)) this.drop(e, true);
      }
    }
    this.schedule();
  }

  private restart(fmu: RVFmu, release: boolean): void {
    this.stopped.delete(fmu);
    const e = this.entries.get(fmu);
    if (e) {
      this.packages.delete(`${e.origin}|${fmu.sha256}`);
      this.grants.delete(`${e.origin}|${fmu.sha256}`);
      this.drop(e, release);
    }
    this.schedule();
  }

  /** Abort an entry and forget it; `release` also gives its lease back (best effort). */
  private drop(e: Entry, release: boolean): void {
    e.abort.abort();
    if (this.entries.get(e.fmu) === e) this.entries.delete(e.fmu);
    if (release && e.leaseId) {
      const leaseId = e.leaseId;
      this.api.releaseLease(leaseId, { baseUrl: e.baseUrl }).catch((err) => {
        console.warn(`[fmu-provisioning] lease ${leaseId} not released:`, err);
      });
    }
    if (e.fmu.leaseId === e.leaseId) {
      e.fmu.leaseId = undefined;
      e.fmu.interfaceId = undefined;
    }
    e.leaseId = undefined;
  }

  // ── Provisioning ──

  private start(fmu: RVFmu, t: Extract<FmuTransport, { kind: 'connect' }>): void {
    const e: Entry = {
      fmu,
      key: fmu.instanceKey,
      origin: t.origin,
      baseUrl: t.baseUrl,
      abort: new AbortController(),
      phase: 'provisioning',
      requestGen: 0,
      sentGen: -1,
    };
    this.entries.set(fmu, e);
    // A restart keeps showing `starting` (not `idle`) until the new generation is up.
    if (!this.pendingRelease.has(fmu)) fmu.setState('idle');
    void this.provision(e);
  }

  private live(e: Entry): boolean {
    return !e.abort.signal.aborted && this.entries.get(e.fmu) === e && !this.disposed;
  }

  private async provision(e: Entry): Promise<void> {
    const { fmu } = e;
    const opts: ConnectFmuCallOptions = { baseUrl: e.baseUrl, signal: e.abort.signal };
    try {
      const pkg = await abortable(this.ensurePackage(e), e.abort.signal);
      if (!this.live(e)) return;
      fmu.setMetadataDrift(describeFmuMetadataDrift(fmu, pkg));

      const grantKey = `${e.origin}|${fmu.sha256}`;
      if (!pkg.trusted && !this.grants.has(grantKey)) {
        e.phase = 'needs-trust';
        fmu.setState('needs-trust', 'Waiting for your consent — an FMU is native code that runs inside CONNECT.');
        const approved = await this.confirmTrust(this.trustRequestOf(fmu, pkg), e.abort.signal);
        if (!this.live(e)) return;
        if (!approved) {
          fmu.setState('needs-trust', 'Not trusted — use “Trust & start” to run it in CONNECT.');
          return;
        }
      }
      if (!pkg.trusted) {
        let grant = this.grants.get(grantKey);
        if (!grant) {
          grant = this.api.trust(fmu.sha256, { baseUrl: e.baseUrl, signal: this.originCtl.signal });
          this.grants.set(grantKey, grant);
          grant.catch(() => { if (this.grants.get(grantKey) === grant) this.grants.delete(grantKey); });
        }
        await abortable(grant, e.abort.signal);
        if (!this.live(e)) return;
      }
      await this.createInstance(e, opts);
    } catch (err) {
      if (isAbortError(err) || !this.live(e)) return;
      this.fail(e, err);
    }
  }

  /** One GET (and at most one upload) per SHA and gateway, shared by every instance. */
  private ensurePackage(e: Entry): Promise<ConnectFmuPackage> {
    const sha = e.fmu.sha256;
    const key = `${e.origin}|${sha}`;
    let pending = this.packages.get(key);
    if (!pending) {
      const opts: ConnectFmuCallOptions = { baseUrl: e.baseUrl, signal: this.originCtl.signal };
      pending = (async () => {
        const found = await this.api.getPackage(sha, opts);
        if (found) return found;
        const resource = binaryResources.get(sha);
        if (!resource) throw new Error('The FMU package bytes are not loaded in this viewer — cannot upload.');
        for (const other of this.entries.values()) {
          if (other.fmu.sha256 === sha && other.origin === e.origin && other.phase === 'provisioning') {
            other.fmu.setState('uploading');
          }
        }
        return this.api.uploadPackage(resource.bytes, sha, e.fmu.embed?.fileName || `${sha}.fmu`, opts);
      })();
      this.packages.set(key, pending);
      const self = pending;
      pending.catch(() => { if (this.packages.get(key) === self) this.packages.delete(key); });
    }
    return pending;
  }

  private trustRequestOf(fmu: RVFmu, pkg: ConnectFmuPackage): FmuTrustRequest {
    return {
      sha256: fmu.sha256,
      modelName: pkg.meta?.modelName || fmu.modelName || fmu.node.name,
      guid: pkg.meta?.guid || fmu.embed?.guid || '',
      generationTool: pkg.meta?.generationTool || fmu.embed?.generationTool || '',
      fileName: fmu.embed?.fileName ?? '',
      byteLength: pkg.meta?.byteLength || fmu.embed?.byteLength || 0,
      sources: [{ nodePath: fmu.nodePath || fmu.node.name, instanceKey: fmu.instanceKey }],
    };
  }

  private async createInstance(e: Entry, opts: ConnectFmuCallOptions): Promise<void> {
    const { fmu } = e;
    e.phase = 'provisioning';
    fmu.setState('starting');
    // A restart released the previous lease: CONNECT must have dropped the
    // interface before the new request, or find-or-create just reuses it.
    const release = this.pendingRelease.get(fmu);
    if (release) {
      await release;
      if (this.pendingRelease.get(fmu) === release) this.pendingRelease.delete(fmu);
      if (!this.live(e)) return;
    }
    let result: Awaited<ReturnType<ConnectFmuApi['createInstance']>>;
    for (;;) {
      const gen = e.requestGen;
      result = await this.api.createInstance(this.instanceRequestOf(e), opts);
      if (!this.live(e)) {
        // Answered after we let go — give the fresh lease straight back.
        this.api.releaseLease(result.leaseId, { baseUrl: e.baseUrl }).catch(() => { /* TTL covers it */ });
        return;
      }
      if (gen === e.requestGen) { e.sentGen = gen; break; }
      // The override map changed while the request was in flight: the newest wins.
      this.api.releaseLease(result.leaseId, { baseUrl: e.baseUrl }).catch(() => { /* TTL covers it */ });
    }
    if (this.restartedByRelease.has(fmu)) {
      this.restartedByRelease.delete(fmu);
      if (!result.created && fmu.expectedGeneration !== undefined) {
        // Another tab still holds the interface: it was not dropped, so it did
        // not restart. Do not wait for a generation that will not come.
        console.warn(`[fmu-provisioning] ${fmu.node.name}: restart skipped — the interface is shared with another lease.`);
        this.clearExpected(fmu);
      }
    }
    e.phase = 'leased';
    this.adoptLease(e, result.leaseId, result.interfaceId);
    fmu.setState('starting');
    this.syncTimers();
    void this.pollStatus();
  }

  private fail(e: Entry, err: unknown): void {
    const { fmu } = e;
    e.phase = 'failed';
    const fe = err instanceof ConnectFmuError ? err : null;
    e.retryable = !fe || fe.status === 0 || fe.status >= 500 || fe.status === 429;
    if (fe?.code === 'fmu-signal-mismatch') {
      const details = Array.isArray(fe.details)
        ? (fe.details as Array<{ name?: string; reason?: string }>).map((d) => `${d.name}: ${d.reason}`).join('; ')
        : fe.message;
      fmu.setMetadataDrift(`CONNECT refused the signal list: ${details}.`);
    }
    let message = (err as Error)?.message ?? String(err);
    if (fe?.code === 'browser-origin-required') {
      message = 'CONNECT refused the trust decision: it must come from realvirtual WEB in a browser (Origin/Host check).';
    }
    if (fe?.code === 'fmu-override-invalid') {
      // plan-502: `details[]{variable, value, reason}` — name every refused override.
      const details = Array.isArray(fe.details)
        ? (fe.details as Array<{ variable?: string; value?: string; reason?: string }>)
          .map((d) => `${d.variable ?? '?'}${d.value !== undefined ? ` = ${d.value}` : ''}: ${d.reason ?? 'invalid'}`).join('; ')
        : '';
      message = `CONNECT refused the start-value overrides — ${details || fe.message}. Fix them in the inspector (FMU › Parameters).`;
      fmu.expectedGeneration = undefined;
    }
    console.warn(`[fmu-provisioning] ${fmu.node.name}: ${message}`);
    fmu.setState('error', message);
  }

  // ── Timers ──

  private syncTimers(): void {
    const leased = [...this.entries.values()].some((e) => e.phase === 'leased');
    const failed = [...this.entries.values()].some((e) => e.phase === 'failed' && e.retryable);
    if ((leased || failed) && !this.disposed) {
      if (!this.renewTimer) this.renewTimer = setInterval(() => { void this.renewAll(); }, this.renewMs);
      if (leased && !this.statusTimer) this.statusTimer = setInterval(() => { void this.pollStatus(); }, this.statusMs);
      if (!leased && this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
    } else {
      this.stopTimers();
    }
  }

  private stopTimers(): void {
    if (this.renewTimer) { clearInterval(this.renewTimer); this.renewTimer = null; }
    if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
  }

  /** Renew every lease this tab holds; retry retryable failures. Exposed for tests. */
  async renewAll(): Promise<void> {
    for (const e of [...this.entries.values()]) {
      if (e.phase === 'failed' && e.retryable) {
        this.drop(e, false);
        continue;
      }
      if (e.phase !== 'leased' || !e.leaseId) continue;
      try {
        await this.api.renewLease(e.leaseId, { baseUrl: e.baseUrl, signal: e.abort.signal });
      } catch (err) {
        if (isAbortError(err) || !this.live(e)) continue;
        if (err instanceof ConnectFmuError && err.isNotFound) {
          // Expired or reaped (gateway restart, a long sleep): provision again —
          // CONNECT's find-or-create hands out the same interface id.
          this.drop(e, false);
          continue;
        }
        console.warn(`[fmu-provisioning] lease renew failed for ${e.fmu.node.name}:`, err);
      }
    }
    this.schedule();
  }

  /** Mirror `GET /status` into the leased instances. Exposed for tests. */
  async pollStatus(): Promise<void> {
    if (this.statusInFlight || this.disposed) return;
    const leased = [...this.entries.values()].filter((e) => e.phase === 'leased' && e.interfaceId);
    if (leased.length === 0) return;
    this.statusInFlight = true;
    try {
      const byBase = new Map<string, Entry[]>();
      for (const e of leased) byBase.set(e.baseUrl, [...(byBase.get(e.baseUrl) ?? []), e]);
      for (const [baseUrl, group] of byBase) {
        let statuses: Record<string, ConnectFmuWorkerStatus>;
        try {
          statuses = await this.api.fetchWorkerStatuses({ baseUrl, signal: this.originCtl.signal });
        } catch (err) {
          if (!isAbortError(err)) console.warn('[fmu-provisioning] /status failed:', err);
          continue;
        }
        let cameUp = false;
        for (const e of group) {
          if (!this.live(e) || e.phase !== 'leased') continue;
          const st = statuses[e.interfaceId!];
          const fmu = e.fmu;
          fmu.setRuntimeStatus(st?.startGeneration, st?.simTime);
          let { state, error } = fmuStateOfWorker(st);
          if (fmu.expectedGeneration !== undefined) {
            // plan-502: a restart is proven by a start generation OTHER than the
            // one it began from — the old worker may still report `Connected` for
            // a moment. "Other", not "greater": a gateway restart resets the
            // counter to 1, and waiting for base + 1 then blocked every later
            // restart edge for good.
            // Generation 0 = the NEW worker has not started yet (the replacement
            // worker reports 0 until its first successful start) — not a proof.
            const base = fmu.expectedGeneration - 1;
            if (st?.startGeneration === undefined) {
              // A CONNECTED worker without generations = a gateway that cannot tell.
              if (st?.status === 'Connected') this.clearExpected(fmu);
            } else if (st.startGeneration > 0 && st.startGeneration !== base) {
              this.clearExpected(fmu);
            } else if (this.now() - (this.restartSince.get(fmu) ?? this.now()) > FMU_RESTART_TIMEOUT_MS) {
              // Never wait for good: give up. A worker that runs is `running`
              // again (the next edge can restart it); one that does not is an
              // error instead of an endless "starting".
              console.warn(`[fmu-provisioning] ${fmu.node.name}: no new start generation after ${FMU_RESTART_TIMEOUT_MS} ms — restart given up.`);
              this.clearExpected(fmu);
              if (state !== 'running') {
                state = 'error';
                error = error ?? `Restart not confirmed by CONNECT within ${FMU_RESTART_TIMEOUT_MS / 1000} s (worker ${st.status}).`;
              }
            } else if (state === 'running') {
              state = 'starting';
            }
          }
          if (state === 'running' && fmu.state !== 'running') {
            cameUp = true;
            fmu.runningSince = this.now();
          }
          if (fmu.state !== state || fmu.lastError !== error) fmu.setState(state, error);
        }
        if (cameUp) this.requestRediscover();
      }
    } finally {
      this.statusInFlight = false;
    }
  }
}

function isUnder(node: Object3D, root: Object3D): boolean {
  for (let cur: Object3D | null = node; cur; cur = cur.parent) if (cur === root) return true;
  return false;
}

/** Await `p`, but reject with an AbortError as soon as `signal` aborts. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
