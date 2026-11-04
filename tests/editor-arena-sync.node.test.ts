// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.6 (sync part) + §9.10 — EditorArenaManager pre-frame sync,
 * visibility epoch, capture latch, empty-bucket removal, draw-call estimate.
 * Node environment: BatchedMesh bookkeeping only, no GPU.
 */
import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, Scene, type BatchedMesh } from 'three';
import { EditorArenaManager } from '../src/core/editor/rv-editor-arena';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { AutoFilterRegistry } from '../src/core/engine/rv-auto-filter-registry';
import { arenaSinkOf, sceneArenaSink } from '../src/core/engine/rv-arena-sink';
import { geometryKeyOf } from '../src/core/editor/rv-editor-arena-classify';
import { arenaMeshesIn, buildArenaFixture, testRoleOf, uberMat } from './helpers/editor-arena-fixture';

function setup() {
  const f = buildArenaFixture();
  const mgr = new EditorArenaManager({ scene: f.scene, roleOf: testRoleOf, perObjectCulling: false });
  mgr.build(f.root);
  const uberArena = mgr.refOf(f.uber[0])!.arena;
  return { ...f, mgr, uberArena };
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

describe('pre-frame matrix sync', () => {
  it('no change → zero setMatrixAt; one moved part → exactly its instance', () => {
    const { mgr, uber, uberArena, root } = setup();
    const spy = vi.spyOn(uberArena.mesh, 'setMatrixAt');
    mgr.beforeFrame();
    expect(spy).not.toHaveBeenCalled();

    uber[2].position.x += 5;
    root.updateMatrixWorld(true);
    mgr.beforeFrame();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(mgr.refOf(uber[2])!.instanceId);

    spy.mockClear();
    mgr.beforeFrame();
    expect(spy).not.toHaveBeenCalled();
  });

  it('root move updates every instance once, then settles', () => {
    const { mgr, root, uberArena, texA, all } = setup();
    const texArena = mgr.refOf(texA[0])!.arena;
    const spyU = vi.spyOn(uberArena.mesh, 'setMatrixAt');
    const spyA = vi.spyOn(texArena.mesh, 'setMatrixAt');
    root.position.set(1, 2, 3);
    root.updateMatrixWorld(true);
    mgr.beforeFrame();
    expect(spyU).toHaveBeenCalledTimes(7);
    expect(spyA).toHaveBeenCalledTimes(16);
    const instances = all.filter((m) => mgr.refOf(m)).length;
    expect(mgr.stats().instances).toBe(instances);
    spyU.mockClear(); spyA.mockClear();
    mgr.beforeFrame();
    expect(spyU).not.toHaveBeenCalled();
    expect(spyA).not.toHaveBeenCalled();
  });

  it('determinant flip switches the instance to the mirrored geometry copy', () => {
    const { mgr, uber, uberArena, root, sharedGeometry } = setup();
    const ref = mgr.refOf(uber[0])!;
    const plainId = uberArena.geometryIds.get(geometryKeyOf(sharedGeometry, false));
    const mirroredId = uberArena.geometryIds.get(geometryKeyOf(sharedGeometry, true));
    expect(ref.geometryId).toBe(plainId);
    expect(mirroredId).toBeDefined();
    const spy = vi.spyOn(uberArena.mesh, 'setGeometryIdAt');
    uber[0].scale.set(1, 1, -1);
    root.updateMatrixWorld(true);
    mgr.beforeFrame();
    expect(spy).toHaveBeenCalledWith(ref.instanceId, mirroredId);
    expect(mgr.refOf(uber[0])!.geometryId).toBe(mirroredId);
  });

  it('a flip to a geometry the arena does not hold yet adds the mirrored copy', () => {
    const { mgr, uber, uberArena, root } = setup();
    const geo = uber[3].geometry;
    expect(uberArena.geometryIds.has(geometryKeyOf(geo, true))).toBe(false);
    uber[3].scale.set(-1, 1, 1);
    root.updateMatrixWorld(true);
    mgr.beforeFrame();
    expect(uberArena.geometryIds.has(geometryKeyOf(geo, true))).toBe(true);
  });

  // Budget = BEST of 25 runs (the repo's load-robust timing convention, see
  // model-search.node.test.ts): the parallel node suite measured a 4 ms median
  // for the same loop that takes ~1.4 ms alone, so a median would gate on load.
  it('budget: 33k unchanged instances sync within machine-relative budget (best of 25)', () => {
    const scene = new Scene();
    const root = new Group();
    scene.add(root);
    const geo = new BoxGeometry();
    const mat = uberMat();
    const meshes: Mesh[] = [];
    for (let i = 0; i < 33_000; i++) {
      const m = new Mesh(geo, mat);
      m.position.set(i % 200, Math.floor(i / 200), 0);
      meshes.push(m);
      root.add(m);
    }
    root.updateMatrixWorld(true);
    const mgr = new EditorArenaManager({ scene, perObjectCulling: false, roleOf: () => undefined });
    mgr.build(root);
    expect(mgr.stats().instances).toBe(33_000);
    const elems = meshes.map((mesh) => new Float32Array(mesh.matrixWorld.elements));
    const c = new Float32Array(33_000 * 16);
    for (let i = 0; i < elems.length; i++) c.set(elems[i], i * 16);
    const referenceWork = () => {
      let equalCount = 0;
      const n = elems.length;
      for (let i = 0, o = 0; i < n; i++, o += 16) {
        const e = elems[i];
        if (
          e[12] === c[o + 12] && e[13] === c[o + 13] && e[14] === c[o + 14] &&
          e[0] === c[o] && e[1] === c[o + 1] && e[2] === c[o + 2] &&
          e[4] === c[o + 4] && e[5] === c[o + 5] && e[6] === c[o + 6] &&
          e[8] === c[o + 8] && e[9] === c[o + 9] && e[10] === c[o + 10] &&
          e[3] === c[o + 3] && e[7] === c[o + 7] && e[11] === c[o + 11] && e[15] === c[o + 15]
        ) {
          equalCount++;
          continue;
        }
      }
      return equalCount;
    };
    for (let i = 0; i < 5; i++) referenceWork();
    const referenceTimes: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      const equalCount = referenceWork();
      referenceTimes.push(performance.now() - t0);
      // Consume the result outside the timed region so the reference stays observable.
      expect(equalCount).toBe(33_000);
    }
    const referenceBest = Math.min(...referenceTimes);
    for (let i = 0; i < 5; i++) mgr.beforeFrame(); // warm-up
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t0 = performance.now();
      mgr.beforeFrame();
      times.push(performance.now() - t0);
    }
    const best = Math.min(...times);
    console.log(`[arena-sync] 33k unchanged: best ${best.toFixed(3)} ms, median ${median(times).toFixed(3)} ms`);
    console.log(`[arena-sync] reference: ${referenceBest.toFixed(3)} ms, ratio: ${(best / referenceBest).toFixed(2)}`);
    // Machine-relative budget. The reference is the same compare loop as beforeFrame over
    // the same memory layout, timed in this process, so the hardware factor cancels. Measured
    // healthy ratio sync/reference: 1.8-3.2 (i5-9600K, noisy under load; beforeFrame also reads the
    // _elems/_matrixCache fields). K = 5 leaves >=1.5x headroom for noise, while a real 3x
    // slowdown of beforeFrame gives ratio >= 5.4 and fails. The reference does not call
    // beforeFrame, so a regression cannot inflate its own budget. Absolute 20 ms cap below
    // catches pathological runs on any machine.
    const KMAX_RATIO = 5;
    expect(referenceBest).toBeGreaterThan(0);
    expect(best).toBeLessThanOrEqual(KMAX_RATIO * referenceBest);
    expect(best).toBeLessThanOrEqual(20);

    // one moved part among 33k
    const arena = mgr.refOf(meshes[0])!.arena;
    const spy = vi.spyOn(arena.mesh, 'setMatrixAt');
    meshes[12345].position.z = 9;
    meshes[12345].updateMatrixWorld(true);
    mgr.beforeFrame();
    expect(spy).toHaveBeenCalledTimes(1);
    mgr.dispose();
  });
});

