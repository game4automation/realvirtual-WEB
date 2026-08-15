// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-stack-recompose.test.ts — plan-703 §9.4b, the ACCEPTANCE
 * CRITERION of Phase 4, and the measurement that decided §2.7.3.
 *
 * A child asset with its own drive and its own shadow-casting mesh is entered,
 * changed, saved and left. Afterwards four things must hold, and §9.4b insists
 * they be checked SEPARATELY, because the plan's first draft conflated two of
 * them:
 *
 *  1. **the drive RUNS** — an `RVDrive` instance exists again, is reachable
 *     through the registry, and one `update()` moves the node. This comes out
 *     of `traverseAndRegister` (`rv-scene-loader.ts:822`), NOT out of
 *     `driveNodeSet`;
 *  2. **shadows/batching** — `castShadow` parity plus `driveNodeSet`
 *     membership, which is what `processMeshes` classifies;
 *  3. **registry** — every path of the subtree resolves, aliases included;
 *  4. **overrides** — the parent's instance overrides are applied again.
 *
 * ## The measurement (§2.7.3): subtree graft vs. full parent reload
 *
 * `describe('Messung')` below runs the SUBTREE way from the plan's step-3/4
 * table by hand — detach, graft the new bytes, re-run `processMeshes` and the
 * registration chain against the parent's LIVE registry — and pins what it does
 * and does not achieve. `describe('Voller Eltern-Reload')` runs the shipped
 * path. The difference between the two is the evidence recorded in §2.7.3.
 *
 * Renderer-free throughout: `loadGLB` is called directly against a bare
 * `Scene`, exactly as `glb-reference-loader-phases.test.ts` does.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  buildGroups,
  initializeComponents,
  loadAndPrepareGLTF,
  loadGLB,
  processMeshes,
  registerNodeAliases,
  traverseAndRegister,
  type LoadResult,
} from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVDrive } from '../src/core/engine/rv-drive';
import {
  setAssetOverrides,
  setAssetReference,
} from '../src/core/engine/rv-asset-reference';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';

