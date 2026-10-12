// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-517 §9.1b (F8) — a second group membership is the key `Group_1`, not
 * `Group1`. rv-odt.json and specification.md said `Group1` while the loader has
 * always read `Group_N`; the text was corrected, and this test pins the
 * BEHAVIOUR the corrected text describes, through a real `loadGLB`:
 *
 *  - a node with `Group` + `Group_1` is a member of BOTH groups;
 *  - a `Kinematic` integrates it through the `Group_1` membership;
 *  - a `Group1` key (no underscore) makes no membership at all.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, type Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { createPickBuildPort } from '../src/core/engine/rv-pick-build-port';
import { _resetBakeRemovalReportForTesting } from '../src/core/engine/rv-bake-survival';
import rvOdt from '../schema/v1/rv-odt.json';

const material = new MeshStandardMaterial({ color: 0x556677 });

function box(name: string, x: number, extras: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material.clone());
  m.name = name;
  m.position.set(x, 0, 0);
  m.userData.realvirtual = extras;
  return m;
}

/**
 *   Cell
 *   ├─ Axis {Kinematic: integrate `Moving`}
 *   ├─ Both   {Group: Frame, Group_1: Moving}  → member of Frame AND Moving, moves under Axis
 *   └─ Legacy {Group: Frame, Group1: Ghost}    → member of Frame only; `Ghost` never exists
 */
function buildCell(): Group {
  const cell = new Group();
  cell.name = 'Cell';
  const axis = new Group();
  axis.name = 'Axis';
  axis.userData.realvirtual = { Kinematic: { IntegrateGroupEnable: true, GroupName: 'Moving' } };
  cell.add(axis);
  cell.add(box('Both', 2, { Group: { GroupName: 'Frame' }, Group_1: { GroupName: 'Moving' } }));
  cell.add(box('Legacy', 4, { Group: { GroupName: 'Frame' }, Group1: { GroupName: 'Ghost' } }));
  return cell;
}

let bytes: ArrayBuffer;
beforeAll(async () => { bytes = await objectToGlb(buildCell()); });

async function load(preserveHierarchy: boolean): Promise<LoadResult> {
  _resetBakeRemovalReportForTesting();
  return loadGLB('cell.glb', new Scene(), {
    data: bytes.slice(0),
    loadKinematicsSidecar: false,
    preserveHierarchy,
    bakeRegistry: new BakeRegistry(),
    bakePickPort: createPickBuildPort({ createWorker: () => null }),
  });
}

function byName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

describe('Group_N multi-membership (plan-517 F8)', () => {
  it('authoring load: a node with Group + Group_1 is a member of both groups; Group1 makes none', async () => {
    const result = await load(true);
    const both = byName(result.root, 'Both')!;
    const legacy = byName(result.root, 'Legacy')!;
    expect(result.groups!.get('Frame')!.nodes).toEqual(expect.arrayContaining([both, legacy]));
    expect(result.groups!.get('Moving')!.nodes).toContain(both);
    expect(result.groups!.get('Moving')!.nodes).not.toContain(legacy);
    expect(result.groups!.get('Ghost') ?? null).toBeNull();
  });

  it('the Kinematic integrates the node through its Group_1 membership (baked load)', async () => {
    // The re-parenting is a pre-bake hook, so it runs on the runtime (baked)
    // path; there the group-only node dissolves into a PARTITION object of the
    // boundary it moved under — which must therefore be the axis.
    const result = await load(false);
    const axis = byName(result.root, 'Axis')!;
    expect(axis).toBeTruthy();
    const moving = result.groups!.get('Moving')!.nodes;
    expect(moving.length).toBeGreaterThan(0);
    for (const n of moving) expect(n.parent, n.name).toBe(axis);
    // `Legacy` is only in `Frame` (its `Group1` is no membership): nothing of
    // it moved under the axis.
    const frameOnly = result.groups!.get('Frame')!.nodes.filter((n) => !moving.includes(n));
    expect(frameOnly.length).toBeGreaterThan(0);
    for (const n of frameOnly) expect(n.parent).not.toBe(axis);
  });

  it('baked load: both group names of the Group_1 node exist as groups', async () => {
    const result = await load(false);
    const names = result.groups!.getGroupNames();
    expect(names).toEqual(expect.arrayContaining(['Frame', 'Moving']));
    expect(names).not.toContain('Ghost');
  });

  it('rv-odt.json documents the Group_N keys the loader reads', () => {
    const desc = (rvOdt as unknown as { $defs: Record<string, { description: string }> }).$defs.Group.description;
    expect(desc).toContain("'Group_1'");
    expect(desc).not.toContain("'Group1'");
  });
});