describe('visibility epoch (F11)', () => {
  it('nothing changes before the bump; after it the chain decides (ancestor, rv.Hidden, trash)', () => {
    const { mgr, scene, root, uber, texA, uberArena } = setup();
    const holder = new Group();
    root.add(holder);
    holder.add(uber[1], texA[0]);
    root.updateMatrixWorld(true);
    holder.visible = false;
    mgr.beforeFrame();
    const visSpy = vi.spyOn(uberArena.mesh, 'setVisibleAt');
    expect(visSpy).not.toHaveBeenCalled();

    mgr.bumpVisibility();
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[1])!.instanceId)).toBe(false);
    const aRef = mgr.refOf(texA[0])!;
    expect(aRef.arena.mesh.getVisibleAt(aRef.instanceId)).toBe(false);
    // siblings outside the hidden subtree stay visible
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[2])!.instanceId)).toBe(true);
    // .visible of the sources is never written by the manager
    expect(uber[1].visible).toBe(true);

    // rv.Hidden on a visible node hides too
    uber[3].userData.realvirtual = { Hidden: true };
    mgr.bumpVisibility();
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[3])!.instanceId)).toBe(false);

    // trash: detached under an invisible group parked in the scene
    const trash = new Group();
    trash.visible = false;
    scene.add(trash);
    trash.add(uber[4]);
    mgr.bumpVisibility();
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[4])!.instanceId)).toBe(false);
    // fully detached → hidden
    uber[5].removeFromParent();
    mgr.bumpVisibility();
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[5])!.instanceId)).toBe(false);
  });

  it('meshes hidden at build become hidden instances; their .visible is untouched', () => {
    const f = buildArenaFixture();
    f.uber[2].visible = false;
    const mgr = new EditorArenaManager({ scene: f.scene, roleOf: testRoleOf });
    mgr.build(f.root);
    const ref = mgr.refOf(f.uber[2])!;
    expect(ref).toBeDefined();
    expect(ref.arena.mesh.getVisibleAt(ref.instanceId)).toBe(false);
    expect(f.uber[2].visible).toBe(false);
    expect(f.uber[2].layers.mask).toBe(0);
  });

  it('group registry and auto-filter writers bump through the scene sink', () => {
    const { mgr, scene, uber, uberArena } = setup();
    expect(arenaSinkOf(uber[0])).toBe(mgr);
    const groups = new GroupRegistry();
    groups.register('G', uber[2]);
    groups.setVisible('G', false);
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[2])!.instanceId)).toBe(false);
    groups.setVisible('G', true);
    mgr.beforeFrame();
    expect(uberArena.mesh.getVisibleAt(mgr.refOf(uber[2])!.instanceId)).toBe(true);
    expect(sceneArenaSink(scene)).toBe(mgr);
  });
});

