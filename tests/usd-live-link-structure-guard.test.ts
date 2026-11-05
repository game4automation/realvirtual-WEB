// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2239 Phase 3 — structure guard, freeze and remount of the USD live link
 * (protocol v1: a remount is a normal new mount).
 *
 * - an unchanged mount stays mounted over many debounce intervals: root, an
 *   invisible template, a pre-placed MU, spawned MUs gripped and released, a
 *   gizmo child — one structural filter for baseline and check;
 * - re-parenting a drive child freezes at once: not one further frame of that
 *   generation (its index included), status `remounting`, exactly one remount
 *   after the debounce, every live MU spawned again after it;
 * - a series of changes extends the debounce; a change while PAUSED (no tick)
 *   is found by the own timer; rename / new visible child remount;
 *   `editor-structure-changed` checks at once;
 * - sync off and model clear cancel the pending remount;
 * - a spawned passive load on the pre-placed MU is classified once for the
 *   collector, the baseline and the guard (Codex review #2);
 * - `lastMountTimings` and the prim counts land in the status.
 */

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { decodeMessage, type DecodedMessage, type LiveSyncAck } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin, type LiveLinkModel } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { LiveLinkStore } from '../src/plugins/usd-live-link/live-link-store';
import type { KitLinkClient, KitLinkClientOptions } from '../src/plugins/usd-live-link/kit-link-client';
import { MIN_EXTENSION_VERSION } from '../src/plugins/usd-live-link/livesync-extension';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

type Msg = DecodedMessage;
type Begin = Extract<Msg, { type: 'mountBegin' }>;
type Frame = Extract<Msg, { type: 'frame' }>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHECK_MS = 10;
const DEBOUNCE_MS = 60;

class FakeClient {
  sent: Msg[] = [];
  isReady = false;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() { /* the test calls ready() */ }
  stop() { this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) { return wanted() && this.send(data); }
  ready(ack: LiveSyncAck = { type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }) { this.isReady = true; this.opts.onReady(ack); }
  begins(): Begin[] { return this.sent.filter((m): m is Begin => m.type === 'mountBegin'); }
  mounted() { const b = this.begins().at(-1)!; this.opts.onAck({ type: 'mounted', session: b.session }); }
}

/** Cell { Axis(drive) { Arm }, Box(template, hidden), Source, Pre(pre-placed MU), Line { Station } }. */
function makeModel() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Cell';
  const axis = new Object3D(); axis.name = 'Axis';
  const arm = new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial()); arm.name = 'Arm';
  const tpl = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); tpl.name = 'Box';
  tpl.add(new Mesh(new BoxGeometry(0.1, 0.1, 0.1), new MeshStandardMaterial())); // clone path
  const srcNode = new Object3D(); srcNode.name = 'Source';
  const pre = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); pre.name = 'Pre';
  const line = new Object3D(); line.name = 'Line';
  const station = new Object3D(); station.name = 'Station';
  scene.add(root);
  root.add(axis, tpl, srcNode, pre, line);
  axis.add(arm);
  line.add(station);
  const source = new RVSource(srcNode);
  source.spawnParent = root;
  source.setTemplate(tpl);
  tpl.visible = false; // hidden at runtime, exported as the template
  const preMu = { id: 9001, node: pre, isInstanced: false, preplaced: true, loadedMus: [] as unknown[] };
  const mus: unknown[] = [preMu];
  const model = {
    root,
    drives: [{ node: axis }],
    transportManager: { sources: [source], mus, preplacedMUs: [preMu] },
  } as unknown as LiveLinkModel;
  const spawn = () => {
    const mu = source.spawnMU()!;
    mus.push(mu);
    return mu as unknown as { id: number; node: Object3D };
  };
  return { scene, root, axis, arm, tpl, pre, line, station, mus, model, spawn };
}

function setup(timing: { checkMs?: number; debounceMs?: number } = {}, now?: () => number) {
  const store = new LiveLinkStore({ port: 8775, token: 'tok', rateHz: 30 });
  let client: FakeClient | null = null;
  const handlers = new Map<string, () => void>();
  const viewer = { on: (ev: string, cb: () => void) => { handlers.set(ev, cb); return () => handlers.delete(ev); } };
  const plugin = new UsdLiveLinkPlugin({
    store,
    sessionModule,
    compress: async (b) => ({ bytes: b, encoding: 'identity' }),
    createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
    structureTiming: { checkMs: timing.checkMs ?? CHECK_MS, debounceMs: timing.debounceMs ?? DEBOUNCE_MS },
    now,
  });
  plugin.init(viewer as unknown as RVViewer);
  return { store, plugin, client: () => client!, emit: (ev: string) => handlers.get(ev)?.() };
}

