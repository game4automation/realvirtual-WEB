// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared in-memory GLB fixtures for the kinematic re-parenting / authoring
 * hierarchy tests (plan-727).
 *
 * GLB fixtures never exist as files in this repo: the scene is built in memory,
 * exported with `GLTFExporter().parseAsync(src, { binary: true })` and handed to
 * `loadGLB(label, scene, { data })`. The label is a pure log identifier —
 * `loadGLB` WITHOUT `data:` issues a real `fetch()` and fails with
 * `GLB fetch failed (404)`.
 *
 * Extracted from the inline `buildGLB()` of `rv-kinematic-instruction-ref.test.ts`.
 */

import { Scene, Object3D, Mesh, BoxGeometry, MeshBasicMaterial } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

async function toGlb(src: Scene): Promise<ArrayBuffer> {
  return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
}

function box(name: string): Mesh {
  const m = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  m.name = name;
  return m;
}

/**
 * The core case: a Kinematic axis that integrates group "G", whose only member
 * lives under an unrelated CAD parent.
 *
 * Runtime load  -> `Part.parent === Kine` (Phase 8b re-parents).
 * Authoring load -> `Part.parent === CadRoot` (plan-727: nothing is moved).
 *
 * Carries NON-IDENTITY transforms on purpose so `hierarchySignature`'s
 * transform component is actually exercised — with an identity fixture the
 * position/quaternion part of the signature would be inert.
 */
export async function buildKinematicGroupGLB(): Promise<ArrayBuffer> {
  const src = new Scene();

  const kin = new Object3D();
  kin.name = 'Kine';
  kin.position.set(0.25, 1.5, -0.75);
  kin.rotation.set(0, Math.PI / 6, 0);
  kin.userData = {
    realvirtual: {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' },
      Drive: { Direction: 'LinearX', StartPosition: 0 },
    },
  };

  const cadRoot = new Object3D();
  cadRoot.name = 'CadRoot';
  cadRoot.position.set(-2, 0, 0.5);
  const part = box('Part');
  part.position.set(1.25, 0.5, 0);
  part.rotation.set(Math.PI / 4, 0, 0);
  part.userData = { realvirtual: { Group: { GroupName: 'G' } } };
  cadRoot.add(part);

  src.add(kin);
  src.add(cadRoot);
  return toGlb(src);
}

/**
 * `KinematicParentEnable`: the Kinematic node itself is re-parented under
 * `Mount`. Authored under `CadRoot`, so an authoring load leaves it there.
 */
export async function buildKinematicParentGLB(): Promise<ArrayBuffer> {
  const src = new Scene();

  const cadRoot = new Object3D();
  cadRoot.name = 'CadRoot';
  cadRoot.position.set(-2, 0, 0.5);

  const kin = new Object3D();
  kin.name = 'Kine';
  kin.position.set(0.25, 1.5, -0.75);
  kin.userData = {
    realvirtual: {
      Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
      Drive: { Direction: 'LinearX', StartPosition: 0 },
    },
  };
  cadRoot.add(kin);

  const mount = new Object3D();
  mount.name = 'Mount';
  mount.position.set(3, 0.25, 0);

  src.add(cadRoot);
  src.add(mount);
  return toGlb(src);
}

/**
 * Nested axes: `Outer` carries a Drive, `Inner` carries only a `Kinematic`
 * extra (no Drive of its own — the Delta-robot passive-link case).
 *
 * Two dynamic-classification paths meet here on purpose:
 *  - `InnerPart` is a MEMBER of Inner's group "GI" but physically parked under
 *    `CadRoot` — it can only become dynamic through the group-aware
 *    reclassification (plan-727 Phase 8a-bis).
 *  - `InnerChild` hangs physically under `Inner` and is dynamic solely because
 *    `MOTION_KEY` in `processMeshes` matches the bare `Kinematic` key. That is
 *    a documented SIDE EFFECT, not designed transitivity; tightening MOTION_KEY
 *    must break the assertion on it.
 */
export async function buildNestedKinematicGLB(): Promise<ArrayBuffer> {
  const src = new Scene();

  const outer = new Object3D();
  outer.name = 'Outer';
  outer.position.set(0, 1, 0);
  outer.userData = {
    realvirtual: {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'GO' },
      Drive: { Direction: 'LinearX', StartPosition: 0 },
    },
  };

  const inner = new Object3D();
  inner.name = 'Inner';
  inner.position.set(0.5, 0, 0.25);
  inner.userData = {
    realvirtual: {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'GI' },
      Group: { GroupName: 'GO' },
    },
  };
  const innerChild = box('InnerChild');
  innerChild.position.set(0, 0.4, 0);
  inner.add(innerChild);
  outer.add(inner);

  const cadRoot = new Object3D();
  cadRoot.name = 'CadRoot';
  cadRoot.position.set(-1.5, 0, 0);
  const innerPart = box('InnerPart');
  innerPart.position.set(0.75, 0, 0.25);
  innerPart.userData = { realvirtual: { Group: { GroupName: 'GI' } } };
  cadRoot.add(innerPart);

  src.add(outer);
  src.add(cadRoot);
  return toGlb(src);
}

/**
 * Structure + transform signature of a subtree.
 *
 * Deliberately WITHOUT `.sort()`: `traverse` order is deterministic and carries
 * the sibling order, which a sort would erase — and re-parenting is exactly a
 * change of parentage AND sibling order. `matrixAutoUpdate` is part of the
 * signature so a frozen (invisibly non-moving) node cannot pass unnoticed.
 */
export function hierarchySignature(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => {
    const parts: string[] = [];
    for (let p: Object3D | null = n; p && p !== root; p = p.parent) parts.unshift(p.name);
    const t = `${n.position.toArray().map((v) => v.toFixed(4)).join(',')}|`
      + `${n.quaternion.toArray().map((v) => v.toFixed(4)).join(',')}|`
      + `${n.matrixAutoUpdate}`;
    out.push(`${parts.join('/')} @ ${t}`);
  });
  return out;
}

/** True when `node` is `ancestor` or lives anywhere below it. */
export function isDescendantOf(node: Object3D | undefined | null, ancestor: Object3D): boolean {
  for (let p: Object3D | null = node ?? null; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
