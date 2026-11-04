// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 Phase 4 CP1c — the REAL scenes/PalletYard.glb in DES Animated, loaded like
// the viewer (bake WITHOUT plugin claims — the authored rv.BakeRole carries it; since
// CP1d-b through the viewer, so the stacker / conveyor placements materialise):
//   - a produced pallet runs visibly along its output belt: strictly rising z over
//     >= 3 snapshots, its bottom on the roller top (± 5 mm);
//   - a delivered pallet runs Conveyor_V* (through the scanner arch) and then
//     ConveyorOut_*, >= 3 snapshots each, rising z (flow local +Z), bottom on the
//     rollers, and is taken by the sink only at the end of ConveyorOut;
//   - the cartons of EuropalletLoaded travel as one unit with the pallet: no carton
//     pose deviates by more than 5 mm / 1 deg relative to the pallet, ever.
// Cause fixed in CP1c: the Conveyor's DES transit timer reads the belt length and
// entry/exit from the Transport-Z mesh bounds (src/behaviors/_shared/transit-timing.ts);
// with the belt merged away by the bake those bounds were empty — pallet at the belt
// origin (y = 0), ~0 s transit. The generator now authors Transport-Z as a chunk.
import { expectNoWaitTimeouts } from './pallet-yard-soak-bounds';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Box3, Matrix4, Quaternion, Vector3, type Object3D, type Scene } from 'three';
import { getMuSource } from '@rv/core/engine/rv-source';
import type { DESMU } from '@rv/plugins/des/rv-des-mu';
import { isUnderScope as isUnder } from '@rv/core/engine/rv-reference-resolver';
import { DESRunner } from '@rv/plugins/des/des-runner';
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, startDesRuntime, type YardRun } from '@rv/plugins/models/PalletYard/yard-runtime';
import { PALLET_YARD_URL as URL, loadPalletYardScene, nodeNamed, type LoadedYardScene } from './pallet-yard-scene-load';

const AVAILABLE = await devAssetAvailable(URL);

interface Snap { t: number; parent: string; pos: Vector3; bottom: number; cartonDev: { mm: number; deg: number } }

