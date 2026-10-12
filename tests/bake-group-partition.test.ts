// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-755 §9.1 — `Group` as the PARTITION KEY of a chunk (Unity
 * `MeshCombiner.CombineByGroups` parity).
 *
 *   prepare: the `Group` hook stamps resolved names as `userData._rvPartition`
 *   bake:    chunk = boundary × partition × material, labels reset at a boundary
 *   template: ONE synthetic partition object per (boundary, partition), carrying
 *            `Group` extras, parent of that partition's chunk meshes
 *   init:    the unchanged load traversal + `buildGroups` register it
 *
 * Every tree here is prepared the way the loader does it (`runPreBakeHooks` on
 * a root under a parentless staging holder) and then baked DESTRUCTIVELY.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3 } from 'three';
import '../src/core/engine/rv-scene-loader';   // side effect: capabilities, schemas, built-in hooks
import { buildGroups } from '../src/core/engine/rv-scene-loader';
import { runPreBakeHooks } from '../src/core/engine/rv-pre-bake';
import { registerBuiltInPreBakeHooks } from '../src/core/engine/rv-pre-bake-hooks';
import { RV_DRIVE_HOME_KEY, RV_SENSOR_BEAM_KEY } from '../src/core/engine/rv-pre-bake-keys';
import { RV_PARTITION_KEY, RV_SYNTHETIC_KEY, type BakedAsset } from '../src/core/engine/rv-bake-chunk';
import { BakeRegistry, RV_BAKE_CHUNK_KEY } from '../src/core/engine/rv-bake-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { GroupRegistry, ISOLATE_FOCUS_LAYER, tagIsolateSubtree } from '../src/core/engine/rv-group-registry';
import { buildPreBakeRegistry } from '../src/core/engine/rv-pre-bake';
import { computeSurvival } from '../src/core/engine/rv-bake-survival';
import { bakeAndPlace, bakeTree, chunkKeys } from './fixtures/bake-fixture';

const matA = new MeshStandardMaterial({ color: 0x884422, name: 'A' });
const matB = new MeshStandardMaterial({ color: 0x224488, name: 'B' });
const matC = new MeshStandardMaterial({ color: 0x228844, name: 'C' });

function mesh(name: string, pos: [number, number, number] = [0, 0, 0], extras?: Record<string, unknown>, material = matA): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material);
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function node(name: string, extras?: Record<string, unknown>, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  if (extras) g.userData.realvirtual = extras;
  for (const c of children) g.add(c);
  return g;
}

const grp = (name: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({ GroupName: name, ...more });

/** The loader's staging shape: `computeNodePath` starts at the root's own name. */
function staged<T extends Object3D>(root: T): T {
  const holder = new Object3D();
  holder.name = '_rvLoadStaging';
  holder.add(root);
  return root;
}

/** prepare → destructive bake → place, exactly the loader's order. */
async function prepareAndBake(root: Object3D, withSurvival = false) {
  staged(root);
  runPreBakeHooks(root);
  const bakeRegistry = new BakeRegistry();
  const survival = withSurvival ? computeSurvival(root, buildPreBakeRegistry(root)) : null;
  const placed = await bakeAndPlace(root, bakeRegistry, {
    survives: survival?.survives,
    incomingRoles: survival?.incoming,
  });
  return { ...placed, bakeRegistry };
}

const isSynthetic = (n: Object3D): boolean => n.userData?.[RV_SYNTHETIC_KEY] === true;
const isChunk = (n: Object3D): boolean => n.userData?.[RV_BAKE_CHUNK_KEY] === true;

function syntheticNodes(root: Object3D): Object3D[] {
  const out: Object3D[] = [];
  root.traverse((n) => { if (isSynthetic(n)) out.push(n); });
  return out;
}

function chunkMeshesOf(parent: Object3D): Mesh[] {
  return parent.children.filter(isChunk) as Mesh[];
}

/** The load traversal's group collection + the UNCHANGED `buildGroups` (F3). */
function groupsOf(template: Object3D): GroupRegistry {
  const holder = new Object3D();
  holder.add(template);
  const registry = new NodeRegistry();
  const groupNodes: { node: Object3D; key: string; data: Record<string, unknown> }[] = [];
  template.traverse((n) => {
    if (isChunk(n)) return;
    registry.registerNode(NodeRegistry.computeNodePath(n), n);
    const rv = n.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (key === 'Group' || /^Group_\d+$/.test(key)) groupNodes.push({ node: n, key, data: rv[key] as Record<string, unknown> });
    }
  });
  return buildGroups(groupNodes, registry) ?? new GroupRegistry();
}