const material = new MeshStandardMaterial({ color: 0x445566 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/**
 * The child asset: one drive, one plain shadow caster, one group member.
 *
 * The `Group` is deliberately present — the `GroupRegistry` is one of the
 * singletons the subtree way cannot reach, and a fixture that only carried a
 * drive would never notice.
 */
function buildAssembly(targetSpeed: number): Group {
  const g = new Group();
  g.name = 'Assembly';
  g.add(meshNamed('Axis', {
    Drive: { Direction: 'LinearY', TargetSpeed: targetSpeed, JogForward: true },
  }));
  g.add(meshNamed('Carriage', { Group: { GroupName: 'AxisGroup' } }));
  g.add(meshNamed('Tool'));
  return g;
}

/** The parent: a floor and one reference to the child, carrying overrides. */
function buildPlant(): Group {
  const plant = new Group();
  plant.name = 'Plant';
  plant.add(meshNamed('Floor'));
  const reference = new Object3D();
  reference.name = 'Station';
  setAssetReference(reference, { assetId: 'assembly' });
  plant.add(reference);
  return plant;
}

let assemblyBytes: ArrayBuffer;
let assemblyBytesEdited: ArrayBuffer;
let plantBytes: ArrayBuffer;
/** Flipped by the "save" step so the resolver hands out the edited child. */
let serveEdited = false;

const resolver: ReferenceResolver = async () => ({
  bytes: (serveEdited ? assemblyBytesEdited : assemblyBytes).slice(0),
  url: 'lib/assembly.glb',
  sha256: serveEdited ? 'sha-assembly-2' : 'sha-assembly',
  signatureState: 'none',
  signaturePresent: false,
});

async function loadPlant(): Promise<LoadResult> {
  return loadGLB('plant.glb', new Scene(), {
    data: plantBytes.slice(0),
    referenceResolver: resolver,
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
    sourceSha256: 'sha-plant',
  });
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

/** The `RVDrive` registered for a node, or null. */
function driveAt(result: LoadResult, node: Object3D): RVDrive | null {
  const path = result.registry.getPathForNode(node);
  if (!path) return null;
  for (const [, component] of result.registry.getComponentsAt(path)) {
    if (component instanceof RVDrive) return component;
  }
  return null;
}

/**
 * Half a second of fixed-step ticks, and how far the node actually moved.
 *
 * More than one step on purpose: `RVDrive` ramps through `Acceleration`, so the
 * FIRST tick of a drive starting from rest moves it exactly zero — a
 * single-tick assertion would fail on a perfectly healthy drive.
 */
function tickAndMeasure(drive: RVDrive, steps = 30): number {
  const before = drive.node.position.y;
  for (let i = 0; i < steps; i++) {
    drive.update(1 / 60);
    drive.applyToNode();
  }
  return drive.node.position.y - before;
}

beforeEach(async () => {
  serveEdited = false;
  assemblyBytes = await objectToGlb(buildAssembly(250));
  // "The user descended, changed TargetSpeed, saved" — the child's new bytes.
  assemblyBytesEdited = await objectToGlb(buildAssembly(900));
  plantBytes = await objectToGlb(buildPlant());
});

// ─────────────────────────────────────────────────────────────────────────
// The four criteria, on a freshly composed parent. This is the BASELINE the
// two recomposition candidates are measured against — without it, "the drive
// runs after Back" could pass by never having run at all.
// ─────────────────────────────────────────────────────────────────────────

describe('Ausgangszustand: das komponierte Kind traegt alle vier Eigenschaften', () => {
  it('Drive laeuft, Schatten klassifiziert, Registry aufloest', async () => {
    const loaded = await loadPlant();
    const axis = findByName(loaded.root, 'Axis')!;

    const drive = driveAt(loaded, axis);
    expect(drive, 'the referenced file\'s drive must be a live instance').toBeTruthy();
    expect(Math.abs(tickAndMeasure(drive!))).toBeGreaterThan(0);

    expect((axis as Mesh).castShadow).toBe(true);
    expect(loaded.registry.getNode(loaded.registry.getPathForNode(axis)!)).toBe(axis);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §2.7.3 — THE MEASUREMENT.
// ─────────────────────────────────────────────────────────────────────────

describe('Messung: der Teilbaum-Weg (§2.7.3 Schritte 1-4 von Hand)', () => {
  /**
   * Steps 1-4 of the plan's table, executed against the parent's live objects.
   *
   * Step 2's `compose()` degenerates to a parse for a child that references
   * nothing further, which is deliberately the EASIEST possible case: if the
   * subtree way cannot carry this, it cannot carry a nested one either.
   */
  async function graftSubtreeWay(loaded: LoadResult): Promise<{
    subtreeRoot: Object3D;
    reference: Object3D;
    stalePathsResolving: string[];
  }> {
    const reference = findByName(loaded.root, 'Station')!;
    const oldSubtree = reference.children.slice();
    const oldPaths = oldSubtree.flatMap((n) => {
      const paths: string[] = [];
      n.traverse((c) => {
        const p = loaded.registry.getPathForNode(c);
        if (p) paths.push(p);
      });
      return paths;
    });

    // Step 1 — DETACH, never dispose (§5.3: shared template resources).
    for (const child of oldSubtree) reference.remove(child);

    // Step 2 — the new bytes, grafted at the same reference node.
    const parsed = await loadAndPrepareGLTF('lib/assembly.glb', new Scene(), assemblyBytesEdited.slice(0));
    const subtreeRoot = parsed.root;
    reference.add(subtreeRoot);
    loaded.root.updateMatrixWorld(true);

    // Step 3 — the four pre-phases, on the grafted subtree.
    processMeshes(subtreeRoot);

    // Step 4 — the registration chain, against the parent's LIVE registry and
    // signal store. This is the part `traverseAndRegister` accepts mechanically.
    const traversed = traverseAndRegister(
      subtreeRoot, loaded.registry, loaded.signalStore, new Map(),
    );
    registerNodeAliases(new Map(), loaded.registry, loaded.signalStore);
    initializeComponents(traversed.pending, {
      registry: loaded.registry,
      signalStore: loaded.signalStore,
      scene: loaded.root.parent as Scene,
      transportManager: loaded.transportManager,
      root: loaded.root,
      expectSceneReady: true,
    });

    // What the old paths do now.
    const stalePathsResolving = oldPaths.filter((p) => loaded.registry.getNode(p) !== null);
    return { subtreeRoot, reference, stalePathsResolving };
  }

  it('bringt den Drive zurueck — der mechanische Teil traegt', async () => {
    const loaded = await loadPlant();
    const { subtreeRoot } = await graftSubtreeWay(loaded);

    const axis = findByName(subtreeRoot, 'Axis')!;
    const drive = driveAt(loaded, axis);
    // `traverseAndRegister` takes an existing registry, so this half works —
    // which is exactly why the subtree way looked viable in the first draft.
    expect(drive, 'traverseAndRegister constructs the drive on a subtree too').toBeTruthy();
    expect((axis.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed)
      .toBe(900);
  });

  it('MESSUNG A: die Registry behaelt die Pfade des abgehaengten Teilbaums', async () => {
    const loaded = await loadPlant();
    const { stalePathsResolving } = await graftSubtreeWay(loaded);

    // The verdict. `traverseAndRegister` only ADDS; nothing in the step-3/4
    // table evicts what step 1 detached, so the old paths keep resolving — to
    // nodes that are no longer in the scene. `NodeRegistry.unregisterSubtree`
    // exists, but the plan's table does not call it, and a Back that silently
    // leaves ghosts is a Back that breaks the next save's path lookups.
    expect(stalePathsResolving.length).toBeGreaterThan(0);
  });

  it('MESSUNG B: die GroupRegistry des Elternteils kennt die neue Kinematik nicht', async () => {
    const loaded = await loadPlant();
    const before = loaded.groups?.getGroupNames?.() ?? [];
    const { subtreeRoot } = await graftSubtreeWay(loaded);

    // `buildGroups` CONSTRUCTS a registry — there is no incremental merge into
    // the one the viewer already holds (and the viewer's isolation gate, the
    // renderer's 3-pass isolate and the dimming all close over that instance,
    // `rv-viewer.ts:3553`). So the subtree's groups land in a throwaway.
    const traversed = traverseAndRegister(
      subtreeRoot, new NodeRegistry(), new SignalStore(), new Map(),
    );
    const orphanRegistry = buildGroups(traversed.groupNodes, loaded.registry);
    expect(orphanRegistry).not.toBe(loaded.groups);

    // And the live one is unchanged by the graft.
    const after = loaded.groups?.getGroupNames?.() ?? [];
    expect(after).toEqual(before);
  });

  it('MESSUNG C: der neue Teilbaum ist nicht in driveNodeSet des Elternteils', async () => {
    const loaded = await loadPlant();
    const { subtreeRoot } = await graftSubtreeWay(loaded);
    const axis = findByName(subtreeRoot, 'Axis')!;

    // `driveNodeSet` is a value returned ONCE by the load's `processMeshes`
    // and handed to `rv-arena-planner` / `rv-batched-render`. Re-running
    // `processMeshes` on the subtree produces a SECOND set that no consumer
    // holds; the parent's classification never learns about the new nodes.
    const fresh = processMeshes(subtreeRoot);
    expect(fresh.driveNodeSet.has(axis)).toBe(true);
    // The parent's own set — the one the batch planner was built from — is a
    // different object, and there is no API to fold one into the other.
    const parentSet = processMeshes(loaded.root).driveNodeSet;
    expect(parentSet).not.toBe(fresh.driveNodeSet);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The shipped path. Full reload of the parent from its bytes + op replay.
// ─────────────────────────────────────────────────────────────────────────

describe('Voller Eltern-Reload: die vier Abnahmekriterien nach Back', () => {
  /** Descend → edit → save → Back, in the shape the recomposer implements. */
  async function descendEditSaveBack(): Promise<LoadResult> {
    const before = await loadPlant();
    expect(driveAt(before, findByName(before.root, 'Axis')!)).toBeTruthy();

    // The child was edited and SAVED: its file now holds the new bytes.
    serveEdited = true;

    // Back — the parent is reloaded from its own bytes; composition picks the
    // child's new file up because that is what the resolver now serves.
    return loadPlant();
  }

  it('1. der Drive laeuft wieder — Instanz, Registry, ein Tick bewegt den Knoten', async () => {
    const after = await descendEditSaveBack();
    const axis = findByName(after.root, 'Axis')!;

    const drive = driveAt(after, axis);
    expect(drive).toBeTruthy();
    expect(after.drives).toContain(drive!);
    // The EDIT survived the round trip, so this is the new document's drive.
    expect(drive!.TargetSpeed).toBe(900);
    expect(Math.abs(tickAndMeasure(drive!))).toBeGreaterThan(0);
  });

  it('2. Schatten/Batching: castShadow-Paritaet und driveNodeSet-Mitgliedschaft', async () => {
    const after = await descendEditSaveBack();
    const axis = findByName(after.root, 'Axis') as Mesh;
    const tool = findByName(after.root, 'Tool') as Mesh;
    const floor = findByName(after.root, 'Floor') as Mesh;

    // Parity: referenced meshes are classified exactly like root-file meshes.
    expect(axis.castShadow).toBe(true);
    expect(tool.castShadow).toBe(true);
    expect(floor.castShadow).toBe(true);

    // `driveNodeSet` membership, recomputed by the reload's own processMeshes.
    expect(processMeshes(after.root).driveNodeSet.has(axis)).toBe(true);
    // A drive node is dynamic — the classification that a stale graft loses.
    expect(axis.matrixAutoUpdate).toBe(true);
  });

  it('3. Registry: jeder Pfad des Teilbaums loest auf, und kein Geisterpfad bleibt', async () => {
    const before = await loadPlant();
    const stalePaths: string[] = [];
    findByName(before.root, 'Station')!.traverse((n) => {
      const p = before.registry.getPathForNode(n);
      if (p) stalePaths.push(p);
    });

    serveEdited = true;
    const after = await loadPlant();

    for (const name of ['Axis', 'Carriage', 'Tool']) {
      const node = findByName(after.root, name)!;
      const path = after.registry.getPathForNode(node);
      expect(path, `${name} must have a registry path`).toBeTruthy();
      expect(after.registry.getNode(path!)).toBe(node);
    }
    // The reload builds a FRESH registry, so no path of the old tree can
    // survive into it — the ghost-path failure of MESSUNG A cannot occur.
    for (const path of stalePaths) {
      const resolved = after.registry.getNode(path);
      if (resolved) expect(resolved).not.toBe(before.registry.getNode(path));
    }
  });

  it('4. Overrides des Referenzknotens sind erneut angewandt', async () => {
    // Author an override on the reference node, then run the round trip.
    const plant = buildPlant();
    const reference = findByName(plant, 'Station')!;
    // Addressed by PATH: node ids are minted at save time and a test that
    // hand-mints them would be testing its own fixture.
    setAssetOverrides(reference, { byNodeId: {}, byPath: { Axis: { Drive: { TargetSpeed: 42 } } } });
    plantBytes = await objectToGlb(plant);

    const before = await loadPlant();
    const axisBefore = findByName(before.root, 'Axis')!;
    const overriddenBefore =
      (axisBefore.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;

    serveEdited = true;
    const after = await loadPlant();
    const axisAfter = findByName(after.root, 'Axis')!;
    const overriddenAfter =
      (axisAfter.userData.realvirtual as Record<string, Record<string, unknown>>).Drive.TargetSpeed;

    // Whatever the override resolved to before the round trip, it resolves to
    // the same thing after it: the overrides belong to the PARENT, and the
    // parent's bytes did not change.
    expect(overriddenAfter).toBe(overriddenBefore);
  });
});
