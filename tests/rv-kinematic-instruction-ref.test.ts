// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * End-to-end: GLB object references to kinematic-group members survive the
 * full loadGLB pipeline. Unity serializes references (e.g. instruction
 * targetObjects) as authoring-hierarchy paths; Phase 8b re-parents group
 * members under their Kinematic node, so Phase 8c must keep the pre-reparent
 * paths resolvable by registering them as registry aliases.
 */

import { describe, it, expect } from 'vitest';
import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import type { RVCustomRuntimeInstruction } from '../src/core/engine/rv-custom-runtime-instruction';

/** Build a GLB mirroring the Unity export: a Kinematic that integrates group
 *  "G", a group member under a different authoring parent, and an instruction
 *  whose target references the member by its authoring path. */
async function buildGLB(): Promise<ArrayBuffer> {
  const src = new Scene();

  const kin = new Object3D();
  kin.name = 'Kine';
  kin.userData = { realvirtual: { Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' } } };

  const oldParent = new Object3D();
  oldParent.name = 'OldParent';
  const part = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  part.name = 'Part';
  part.userData = { realvirtual: { Group: { GroupName: 'G' } } };
  oldParent.add(part);

  const instrNode = new Object3D();
  instrNode.name = 'Instruction';
  instrNode.userData = {
    realvirtual: {
      CustomRuntimeInstruction: {
        steps: [{ instruction: 'Inspect the part', targetObjects: ['OldParent/Part'] }],
      },
    },
  };

  src.add(kin);
  src.add(oldParent);
  src.add(instrNode);

  const exporter = new GLTFExporter();
  return (await exporter.parseAsync(src, { binary: true })) as ArrayBuffer;
}

describe('GLB round-trip: instruction target on a kinematic-group member', () => {
  it('authoring path still resolves after kinematic re-parenting (Phase 8c alias)', async () => {
    const data = await buildGLB();
    const scene = new Scene();
    const result = await loadGLB('kinematic-instruction-ref.glb', scene, {
      data,
      preserveHierarchy: true,
    });
    const registry = result.registry;

    // Kinematic re-parenting happened: Part now lives under Kine.
    let part: Object3D | null = null;
    result.root.traverse((n) => { if (n.name === 'Part') part = n; });
    expect(part).not.toBeNull();
    expect((part as unknown as Object3D).parent?.name).toBe('Kine');

    // The canonical registry path is the post-reparent one...
    const canonical = registry.getPathForNode(part as unknown as Object3D);
    expect(canonical).not.toBeNull();
    expect(canonical!.endsWith('Kine/Part')).toBe(true);

    // ...but the authoring path serialized in the GLB still resolves (alias).
    expect(registry.getNode('OldParent/Part')).toBe(part);

    // The instruction resolves its target exactly like highlightStep does.
    const instrs = registry.getAll<RVCustomRuntimeInstruction>('CustomRuntimeInstruction');
    expect(instrs.length).toBe(1);
    const targets = instrs[0].instance.stepTargetPaths(0);
    expect(targets).toEqual(['OldParent/Part']);
    expect(registry.getNode(targets[0])).toBe(part);
  });
});

/**
 * plan-727: the same GLB opened in AUTHORING mode. Nothing is re-parented, so
 * there is no alias to register — the authoring path IS the current path, and
 * the reference resolves directly. (Unity serializes references as authoring
 * paths; the `_N` dedup / `_rvOrigName` alias mechanism of Phase 6 is an
 * orthogonal concern and unaffected either way.)
 */
describe('GLB round-trip: instruction target in authoring mode', () => {
  it('resolves without an alias because nothing moved', async () => {
    const data = await buildGLB();
    const scene = new Scene();
    const result = await loadGLB('kinematic-instruction-ref.glb', scene, {
      data,
      preserveHierarchy: true,
      preserveAuthoringHierarchy: true,
    });
    const registry = result.registry;

    let part: Object3D | null = null;
    result.root.traverse((n) => { if (n.name === 'Part') part = n; });
    expect(part).not.toBeNull();
    expect((part as unknown as Object3D).parent?.name).toBe('OldParent');

    // The canonical path IS the authoring path here — no remap, no alias.
    const canonical = registry.getPathForNode(part as unknown as Object3D);
    expect(canonical!.endsWith('OldParent/Part')).toBe(true);
    expect(registry.getNode('OldParent/Part')).toBe(part);

    const instrs = registry.getAll<RVCustomRuntimeInstruction>('CustomRuntimeInstruction');
    expect(instrs.length).toBe(1);
    const targets = instrs[0].instance.stepTargetPaths(0);
    expect(targets).toEqual(['OldParent/Part']);
    expect(registry.getNode(targets[0])).toBe(part);
  });
});
