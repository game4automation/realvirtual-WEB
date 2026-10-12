// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * placement-turntable-hierarchy.test.ts — plan-752 Nachkorrektur 2, B2.
 *
 * The live report after plan-752: a dropped Turntable shows `Transport-Z` as a
 * SIBLING of `Drive-Rot-Y` in the hierarchy panel, although the GLB has it as
 * that drive's CHILD (verified in `public/library/PalletHandling/Turntable.glb`:
 * node 11 `Transport-Z`, parent node 6 `Drive-Rot-Y`). The motion is correct,
 * which already says the SCENE GRAPH is intact — so the question these cases
 * answer is which of the two sources the panel reads from disagrees:
 *
 *   1. the three.js scene graph (`Object3D.parent`), and
 *   2. the NodeRegistry paths — `ExtrasEditor._scanEditableNodes` builds every
 *      hierarchy row from `registry.getPathForNode(node)`, and
 *      `buildStructureTree` reconstructs parentage by SPLITTING those path
 *      strings. A node registered under a path that skips its drive ancestor
 *      is drawn as a sibling of that drive no matter what the scene graph says.
 *
 * The fixture goes through the real registration path
 * (`prepPlacedVisual` → `registerPlaced` → `processExtras`) on the shared mock
 * viewer, which carries a real `NodeRegistry`, `SignalStore` and
 * `RVTransportManager`.
 */

import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Object3D } from 'three';

import { createMockViewer } from './_layout-planner-async-harness';
import { flattenSceneRows, type SceneTreeNode } from '../src/core/hmi/hierarchy-rows';
import {
  prepPlacedVisual,
  registerPlaced,
  type SceneMutationDeps,
} from '../src/plugins/layout-planner/scene-mutations';

/** Turntable.glb in miniature: Drive-Rot-Y with Transport-Z as its CHILD. */
function makeTurntable(): { root: Group; drive: Object3D; transport: Object3D; roll: Mesh } {
  const root = new Group();
  root.name = 'Turntable';
  root.userData.realvirtual = {
    LayoutObject: { Label: 'Turntable', CatalogId: 'cat:turntable', Locked: false },
    PlacementMeta: { catalogId: 'cat:turntable' },
  };

  const drive = new Object3D();
  drive.name = 'Drive-Rot-Y';
  drive.userData.realvirtual = { Drive: { Direction: 'RotationY', TargetSpeed: 30 } };
  root.add(drive);

  const transport = new Object3D();
  transport.name = 'Transport-Z';
  transport.userData.realvirtual = { TransportSurface: { TransportSpeed: 100 } };
  drive.add(transport);

  const roll = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  roll.name = 'Roll';
  transport.add(roll);

  return { root, drive, transport, roll };
}

function makeDeps(): { deps: SceneMutationDeps; viewer: ReturnType<typeof createMockViewer>; modelRoot: Object3D } {
  const viewer = createMockViewer();
  const layoutRoot = new Group();
  layoutRoot.name = '_layoutRoot';
  viewer.scene.add(layoutRoot);
  const modelRoot = viewer.currentModel;
  const deps: SceneMutationDeps = {
    getViewer: () => viewer as never,
    objectMap: new Map<string, Object3D>(),
    idByObject: new WeakMap<Object3D, string>(),
    getLayoutRoot: () => layoutRoot,
    getTransformControls: () => null,
    getModelRoot: () => modelRoot,
  };
  return { deps, viewer, modelRoot };
}

describe('a placed Turntable keeps Transport-Z under Drive-Rot-Y (B2)', () => {
  it('does not re-parent the transport in the scene graph', () => {
    const { deps } = makeDeps();
    const t = makeTurntable();

    prepPlacedVisual(deps, t.root, 'p1', 'Turntable', 'cat:turntable');
    registerPlaced(deps, t.root, 'p1', 'Turntable', 'cat:turntable');

    expect(t.transport.parent).toBe(t.drive);
    expect(t.roll.parent).toBe(t.transport);
    expect(t.drive.children).toContain(t.transport);
  });

  it('registers the transport under a path that contains the drive', () => {
    const { deps, viewer } = makeDeps();
    const t = makeTurntable();

    prepPlacedVisual(deps, t.root, 'p1', 'Turntable', 'cat:turntable');
    registerPlaced(deps, t.root, 'p1', 'Turntable', 'cat:turntable');

    const drivePath = viewer.registry.getPathForNode(t.drive);
    const transportPath = viewer.registry.getPathForNode(t.transport);
    // The hierarchy panel reconstructs parentage by splitting these strings —
    // a transport path that skips the drive segment renders as its sibling.
    expect(drivePath).toBeTruthy();
    expect(transportPath).toBeTruthy();
    expect(transportPath!.startsWith(drivePath! + '/')).toBe(true);
  });
});