describe('isolate = capture mode (B1)', () => {
  it('group isolate enters capture (sources on their layers + focus bit, arenas masked), showAll leaves', () => {
    const { mgr, scene, uber } = setup();
    const groups = new GroupRegistry();
    groups.register('G', uber[2]);
    groups.isolate('G');
    expect(mgr.captureDepth).toBe(1);
    expect(uber[2].layers.isEnabled(0)).toBe(true);
    expect(uber[2].layers.isEnabled(2)).toBe(true); // ISOLATE_FOCUS_LAYER
    expect(uber[3].layers.isEnabled(0)).toBe(true);
    for (const a of arenaMeshesIn(scene)) expect(a.layers.mask).toBe(0);
    groups.showAll();
    expect(mgr.captureDepth).toBe(0);
    expect(uber[2].layers.mask).toBe(0);
    expect(uber[3].layers.mask).toBe(0);
    for (const a of arenaMeshesIn(scene)) expect(a.layers.mask).toBe(1);
  });

  it('external isolate and auto-filter isolate hold one capture each and release it', () => {
    const { mgr, uber } = setup();
    const groups = new GroupRegistry();
    groups.setExternalIsolated([uber[1]]);
    expect(mgr.captureDepth).toBe(1);
    const filters = new AutoFilterRegistry();
    (filters as unknown as { _filters: Map<string, unknown> })._filters.set('T', { type: 'T', nodes: [uber[4]], visible: true });
    filters.isolate('T');
    expect(mgr.captureDepth).toBe(2);
    filters.showAll();
    groups.setExternalIsolated(null);
    expect(mgr.captureDepth).toBe(0);
    expect(uber[1].layers.mask).toBe(0);
  });

  it('a latch never leaves a manager it did not enter (rebuild in between)', () => {
    const { mgr, uber, root } = setup();
    const groups = new GroupRegistry();
    groups.setExternalIsolated([uber[1]]);
    mgr.dispose();
    const other = new EditorArenaManager({ scene: uber[1].parent!.parent!, roleOf: testRoleOf });
    other.build(root);
    groups.setExternalIsolated(null);
    expect(other.captureDepth).toBe(0);
    expect(uber[2].layers.mask).toBe(0);
  });
});

