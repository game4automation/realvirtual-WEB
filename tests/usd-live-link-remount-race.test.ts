// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2239 Phase 3 — structure changes racing a running mount.
 *
 * - re-parent while the export runs: the snapshot's baseline was captured in
 *   the export's own synchronous pass, so the check before `mountBegin` drops
 *   the mount — no `mountBegin`, ZERO frames from the stale snapshot — and
 *   exactly one follow-up mount comes;
 * - re-parent while the upload runs and the debounce elapses before the upload
 *   ended: the remount waits for the running mount and then starts exactly
 *   once (no stack of exports); a late `mounted` of the dropped generation
 *   sends nothing;
 * - re-parent between the upload and the `mounted` ack: the check before the
 *   first full frame drops the mount;
 * - a hung export of an OLDER lifecycle (model switch, sync off/on) never
 *   holds back the remount of the current mount (Codex review #1).
 */

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { decodeMessage, type DecodedMessage, type LiveSyncAck } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin, type LiveLinkModel } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { LiveLinkStore } from '../src/plugins/usd-live-link/live-link-store';
import { exportRuntimeStage, type RuntimeStageInput, type RuntimeStageSnapshot } from '../src/core/usd/runtime-stage-export';
import type { KitLinkClient, KitLinkClientOptions } from '../src/plugins/usd-live-link/kit-link-client';
import { MIN_EXTENSION_VERSION } from '../src/plugins/usd-live-link/livesync-extension';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

type Msg = DecodedMessage;
type Begin = Extract<Msg, { type: 'mountBegin' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE_MS = 50;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

class FakeClient {
  sent: Msg[] = [];
  isReady = false;
  /** When set, every chunk waits for it. */
  chunkGate: Promise<void> | null = null;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() { /* ready() below */ }
  stop() { this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) {
    if (this.chunkGate) await this.chunkGate;
    return wanted() && this.send(data);
  }
  ready(ack: LiveSyncAck = { type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }) { this.isReady = true; this.opts.onReady(ack); }
  begins(): Begin[] { return this.sent.filter((m): m is Begin => m.type === 'mountBegin'); }
  ack(session: number) { this.opts.onAck({ type: 'mounted', session }); }
}

function makeModel() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Cell';
  const axis = new Object3D(); axis.name = 'Axis';
  const arm = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()); arm.name = 'Arm';
  scene.add(root);
  root.add(axis);
  axis.add(arm);
  const model = {
    root,
    drives: [{ node: axis }],
    transportManager: { sources: [], mus: [], preplacedMUs: [] },
  } as unknown as LiveLinkModel;
  return { root, axis, arm, model };
}

function setup(exportStage: (i: RuntimeStageInput) => Promise<RuntimeStageSnapshot>) {
  const store = new LiveLinkStore({ port: 8775, token: 'tok', rateHz: 30 });
  let client: FakeClient | null = null;
  const plugin = new UsdLiveLinkPlugin({
    store,
    sessionModule,
    exportStage,
    compress: async (b) => ({ bytes: b, encoding: 'identity' }),
    createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
    structureTiming: { checkMs: 10, debounceMs: DEBOUNCE_MS },
  });
  plugin.init({ on: () => () => {} } as unknown as RVViewer);
  return { store, plugin, client: () => client! };
}

/** Sessions of every frame / MU message. */
function streamed(c: FakeClient): number[] {
  return c.sent.filter((x) => x.type === 'frame' || x.type === 'muSpawn' || x.type === 'muDelete').map((x) => x.session);
}

