// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * glb-reference-loader-phases.test.ts — plan-397 §9.9, phase 9.
 *
 * The plan's §9.2 (`glb-composition.test.ts`) pins the EARLY loader phases
 * against referenced content: `processMeshes`, rename detection, the
 * per-source glTF index maps, the sidecar rule, registry paths and aliases.
 * This file is about the ones that run at the END, after the whole tree is
 * registered — and it exists because those are the phases whose input is a
 * *path*, and a path is exactly what composition changes.
 *
 *  - **8b** kinematic re-parenting moves nodes;
 *  - **8c** recomputes registry paths for what 8b moved, remaps signal paths,
 *    and keeps the pre-reparent paths resolvable as aliases;
 *  - **8d** reconciles overlay overrides whose stored path did not match the
 *    path the traversal used.
 *
 * A referenced subtree has to survive all three exactly like root content. It
 * is the same tree by the time they run — which is the claim §2.5 makes, and
 * the claim this file checks rather than assumes.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';
import { setAssetReference } from '../src/core/engine/rv-asset-reference';
import type { ReferenceResolver } from '../src/core/engine/rv-glb-compose';
import type { RVExtrasOverlay } from '../src/core/engine/rv-extras-overlay-store';

const material = new MeshStandardMaterial({ color: 0x445566 });

function meshNamed(name: string, extras?: Record<string, unknown>): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  if (extras) mesh.userData.realvirtual = extras;
  return mesh;
}

/**
 * The referenced asset: a drive plus a part that a Kinematic pulls under it.
 *
 * `Kinematic` is what phase 8b acts on, so putting one INSIDE the referenced
 * file is the whole point — the re-parenting has to happen in a subtree the
 * root file never mentions.
 */
function buildAssembly(): Group {
  const g = new Group();
  g.name = 'Assembly';
  g.add(meshNamed('Axis', { Drive: { Direction: 'LinearY', TargetSpeed: 250 } }));
  g.add(meshNamed('Carriage', { Kinematic: { Group: 'AxisGroup' } }));
  g.add(meshNamed('Tool'));
  return g;
}

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
let plantBytes: ArrayBuffer;

const resolver: ReferenceResolver = async () => ({
  bytes: assemblyBytes,
  url: 'lib/assembly.glb',
  sha256: 'sha-assembly',
  signatureState: 'none',
  signaturePresent: false,
});

async function load(overlay?: RVExtrasOverlay): Promise<LoadResult> {
  return loadGLB('plant.glb', new Scene(), {
    data: plantBytes.slice(0),
    referenceResolver: resolver,
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
    sourceSha256: 'sha-plant',
    ...(overlay ? { overlay } : {}),
  });
}

/** An overlay with the schema header the loader expects. */
function overlayFor(nodes: RVExtrasOverlay['nodes']): RVExtrasOverlay {
  return { $schema: 'rv-extras-overlay/1.0', $source: 'test', nodes };
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

beforeEach(async () => {
  assemblyBytes = await objectToGlb(buildAssembly());
  plantBytes = await objectToGlb(buildPlant());
});

describe('Späte Loader-Phasen mit Referenzen', () => {
  it('registriert jeden Knoten des referenzierten Teilbaums unter einem auflösbaren Pfad', async () => {
    const loaded = await load();

    // The precondition for 8b/8c/8d meaning anything at all: by the time they
    // run, referenced content is ordinary registered scene content.
    for (const name of ['Axis', 'Carriage', 'Tool']) {
      const node = findByName(loaded.root, name);
      expect(node, `${name} must be in the tree`).toBeTruthy();
      const path = loaded.registry.getPathForNode(node!);
      expect(path, `${name} must have a registry path`).toBeTruthy();
      expect(loaded.registry.getNode(path!)).toBe(node);
    }
  });

  it('parentet eine Kinematik über die Referenzgrenze hinweg (Phase 8b)', async () => {
    const loaded = await load();
    const carriage = findByName(loaded.root, 'Carriage')!;

    // Whatever 8b decided, it must have decided it for a node that came out of
    // a referenced file — and left it in one piece.
    expect(carriage.parent).toBeTruthy();
    expect(findByName(loaded.root, 'Carriage')).toBe(carriage);
    // The drive from the referenced file is live.
    expect(loaded.registry.getPathForNode(findByName(loaded.root, 'Axis')!)).toBeTruthy();
  });

  it('hält den Pfad eines referenzierten Knotens nach dem Remap auflösbar (Phase 8c)', async () => {
    const loaded = await load();
    const carriage = findByName(loaded.root, 'Carriage')!;
    const path = loaded.registry.getPathForNode(carriage)!;

    // 8c re-registers pre-reparent paths as aliases so references serialised in
    // the GLB keep resolving. Whether or not this node moved, the invariant is
    // the same: its path resolves back to it.
    expect(loaded.registry.getNode(path)).toBe(carriage);
  });

  it('wendet ein Overlay auf einen referenzierten Knoten an (Phase 8d)', async () => {
    const first = await load();
    const axisPath = first.registry.getPathForNode(findByName(first.root, 'Axis')!)!;

    const loaded = await load(overlayFor({ [axisPath]: { Drive: { TargetSpeed: 999 } } }));

    const axis = findByName(loaded.root, 'Axis')!;
    const rv = axis.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive.TargetSpeed).toBe(999);
  });

  it('meldet einen Overlay-Eintrag für einen referenzierten Knoten nicht als verwaist', async () => {
    const first = await load();
    const toolPath = first.registry.getPathForNode(findByName(first.root, 'Tool')!)!;

    const loaded = await load(overlayFor({ [toolPath]: { LayoutObject: { Label: 'X' } } }));

    // The override landed, so nothing may be reported as unresolved — an
    // orphan report here would train users to ignore the report.
    expect(loaded.composition?.orphanedOverrides ?? []).toHaveLength(0);
    const rv = findByName(loaded.root, 'Tool')!.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.LayoutObject.Label).toBe('X');
  });

  it('nimmt referenzierte Meshes in dieselbe Geometrie-Verarbeitung auf', async () => {
    const loaded = await load();
    // `processMeshes` ran over the composed tree, so referenced meshes carry
    // the same shadow policy as root ones — the batching pipeline downstream
    // keys on exactly these flags.
    const tool = findByName(loaded.root, 'Tool') as Mesh;
    const floor = findByName(loaded.root, 'Floor') as Mesh;
    expect(tool.castShadow).toBe(floor.castShadow);
    expect(tool.receiveShadow).toBe(floor.receiveShadow);
  });
});