type M = ReturnType<typeof setup>;
type W = ReturnType<typeof makeModel>;

async function goLive(m: M, w: W): Promise<Begin> {
  m.plugin.onModelLoaded(w.model as unknown as LoadResult);
  m.plugin.setSyncEnabled(true);
  m.client().ready();
  await vi.waitFor(() => expect(m.client().begins()).toHaveLength(1), { timeout: 10_000 });
  m.client().mounted();
  expect(m.store.state.status).toBe('live');
  return m.client().begins()[0];
}

/** A few fixed ticks so the rate gate lets samples through. */
function ticks(m: M, n = 4): void {
  for (let i = 0; i < n; i++) m.plugin.onFixedUpdatePost(1 / 30);
}

function indexOf(begin: Begin, suffix: string): number {
  return begin.meta.nodes.findIndex((p) => p.endsWith(suffix));
}

describe('usd-live-link structure guard (plan-2239 Phase 3)', () => {
  it('an unchanged mount stays mounted: root, hidden template, pre-placed MU, MU grip/release, gizmo child', async () => {
    const m = setup();
    const w = makeModel();
    w.spawn();
    await goLive(m, w);
    expect(m.store.state.prims!.total).toBeGreaterThan(5);
    const mu = w.spawn(); // spawned after the mount, under the root
    ticks(m);
    w.axis.attach(mu.node); // grip
    ticks(m);
    await sleep(DEBOUNCE_MS);
    w.root.attach(mu.node); // release
    w.axis.attach(w.pre); // grip the pre-placed MU
    ticks(m);
    await sleep(DEBOUNCE_MS);
    w.root.attach(w.pre);
    const gizmo = new Object3D(); gizmo.userData._rvGizmo = true; w.axis.add(gizmo);
    for (let i = 0; i < 5; i++) { ticks(m); await sleep(DEBOUNCE_MS); }
    expect(m.client().begins()).toHaveLength(1);
    expect(m.store.state.status).toBe('live');
    expect(m.store.state.remounts).toBeUndefined();
    m.plugin.setSyncEnabled(false);
  });

  it('a spawned passive load on the pre-placed MU before the mount: not exported, no alarm at the carrier, unloading remounts nothing (review #2)', async () => {
    const m = setup();
    const w = makeModel();
    const load = w.spawn();
    load.node.name = 'PassiveLoad';
    // plan-516 load: out of the active list, attached under the carrier's node.
    w.mus.splice(w.mus.indexOf(load), 1);
    w.pre.attach(load.node);
    const preMu = w.mus[0] as { loadedMus: unknown[] };
    preMu.loadedMus.push(load);
    const first = await goLive(m, w);
    expect(first.meta.nodes.some((p) => p.endsWith('/PassiveLoad'))).toBe(false);
    expect(indexOf(first, '/Pre')).toBeGreaterThan(0);

    // A helper at the carrier (raw children differ → slow path) and a grip of the carrier.
    const gizmo = new Object3D(); gizmo.userData._rvGizmo = true; w.pre.add(gizmo);
    ticks(m);
    w.axis.attach(w.pre);
    ticks(m);
    await sleep(DEBOUNCE_MS * 2);
    w.root.attach(w.pre);
    // Unload: active again, released under the root.
    preMu.loadedMus.length = 0;
    w.mus.push(load);
    w.root.attach(load.node);
    for (let i = 0; i < 4; i++) { ticks(m); await sleep(DEBOUNCE_MS); }
    expect(m.client().begins()).toHaveLength(1);
    expect(m.store.state.status).toBe('live');
    expect(m.store.state.remounts).toBeUndefined();
    m.plugin.setSyncEnabled(false);
  });

  it('spawned passive loads are transmitted: one muSpawn after mount and after remount, loading without muDelete, pose follows the carrier, unloading without a second spawn (review #2 follow-up)', async () => {
    type Spawn = Extract<Msg, { type: 'muSpawn' }>;
    const m = setup();
    const w = makeModel();
    const preMu = w.mus[0] as { loadedMus: unknown[] };
    const makePassive = (mu: { node: Object3D }) => {
      w.mus.splice(w.mus.indexOf(mu), 1);
      w.pre.attach(mu.node);
      preMu.loadedMus.push(mu);
    };
    const spawnsOf = (session: number, id: number) => m.client().sent
      .filter((x): x is Spawn => x.type === 'muSpawn' && x.session === session && x.muId === id).length;
    const deletesOf = (id: number) => m.client().sent.filter((x) => x.type === 'muDelete' && x.muId === id).length;
    const posesOf = (session: number, id: number) => m.client().sent
      .flatMap((x) => (x.type === 'frame' && x.session === session ? x.mus : []))
      .filter((p) => p.muId === id);

    const early = w.spawn(); // a load already resting on the carrier before the mount
    early.node.name = 'EarlyLoad';
    makePassive(early);
    const first = await goLive(m, w);
    expect(first.meta.nodes.some((p) => p.endsWith('/EarlyLoad'))).toBe(false);
    expect(spawnsOf(first.session, early.id), 'passive load spawned once after the mount').toBe(1);

    const later = w.spawn();
    ticks(m);
    expect(spawnsOf(first.session, later.id)).toBe(1);
    makePassive(later); // active → passive: the same MU
    ticks(m, 8);
    expect(deletesOf(later.id), 'loading is no delete').toBe(0);
    expect(spawnsOf(first.session, later.id)).toBe(1);

    // The carrier moves: the loads' world poses follow.
    const before = posesOf(first.session, early.id).length;
    w.pre.position.x += 0.5;
    ticks(m);
    const moved = posesOf(first.session, early.id);
    expect(moved.length).toBeGreaterThan(before);
    early.node.updateWorldMatrix(true, false);
    expect(moved.at(-1)!.m[12]).toBeCloseTo(early.node.matrixWorld.elements[12], 5);
    expect(posesOf(first.session, later.id).length).toBeGreaterThan(0);

    // Unload `later`: active again, no second spawn, no delete.
    preMu.loadedMus.splice(preMu.loadedMus.indexOf(later), 1);
    w.mus.push(later);
    w.root.attach(later.node);
    ticks(m, 8);
    expect(spawnsOf(first.session, later.id)).toBe(1);
    expect(deletesOf(later.id)).toBe(0);

    // Remount: every live MU, the remaining passive load included, exactly once again.
    w.root.attach(w.arm);
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    m.client().mounted();
    const second = m.client().begins()[1];
    expect(spawnsOf(second.session, early.id), 'passive load spawned once after the remount').toBe(1);
    expect(spawnsOf(second.session, later.id)).toBe(1);
    ticks(m, 8);
    expect(spawnsOf(second.session, early.id)).toBe(1);
    m.plugin.setSyncEnabled(false);
  });

  it('re-parenting a drive child freezes at once (not one further frame), then exactly one remount re-spawns the MUs', async () => {
    const m = setup();
    const w = makeModel();
    const mu1 = w.spawn();
    const first = await goLive(m, w);
    const armIndex = indexOf(first, '/Arm');
    expect(armIndex).toBeGreaterThan(0);
    ticks(m);
    expect(m.client().sent.some((x) => x.type === 'frame')).toBe(true);
    const mark = m.client().sent.length;

    w.arm.position.x = 0.3;
    w.root.attach(w.arm); // re-parent in this tick
    ticks(m, 8);
    const oldFrames = m.client().sent.slice(mark).filter((x) => x.session === first.session);
    expect(oldFrames, 'no frame / spawn / delete of the frozen generation').toEqual([]);
    expect(m.store.state.status).toBe('remounting');
    expect(m.store.state.remountReason).toBe('re-parent: Arm');
    expect(m.store.state.message).toContain('Structure changed (re-parent: Arm)');

    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    await sleep(DEBOUNCE_MS * 3);
    expect(m.client().begins(), 'exactly one remount').toHaveLength(2);
    const second = m.client().begins()[1];
    expect(second.session).toBeGreaterThan(first.session);
    expect(indexOf(second, '/Cell/Arm')).toBeGreaterThan(0); // the new hierarchy
    m.client().mounted();
    expect(m.store.state.status).toBe('live');
    // Kit lost the spawned MUs with the old wrapper: they come again.
    const spawns = m.client().sent.filter((x) => x.type === 'muSpawn' && x.session === second.session);
    expect(spawns.map((s) => (s as Extract<Msg, { type: 'muSpawn' }>).muId)).toEqual([mu1.id]);
    expect(m.store.state.lastMountTimings?.cause).toBe('structure');
    expect(m.store.state.remounts).toBe(1);
    m.plugin.setSyncEnabled(false);
  });

  it('a series of changes extends the debounce: one remount, at least the debounce after the LAST change', async () => {
    const m = setup({ debounceMs: 120 });
    const w = makeModel();
    await goLive(m, w);
    w.station.name = 'Station2';
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 2000 });
    let last = performance.now();
    for (let i = 0; i < 3; i++) {
      await sleep(50);
      w.line.add(new Object3D());
      last = performance.now();
    }
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000, interval: 5 });
    const elapsed = performance.now() - last;
    expect(elapsed).toBeGreaterThanOrEqual(120 - CHECK_MS - 5);
    await sleep(300);
    expect(m.client().begins()).toHaveLength(2);
    m.plugin.setSyncEnabled(false);
  });

  it('a change while paused (no tick at all) is found by the own timer; rename and new visible child remount', async () => {
    const m = setup();
    const w = makeModel();
    await goLive(m, w);
    w.station.name = 'Renamed'; // no onFixedUpdatePost from here on
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 2000 });
    expect(m.store.state.remountReason).toBe('rename: Station');
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(2), { timeout: 5000 });
    m.client().mounted();
    expect(m.store.state.status).toBe('live');

    w.line.add(new Object3D());
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 2000 });
    expect(m.store.state.remountReason).toBe('child added: Line');
    await vi.waitFor(() => expect(m.client().begins()).toHaveLength(3), { timeout: 5000 });
    m.plugin.setSyncEnabled(false);
  });

  it('editor-structure-changed checks at once, without waiting for the timer', async () => {
    const m = setup({ checkMs: 60_000 });
    const w = makeModel();
    await goLive(m, w);
    w.station.name = 'Moved';
    expect(m.store.state.status).toBe('live');
    m.emit('editor-structure-changed');
    expect(m.store.state.status).toBe('remounting');
    m.plugin.setSyncEnabled(false);
  });

  it('sync off and model clear cancel the pending remount', async () => {
    const m = setup();
    const w = makeModel();
    await goLive(m, w);
    w.station.name = 'X';
    await vi.waitFor(() => expect(m.store.state.status).toBe('remounting'), { timeout: 2000 });
    m.plugin.setSyncEnabled(false);
    await sleep(DEBOUNCE_MS * 3);
    expect(m.client().begins()).toHaveLength(1);
    expect(m.store.state.status).toBe('off');

    const m2 = setup();
    const w2 = makeModel();
    await goLive(m2, w2);
    w2.station.name = 'X';
    await vi.waitFor(() => expect(m2.store.state.status).toBe('remounting'), { timeout: 2000 });
    m2.plugin.onModelCleared();
    await sleep(DEBOUNCE_MS * 3);
    expect(m2.client().begins()).toHaveLength(1);
    expect(m2.store.state.status).toBe('mounting'); // "Waiting for a model"
    m2.plugin.setSyncEnabled(false);
  });

  it('reports lastMountTimings and the prim counts of the mount', async () => {
    let t = 1000;
    const m = setup({}, () => (t += 5)); // deterministic clock
    const w = makeModel();
    await goLive(m, w);
    const tm = m.store.state.lastMountTimings!;
    expect(tm).toMatchObject({ cause: 'initial', prims: m.store.state.prims!.total });
    for (const k of ['sceneReadyMs', 'exportMs', 'compressMs', 'uploadMs', 'ackMs', 'totalMs'] as const) {
      expect(tm[k], k).toBeGreaterThanOrEqual(0);
    }
    expect(tm.totalMs).toBeGreaterThanOrEqual(tm.exportMs + tm.compressMs + tm.uploadMs + tm.ackMs);
    expect(tm.rawBytes).toBeGreaterThan(0);
    expect(tm.compressedBytes).toBe(tm.rawBytes); // identity in this test
    expect(m.store.state.prims!.withAddress).toBe(0); // no registry in this model
    m.plugin.setSyncEnabled(false);
  });
});

