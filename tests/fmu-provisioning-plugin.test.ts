// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.6 — the FMU provisioning plugin against a mocked CONNECT
 * (`/fmu` routes as an in-memory fake that behaves like `FmuEndpoints.cs`:
 * find-or-create per instance key, leases, trust per SHA).
 *
 * Covered: first contact (GET 404 → upload → dialog → trust → instances →
 * renew), auto-start with trust, transport detection (CONNECT stream, Unity
 * WS, connecting, host change → abort + release), one upload for two
 * placements, two tabs (a tab releases only its own lease), lease expiry,
 * AllowViewerToFmu → allowWebToPlc, once-per-process → error "restart
 * required", 422 → fmu-metadata-drift, dispose / removal → release.
 *
 * plan-502 §9.6 (last describe): the complete start-value map in every
 * request, `overrides-changed` → re-send with a request generation (restart
 * proven by `startGeneration + 1`), no viewer-side start-value write, Undo while
 * in flight, reconnect, 422 `fmu-override-invalid`, the `Restart` signal edge,
 * the storm guard and `RestartOnReset`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import '../src/core/engine/rv-fmu';
import { RVFmu, getFmuInstances, setFmuDocumentIdProvider } from '../src/core/engine/rv-fmu';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import {
  ConnectFmuError,
  type ConnectFmuApi,
  type ConnectFmuCallOptions,
  type ConnectFmuInstanceRequest,
  type ConnectFmuPackage,
  type ConnectFmuWorkerStatus,
} from '../src/core/hmi/connect-fmu';
import {
  FmuProvisioningPlugin,
  FMU_RESTART_TIMEOUT_MS,
  FMU_RESTART_POLL_MS,
  fmuDocumentIdOf,
  fmuStateOfWorker,
  type FmuDocumentSources,
  getFmuProvisioning,
} from '../src/plugins/fmu-provisioning-plugin';
import type { FmuTrustRequest } from '../src/core/hmi/fmu-trust-store';
import type { RVViewer } from '../src/core/rv-viewer';

const GATEWAY = 'http://127.0.0.1:5100';
const SHA = 'c'.repeat(64);
const VARS = [
  { name: 'u', valueReference: 1, causality: 'input', variability: 'continuous', type: 'Real', start: '0.5' },
  { name: 'y', valueReference: 2, causality: 'output', variability: 'continuous', type: 'Real' },
  { name: 'n', valueReference: 1, causality: 'output', variability: 'discrete', type: 'Integer' },
];

// ─── Fake CONNECT ───────────────────────────────────────────────────────

class FakeConnect implements ConnectFmuApi {
  packages = new Map<string, { trusted: boolean }>();
  interfaces = new Map<string, { id: string; leases: Set<string>; req: ConnectFmuInstanceRequest }>();
  statuses: Record<string, ConnectFmuWorkerStatus> = {};
  calls: string[] = [];
  requests: ConnectFmuInstanceRequest[] = [];
  signals: Array<AbortSignal | undefined> = [];
  /** When set, `getPackage` hangs until aborted. */
  hangGet = false;
  /** When set, `createInstance` fails with it. */
  instanceError: ConnectFmuError | null = null;
  /** plan-502 — when set, the NEXT `createInstance` waits for `release()` before answering. */
  gate: { promise: Promise<void>; release: () => void } | null = null;
  private leaseSeq = 0;

  constructor(readonly name = 'A') {}

  private log(what: string, opts?: ConnectFmuCallOptions): void {
    this.calls.push(`${what} @${opts?.baseUrl ?? '?'}`);
    this.signals.push(opts?.signal);
  }

  private variables() {
    return VARS.map((v) => ({
      ...v,
      supported: true,
      dataType: v.type === 'Real' ? 'Real' : 'Integer',
      direction: v.causality === 'input' ? 'input' as const : 'output' as const,
    }));
  }

  private describe(sha: string): ConnectFmuPackage {
    return {
      sha256: sha,
      trusted: this.packages.get(sha)!.trusted,
      refCount: [...this.interfaces.values()].filter((i) => i.req.sha256 === sha).length,
      meta: { modelName: 'Feedthrough', guid: '{g}', fmiVersion: '2.0', generationTool: 'Reference FMUs', byteLength: 3 },
      variables: this.variables(),
    };
  }

  getPackage = async (sha: string, opts?: ConnectFmuCallOptions): Promise<ConnectFmuPackage | null> => {
    this.log(`GET ${sha.slice(0, 4)}`, opts);
    if (this.hangGet) {
      return new Promise((_res, rej) => {
        opts?.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      });
    }
    return this.packages.has(sha) ? this.describe(sha) : null;
  };

  uploadPackage = async (bytes: Uint8Array, sha: string, _fileName: string, opts?: ConnectFmuCallOptions): Promise<ConnectFmuPackage> => {
    this.log(`UPLOAD ${sha.slice(0, 4)} ${bytes.byteLength}`, opts);
    if (!this.packages.has(sha)) this.packages.set(sha, { trusted: false });
    return this.describe(sha);
  };

  trust = async (sha: string, opts?: ConnectFmuCallOptions): Promise<void> => {
    this.log(`TRUST ${sha.slice(0, 4)}`, opts);
    this.packages.get(sha)!.trusted = true;
  };

  revokeTrust = async (sha: string, opts?: ConnectFmuCallOptions): Promise<void> => {
    this.log(`REVOKE ${sha.slice(0, 4)}`, opts);
    this.packages.get(sha)!.trusted = false;
  };

