// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kinematic group NAMES at init time, and what the init deliberately does NOT
 * do any more.
 *
 * Until plan-757 Phase 3 commit B `applyKinematicParenting()` carried two
 * halves: the resolution of `IntegrateGroupEnable` group names (with
 * `GroupNamePrefix`) and the runtime re-parent passes (group members under the
 * axis, `KinematicParentEnable` axes under their parent, `matrixAutoUpdate` +
 * drive-base fix-up). The re-parent passes are gone: re-parenting happens ONCE,
 * in `prepare` of the recipe (the `Kinematic` pre-bake hook —
 * `tests/bake-pipeline-order.test.ts` pins every case the deleted passes
 * used to pin). What is left is `resolveKinematicGroupNames()`: names only,
 * for `GroupRegistry.isKinematic()` and the editor's group-assignment menu
 * (plan-727 F9).
 *
 * The `'bracket'` / `'defer'` home-pose modes of `initSubtree` went with the
 * passes (they only ever protected the pose while a member was attached), so
 * the init leaves every drive exactly where its `init()` put it — pinned here
 * on the fixture of the deleted `drive-home-pose-modes` characterisation.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { initSubtree, resolveKinematicGroupNames, type KinematicNodeEntry } from '../src/core/engine/rv-scene-loader';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { RVDrive } from '../src/core/engine/rv-drive';

/** Helper: create a minimal NodeRegistry with nodes registered by path */
function buildRegistry(root: Object3D): NodeRegistry {
  const reg = new NodeRegistry();
  root.traverse((node: Object3D) => {
    const path = NodeRegistry.computeNodePath(node);
    reg.registerNode(path, node);
  });
  return reg;
}

describe('resolveKinematicGroupNames (names only, plan-757 Phase 3 commit B)', () => {
  it('resolves the group name and moves NOTHING', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kinematic1';
    kinNode.position.set(100, 0, 0);
    const cadParent = new Object3D(); cadParent.name = 'CadRoot';
    const groupNode = new Object3D(); groupNode.name = 'Part1';
    groupNode.position.set(50, 0, 0);
    cadParent.add(groupNode);
    root.add(kinNode);
    root.add(cadParent);
    root.updateMatrixWorld(true);
    const worldBefore = groupNode.getWorldPosition(new Vector3());

    const groups = new GroupRegistry();
    groups.register('MyGroup', groupNode);
    const registry = buildRegistry(root);
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'MyGroup' },
    }];

    const names = resolveKinematicGroupNames(kinEntries, groups, registry);
    expect(names).toEqual(['MyGroup']);
    expect(groupNode.parent).toBe(cadParent);
    expect(groupNode.getWorldPosition(new Vector3()).distanceTo(worldBefore)).toBe(0);
  });

  it('returns empty when no kinematic nodes', () => {
    const root = new Object3D();
    const registry = buildRegistry(root);
    expect(resolveKinematicGroupNames([], null, registry)).toEqual([]);
  });

  it('skips when GroupName is empty', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    root.add(kinNode);
    const groups = new GroupRegistry();
    const registry = buildRegistry(root);
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: '' },
    }];
    expect(resolveKinematicGroupNames(kinEntries, groups, registry)).toEqual([]);
  });

  it('skips a group nobody registered', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    root.add(kinNode);
    const registry = buildRegistry(root);
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'Nope' },
    }];
    expect(resolveKinematicGroupNames(kinEntries, new GroupRegistry(), registry)).toEqual([]);
    expect(resolveKinematicGroupNames(kinEntries, null, registry)).toEqual([]);
  });

  it('falls back to GroupName when GroupNamePrefix not found', () => {
    const root = new Object3D(); root.name = 'Root';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const groupNode = new Object3D(); groupNode.name = 'Arm';
    root.add(kinNode);
    root.add(groupNode);
    const groups = new GroupRegistry();
    groups.register('Arm', groupNode);
    const registry = buildRegistry(root);
    const kinEntries: KinematicNodeEntry[] = [{
      node: kinNode,
      data: {
        IntegrateGroupEnable: true,
        GroupName: 'Arm',
        GroupNamePrefix: { path: 'NonExistent/Path' },
      },
    }];
    expect(resolveKinematicGroupNames(kinEntries, groups, registry)).toEqual(['Arm']);
    expect(groupNode.parent).toBe(root);
  });

  it('resolves GroupNamePrefix to prefixNode.name + GroupName (path object and string form)', () => {
    const root = new Object3D(); root.name = 'Root';
    const prefixNode = new Object3D(); prefixNode.name = 'Robot1';
    const kinNode = new Object3D(); kinNode.name = 'Kin';
    const groupNode = new Object3D(); groupNode.name = 'PartA';
    root.add(prefixNode);
    root.add(kinNode);
    root.add(groupNode);
    const groups = new GroupRegistry();
    groups.register('Robot1Arm', groupNode);
    const registry = buildRegistry(root);
    // NodeRegistry.computeNodePath stops at scene root, so path is just "Robot1"
    const asObject: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'Arm', GroupNamePrefix: { path: 'Robot1' } },
    }];
    const asString: KinematicNodeEntry[] = [{
      node: kinNode,
      data: { IntegrateGroupEnable: true, GroupName: 'Arm', GroupNamePrefix: 'Robot1' },
    }];
    expect(resolveKinematicGroupNames(asObject, groups, registry)).toEqual(['Robot1Arm']);
    expect(resolveKinematicGroupNames(asString, groups, registry)).toEqual(['Robot1Arm']);
    expect(groupNode.parent).toBe(root);
  });

  it('KinematicParentEnable is not its business: the axis stays where it is authored', () => {
    const root = new Object3D(); root.name = 'Root';
    const cadParent = new Object3D(); cadParent.name = 'CadRoot';
    const kinNode = new Object3D(); kinNode.name = 'Kine';
    cadParent.add(kinNode);
    const mount = new Object3D(); mount.name = 'Mount';
    root.add(cadParent);
    root.add(mount);
    const registry = buildRegistry(root);
    const names = resolveKinematicGroupNames(
      [{ node: kinNode, data: { KinematicParentEnable: true, Parent: { path: 'Mount' } } }],
      null, registry,
    );
    expect(names).toEqual([]);
    expect(kinNode.parent).toBe(cadParent);
  });
});

