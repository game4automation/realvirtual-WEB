// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 F10 / R2 #4 / R2 #5 — lifecycle of the USD live link:
 * - a reset while paused (no tick follows) still sends the POST-reset poses
 *   and MU inventory;
 * - a model switch or Sync off during the export drops the export result;
 * - switching on with MUs already present spawns them after the mount and
 *   leaves their nodes out of the stage;
 * - spawning / stopping during `parseAsync` leaves the live scene untouched.
 */

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { decodeMessage, type DecodedMessage } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin, type LiveLinkModel, type UsdLiveLinkSessionModule } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { LiveLinkStore } from '../src/plugins/usd-live-link/live-link-store';
import {
  exportRuntimeStage,
  type RuntimeStageInput,
  type RuntimeStageSnapshot,
} from '../src/plugins/usd-live-link/runtime-stage-export';
import type { KitLinkClient, KitLinkClientOptions } from '../src/plugins/usd-live-link/kit-link-client';
import type { LiveSyncAck } from '../src/plugins/usd-live-link/livesync-protocol';
import { MIN_EXTENSION_VERSION } from '../src/plugins/usd-live-link/livesync-extension';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

type Msg = DecodedMessage;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A client double: ready on demand, records decoded messages. */
class FakeClient {
  sent: Msg[] = [];
  isReady = false;
  started = false;
  stopped = false;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() { this.started = true; }
  stop() { this.stopped = true; this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) { return wanted() && this.send(data); }
  ready(ack: LiveSyncAck = { type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }) {
    this.isReady = true;
    this.opts.onReady(ack);
  }
  mounted() {
    const b = [...this.sent].reverse().find((m) => m.type === 'mountBegin');
    this.opts.onAck({ type: 'mounted', session: b!.session });
  }
  types() { return this.sent.map((m) => m.type); }
}

function makeModel() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Cell';
  const axis = new Object3D(); axis.name = 'Axis';
  const tpl = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); tpl.name = 'Box';
  tpl.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial())); // clone path
  const srcNode = new Object3D(); srcNode.name = 'Source';
  scene.add(root);
  root.add(axis, tpl, srcNode);
  const source = new RVSource(srcNode);
  source.spawnParent = root;
  source.setTemplate(tpl);
  const mus: unknown[] = [];
  const model = {
    root,
    drives: [{ node: axis }],
    transportManager: { sources: [source], mus, preplacedMUs: [] },
  } as unknown as LiveLinkModel;
  const spawn = () => {
    const mu = source.spawnMU()!;
    mus.push(mu);
    return mu;
  };
  return { scene, root, axis, tpl, source, mus, model, spawn };
}

