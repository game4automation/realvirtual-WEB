// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2239 Phase 3 review follow-ups — passive loads (plan-516) in the USD
 * live link, against the REAL transport manager (`loadMu`, `removeMU`, the
 * sink removal loop of `update()`):
 *
 * - a loaded pre-placed carrier taken out by `removeMU()` or by the sink path:
 *   every spawned load on it is deleted in Kit (the carrier's node leaves the
 *   scene, its loads ride along), and a later remount spawns none of them again;
 * - a PRE-PLACED load on a moving carrier is posed through the sampler's
 *   pre-placed path: its world pose follows the carrier, before and after a
 *   remount, and it is never spawned (document node).
 */

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene, Vector3 } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { loadMu } from '../src/core/engine/rv-mu-load';
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
const DEBOUNCE_MS = 50;

class FakeClient {
  sent: Msg[] = [];
  isReady = false;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() { /* ready() below */ }
  stop() { this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) { return wanted() && this.send(data); }
  ready(ack: LiveSyncAck = { type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }) { this.isReady = true; this.opts.onReady(ack); }
  begins(): Begin[] { return this.sent.filter((m): m is Begin => m.type === 'mountBegin'); }
  mounted() { const b = this.begins().at(-1)!; this.opts.onAck({ type: 'mounted', session: b.session }); }
}

const box = (name: string, s = 0.2) => { const m = new Mesh(new BoxGeometry(s, s, s), new MeshStandardMaterial()); m.name = name; return m; };

/** Cell { Axis(drive) { Arm }, Box(template), Source, Pallet(pre-placed carrier) { Cap(pre-placed load)? } } with a real manager. */
function makeModel(withPreplacedLoad = false) {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Cell';
  const axis = new Object3D(); axis.name = 'Axis';
  const arm = box('Arm', 0.1);
  const tpl = box('Box');
  const srcNode = new Object3D(); srcNode.name = 'Source';
  const pallet = box('Pallet', 0.4);
  scene.add(root);
  root.add(axis, tpl, srcNode, pallet);
  axis.add(arm);
  const tm = new RVTransportManager();
  tm.spawnEnabled = false; // update() runs the removal loop, the source spawns nothing by itself
  const source = new RVSource(srcNode);
  source.spawnParent = root;
  source.setTemplate(tpl);
  tpl.visible = false;
  tm.sources.push(source);
  const carrier = new RVMovingUnit(pallet, '', new Vector3(0.2, 0.2, 0.2));
  carrier.preplaced = true;
  tm.registerPreplaced(carrier, root);
  tm.activateMU(carrier);
  let cap: RVMovingUnit | null = null;
  if (withPreplacedLoad) {
    const capNode = box('Cap', 0.1);
    capNode.position.y = 0.3;
    pallet.add(capNode);
    cap = new RVMovingUnit(capNode, '', new Vector3(0.05, 0.05, 0.05));
    cap.preplaced = true;
    tm.registerPreplaced(cap, root);
    expect(loadMu(cap, carrier, tm)).toBe(true);
  }
  const spawnLoad = (): RVMovingUnit => {
    const mu = source.spawnMU() as RVMovingUnit;
    tm.activateMU(mu);
    expect(loadMu(mu, carrier, tm)).toBe(true); // passive: out of tm.mus, under the pallet
    return mu;
  };
  const model = { root, drives: [{ node: axis }], transportManager: tm } as unknown as LiveLinkModel;
  return { scene, root, arm, pallet, tm, carrier, cap, spawnLoad, model };
}

