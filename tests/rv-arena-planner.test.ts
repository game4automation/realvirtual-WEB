// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Group,
  Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
} from 'three';
import {
  ARENA_PLANNER_FLAG_KEY,
  ARENA_PLANNER_VERSION,
  AdvancedArenaPlanner,
  arenaPlannerRegistry,
  resolveArenaPlan,
  type ArenaPlanner,
  type PlanContext,
} from '../src/core/engine/rv-arena-planner';
import { buildBatchedScene, isBatchSafe } from '../src/core/engine/rv-batched-render';
import { BatchTable } from '../src/core/engine/rv-batch-table';

const NO_DRIVES: ReadonlySet<Object3D> = new Set();

function staticMesh(name: string, geometry: BufferGeometry, material: Material): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  return mesh;
}

function pair(): { root: Group; meshes: [Mesh, Mesh]; material: Material; geometry: BufferGeometry } {
  const root = new Group();
  const geometry = new BoxGeometry();
  const material = new MeshStandardMaterial();
  const a = staticMesh('a', geometry, material);
  const b = staticMesh('b', geometry, material);
  b.position.x = 2;
  b.updateMatrix();
  root.add(a, b);
  root.updateMatrixWorld(true);
  return { root, meshes: [a, b], material, geometry };
}

function ctx(overrides?: Partial<PlanContext>): PlanContext {
  return {
    sharedUber: null,
    driveNodeSet: NO_DRIVES,
    shouldAbort: () => false,
    ...overrides,
  };
}

beforeEach(() => {
  arenaPlannerRegistry.register(null);
  localStorage.removeItem(ARENA_PLANNER_FLAG_KEY);
});

afterEach(() => {
  arenaPlannerRegistry.register(null);
  localStorage.removeItem(ARENA_PLANNER_FLAG_KEY);
  vi.restoreAllMocks();
});

describe('ArenaPlanner registry and fallback', () => {
  it('Test_Registry_Empty_UsesAdvancedDefault', () => {
    const { root, meshes } = pair();
    const resolved = resolveArenaPlan(root, meshes, ctx());
    expect(resolved.planner).toBe('advanced');
    expect(resolved.groups).toHaveLength(1);
  });

  it('Test_VersionMismatch_WarnsBaseline', () => {
    const { root, meshes } = pair();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    arenaPlannerRegistry.register({ version: ARENA_PLANNER_VERSION + 1, plan: () => [] });
    const resolved = resolveArenaPlan(root, meshes, ctx());
    expect(resolved.planner).toBe('baseline');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider version'));
  });

  it('Test_KillSwitch_ForcesBaseline', () => {
    const { root, meshes } = pair();
    const advanced: ArenaPlanner = {
      version: ARENA_PLANNER_VERSION,
      plan: () => [{ anchor: null, groupKey: 'advanced', meshes }],
    };
    arenaPlannerRegistry.register(advanced);
    localStorage.setItem(ARENA_PLANNER_FLAG_KEY, 'off');
    expect(resolveArenaPlan(root, meshes, ctx()).planner).toBe('baseline');
  });

  it('Test_PlannerThrows_FallsBackToBaseline_NoSourceTouched', async () => {
    const root = new Group();
    const material = new MeshStandardMaterial();
    const meshes: [Mesh, Mesh] = [
      staticMesh('a', new BoxGeometry(), material),
      staticMesh('b', new BoxGeometry(), material),
    ];
    root.add(...meshes);
    root.updateMatrixWorld(true);
    arenaPlannerRegistry.register({
      version: ARENA_PLANNER_VERSION,
      plan: () => { throw new Error('planner failed'); },
    });
    const table = new BatchTable();
    const result = await buildBatchedScene(root, null, NO_DRIVES, table);
    expect(result.staticTextured.instanceCount).toBe(0);
    expect(table.batches).toHaveLength(0);
    for (const mesh of meshes) {
      expect(mesh.layers.mask).toBe(1);
      expect(mesh.userData._rvBatchSource).toBeUndefined();
    }
  });

  it.each(['duplicateMesh', 'foreignMesh', 'unsafeMesh', 'badAnchor'])(
    'Test_PlanValidation_%s_Rejected',
    (failure) => {
      const { root, meshes } = pair();
      const foreign = staticMesh('foreign', meshes[0].geometry, meshes[0].material as Material);
      const unsafe = staticMesh('unsafe', meshes[0].geometry, meshes[0].material as Material);
      unsafe.visible = false;
      const badAnchor = new Object3D();
      const driveNodeSet = new Set<Object3D>([badAnchor]);
      arenaPlannerRegistry.register({
        version: ARENA_PLANNER_VERSION,
        plan: () => {
          if (failure === 'duplicateMesh') return [{ anchor: null, groupKey: 'bad', meshes: [meshes[0], meshes[0]] }];
          if (failure === 'foreignMesh') return [{ anchor: null, groupKey: 'bad', meshes: [meshes[0], foreign] }];
          if (failure === 'unsafeMesh') return [{ anchor: null, groupKey: 'bad', meshes: [meshes[0], unsafe] }];
          return [{ anchor: badAnchor, groupKey: 'bad', meshes }];
        },
      });
      const resolved = resolveArenaPlan(root, meshes, ctx({ driveNodeSet }));
      expect(resolved.planner).toBe('baseline');
      expect(resolved.groups).toHaveLength(1);
    },
  );
});