function setup(opts: { exportStage?: (i: RuntimeStageInput) => Promise<RuntimeStageSnapshot> } = {}) {
  const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
  let client: FakeClient | null = null;
  const handlers = new Map<string, () => void>();
  const viewer = { on: (ev: string, cb: () => void) => { handlers.set(ev, cb); return () => handlers.delete(ev); } };
  const plugin = new UsdLiveLinkPlugin({
    store,
    sessionModule,
    exportStage: opts.exportStage,
    compress: async (b) => ({ bytes: b, encoding: 'identity' }),
    createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
  });
  plugin.init(viewer as unknown as RVViewer);
  return { store, plugin, client: () => client!, emit: (ev: string) => handlers.get(ev)?.() };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('usd-live-link lifecycle', () => {
  it('reset while paused, no tick after it: sends the post-reset poses and MU inventory', async () => {
    const m = setup();
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    w.spawn();
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    await vi.waitFor(() => expect(m.client().types()).toContain('mountBegin'), { timeout: 10_000 });
    m.client().mounted();
    expect(m.store.state.status).toBe('live');
    m.client().sent.length = 0;

    // Pre-reset state: axis moved, one more MU.
    w.axis.position.x = 0.5;
    w.spawn();
    // resetSimulation(): the event fires FIRST, then drives / MUs are reset.
    m.emit('simulation-reset');
    w.axis.position.x = 0;
    w.mus.length = 0;
    expect(m.client().sent).toEqual([]); // nothing sent from inside the event
    await Promise.resolve();
    await flush();
    const types = m.client().types();
    expect(types[0]).toBe('reset');
    expect(types).not.toContain('muSpawn');
    const frame = m.client().sent.find((x) => x.type === 'frame') as Extract<Msg, { type: 'frame' }>;
    const axisEntry = frame.nodes.find((n) => n.index === 1)!;
    expect(axisEntry.m[12]).toBe(0); // post-reset, not 0.5
  });

  it('a model switch during the export drops the stale result', async () => {
    const pending: Array<ReturnType<typeof deferred<RuntimeStageSnapshot>>> = [];
    const m = setup({ exportStage: () => { const d = deferred<RuntimeStageSnapshot>(); pending.push(d); return d.promise; } });
    const a = makeModel();
    const b = makeModel();
    m.plugin.onModelLoaded(a.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    expect(pending).toHaveLength(1);
    m.plugin.onModelCleared();
    m.plugin.onModelLoaded(b.model as unknown as LoadResult);
    expect(pending).toHaveLength(2);
    pending[0].resolve(await exportRuntimeStage(collect(a)));
    await flush();
    expect(m.client().types()).not.toContain('mountBegin');
    pending[1].resolve(await exportRuntimeStage(collect(b)));
    await vi.waitFor(() => expect(m.client().types()).toContain('mountBegin'));
    const begins = m.client().sent.filter((x) => x.type === 'mountBegin');
    expect(begins).toHaveLength(1);
    expect(begins[0].session).toBe(m.store.state.session);
  });

  it('Sync off during the export drops the result', async () => {
    const d = deferred<RuntimeStageSnapshot>();
    const m = setup({ exportStage: () => d.promise });
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    const client = m.client();
    client.ready();
    m.plugin.setSyncEnabled(false);
    client.isReady = true; // even if the socket were still there
    d.resolve(await exportRuntimeStage(collect(w)));
    await flush(); await flush();
    expect(client.types()).not.toContain('mountBegin');
    expect(m.store.state.status).toBe('off');
  });

  it('switching on with MUs present: their nodes stay out of the stage and they are spawned after the mount', async () => {
    const inputs: RuntimeStageInput[] = [];
    const m = setup({ exportStage: (i) => { inputs.push(i); return exportRuntimeStage(i); } });
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    const mu1 = w.spawn();
    const mu2 = w.spawn();
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    await vi.waitFor(() => expect(m.client().types()).toContain('mountBegin'), { timeout: 10_000 });
    expect(inputs[0].exclude.has(mu1.node)).toBe(true);
    const begin = m.client().sent.find((x) => x.type === 'mountBegin') as Extract<Msg, { type: 'mountBegin' }>;
    expect(begin.meta.nodes.some((p) => p.includes('Box_'))).toBe(false); // clone MUs are not in the stage
    expect(begin.meta.templates).toEqual(['/Root/Scenes/Scene/Cell/Box']);
    m.client().mounted();
    const spawns = m.client().sent.filter((x) => x.type === 'muSpawn') as Array<Extract<Msg, { type: 'muSpawn' }>>;
    expect(spawns.map((s) => s.muId)).toEqual([mu1.id, mu2.id]);
    expect(spawns.every((s) => s.templateIndex === 0)).toBe(true);
  });

  it('spawning and stopping during parseAsync leave the live scene untouched', async () => {
    const w = makeModel();
    w.tpl.name = 'Box (template)'; // not a valid prim name — the export must not rename the live node
    const before = new Map<Object3D, [string, boolean]>();
    w.scene.traverse((o) => before.set(o, [o.name, o.visible]));
    const exp = exportRuntimeStage(collect(w));
    // While the exporter runs (it awaits the lazy exporter import and
    // parseAsync): spawn an MU, stop the source, move an axis.
    const mu = w.spawn();
    w.source.Enabled = false;
    w.axis.position.y = 3;
    const snap = await exp;
    for (const [o, [name, visible]] of before) {
      expect(o.name).toBe(name);
      expect(o.visible).toBe(visible);
    }
    expect(w.tpl.visible).toBe(false); // the template stays hidden at runtime
    expect(snap.indexOf.has(mu.node)).toBe(false);
    expect(snap.primPaths).toContain('/Root/Scenes/Scene/Cell/Boxtemplate');
  });
});

describe('usd-live-link lazy session (entry budget)', () => {
  function lazySetup() {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const load = deferred<UsdLiveLinkSessionModule>();
    const loadSessionModule = vi.fn(() => load.promise);
    const clients: FakeClient[] = [];
    const plugin = new UsdLiveLinkPlugin({
      store,
      loadSessionModule,
      exportStage: () => new Promise<RuntimeStageSnapshot>(() => {}), // never settles: mount stays pending
      createClient: (o) => { const c = new FakeClient(o); clients.push(c); return c as unknown as KitLinkClient; },
    });
    plugin.init({ on: () => () => {} } as unknown as RVViewer);
    return { store, plugin, load, loadSessionModule, clients };
  }

  it('loads the session only on the first Sync click and hands the current model over', async () => {
    const m = lazySetup();
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    m.plugin.onFixedUpdatePost(1 / 60); // no session yet: a no-op
    expect(m.loadSessionModule).not.toHaveBeenCalled();
    m.plugin.setSyncEnabled(true);
    expect(m.loadSessionModule).toHaveBeenCalledTimes(1);
    expect(m.plugin.syncEnabled).toBe(true);
    expect(m.store.state.status).toBe('connecting');
    expect(m.clients).toHaveLength(0);
    m.load.resolve(sessionModule);
    await vi.waitFor(() => expect(m.clients).toHaveLength(1));
    expect(m.clients[0].started).toBe(true);
    // The model loaded before the session existed is the one it mounts.
    m.clients[0].ready();
    expect(m.store.state.status).toBe('mounting');
    expect(m.store.state.message).not.toBe('Waiting for a model');
  });

  it('Sync off while the chunk loads cancels the start', async () => {
    const m = lazySetup();
    m.plugin.setSyncEnabled(true);
    m.plugin.setSyncEnabled(false);
    expect(m.plugin.syncEnabled).toBe(false);
    expect(m.store.state.status).toBe('off');
    m.load.resolve(sessionModule);
    await flush();
    expect(m.clients).toHaveLength(0);
    m.plugin.setSyncEnabled(true); // module already there: starts at once
    expect(m.loadSessionModule).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(m.clients).toHaveLength(1));
  });

  it('the entry-side modules import the live link and the menu only dynamically', () => {
    const shell = import.meta.glob(
      '../src/plugins/usd-live-link/{usd-live-link-plugin.tsx,UsdToolButton.tsx,LiveLinkPill.tsx,live-link-store.ts}',
      { query: '?raw', import: 'default', eager: true },
    ) as Record<string, string>;
    expect(Object.keys(shell)).toHaveLength(4);
    const lazyOnly = /^import\s+(?!type\b)[^;]*from\s+'\.\/(usd-live-link-session|kit-link-client|livesync-protocol|runtime-stage-export|sync-tracker|UsdToolMenu)'/m;
    for (const [path, text] of Object.entries(shell)) {
      expect(lazyOnly.test(text), `${path} statically imports a lazy-only module`).toBe(false);
    }
  });

  it('without a token nothing is loaded; the switch stays on until a token is committed', async () => {
    const m = lazySetup();
    m.store.updateSettings({ token: '' });
    m.plugin.setSyncEnabled(true);
    expect(m.loadSessionModule).not.toHaveBeenCalled();
    expect(m.plugin.syncEnabled).toBe(true);
    expect(m.store.state.status).toBe('needs-token');
    m.plugin.commitToken('   ');
    expect(m.loadSessionModule).not.toHaveBeenCalled();
    m.plugin.commitToken('tok');
    expect(m.loadSessionModule).toHaveBeenCalledTimes(1);
    expect(m.store.state.status).toBe('connecting');
    m.load.resolve(sessionModule);
    await vi.waitFor(() => expect(m.clients).toHaveLength(1));
    expect(m.clients[0].opts.token).toBe('tok');
  });

  it('switching off always ends in off, also from an error or a missing token without a session', async () => {
    const m = lazySetup();
    m.loadSessionModule.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    m.plugin.setSyncEnabled(true);
    await vi.waitFor(() => expect(m.store.state.status).toBe('error'));
    m.plugin.setSyncEnabled(false);
    expect(m.store.state.status).toBe('off');
    expect(m.store.state.message).toBeUndefined();
    m.store.updateSettings({ token: '' });
    m.plugin.setSyncEnabled(true);
    expect(m.store.state.status).toBe('needs-token');
    m.plugin.setSyncEnabled(false);
    expect(m.store.state.status).toBe('off');
    expect(m.plugin.syncEnabled).toBe(false);
    m.plugin.commitToken('tok'); // no longer waiting: storing the token connects nothing
    expect(m.loadSessionModule).toHaveBeenCalledTimes(1);
  });

  it('a failed chunk load is a visible error, and a retry loads again', async () => {
    const m = lazySetup();
    m.loadSessionModule.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    m.plugin.setSyncEnabled(true);
    await vi.waitFor(() => expect(m.store.state.status).toBe('error'));
    expect(m.store.state.message).toContain('offline');
    expect(m.plugin.syncEnabled).toBe(false);
    m.plugin.setSyncEnabled(true);
    expect(m.loadSessionModule).toHaveBeenCalledTimes(2);
  });
});

function collect(w: ReturnType<typeof makeModel>): RuntimeStageInput {
  const exclude = new Set<Object3D>();
  for (const mu of w.mus as Array<{ node: Object3D }>) exclude.add(mu.node);
  return { root: w.root, templates: [w.tpl], exclude, preplaced: [] };
}

describe('usd-live-link version handshake (plan-637 Phase 6)', () => {
  it('a current extension mounts without a hint', async () => {
    const m = setup();
    m.plugin.onModelLoaded(makeModel().model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    await vi.waitFor(() => expect(m.client().types()).toContain('mountBegin'), { timeout: 10_000 });
    expect(m.store.state.extensionNotice).toBeUndefined();
  });

  it('an old extension (no extVersion) still mounts and syncs, with the outdated hint', async () => {
    const m = setup();
    m.plugin.onModelLoaded(makeModel().model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready({ type: 'ready' });
    await vi.waitFor(() => expect(m.client().types()).toContain('mountBegin'), { timeout: 10_000 });
    m.client().mounted();
    expect(m.store.state.status).toBe('live');
    expect(m.store.state.extensionNotice).toMatch(/^Isaac Sim extension outdated \(version unknown\) — download v/);
    m.plugin.setSyncEnabled(false);
    expect(m.store.state.extensionNotice).toBeUndefined();
  });

  it('another protocol: clear error, no mount, connection closed', async () => {
    const m = setup();
    m.plugin.onModelLoaded(makeModel().model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    const client = m.client();
    client.ready({ type: 'ready', extVersion: '1.0.0', protocol: 2 });
    await flush();
    expect(client.sent).toEqual([]);
    expect(client.stopped).toBe(true);
    expect(m.plugin.syncEnabled).toBe(false);
    expect(m.store.state.status).toBe('error');
    expect(m.store.state.message).toContain('protocol 2');
  });
});
