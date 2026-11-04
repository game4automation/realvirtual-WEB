// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 §9.4 — PalletYard scene generator: path graph, stiches, vehicles,
// floor slots, sources, configuration == layout.ts, instance-local references,
// uniform scale up to ForkAnchor, idempotency (GLB + project.json), manifest
// row insertion, the AGVFactory refactor, and the scene name. Since CP1d-b the
// stackers and conveyors are library PLACEMENTS (AssetReference, no PlacementMeta):
// their content is checked in the library asset, their pose through the asset
// root's own transform (the reference node compensates it).
// The bound-scene part ("three lifts independent") is pallet-yard-scene.test.ts.
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { parsePathExtras } from '@rv/core/engine/rv-path';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { findShortMergeEntries } from '@rv/core/engine/rv-movement-authority';
import {
  DEFAULT_GLB, DEFAULT_MANIFEST, LIBRARY_DIR, PATH_NETWORK_NAME, ROOT_NAME, readGlb, writePalletYard, compensatedPose,
  pathBlockExtras, readPreservedSceneExtras, DEMO_AGV_DOWNTIME, DEMO_VARIANTS,
  type GltfDocumentLike, type GltfNodeLike,
} from '../../tools/des-examples/pallet-yard.mjs';
import {
  CONVEYOR_END_SEAT_Z_M, CONVEYOR_HEAD_SEAT_Z_M, CONVEYOR_LENGTH_M, CONVEYOR_OUT_LENGTH_M, CONVEYOR_SURFACE_M, COURSE, PALLET_YARD_CONFIG,
  SINK_BEHIND_END_M, STATION_GEOMETRY, VEHICLES,
  VEHICLE_LENGTH_MM, VEHICLE_WIDTH_MM, conveyorZOf, handlingPose, headSeatOf, junctionInId, junctionOfStation,
  junctionOutId, mergeZoneOf, palletYardBakeRoleOf, palletYardClaimPaths, stichArcId, stichPathId, turnPathOf,
  LIBRARY_ASSETS, STATION_TAG_KEY, type LibraryAsset,
} from '../../src/plugins/models/PalletYard/layout';

import { composeYard, composeYardBlocks, YARD_ASSETS } from '../../src/plugins/models/PalletYard/yard-compose';
import { buildYardModuleBytes } from '../../tools/des-examples/pallet-yard-modules.mjs';
import { pathExtras, round } from '../../src/plugins/models/PalletYard/path-dsl.mjs';

const YARD = composeYard(2);
const ASSETS = { ...LIBRARY_ASSETS, ...YARD_ASSETS };
const PROJECT = resolve(__dirname, '../../public/demo-realvirtual');
const WV = resolve(__dirname, '../..');
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

interface Entry { path: string; node: GltfNodeLike; parent: Entry | null }

function index(doc: GltfDocumentLike): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const walk = (n: GltfNodeLike, parent: Entry | null): void => {
    const path = parent ? `${parent.path}/${n.getName()}` : n.getName();
    const e = { path, node: n, parent };
    map.set(path, e);
    for (const c of n.listChildren()) walk(c, e);
  };
  for (const s of doc.getRoot().listScenes()) for (const n of s.listChildren()) walk(n, null);
  return map;
}
const rv = (n: GltfNodeLike): Record<string, any> => n.getExtras()?.realvirtual ?? {};