describe('structure bookkeeping', () => {
  it('empty bucket → arena removed from the scene and disposed', () => {
    const { mgr, scene, texA } = setup();
    const arena = mgr.refOf(texA[0])!.arena;
    const dispose = vi.spyOn(arena.mesh as BatchedMesh, 'dispose');
    expect(arenaMeshesIn(scene).length).toBe(3);
    mgr.remove(texA);
    expect(arenaMeshesIn(scene).length).toBe(2);
    expect(mgr.arenas.length).toBe(2);
    expect(dispose).toHaveBeenCalledTimes(1);
    for (const m of texA) expect(m.layers.mask).toBe(1);
  });

  it('draw-call estimate = visible renderables (arenas with a visible instance + visible standalone)', () => {
    const { mgr, texA, root } = setup();
    expect(mgr.stats()).toMatchObject({ arenas: 3, standalone: 5, drawCallsEstimate: 8 });
    const holder = new Group();
    root.add(holder);
    holder.add(...texA);
    holder.visible = false;
    mgr.bumpVisibility();
    mgr.beforeFrame();
    expect(mgr.stats().drawCallsEstimate).toBe(7);
    mgr.enterCapture();
    // capture: every visible source draws itself (7 uber + 16 B + 5 standalone)
    expect(mgr.stats().drawCallsEstimate).toBe(28);
    mgr.leaveCapture();
  });

  it('build() is idempotent and dispose() releases the scene sink', () => {
    const { mgr, scene, root } = setup();
    mgr.build(root);
    expect(arenaMeshesIn(scene).length).toBe(3);
    mgr.dispose();
    expect(arenaMeshesIn(scene).length).toBe(0);
    expect(sceneArenaSink(scene)).toBeNull();
  });
});

describe('runtime neutrality without a manager', () => {
  it('registries and sink lookups are no-ops on a scene without arenas', () => {
    const scene = new Scene();
    const node = new Group();
    scene.add(node);
    expect(arenaSinkOf(node)).toBeNull();
    const groups = new GroupRegistry();
    groups.register('G', node);
    groups.setVisible('G', false);
    groups.isolate('G');
    groups.setExternalIsolated([node]);
    groups.showAll();
    groups.setExternalIsolated(null);
    expect(node.visible).toBe(true);
    expect(node.layers.mask).toBe(1);
  });
});