  createInstance = async (req: ConnectFmuInstanceRequest, opts?: ConnectFmuCallOptions) => {
    this.log(`INSTANCE ${req.instanceKey}`, opts);
    this.requests.push(req);
    if (this.gate) {
      const g = this.gate;
      this.gate = null;
      await g.promise;
    }
    if (this.instanceError) throw this.instanceError;
    let iface = this.interfaces.get(req.instanceKey);
    const created = !iface;
    if (!iface) {
      iface = { id: `fmu-${this.interfaces.size + 1}`, leases: new Set(), req };
      this.interfaces.set(req.instanceKey, iface);
    }
    const leaseId = `${this.name}-L${++this.leaseSeq}`;
    iface.leases.add(leaseId);
    return { interfaceId: iface.id, leaseId, created };
  };

  renewLease = async (leaseId: string, opts?: ConnectFmuCallOptions) => {
    this.log(`RENEW ${leaseId}`, opts);
    const iface = [...this.interfaces.values()].find((i) => i.leases.has(leaseId));
    if (!iface) throw new ConnectFmuError('FMU lease renew: expired', 404, 'lease-unknown');
    return { leaseId, interfaceId: iface.id };
  };

  releaseLease = async (leaseId: string, opts?: ConnectFmuCallOptions): Promise<void> => {
    this.log(`RELEASE ${leaseId}`, opts);
    for (const [key, iface] of this.interfaces) {
      if (iface.leases.delete(leaseId) && iface.leases.size === 0) this.interfaces.delete(key);
    }
  };

  /** plan-502 — how `POST /fmu/leases/{id}/restart` answers. */
  restartMode: 'ok' | 'debounced' | 'other-lease' | 'old-gateway' = 'ok';
  /** The `cause` of every restart request, in order. */
  restartCauses: string[] = [];
  /** When set, `/status` fails with it (e.g. the HTTP 500 of a concurrent config change). */
  statusError: ConnectFmuError | null = null;

  restartInstance?: ConnectFmuApi['restartInstance'] = async (leaseId: string, opts?: ConnectFmuCallOptions, cause = 'signal') => {
    this.log(`RESTART ${leaseId}`, opts);
    this.restartCauses.push(cause);
    if (this.restartMode === 'old-gateway') throw new ConnectFmuError('FMU restart: HTTP 404', 404, null);
    const iface = [...this.interfaces.values()].find((i) => i.leases.has(leaseId));
    if (!iface) throw new ConnectFmuError('FMU restart: lease expired', 404, 'lease-unknown');
    const startGeneration = this.statuses[iface.id]?.startGeneration;
    if (this.restartMode === 'debounced' || this.restartMode === 'other-lease') {
      return { interfaceId: iface.id, restarted: false, reason: this.restartMode, startGeneration };
    }
    return { interfaceId: iface.id, restarted: true, startGeneration };
  };

  fetchWorkerStatuses = async (opts?: ConnectFmuCallOptions) => {
    this.log('STATUS', opts);
    if (this.statusError) throw this.statusError;
    return { ...this.statuses };
  };

