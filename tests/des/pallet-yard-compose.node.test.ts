// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  composeGeometry, composeGraph, composeYard, compositionHash, countsFor, DEFAULT_RATIOS, YARD_ASSETS,
} from '../../src/plugins/models/PalletYard/yard-compose';
import {
  STATION_GEOMETRY, COURSE, buildPathGraph, composeGraph as layoutComposeGraph, handlingPose, conveyorZOf, headSeatOf, STICH_LENGTH_M,
  CONVEYOR_LENGTH_M, CONVEYOR_OUT_LENGTH_M, CONVEYOR_SURFACE_M, SINK_BEHIND_END_M,
} from '../../src/plugins/models/PalletYard/layout';
import { pathExtras, round, specLength } from '../../src/plugins/models/PalletYard/path-dsl.mjs';
import { parsePathExtras } from '@rv/core/engine/rv-path';
import { RVPathNetwork } from '@rv/core/engine/rv-path-network';
import { findShortMergeEntries } from '@rv/core/engine/rv-movement-authority';

const fixture = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/pallet-yard-legacy-n2.json'), 'utf8'));

describe('PalletYard composition', () => {
  it('reproduces the frozen n=2 geometry and graph, including JSON insertion order', () => {
    expect(composeGraph).toBe(layoutComposeGraph);
    expect(JSON.stringify(buildPathGraph())).toBe(JSON.stringify(fixture.pathGraph));
    const { geometry, xMin, xMax } = composeGeometry(2);
    expect(geometry).toEqual(fixture.stationGeometry);
    expect(composeGraph(geometry, xMin, xMax)).toEqual(fixture.pathGraph);
    expect(JSON.stringify(composeGraph(STATION_GEOMETRY, -COURSE.xEnd, COURSE.xEnd))).toBe(JSON.stringify(buildPathGraph()));
  });
});

