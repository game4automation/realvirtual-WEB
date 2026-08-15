// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-409 §9.4 — collision detection meets CSG material removal.
 *
 * Three failure modes, all of which only appear when plan-394 and plan-405 run
 * in the SAME scene, and none of which either subsystem can see on its own:
 *
 * 1. **The chunk meshes poison the body.** They are created at runtime, long
 *    after the one-shot BVH build, so a single one of them in the workpiece body
 *    sets `aabbOnly` for the WHOLE body and every pair it takes part in.
 * 2. **The workpiece vanishes.** `attachGrid()` hides the authored mesh; with
 *    the chunks excluded (1) the body would have no geometry left at all, so a
 *    real crash into the workpiece would go unreported.
 * 3. **Legitimate cutting alarms.** A milling cutter is supposed to be inside
 *    the workpiece. Muting that has to be narrow: only the pair the machining
 *    configuration actually names, and only while its spindle runs.
 *
 * The fixture is deliberately dimensioned so the STOCK box and the AUTHORED
 * mesh box are far apart — the cutter sits inside the stock envelope but well
 * outside the authored mesh, so "which box is the body using" is answered by
 * whether a collision is reported at all, not by a tolerance comparison.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVCollisionManager } from '../src/core/engine/rv-collision-manager';
import { RVMachiningVolume } from '../src/core/engine/rv-machining-volume';
import { RVMachiningTool } from '../src/core/engine/rv-machining-tool';
import { MachiningManager, type MachiningSignalHost } from '../src/core/engine/rv-machining-manager';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { applySchema, type ComponentContext } from '../src/core/engine/rv-component-registry';
import type { MachiningGridHandle } from '../src/core/engine/rv-machining-registry';
import { boxMesh, FakeHighlightHost } from './collision-fixture';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';

const DT = 1 / 60;

// Authored stock: 100 × 60 × 80 mm on a 32³ lattice.
//   voxel  = 100/(32-3) = 3.448 mm  → padding 1.5·voxel = 5.172 mm
//   extent = ±(50+5.172) mm = ±0.055172 m
// The same numbers the worker computes (`CsgKernel.computeGeometry`).
const STOCK_HALF_X = 0.055172;
const STOCK_HALF_Y = 0.033103;
const STOCK_HALF_Z = 0.044138;

/** Where a cutter is inside the STOCK envelope but outside the authored mesh. */
const IN_STOCK_ONLY = 0.05;

// ─── Fixture ────────────────────────────────────────────────────────────

interface Fixture {
  scene: Scene;
  collision: RVCollisionManager;
  registry: NodeRegistry;
  volume: RVMachiningVolume;
  volumeNode: Object3D;
  cutterNode: Object3D;
  machineNode: Object3D;
  highlight: FakeHighlightHost;
  ctx: ComponentContext;
}

function makeContext(
  registry: NodeRegistry, collision: RVCollisionManager, machining?: MachiningManager,
): ComponentContext {
  return {
    registry,
    scene: new Scene(),
    signalStore: {} as ComponentContext['signalStore'],
    transportManager: {} as ComponentContext['transportManager'],
    root: new Object3D(),
    collisionManager: collision,
    machiningManager: machining,
  } as unknown as ComponentContext;
}

/**
 * scene
 * ├─ Workpiece (role Workpiece, MachiningVolume) → a SMALL authored mesh
 * ├─ Cutter    (role Cutter,    MachiningTool)   → mesh at `IN_STOCK_ONLY`
 * └─ Machine   (role Machine)                    → mesh far off to the side
 */