  /** Lease reaper: every lease is gone (TTL elapsed without renew). */
  expireAllLeases(): void {
    this.interfaces.clear();
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

// ─── Fake viewer + transports ───────────────────────────────────────────

interface Transports {
  /** InterfaceManager active interface (Unity WS etc.). */
  manager: { endpoint: URL | null; state: string } | null;
  /** CONNECT plugin value stream. */
  stream: { endpoint: URL | null; state: string } | null;
}

interface Env {
  viewer: RVViewer;
  emit(event: string, data?: unknown): void;
  /** plan-502 — viewer events as the COMPONENTS see them (`ctx.events`, e.g. `simulation-reset`). */
  emitToComponents(event: string): void;
  transports: Transports;
  store: SignalStore;
  registry: NodeRegistry;
  scene: Scene;
  ctx: ComponentContext;
}

function env(): Env {
  const listeners = new Map<string, Set<(d: unknown) => void>>();
  const transports: Transports = { manager: null, stream: null };
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const viewer = {
    currentModelUrl: 'models/cell.glb',
    on(event: string, cb: (d: unknown) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, set = new Set());
      set.add(cb);
      return () => set!.delete(cb);
    },
    getPlugin(id: string) {
      if (id === 'interface-manager') {
        const m = transports.manager;
        return {
          id,
          getActive: () => (m ? { connectionState: m.state } : null),
          getActiveEndpoint: () => (m && m.state === 'connected' ? m.endpoint : null),
        };
      }
      if (id === 'connect') {
        const s = transports.stream;
        return { id, streamEndpoint: s && s.state === 'connected' ? s.endpoint : null, streamConnectionState: s?.state ?? 'disconnected' };
      }
      return undefined;
    },
  } as unknown as RVViewer;
  const compListeners = new Map<string, Set<() => void>>();
  const events = {
    on(event: string, cb: () => void) {
      let set = compListeners.get(event);
      if (!set) compListeners.set(event, set = new Set());
      set.add(cb);
      return () => set!.delete(cb);
    },
  };
  const ctx = { registry, signalStore: store, scene, events } as unknown as ComponentContext;
  return {
    viewer, transports, store, registry, scene, ctx,
    emit(event, data) { for (const cb of listeners.get(event) ?? []) cb(data); },
    emitToComponents(event) { for (const cb of [...(compListeners.get(event) ?? [])]) cb(); },
  };
}

function connectStream(e: Env, host = '127.0.0.1:5100'): void {
  e.transports.stream = { endpoint: new URL(`ws://${host}/ws?apikey=x`), state: 'connected' };
}

/** The model root `Model` under the scene. */
function model(e: Env): Object3D {
  let m = e.scene.children.find((c) => c.name === 'Model');
  if (!m) { m = new Object3D(); m.name = 'Model'; e.scene.add(m); }
  return m;
}

/** scene > Model > …names; an `Fmu` on the last node. */
function fmuAt(e: Env, names: string[], extras: Partial<Record<string, unknown>> = {}, userData: Record<string, unknown> = {}): RVFmu {
  let parent: Object3D = e.scene;
  for (const n of ['Model', ...names]) {
    let o = parent.children.find((c) => c.name === n);
    if (!o) { o = new Object3D(); o.name = n; parent.add(o); }
    parent = o;
  }
  Object.assign(parent.userData, userData);
  const data = {
    StepSize: 0.02, Tolerance: 1e-5, AllowViewerToFmu: true,
    FmuEmbed: { fileName: 'Feedthrough.fmu', sha256: SHA, guid: '{g}', modelName: 'Feedthrough', fmiVersion: '2.0', byteLength: 3, bufferView: 0 },
    FmuVariables: VARS,
    ...extras,
  };
  parent.userData.realvirtual = { Fmu: data };
  const inst = new RVFmu(parent);
  applySchema(inst as unknown as Record<string, unknown>, RVFmu.schema, data);
  e.registry.registerNode(NodeRegistry.computeNodePath(parent), parent);
  inst.init(e.ctx);
  return inst;
}

/** Let queued microtasks and promise chains run. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

interface Harness {
  plugin: FmuProvisioningPlugin;
  api: FakeConnect;
  asked: FmuTrustRequest[];
  answer: { value: boolean };
  gateway: { url: string; listeners: Set<() => void> };
}

function plugin(e: Env, api = new FakeConnect(), answer = { value: true }, now?: () => number): Harness {
  const asked: FmuTrustRequest[] = [];
  const gateway = { url: GATEWAY, listeners: new Set<() => void>() };
  const p = new FmuProvisioningPlugin({
    api,
    gatewayUrl: () => gateway.url,
    subscribeGateway: (l) => { gateway.listeners.add(l); return () => gateway.listeners.delete(l); },
    confirmTrust: async (req) => { asked.push(req); return answer.value; },
    documentId: () => 'proj/doc-1',
    renewIntervalMs: 3_600_000,
    statusIntervalMs: 3_600_000,
    now,
  });
  p.init(e.viewer);
  return { plugin: p, api, asked, answer, gateway };
}

const harnesses: Harness[] = [];

beforeEach(() => {
  binaryResources._resetForTesting();
  binaryResources.put(SHA, new Uint8Array([1, 2, 3]), 'doc');
  resetProblemsForTests();
  setFmuDocumentIdProvider(null);
  for (const i of [...getFmuInstances()]) i.dispose();
});

afterEach(() => {
  for (const h of harnesses.splice(0)) h.plugin.dispose();
  for (const i of [...getFmuInstances()]) i.dispose();
});

function track(h: Harness): Harness {
  harnesses.push(h);
  return h;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('FMU provisioning — first contact and auto-start', () => {
  it('GET 404 → upload → dialog → trust → instances → starting → /status running → renew', async () => {
    const e = env();
    connectStream(e);
    const h = track(plugin(e));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();

    expect(h.api.calls.map((c) => c.split(' @')[0])).toEqual([
      `GET ${SHA.slice(0, 4)}`, `UPLOAD ${SHA.slice(0, 4)} 3`, `TRUST ${SHA.slice(0, 4)}`, 'INSTANCE proj/doc-1#Hydraulics', 'STATUS',
    ]);
    expect(h.api.calls.every((c) => c.endsWith(`@${GATEWAY}`))).toBe(true);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({ sha256: SHA, modelName: 'Feedthrough', guid: '{g}', generationTool: 'Reference FMUs', fileName: 'Feedthrough.fmu' });
    expect(h.asked[0].sources).toEqual([{ nodePath: 'Model/Hydraulics', instanceKey: 'proj/doc-1#Hydraulics' }]);

    const req = h.api.requests[0];
    expect(req).toMatchObject({ instanceKey: 'proj/doc-1#Hydraulics', sha256: SHA, allowWebToPlc: true, stepSize: 0.02, tolerance: 1e-5 });
    // The REGISTERED wire names of the children, typed the CONNECT way.
    expect(req.signals).toEqual([
      { name: 'Hydraulics.u', valueReference: 1, dataType: 'Real', direction: 'input' },
      { name: 'Hydraulics.y', valueReference: 2, dataType: 'Real', direction: 'output' },
      { name: 'Hydraulics.n', valueReference: 1, dataType: 'Integer', direction: 'output' },
    ]);
    expect(req.signals.map((s) => s.name).sort()).toEqual([...fmu.signalNames].sort());
    expect(fmu.state).toBe('starting');
    expect(fmu.leaseId).toBe('A-L1');
    expect(fmu.interfaceId).toBe('fmu-1');

    h.api.statuses['fmu-1'] = { status: 'Connected' };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    expect(getProblems().filter((p) => p.code.startsWith('fmu-'))).toEqual([]);

    await h.plugin.renewAll();
    expect(h.api.count('RENEW A-L1')).toBe(1);
  });

  it('a later load with trust: no dialog, straight to instances (auto-start)', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    fmuAt(e, ['Hydraulics']);
    await settle();
    expect(h.asked).toHaveLength(0);
    expect(api.calls.map((c) => c.split(' @')[0])).toEqual([`GET ${SHA.slice(0, 4)}`, 'INSTANCE proj/doc-1#Hydraulics', 'STATUS']);
  });

  it('dialog declined → needs-trust, nothing created; "Trust & start" asks again and starts', async () => {
    const e = env();
    connectStream(e);
    const h = track(plugin(e, new FakeConnect(), { value: false }));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(fmu.state).toBe('needs-trust');
    expect(h.api.count('TRUST')).toBe(0);
    expect(h.api.count('INSTANCE')).toBe(0);

    h.answer.value = true;
    getFmuProvisioning()!.trustAndStart(fmu);
    await settle();
    expect(h.asked).toHaveLength(2);
    expect(h.api.count('TRUST')).toBe(1);
    expect(fmu.state).toBe('starting');
  });

  it('installs the document id provider (instanceKey = <documentId>#<path>)', async () => {
    const e = env();
    track(plugin(e));
    const fmu = fmuAt(e, ['Cell', 'Hydraulics']);
    expect(fmu.instanceKey).toBe('proj/doc-1#Cell/Hydraulics');
  });
});

describe('FMU provisioning — transport detection', () => {
  it('Unity live (InterfaceManager on another origin) → no call, standalone', async () => {
    const e = env();
    e.transports.manager = { endpoint: new URL('http://localhost:7000/'), state: 'connected' };
    connectStream(e); // even with a CONNECT stream: the active foreign interface wins
    const h = track(plugin(e));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(h.api.calls).toEqual([]);
    expect(fmu.state).toBe('standalone');
    expect(h.plugin.transport()).toEqual({ kind: 'standalone', reason: 'other' });
  });

  it('InterfaceManager connected to the gateway origin (ws → http normalised) → provisions', async () => {
    const e = env();
    e.transports.manager = { endpoint: new URL('http://127.0.0.1:5100/'), state: 'connected' };
    const h = track(plugin(e));
    fmuAt(e, ['Hydraulics']);
    await settle();
    expect(h.plugin.transport()).toMatchObject({ kind: 'connect', origin: GATEWAY });
    expect(h.api.count('INSTANCE')).toBe(1);
  });

  it('connecting → waits (idle, no call); connected → provisions', async () => {
    const e = env();
    e.transports.stream = { endpoint: null, state: 'connecting' };
    const h = track(plugin(e));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(h.api.calls).toEqual([]);
    expect(fmu.state).toBe('idle');

    connectStream(e);
    e.emit('interface-connected', { interfaceId: 'websocket-realtime', type: 'WebSocket' });
    await settle();
    expect(h.api.count('INSTANCE')).toBe(1);
  });

  it('no transport → standalone, no call', async () => {
    const e = env();
    const h = track(plugin(e));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(h.api.calls).toEqual([]);
    expect(fmu.state).toBe('standalone');
  });

  it('host change aborts the requests in flight and releases the old gateway lease', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    const leased = fmuAt(e, ['Leased']);
    await settle();
    expect(leased.leaseId).toBe('A-L1');

    // A second FMU whose lookup hangs at the old gateway.
    api.hangGet = true;
    const other = fmuAt(e, ['Other'], { FmuEmbed: { fileName: 'o.fmu', sha256: 'd'.repeat(64), guid: '', modelName: 'O', fmiVersion: '2.0', byteLength: 3, bufferView: 0 } });
    binaryResources.put('d'.repeat(64), new Uint8Array([4]), 'doc');
    h.plugin.reconcileNow();
    await settle();
    const hanging = api.signals[api.calls.findIndex((c) => c.startsWith(`GET dddd`))];
    expect(hanging?.aborted).toBe(false);

    api.hangGet = false;
    h.gateway.url = 'http://10.0.0.7:5100';
    connectStream(e, '10.0.0.7:5100');
    for (const l of h.gateway.listeners) l();
    await settle();

    expect(hanging?.aborted).toBe(true);
    expect(api.calls).toContain(`RELEASE A-L1 @${GATEWAY}`);
    expect(api.calls.some((c) => c.startsWith('GET') && c.endsWith('@http://10.0.0.7:5100'))).toBe(true);
    expect(other.state === 'needs-trust' || other.state === 'starting').toBe(true);
  });

  it('transport lost → requests aborted, state standalone, the lease is NOT released (TTL keeps a reconnect cheap)', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(fmu.leaseId).toBe('A-L1');
    e.transports.stream = null;
    e.emit('connection-state-changed', { state: 'Disconnected', previous: 'Connected' });
    await settle();
    expect(fmu.state).toBe('standalone');
    expect(fmu.leaseId).toBeUndefined();
    expect(api.count('RELEASE')).toBe(0);
    // Back within the TTL: find-or-create lands on the same interface.
    connectStream(e);
    e.emit('interface-connected', {});
    await settle();
    expect(api.requests.map((r) => r.instanceKey)).toEqual(['proj/doc-1#Hydraulics', 'proj/doc-1#Hydraulics']);
    expect(fmu.interfaceId).toBe('fmu-1');
  });
});

describe('FMU provisioning — instances, tabs, leases', () => {
  it('two placements of one package → one upload, two instances with their own keys and wire names', async () => {
    const e = env();
    connectStream(e);
    const h = track(plugin(e));
    // Placement roots Cell_1 / Cell_2 (record ids rec-1 / rec-2), the same asset inside.
    for (const [name, id] of [['Cell_1', 'rec-1'], ['Cell_2', 'rec-2']]) {
      const root = new Object3D();
      root.name = name;
      root.userData._layoutId = id;
      model(e).add(root);
    }
    const a2 = fmuAt(e, ['Cell_1', 'Hyd']);
    const b2 = fmuAt(e, ['Cell_2', 'Hyd']);
    await settle();
    expect(h.api.count('UPLOAD')).toBe(1);
    expect(h.api.count('GET')).toBe(1);
    // One question per instance; the dialog store merges them into ONE row per
    // SHA (see fmu-hierarchy.test.tsx) — and one trust grant covers both.
    expect(h.asked.map((q) => q.sha256)).toEqual([SHA, SHA]);
    expect(h.api.count('TRUST')).toBe(1);
    expect(h.api.requests.map((r) => r.instanceKey).sort()).toEqual(['proj/doc-1#rec-1#Hyd', 'proj/doc-1#rec-2#Hyd']);
    expect(a2.interfaceId).not.toBe(b2.interfaceId);
  });

  it('two tabs: one tab disposing releases ONLY its own lease — the interface lives on', async () => {
    const shared = new FakeConnect('shared');
    shared.packages.set(SHA, { trusted: true });
    const e1 = env();
    connectStream(e1);
    const tab1 = track(plugin(e1, shared));
    const f1 = fmuAt(e1, ['Hydraulics']);
    await settle();
    const e2 = env();
    connectStream(e2);
    const tab2 = track(plugin(e2, shared));
    // tab2's plugin is the newest registration; both see the module-wide list.
    await settle();
    const iface = shared.interfaces.get('proj/doc-1#Hydraulics')!;
    expect(iface.leases.size).toBe(2);
    const lease1 = tab1.plugin.leaseOf(f1)!;
    const lease2 = tab2.plugin.leaseOf(f1)!;
    expect(lease1).not.toBe(lease2);

    harnesses.splice(harnesses.indexOf(tab1), 1);
    tab1.plugin.dispose();
    await settle();
    expect(shared.calls.filter((c) => c.startsWith('RELEASE'))).toEqual([`RELEASE ${lease1} @${GATEWAY}`]);
    expect(shared.interfaces.get('proj/doc-1#Hydraulics')?.leases).toEqual(new Set([lease2]));
  });

  it('lease expired (renew → 404) → provision again: same interface, new lease', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(fmu.leaseId).toBe('A-L1');
    api.expireAllLeases();
    await h.plugin.renewAll();
    await settle();
    expect(api.count('RENEW A-L1')).toBe(1);
    expect(api.count('INSTANCE')).toBe(2);
    expect(fmu.leaseId).toBe('A-L2');
  });

  it('instance disposed / placement removed / Stop → lease released', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    const a = fmuAt(e, ['A']);
    const b = fmuAt(e, ['Placed', 'B']);
    const c = fmuAt(e, ['C']);
    await settle();
    const [la, lb, lc] = [a.leaseId, b.leaseId, c.leaseId];
    a.dispose();
    await settle();
    expect(api.calls).toContain(`RELEASE ${la} @${GATEWAY}`);
    e.emit('layout-content-removed', { root: b.node.parent });
    await settle();
    expect(api.calls).toContain(`RELEASE ${lb} @${GATEWAY}`);
    h.plugin.stop(c);
    await settle();
    expect(api.calls).toContain(`RELEASE ${lc} @${GATEWAY}`);
    expect(c.state).toBe('idle');
    // Stopped stays stopped across reconciles until Re-provision.
    h.plugin.reconcileNow();
    await settle();
    expect(api.count(`INSTANCE proj/doc-1#C`)).toBe(1);
    h.plugin.reprovision(c);
    await settle();
    expect(api.count(`INSTANCE proj/doc-1#C`)).toBe(2);
  });

  it('AllowViewerToFmu=false → allowWebToPlc=false', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    track(plugin(e, api));
    fmuAt(e, ['Hydraulics'], { AllowViewerToFmu: false });
    await settle();
    expect(api.requests[0].allowWebToPlc).toBe(false);
  });
});

describe('FMU provisioning — errors', () => {
  it('once-per-process (worker parked) → error "restart required" + fmu-error problem', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    api.statuses['fmu-1'] = { status: 'Error', error: 'FMU allows one instance per process — restart the gateway' };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('error');
    expect(fmu.lastError).toMatch(/^Restart required — /);
    const p = getProblems().find((x) => x.code === 'fmu-error');
    expect(p?.severity).toBe('error');
    expect(p?.detail).toContain('restart the gateway');
  });

  it('CONNECT variables ≠ browser variables (422 fmu-signal-mismatch) → fmu-metadata-drift warning + error', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    api.instanceError = new ConnectFmuError('FMU instance: Some signals do not match', 422, 'fmu-signal-mismatch',
      [{ name: 'Hydraulics.u', valueReference: 1, reason: 'dataType is Integer, not Real' }]);
    track(plugin(e, api));
    const fmu = fmuAt(e, ['Hydraulics']);
    await settle();
    expect(fmu.state).toBe('error');
    const drift = getProblems().find((x) => x.code === 'fmu-metadata-drift');
    expect(drift?.severity).toBe('warning');
    expect(drift?.detail).toContain('dataType is Integer, not Real');
    expect(getProblems().find((x) => x.code === 'fmu-error')?.severity).toBe('error');
  });

  it('a GET that lists different variables than the browser → drift warning, still provisions', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    track(plugin(e, api));
    fmuAt(e, ['Hydraulics'], { FmuVariables: VARS.slice(0, 2) }); // viewer lacks `n`
    await settle();
    const drift = getProblems().find((x) => x.code === 'fmu-metadata-drift');
    expect(drift?.detail).toContain('n (vr 1) has no signal in the viewer');
    expect(api.count('INSTANCE')).toBe(1);
  });

  it('worker states map onto FMU states', () => {
    expect(fmuStateOfWorker(undefined).state).toBe('starting');
    expect(fmuStateOfWorker({ status: 'Connected' }).state).toBe('running');
    expect(fmuStateOfWorker({ status: 'Reconnecting', error: 'step failed' })).toEqual({ state: 'starting', error: 'step failed' });
    expect(fmuStateOfWorker({ status: 'Error', error: 'FMU not trusted' })).toEqual({ state: 'error', error: 'FMU not trusted' });
    expect(fmuStateOfWorker({ status: 'Stopped' }).state).toBe('idle');
  });
});

describe('FMU provisioning — document id of the instance key', () => {
  // Live acceptance 2026-09-26: opening document B from document A gave B's FMU
  // A's id, because the cross-mode handle is published AFTER the load while an
  // RVFmu reads the provider during init(). The scene store's workspace is bound
  // BEFORE the load and is what the provider must read.
  it('document switch A -> B: the provider answers B even while the handle still says A', () => {
    const store = { openDocumentId: 'doc_a' as string | null };
    const staleHandle = { kind: 'document', documentId: 'doc_a' };
    const sources: FmuDocumentSources = {
      sceneStore: store,
      openDocumentBase: () => staleHandle,
      projectId: () => 'prj_sample',
    };
    expect(fmuDocumentIdOf(null, sources)).toBe('prj_sample/doc_a');
    store.openDocumentId = 'doc_fmu-demo_154b2h4'; // workspace bound to B, handle not yet
    expect(fmuDocumentIdOf(null, sources)).toBe('prj_sample/doc_fmu-demo_154b2h4');
  });

  it('a workspace without a document row never falls back to a stale handle', () => {
    const sources: FmuDocumentSources = {
      sceneStore: { openDocumentId: null },
      openDocumentBase: () => ({ kind: 'document', documentId: 'doc_a' }),
      projectId: () => 'prj_sample',
    };
    expect(fmuDocumentIdOf({ currentModelUrl: '/models/x.glb?v=1' }, sources)).toBe('/models/x.glb');
  });

  it('without a scene store the cross-mode handle is the fallback', () => {
    const sources: FmuDocumentSources = {
      sceneStore: null,
      openDocumentBase: () => ({ kind: 'document', documentId: 'doc_c' }),
      projectId: () => null,
    };
    expect(fmuDocumentIdOf(null, sources)).toBe('doc_c');
  });
});

// ─── plan-502 — start-value overrides, restarts ─────────────────────────

describe('FMU provisioning — start-value overrides and restarts (plan-502)', () => {
  /** A fixed parameter (restart required, no signal) next to the Feedthrough-like variables. */
  const K = { name: 'k', valueReference: 9, causality: 'parameter', variability: 'fixed', type: 'Real', start: '1' };
  const VARS_K = [...VARS, K];