/**
 * The init and the drive pose — the fixture of the deleted
 * `drive-home-pose-modes` characterisation: an axis `Kine` (Drive LinearX,
 * StartPosition 100 mm) integrating group `G`, whose only member `Part` is
 * authored under an unrelated `CadRoot`. Before commit B the init snapshotted
 * the drives, drove to home, attached and restored; now it does none of that.
 */
describe('initSubtree never moves a node and never drives an axis to home (plan-757 Phase 3 commit B)', () => {
  const START_POSITION_MM = 100;
  const KINE_HOME = new Vector3(0.25, 1.5, -0.75);

  function buildTree(): { scene: Scene; root: Object3D; kine: Object3D; part: Object3D } {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Root';
    const kine = new Object3D();
    kine.name = 'Kine';
    kine.position.copy(KINE_HOME);
    kine.userData.realvirtual = {
      Kinematic: { IntegrateGroupEnable: true, GroupName: 'G' },
      Drive: { Direction: 'LinearX', StartPosition: START_POSITION_MM },
    };
    const cadRoot = new Object3D();
    cadRoot.name = 'CadRoot';
    cadRoot.position.set(-2, 0, 0.5);
    const part = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    part.name = 'Part';
    part.position.set(1.25, 0.5, 0);
    part.userData.realvirtual = { Group: { GroupName: 'G' } };
    cadRoot.add(part);
    root.add(kine, cadRoot);
    scene.add(root);
    scene.updateMatrixWorld(true);
    return { scene, root, kine, part };
  }

  for (const authoring of [false, true]) {
    it(`preserveAuthoringHierarchy: ${authoring} — the member stays under CadRoot, the axis sits at StartPosition, the name flows`, () => {
      const { scene, root, kine, part } = buildTree();
      const partAuthoredWorld = part.getWorldPosition(new Vector3());
      const registry = new NodeRegistry();
      const result = initSubtree(root, {
        registry, signalStore: new SignalStore(), transportManager: new RVTransportManager(), scene,
        preserveAuthoringHierarchy: authoring,
      });
      const drive = result.drives[0] as RVDrive;
      expect(drive).toBeDefined();
      // Nothing was attached — in NO mode.
      expect(part.parent?.name).toBe('CadRoot');
      expect(part.getWorldPosition(new Vector3()).distanceTo(partAuthoredWorld)).toBeLessThan(1e-9);
      // The drive is where its init() put it: at StartPosition, not bracketed
      // through home and back.
      expect(drive.currentPosition).toBe(START_POSITION_MM);
      const expectedPose = KINE_HOME.clone().addScaledVector(drive.getAxis(), drive.positionToLocalOffset(START_POSITION_MM));
      expect(kine.position.distanceTo(expectedPose)).toBeLessThan(1e-6);
      // The name still flows (plan-727 F9) — identically in both modes.
      expect(result.kinematicGroupNames).toEqual(['G']);
      expect(result.groups?.isKinematic('G')).toBe(true);
      // plan-727 F8: the member is dynamic although it does not hang under the axis.
      expect(part.matrixAutoUpdate).toBe(true);
      // The result carries no restore hook any more.
      expect('restoreDriveHomePose' in result).toBe(false);
    });
  }
});

