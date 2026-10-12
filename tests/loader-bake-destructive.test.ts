// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.4 — the loader on the DESTRUCTIVE pipeline
 * (`load → prepare → bake → drop → place → init`), the rewrite of
 * `loader-bake-inplace.test.ts`.
 *
 * A real `loadGLB` over an in-memory GLB pins what the plan says the scene
 * graph must be afterwards:
 *  - a plain `scene.traverse` reaches every node there is (G4): survivors +
 *    chunk meshes, nothing masked, nothing detached, no ghosts;
 *  - the nodes the removal report named as removal tops are GONE and no longer
 *    resolve in the registry, while every survivor keeps its authored path;
 *  - a component node whose mesh was merged (`RuntimeMetadata`) is a plain
 *    `Group` that the registry, the component and the pick window all resolve
 *    to the same object;
 *  - chunk meshes are real children of their boundary, carry `_rvBakeChunk`
 *    and are NOT registered as document nodes.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { segmentRange } from '../src/core/engine/rv-pick-structure';
import { RAYCAST_BLOCKED } from '../src/core/engine/rv-raycast-manager';
import { bakeRemovalReport, _resetBakeRemovalReportForTesting } from '../src/core/engine/rv-bake-survival';
import { bakeEvents, _resetBakeEventsForTesting } from '../src/core/engine/rv-bake-pipeline';

const material = new MeshStandardMaterial({ color: 0x445566 });

function box(name: string, pos: [number, number, number], extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

/**
 *   Plant
 *   ├─ Frame                 plain mesh                 → removed
 *   ├─ Cad                   plain group                → removed
 *   │   └─ Bolt              plain mesh                 → removed
 *   ├─ Info {RuntimeMetadata} (mesh!)                   → survives WITHOUT its mesh
 *   ├─ Axis {Drive}                                     → boundary (own chunk)
 *   │   └─ Arm               plain mesh                 → removed, triangles in Axis' chunk
 *   └─ Beacon {Lamp}         keep mesh                  → survives AS a mesh
 */
function buildPlant(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(box('Frame', [0, 0, 0]));
  const cad = new Group(); cad.name = 'Cad'; cad.add(box('Bolt', [2, 0, 0]));
  plant.add(cad);
  plant.add(box('Info', [4, 0, 0], { RuntimeMetadata: { Content: 'hello' } }));
  const axis = new Group(); axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY', TargetSpeed: 250 } };
  axis.add(box('Arm', [8, 0, 0]));
  plant.add(axis);
  plant.add(box('Beacon', [12, 0, 0], { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } }));
  return plant;
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildPlant()); });

async function load(opts: { preserveHierarchy?: boolean } = {}): Promise<{ result: LoadResult; scene: Scene }> {
  const scene = new Scene();
  _resetBakeRemovalReportForTesting();
  const result = await loadGLB('plant.glb', scene, {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    preserveHierarchy: opts.preserveHierarchy,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
  });
  return { result, scene };
}

/** Every node a PLAIN traverse reaches, chunk meshes excluded. */
function documentNodeNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((n) => { if (!n.userData[RV_BAKE_CHUNK_KEY]) names.push(n.name); });
  return names.sort();
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