describe('Complete yard composition', () => {
  // plan-681 Phase 2: + marking placements, slots, bundled-library asset paths
  it.each([
    [1, 'b21636394c724ae6'],
    [2, 'a18292102854f519'],
    [4, 'b993852a59d795d8'],
  ] as const)('size %i matches its frozen golden hash', (n, hash) => {
    expect(compositionHash(composeYard(n))).toBe(hash);
  });

  it('places station markings and floor slots at handling poses using bundled-library assets', () => {
    const c = composeYard(2);
    const markings = c.placements.filter(p => ['YardSlotMarking', 'YardChargerStation', 'YardWaitMarking'].includes(p.asset));
    const geometry = c.geometry.filter(g => ['buffer', 'charger', 'wait'].includes(g.kind));
    expect(markings).toHaveLength(9);
    expect(markings.map(p => p.id)).toEqual(geometry.map(g => (g.kind === 'charger' ? 'Charger_' : 'Marking_') + g.id));
    for (const g of geometry) {
      const pose = handlingPose(g);
      expect(markings.find(p => p.id === (g.kind === 'charger' ? 'Charger_' : 'Marking_') + g.id)).toMatchObject({
        asset: g.kind === 'buffer' ? 'YardSlotMarking' : g.kind === 'charger' ? 'YardChargerStation' : 'YardWaitMarking',
        position: [g.x, 0, g.kind === 'buffer' ? pose.seat[1] : pose.root[1]].map(round),
        yawDeg: g.kind === 'buffer' || pose.forwardZ === 1 ? 0 : 180,
      });
    }
    expect(markings.filter(p => p.asset === 'YardSlotMarking').map(p => p.id)).toEqual(['Marking_P1', 'Marking_P2', 'Marking_P3', 'Marking_P4', 'Marking_P5', 'Marking_P6']);
    expect(markings.filter(p => p.asset === 'YardChargerStation').map(p => p.id)).toEqual(['Charger_L1', 'Charger_L2']);
    expect(markings.filter(p => p.asset === 'YardWaitMarking').map(p => p.id)).toEqual(['Marking_W']);
    expect(c.slots.map(s => s.node)).toEqual(['Slot_P1', 'Slot_P2', 'Slot_P3', 'Slot_P4', 'Slot_P5', 'Slot_P6']);
    expect(c.slots).toEqual(c.geometry.filter(g => g.kind === 'buffer').map(g => ({
      station: g.id, node: 'Slot_' + g.id, position: [g.x, 0, round(handlingPose(g).seat[1])],
    })));
    expect(composeYard(4).placements.filter(p => p.asset === 'YardWaitMarking').map(p => p.id)).toEqual(['Marking_W2', 'Marking_W']);
    for (const asset of Object.values(YARD_ASSETS)) {
      expect(asset.path.startsWith('/library/')).toBe(true);
      const stem = asset.path.split('/').pop()!.replace(/\.glb$/, '');
      if (stem.startsWith('PalletYard')) expect(asset.assetId).toBe('pallethandling-' + stem.toLowerCase());
    }
  });

  it('reproduces legacy stations, config, vehicles and Agv property order', () => {
    const c = composeYard(2);
    expect(c.geometry).toEqual(fixture.stationGeometry);
    expect(c.pathGraph).toEqual(fixture.pathGraph);
    expect(c.vehicles).toEqual(fixture.vehicles);
    expect(c.config).toEqual(fixture.config);
    expect(JSON.stringify(c.config)).toBe(JSON.stringify(fixture.config));
    expect(c.stations).toBe(c.config.stations);
    expect(c.stations).toEqual(fixture.config.stations);
    for (const v of c.vehicles) expect(JSON.stringify(c.placements.find(p => p.id === v.id)!.extras.Agv)).toBe(JSON.stringify(fixture.agv[v.id]));
  });

  it('applies sparse count overrides and validates geometry, size and fleet', () => {
    expect(countsFor(2)).toEqual({ outputs: 2, inputs: 2, slots: 6, chargers: 2, waitPoints: 1, vehicles: 3 });
    expect([1, 3, 16].map(n => countsFor(n).vehicles)).toEqual([2, 5, 24]);
    const table = { 3: { vehicles: 4 } };
    expect(countsFor(3, DEFAULT_RATIOS, table)).toEqual({ ...countsFor(3), vehicles: 4 });
    expect(composeYard(3, DEFAULT_RATIOS, table).vehicles).toHaveLength(4);
    expect(composeYard(2, DEFAULT_RATIOS, table)).toEqual(composeYard(2));
    for (const key of ['outputs', 'inputs', 'slots', 'chargers', 'waitPoints']) {
      expect(() => composeYard(2, DEFAULT_RATIOS, { 2: { [key]: 999 } })).toThrow('module-geometry-mismatch');
    }
    expect(() => composeYard(2, { ...DEFAULT_RATIOS, slots: 4 })).toThrow('module-geometry-mismatch');
    for (const size of [0, 17, 2.5, NaN, Infinity]) expect(() => composeYard(size)).toThrow(RangeError);
    expect(() => composeYard(2, DEFAULT_RATIOS, { 2: { vehicles: 0 } })).toThrow(RangeError);
    expect(() => composeYard(2, DEFAULT_RATIOS, { 2: { vehicles: 100 } })).toThrow('palletYard: no start position for');
    expect(composeYard(1, DEFAULT_RATIOS, { 1: { vehicles: 1 } }).config.battery.startSoc).toEqual([90]);
    expect(composeYard(2, { ...DEFAULT_RATIOS, ratePerOutput: 60 }).config.production).toEqual({ intervalSec: 60, phaseSec: [0, 30] });
  });

  it('preserves the first pair station ids and coordinates when growing to four', () => {
    const larger = composeYard(4);
    for (const g of composeYard(2).geometry) expect(larger.geometry.find(x => x.id === g.id)).toEqual(g);
  });

  it('hashes sorted object keys while preserving array order', () => {
    const c = composeYard(2);
    const reordered = { ...c, course: { xMax: c.course.xMax, xMin: c.course.xMin } };
    expect(compositionHash(reordered)).toBe(compositionHash(c));
    expect(compositionHash({ ...c, placements: [...c.placements].reverse() })).not.toBe(compositionHash(c));
  });

  it('reproduces the golden hashes in another process', () => {
    const file = resolve(__dirname, '../../src/plugins/models/PalletYard/yard-compose.ts');
    const source = 'const {composeYard, compositionHash} = await import(' + JSON.stringify(pathToFileURL(file).href)
      + '); console.log(JSON.stringify([1, 2, 4].map(n => compositionHash(composeYard(n)))));';
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', source], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['b21636394c724ae6', 'a18292102854f519', 'b993852a59d795d8']);
  });

  it.each(Array.from({ length: 16 }, (_, i) => i + 1))('size %i is deterministic, connected, body-safe and fully placed', n => {
    const c = composeYard(n);
    expect(compositionHash(c)).toBe(compositionHash(composeYard(n)));
    expect(c.course).toEqual({ xMin: -7.5, xMax: (68 * n - 61) / 10 });
    expect(c.waitPointPathIds).toEqual(c.geometry.filter(g => g.kind === 'wait').map(g => 'Stich_' + g.id));
    for (const [kind, count] of Object.entries({ pick: n, drop: n, buffer: 3 * n, charger: n, wait: Math.ceil(n / 2) })) {
      expect(c.geometry.filter(g => g.kind === kind)).toHaveLength(count);
    }
    const paths = new Map(c.pathGraph.map(p => [p.id, p]));
    expect(paths.size).toBe(c.pathGraph.length);
    const lane = c.pathGraph.filter(p => !p.id.startsWith('Stich_'));
    const visited = new Set<string>();
    let id = 'West';
    do {
      expect(visited.has(id)).toBe(false);
      visited.add(id);
      const p = paths.get(id)!;
      expect(p.successors).toHaveLength(1);
      id = p.successors[0];
    } while (id !== 'West' && visited.size <= lane.length);
    expect(id).toBe('West');
    expect(visited.size).toBe(lane.length);
    for (const p of c.pathGraph) for (const successor of p.successors) expect(paths.has(successor)).toBe(true);
    const zones: string[] = [];
    for (const g of c.geometry) {
      const dock = paths.get('Stich_' + g.id)!;
      expect(dock.successors).toEqual(['Stich_' + g.id + '_Arc']);
      expect(dock.zone).toBe('Stich_' + g.id);
      zones.push(dock.zone!);
      const mouth = paths.get(dock.successors[0])!;
      expect(mouth.successors).toHaveLength(1);
      expect(mouth.successors[0]).toMatch(/_Out$/);
      expect(paths.get(mouth.successors[0])!.zone).toBe(mouth.zone);
    }
    expect(new Set(zones).size).toBe(c.geometry.length);
    const net = new RVPathNetwork();
    for (const p of c.pathGraph) net.register(parsePathExtras(pathExtras(p).Path, p.id)!);
    net.resolveGraph();
    expect(findShortMergeEntries(net.all(), { front: 0.875, rear: 0.875, width: 0.86 })).toEqual([]);
    if (n === 2 || n === 4) {
      expect(c.pathGraph).toHaveLength(n === 2 ? 62 : 110);
      expect(c.pathGraph.filter(p => /^Stich_[A-Z]\d*$/.test(p.id))).toHaveLength(n === 2 ? 13 : 26);
    }
    const expectedAssets = { YardEndWest: 1, YardModule: n, YardEndEast: 1, 'RollConveyor-3m': 2 * n, 'RollConveyor-2m': n,
      EuropalletLoaded: n, PalletScanner: n, PalletSink: n, AGVStacker: c.counts.vehicles };
    expect(new Set(c.placements.map(p => p.id)).size).toBe(c.placements.length);
    for (const [asset, count] of Object.entries(expectedAssets)) expect(c.placements.filter(p => p.asset === asset)).toHaveLength(count);
    for (const p of c.placements) expect(p.assetRef).toEqual(YARD_ASSETS[p.asset]);
    expect(c.placements.slice(0, n + 2).map(p => p.id)).toEqual(['YardEndWest', ...Array.from({ length: n }, (_, i) => 'YardModule_' + (i + 1)), 'YardEndEast']);
    expect(c.placements[0]).toMatchObject({ position: [c.course.xMin, 0, 0], yawDeg: 0, extras: {} });
    expect(c.placements[n + 1]).toMatchObject({ position: [c.course.xMax, 0, 0], yawDeg: 0, extras: {} });
    for (let i = 0; i < n; i++) expect(c.placements[i + 1]).toMatchObject({
      position: [(-34 + 68 * i) / 10, 0, 0], yawDeg: 0, extras: { YardModule: { Index: i + 1, Parity: i % 2 } },
    });
    for (const g of c.geometry.filter(g => g.kind === 'pick' || g.kind === 'drop')) {
      const conveyor = c.placements.find(p => p.id === 'Conveyor_' + g.id)!;
      expect(conveyor.position).toEqual([g.x, 0, conveyorZOf(g)].map(round));
      expect(conveyor.extras).toEqual({ PalletYardStation: { Station: g.id, StichPathId: 'Stich_' + g.id } });
      if (g.kind === 'pick') {
        const pallet = c.placements.find(p => p.id === 'Pallet_' + g.id)!;
        expect(pallet.position).toEqual(headSeatOf(g).map(round));
        expect(pallet.overrides).toEqual({ Source: { AutomaticGeneration: false, GenerateMU: false, Interval: 0, ThisObjectAsMU: pallet.id } });
      } else {
        const z = conveyorZOf(g);
        const at = c.placements.findIndex(p => p.id === conveyor.id);
        expect(c.placements.slice(at, at + 4).map(p => p.id)).toEqual([
          conveyor.id, 'Scanner_' + g.id, 'ConveyorOut_' + g.id, 'Sink_' + g.id,
        ]);
        expect(c.placements[at + 1].position).toEqual([g.x, 0, round(z + 0.8)]);
        expect(c.placements[at + 2].position).toEqual([g.x, 0, round(z + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M / 2)]);
        expect(c.placements[at + 3].position).toEqual([g.x, round(CONVEYOR_SURFACE_M + 0.1), round(z + CONVEYOR_LENGTH_M / 2 + CONVEYOR_OUT_LENGTH_M + SINK_BEHIND_END_M)]);
      }
    }
    expect(c.docks).toHaveLength(2 * n);
    for (const dock of c.docks) {
      expect(c.placements.find(p => p.id === dock.placementId)?.asset).toBe('RollConveyor-3m');
      expect(paths.has(dock.stichPathId)).toBe(true);
    }
    const starts = c.vehicles.map(v => v.startPathId);
    expect(new Set(starts).size).toBe(starts.length);
    expect(starts.filter(id => id.startsWith('Stich_L'))).toEqual(
      Array.from({ length: [0, 0, 0, 0, 1, 1, 3, 3, 5, 5, 7, 7, 9, 9, 11, 11][n - 1] }, (_, i) => 'Stich_L' + (i + 1)),
    );
    for (const v of c.vehicles) {
      expect(paths.has(v.startPathId)).toBe(true);
      const p = paths.get(v.startPathId)!;
      const placement = c.placements.find(p => p.id === v.id)!;
      expect(placement.position[1]).toBe(0);
      expect(placement.extras.Agv).toMatchObject({ PathId: p.id, StartPosition: 600 });
      // Use the runtime path sampler as an independent oracle for line/arc pose and heading.
      const runtimePath = net.get(p.id)!;
      const position = runtimePath.getAbsPosition(0.6);
      const tangent = runtimePath.getAbsDirection(0.6);
      expect(placement.position).toEqual([round(position.x), 0, round(position.z)]);
      expect(placement.yawDeg).toBe(round(Math.atan2(tangent.x, tangent.z) * 180 / Math.PI));
      if (!p.id.startsWith('Stich_')) {
        expect(p.zone).toBeUndefined();
        expect(p.segments.reduce((sum, s) => sum + specLength(s), 0)).toBeGreaterThanOrEqual(1.575);
        expect(lane.find(q => q.successors.includes(p.id))!.zone).toBeUndefined();
        expect(p.successors.some(s => starts.includes(s))).toBe(false);
      } else expect(p.id).toMatch(/^Stich_L\d+$/);
    }
    expect(c.stations.every(s => s.stichLengthM === STICH_LENGTH_M)).toBe(true);
  });

  it.each(['layout', 'yard-compose'])('%s imports in a fresh plain Node process without diagnostics', name => {
    const file = resolve(__dirname, '../../src/plugins/models/PalletYard/' + name + '.ts');
    const result = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', 'await import(' + JSON.stringify(pathToFileURL(file).href) + ')'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});