function setup() {
  const store = new LiveLinkStore({ port: 8775, token: 'tok', rateHz: 30 });
  let client: FakeClient | null = null;
  const plugin = new UsdLiveLinkPlugin({
    store,
    sessionModule,
    compress: async (b) => ({ bytes: b, encoding: 'identity' }),
    createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
    structureTiming: { checkMs: 10, debounceMs: DEBOUNCE_MS },
  });
  plugin.init({ on: () => () => {} } as unknown as RVViewer);
  return { store, plugin, client: () => client! };
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

function ticks(m: M, n = 4): void {
  for (let i = 0; i < n; i++) m.plugin.onFixedUpdatePost(1 / 30);
}

const spawns = (m: M, session: number, id: number) => m.client().sent
  .filter((x) => x.type === 'muSpawn' && x.session === session && x.muId === id).length;
const deletes = (m: M, session: number, id: number) => m.client().sent
  .filter((x) => x.type === 'muDelete' && x.session === session && x.muId === id).length;
const poses = (m: M, session: number, id: number) => m.client().sent
  .flatMap((x) => (x.type === 'frame' && x.session === session ? x.mus : []))
  .filter((p) => p.muId === id);

/** Remount by a structure change (re-parent of a drive child) and ack it. */
async function remount(m: M, w: W, expectedBegins: number): Promise<Begin> {
  w.root.attach(w.arm);
  await vi.waitFor(() => expect(m.client().begins()).toHaveLength(expectedBegins), { timeout: 5000 });
  m.client().mounted();
  expect(m.store.state.status).toBe('live');
  return m.client().begins()[expectedBegins - 1];
}

describe('usd-live-link passive loads with the real transport manager (plan-2239 review follow-ups)', () => {
  for (const path of ['removeMU', 'sink'] as const) {
    it(`a loaded pre-placed carrier taken out by ${path}: every spawned load deleted, none spawned again after a remount`, async () => {
      const m = setup();
      const w = makeModel();
      const early = w.spawnLoad(); // already resting on the carrier at the mount
      const first = await goLive(m, w);
      const late = w.spawnLoad();
      ticks(m);
      expect(spawns(m, first.session, early.id)).toBe(1);
      expect(spawns(m, first.session, late.id)).toBe(1);

      if (path === 'removeMU') w.tm.removeMU(w.carrier);
      else { w.carrier.markedForRemoval = true; w.tm.update(1 / 60); }
      expect(w.pallet.parent, 'the carrier node left the scene').toBeNull();
      expect(w.tm.preplacedMUs).toContain(w.carrier); // stays registered, keeps its loads
      expect(w.carrier.loadedMus.length).toBe(2);
      ticks(m);
      expect(deletes(m, first.session, early.id)).toBe(1);
      expect(deletes(m, first.session, late.id)).toBe(1);
      expect(deletes(m, first.session, w.carrier.id)).toBe(1);
      // A sunk / removed pre-placed MU is handled by muDelete, not by a structure remount.
      await new Promise((r) => setTimeout(r, DEBOUNCE_MS * 3));
      ticks(m);
      expect(m.client().begins()).toHaveLength(1);
      expect(m.store.state.status).toBe('live');
      expect(m.store.state.remounts).toBeUndefined();

      const second = await remount(m, w, 2);
      ticks(m, 8);
      expect(spawns(m, second.session, early.id), 'no respawn of a detached load').toBe(0);
      expect(spawns(m, second.session, late.id)).toBe(0);
      expect(poses(m, second.session, early.id)).toEqual([]);
      m.plugin.setSyncEnabled(false);
    });
  }

  it('a pre-placed load on a moving carrier: its world pose follows, before and after a remount, never spawned', async () => {
    const m = setup();
    const w = makeModel(true);
    const cap = w.cap!;
    const first = await goLive(m, w);
    expect(first.meta.nodes.some((p) => p.endsWith('/Pallet/Cap'))).toBe(true); // document node in the snapshot
    expect(first.meta.preplaced.map((p) => p.muId)).toContain(cap.id);

    const follow = (session: number) => {
      const before = poses(m, session, cap.id).length;
      w.pallet.position.x += 0.5;
      ticks(m);
      const after = poses(m, session, cap.id);
      expect(after.length).toBeGreaterThan(before);
      cap.node.updateWorldMatrix(true, false);
      expect(after.at(-1)!.m[12]).toBeCloseTo(cap.node.matrixWorld.elements[12], 5);
    };
    follow(first.session);
    expect(spawns(m, first.session, cap.id)).toBe(0);
    expect(deletes(m, first.session, cap.id)).toBe(0);

    const second = await remount(m, w, 2);
    follow(second.session);
    expect(spawns(m, second.session, cap.id)).toBe(0);
    expect(deletes(m, second.session, cap.id)).toBe(0);

    // The carrier leaves the scene: the load is no longer sampled (detached = gone, the pre-placed rule).
    w.tm.removeMU(w.carrier);
    ticks(m);
    const n = poses(m, second.session, cap.id).length;
    ticks(m, 8);
    expect(poses(m, second.session, cap.id).length).toBe(n);
    expect(spawns(m, second.session, cap.id)).toBe(0);
    m.plugin.setSyncEnabled(false);
  });
});