function fixture(machining?: MachiningManager): Fixture {
  const scene = new Scene();
  const registry = new NodeRegistry();
  const collision = new RVCollisionManager();
  const highlight = new FakeHighlightHost();
  collision.setHighlightHost(highlight);

  const volumeNode = new Object3D();
  volumeNode.name = 'Workpiece';
  // 20 mm cube — an order of magnitude smaller than the 100 mm stock.
  volumeNode.add(boxMesh({ name: 'StockMesh', size: [0.02, 0.02, 0.02] }));

  const cutterNode = new Object3D();
  cutterNode.name = 'Cutter';
  cutterNode.add(boxMesh({ name: 'CutterMesh', size: [0.02, 0.02, 0.02] }));
  cutterNode.position.set(IN_STOCK_ONLY, 0, 0);

  const machineNode = new Object3D();
  machineNode.name = 'Machine';
  machineNode.add(boxMesh({ name: 'MachineMesh', size: [0.02, 0.02, 0.02] }));
  machineNode.position.set(0.5, 0, 0);

  scene.add(volumeNode, cutterNode, machineNode);
  scene.updateMatrixWorld(true);

  collision.register(volumeNode, 'Workpiece');
  collision.register(cutterNode, 'Cutter');
  collision.register(machineNode, 'Machine');

  const ctx = makeContext(registry, collision, machining);
  const volume = new RVMachiningVolume(volumeNode);
  applySchema(volume as unknown as Record<string, unknown>, RVMachiningVolume.schema, {
    gridResolution: { x: 32, y: 32, z: 32 },
    workpieceSize: { x: 100, y: 60, z: 80 },
  });
  volume.init(ctx);

  return {
    scene, collision, registry, volume, volumeNode, cutterNode, machineNode, highlight, ctx,
  };
}

/** A grid handle shaped like the worker's, enough for `attachGrid()`. */
function gridHandle(chunkCount = 8): MachiningGridHandle {
  return {
    id: 1,
    resolution: { x: 32, y: 32, z: 32 },
    chunkResolution: { x: 2, y: 2, z: 2 },
    chunkCount,
    voxelSizeMm: { x: 100 / 29, y: 60 / 29, z: 80 / 29 },
    gridOriginMm: { x: -55.172, y: -33.103, z: -44.138 },
    totalVoxels: 32 ** 3,
    initialSolidVoxels: 1000,
  };
}

/** Pair labels reported as latched, normalized and sorted. */
function reported(collision: RVCollisionManager): string[] {
  return collision.activePairs
    .map((p) => [p.aPath, p.bPath].sort().join('|'))
    .sort();
}

