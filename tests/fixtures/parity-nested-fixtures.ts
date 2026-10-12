// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 2 (spike S2) — the nested parity fixtures: an asset INSIDE an
 * asset, two levels. The inner asset is a Cell with an off-centre body and a
 * jogging drive; the outer asset is a Machine with its own frame mesh and ONE
 * reference node to the inner asset's bytes:
 *
 *  (n1) a PLANNER reference — `AssetReference` + `PlacementMeta` (what the
 *       layout planner writes when a machine is placed inside an asset);
 *  (n2) a HAND-AUTHORED reference — `AssetReference` only (a CAD sub-assembly
 *       referencing its part file; keeps its child transforms).
 *
 * The outer bytes embed the inner asset's `blob:` url, so the inner GLB is
 * written first and the outer builder takes its url. Positions are metres.
 */
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { setAssetReference, setPlacementMeta } from '../../src/core/engine/rv-asset-reference';
import { setNodeId } from '../../src/core/engine/rv-node-id';
import type { ParityPickRay } from './parity-fixtures';

export type NestedFixtureId = 'n1' | 'n2' | 'n3';

export interface NestedParityFixture {
  id: NestedFixtureId;
  title: string;
  /** Name of the OUTER asset root (== the scene name in the GLB). */
  rootName: string;
  /** Name of the reference node inside the outer asset. */
  referenceName: string;
  planner: boolean;
  buildInner(): Group;
  buildOuter(innerUrl: string): Group;
  pick: ParityPickRay;
  steps: number;
}

function mesh(name: string, size: [number, number, number], pos: [number, number, number], color: number): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

function group(name: string): Group {
  const g = new Group();
  g.name = name;
  return g;
}

/** Cell: Body (AABB x 1.5…2.5) + `Slide` drive at x = 2 jogging forward — floor-centre pivot offset (−2, 0, 0). */
export function buildNestedInner(): Group {
  const root = group('Cell');
  root.add(mesh('Body', [1, 0.5, 1], [2, 0.25, 0], 0x336699));
  const slide = new Object3D();
  slide.name = 'Slide';
  slide.position.set(2, 0.5, 0);
  slide.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 200, JogForward: true } };
  slide.add(mesh('Tool', [0.2, 0.2, 0.2], [0, 0.1, 0], 0x99cc33));
  root.add(slide);
  return root;
}

/**
 * `under`: the reference sits below a STATIC intermediate node (plan-757 Phase 2
 * review F15 — `Machine/Mount/Cell_1`): a bare node without a component that
 * survives the bake only because its descendant claims itself.
 */
function buildOuter(referenceName: string, planner: boolean, innerUrl: string, under?: string): Group {
  const root = group('Machine');
  root.add(mesh('Frame', [3, 0.2, 3], [0, 0.1, 0], 0x777777));
  let parent: Object3D = root;
  if (under) {
    const mount = new Object3D();
    mount.name = under;
    mount.position.set(0, 0.2, 0);
    root.add(mount);
    parent = mount;
  }
  const ref = new Object3D();
  ref.name = referenceName;
  ref.position.set(3, 0, 0);
  setNodeId(ref, planner ? 'nid-nested-cell' : 'nid-nested-cellref');
  setAssetReference(ref, { assetId: 'cat:parity-nested-cell', path: innerUrl });
  if (planner) setPlacementMeta(ref, {});
  parent.add(ref);
  return root;
}

const DOWN: [number, number, number] = [0, -1, 0];

export const NESTED_PARITY_FIXTURES: ReadonlyArray<NestedParityFixture> = Object.freeze([
  {
    id: 'n1',
    title: 'planner reference (PlacementMeta) inside an asset',
    rootName: 'Machine',
    referenceName: 'Cell_1',
    planner: true,
    buildInner: buildNestedInner,
    buildOuter: (innerUrl) => buildOuter('Cell_1', true, innerUrl),
    // Pivoted: the inner Slide sits at the reference node → outer x = 3.
    pick: { origin: [3, 5, 0], direction: DOWN, expect: 'Cell_1/Slide' },
    steps: 60,
  },
  {
    id: 'n2',
    title: 'hand-authored reference (no PlacementMeta) inside an asset',
    rootName: 'Machine',
    referenceName: 'CellRef',
    planner: false,
    buildInner: buildNestedInner,
    buildOuter: (innerUrl) => buildOuter('CellRef', false, innerUrl),
    // Not pivoted: the inner Slide keeps x = 2 under the reference at x = 3 → outer x = 5.
    pick: { origin: [5, 5, 0], direction: DOWN, expect: 'CellRef/Slide' },
    steps: 60,
  },
  {
    id: 'n3',
    title: 'planner reference under a STATIC intermediate ancestor (Machine/Mount/Cell_1)',
    rootName: 'Machine',
    referenceName: 'Cell_1',
    planner: true,
    buildInner: buildNestedInner,
    buildOuter: (innerUrl) => buildOuter('Cell_1', true, innerUrl, 'Mount'),
    // Pivoted under Mount (0, 0.2, 0): the inner Slide sits at the reference node → outer x = 3.
    pick: { origin: [3, 5, 0], direction: DOWN, expect: 'Mount/Cell_1/Slide' },
    steps: 60,
  },
]);

export function nestedParityFixture(id: NestedFixtureId): NestedParityFixture {
  const f = NESTED_PARITY_FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`nested parity fixture (${id}) does not exist`);
  return f;
}