describe('loader bake, destructive (plan-754 §9.4)', () => {
  beforeEach(() => { _resetBakeEventsForTesting(); });

  it('the placed root IS the bake template and the model is baked', async () => {
    const { result, scene } = await load();
    expect(result.bakedAsset).toBeTruthy();
    expect(result.bakedAsset!.destructive).toBe(true);
    expect(result.bakeInstance).toBeTruthy();
    expect(result.root).toBe(result.bakedAsset!.template);
    expect(result.root.parent).toBe(scene);
    expect(result.bakedAsset!.chunks.length).toBeGreaterThan(0);
  });

  // Ported from `loader-bake-inplace.test.ts` when plan-754 Phase 1c deleted
  // that file: the guard is about the UNBAKED path, not about which bake ran.
  // An authoring load must never reach `bake()`, so the full authored tree
  // survives and every mesh stays a drawn mesh of its own.
  it('§9.12: a preserveHierarchy load never reaches bake() and installs nothing baked', async () => {
    const { result } = await load({ preserveHierarchy: true });
    expect(result.bakedAsset ?? null).toBeNull();
    expect(result.bakeInstance ?? null).toBeNull();
    expect(bakeEvents.some((e) => e.allowed)).toBe(false);
    for (const name of ['Frame', 'Arm', 'Beacon']) {
      const node = findByName(result.root, name);
      expect(node, name).toBeTruthy();
      expect((node as Mesh).layers.mask).toBe(1);
    }
  });

  it('removal tops are really gone; survivors keep their authored path (G4)', async () => {
    const { result } = await load();
    const report = bakeRemovalReport[0];
    expect(report).toBeTruthy();

    const names = documentNodeNames(result.root);
    for (const survivor of ['Plant', 'Info', 'Axis', 'Beacon']) expect(names).toContain(survivor);
    for (const removed of ['Frame', 'Cad', 'Bolt', 'Arm']) expect(names).not.toContain(removed);

    // The registry is built FROM the final graph: a removed path resolves to
    // nothing, a survivor path to the node the plain traverse found.
    for (const p of report.removalTops) expect(result.registry.getNode(p), p).toBeNull();
    const axis = result.registry.getNode('Plant/Axis');
    expect(axis).toBe(findByName(result.root, 'Axis'));
  });

  it('nothing is masked, nothing is ghosted — a plain traverse is complete (G4)', async () => {
    const { result } = await load();
    let masked = 0;
    let ghostHolders = 0;
    result.root.traverse((n) => {
      if ((n as Mesh).isMesh && n.layers.mask === 0) masked++;
      if ((n.userData as Record<string, unknown>)._rvHiddenChildren) ghostHolders++;
    });
    expect(masked).toBe(0);
    expect(ghostHolders).toBe(0);
    // and no window table to reconcile — segments are the only table (plan-756)
    for (const chunk of result.bakedAsset!.chunks) expect(chunk.pick.segmentCount).toBeGreaterThan(0);
  });

  it('a merged component node is a plain Group the registry, component and pick table agree on', async () => {
    const { result } = await load();
    const info = result.registry.getNode('Plant/Info')!;
    expect(info).toBeTruthy();
    expect((info as Mesh).isMesh).not.toBe(true);
    expect(info.userData.realvirtual?.RuntimeMetadata).toBeTruthy();
    // The node table of the asset references THIS object, not a dropped one, and
    // its subtree owns a non-empty segment interval (plan-756 step 1d — the
    // per-node index WINDOW was replaced by that interval).
    const table = result.bakedAsset!.nodeTable;
    const ordinal = table.ordinalOf.get(info);
    expect(ordinal, 'RuntimeMetadata has a pre-order ordinal').toBeGreaterThanOrEqual(0);
    const rows = table.rowStart[ordinal! + 1] - table.rowStart[ordinal!];
    expect(rows, 'RuntimeMetadata owns segments in at least one chunk').toBeGreaterThan(0);
    const row = table.rowStart[ordinal!];
    const chunk = table.chunks[table.rowChunk[row]];
    const range = segmentRange(chunk.pick, table.rowFirstSeg[row], table.rowLastSeg[row]);
    expect(range!.indexCount).toBeGreaterThan(0);
  });

  it('chunk meshes are real children of their boundary and are not document nodes', async () => {
    const { result } = await load();
    const chunkMeshes: Mesh[] = [];
    result.root.traverse((n) => { if (n.userData[RV_BAKE_CHUNK_KEY]) chunkMeshes.push(n as Mesh); });
    expect(chunkMeshes.length).toBe(result.bakedAsset!.chunks.length);
    for (const m of chunkMeshes) {
      expect(m.parent).toBeTruthy();
      expect(m.isMesh).toBe(true);
      // never registered — a chunk is a render artefact, not an address
      expect(result.registry.getPathForNode(m)).toBeFalsy();
    }
    // The Drive is a boundary: it owns a chunk of its own.
    const axis = result.registry.getNode('Plant/Axis')!;
    expect(chunkMeshes.some((m) => m.parent === axis)).toBe(true);
  });

  it('a keep mesh is MOVED into the template, geometry and material intact', async () => {
    const { result } = await load();
    const beacon = result.registry.getNode('Plant/Beacon') as Mesh;
    expect(beacon?.isMesh).toBe(true);
    expect(beacon.geometry?.getAttribute('position')?.count).toBeGreaterThan(0);
    expect(beacon.material).toBeTruthy();
    expect(result.bakedAsset!.keep.some((k) => k.mesh === beacon)).toBe(true);
  });

  it('release takes the chunk meshes out and leaves the document graph alone; idempotent', async () => {
    const scene = new Scene();
    const bakeRegistry = new BakeRegistry();
    _resetBakeRemovalReportForTesting();
    const result = await loadGLB('plant.glb', scene, {
      data: bytes.slice(0),
      loadKinematicsSidecar: false,
      bakeRegistry,
      bakePickPort: createPickBuildPort({ createWorker: () => null }),
    });
    const instance = result.bakeInstance!;
    expect(instance.chunks.length).toBeGreaterThan(0);
    for (const m of instance.chunks) expect(m.userData[RV_BAKE_CHUNK_KEY]).toBe(true);

    bakeRegistry.release(instance);
    for (const m of instance.chunks) expect(m.parent).toBeNull();
    // Survivors and keep meshes belong to the scene graph, not to the instance.
    expect(findByName(result.root, 'Axis')).toBeTruthy();
    expect(findByName(result.root, 'Beacon')).toBeTruthy();
    expect(() => bakeRegistry.release(instance)).not.toThrow();
  });

  it('instantiateTemplate refuses a second placement of the same template', async () => {
    const { result } = await load();
    const other = new BakeRegistry();
    expect(() => other.instantiateTemplate(result.bakedAsset!)).not.toThrow();
    expect(() => other.instantiateTemplate(result.bakedAsset!)).toThrow(/already placed/);
  });
});