/** Meshes the renderer would walk into, the three.js way. */
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

const partitionsOf = (asset: BakedAsset): string[] => asset.chunks.map((c) => c.partition).sort();

beforeEach(() => { registerBuiltInPreBakeHooks(); });

describe('Group hook → partition stamp (plan-755 §2.4)', () => {
  it('stamps resolved, deduplicated names; disabled and empty blocks stamp nothing (D10)', () => {
    const root = staged(node('Plant', undefined,
      node('Pre'),
      node('N', {
        Group: grp('A'),
        Group_1: grp('A'),
        Group_2: grp('Off', { _enabled: false }),
        Group_3: grp(''),
        Group_4: grp('Door', { GroupNamePrefix: 'Plant/Pre' }),
      }),
      node('Plain'),
    ));
    runPreBakeHooks(root);
    expect(root.getObjectByName('N')!.userData[RV_PARTITION_KEY]).toEqual(['A', 'PreDoor']);
    expect(root.getObjectByName('Plain')!.userData[RV_PARTITION_KEY]).toBeUndefined();
    // Plain data — `userData` is JSON-cloned by `Object3D.clone()`.
    expect(JSON.parse(JSON.stringify(root.getObjectByName('N')!.userData))[RV_PARTITION_KEY]).toEqual(['A', 'PreDoor']);
  });

  it('a node carrying ONLY `Group_1` is stamped, and the hook runs once per node (B2)', () => {
    const root = staged(node('Plant', undefined,
      node('OnlySuffix', { Group_1: grp('Solo') }),
      node('Both', { Group: grp('X'), Group_1: grp('Y'), Group_2: grp('Z') }),
    ));
    const result = runPreBakeHooks(root);
    expect(root.getObjectByName('OnlySuffix')!.userData[RV_PARTITION_KEY]).toEqual(['Solo']);
    expect(root.getObjectByName('Both')!.userData[RV_PARTITION_KEY]).toEqual(['X', 'Y', 'Z']);
    // Two nodes, one base type → exactly two invocations, not one per block.
    expect(result.hooks).toBe(2);
    expect(result.types).toEqual(['Group']);
  });

  it('suffix dispatch leaves the other built-in hooks correct: a lone `Sensor_1` / `Drive_1` does no harm', () => {
    const root = staged(node('Plant', undefined,
      node('S', { Sensor_1: { AutoRay: true } }, mesh('Body')),
      node('D', { Drive: { Direction: 'LinearX' }, Drive_1: { Direction: 'LinearY' } }),
    ));
    const result = runPreBakeHooks(root);
    // Sensor hook reads `extras.Sensor` → absent → no beam; Drive ran ONCE for D.
    expect(root.getObjectByName('S')!.userData[RV_SENSOR_BEAM_KEY]).toBeUndefined();
    expect(root.getObjectByName('D')!.userData[RV_DRIVE_HOME_KEY]).toBeTruthy();
    expect(result.hooks).toBe(2);
  });
});