describe('isBatchSafe correctness gate', () => {
  it('Test_Baseline_ExcludesAllUnsafe', () => {
    const material = new MeshStandardMaterial();
    const make = (name: string) => staticMesh(name, new BoxGeometry(), material);
    const cases: Mesh[] = [];

    const skinned = make('skinned') as Mesh & { skeleton?: unknown };
    skinned.skeleton = {};
    cases.push(skinned);
    const morphed = make('morphed');
    morphed.morphTargetInfluences = [0];
    cases.push(morphed);
    const multi = staticMesh('multi', new BoxGeometry(), [material, material] as unknown as Material);
    cases.push(multi);
    const hidden = make('hidden');
    hidden.visible = false;
    cases.push(hidden);
    const hiddenParent = new Object3D();
    hiddenParent.visible = false;
    const hiddenChild = make('hidden-parent-child');
    hiddenParent.add(hiddenChild);
    cases.push(hiddenChild);
    for (const key of ['TransportSurface', 'Source', 'Sink', 'MU', 'Cam']) {
      const parent = new Object3D();
      parent.userData.realvirtual = { [key]: {} };
      const child = make(`${key}-child`);
      parent.add(child);
      cases.push(child);
    }
    for (const type of ['Pipe', 'Tank']) {
      const mesh = make(type);
      mesh.userData._rvType = type;
      cases.push(mesh);
      const parent = new Object3D();
      parent.userData._rvType = type;
      const child = make(`${type}-parent-child`);
      parent.add(child);
      cases.push(child);
    }
    for (const name of ['part_sensorViz', '_tankFillViz']) cases.push(make(name));
    for (const tag of ['_rvBatchSource', '_rvBatchedRender', '_rvRaycastBVH', '_highlightOverlay', '_driveHoverOverlay', '_isGhostOverlay']) {
      const mesh = make(tag);
      mesh.userData[tag] = true;
      cases.push(mesh);
    }

    for (const mesh of cases) {
      const root = new Group();
      let top: Object3D = mesh;
      while (top.parent) top = top.parent;
      root.add(top);
      root.updateMatrixWorld(true);
      expect(isBatchSafe(mesh, root), mesh.name).toBe(false);
    }
  });
});

describe('planner execution parity and abort contracts', () => {
  it('Test_ThreeWayParity_DataDrivenTransformsWindingAndSourceContract', async () => {
    const build = async (planner: ArenaPlanner | null) => {
      const { root, meshes, geometry } = pair();
      meshes[1].scale.z = -1;
      meshes[1].updateMatrix();
      root.updateMatrixWorld(true);
      const sourceIndex = Array.from(geometry.index!.array);
      arenaPlannerRegistry.register(planner);
      const table = new BatchTable();
      const result = await buildBatchedScene(root, null, NO_DRIVES, table);
      const matrices = meshes.map((mesh) => mesh.matrixWorld.clone());
      return { root, meshes, geometry, sourceIndex, table, result, matrices };
    };

    const baseline = await build(null);
    const advanced = await build(new AdvancedArenaPlanner());
    for (const built of [baseline, advanced]) {
      expect(built.result.staticTextured.instanceCount).toBe(2);
      expect(Array.from(built.geometry.index!.array)).toEqual(built.sourceIndex);
      for (let i = 0; i < built.meshes.length; i++) {
        const ref = built.table.refFor(built.meshes[i])!;
        const actual = new Matrix4();
        ref.batch.getMatrixAt(ref.instanceId, actual);
        expect(actual.elements).toEqual(built.matrices[i].elements);
        expect(built.meshes[i].layers.mask).toBe(0);
        expect(built.meshes[i].visible).toBe(true);
        expect(built.meshes[i].userData._rvBatchSource).toBe(true);
      }
    }

    const off = pair();
    off.meshes[1].scale.z = -1;
    off.meshes[1].updateMatrix();
    off.root.updateMatrixWorld(true);
    expect(off.meshes.map((mesh) => mesh.matrixWorld.elements)).toEqual(
      baseline.matrices.map((matrix) => matrix.elements),
    );
  });

  it('Test_SourceContract_Unchanged', async () => {
    const { root, meshes, geometry } = pair();
    const position = geometry.getAttribute('position');
    const table = new BatchTable();
    await buildBatchedScene(root, null, NO_DRIVES, table);
    for (const mesh of meshes) {
      expect(mesh.geometry).toBe(geometry);
      expect(mesh.geometry.getAttribute('position')).toBe(position);
      expect(mesh.visible).toBe(true);
      expect(mesh.layers.mask).toBe(0);
      expect(mesh.userData._rvBatchInstance).toBeTruthy();
    }
  });

  it('Test_AbortAfterPlan_BeforeFirstFill_NoSourceTouched', async () => {
    const { root, meshes } = pair();
    let abort = false;
    arenaPlannerRegistry.register({
      version: ARENA_PLANNER_VERSION,
      plan: () => {
        abort = true;
        return [{ anchor: null, groupKey: 'abort', meshes }];
      },
    });
    const table = new BatchTable();
    await buildBatchedScene(root, null, NO_DRIVES, table, { shouldAbort: () => abort });
    expect(table.batches).toHaveLength(0);
    for (const mesh of meshes) expect(mesh.layers.mask).toBe(1);
  });

  it('Test_AbortInFillArenaYield_NoSourceTouched', async () => {
    const { root, meshes } = pair();
    arenaPlannerRegistry.register(new AdvancedArenaPlanner());
    let abort = false;
    const table = new BatchTable();
    await buildBatchedScene(root, null, NO_DRIVES, table, {
      shouldAbort: () => abort,
      onArenaBuild: () => { abort = true; },
    });
    expect(table.batches).toHaveLength(0);
    for (const mesh of meshes) expect(mesh.layers.mask).toBe(1);
  });
});