describe('group-aware dynamic classification (plan-727 F8)', () => {
  it('marks group members dynamic without reparenting', async () => {
    const { loadGLB } = await import('../src/core/engine/rv-scene-loader');
    const { Scene } = await import('three');
    const { buildKinematicGroupGLB } = await import('./kinematic-fixture');

    const scene = new Scene();
    await loadGLB('kin.glb', scene, {
      data: await buildKinematicGroupGLB(), preserveAuthoringHierarchy: true,
    });
    // The exact regression the isStatic branch of processMeshes describes:
    // frozen means three.js never rebuilds the matrix from the quaternion the
    // drive writes — "running" drive, motionless geometry.
    expect(scene.getObjectByName('Part')?.matrixAutoUpdate).toBe(true);
  });

  // (The "runtime classification never turns a dynamic node static" golden set
  // of plan-727 went with commit B: a RUNTIME load bakes, and `Part` — a plain
  // mesh carrying only a `Group` — is merged into the axis' mover chunk and is
  // no node at all afterwards. The premise "the member node exists after a
  // runtime load" is gone, not the monotonicity: `reclassifyKinematicGroupsDynamic`
  // still only ever sets `matrixAutoUpdate = true`, pinned above on the
  // authoring load.)

  // Guards the SIDE EFFECT documented in plan-727 §2.5: a nested axis without a
  // Drive of its own qualifies today only because MOTION_KEY matches the bare
  // `Kinematic` key. This is not designed transitivity — tighten MOTION_KEY and
  // this test is supposed to break.
  it('nested axis without its own Drive still classifies as dynamic', async () => {
    const { loadGLB } = await import('../src/core/engine/rv-scene-loader');
    const { Scene } = await import('three');
    const { buildNestedKinematicGLB } = await import('./kinematic-fixture');
    const { Vector3 } = await import('three');

    const scene = new Scene();
    await loadGLB('kin.glb', scene, {
      data: await buildNestedKinematicGLB(), preserveAuthoringHierarchy: true,
    });
    // Reached through group membership (the plan-727 reclassification)...
    expect(scene.getObjectByName('InnerPart')?.matrixAutoUpdate).toBe(true);
    // ...and through the bare-`Kinematic` MOTION_KEY match: the nested axis
    // itself is a LOCAL mover (its local matrix is re-composed every frame)...
    expect(scene.getObjectByName('Inner')?.matrixAutoUpdate).toBe(true);
    // ...and its plain child rides along through a LIVE WORLD matrix. Since
    // 97bc6643 (freezeStaticMatrices `localMovers`, 2026-09-17) a mover's pure
    // descendant deliberately stops re-composing its constant LOCAL matrix
    // (`matrixAutoUpdate = false`); "dynamic" for it means matrixWorldAutoUpdate.
    const innerChild = scene.getObjectByName('InnerChild');
    expect(innerChild?.matrixWorldAutoUpdate).toBe(true);
    const outer = scene.getObjectByName('Outer')!;
    const before = new Vector3();
    innerChild!.getWorldPosition(before);
    outer.position.x += 1;
    scene.updateMatrixWorld();
    const after = new Vector3();
    innerChild!.getWorldPosition(after);
    expect(after.x - before.x).toBeCloseTo(1, 5);
  });
});
