// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 4 CP1c-Nachtrag / plan-631 9.5 — hand-over pose of the REAL
// scenes/PalletYard.glb, DES Animated, FastForward and Animated → FF → Animated: no
// pallet jumps when it changes its owner — WITHOUT infeed stands (plan-631 Phase 2: the
// conveyor takes the pallet over at its set-down pose, `transferMUWithPose`).
//   (a) drop on a shipping input (V1, V2): the pose the conveyor's transit starts
//       from (the tween window `from`, i.e. the engine's take-over pose) equals the
//       pallet pose on the fork just before the hand-over;
//   (s) production source (A1, A2): the transit of a produced pallet starts at the
//       source's spawn pose on the belt head (the Source node = where its visual spawns);
//   (b) pick at a production output (A1, A2): the fork seat (ForkAnchor, pallet
//       centre) equals the pose the pallet waits at at the belt end (the transit
//       window's `to`);
//   (c) floor slots: store = fork seat vs slot pose, retrieve = slot pose vs fork seat.
// Tolerance: ≤ 10 mm in x/z, ≤ 5 mm in y.
// Fork seat: Animated = the real ForkAnchor world pose (the vehicle node is written every
// frame — this also proves the dock depth); FastForward writes no vehicle transform until
// FF exit, so there the seat is the LOGICAL one the visual lands on: the stich's handling
// seat (layout.ts handlingPose) at the lift's current height.
// The pallet waits at the belt end with its leading edge at the belt exit (Transport-Z
// mesh bounds, layout.ts CONVEYOR_END_SEAT_Z_M); drop and spawn sit on the belt head
// (CONVEYOR_HEAD_SEAT_Z_M) and the conveyor takes the pallet over THERE (plan-631).
// Since CP1d-b the scene is loaded through the viewer (stacker / conveyor placements).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vector3, type Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { clearShared } from '../helpers/agv-harness';
import { PluginOwnerRegistry, muNode } from '@rv/plugins/des/fleet/des-handover';
import {
  FORK_TOP_HOME_MM, PALLET_SEAT_M, PALLET_YARD_CONFIG, STATION_GEOMETRY, handlingPose,
} from '../../src/plugins/models/PalletYard/layout';
import { bindDesYard, startDesRuntime, type YardRun } from '@rv/plugins/models/PalletYard/yard-runtime';
import type { DesHandoverBackend } from '@rv/plugins/des/fleet/des-handover';
import { PALLET_YARD_URL as URL, loadPalletYardScene, type LoadedYardScene } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(URL);

/** `mixed` = Animated 0..500 s, FastForward 500..1000 s, Animated 1000..1500 s. */
type Mode = 'animated' | 'fastforward' | 'mixed';
const MODES: Mode[] = ['animated', 'fastforward', 'mixed'];
interface Sample { kind: 'drop' | 'pick' | 'store' | 'retrieve' | 'produce'; station: string; vehicle: string; t: number; dxz: number; dy: number; a: number[]; b: number[] }

const XZ_MM = 10, Y_MM = 5;
/** Sim seconds: both shipping pauses (V1 300..600, V2 900..1200) fill and empty the floor slots. */
const RUN_SEC = 1500;
const fmt = (v: number[]): string => v.map((x) => x.toFixed(3)).join(', ');

function measure(kind: Sample['kind'], station: string, vehicle: string, t: number, a: Vector3, b: Vector3): Sample {
  return {
    kind, station, vehicle, t,
    dxz: Math.hypot(a.x - b.x, a.z - b.z) * 1000, dy: Math.abs(a.y - b.y) * 1000,
    a: [a.x, a.y, a.z], b: [b.x, b.y, b.z],
  };
}