// ─── plan-755 §9.6 — Group = partition of the chunk, through the real loader ──

/**
 *   Line
 *   ├─ GA {Group: MC01.13}          group-only          → removed; object `MC01.13` under Line
 *   │   ├─ PartA1, PartA2           plain meshes
 *   ├─ Loose                        plain mesh          → ungrouped static chunk
 *   ├─ Axis {Drive}                                     → boundary
 *   │   ├─ Arm                      plain mesh
 *   │   └─ Cover {Group: Covers}    group-only          → object `Covers` under Axis
 *   │       └─ Lid                  plain mesh
 *   ├─ Kin {Kinematic: integrate group `Mov`}           → boundary, members move under it
 *   ├─ M1 {Group: Mov}              mesh                → partition `Mov` of Kin
 *   └─ M2 {Group: Mov, Group_1: Vis} mesh               → partition `Mov|Vis` of Kin (R12)
 */
function buildGroupedLine(): Group {
  const line = new Group(); line.name = 'Line';
  const ga = new Group(); ga.name = 'GA';
  ga.userData.realvirtual = { Group: { GroupName: 'MC01.13' } };
  ga.add(box('PartA1', [0, 0, 0]), box('PartA2', [0, 2, 0]));
  line.add(ga);
  line.add(box('Loose', [2, 0, 0]));
  const axis = new Group(); axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearY', TargetSpeed: 250 } };
  axis.add(box('Arm', [4, 0, 0]));
  const cover = new Group(); cover.name = 'Cover';
  cover.userData.realvirtual = { Group: { GroupName: 'Covers' } };
  cover.add(box('Lid', [4, 2, 0]));
  axis.add(cover);
  line.add(axis);
  const kin = new Group(); kin.name = 'Kin';
  kin.userData.realvirtual = { Kinematic: { IntegrateGroupEnable: true, GroupName: 'Mov' } };
  line.add(kin);
  line.add(box('M1', [6, 0, 0], { Group: { GroupName: 'Mov' } }));
  line.add(box('M2', [8, 0, 0], { Group: { GroupName: 'Mov' }, Group_1: { GroupName: 'Vis' } }));
  return line;
}

/** Meshes the renderer would actually walk into (effective `.visible` chain). */
function drawnMeshes(root: Object3D): Mesh[] {
  const out: Mesh[] = [];
  const walk = (n: Object3D, visible: boolean): void => {
    const effective = visible && n.visible;
    if (effective && (n as Mesh).isMesh) out.push(n as Mesh);
    for (const c of n.children) walk(c, effective);
  };
  walk(root, true);
  return out;
}

const byName = (a: Object3D, b: Object3D): number => a.name.localeCompare(b.name);