describe('chunk = boundary × partition × material (plan-755 §9.1)', () => {
  it('two groups under the static root → two partition objects; ungrouped chunks stay at the root', async () => {
    const root = node('Plant', undefined,
      node('GA', { Group: grp('MC01.13') }, mesh('PartA', [0, 0, 0])),
      node('GB', { Group: grp('B') }, mesh('PartB', [2, 0, 0])),
      mesh('Loose', [4, 0, 0]),
    );
    const { baked, template } = await prepareAndBake(root);

    expect(partitionsOf(baked)).toEqual(['', 'B', 'MC01.13']);
    const objects = syntheticNodes(template);
    expect(objects.map((o) => o.name).sort()).toEqual(['B', 'MC01.13']);
    for (const o of objects) {
      expect(o.parent).toBe(template);
      expect(o.matrixAutoUpdate).toBe(false);
      expect(o.matrix.elements).toEqual(new Object3D().matrix.elements);
      expect(chunkMeshesOf(o).length).toBe(1);
    }
    // The ungrouped chunk hangs directly under the root — no `Static` object (D4).
    expect(chunkMeshesOf(template).length).toBe(1);
    const dotted = objects.find((o) => o.name === 'MC01.13')!;
    expect(dotted.userData.realvirtual).toEqual({ Group: { GroupName: 'MC01.13' } });
    // `chunk.owner` stays the BOUNDARY; `groupObject` is the new parent.
    const chunk = baked.chunks.find((c) => c.partition === 'MC01.13')!;
    expect(chunk.owner).toBe(template);
    expect(chunk.groupObject).toBe(dotted);
    expect(chunk.templateMesh!.parent).toBe(dotted);
    expect(chunk.key).toBe(`grp:MC01.13|tex:${matA.uuid}`);
    // The pure group nodes are gone (plan-755 F5) — nothing claims them.
    expect(template.getObjectByName('GA')).toBeUndefined();
  });

  it('a mesh inside two nested groups → ONE object `A|B` (sorted), member of both groups (D1)', async () => {
    const root = node('Plant', undefined,
      node('Outer', { Group: grp('B') }, node('Inner', { Group: grp('A') }, mesh('Part'))),
    );
    const { baked, template } = await prepareAndBake(root);
    expect(partitionsOf(baked)).toEqual(['A|B']);
    const [object] = syntheticNodes(template);
    expect(object.name).toBe('A|B');
    expect(object.userData.realvirtual).toEqual({ Group: { GroupName: 'A' }, Group_1: { GroupName: 'B' } });
    const groups = groupsOf(template);
    expect(groups.getGroupNames().sort()).toEqual(['A', 'B']);
    expect(groups.get('A')!.nodes).toContain(object);
    expect(groups.get('B')!.nodes).toContain(object);
  });

  it('group on a child below a Drive → object under the drive; hiding it spares a nested drive (D4)', async () => {
    const root = node('Plant', undefined,
      node('Axis', { Drive: { Direction: 'LinearX' } },
        mesh('Arm', [0, 0, 0]),
        node('Cover', { Group: grp('Covers') },
          mesh('Lid', [2, 0, 0]),
          node('Inner', { Drive: { Direction: 'LinearY' } }, mesh('Slide', [4, 0, 0])),
        ),
      ),
    );
    const { baked, template, node: find } = await prepareAndBake(root);
    const axis = find('Axis');
    const [object] = syntheticNodes(template);
    expect(object.parent).toBe(axis);
    expect(baked.chunks.find((c) => c.partition === 'Covers')!.key).toBe(`mover:Axis|grp:Covers|tex:${matA.uuid}`);
    // The nested drive opened its own context: the label does not reach in (D3).
    expect(baked.chunks.find((c) => c.ownerPath === 'Axis/Cover/Inner')!.partition).toBe('');

    const before = drawnMeshes(template).length;
    object.visible = false;
    const after = drawnMeshes(template);
    expect(after.length).toBe(before - 1);
    expect(after.some((m) => m.parent === find('Inner'))).toBe(true);
  });

  it('group ON the drive itself → no partition object; the drive is the member and hides its subtree (D12/D5)', async () => {
    const root = node('Plant', undefined,
      node('Axis', { Drive: { Direction: 'LinearX' }, Group: grp('Axes') }, mesh('Arm'), node('Sub', undefined, mesh('Deep', [2, 0, 0]))),
      mesh('Loose', [6, 0, 0]),
    );
    const { baked, template, node: find } = await prepareAndBake(root);
    expect(syntheticNodes(template)).toEqual([]);
    expect(baked.chunks.every((c) => !c.key.includes('grp:'))).toBe(true);
    const groups = groupsOf(template);
    expect(groups.get('Axes')!.nodes).toEqual([find('Axis')]);
    const before = drawnMeshes(template).length;
    groups.setVisible('Axes', false);
    expect(drawnMeshes(template).length).toBe(before - 1);
  });

  it('a boundary with its OWN mesh and its OWN group: own triangles in the plain mover chunk, hide still takes everything (D12)', async () => {
    const axis = mesh('Axis', [0, 0, 0], { Drive: { Direction: 'LinearX' }, Group: grp('Axes') });
    axis.add(node('Trim', { Group: grp('Trim') }, mesh('TrimPart', [2, 0, 0])));
    const root = node('Plant', undefined, axis, mesh('Loose', [6, 0, 0]));
    const { baked, template, node: find } = await prepareAndBake(root);
    expect(chunkKeys(baked)).toEqual([
      `mover:Axis|grp:Trim|tex:${matA.uuid}`,
      `mover:Axis|tex:${matA.uuid}`,
      `tex:${matA.uuid}`,
    ].sort());
    const groups = groupsOf(template);
    expect(groups.get('Axes')!.nodes).toEqual([find('Axis')]);
    groups.setVisible('Axes', false);
    expect(drawnMeshes(template).map((m) => m.name)).toEqual([`tex:${matA.uuid}`]);
  });

  it('a group ABOVE a drive does not reach into it; the group node survives as an ancestor and stays a member (D3)', async () => {
    const root = node('Plant', undefined,
      node('Cell', { Group: grp('Cell') },
        mesh('Frame', [0, 0, 0]),
        node('Axis', { Drive: { Direction: 'LinearX' } }, mesh('Arm', [2, 0, 0])),
      ),
    );
    const { baked, template, node: find } = await prepareAndBake(root);
    expect(baked.chunks.find((c) => c.ownerPath === 'Cell/Axis')!.partition).toBe('');
    expect(baked.chunks.find((c) => c.ownerPath === null)!.partition).toBe('Cell');
    // `Cell` (group-only) survives because the drive below it does.
    const cell = find('Cell');
    // The partition object hangs under the ROOT (the boundary), beside `Cell` —
    // and has to take the `_1` suffix because `Cell` already owns the name.
    const [object] = syntheticNodes(template);
    expect(object.parent).toBe(template);
    expect(object.name).toBe('Cell_1');
    expect(object.userData._rvOrigName).toBe('Cell');
    const groups = groupsOf(template);
    expect(groups.get('Cell')!.nodes.sort((a, b) => a.name.localeCompare(b.name))).toEqual([cell, object]);
    // Hiding the group hides the static part (object) AND the drive (subtree of Cell).
    groups.setVisible('Cell', false);
    expect(drawnMeshes(template)).toEqual([]);
  });

  it('`GroupNamePrefix` → the RESOLVED name in key, object name and extras, no prefix reference (D6)', async () => {
    const root = node('Plant', undefined,
      node('Robot'),
      node('G', { Group: grp('Door', { GroupNamePrefix: 'Plant/Robot' }) }, mesh('Part')),
      node('Off', { Group: grp('Off', { _enabled: false }) }, mesh('PartOff', [2, 0, 0])),
    );
    const { baked, template } = await prepareAndBake(root);
    expect(partitionsOf(baked)).toEqual(['', 'RobotDoor']);
    const [object] = syntheticNodes(template);
    expect(object.name).toBe('RobotDoor');
    expect(object.userData.realvirtual).toEqual({ Group: { GroupName: 'RobotDoor' } });
  });

  it('name collision with a template sibling → glTF `_N` suffix, readable spelling kept', async () => {
    const root = node('Plant', undefined,
      node('Lid', { Drive: { Direction: 'LinearX' } }, mesh('LidMesh')),
      node('Lid_1', { Drive: { Direction: 'LinearX' } }, mesh('LidMesh1', [2, 0, 0])),
      node('G', { Group: grp('Lid') }, mesh('Part', [4, 0, 0])),
    );
    const { template } = await prepareAndBake(root);
    const [object] = syntheticNodes(template);
    expect(object.name).toBe('Lid_2');
    expect(object.userData._rvOrigName).toBe('Lid');
    expect(new Set(template.children.map((c) => c.name)).size).toBe(template.children.length);
  });

  it('a moving drive carries the chunk under its partition object (R1)', async () => {
    const root = node('Plant', undefined,
      node('Axis', { Drive: { Direction: 'LinearX' } }, node('G', { Group: grp('Cover') }, mesh('Lid', [1, 0, 0]))),
    );
    const { template, node: find } = await prepareAndBake(root);
    const [object] = syntheticNodes(template);
    const chunk = chunkMeshesOf(object)[0];
    const before = chunk.getWorldPosition(new Vector3());
    find('Axis').position.x += 5;
    template.updateMatrixWorld(true);
    const after = chunk.getWorldPosition(new Vector3());
    expect(after.x - before.x).toBeCloseTo(5, 6);
    // The baked geometry is in the AXIS frame — the lid still sits at x = 1 there.
    chunk.geometry.computeBoundingBox();
    expect(chunk.geometry.boundingBox!.getCenter(new Vector3()).x).toBeCloseTo(1, 6);
  });

  it('synthetic N groups × M materials → exactly N × M chunks (draw-call bound)', async () => {
    const N = 4;
    const mats = [matA, matB, matC];
    const root = node('Plant');
    for (let g = 0; g < N; g++) {
      const holder = node('G' + g, { Group: grp('Grp' + g) });
      // Several meshes per (group, material) — they must MERGE, not multiply.
      for (let m = 0; m < mats.length; m++) for (let k = 0; k < 3; k++) holder.add(mesh(`P${g}_${m}_${k}`, [g, m, k], undefined, mats[m]));
      root.add(holder);
    }
    const { baked, template } = await prepareAndBake(root);
    expect(baked.chunks.length).toBe(N * mats.length);
    expect(syntheticNodes(template).length).toBe(N);
    for (const o of syntheticNodes(template)) expect(chunkMeshesOf(o).length).toBe(mats.length);
  });
});

