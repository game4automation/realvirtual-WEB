// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-469 Phase 0d — the realistic-scene extensions of the synthetic line.
 *
 * The scene generator is the measurement instrument for a whole campaign, so the
 * four properties the campaign's conclusions rest on are pinned here:
 *
 *  - the DEFAULTS are the plan-465 line, byte for byte (regression freedom: an
 *    existing invocation must keep measuring what it measured yesterday);
 *  - the robots are DETERMINISTIC — same seed, same poses at the same tick —
 *    and they actually move when asked to, so a "robots cost X" statement is
 *    about motion and not about 600 stationary boxes;
 *  - the library geometry is VISUAL ONLY: adding it must not change one surface,
 *    one sensor or one drive of the transport topology;
 *  - `dispose()` gives back the robots AND the library visuals, so a matrix that
 *    builds and tears down dozens of cells in one page does not drift.
 *
 * The GLB is never fetched: `setCachedAsset` injects a hand-built stand-in, so
 * the test says something about the BUILDER and nothing about the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Mesh, MeshStandardMaterial, Object3D, Scene, type Material } from 'three';
import {
  buildSyntheticLine, DEFAULT_SYNTHETIC_LINE, requiredAssets,
  type SyntheticLineConfig, type SyntheticLineHandle, type SyntheticLineHost,
} from '../../src/core/engine/perf/rv-synthetic-line';
import {
  ROBOT_AXIS_COUNT, clearSyntheticAssetCache, pieceForLength, setCachedAsset, tileSegment,
} from '../../src/core/engine/perf/rv-synthetic-assets';
import { RVTransportManager } from '../../src/core/engine/rv-transport-manager';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import type { RVDrive } from '../../src/core/engine/rv-drive';

const STEP = 1 / 60;

function makeHost(): SyntheticLineHost & { drives: RVDrive[]; scene: Scene } {
  const scene = new Scene();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  return { scene, transportManager, signalStore: new SignalStore(), drives: [], fixedTimeStep: STEP };
}

function runDrives(host: SyntheticLineHost & { drives: RVDrive[] }, steps: number): void {
  for (let i = 0; i < steps; i++) for (const d of host.drives) d.update(STEP);
}

/** Small line that is still a valid plan (keeps every case well under a second). */
const SMALL: Partial<SyntheticLineConfig> = {
  lanes: 2, plcs: 2, segments: 4, segmentLengthM: 5,
  sensorsPerSegment: 1, targetMUs: 40, speedMmS: 1000,
  muLengthMm: 200, muGapMm: 100, signalBinding: 'none',
};

/**
 * A stand-in for `RollConveyor-Nm.glb`: a root with TWO meshes (frame + rolls),
 * so the part-flattening and the per-part InstancedMesh split are both exercised.
 * `lengthM` sizes the frame, which is what the alignment matrix reads.
 */
function fakeConveyorAsset(lengthM: number): Object3D {
  const root = new Group();
  const frame = new Mesh(new BoxGeometry(lengthM, 0.1, 0.6), new MeshStandardMaterial());
  frame.name = 'Frame';
  const rolls = new Mesh(new BoxGeometry(lengthM * 0.9, 0.05, 0.5), new MeshStandardMaterial());
  rolls.name = 'Rolls';
  rolls.position.y = 0.08;
  root.add(frame, rolls);
  root.updateMatrixWorld(true);
  return root;
}

/** A stand-in for `CartonBox.glb` with `meshes` mesh children. */
function fakeBoxAsset(meshes: number): Object3D {
  const root = new Group();
  for (let i = 0; i < meshes; i++) {
    const m = new Mesh(new BoxGeometry(0.4, 0.3, 0.3), new MeshStandardMaterial());
    m.name = `Part${i}`;
    m.position.x = i * 0.01;
    root.add(m);
  }
  root.updateMatrixWorld(true);
  return root;
}

let host: SyntheticLineHost & { drives: RVDrive[]; scene: Scene };
let handle: SyntheticLineHandle | null = null;

beforeEach(() => {
  host = makeHost();
  clearSyntheticAssetCache();
});
afterEach(() => {
  handle?.dispose();
  handle = null;
  clearSyntheticAssetCache();
});

describe('defaults are the plan-465 line', () => {
  it('leaves geometry, MU asset and robots neutral', () => {
    expect(DEFAULT_SYNTHETIC_LINE.geometry).toBe('primitive');
    expect(DEFAULT_SYNTHETIC_LINE.muAsset).toBe('primitive');
    expect(DEFAULT_SYNTHETIC_LINE.robots).toBe(0);
    expect(DEFAULT_SYNTHETIC_LINE.robotMotion).toBe('static');
  });

  it('needs no assets at all, so a default run never touches the network', () => {
    expect(requiredAssets(DEFAULT_SYNTHETIC_LINE)).toEqual([]);
  });

  it('builds the same topology and the same drive count as before the extension', () => {
    handle = buildSyntheticLine(host, SMALL);
    expect(handle.surfaces.length).toBe(8);          // 2 lanes x 4 segments
    expect(handle.sensors.length).toBe(8);
    expect(handle.drives.length).toBe(8);            // belt drives only
    expect(host.drives.length).toBe(8);
    expect(handle.plan.scene?.robots).toBe(0);
    expect(handle.plan.scene?.conveyorDraws).toBe(0);
    expect(handle.plan.scene?.muMeshCount).toBe(1);
  });
});