describe('usd-live-link remount race (plan-2239 Phase 3)', () => {
  it('re-parent during the export: no mountBegin, zero frames from the stale snapshot, exactly one follow-up mount', async () => {
    const gates: Array<ReturnType<typeof deferred>> = [];
    let exports = 0;
    const m = setup(async (input) => {
      exports++;
      // The tree (and the structure baseline) is built synchronously HERE.
      const snapshot = exportRuntimeStage(input);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      return snapshot;
    });
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    expect(exports).toBe(1);
    const staleSession = m.store.state.session;

    w.root.attach(w.arm); // re-parent while the export runs
    gates[0].resolve();
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 5000 });
    expect(m.client().begins()).toHaveLength(0);

    await vi.waitFor(() => expect(gates).toHaveLength(2), { timeout: 5000 });
    gates[1].resolve();
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(1), { timeout: 5000 });
    await sleep(DEBOUNCE_MS * 3);
    expect(exports).toBe(2);
    const begin = m.client().begins()[0];
    expect(begin.session).not.toBe(staleSession);
    m.client().ack(begin.session);
    expect(m.store.state.status).toBe('live');
    expect(streamed(m.client()).every((s) => s === begin.session)).toBe(true);
    m.plugin.setSyncEnabled(false);
  });

  it('re-parent during the upload, debounce over before the upload ends: exactly one remount after it, none stacked', async () => {
    let exports = 0;
    const m = setup(async (input) => { exports++; return exportRuntimeStage(input); });
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    const upload = deferred();
    m.client().chunkGate = upload.promise;
    m.client().ready();
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(1), { timeout: 10_000 });
    const stale = m.client().begins()[0];

    w.root.attach(w.arm); // the guard runs from the snapshot on
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 5000 });
    await sleep(DEBOUNCE_MS * 4); // debounce elapsed — the upload still runs
    expect(exports, 'no second export while the first mount runs').toBe(1);
    expect(m.client().begins()).toHaveLength(1);

    m.client().chunkGate = null;
    upload.resolve();
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 10_000 });
    await sleep(DEBOUNCE_MS * 3);
    expect(exports).toBe(2);
    expect(m.client().begins()).toHaveLength(2);

    // A late `mounted` for the dropped generation changes nothing.
    m.client().ack(stale.session);
    expect(m.store.state.status).toBe('mounting');
    expect(streamed(m.client())).toEqual([]);

    const fresh = m.client().begins()[1];
    m.client().ack(fresh.session);
    expect(m.store.state.status).toBe('live');
    expect(streamed(m.client()).every((s) => s === fresh.session)).toBe(true);
    m.plugin.setSyncEnabled(false);
  });

  it('a hung export of an older model never holds back the remount of the current one (review #1)', async () => {
    const a = makeModel(); a.root.name = 'CellA';
    const b = makeModel(); b.root.name = 'CellB';
    const hung = deferred(); // model A's export never ends in this test
    let exportsB = 0;
    const m = setup(async (input) => {
      const snapshot = exportRuntimeStage(input);
      if (input.root === a.root) { await hung.promise; return snapshot; }
      exportsB++;
      return snapshot;
    });
    m.plugin.onModelLoaded(a.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready(); // A's export starts and hangs

    m.plugin.onModelLoaded(b.model as unknown as LoadResult);
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(1), { timeout: 10_000 });
    m.client().ack(m.client().begins()[0].session);
    expect(m.store.state.status).toBe('live');

    b.arm.name = 'ArmRenamed';
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 5000 });
    // After the debounce — without A's export ever ending.
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    expect(exportsB).toBe(2);
    expect(m.client().begins()[1].meta.nodes.some((p) => p.endsWith('/ArmRenamed'))).toBe(true);
    m.client().ack(m.client().begins()[1].session);
    expect(m.store.state.status).toBe('live');
    m.plugin.setSyncEnabled(false);
    hung.resolve();
  });

  it('sync off/on drops a hung export: the remount of the next session does not wait for it (review #1)', async () => {
    const a = makeModel(); a.root.name = 'CellA';
    const b = makeModel(); b.root.name = 'CellB';
    const hung = deferred();
    const m = setup(async (input) => {
      const snapshot = exportRuntimeStage(input);
      if (input.root === a.root) await hung.promise;
      return snapshot;
    });
    m.plugin.onModelLoaded(a.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready(); // A's export hangs
    m.plugin.setSyncEnabled(false);
    m.plugin.onModelLoaded(b.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(1), { timeout: 10_000 });
    m.client().ack(m.client().begins()[0].session);
    expect(m.store.state.status).toBe('live');

    b.root.attach(b.arm);
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 5000 });
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    m.plugin.setSyncEnabled(false);
    hung.resolve();
  });

  it('re-parent between the upload and the `mounted` ack: the first full frame is never sent', async () => {
    const m = setup((input) => exportRuntimeStage(input));
    const w = makeModel();
    m.plugin.onModelLoaded(w.model as unknown as LoadResult);
    m.plugin.setSyncEnabled(true);
    m.client().ready();
    await vi.waitFor(() => expect(m.store.state.message).toBe('Waiting for Isaac Sim…'), { timeout: 10_000 });
    const begin = m.client().begins()[0];
    w.root.attach(w.arm);
    m.client().ack(begin.session); // before the guard timer could tick
    expect(m.store.state.status).toBe('remounting');
    expect(streamed(m.client())).toEqual([]);
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    m.plugin.setSyncEnabled(false);
  });
});