let doc: GltfDocumentLike;
let nodes: Map<string, Entry>;
/** The library assets the scene places, indexed (paths start with the asset root, e.g. `AGV_Stacker/Lift`). */
const lib = new Map<string, { doc: GltfDocumentLike; nodes: Map<string, Entry>; root: GltfNodeLike }>();
const libFile = (a: LibraryAsset): string => join(LIBRARY_DIR, ...a.path.replace(/^\/library\//, '').split('/'));

beforeAll(async () => {
  doc = await readGlb(DEFAULT_GLB);
  nodes = index(doc);
  for (const [k, a] of Object.entries(ASSETS)) {
    const d = await readGlb(libFile(a));
    lib.set(k, { doc: d, nodes: index(d), root: d.getRoot().listScenes()[0].listChildren()[0] });
  }
}, 120_000);

/** Where the asset content stands: reference translation + rotated asset root translation. */
function contentAt(ref: GltfNodeLike, asset: keyof typeof ASSETS): number[] {
  const t = ref.getTranslation();
  const r = ref.getRotation();
  const a = new Vector3().fromArray(lib.get(asset)!.root.getTranslation());
  a.applyQuaternion(new Quaternion(r[0], r[1], r[2], r[3]));
  return [t[0] + a.x, t[1] + a.y, t[2] + a.z];
}

/** Compose reference and library-root rotations; quaternion signs represent the same pose. */
function expectContentRotation(ref: GltfNodeLike, asset: keyof typeof ASSETS): void {
  const q = new Quaternion().fromArray(ref.getRotation())
    .multiply(new Quaternion().fromArray(lib.get(asset)!.root.getRotation())).normalize();
  expect(q.angleTo(new Quaternion())).toBeLessThanOrEqual(1e-6);
}

/** The node is a placement of `asset`: AssetReference, NodeId, no PlacementMeta (no pivot), no children. */
function expectPlacement(e: Entry | undefined, asset: keyof typeof ASSETS, what: string): void {
  expect(e, what).toBeTruthy();
  const x = rv(e!.node);
  expect(x.AssetReference, what).toEqual({ assetId: ASSETS[asset].assetId, path: ASSETS[asset].path.replace(/^\//, '') });
  expect(typeof x.NodeId, what).toBe('string');
  expect(x.PlacementMeta, `${what}: no PlacementMeta (no floor-centre pivot)`).toBeUndefined();
  expect(e!.node.listChildren(), `${what}: an empty reference node`).toEqual([]);
}

describe('PalletYard scene (GLB)', () => {
  it('has the path network and ONE PalletYardRoot carrying the configuration — equal to layout.ts', () => {
    // plan-628 8.6: the generated PathNetwork is a direct child of the model root (the
    // document's own network), ahead of PalletYardRoot; Course is gone.
    const roots = doc.getRoot().listScenes()[0].listChildren();
    expect(roots.map((r) => r.getName())).toEqual([PATH_NETWORK_NAME, ROOT_NAME]);
    // The demo document adds the AGV count and the AGV breakdowns (Experiments example).
    // No VehicleCount: the yard size keeps deriving the fleet until someone sets it (variants override it).
    const demo = { AgvMtbf: DEMO_AGV_DOWNTIME.mtbf, AgvMttr: DEMO_AGV_DOWNTIME.mttr, AgvDowntimeStochastic: DEMO_AGV_DOWNTIME.stochastic };
    expect(rv(roots[1]).PalletYard).toEqual({ ...PALLET_YARD_CONFIG, Size: 2, ...demo });
    expect(rv(roots[1]).PalletYard).toEqual({ ...YARD.config, Size: 2, ...demo });
    expect(nodes.has(ROOT_NAME + '/Course')).toBe(false);
  });

  it('writes every generated path under its composed block and marks only the generated paths, blocks and slots', () => {
    const network = nodes.get(PATH_NETWORK_NAME)!.node;
    expect(rv(network).Generated).toBeUndefined();
    const blocks = composeYardBlocks(YARD);
    expect(network.listChildren().map(n => n.getName())).toEqual(blocks.map(b => b.id));
    network.listChildren().forEach((bn, i) => {
      expect(rv(bn)).toEqual({ PathBlock: pathBlockExtras(blocks[i]), Generated: { owner: 'palletYard' } });
      expect(bn.listChildren().map(n => n.getName())).toEqual(blocks[i].paths);
      for (const n of bn.listChildren()) {
        const p = YARD.pathGraph.find(q => q.id === n.getName())!;
        expect(rv(n)).toEqual({ ...pathExtras(p), Generated: { owner: 'palletYard' } });
      }
    });
    const generated = [...nodes.values()].filter(e => rv(e.node).Generated?.owner === 'palletYard');
    expect(generated).toHaveLength(YARD.pathGraph.length + blocks.length + YARD.slots.length);
    // The AGV breakdowns carry their own owner (one per stacker, updated in place by the rebuild).
    const downtimes = [...nodes.values()].filter(e => rv(e.node).Generated?.owner === 'palletYardDowntime');
    expect(downtimes.map(e => e.node.getName())).toEqual(YARD.vehicles.map(v => `Downtime_${v.id}`));
  });

  it('places bundled module, end-cap and station geometry in composition order within each group', () => {
    const groups = [['YardModule', 'YardEndWest', 'YardEndEast'], ['YardSlotMarking', 'YardChargerStation', 'YardWaitMarking']];
    for (const assets of groups) {
      const placements = YARD.placements.filter(p => assets.includes(p.asset));
      const refs = [...nodes.values()].filter(e => placements.some(p => p.id === e.node.getName()));
      expect(refs.map(e => e.node.getName())).toEqual(placements.map(p => p.id));
      for (const p of placements) {
        const e = nodes.get(ROOT_NAME + '/' + p.id)!;
        expectPlacement(e, p.asset, p.id);
        contentAt(e.node, p.asset).forEach((value, i) => expect(value).toBeCloseTo(p.position[i], 6));
        const yaw = p.yawDeg * Math.PI / 180;
        const expected = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
        e.node.getRotation().forEach((value, i) => expect(value).toBeCloseTo(expected[i], 6));
        if (p.yawDeg === 0) expect(e.node.getRotation()).toEqual([0, 0, 0, 1]);
      }
    }
    expect(nodes.has(ROOT_NAME + '/Markings')).toBe(false);
  });

  it('no node is named like the file stem / scene PalletYard (no file-wide clash with the model root, #188)', () => {
    // The loader makes the glTF scene the model root and dedups node names
    // file-wide against it: a node called `PalletYard` would load as
    // `PalletYard_1`, and an editor save would write that loader name back as authored.
    const stem = DEFAULT_GLB.split(/[\\/]/).pop()!.replace(/\.glb$/i, '');
    const sceneName = doc.getRoot().listScenes()[0].getName();
    expect(stem).toBe('PalletYard');
    expect(sceneName).toBe(stem);
    const clashing = doc.getRoot().listNodes().filter((n) => n.getName() === stem).map((n) => n.getName());
    expect(clashing).toEqual([]);
  });

  it('scene / file / root names do not match the *AGV* / *Agv* behavior glob', () => {
    const names = [DEFAULT_GLB.split(/[\\/]/).pop()!.replace(/\.glb$/i, ''), ROOT_NAME, doc.getRoot().listScenes()[0].getName()];
    for (const n of names) expect(/agv/i.test(n)).toBe(false);
  });

  it('the path graph resolves: every successor exists, joints are position- and tangent-continuous', () => {
    const net = new RVPathNetwork();
    const ids: string[] = [];
    for (const e of nodes.values()) {
      const p = rv(e.node).Path;
      if (!p) continue;
      const path = parsePathExtras(p, e.node.getName());
      expect(path, e.path).not.toBeNull();
      net.register(path!);
      ids.push(path!.id);
    }
    net.resolveGraph();
    const a = new Vector3(), b = new Vector3(), ta = new Vector3(), tb = new Vector3();
    for (const id of ids) {
      const p = net.get(id)!;
      expect(p.successorIds.length, id).toBeGreaterThan(0);
      for (const s of p.successorIds) {
        const q = net.get(s);
        expect(q, `${id} → ${s}`).toBeTruthy();
        p.getAbsPosition(p.length, a); q!.getAbsPosition(0, b);
        expect(a.distanceTo(b), `${id} → ${s}`).toBeLessThan(1e-4);
        p.getAbsDirection(p.length, ta); q!.getAbsDirection(0, tb);
        expect(ta.dot(tb), `${id} → ${s}`).toBeGreaterThan(0.9999);
      }
    }
  });

  it('12 station stiches + the wait point, straight docks starting at the handling pose, capacity-1 zones', () => {
    const paths = new Map([...nodes.values()].filter((e) => rv(e.node).Path).map((e) => [rv(e.node).Path.id, rv(e.node).Path]));
    const stations = STATION_GEOMETRY.filter((g) => g.kind !== 'wait');
    expect(stations).toHaveLength(12);
    expect(PALLET_YARD_CONFIG.stations).toHaveLength(12);
    for (const g of STATION_GEOMETRY) {
      const dock = paths.get(stichPathId(g.id));
      const arc = paths.get(stichArcId(g.id));
      expect(dock, g.id).toBeTruthy();
      expect(dock.segments).toHaveLength(1);
      expect(dock.segments[0].kind).toBe('line');
      // split zones (plan-595 §2.3): the dock is its own zone K_i, the mouth (arc) lies in M_i
      const j = junctionOfStation(g.id);
      expect(dock).toMatchObject({ zone: `Stich_${g.id}`, zoneCapacity: 1, successors: [stichArcId(g.id)] });
      expect(arc).toMatchObject({ zone: mergeZoneOf(j.id), zoneCapacity: 1, successors: [junctionOutId(j)] });
      // authored FROM the handling position TO the lane (plan-595 §2.3)
      const { root } = handlingPose(g);
      expect(dock.segments[0].from[0]).toBeCloseTo(root[0], 6);
      expect(dock.segments[0].from[2]).toBeCloseTo(root[1], 6);
      // the lane pieces around the junction form the merge zone; the turn point is the end of _Out
      const out = paths.get(arc.successors[0]);
      expect(out).toMatchObject({ id: turnPathOf(g.id), zone: mergeZoneOf(j.id), zoneCapacity: 1 });
      expect(paths.get(junctionInId(j))).toMatchObject({ zone: mergeZoneOf(j.id), successors: [junctionOutId(j)] });
    }
    expect(PALLET_YARD_CONFIG.waitPointPathId).toBe(stichPathId('W'));
  });

  it('no merge entry is too short for the stacker bodies (finding #194) — the turn point keeps clear of the next zone', () => {
    const net = new RVPathNetwork();
    for (const e of nodes.values()) {
      const p = rv(e.node).Path;
      if (p) net.register(parsePathExtras(p, e.node.getName())!);
    }
    net.resolveGraph();
    const body = { front: VEHICLE_LENGTH_MM / 2000, rear: VEHICLE_LENGTH_MM / 2000, width: VEHICLE_WIDTH_MM / 1000 };
    expect(findShortMergeEntries(net.all(), body)).toEqual([]);
    // control: the check is sharp — a body 0.3 m longer at each end (reach beyond the 1.8 m lane run) fails
    expect(findShortMergeEntries(net.all(), { ...body, front: body.front + 0.3, rear: body.rear + 0.3 }).length).toBeGreaterThan(0);
    // the merge piece ends with a free gap longer than the body reach ahead of the root
    for (const p of net.all()) {
      if (!/_Out$/.test(p.id)) continue;
      const next = p.successors[0];
      expect(next.zoneId, `${p.id} → ${next.id}`).toBeNull();
      expect(next.length, next.id).toBeGreaterThan(body.front + 0.1);
    }
  });

  it('three stackers — placements of the library stacker — with AllowReverse, ReverseSpeed, explicit body size and a valid start path ON the reference node', () => {
    const pathIds = new Set([...nodes.values()].filter((e) => rv(e.node).Path).map((e) => rv(e.node).Path.id));
    for (const v of VEHICLES) {
      const e = nodes.get(`${ROOT_NAME}/${v.id}`)!;
      expectPlacement(e, 'stacker', v.id);
      const agv = rv(e.node).Agv;
      expect(agv).toMatchObject({
        PathId: v.startPathId, AllowReverse: true, ReverseSpeed: 300, VehicleLength: 1750, VehicleWidth: 860,
      });
      expect(pathIds.has(agv.PathId)).toBe(true);
    }
    expect([...nodes.values()].filter((e) => rv(e.node).Agv)).toHaveLength(3);
  });

  it('the library stacker: the Drive_Gear master is a TAGGED asset-relative reference to its own Lift (b1-0, SOL #10)', () => {
    const st = lib.get('stacker')!;
    const gears = [...st.nodes.values()].filter((e) => rv(e.node).Drive_Gear);
    // The SolidCraft stacker (CP1b) has one gear: LiftRam follows Lift at 0.5.
    expect(gears.map((g) => g.path)).toEqual(['AGV_Stacker/LiftRam']);
    const ref = rv(gears[0].node).Drive_Gear.MasterDrive;
    // type is required — the loader resolves only tagged references (b0 finding 2')
    expect(ref).toEqual({ type: 'ComponentReference', path: 'AGV_Stacker/Lift', componentType: 'Drive' });
    expect(rv(st.nodes.get(ref.path)!.node).Drive).toBeTruthy();
    // load rollers ride on the chassis, not on the lift
    expect(st.nodes.has('AGV_Stacker/Chassis/LoadRollerL')).toBe(true);
    expect(st.nodes.has('AGV_Stacker/Chassis/LoadRollerR')).toBe(true);
    // the scene itself holds no stacker content any more
    expect([...nodes.values()].filter((e) => rv(e.node).Drive_Gear || rv(e.node).Drive)).toEqual([]);
  });

  it('the library stacker keeps Lift/ForkAnchor by its authored rv.BakeRole (b1-0); ForkAnchor and its ancestors are uniformly scaled', () => {
    const st = lib.get('stacker')!;
    let e: Entry | null = st.nodes.get('AGV_Stacker/Lift/ForkAnchor')!;
    expect(e).toBeTruthy();
    expect(rv(e.node).BakeRole).toBe('merge');
    for (; e; e = e.parent) {
      const [x, y, z] = e.node.getScale();
      expect(Math.abs(x - y) + Math.abs(y - z), e.path).toBeLessThan(1e-9);
    }
    for (const v of VEHICLES) expect(nodes.get(`${ROOT_NAME}/${v.id}`)!.node.getScale()).toEqual([1, 1, 1]);
  });

  it('every glTF node of the scene belongs to the scene (no orphan such as the old LiftRam template rest)', () => {
    const inScene = new Set([...nodes.values()].map((e) => e.node));
    expect(doc.getRoot().listNodes().filter((n) => !inScene.has(n)).map((n) => n.getName())).toEqual([]);
  });

  it('6 floor-slot nodes at the pallet seats, no DESStorage anywhere', () => {
    for (const s of PALLET_YARD_CONFIG.stations.filter((x) => x.kind === 'buffer')) {
      const e = nodes.get(`${ROOT_NAME}/${s.slot}`)!;
      expect(e, s.id).toBeTruthy();
      expect(rv(e.node)).toEqual({ BakeRole: 'merge', Generated: { owner: 'palletYard' } });
      const { seat } = handlingPose(STATION_GEOMETRY.find((g) => g.id === s.id)!);
      expect(e.node.getTranslation()[0]).toBeCloseTo(seat[0], 6);
      expect(e.node.getTranslation()[2]).toBeCloseTo(seat[1], 6);
    }
    for (const e of nodes.values()) expect(rv(e.node).DESStorage, e.path).toBeUndefined();
  });

  it('pallet sources are placements with plugin takt overrides and library-owned template names', () => {
    const source = rv(lib.get('EuropalletLoaded')!.root).Source;
    expect(source).toMatchObject({ ThisObjectAsMU: 'EuropalletLoaded', _fullTypeName: 'realvirtual.Source', _version: 2 });
    expect(Object.keys(source).length).toBeGreaterThan(20);
    for (const id of ['A1', 'A2']) {
      const e = nodes.get(ROOT_NAME + '/Pallet_' + id)!;
      expectPlacement(e, 'EuropalletLoaded', 'Pallet_' + id);
      expect(rv(e.node).Source).toBeUndefined();
      expect(rv(e.node).AssetOverrides).toEqual({ byPath: { EuropalletLoaded: { Source: {
        AutomaticGeneration: false, GenerateMU: false, Interval: 0,
      } } } });
      const g = STATION_GEOMETRY.find(g => g.id === id)!;
      contentAt(e.node, 'EuropalletLoaded').forEach((value, i) => expect(value).toBeCloseTo(headSeatOf(g)[i], 6));
      expectContentRotation(e.node, 'EuropalletLoaded');
    }
  });

  it('scanner and sink placements preserve their content poses and library root scale', () => {
    expect(lib.get('PalletSink')!.root.getScale()).toEqual([1, 0.2, 1]);
    expect(rv(lib.get('PalletSink')!.root).Sink).toBeTruthy();
    for (const id of ['V1', 'V2']) {
      const g = STATION_GEOMETRY.find(g => g.id === id)!;
      const z = conveyorZOf(g);
      for (const [prefix, asset, position] of [
        ['Scanner_', 'PalletScanner', [g.x, 0, z + 0.8]],
        ['Sink_', 'PalletSink', [g.x, CONVEYOR_SURFACE_M + 0.1, z + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M + SINK_BEHIND_END_M]],
      ] as const) {
        const e = nodes.get(ROOT_NAME + '/' + prefix + id)!;
        expectPlacement(e, asset, prefix + id);
        contentAt(e.node, asset).forEach((value, i) => expect(Math.abs(value - position[i])).toBeLessThanOrEqual(1e-6));
        expectContentRotation(e.node, asset);
        expect(e.node.getScale()).toEqual([1, 1, 1]);
        expect(rv(e.node).Sink).toBeUndefined();
        expect(rv(e.node).AssetOverrides).toBeUndefined();
      }
    }
  });

  it('conveyors are placements of RollConveyor-3m tagged with their station + stich, seating the pallets where the forks reach', () => {
    for (const id of ['A1', 'A2', 'V1', 'V2']) {
      const g = STATION_GEOMETRY.find((x) => x.id === id)!;
      const e = nodes.get(`${ROOT_NAME}/Conveyor_${id}`)!;
      expectPlacement(e, 'conveyor3m', `Conveyor_${id}`);
      expect(rv(e.node)[STATION_TAG_KEY], `Conveyor_${id} tag`).toEqual({ Station: id, StichPathId: stichPathId(id) });
      expect(rv(e.node).Conveyor, 'no explicit Conveyor payload (a placement binds by name)').toBeUndefined();
      const { seat } = handlingPose(g);
      // The fork seat stands where the DES Conveyor hands off (pick: belt end) or on the head
      // (drop): the conveyor takes a pallet over at its set-down pose (plan-631).
      const local = g.kind === 'pick' ? CONVEYOR_END_SEAT_Z_M : CONVEYOR_HEAD_SEAT_Z_M;
      const at = contentAt(e.node, 'conveyor3m');
      expect(at[2] + local).toBeCloseTo(seat[1], 6);
      expect(at[2]).toBeCloseTo(conveyorZOf(g), 6);
      expect(at[0]).toBeCloseTo(seat[0], 6);
      expect(at[1]).toBeCloseTo(0, 6);
      if (g.kind === 'pick') {
        // the production source spawns ON the belt head (pallet bottom on the rollers)
        const p = contentAt(nodes.get(`${ROOT_NAME}/Pallet_${id}`)!.node, 'EuropalletLoaded');
        const h = headSeatOf(g);
        for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(h[k], 6);
        expect(p[2]).toBeCloseTo(at[2] + CONVEYOR_HEAD_SEAT_Z_M, 6);
      }
      // no infeed stand any more (plan-631 Phase 2 removed the CP1c work-around)
      expect(nodes.has(`${ROOT_NAME}/Infeed_${id}`), `Infeed_${id}`).toBe(false);
    }
    const conveyorRefs = [...nodes.values()].filter((e) => e.parent?.path === ROOT_NAME && /rollconveyor/.test(rv(e.node).AssetReference?.assetId ?? ''));
    expect(conveyorRefs.map((e) => e.node.getName()).sort()).toEqual(['ConveyorOut_V1', 'ConveyorOut_V2', 'Conveyor_A1', 'Conveyor_A2', 'Conveyor_V1', 'Conveyor_V2']);
  });

  it('every shipping line goes on with a 2 m ConveyorOut directly behind the input, the sink at its end (CP1c)', () => {
    for (const id of ['V1', 'V2']) {
      const conv = nodes.get(`${ROOT_NAME}/Conveyor_${id}`)!.node;
      const out = nodes.get(`${ROOT_NAME}/ConveyorOut_${id}`)!;
      expectPlacement(out, 'conveyor2m', `ConveyorOut_${id}`);
      const [cx, , cz] = contentAt(conv, 'conveyor3m');
      const [ox, oy, oz] = contentAt(out.node, 'conveyor2m');
      expect(out.node.getRotation()).toEqual([0, 0, 0, 1]);           // flow local +Z, as the input conveyor
      expect(ox).toBeCloseTo(cx, 6);
      expect(oy).toBeCloseTo(0, 9);
      // directly adjacent: input end (cz + 1.5) == out head (oz - 1.0)
      expect(oz - CONVEYOR_OUT_LENGTH_M / 2).toBeCloseTo(cz + CONVEYOR_LENGTH_M / 2, 6);
      // belt + sensor: in the library asset (the Conveyor behaviour finds them below the placement)
      const kids = lib.get('conveyor2m')!.root.listChildren().map((c) => c.getName());
      expect(kids).toContain('Transport-Z');
      expect(kids).toContain('Sensor');
      const sink = contentAt(nodes.get(`${ROOT_NAME}/Sink_${id}`)!.node, 'PalletSink');
      expect(sink[0]).toBeCloseTo(cx, 6);
      expect(sink[2]).toBeCloseTo(oz + CONVEYOR_OUT_LENGTH_M / 2 + SINK_BEHIND_END_M, 6);
      // clear of the loop (north lane at z = +R, its outer reach + a body) and of the other line
      expect(oz - CONVEYOR_OUT_LENGTH_M / 2).toBeGreaterThan(COURSE.r + 1);
    }
    const x1 = contentAt(nodes.get(`${ROOT_NAME}/ConveyorOut_V1`)!.node, 'conveyor2m')[0];
    const x2 = contentAt(nodes.get(`${ROOT_NAME}/ConveyorOut_V2`)!.node, 'conveyor2m')[0];
    expect(Math.abs(x1 - x2)).toBeGreaterThan(1.5);
  });

  it('every node the plugin claims carries an authored rv.BakeRole merge (survives a bake before the plugin loads, CP1c)', () => {
    const claims = palletYardClaimPaths(PALLET_YARD_CONFIG, ROOT_NAME);
    // CP1d-b: only the main model's floor slots — nothing inside a placement (plan-757 D5)
    expect(claims).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((id) => `${ROOT_NAME}/Slot_${id}`));
    const missing = claims.filter((p) => !nodes.has(p));
    expect(missing).toEqual([]);
    const unmarked = claims.filter((p) => rv(nodes.get(p)!.node).BakeRole !== palletYardBakeRoleOf(p));
    expect(unmarked).toEqual([]);
    expect(claims.filter((p) => palletYardBakeRoleOf(p) === 'chunk')).toHaveLength(0);
    // no BakeRole left on a placement reference (it would act on the empty reference node only)
    expect([...nodes.values()].filter((e) => rv(e.node).AssetReference && rv(e.node).BakeRole)).toEqual([]);
  });

  it('every ComponentReference in the document resolves inside the document', () => {
    const bad: string[] = [];
    const visit = (v: unknown, where: string): void => {
      if (Array.isArray(v)) { v.forEach((x) => visit(x, where)); return; }
      if (!v || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      if (o.type === 'ComponentReference' && typeof o.path === 'string' && !nodes.has(o.path)) bad.push(`${where} → ${o.path}`);
      for (const k of Object.keys(o)) visit(o[k], where);
    };
    for (const e of nodes.values()) visit(rv(e.node), e.path);
    expect(bad).toEqual([]);
  });
});

describe('PalletYard generator', () => {
  it.each([1, 2, 4])('size %i straight paint covers the course without gaps or overlaps', async n => {
    const dir = mkdtempSync(join(tmpdir(), 'pallet-yard-paint-'));
    const assets = new Map<string, GltfNodeLike>();
    for (const [file, bytes] of await buildYardModuleBytes()) {
      if (!/^PalletYard(Module|EndWest|EndEast)\.glb$/.test(file)) continue;
      const target = join(dir, file);
      writeFileSync(target, bytes);
      const asset = await readGlb(target);
      assets.set(file.replace(/\.glb$/, ''), asset.getRoot().listScenes()[0].listChildren()[0]);
    }
    const c = composeYard(n);
    for (const edge of ['SouthIn', 'SouthOut', 'NorthIn', 'NorthOut']) {
      const intervals = c.placements.filter(p => ['YardModule', 'YardEndWest', 'YardEndEast'].includes(p.asset)).map(p => {
        const root = assets.get('Pallet' + p.asset)!;
        const line = root.listChildren().find(node => node.getName() === 'LaneEdge_' + edge)!;
        expect(line, p.id + '/' + edge).toBeTruthy();
        const position = line.getMesh()!.listPrimitives()[0].getAttribute('POSITION')!;
        const x = p.position[0] + line.getTranslation()[0];
        return [x + position.getMin([])[0], x + position.getMax([])[0]];
      }).sort((a, b) => a[0] - b[0]);
      expect(intervals).toHaveLength(n + 2);
      expect(Math.abs(intervals[0][0] - c.course.xMin)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(intervals[intervals.length - 1][1] - c.course.xMax)).toBeLessThanOrEqual(1e-6);
      for (let i = 1; i < intervals.length; i++) {
        expect(Math.abs(intervals[i][0] - intervals[i - 1][1])).toBeLessThanOrEqual(1e-6);
      }
    }
  }, 120_000);

  it('compensates identity and rotated library roots without changing their scale', () => {
    const at = [3, 2, -4];
    const rot = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3).toArray();
    for (const asset of ['conveyor3m', 'PalletScanner', 'PalletSink'] as const) {
      const root = lib.get(asset)!.root;
      const scale = [...root.getScale()];
      const pose = compensatedPose(root, at, rot);
      if (asset !== 'PalletScanner') {
        expect(pose.rotation).toEqual(rot);
        const offset = new Vector3().fromArray(root.getTranslation()).applyQuaternion(new Quaternion().fromArray(rot));
        expect(pose.translation).toEqual(at.map((value, i) => round(value - offset.getComponent(i))));
      }
      const rotation = new Quaternion().fromArray(pose.rotation);
      const position = new Vector3().fromArray(root.getTranslation()).applyQuaternion(rotation)
        .add(new Vector3().fromArray(pose.translation));
      position.toArray().forEach((value, i) => expect(Math.abs(value - at[i])).toBeLessThanOrEqual(1e-6));
      rotation.multiply(new Quaternion().fromArray(root.getRotation())).normalize();
      expect(rotation.angleTo(new Quaternion().fromArray(rot))).toBeLessThanOrEqual(1e-6);
      expect(root.getScale()).toEqual(scale);
    }
  });

  it('builds six deterministic pure-geometry library assets matching the files on disk', async () => {
    const first = await buildYardModuleBytes(), second = await buildYardModuleBytes();
    expect([...first.keys()]).toEqual(['PalletYardModule.glb', 'PalletYardEndWest.glb', 'PalletYardEndEast.glb',
      'PalletYardSlotMarking.glb', 'PalletYardChargerStation.glb', 'PalletYardWaitMarking.glb']);
    for (const [file, bytes] of first) {
      expect(Buffer.from(bytes).equals(Buffer.from(second.get(file)!))).toBe(true);
      const target = join(LIBRARY_DIR, 'PalletHandling', file);
      expect(sha(target)).toBe(createHash('sha256').update(bytes).digest('hex'));
      const asset = await readGlb(target);
      expect(asset.getRoot().listScenes()).toHaveLength(1);
      const roots = asset.getRoot().listScenes()[0].listChildren();
      expect(roots).toHaveLength(1);
      expect(roots[0].getName()).toBe(file.replace(/\.glb$/, ''));
      expect(roots[0].getTranslation()).toEqual([0, 0, 0]);
      expect(roots[0].getRotation()).toEqual([0, 0, 0, 1]);
      expect(roots[0].getScale()).toEqual([1, 1, 1]);
      for (const n of asset.getRoot().listNodes()) {
        expect(n.getExtras().realvirtual).toBeUndefined();
        expect(n.getExtras().Path).toBeUndefined();
        expect(n.getExtras().zone).toBeUndefined();
      }
    }
  }, 120_000);

  it('two runs with a time gap → same sha256 and byte-identical project.json; a missing row uses the public model binding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pallet-yard-'));
    const glb = join(dir, 'scenes-PalletYard.glb');
    const manifest = join(dir, 'project.json');
    // a manifest WITHOUT the PalletYard row
    const m = JSON.parse(readFileSync(DEFAULT_MANIFEST, 'utf8'));
    m.documents = m.documents.filter((d: { path: string }) => !/PalletYard/.test(d.path));
    writeFileSync(manifest, JSON.stringify(m, null, 2));
    const first = await writePalletYard({ glbPath: glb, manifestPath: manifest });
    expect(first).toMatchObject({ written: true, inserted: true });
    const row = JSON.parse(readFileSync(manifest, 'utf8')).documents.find((d: { path: string }) => d.path === first.rel);
    expect(row).toMatchObject({ sha256: first.sha256, sizeBytes: first.sizeBytes });
    expect(row).not.toHaveProperty('scriptRef');
    const manifestBytes = readFileSync(manifest);
    await new Promise((r) => setTimeout(r, 1100));
    const second = await writePalletYard({ glbPath: glb, manifestPath: manifest });
    expect(second).toMatchObject({ written: false, inserted: false, sha256: first.sha256 });
    expect(readFileSync(manifest).equals(manifestBytes)).toBe(true);
    // the committed scene is exactly what the generator builds today
    expect(sha(DEFAULT_GLB)).toBe(first.sha256);
  }, 240_000);

  it('a rerun keeps the PlanningScenarios a planner saved (plan-630 Phase 3, 9.8)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pallet-yard-scen-'));
    const glb = join(dir, 'PalletYard.glb');
    const manifest = join(dir, 'project.json');
    writeFileSync(manifest, readFileSync(DEFAULT_MANIFEST));
    const fresh = await writePalletYard({ glbPath: glb, manifestPath: manifest });
    expect(readPreservedSceneExtras(glb)).toEqual({ Variants: DEMO_VARIANTS });
    // What the viewer's Save writes: a block in the default scene's extras (JSON chunk only).
    const block = { version: 1, active: 'Hoch', scenarios: { Basis: {}, Hoch: { 'palletYard.size': 4 } } };
    const buf = readFileSync(glb);
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
    const scene = json.scenes[json.scene ?? 0];
    scene.extras = { ...(scene.extras ?? {}), realvirtual: { ...(scene.extras?.realvirtual ?? {}), PlanningScenarios: block } };
    let text = Buffer.from(JSON.stringify(json), 'utf8');
    if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
    const rest = buf.subarray(20 + jsonLen);
    const head = Buffer.alloc(20);
    head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + text.length + rest.length, 8);
    head.writeUInt32LE(text.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
    writeFileSync(glb, Buffer.concat([head, text, rest]));
    expect(readPreservedSceneExtras(glb)).toEqual({ PlanningScenarios: block, Variants: DEMO_VARIANTS });

    const rerun = await writePalletYard({ glbPath: glb, manifestPath: manifest });
    // The injected file is already what the generator writes (demo Variants first, then
    // the preserved block), so the rerun may leave the bytes as they are — what counts is
    // that the planner block survives it.
    expect(readPreservedSceneExtras(glb)).toEqual({ PlanningScenarios: block, Variants: DEMO_VARIANTS }); // … and the block is still there
    expect(rerun.sha256).not.toBe(fresh.sha256);
    const again = await writePalletYard({ glbPath: glb, manifestPath: manifest });
    expect(again).toMatchObject({ written: false, sha256: rerun.sha256 }); // still deterministic
  }, 240_000);

  it('agv-factory-paths.mjs after the path-dsl refactor: same graph, committed AGVFactory.glb untouched', async () => {
    // Byte identity old vs. refactored script was proven once on identical inputs
    // (AGV_COUNT 8/4/3, plan-612 Implementation Complete). The script is not
    // idempotent on its own output (pre-existing), so this test pins the graph.
    const before = sha(join(PROJECT, 'AGVFactory.glb'));
    const dir = mkdtempSync(join(tmpdir(), 'agv-factory-'));
    const copy = join(dir, 'AGVFactory.glb');
    copyFileSync(join(PROJECT, 'AGVFactory.glb'), copy);
    const out = execFileSync(process.execPath, [join(WV, 'tools/des-examples/agv-factory-paths.mjs'), copy], {
      cwd: WV, env: { ...process.env, AGV_COUNT: '4' }, stdio: 'pipe', encoding: 'utf8',
    });
    expect(out).toContain('46 paths (33 oval pieces), 4 AGVs');
    const agv = index(await readGlb(copy));
    const paths = [...agv.values()].map((e) => rv(e.node).Path).filter(Boolean);
    expect(paths).toHaveLength(46);
    expect(paths.filter((p) => p.zone).map((p) => `${p.id}:${p.zone}`).sort()).toEqual([
      'LoadOut:MergeNorthC', 'NorthB_4:MergeNorthC', 'NorthC:MergeNorthC',
      'NorthD_4:MergeWest', 'SouthB_4:MergeSouthC', 'SouthC:MergeSouthC', 'SouthD_4:MergeSouthE',
      'SouthE:MergeSouthE', 'WS1Out:MergeSouthC', 'WS2Out:MergeSouthE', 'WS3Out:MergeWest', 'West:MergeWest',
    ]);
    expect(sha(join(PROJECT, 'AGVFactory.glb'))).toBe(before);
  }, 240_000);
});