describe('segment tiling', () => {
  it('tiles greedily longest-first and picks the matching library piece', () => {
    expect(tileSegment(5)).toEqual([3, 2]);
    expect(tileSegment(3)).toEqual([3]);
    expect(tileSegment(4)).toEqual([3, 1]);
    expect(tileSegment(0.5)).toEqual([]);
    expect(pieceForLength(3)).toBe('RollConveyor-3m');
    expect(pieceForLength(2)).toBe('RollConveyor-2m');
    expect(pieceForLength(1)).toBe('RollConveyor-1m');
    expect(pieceForLength(0.2)).toBeNull();
  });

  it('reports exactly the assets a configuration needs', () => {
    expect(requiredAssets({ ...DEFAULT_SYNTHETIC_LINE, ...SMALL, geometry: 'library' } as SyntheticLineConfig))
      .toEqual(['RollConveyor-3m', 'RollConveyor-2m']);
    expect(requiredAssets({ ...DEFAULT_SYNTHETIC_LINE, ...SMALL, muAsset: 'cartonbox' } as SyntheticLineConfig))
      .toEqual(['CartonBox']);
  });
});

describe('library conveyor geometry', () => {
  beforeEach(() => {
    setCachedAsset('RollConveyor-3m', fakeConveyorAsset(3));
    setCachedAsset('RollConveyor-2m', fakeConveyorAsset(2));
  });

  it('refuses to build when the assets were not preloaded', () => {
    clearSyntheticAssetCache();
    expect(() => buildSyntheticLine(host, { ...SMALL, geometry: 'library' }))
      .toThrow(/preload/);
  });

  it('adds InstancedMeshes and changes NOTHING about the transport topology', () => {
    const plain = buildSyntheticLine(host, SMALL);
    const surfaces = plain.surfaces.length;
    const sensors = plain.sensors.length;
    const drives = plain.drives.length;
    plain.dispose();

    handle = buildSyntheticLine(host, { ...SMALL, geometry: 'library' });
    expect(handle.surfaces.length).toBe(surfaces);
    expect(handle.sensors.length).toBe(sensors);
    expect(handle.drives.length).toBe(drives);

    // 8 segments x (3 m + 2 m) = 16 placements; 2 variants x 2 parts = 4 draws.
    const scene = handle.plan.scene!;
    expect(scene.conveyorPlacements).toBe(16);
    expect(scene.conveyorDraws).toBe(4);
    expect(scene.conveyorTriangles).toBeGreaterThan(0);
    // The point of instancing: 16 x 2 = 32 plain meshes were avoided.
    expect(scene.conveyorClonesAvoided).toBe(32);

    const instanced: InstancedMesh[] = [];
    handle.root.traverse((o) => {
      if ((o as InstancedMesh).isInstancedMesh && o.name.startsWith('__rvConv_')) {
        instanced.push(o as InstancedMesh);
      }
    });
    expect(instanced.length).toBe(4);
  });
});

describe('library MU asset', () => {
  it('merges a multi-mesh asset into ONE multi-material mesh and instances it (2026-09-25)', () => {
    setCachedAsset('CartonBox', fakeBoxAsset(3));
    handle = buildSyntheticLine(host, { ...SMALL, muAsset: 'cartonbox' });
    const scene = handle.plan.scene!;
    // `analyzeTemplate` instances a SINGLE-mesh template only, so the builder
    // merges the parts: one geometry with one group per part, each keeping
    // its own material. Same triangles, same materials — and the instanced path.
    expect(scene.muMeshCount).toBe(1);
    expect(scene.muTriangles).toBe(3 * 12);
    expect(scene.muInstanced).toBe(true);
    const template = handle.root.getObjectByName('MU_L0') as Mesh;
    expect(template.isMesh).toBe(true);
    expect(Array.isArray(template.material)).toBe(true);
    expect((template.material as Material[]).length).toBe(3);
    expect(template.geometry.groups.length).toBe(3);
  });

  it('takes the instanced path for a single-mesh asset', () => {
    setCachedAsset('CartonBox', fakeBoxAsset(1));
    handle = buildSyntheticLine(host, { ...SMALL, muAsset: 'cartonbox' });
    expect(handle.plan.scene!.muMeshCount).toBe(1);
    expect(handle.plan.scene!.muInstanced).toBe(true);
  });
});