describe.skipIf(!AVAILABLE)('PalletYard real scene: belt transit, delivery line, carton load (CP1c)', () => {
  let scene: Scene;
  let y: LoadedYardScene;
  let root: Object3D;
  let runner: DESRunner;
  let rt: YardRun;
  const track = new Map<string, Snap[]>();     // pallet node UUID → snapshots
  const outputOf = new Map<string, string>();
  let shippedAt = -1;
  const lampCombos = new Set<string>();                 // Stapler_1 displayed lamp combos over the run
  const beltTop = new Map<string, { top: number; z0: number; z1: number; x: number }>();

  beforeAll(async () => {
    y = await loadPalletYardScene();
    scene = y.scene;
    root = y.root;
    runner = new DESRunner({ subMode: 'animated' });
    runner.start([], { root, host: y.host as never });
    const r = bindDesYard({ runner, root, drives: y.drives, owners: new PluginOwnerRegistry() });
    if (!r.ok) throw new Error(`bind: ${r.missing.join(', ')}`);
    rt = startDesRuntime(r.backend, () => {});
    scene.updateMatrixWorld();
    for (const c of ['Conveyor_A1', 'Conveyor_V1', 'ConveyorOut_V1']) {
      // (a placement: the belt hangs below the asset root, not directly below the reference node)
      const belt = nodeNamed(nodeNamed(root, c)!, 'Transport-Z')!;
      const b = new Box3().setFromObject(belt);
      beltTop.set(c, { top: b.max.y, z0: b.min.z, z1: b.max.z, x: (b.min.x + b.max.x) / 2 });
    }
    const inv = new Matrix4(), m = new Matrix4(), t = new Vector3(), q = new Quaternion(), s = new Vector3();
    const sourceRoots = ['A1', 'A2'].map(id => ({ id, node: nodeNamed(root, 'Pallet_' + id)! }));
    const manager = runner.getManager();
    const reference = new Map<string, Matrix4>();          // carton pose in the pallet frame at the first sight
    for (let k = 0; k < 60 * 130; k++) {
      runner.tick(1 / 60); runner.lateTick(1 / 60); rt.frame(); expectNoWaitTimeouts(rt);
      scene.updateMatrixWorld();                            // the viewer's render loop does this every frame
      if (shippedAt < 0 && rt.counters.delivered > 0 && r.backend.sinkOf('V1')!.totalProcessed + r.backend.sinkOf('V2')!.totalProcessed > 0) shippedAt = runner.renderClock;
      if (k % 30 !== 0) continue;
      {
        const lit: string[] = [];
        r.backend.vehicleNode('Stapler_1')!.traverse((n) => {
          const l = (n.userData as { _rvLamp?: { isLit(): boolean } })._rvLamp;
          if (l) lit.push(`${n.name.replace(/_\d+$/, '')}=${l.isLit() ? 1 : 0}`);
        });
        lampCombos.add(lit.sort().join(' '));
      }
      for (let id = 0; id < manager.muCount; id++) {
        const mu = manager.getMU(id) as DESMU | null;
        const visual = mu?.visual;
        if (!visual || visual.isInstanced) continue;
        const source = getMuSource(visual);
        const output = source && sourceRoots.find(r => isUnder(source.node, r.node));
        const n = visual.node;
        if (!output || !n.visible) continue;
        outputOf.set(n.uuid, output.id);
        inv.copy(n.matrixWorld).invert();
        let mm = 0, deg = 0;
        for (const c of n.children) {
          m.multiplyMatrices(inv, c.matrixWorld);
          const key = `${n.uuid}/${c.uuid}`;
          const ref = reference.get(key);
          if (!ref) { reference.set(key, m.clone()); continue; }
          m.decompose(t, q, s);
          const t0 = new Vector3(), q0 = new Quaternion();
          ref.decompose(t0, q0, s);
          mm = Math.max(mm, t.distanceTo(t0) * 1000);
          deg = Math.max(deg, q.angleTo(q0) * 180 / Math.PI);
        }
        const list = track.get(n.uuid) ?? [];
        list.push({
          t: runner.renderClock, parent: n.parent?.name ?? '', pos: n.getWorldPosition(new Vector3()),
          bottom: new Box3().setFromObject(n).min.y, cartonDev: { mm, deg },
        });
        track.set(n.uuid, list);
      }
    }
  }, 300_000);
  afterAll(() => { rt?.dispose(); runner?.dispose(); y?.dispose(); });

  /** Snapshots of a pallet UUID while on the belt `conveyor` (not on a fork), in time order. */
  const onBelt = (name: string, conveyor: string): Snap[] => {
    const b = beltTop.get(conveyor)!;
    return (track.get(name) ?? []).filter((s) => !/^ForkAnchor/.test(s.parent) && s.pos.z >= b.z0 - 0.05 && s.pos.z <= b.z1 + 0.05
      && Math.abs(s.pos.x - b.x) < 0.05); // belt centre (the reference node of a placement is not the conveyor centre)
  };
  const rising = (s: Snap[]): boolean => s.every((x, i) => i === 0 || x.pos.z > s[i - 1].pos.z + 1e-4);

  it('a produced pallet runs head → end of Conveyor_A1, bottom on the roller top', () => {
    const firstA1 = [...track.keys()].find(id => outputOf.get(id) === 'A1');
    expect(firstA1, 'first pallet produced by the source under Pallet_A1').toBeDefined();
    const s = onBelt(firstA1!, 'Conveyor_A1');
    const moving = s.filter((x, i) => i > 0 && x.pos.z > s[i - 1].pos.z + 1e-4);
    expect(moving.length, JSON.stringify(s.map((x) => x.pos.z.toFixed(2)))).toBeGreaterThanOrEqual(3);
    expect(rising([s[0], ...moving])).toBe(true);
    const top = beltTop.get('Conveyor_A1')!.top;
    for (const x of s) expect(Math.abs(x.bottom - top) * 1000, `t=${x.t}`).toBeLessThan(5);
  });

  it('the delivered pallet runs Conveyor_V1 then ConveyorOut_V1 (rising z, on the rollers) and only then reaches the sink', () => {
    const name = [...track.keys()].find((n) => onBelt(n, 'ConveyorOut_V1').length > 0);
    expect(name, 'a pallet on ConveyorOut_V1').toBeDefined();
    for (const c of ['Conveyor_V1', 'ConveyorOut_V1']) {
      const s = onBelt(name!, c);
      expect(s.length, c).toBeGreaterThanOrEqual(3);
      expect(rising(s), `${c}: ${s.map((x) => x.pos.z.toFixed(2)).join(' ')}`).toBe(true);
      const top = beltTop.get(c)!.top;
      for (const x of s) expect(Math.abs(x.bottom - top) * 1000, `${c} t=${x.t}`).toBeLessThan(5);
    }
    const v1 = onBelt(name!, 'Conveyor_V1'), out = onBelt(name!, 'ConveyorOut_V1');
    expect(v1[v1.length - 1].t).toBeLessThan(out[0].t);
    // the sink takes it at the END of ConveyorOut — not earlier
    expect(out[out.length - 1].pos.z).toBeGreaterThan(beltTop.get('ConveyorOut_V1')!.z1 - 0.9);
    expect(shippedAt).toBeGreaterThan(out[out.length - 1].t - 0.6);
  });

  it('the cartons travel as one unit with the pallet (≤ 5 mm, ≤ 1°) through pick, transport and drop', () => {
    let worst = { mm: 0, deg: 0 };
    let n = 0;
    for (const list of track.values()) for (const s of list) {
      n++;
      worst = { mm: Math.max(worst.mm, s.cartonDev.mm), deg: Math.max(worst.deg, s.cartonDev.deg) };
    }
    console.log(`[cartons] ${n} snapshots, worst deviation ${worst.mm.toFixed(2)} mm / ${worst.deg.toFixed(2)} deg`);
    expect(n).toBeGreaterThan(100);
    expect(worst.mm).toBeLessThan(5);
    expect(worst.deg).toBeLessThan(1);
    // the measured pallets went through a pick and a drop (fork parent seen, then a belt again)
    const cycled = [...track.values()].some((l) => l.some((s) => /^ForkAnchor/.test(s.parent)) && /^ForkAnchor/.test(l[0].parent) === false && !/^ForkAnchor/.test(l[l.length - 1].parent));
    expect(cycled).toBe(true);
  });

  it('the real stackers carry six status lamps each; the plugin drives them (Stapler_1 shows several states)', () => {
    for (const v of rt.vehicleIds) expect(rt.lamps.lampCount(v), v).toBe(6);
    console.log(`[lamps] Stapler_1 displayed combos: ${[...lampCombos].join(' | ')}`);
    expect(lampCombos.size).toBeGreaterThanOrEqual(3);
    expect([...lampCombos].some((c) => c.includes('Lamp_StackAmber=1'))).toBe(true);   // hand-over seen
    expect([...lampCombos].every((c) => c.includes('Lamp_StackRed=0'))).toBe(true);    // no fault
  });
});
