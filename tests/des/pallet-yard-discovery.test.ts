// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.10 — plugin owners stay out of the legacy DES discovery (SOL R2 #1),
// plus the bind of the REAL scene (CP1, CP1d-b placements):
//   - owners are reused on a rebind with the same manager and created anew after
//     a manager change;
//   - scenes/PalletYard.glb loaded like the viewer (placements materialised), with
//     the plugin's `bakeClaims()` (now only the floor slots) and without any: Slot_P*,
//     every stacker's ForkAnchor (authored BakeRole in the LIBRARY asset, b1-0) and
//     every conveyor's belt + sensor survive, a real DESRunner binds all six
//     conveyors (incl. the two ConveyorOut_V*), both sources and sinks and the three
//     stackers; every conveyor's stich tag resolves.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { DES } from '@rv/plugins/des/rv-des-api';
// The viewer registers every library behaviour; this test imports the four the yard binds.
import '@rv/behaviors/Conveyor';
import '@rv/behaviors/Source';
import '@rv/behaviors/Sink';
import '@rv/behaviors/Agv';
import { getProblems } from '../../src/core/hmi/problems-store';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { CarrierOwner, PluginOwnerRegistry } from '@rv/plugins/des/fleet/des-handover';
import { bindDesYard, palletYardBakeClaims, startDesRuntime } from '@rv/plugins/models/PalletYard/yard-runtime';
import { readStationTag } from '../../src/plugins/models/PalletYard/layout';
/** Node name without the loader's file-wide duplicate suffix (test-side scan only). */
const baseName = (n: { name: string }): string => n.name.replace(/_\d+$/, '');
import { PALLET_YARD_CONFIG, palletYardClaimPaths } from '../../src/plugins/models/PalletYard/layout';
import { buildYard, type YardWorld } from './pallet-yard-harness';
import { PALLET_YARD_URL, loadPalletYardScene, nodeNamed, type LoadedYardScene } from './pallet-yard-scene-load';

let w: YardWorld | null = null;
afterEach(() => { w?.dispose(); w = null; DES.setManager(null); });

describe('PalletYard plugin owner registration (9.10)', () => {
  it('owners stay registered on the runner manager', () => {
    w = buildYard('fastforward');
    w.runTo(200);
    const mgr = w.runner.getManager();
    DES.setManager(mgr);
    const owners = w.owners.all();
    expect(owners.length).toBe(2 + 3 + 6);              // 2 end probes, 3 carriers, 6 floor slots
    for (const o of owners) {
      expect(Object.prototype.hasOwnProperty.call(o.node.userData, '_desComponent'), o.node.name).toBe(false);
      expect(mgr.getComponentByEntityId(o.entityId)).toBe(o);
    }
  });

  it('owners are reused on a rebind with the same manager and created anew after a manager change', () => {
    w = buildYard('fastforward');
    const anchor = w.vehicle('Stapler_1').anchor;
    const before = w.backend.carrierOf('Stapler_1')!;
    const created = w.owners.created;
    // rebind on the same runner / manager
    w.rt.dispose();
    const drives = w.rt.vehicleIds.map((id) => w!.vehicle(id).lift);
    const r = bindDesYard({ runner: w.runner, root: w.root, drives, owners: w.owners });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backend.carrierOf('Stapler_1')).toBe(before);
    expect(w.owners.created).toBe(created);
    w.backend = r.backend;
    w.rt = startDesRuntime(r.backend, () => {});
    // a different manager (new runner) → a new owner, registered with THAT manager
    const other = new DESRunner({ subMode: 'fastforward' });
    const reg = w.owners;
    const fresh = reg.get(CarrierOwner, anchor, other.getManager());
    expect(fresh).not.toBe(before);
    expect(other.getManager().getComponentByEntityId(fresh.entityId)).toBe(fresh);
    expect(Object.prototype.hasOwnProperty.call(anchor.userData, '_desComponent')).toBe(false);
    other.dispose();
    // a fresh registry on the same manager also gets fresh owners (nothing global)
    expect(new PluginOwnerRegistry().get(CarrierOwner, anchor, w.runner.getManager())).not.toBe(before);
  });
});

// ── The real scene (placements + bind) ──────────────────────────────────────

const AVAILABLE = await devAssetAvailable(PALLET_YARD_URL);
const CONVEYORS = ['Conveyor_A1', 'Conveyor_A2', 'Conveyor_V1', 'Conveyor_V2', 'ConveyorOut_V1', 'ConveyorOut_V2'];
const isUnder = (n: Object3D, a: Object3D): boolean => { for (let c: Object3D | null = n; c; c = c.parent) if (c === a) return true; return false; };

/** The real scene (placements materialised) + a started FastForward runner over it. */
async function loadAndStart(claims: boolean): Promise<{ y: LoadedYardScene; runner: DESRunner }> {
  const y = await loadPalletYardScene({
    before: claims ? (v) => v.use({ id: 'pallet-yard-claims', bakeClaims: () => palletYardBakeClaims() } as never) : undefined,
  });
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 1e6 });
  runner.start([], { root: y.root, host: y.host as never });
  return { y, runner };
}