beforeEach(() => __resetCollisionAlertStore());
afterEach(() => vi.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════════
describe('chunk meshes never join a collision body (F3)', () => {
  it('cuts off the whole CsgChunks subtree, including UNMARKED children', () => {
    const f = fixture();
    // What the render side builds: a flagged container, and inside it meshes
    // that do NOT all carry the per-mesh flag (a helper the renderer may nest).
    const chunkRoot = new Object3D();
    chunkRoot.name = 'CsgChunks';
    chunkRoot.userData._rvMachiningChunks = true;
    const flagged = boxMesh({ name: 'Chunk_0', bvh: false });
    flagged.userData._rvMachiningChunk = 0;      // index 0 — falsy on purpose
    const unflagged = boxMesh({ name: 'ChunkHelper', bvh: false });
    chunkRoot.add(flagged, unflagged);
    f.volumeNode.add(chunkRoot);
    f.scene.updateMatrixWorld(true);

    f.collision.rebuild();
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.meshes.map((m) => m.mesh.name)).toEqual(['StockMesh']);
    // The decisive consequence: a BVH-less chunk would have degraded the whole
    // workpiece body to a box test for EVERY pair it takes part in.
    expect(body.aabbOnly).toBe(false);
    expect(body.baseAabbOnly).toBe(false);
  });

  it('still filters a chunk mesh that sits outside the container', () => {
    const f = fixture();
    const stray = boxMesh({ name: 'StrayChunk', bvh: false });
    stray.userData._rvMachiningChunk = 0;        // falsy index, must still match
    f.volumeNode.add(stray);
    f.scene.updateMatrixWorld(true);

    f.collision.rebuild();
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.meshes.map((m) => m.mesh.name)).toEqual(['StockMesh']);
    expect(body.aabbOnly).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('stock bounds stand in for the hidden workpiece (F4)', () => {
  it('reports null while no grid is attached — the authored meshes speak', () => {
    const f = fixture();
    expect(f.volume.getStockBoundsLocal()).toBeNull();

    f.collision.update(DT);
    // The cutter is outside the 20 mm authored mesh, so nothing is reported.
    expect(reported(f.collision)).toEqual([]);
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.aabbOnly).toBe(false);
  });

  it('picks the stock box up on the NEXT tick after an async attachGrid — no manual rebuild', () => {
    const f = fixture();
    // Real order of events: the bodies are built first, `attachGrid()` lands
    // asynchronously afterwards. A box installed only during rebuild would
    // therefore never be installed at all.
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);

    f.volume.attachGrid(gridHandle());
    f.scene.updateMatrixWorld(true);

    f.collision.update(DT);                       // no rebuild() call anywhere
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece']);
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.aabbOnly).toBe(true);             // a box has no triangles
    expect(body.baseAabbOnly).toBe(false);        // ...but only for this reason
  });

  it('returns to the authored mesh bounds after teardownRender — again without a manual rebuild', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece']);

    f.collision.reset();
    f.volume.teardownRender();                    // grid destroyed / degraded
    expect(f.volume.getStockBoundsLocal()).toBeNull();

    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.aabbOnly).toBe(false);            // triangle precision restored
    expect(body.meshes.map((m) => m.mesh.name)).toEqual(['StockMesh']);
  });

  it('covers the true stock extent including the grid padding', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    const box = f.volume.getStockBoundsLocal()!;
    expect(box.min.x).toBeCloseTo(-STOCK_HALF_X, 5);
    expect(box.max.x).toBeCloseTo(STOCK_HALF_X, 5);
    expect(box.min.y).toBeCloseTo(-STOCK_HALF_Y, 5);
    expect(box.max.y).toBeCloseTo(STOCK_HALF_Y, 5);
    expect(box.min.z).toBeCloseTo(-STOCK_HALF_Z, 5);
    expect(box.max.z).toBeCloseTo(STOCK_HALF_Z, 5);
  });

  it('gives Cylinder the same domain box and Mesh the authored geometry bounds', () => {
    // Cylinder: inscribed in the workpieceSize box, so the box bounds it.
    const cyl = fixture();
    cyl.volume.Shape = 'Cylinder';
    cyl.volume.attachGrid(gridHandle());
    const cylBox = cyl.volume.getStockBoundsLocal()!;
    expect(cylBox.max.x).toBeCloseTo(STOCK_HALF_X, 5);
    expect(cylBox.max.y).toBeCloseTo(STOCK_HALF_Y, 5);

    // Mesh: the domain is the authored geometry (a 20 mm cube = ±10 mm), so the
    // box must be MUCH smaller than the 100 mm workpieceSize box.
    const mesh = fixture();
    mesh.volume.Shape = 'Mesh';
    mesh.volume.attachGrid(gridHandle());
    const meshBox = mesh.volume.getStockBoundsLocal()!;
    // 20 mm domain, voxel = 20/29, padding 1.5·voxel → ±(10 + 1.034) mm.
    expect(meshBox.max.x).toBeCloseTo(0.011034, 5);
    expect(meshBox.max.x).toBeLessThan(STOCK_HALF_X);
  });

  it('follows translation, rotation and non-uniform scale of the volume node', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());

    // Non-uniform scale + a quarter turn about Y (swaps the X and Z extents) +
    // a translation. `Box3.applyMatrix4` transforms all eight corners, which is
    // the only form that survives this.
    f.volumeNode.position.set(1, 2, 3);
    f.volumeNode.rotation.y = Math.PI / 2;
    f.volumeNode.scale.set(2, 1, 1);
    f.scene.updateMatrixWorld(true);

    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)
      ?? (f.collision.rebuild(), f.collision.bodies.find((b) => b.root === f.volumeNode)!);
    f.collision.updateBodyBounds(body);

    // Local +X (scaled ×2) points along world −Z after the rotation; local +Z
    // points along world +X.
    expect(body.worldBox.min.x).toBeCloseTo(1 - STOCK_HALF_Z, 4);
    expect(body.worldBox.max.x).toBeCloseTo(1 + STOCK_HALF_Z, 4);
    expect(body.worldBox.max.y).toBeCloseTo(2 + STOCK_HALF_Y, 4);
    expect(body.worldBox.max.z).toBeCloseTo(3 + 2 * STOCK_HALF_X, 4);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('machining suppression mutes exactly the machined pair (F5/F6)', () => {
  it('silences Cutter↔Workpiece while the spindle runs and nothing else', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);

    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);

    // The very same cutter against the MACHINE is still a crash.
    f.cutterNode.position.set(0.5, 0, 0);
    f.scene.updateMatrixWorld(true);
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Machine']);
  });

  it('latches the contact again as soon as the spindle goes off', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);

    // Spindle off while still buried in the material IS the crash case.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, false);
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece']);
  });

  it('keeps a pair muted until the LAST association on it goes inactive (refcount)', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    // Two volumes may share one tool, or a volume may list it twice — both end
    // up as two associations resolving to the SAME body pair.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    f.collision.setMachiningAssociation('a2', f.cutterNode, f.volumeNode, true);

    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, false);
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);          // a2 still holds it

    f.collision.removeMachiningAssociation('a2');
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece']);
  });

  it('applies an association reported BEFORE the bodies were ever built', () => {
    const f = fixture();
    // Scene-ready order: machining reports its initial state, the collision
    // bodies are built later. The registry is body-index independent for this.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    expect(f.collision.suppressedPairKeys.size).toBe(0);   // unresolvable yet

    f.volume.attachGrid(gridHandle());
    f.collision.update(DT);                               // rebuild + resolve
    expect(f.collision.suppressedPairKeys.size).toBe(1);
    expect(reported(f.collision)).toEqual([]);
  });

  it('leaves the ignoreType mechanism completely untouched', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.ignoreType('Cutter', 'Workpiece');
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);
    // The two systems are separate: ignoring a TYPE does not create an
    // association, and no association was needed to silence it.
    expect(f.collision.ignoredTypes.has('Cutter|Workpiece')).toBe(true);
    expect(f.collision.suppressedPairKeys.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('association → body resolution (nearest role-carrying ancestor)', () => {
  /** Bare bodies — no machining components needed to exercise the rule. */
  function roleScene() {
    const scene = new Scene();
    const collision = new RVCollisionManager();
    collision.setHighlightHost(new FakeHighlightHost());
    const spindle = new Object3D(); spindle.name = 'Spindle';
    const tool = new Object3D(); tool.name = 'ToolNode';
    const toolTip = new Object3D(); toolTip.name = 'ToolTip';
    spindle.add(tool); tool.add(toolTip);
    const wp = new Object3D(); wp.name = 'WP';
    wp.add(boxMesh({ name: 'WPMesh' }));
    spindle.add(boxMesh({ name: 'SpindleMesh' }));
    scene.add(spindle, wp);
    scene.updateMatrixWorld(true);
    collision.register(wp, 'Workpiece');
    return { scene, collision, spindle, tool, toolTip, wp };
  }

  it('resolves a role sitting on the machining node itself', () => {
    const s = roleScene();
    s.collision.register(s.tool, 'Cutter');
    s.collision.rebuild();
    s.collision.setMachiningAssociation('a', s.tool, s.wp, true);
    expect(s.collision.suppressedPairKeys.size).toBe(1);
  });

  it('resolves a role sitting on an ANCESTOR of the machining node', () => {
    const s = roleScene();
    s.collision.register(s.spindle, 'Cutter');     // role one level up
    s.collision.rebuild();
    s.collision.setMachiningAssociation('a', s.tool, s.wp, true);
    expect(s.collision.suppressedPairKeys.size).toBe(1);
  });

  it('suppresses nothing and warns once when the role is only on a CHILD', () => {
    const s = roleScene();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    s.collision.register(s.toolTip, 'Cutter');     // role BELOW the tool node
    s.collision.rebuild();
    s.collision.setMachiningAssociation('a', s.tool, s.wp, true);

    expect(s.collision.suppressedPairKeys.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('only on a CHILD');

    // Warn ONCE, not every rebuild.
    s.collision.rebuild();
    s.collision.setMachiningAssociation('b', s.tool, s.wp, true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('mutes nothing when both sides resolve to the SAME body', () => {
    const s = roleScene();
    s.collision.register(s.spindle, 'Cutter');
    s.collision.rebuild();
    // Tool and "volume" both inside the spindle body — there is no pair.
    s.collision.setMachiningAssociation('a', s.tool, s.toolTip, true);
    expect(s.collision.suppressedPairKeys.size).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('unlatching a pair that became legitimate (F8)', () => {
  it('drops the latched card of the muted pair and republishes, keeping others', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());

    // An unrelated, genuinely crashing pair that must survive untouched.
    const robot = new Object3D();
    robot.name = 'Robot';
    robot.add(boxMesh({ name: 'RobotMesh', size: [0.02, 0.02, 0.02] }));
    robot.position.set(0.505, 0, 0);
    f.scene.add(robot);
    f.scene.updateMatrixWorld(true);
    f.collision.register(robot, 'Robot');

    // Spindle off: the cutter in the material latches as a crash.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, false);
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece', 'Machine|Robot']);
    expect(f.highlight.current).toContain(f.cutterNode);

    // Spindle on: the same contact is now legitimate cutting. Without the
    // unlatch the stale card and outline would simply stay.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    expect(reported(f.collision)).toEqual(['Machine|Robot']);
    expect(f.highlight.current).not.toContain(f.cutterNode);
    expect(f.highlight.current).toContain(robot);

    // ...and it stays gone across ticks.
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Machine|Robot']);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('cost of the suppression (F7)', () => {
  it('precomputes every pair key at rebuild — the tick only looks one up', () => {
    const f = fixture();
    f.collision.rebuild();
    for (const pair of f.collision.pairs) {
      expect(pair.pairKey.length).toBeGreaterThan(0);
      expect(pair.pairKey).toContain(f.collision.bodies[pair.i].key);
      expect(pair.pairKey).toContain(f.collision.bodies[pair.j].key);
    }
    // Stable across ticks: nothing in the tick rebuilds or re-derives them.
    const before = f.collision.pairs.map((p) => p.pairKey);
    f.collision.update(DT);
    f.collision.update(DT);
    expect(f.collision.pairs.map((p) => p.pairKey)).toEqual(before);
  });

  it('never triggers a rebuild when the spindle toggles', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.update(DT);
    expect(f.collision.isDirty).toBe(false);

    const rebuild = vi.spyOn(f.collision, 'rebuild');
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, false);
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);

    expect(rebuild).not.toHaveBeenCalled();
    expect(f.collision.isDirty).toBe(false);
  });

  it('ignores a repeated report of an unchanged state', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.rebuild();
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    const keys = [...f.collision.suppressedPairKeys];
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    expect([...f.collision.suppressedPairKeys]).toEqual(keys);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('lifecycle', () => {
  it('clear() drops associations, suppression and stock sources', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    f.collision.update(DT);
    expect(f.collision.suppressedPairKeys.size).toBe(1);

    f.collision.clear();
    expect(f.collision.suppressedPairKeys.size).toBe(0);
    f.collision.update(DT);
    expect(f.collision.bodies).toHaveLength(0);

    // A stale association arriving after clear() must not resurrect anything.
    f.collision.setMachiningAssociation('a1', f.cutterNode, f.volumeNode, true);
    expect(f.collision.suppressedPairKeys.size).toBe(0);
  });

  it('unregisters the stock source when the volume is disposed', () => {
    const f = fixture();
    f.volume.attachGrid(gridHandle());
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual(['Cutter|Workpiece']);

    f.collision.reset();
    f.volume.dispose();
    f.collision.update(DT);
    expect(reported(f.collision)).toEqual([]);
    const body = f.collision.bodies.find((b) => b.root === f.volumeNode)!;
    expect(body.stockSources).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
describe('MachiningManager reports the spindle state (F5, end to end)', () => {
  class FakeSignals implements MachiningSignalHost {
    readonly values = new Map<string, boolean | number>();
    getBoolByPath(path: string): boolean { return this.values.get(path) === true; }
    setByPath(path: string, value: boolean | number): void { this.values.set(path, value); }
  }

  /** Wires a real MachiningManager with one volume + one tool onto the fixture. */
  function wired(signalPath: string | null, signalValue?: boolean) {
    const machining = new MachiningManager();
    const f = fixture(machining);
    const signals = new FakeSignals();
    if (signalPath && signalValue !== undefined) signals.values.set(signalPath, signalValue);
    machining.setSignalHost(signals);
    machining.setCollisionBridge(f.collision);

    const tool = new RVMachiningTool(f.cutterNode);
    applySchema(tool as unknown as Record<string, unknown>, RVMachiningTool.schema, {
      Shape: 'Cylinder', ToolDiameter: 10, ToolLength: 40,
    });
    tool.init(f.ctx);
    f.registry.registerNode('Cutter', f.cutterNode);
    f.registry.register('MachiningTool', 'Cutter', tool);
    f.volume.Tools = [f.cutterNode];
    f.volume.SignalSpindleOn = signalPath;
    f.volume.onSceneReady(f.ctx);            // resolveTools + register + initial report
    f.volume.attachGrid(gridHandle());
    return { ...f, machining, signals, tool };
  }

  it('treats a MISSING SignalSpindleOn as "spindle always on" (parity with the cut gate)', () => {
    const s = wired(null);
    s.collision.update(DT);
    // Same rule the subtraction gate uses: without a signal it always cuts, so
    // contact is always legitimate. Crash monitoring here needs an authored signal.
    expect(reported(s.collision)).toEqual([]);
  });

  it('reports the INITIAL state at registration, not on the first machining tick', () => {
    const s = wired(null);
    // Deliberately NO `machining.update()`: the report has to have happened in
    // `register()` already, otherwise a scene whose spindle is on from the very
    // first frame alarms before anything ever changes.
    s.collision.update(DT);
    expect(s.collision.suppressedPairKeys.size).toBe(1);
    expect(reported(s.collision)).toEqual([]);
  });

  it('does not suppress while the authored spindle signal is false', () => {
    const s = wired('Sig/SpindleOn', false);
    s.machining.update(DT);
    s.collision.update(DT);
    expect(reported(s.collision)).toEqual(['Cutter|Workpiece']);
  });

  it('suppresses while the authored spindle signal is true, and follows it live', () => {
    const s = wired('Sig/SpindleOn', true);
    s.machining.update(DT);
    s.collision.update(DT);
    expect(reported(s.collision)).toEqual([]);

    s.signals.values.set('Sig/SpindleOn', false);
    s.machining.update(DT);
    s.collision.update(DT);
    expect(reported(s.collision)).toEqual(['Cutter|Workpiece']);
  });

  it('withdraws the suppression when the volume is unregistered', () => {
    const s = wired('Sig/SpindleOn', true);
    s.machining.update(DT);
    s.collision.update(DT);                  // builds the bodies → resolves it
    expect(s.collision.suppressedPairKeys.size).toBe(1);

    s.machining.unregister(s.volume);
    expect(s.collision.suppressedPairKeys.size).toBe(0);

    // The teardown also gives the authored workpiece back, so the stock box is
    // gone as well — the cutter now sits in empty space next to a 20 mm cube.
    s.collision.update(DT);
    expect(reported(s.collision)).toEqual([]);
    expect(s.volume.getStockBoundsLocal()).toBeNull();
  });
});