describe('keep meshes and roles (plan-755 Phase-1 hand-over)', () => {
  it('a Group node under a Lamp does not pull its mesh out of `keep`, and a keep mesh is never partitioned', async () => {
    const root = node('Plant', undefined,
      node('Beacon', { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } },
        node('Shade', { Group: grp('Lamps') }, mesh('Glass')),
      ),
      mesh('Loose', [4, 0, 0]),
    );
    const { baked, template } = await prepareAndBake(root);
    expect(baked.keep.map((k) => k.mesh.name)).toEqual(['Glass']);
    expect(partitionsOf(baked)).toEqual(['']);
    expect(syntheticNodes(template)).toEqual([]);
  });
});

describe('selection, highlight and visibility of a partition object', () => {
  async function twoGroupCell() {
    const root = node('Plant', undefined,
      node('GA', { Group: grp('A') }, mesh('PartA1', [0, 0, 0], undefined, matA), mesh('PartA2', [0, 2, 0], undefined, matB)),
      node('GB', { Group: grp('B') }, mesh('PartB', [2, 0, 0])),
      mesh('Loose', [4, 0, 0]),
    );
    return prepareAndBake(root);
  }

  it('`chunkTargetsOf(partitionObject)` → exactly its whole chunks (B3), on the identity placement', async () => {
    const { template, bakeRegistry } = await twoGroupCell();
    const a = syntheticNodes(template).find((o) => o.name === 'A')!;
    const targets = bakeRegistry.chunkTargetsOf(a)!;
    expect(targets.map((t) => t.mesh).sort((x, y) => x.name.localeCompare(y.name)))
      .toEqual(chunkMeshesOf(a).sort((x, y) => x.name.localeCompare(y.name)));
    expect(targets.every((t) => t.range === null)).toBe(true);
    expect(targets.length).toBe(2);
  });

  it('`tagIsolateSubtree(partitionObject)` puts its chunk meshes on the isolate focus layer', async () => {
    const { template } = await twoGroupCell();
    const a = syntheticNodes(template).find((o) => o.name === 'A')!;
    tagIsolateSubtree(a);
    for (const m of chunkMeshesOf(a)) expect(m.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(true);
    const b = syntheticNodes(template).find((o) => o.name === 'B')!;
    for (const m of chunkMeshesOf(b)) expect(m.layers.isEnabled(ISOLATE_FOCUS_LAYER)).toBe(false);
  });

  it('hiding a group through the registry removes exactly its chunks from the drawn set (F4)', async () => {
    const { template } = await twoGroupCell();
    const groups = groupsOf(template);
    const before = drawnMeshes(template).length;
    groups.setVisible('A', false);
    expect(drawnMeshes(template).length).toBe(before - 2);
    groups.setVisible('A', true);
    expect(drawnMeshes(template).length).toBe(before);
  });

  it('a partition object joining a default-hidden group is invisible after `register()`', async () => {
    const { template } = await twoGroupCell();
    const a = syntheticNodes(template).find((o) => o.name === 'A')!;
    const groups = new GroupRegistry();
    groups.setDefaultHiddenGroups(['A']);
    groups.register('A', new Object3D());
    groups.showAll();                      // re-applies the default-hidden set
    expect(a.visible).toBe(true);
    groups.register('A', a);
    expect(a.visible).toBe(false);
  });

  it('F6: a RuntimeMetadata part whose meshes fall into two partitions keeps its node and gets TWO windows', async () => {
    const root = node('Plant', undefined,
      node('Info', { RuntimeMetadata: { Content: 'hello' } },
        node('GA', { Group: grp('A') }, mesh('InA')),
        node('GB', { Group: grp('B') }, mesh('InB', [2, 0, 0])),
      ),
    );
    const { template, bakeRegistry, node: find } = await prepareAndBake(root);
    const info = find('Info');
    const targets = bakeRegistry.chunkTargetsOf(info)!;
    expect(targets.length).toBe(2);
    expect(targets.every((t) => t.range !== null && t.range.indexCount === 36)).toBe(true);
    const parents = targets.map((t) => t.mesh.parent!.name).sort();
    expect(parents).toEqual(['A', 'B']);
    // Windows are in the partitioned chunks; the objects hang under the ROOT
    // (the boundary), not under the metadata node.
    for (const o of syntheticNodes(template)) expect(o.parent).toBe(template);
  });

  it('R5: a node with a Mesh AND Group blocks (Unity pre-combined) → object of the same name, old node gone, same groups', async () => {
    const build = (): Group => node('Plant', undefined,
      mesh('CNCCase|CNCDoor', [0, 0, 0], { Group: grp('CNCCase'), Group_1: grp('CNCDoor') }),
      mesh('Loose', [4, 0, 0]),
    );
    // Before: what `buildGroups` sees on the UNBAKED tree.
    const before = groupsOf(build()).getGroupNames().sort();
    const { template } = await prepareAndBake(build());
    const after = groupsOf(template);
    expect(after.getGroupNames().sort()).toEqual(before);
    const [object] = syntheticNodes(template);
    expect(object.name).toBe('CNCCase|CNCDoor');
    expect((object as Mesh).isMesh).toBeFalsy();
    expect(after.get('CNCDoor')!.nodes).toEqual([object]);
    // Exactly one node of that name: the mesh node was group-only and is gone.
    let count = 0;
    template.traverse((n) => { if (n.name === 'CNCCase|CNCDoor') count++; });
    expect(count).toBe(1);
  });
});

describe('placements (plan-755 F8/B1)', () => {
  it('two `instantiate()` placements get their OWN partition objects over SHARED geometry', async () => {
    const root = node('Asset', undefined,
      node('GA', { Group: grp('A') }, mesh('PartA')),
      node('Axis', { Drive: { Direction: 'LinearX' } }, node('GB', { Group: grp('B') }, mesh('Lid', [2, 0, 0]))),
      mesh('Loose', [4, 0, 0]),
    );
    staged(root);
    runPreBakeHooks(root);
    const baked = await bakeTree(root, { destructive: true });
    const registry = new BakeRegistry();
    const r1 = new Group(); const r2 = new Group();
    const p1 = registry.instantiate(baked, r1);
    const p2 = registry.instantiate(baked, r2);

    const find = (r: Object3D, name: string): Object3D => r.getObjectByName(name)!;
    const a1 = find(r1, 'A'); const a2 = find(r2, 'A');
    expect(a1).toBeTruthy();
    expect(a1).not.toBe(a2);
    expect(isSynthetic(a1)).toBe(true);
    expect(a1.userData.realvirtual).toEqual({ Group: { GroupName: 'A' } });
    expect(a1.userData).not.toBe(a2.userData);
    // Same shape as the template: object under the boundary, chunk under the object.
    expect(a1.parent).toBe(r1);
    expect(find(r1, 'B').parent).toBe(find(r1, 'Axis'));
    const c1 = chunkMeshesOf(a1)[0]; const c2 = chunkMeshesOf(a2)[0];
    expect(c1).not.toBe(c2);
    expect(c1.geometry).toBe(c2.geometry);
    expect(p1.chunks.length).toBe(baked.chunks.length);

    a1.visible = false;
    expect(drawnMeshes(r1).length).toBe(baked.chunks.length - 1);
    expect(drawnMeshes(r2).length).toBe(baked.chunks.length);

    // Highlight seam on a CLONED placement resolves the clone, not the template.
    expect(registry.chunkTargetsOf(a2)!.map((t) => t.mesh)).toEqual([c2]);

    registry.release(p1);
    expect(r1.children.length).toBe(0);
    expect(p2.released).toBe(false);
  });
});

describe('survival: `_N` keys reach the reference table (plan-755 Phase-1 hand-over)', () => {
  it('`Group_1.GroupNamePrefix` tags its prefix node like `Group.GroupNamePrefix` does', () => {
    const root = staged(node('Plant', undefined,
      node('PrefixA'),
      node('PrefixB'),
      node('Bare'),
      mesh('Part', [0, 0, 0], {
        Group: grp('X', { GroupNamePrefix: 'Plant/PrefixA' }),
        Group_1: grp('Y', { GroupNamePrefix: 'Plant/PrefixB' }),
      }),
    ));
    const model = computeSurvival(root, buildPreBakeRegistry(root));
    expect(model.survives(root.getObjectByName('PrefixA')!)).toBe(true);
    expect(model.survives(root.getObjectByName('PrefixB')!)).toBe(true);
    expect(model.survives(root.getObjectByName('Bare')!)).toBe(false);
  });
});

describe('N2: the bake knows no component type', () => {
  it('rv-bake-pipeline.ts imports nothing group-specific and never spells the type as a string', async () => {
    const source = await (await fetch('/src/core/engine/rv-bake-pipeline.ts?raw&import')).text();
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const imp of imports) expect(imp.includes('rv-group'), imp).toBe(false);
    // Quoted spellings only: comments legitimately mention three's `Group` class.
    expect(/['"]Group(_\d+)?\\?['"]/.test(source)).toBe(false);
    expect(/GroupName/.test(source)).toBe(false);
  });
});