function expectSceneBinds(y: LoadedYardScene, runner: DESRunner): void {
  const root = y.root;
  const names = new Map<string, Object3D[]>();
  root.traverse((n) => { const b = baseName(n); names.set(b, [...(names.get(b) ?? []), n]); });
  for (const s of ['Slot_P1', 'Slot_P2', 'Slot_P3', 'Slot_P4', 'Slot_P5', 'Slot_P6']) expect(names.get(s), s).toHaveLength(1);
  for (const v of ['Stapler_1', 'Stapler_2', 'Stapler_3']) {
    const vroot = nodeNamed(root, v);
    expect(vroot, v).toBeTruthy();
    let anchors = 0;
    vroot!.traverse((n) => { if (baseName(n) === 'ForkAnchor') anchors++; });
    expect(anchors, `${v}: ForkAnchor (library BakeRole)`).toBe(1);
  }
  for (const c of CONVEYORS) {
    const node = nodeNamed(root, c);
    expect(node, c).toBeTruthy();
    const kids: string[] = [];
    node!.traverse((k) => kids.push(baseName(k)));
    expect(kids, c).toContain('Transport-Z');
    expect(kids, c).toContain('Sensor');
    // one conveyor instance bound on the placement (reference node or its asset root)
    expect(runner.liveInstances.filter((i) => i.def.kind === 'conveyor' && isUnder(i.adapter.node, node!)), `${c} bound`).toHaveLength(1);
  }
  for (const id of ['A1', 'A2', 'V1', 'V2']) {
    const tag = readStationTag(nodeNamed(root, `Conveyor_${id}`)!);
    expect(tag, `Conveyor_${id} tag`).toEqual({ Station: id, StichPathId: `Stich_${id}` });
  }
}

describe.skipIf(!AVAILABLE)('PalletYard real scene with the plugin bake claims: placements + DES bind (CP1d-b)', () => {
  let y: LoadedYardScene;
  let runner: DESRunner;
  beforeAll(async () => { ({ y, runner } = await loadAndStart(true)); }, 180_000);
  afterAll(() => { runner?.dispose(); y?.dispose(); });

  it('claimed / library-kept nodes survive; all six conveyors, both sources and sinks and the stackers bind', () => {
    expectSceneBinds(y, runner);
    // What the runner's port graph wired by itself BEFORE the plugin's explicit topology
    // (Snap / typed distance, plan-633) — diagnostics for the plan report.
    const nextOf = (name: string): string => {
      const node = nodeNamed(y.root, name)!;
      const a = runner.liveInstances.find((i) => isUnder(i.adapter.node, node))?.adapter;
      return a ? a.nextComponents.map((c) => c.node.name).join('|') || '-' : '?';
    };
    console.info(`[b1] port graph before bindDesYard: ${['Pallet_A1', 'Pallet_A2', ...CONVEYORS].map((n) => `${n}->${nextOf(n)}`).join(', ')}`);
    console.info(`[b1] conveyor adapter nodes: ${runner.liveInstances.filter((i) => i.def.kind === 'conveyor').map((i) => i.adapter.node.name).join(', ')}`);
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
    expect(r.ok ? [] : r.missing).toEqual([]);
    if (!r.ok) return;
    // the plugin's explicit topology after the bind: source → output, input → out → sink
    expect(r.backend.sourceOf('A1')!.nextComponents).toEqual([r.backend.outputConveyor('A1')]);
    expect(r.backend.inputConveyor('V1')!.nextComponents).toEqual([r.backend.conveyorOutOf('V1')]);
    expect(r.backend.conveyorOutOf('V1')!.nextComponents).toEqual([r.backend.sinkOf('V1')]);
    r.backend.dispose();
    // The plugin claims nothing inside a placement any more: no claim-not-applicable entry.
    expect(getProblems().filter((p) => p.code === 'plugin-claim-not-applicable').map((p) => p.id)).toEqual([]);
  });

  it('a stich tag that does not resolve in the PathNetwork is a missing bind item', () => {
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry(), paths: { get: () => null } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect([...r.missing].sort()).toEqual(['A1', 'A2', 'V1', 'V2'].map((id) => `Conveyor_${id}: stich Stich_${id} (Path)`));
  });
});

describe.skipIf(!AVAILABLE)('PalletYard real scene WITHOUT plugin bake claims (authored BakeRole, CP1c / CP1d-b)', () => {
  let y: LoadedYardScene;
  let runner: DESRunner;
  beforeAll(async () => { ({ y, runner } = await loadAndStart(false)); }, 180_000);
  afterAll(() => { runner?.dispose(); y?.dispose(); });

  it('every node the plugin needs survives the bake and bindDesYard is ok', () => {
    const lost = palletYardClaimPaths(PALLET_YARD_CONFIG, 'PalletYardRoot').filter((p) => !nodeNamed(y.root, p.split('/').pop()!));
    expect(lost).toEqual([]);
    expectSceneBinds(y, runner);
    const r = bindDesYard({ runner, root: y.root, drives: y.drives, owners: new PluginOwnerRegistry() });
    expect(r.ok ? [] : r.missing).toEqual([]);
    if (r.ok) r.backend.dispose();
  });
});