describe('loader bake: Group partitions the chunk (plan-755 §9.6)', () => {
  let groupedBytes: ArrayBuffer;
  beforeAll(async () => { groupedBytes = await objectToGlb(buildGroupedLine()); });

  async function loadLine(opts: { preserveHierarchy?: boolean } = {}): Promise<{ result: LoadResult; bakeRegistry: BakeRegistry }> {
    _resetBakeRemovalReportForTesting();
    const bakeRegistry = new BakeRegistry();
    const result = await loadGLB('line.glb', new Scene(), {
      data: groupedBytes.slice(0),
      loadKinematicsSidecar: false,
      preserveHierarchy: opts.preserveHierarchy,
      bakeRegistry,
      bakePickPort: createPickBuildPort({ createWorker: () => null }),
    });
    return { result, bakeRegistry };
  }

  it('the partition object is a REGISTERED node with Group extras, found by the unchanged traversal and buildGroups (F3)', async () => {
    const { result } = await loadLine();
    const object = result.registry.getNode('MC01.13')!;
    expect(object, 'the partition object resolves by name').toBeTruthy();
    // STATIC geometry belongs to the model root — that is the boundary, so the
    // object hangs there and not under the nearest surviving ancestor (`Line`).
    expect(object.parent).toBe(result.root);
    expect(object.userData._rvSynthetic).toBe(true);
    expect(object.userData.realvirtual).toEqual({ Group: { GroupName: 'MC01.13' } });
    expect(result.registry.getPathForNode(object)).toBe(`${result.root.name}/MC01.13`);
    // The pure group node is gone — and so is its path (plan-755 F5 / I4).
    expect(findByName(result.root, 'GA')).toBeNull();
    // Member of the group is the partition object, nothing else.
    expect(result.groups!.get('MC01.13')!.nodes).toEqual([object]);
    // Under the drive: the object hangs under the BOUNDARY.
    const covers = result.registry.getNode('Line/Axis/Covers')!;
    expect(covers.parent).toBe(result.registry.getNode('Line/Axis'));
    // Chunk meshes below a partition object are still not document nodes.
    expect(object.children.length).toBeGreaterThan(0);
    for (const c of object.children) {
      expect(c.userData[RV_BAKE_CHUNK_KEY]).toBe(true);
      expect(result.registry.getPathForNode(c)).toBeNull();
    }
  });

  it('setVisible(false) removes exactly the chunks of that group from the drawn set (F4); identity placement unchanged', async () => {
    const { result, bakeRegistry } = await loadLine();
    const object = result.registry.getNode('MC01.13')!;
    const own = object.children.filter((c) => c.userData[RV_BAKE_CHUNK_KEY]) as Mesh[];
    expect(own.length).toBeGreaterThan(0);
    const before = drawnMeshes(result.root);
    result.groups!.setVisible('MC01.13', false);
    const after = drawnMeshes(result.root);
    expect(after.length).toBe(before.length - own.length);
    for (const m of own) expect(after).not.toContain(m);
    result.groups!.setVisible('MC01.13', true);

    // `instantiateTemplate` needed no change: the instance owns the partitioned
    // chunk meshes, and the highlight seam answers for the partition object.
    const instance = result.bakeInstance!;
    expect(instance.identity).toBe(true);
    for (const m of own) expect(instance.chunks).toContain(m);
    expect(bakeRegistry.chunkTargetsOf(object)!.map((t) => t.mesh).sort(byName)).toEqual([...own].sort(byName));
    // A hit on a partitioned chunk: plain CAD under the root has no pick owner
    // (`segOwner === -1`). DELIBERATE CHANGE, plan-756 Q5 — it used to resolve to
    // `null` (ray-transparent); an OPAQUE chunk now BLOCKS instead, so nothing
    // behind the housing lights up. `resolveHit`'s second argument is the owner
    // ordinal now, not a `faceIndex`.
    expect(bakeRegistry.resolveHit(own[0], -1)).toBe(RAYCAST_BLOCKED);
  });

  it('R12: a Kinematic integration group and a plain visibility group in one subtree', async () => {
    const { result } = await loadLine();
    const kin = result.registry.getNode('Line/Kin')!;
    const mov = result.registry.getNode('Line/Kin/Mov')!;
    const movVis = result.registry.getNode('Line/Kin/Mov|Vis')!;
    expect(mov.parent).toBe(kin);
    expect(movVis.parent).toBe(kin);
    expect(result.kinematicGroupNames).toContain('Mov');
    expect([...result.groups!.get('Mov')!.nodes].sort(byName)).toEqual([mov, movVis]);
    expect(result.groups!.get('Vis')!.nodes).toEqual([movVis]);
    // Hiding the plain visibility group takes the triangles of M2 only.
    const before = drawnMeshes(result.root).length;
    result.groups!.setVisible('Vis', false);
    expect(drawnMeshes(result.root).length).toBe(before - movVis.children.length);
    expect(drawnMeshes(result.root).some((m) => m.parent === mov)).toBe(true);
  });

  it('R8: an editor load (preserveHierarchy) stamps nothing and creates no partition object', async () => {
    const { result } = await loadLine({ preserveHierarchy: true });
    expect(result.bakedAsset ?? null).toBeNull();
    let synthetic = 0;
    let stamped = 0;
    result.root.traverse((n) => {
      if (n.userData?._rvSynthetic) synthetic++;
      if (n.userData?._rvPartition) stamped++;
    });
    expect(synthetic).toBe(0);
    expect(stamped).toBe(0);
    const ga = result.registry.getNode('Line/GA')!;
    expect(ga.userData.realvirtual.Group).toEqual({ GroupName: 'MC01.13' });
    expect(result.groups!.get('MC01.13')!.nodes).toEqual([ga]);
  });
});