  /** Provision one instance to `running` at start generation `gen`. */
  async function running(opts: { extras?: Record<string, unknown>; now?: () => number; gen?: number } = {}) {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    const h = track(plugin(e, api, { value: true }, opts.now));
    const fmu = fmuAt(e, ['Hydraulics'], { FmuVariables: VARS_K, ...opts.extras });
    await settle();
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: opts.gen ?? 1, simTime: 2.5 };
    await h.plugin.pollStatus();
    return { e, api, h, fmu };
  }

  /** What `RVFmu.reapplyConfig` sees after a setField / Undo of `FmuStartOverrides`. */
  function setOverrides(fmu: RVFmu, map: Record<string, string>): void {
    fmu.FmuStartOverrides = map;
    fmu.reapplyConfig();
  }

  it('createInstance carries the complete map of applied overrides (orphans and outputs are not sent)', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    track(plugin(e, api));
    fmuAt(e, ['Hydraulics'], { FmuVariables: VARS_K, FmuStartOverrides: { u: '1.5', k: '3', y: '9', gone: '1' } });
    await settle();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].startOverrides).toEqual({ k: '3', u: '1.5' });
  });

  it('mirrors startGeneration / simTime from /status', async () => {
    const { fmu } = await running({ gen: 4 });
    expect(fmu.state).toBe('running');
    expect(fmu.startGeneration).toBe(4);
    expect(fmu.simTime).toBe(2.5);
  });

  it('overrides-changed with the fixed k → createInstance again, `starting` until startGeneration + 1', async () => {
    const { api, h, fmu } = await running();
    expect(fmu.leaseId).toBe('A-L1');
    setOverrides(fmu, { k: '3' });
    expect(fmu.state).toBe('starting');
    expect(fmu.expectedGeneration).toBe(2);
    await settle();
    expect(api.requests).toHaveLength(2);
    expect(api.requests[1].startOverrides).toEqual({ k: '3' });
    // The new lease is held, the old one given back — the interface stays.
    expect(fmu.leaseId).toBe('A-L2');
    expect(api.count('RELEASE A-L1')).toBe(1);
    expect(api.interfaces.get('proj/doc-1#Hydraulics')?.leases).toEqual(new Set(['A-L2']));

    // CONNECT still reports the old worker (generation 1): not running yet.
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('starting');
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2, simTime: 0 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
    expect(fmu.simTime).toBe(0);
  });

  it('overrides-changed with the live u → createInstance again, no restart expected, no start-value write by the viewer', async () => {
    const { e, api, h, fmu } = await running();
    e.store.set('Hydraulics.u', 7); // the live value an author set in the editor
    setOverrides(fmu, { u: '2' });
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
    await settle();
    expect(api.requests.at(-1)!.startOverrides).toEqual({ u: '2' });
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    // Neither the component nor the plugin wrote the start value into the running FMU.
    expect(e.store.get('Hydraulics.u')).toBe(7);
  });

  it('Undo while the request is in flight → the older generation is discarded, the stored state wins', async () => {
    const { api, fmu } = await running();
    let release!: () => void;
    api.gate = { promise: new Promise<void>((r) => { release = r; }), release: () => release() };
    setOverrides(fmu, { k: '3' }); // request #2 held
    await settle();
    setOverrides(fmu, {}); // Undo
    release();
    await settle();
    // #2 answered for an overtaken generation → its lease given straight back; #3 carries the current map.
    expect(api.requests.map((r) => r.startOverrides)).toEqual([{}, { k: '3' }, {}]);
    expect(api.count('RELEASE A-L2')).toBe(1);
    expect(fmu.leaseId).toBe('A-L3');
    expect(api.interfaces.get('proj/doc-1#Hydraulics')?.leases).toEqual(new Set(['A-L3']));
  });

  it('reconnect within the lease TTL → createInstance with the CURRENT map', async () => {
    const { e, api, fmu } = await running();
    e.transports.stream = null;
    e.emit('connection-state-changed', { state: 'Disconnected' });
    await settle();
    expect(fmu.state).toBe('standalone');
    setOverrides(fmu, { u: '4', k: '5' });
    connectStream(e);
    e.emit('interface-connected', {});
    await settle();
    expect(api.requests.at(-1)!.startOverrides).toEqual({ k: '5', u: '4' });
  });

  it('422 fmu-override-invalid → error state + fmu-error naming the variable; a fixed map provisions again', async () => {
    const e = env();
    connectStream(e);
    const api = new FakeConnect();
    api.packages.set(SHA, { trusted: true });
    api.instanceError = new ConnectFmuError(
      'FMU instance: start override "k" is invalid', 422, 'fmu-override-invalid',
      [{ variable: 'k', value: 'NaN', reason: 'not a finite number' }],
    );
    track(plugin(e, api));
    const fmu = fmuAt(e, ['Hydraulics'], { FmuVariables: VARS_K, FmuStartOverrides: { k: '3' } });
    await settle();
    expect(fmu.state).toBe('error');
    const problem = getProblems().find((p) => p.code === 'fmu-error');
    expect(problem?.detail).toContain('k = NaN: not a finite number');

    api.instanceError = null;
    setOverrides(fmu, { k: '4' });
    await settle();
    expect(api.requests.at(-1)!.startOverrides).toEqual({ k: '4' });
    expect(fmu.state).toBe('starting');
  });

  it('Restart signal: a rising edge → exactly one restart on the lease (no release, no new instance), signal back to false', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    t += 5_000;
    expect(fmu.restartSignalName).toBe('Hydraulics.Restart');
    e.store.set('Hydraulics.Restart', true);
    expect(fmu.state).toBe('starting');
    expect(fmu.expectedGeneration).toBe(2);
    await settle();
    expect(e.store.get('Hydraulics.Restart')).toBe(false);
    expect(api.count('RESTART A-L1')).toBe(1);
    expect(api.count('RELEASE')).toBe(0);
    expect(api.count('INSTANCE')).toBe(1);
    expect(fmu.leaseId).toBe('A-L1');
    // The Restart control signal is never announced to CONNECT.
    expect(api.requests.at(-1)!.signals.map((s) => s.name)).not.toContain('Hydraulics.Restart');

    // The old worker still reports generation 1: not running yet.
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('starting');
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2, simTime: 0 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
  });

  it('a second tab holding a lease on the same interface does not swallow the restart', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    api.interfaces.get('proj/doc-1#Hydraulics')!.leases.add('B-L1'); // the other tab
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART A-L1')).toBe(1);
    // Both leases are still there — nothing was released, nothing re-created.
    expect(api.interfaces.get('proj/doc-1#Hydraulics')?.leases).toEqual(new Set(['A-L1', 'B-L1']));
    expect(fmu.expectedGeneration).toBe(2);
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');

    // The next edge (12 s later) restarts again — the sequence never stands still.
    t += 12_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART A-L1')).toBe(2);
    expect(fmu.expectedGeneration).toBe(3);
  });

  it('debounced by CONNECT (another tab restarted it < 2 s ago) → no wait for a generation', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    api.restartMode = 'debounced';
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART A-L1')).toBe(1);
    expect(fmu.expectedGeneration).toBeUndefined();
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
  });

  it('a gateway restart resets the generation counter → the restart still completes (no standing sequence)', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t, gen: 4474 });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(fmu.expectedGeneration).toBe(4475);
    // CONNECT was restarted meanwhile: its counter starts at 1 again.
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 1 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
    t += 12_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(2);
  });

  it('no new generation within the timeout → the wait is given up, the next edge restarts again', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('starting');
    // A later edge while waiting is ignored ...
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(1);
    // ... but the wait is not forever.
    t += FMU_RESTART_TIMEOUT_MS;
    await h.plugin.pollStatus();
    expect(fmu.expectedGeneration).toBeUndefined();
    expect(fmu.state).toBe('running');
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(2);
  });

  it('/status failing (HTTP 500) during a restart → still starting, completes on the next good poll', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    api.statusError = new ConnectFmuError('CONNECT status: HTTP 500 Internal Server Error', 500, null);
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('starting');
    api.statusError = null;
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
  });

  it('a gateway without the restart route → release (awaited) + re-create, as before', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    api.restartMode = 'old-gateway';
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    const calls = api.calls.map((c) => c.split(' @')[0]);
    expect(calls.indexOf('RESTART A-L1')).toBeGreaterThan(-1);
    expect(calls.indexOf('RELEASE A-L1')).toBeGreaterThan(calls.indexOf('RESTART A-L1'));
    expect(calls.indexOf('RELEASE A-L1')).toBeLessThan(calls.lastIndexOf('INSTANCE proj/doc-1#Hydraulics'));
    expect(api.count('INSTANCE')).toBe(2);
    expect(fmu.leaseId).toBe('A-L2');
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
  });

  it('an api without restartInstance (pre-route client seam) restarts by release + re-create', async () => {
    let t = 10_000;
    const { e, api, fmu } = await running({ now: () => t });
    api.restartInstance = undefined;
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RELEASE A-L1')).toBe(1);
    expect(api.count('INSTANCE')).toBe(2);
    expect(fmu.state).toBe('starting');
  });

  it('storm guard: edges while starting and within the first second after running are ignored', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    // Within 1 s after `running` (runningSince = 10 000).
    t += 500;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(0);
    expect(e.store.get('Hydraulics.Restart')).toBe(false);

    t += 1_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(1);
    // While the restart runs (`starting`): ignored.
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(1);

    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    e.store.set('Hydraulics.Restart', true); // same instant as `running` → guard
    await settle();
    expect(api.count('RESTART')).toBe(1);
    expect(api.count('INSTANCE')).toBe(1);
  });

  it('a restart is confirmed by fast /status polls, not the 2 s cadence (a 2 s sequence period keeps every edge)', async () => {
    let t = 10_000;
    const { e, api, fmu } = await running({ now: () => t });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(fmu.state).toBe('starting');
    const polls = api.count('STATUS');
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await new Promise((r) => setTimeout(r, FMU_RESTART_POLL_MS * 3));
    expect(api.count('STATUS')).toBeGreaterThan(polls);
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
    // Two seconds later (the demo's shortest period) the next edge restarts again.
    t += 2_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(2);
  });

  it('generation 0 (the replacement worker has not started yet) is no proof of the restart', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t, gen: 6 });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(fmu.expectedGeneration).toBe(7);
    api.statuses['fmu-1'] = { status: 'Connecting', startGeneration: 0 };
    await h.plugin.pollStatus();
    expect(fmu.expectedGeneration).toBe(7);
    expect(fmu.state).toBe('starting');
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 7 };
    await h.plugin.pollStatus();
    expect(fmu.expectedGeneration).toBeUndefined();
    expect(fmu.state).toBe('running');
  });

  it('restart timeout with a worker that does not run → error (not an endless "starting"), recovers when it runs', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    api.statuses['fmu-1'] = { status: 'Connecting', startGeneration: 0 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('starting');
    t += FMU_RESTART_TIMEOUT_MS + 1;
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('error');
    expect(fmu.lastError).toContain('Restart not confirmed');
    expect(fmu.expectedGeneration).toBeUndefined();
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART')).toBe(2);
  });

  it("another tab leads the restart loop ('other-lease') → no restart, no \"starting\" flicker, next edge asks again", async () => {
    let t = 10_000;
    const { e, api, fmu } = await running({ now: () => t });
    api.restartMode = 'other-lease';
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART A-L1')).toBe(1);
    expect(fmu.state).toBe('running');
    expect(fmu.expectedGeneration).toBeUndefined();
    expect(e.store.get('Hydraulics.Restart')).toBe(false);
    t += 12_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    expect(api.count('RESTART A-L1')).toBe(2);
  });

  it("the Restart edge asks as cause 'signal', simulation-reset as cause 'reset'", async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    t += 5_000;
    e.store.set('Hydraulics.Restart', true);
    await settle();
    api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 2 };
    await h.plugin.pollStatus();
    expect(fmu.state).toBe('running');
    t += 5_000;
    e.emitToComponents('simulation-reset');
    await settle();
    expect(api.restartCauses).toEqual(['signal', 'reset']);
  });

  it('streamed values and status polls (fresh start values after a restart) never restart the instance', async () => {
    let t = 10_000;
    const { e, api, h, fmu } = await running({ now: () => t });
    const names = api.requests.at(-1)!.signals.map((s) => s.name);
    expect(names.length).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) {
      t += 100;
      for (const name of names) e.store.set(name, i % 2 === 0 ? 0 : i);
      api.statuses['fmu-1'] = { status: 'Connected', startGeneration: 1, simTime: i * 0.1 };
      await h.plugin.pollStatus();
    }
    await settle();
    expect(api.count('RESTART')).toBe(0);
    expect(api.count('INSTANCE')).toBe(1);
    expect(fmu.state).toBe('running');
  });

  it('simulation-reset restarts a running instance; RestartOnReset=false does nothing', async () => {
    let t = 10_000;
    const on = await running({ now: () => t });
    t += 5_000;
    on.e.emitToComponents('simulation-reset');
    await settle();
    expect(on.api.count('RESTART A-L1')).toBe(1);
    expect(on.api.count('RELEASE')).toBe(0);
    expect(on.fmu.state).toBe('starting');
    // One plugin per test from here on (the instance list is module-wide).
    on.h.plugin.dispose();
    on.fmu.dispose();

    const off = await running({ now: () => t, extras: { RestartOnReset: false } });
    t += 5_000;
    off.e.emitToComponents('simulation-reset');
    await settle();
    expect(off.api.count('RESTART')).toBe(0);
    expect(off.api.count('INSTANCE')).toBe(1);
    expect(off.fmu.state).toBe('running');
  });
});