async function runYard(mode: Mode): Promise<{ samples: Sample[]; rt: YardRun; runner: DESRunner; y: LoadedYardScene }> {
  const y = await loadPalletYardScene();
  const scene = y.scene;
  const root: Object3D = y.root;
  const runner = new DESRunner(mode === 'fastforward' ? { subMode: 'fastforward', durationSeconds: 1e7 } : { subMode: 'animated' });
  runner.start([], { root, host: y.host as never });
  const r = bindDesYard({ runner, root, drives: y.drives, owners: new PluginOwnerRegistry() });
  if (!r.ok) throw new Error(`bind: ${r.missing.join(', ')}`);
  const be: DesHandoverBackend = r.backend;
  const rt = startDesRuntime(be, () => {});
  scene.updateMatrixWorld();
  const tweens = runner.getTweenRegistry();
  const manager = runner.getManager();
  const now = (): number => manager.currentTime;
  const samples: Sample[] = [];

  /** World pose of the fork seat (pallet origin on the fork) of `vehicle` standing in the stich of `station`. */
  const forkSeat = (vehicle: string, station: string): Vector3 => {
    if (runner.subMode === 'fastforward') {
      const { seat } = handlingPose(STATION_GEOMETRY.find((g) => g.id === station)!);
      return new Vector3(seat[0], (FORK_TOP_HOME_MM + be.lift.position(vehicle)) / 1000 - PALLET_SEAT_M, seat[1]);
    }
    const c = be.carrierOf(vehicle)!;
    scene.updateMatrixWorld();   // as the viewer's render loop (baked nodes: no per-call parent walk)
    return c.node.localToWorld(c.seatPosition.clone());
  };
  const slotPose = (slot: string): Vector3 => {
    const n = be.slotOwner(slot)!.node;
    scene.updateMatrixWorld();
    return n.getWorldPosition(new Vector3());
  };

  // (a) drop: fork seat before ↔ transit start after.
  const putOnHead = be.putOnHead.bind(be);
  be.putOnHead = (vehicle, input) => {
    const before = forkSeat(vehicle, input);
    const mu = be.carrierOf(vehicle)!.held;
    const ok = putOnHead(vehicle, input);
    if (ok && mu) {
      const w = tweens.activeWindowForMu(mu.id, now());
      if (!w) throw new Error(`drop ${input}: no transit window for MU ${mu.id}`);
      samples.push(measure('drop', input, vehicle, now(), before, w.from));
    }
    return ok;
  };
  // (b) pick: the pose the pallet waits at (transit window end) ↔ fork seat at the take.
  const waitPose = new Map<number, Vector3>();
  const onReady = be.onPalletReady;
  be.onPalletReady = (output, pallet) => {
    const id = Number(pallet);
    const w = tweens.activeWindowForMu(id, now());
    const node = muNode(manager.getMU(id) as DESMU | null);
    const p = w ? w.to : node ? node.getWorldPosition(new Vector3()) : null;
    if (!p) throw new Error(`pick ${output}: no wait pose for MU ${id}`);
    waitPose.set(id, p);
    onReady?.(output, pallet);
  };
  const handler = be.setPickHandler((output, data, pallet) => {
    const wait = waitPose.get(Number(pallet));
    if (!wait) throw new Error(`pick ${output}: MU ${pallet} was never reported waiting`);
    samples.push(measure('pick', output, data.v, now(), wait, forkSeat(data.v, output)));
    handler(output, data, pallet);
  });
  // (s) production: the source's spawn pose (its node) ↔ transit start of the produced pallet.
  const produce = be.produce.bind(be);
  be.produce = (output) => {
    const conv = be.outputConveyor(output)!;
    const before = new Set(conv.self.mus.map((m) => m.id));
    scene.updateMatrixWorld();
    const spawnAt = be.sourceOf(output)!.node.getWorldPosition(new Vector3());
    const ok = produce(output);
    if (ok) {
      const mu = conv.self.mus.find((m) => !before.has(m.id));
      if (!mu) throw new Error(`produce ${output}: no new MU on the head`);
      const w = tweens.activeWindowForMu(mu.id, now());
      if (!w) throw new Error(`produce ${output}: no transit window for MU ${mu.id}`);
      samples.push(measure('produce', output, '-', now(), spawnAt, w.from));
    }
    return ok;
  };
  // (c) floor slots.
  const store = be.store.bind(be);
  be.store = (vehicle, slot) => {
    const before = forkSeat(vehicle, slot);
    const ok = store(vehicle, slot);
    if (ok) samples.push(measure('store', slot, vehicle, now(), before, slotPose(slot)));
    return ok;
  };
  const retrieve = be.retrieve.bind(be);
  be.retrieve = (slot, vehicle) => {
    const before = slotPose(slot);
    const id = retrieve(slot, vehicle);
    if (id !== null) samples.push(measure('retrieve', slot, vehicle, now(), before, forkSeat(vehicle, slot)));
    return id;
  };

  const runFF = (from: number, to: number): void => {
    for (let t = from + 1; t <= to; t++) {
      be.clock.schedule(t, () => {});
      manager.processUpTo(t, 1e8);
      rt.frame();
    }
  };
  const runAnimated = (to: number): void => {
    const dt = 1 / 20;
    while (runner.renderClock < to - 1e-9) { runner.tick(dt); runner.lateTick(dt); rt.frame(); }
  };
  if (mode === 'fastforward') runFF(0, RUN_SEC);
  else if (mode === 'animated') runAnimated(RUN_SEC);
  else {
    runAnimated(RUN_SEC / 3);
    runner.setSubMode('fastforward');
    runFF(Math.round(manager.currentTime), (2 * RUN_SEC) / 3);
    runner.setSubMode('animated');
    runAnimated(RUN_SEC);
  }
  return { samples, rt, runner, y };
}

