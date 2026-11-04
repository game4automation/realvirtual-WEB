// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 Phase 0 — characterisation of the Mauser core bug at HEAD (9.2 seed).
 *
 * Mauser Cageline30 (2026-10-20): a reference to a part that Three.js RENAMES
 * (file-wide `_N` de-duplication) AND that the `Kinematic` prepare hook
 * RE-PARENTS does not bind to the authored node. This fixture is the smallest
 * file with exactly that shape, built so that the guessing stages have a
 * WRONG candidate available:
 *
 *   Cell                                      (glTF scene → model root)
 *    ├─ CadA/Sep/Pin              (mesh)      — first "Sep", first "Pin": keeps the names
 *    ├─ CadB/Sep  Kinematic → Mount (+Drive)  — loads as "Sep_1"; re-parented under Mount
 *    │      └─ Pin                (mesh)      — loads as "Pin_1"
 *    ├─ Mount
 *    └─ Panel  CustomRuntimeInstruction  steps[0].targetObjects = ["CadB/Sep/Pin"]
 *                                         + a ComponentReference "CadB/Sep" (Drive)
 *
 * Authored truth: "CadB/Sep/Pin" is the Pin under the Kinematic Sep. The
 * plan-769 migration binds it through the file's authored index; HEAD has to
 * go through renamed-node aliases and prefix aliases of the re-parented subtree.
 * The assertions describe the CORRECT outcome — the HEAD behaviour is pinned
 * with `it.fails` where it is wrong, so Phase 1 flips them to plain `it`.
 *
 * Phase 1b (2026-10-21): flipped. Two assertions changed FORM, not intent: an
 * authored path is a path input (`findNodeForUser`, D6/F9 — `getNode` stays the
 * runtime index), and the surviving pin is identified by its authored path (a
 * chunk boundary keeps no box geometry of its own).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { getProblems, resetProblemsForTests, UNRESOLVED_INSTRUCTION_TARGET_CODE } from '../src/core/hmi/problems-store';
import { bakeRemovalReport } from '../src/core/engine/rv-bake-survival';

function box(name: string, size: number): Mesh {
  // Different geometry sizes: GLTFExporter would merge identical meshes.
  const m = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  m.name = name;
  return m;
}

function node(name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  return n;
}

export async function buildMauserLikeGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  scene.name = 'Cell';
  const cadA = node('CadA');
  cadA.position.set(-2, 0, 0);
  const sepA = node('Sep');
  sepA.add(box('Pin', 0.1));
  cadA.add(sepA);
  const cadB = node('CadB');
  cadB.position.set(2, 0, 0);
  const sepB = node('Sep', {
    Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
    Drive: { Direction: 'LinearX', StartPosition: 0 },
  });
  sepB.add(box('Pin', 0.2));
  cadB.add(sepB);
  const mount = node('Mount');
  mount.position.set(0, 1, 0);
  const panel = node('Panel', {
    CustomRuntimeInstruction: { steps: [{ instruction: 'look at the pin', targetObjects: ['CadB/Sep/Pin'] }] },
  });
  scene.add(cadA, cadB, mount, panel);
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

/** The authored CadB pin wherever the hooks put it: the 0.2 box under the Kinematic node. */
function authoredPin(root: Object3D): Object3D | null {
  let hit: Object3D | null = null;
  root.traverse((n) => {
    const g = (n as Mesh).geometry as BoxGeometry | undefined;
    if (!hit && g?.parameters?.width === 0.2) hit = n;
  });
  return hit;
}

describe('plan-769 Phase 0 — Mauser-like reference (dedup-renamed + re-parented)', () => {
  let h: TestViewerHandle | null = null;
  afterEach(() => { h?.dispose(); h = null; resetProblemsForTests(); });

  async function load(): Promise<TestViewerHandle> {
    resetProblemsForTests();
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-like.glb', { data: await buildMauserLikeGlb() });
    return h;
  }

  it('fixture sanity: the Kinematic hook re-parents the renamed Sep under Mount', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    const sep = reg.getNode('Cell/Mount/Sep_1');
    expect(sep).not.toBeNull();
    expect(sep!.parent?.name).toBe('Mount');
  });

  // HEAD: null — the loader publishes 'Cell/CadB/Sep_1/Pin_1' aliases, but the hook moved the subtree.
  // Phase 1b (plan-769 D6/F9): `getNode` stays the RUNTIME path index; an authored
  // path is an INPUT and goes through `findNodeForUser` — exact through the file's
  // authored index (`via: 'authored'`), never through a guessing stage. The baked
  // pin keeps no box geometry of its own (it became a chunk boundary), so it is
  // identified by its authored path and its parent, the Kinematic `Sep`.
  it('the authored target path names the CadB pin (exact, in the registry)', async () => {
    const { viewer } = await load();
    const reg = viewer.registry!;
    expect(reg.getNode('Cell/CadB/Sep/Pin')).toBeNull(); // the runtime index knows only runtime paths
    const hit = reg.findNodeForUser('CadB/Sep/Pin');
    expect(hit?.via).toBe('authored');
    expect(reg.getAuthoredPath(hit!.node)).toBe('CadB/Sep/Pin');
    expect(hit!.node.parent && reg.getAuthoredPath(hit!.node.parent)).toBe('CadB/Sep');
    expect(hit!.node.parent?.parent?.name).toBe('Mount'); // the re-parented one, not CadA's
  });

  // HEAD: one unresolved-instruction-target + one reference-unresolved for "CadB/Sep/Pin".
  it('the instruction target resolves (no unresolved-instruction-target)', async () => {
    await load();
    const misses = getProblems().filter((p) => p.code === UNRESOLVED_INSTRUCTION_TARGET_CODE);
    expect(misses).toEqual([]);
  });

  // HEAD: the reference does not resolve in prepare either, so nothing claims the pin and the bake drops it.
  // Phase 1b ("Survival == Runtime"): prepare reads the target by the file's verdict,
  // tags it, the bake keeps it, and the runtime resolves the SAME node by address.
  it('the authored pin survives the bake (the reference claims it)', async () => {
    bakeRemovalReport.length = 0;
    const { viewer } = await load();
    const reg = viewer.registry!;
    const report = bakeRemovalReport.find((r) => r.assetId === 'mauser-like.glb') ?? bakeRemovalReport[0];
    expect(report?.unresolvedReferences.filter((u) => u.path === 'CadB/Sep/Pin')).toEqual([]);
    const r = reg.resolveRef(reg.getNode('Cell/Panel')!, 'CadB/Sep/Pin');
    expect(r.status).toBe('resolved');
    const pin = r.status === 'resolved' ? r.node : null;
    let attached = false;
    for (let n: Object3D | null = pin; n; n = n.parent) if (n === viewer.currentModelRoot) attached = true;
    expect(attached).toBe(true);
    expect(reg.getAuthoredPath(pin!)).toBe('CadB/Sep/Pin');
  });
});