describe('robots', () => {
  it('creates six rotary drives per robot and registers them with the host', () => {
    handle = buildSyntheticLine(host, { ...SMALL, robots: 3 });
    const scene = handle.plan.scene!;
    expect(scene.robots).toBe(3);
    expect(scene.robotDrives).toBe(3 * ROBOT_AXIS_COUNT);
    expect(scene.robotMeshes).toBe(3 * ROBOT_AXIS_COUNT);
    // 8 belt drives + 18 robot axes, all in the list CoreSubsystems ticks.
    expect(host.drives.length).toBe(8 + 3 * ROBOT_AXIS_COUNT);
  });

  it('holds its pose when static and moves every axis when erratic', () => {
    const staticHandle = buildSyntheticLine(host, { ...SMALL, robots: 2, robotMotion: 'static' });
    const staticAxes = axisPositions(staticHandle);
    runDrives(host, 120);
    expect(axisPositions(staticHandle)).toEqual(staticAxes);
    staticHandle.dispose();

    handle = buildSyntheticLine(host, { ...SMALL, robots: 2, robotMotion: 'erratic' });
    const before = axisPositions(handle);
    runDrives(host, 60);
    const after = axisPositions(handle);
    expect(after.length).toBe(before.length);
    // EVERY axis has to have moved — one stuck axis in twelve would be invisible
    // in an aggregate and would quietly halve the measured robot cost.
    for (let i = 0; i < before.length; i++) expect(after[i]).not.toBe(before[i]);
  });

  it('is deterministic: the same seed reaches the same poses at the same tick', () => {
    handle = buildSyntheticLine(host, { ...SMALL, robots: 2, robotMotion: 'erratic', seed: 4711 });
    runDrives(host, 200);
    const first = axisPositions(handle);
    handle.dispose();
    handle = null;

    const host2 = makeHost();
    const second = buildSyntheticLine(host2, { ...SMALL, robots: 2, robotMotion: 'erratic', seed: 4711 });
    for (let i = 0; i < 200; i++) for (const d of host2.drives) d.update(STEP);
    expect(axisPositions(second)).toEqual(first);
    second.dispose();
  });

  it('a different seed produces a different target stream', () => {
    handle = buildSyntheticLine(host, { ...SMALL, robots: 2, robotMotion: 'erratic', seed: 1 });
    runDrives(host, 200);
    const a = axisPositions(handle);
    handle.dispose();
    handle = null;

    const host2 = makeHost();
    const b = buildSyntheticLine(host2, { ...SMALL, robots: 2, robotMotion: 'erratic', seed: 2 });
    for (let i = 0; i < 200; i++) for (const d of host2.drives) d.update(STEP);
    expect(axisPositions(b)).not.toEqual(a);
    b.dispose();
  });

  it('owns no transport surface, sensor, source or sink', () => {
    const plain = buildSyntheticLine(host, SMALL);
    const counts = {
      surfaces: host.transportManager.surfaces.length,
      sensors: host.transportManager.sensors.length,
      sources: host.transportManager.sources.length,
      sinks: host.transportManager.sinks.length,
    };
    plain.dispose();

    handle = buildSyntheticLine(host, { ...SMALL, robots: 5, robotMotion: 'erratic' });
    expect(host.transportManager.surfaces.length).toBe(counts.surfaces);
    expect(host.transportManager.sensors.length).toBe(counts.sensors);
    expect(host.transportManager.sources.length).toBe(counts.sources);
    expect(host.transportManager.sinks.length).toBe(counts.sinks);
  });
});

describe('dispose gives back the realistic-scene extras', () => {
  it('removes robots, their drives and the library visuals completely', () => {
    setCachedAsset('RollConveyor-3m', fakeConveyorAsset(3));
    setCachedAsset('RollConveyor-2m', fakeConveyorAsset(2));
    setCachedAsset('CartonBox', fakeBoxAsset(2));

    const built = buildSyntheticLine(host, {
      ...SMALL, geometry: 'library', muAsset: 'cartonbox', robots: 4, robotMotion: 'erratic',
    });
    expect(host.drives.length).toBe(8 + 4 * ROBOT_AXIS_COUNT);
    expect(host.scene.children.length).toBeGreaterThan(0);

    built.dispose();

    expect(host.drives.length).toBe(0);
    expect(host.transportManager.surfaces.length).toBe(0);
    expect(host.transportManager.sensors.length).toBe(0);
    // Nothing of the line survives in the scene graph — no robot farm, no
    // conveyor InstancedMesh, no line root.
    let leftovers = 0;
    host.scene.traverse((o) => {
      if (o === host.scene) return;
      if (o.name === '__rvRobotFarm' || o.name === '__rvSyntheticLine' || o.name.startsWith('__rvConv_')) {
        leftovers++;
      }
    });
    expect(leftovers).toBe(0);
  });

  it('is idempotent', () => {
    const built = buildSyntheticLine(host, { ...SMALL, robots: 2, robotMotion: 'erratic' });
    built.dispose();
    expect(() => built.dispose()).not.toThrow();
    expect(host.drives.length).toBe(0);
  });
});

/** Current position of every robot axis, in build order. */
function axisPositions(h: SyntheticLineHandle): number[] {
  return h.drives.filter((d) => d.name.includes('/A')).map((d) => d.currentPosition);
}