/**
 * The same asset the way the LIBRARY file actually ships it: no component
 * extras at all (`public/library/PalletHandling/Turntable.glb` carries only
 * `layer/tag/activeSelf` per node). Drive and TransportSurface are synthesized
 * by the naming-convention scan inside `registerPlaced` — the step that is
 * skipped on the loader path and could therefore have drifted.
 */
function makeNameOnlyTurntable(): { root: Group; drive: Object3D; transport: Object3D } {
  const root = new Group();
  root.name = 'Turntable';
  root.userData.realvirtual = {
    LayoutObject: { Label: 'Turntable', CatalogId: 'cat:turntable', Locked: false },
    PlacementMeta: { catalogId: 'cat:turntable' },
  };
  const base = new Mesh(new BoxGeometry(2, 1, 2), new MeshBasicMaterial());
  base.name = 'Base';
  root.add(base);

  const drive = new Object3D();
  drive.name = 'Drive-Rot-Y';
  root.add(drive);

  const transport = new Object3D();
  transport.name = 'Transport-Z';
  drive.add(transport);
  for (const n of ['SmallRoll', 'Roll']) {
    const m = new Mesh(new BoxGeometry(1, 0.2, 1), new MeshBasicMaterial());
    m.name = n;
    transport.add(m);
  }
  return { root, drive, transport };
}

describe('the hierarchy rows the panel builds from those paths (B2)', () => {
  it('keeps Transport-Z nested under Drive-Rot-Y for the shipped, extras-free asset', () => {
    const { deps, viewer } = makeDeps();
    const t = makeNameOnlyTurntable();

    prepPlacedVisual(deps, t.root, 'p1', 'Turntable', 'cat:turntable');
    registerPlaced(deps, t.root, 'p1', 'Turntable', 'cat:turntable');

    // The naming scan really did synthesize the two components.
    const rv = (n: Object3D): Record<string, unknown> =>
      (n.userData.realvirtual ?? {}) as Record<string, unknown>;
    expect(rv(t.drive).Drive).toBeTruthy();
    expect(rv(t.transport).TransportSurface).toBeTruthy();

    // What the panel renders. Since plan-754 there is no path-splitting step
    // left to disagree with the graph — a row IS the object, and its parent row
    // IS `Object3D.parent` — so this case now pins the OTHER half of the
    // original defect: the registry path must still name the drive ancestor,
    // because everything addressed by path (ops, overrides, MCP) reads it.
    const expanded = new Set<string>();
    viewer.scene.traverse((n) => expanded.add(n.uuid));
    const rows = flattenSceneRows(viewer.scene as unknown as Object3D, expanded, {
      getPathForNode: (n: Object3D) => viewer.registry.getPathForNode(n) ?? null,
      overlay: null,
      modelRoot: null,
      hideRuntime: false,
    }).map((r) => r.node as SceneTreeNode);

    const driveRow = rows.find((r) => r.name === 'Drive-Rot-Y');
    const transportRow = rows.find((r) => r.name === 'Transport-Z');
    expect(driveRow).toBeTruthy();
    expect(transportRow).toBeTruthy();
    // Nested in the rendered tree…
    expect(transportRow!.object.parent).toBe(driveRow!.object);
    const driveDepth = rows.indexOf(driveRow!);
    const transportDepth = rows.indexOf(transportRow!);
    expect(transportDepth).toBe(driveDepth + 1);
    // …and nested in the path space too.
    expect(transportRow!.path).toBe(`${driveRow!.path}/Transport-Z`);
  });
});