describe.skipIf(!AVAILABLE)('PalletYard real scene: hand-over without a jump (CP1c-Nachtrag)', () => {
  const results = new Map<Mode, Sample[]>();

  beforeAll(async () => {
    for (const mode of MODES) {
      const r = await runYard(mode);
      results.set(mode, r.samples);
      r.rt.dispose(); r.runner.dispose(); r.y.dispose();
    }
  }, 900_000);
  afterAll(() => { clearShared(); });

  for (const mode of MODES) {
    it(`[${mode}] every drop / pick / produce / store / retrieve keeps the pallet pose (≤ ${XZ_MM} mm x/z, ≤ ${Y_MM} mm y)`, () => {
      const s = results.get(mode)!;
      const by = new Map<string, Sample[]>();
      for (const x of s) by.set(`${x.kind} ${x.station}`, [...(by.get(`${x.kind} ${x.station}`) ?? []), x]);
      for (const [k, l] of [...by].sort()) {
        const w = l.reduce((m, x) => (x.dxz > m.dxz ? x : m));
        const wy = Math.max(...l.map((x) => x.dy));
        console.log(`[transfer-pose ${mode}] ${k}: n=${l.length} max xz ${w.dxz.toFixed(1)} mm, max y ${wy.toFixed(1)} mm (${w.vehicle} t=${w.t.toFixed(1)} a=[${fmt(w.a)}] b=[${fmt(w.b)}])`);
      }
      // Every hand-over point was exercised: both drops, both picks, at least two floor slots each way.
      for (const id of ['V1', 'V2']) expect(by.has(`drop ${id}`), `drop ${id}`).toBe(true);
      for (const id of ['A1', 'A2']) expect(by.has(`pick ${id}`), `pick ${id}`).toBe(true);
      for (const id of ['A1', 'A2']) expect(by.has(`produce ${id}`), `produce ${id}`).toBe(true);
      expect(s.filter((x) => x.kind === 'store').length, 'stores').toBeGreaterThanOrEqual(2);
      expect(s.filter((x) => x.kind === 'retrieve').length, 'retrieves').toBeGreaterThanOrEqual(2);
      for (const x of s) {
        const what = `${x.kind} ${x.station} ${x.vehicle} t=${x.t.toFixed(1)} a=[${fmt(x.a)}] b=[${fmt(x.b)}]`;
        expect(x.dxz, what).toBeLessThanOrEqual(XZ_MM);
        expect(x.dy, what).toBeLessThanOrEqual(Y_MM);
      }
    });
  }

  it('the configuration covers the stations measured', () => {
    expect(PALLET_YARD_CONFIG.stations.filter((x) => x.kind === 'drop').map((x) => x.id)).toEqual(['V1', 'V2']);
    expect(PALLET_YARD_CONFIG.stations.filter((x) => x.kind === 'pick').map((x) => x.id)).toEqual(['A1', 'A2']);
  });
});
