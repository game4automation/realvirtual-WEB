// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-moving-colliders.test.ts — plan-467 test 9.3 (Phase 3).
 *
 * The DISCOVERY and FILTER rules of `RVMovingColliderRegistry` against a mock
 * provider — the decisions that determine which machine parts a physical MU can
 * be pushed by, and which of them would silently be wrong:
 *
 *  - drive subtrees AND mechanism links, the latter including kinematic-group
 *    FOLLOWERS that live outside the link subtree (SOL R1 #8),
 *  - NO mesh-AABB fallback: a part without authored collider extras stays
 *    invisible, exactly like today,
 *  - `enabled:false` / `isTrigger:true` excluded (SOL R1 #10 — trigger volumes
 *    are precisely the things that must not push anything),
 *  - the Unity BoxCollider `center` survives into the shape, scaled and
 *    X-converted (SOL R1 #6),
 *  - zone containment and the `movingColliders:false` authoring switch,
 *  - a node under a drive AND a link is ONE body, attributed to the link,
 *  - a topology rebuild invalidates the link mapping (SOL R1 #9),
 *  - reset frees every body.
 *
 * Runs only in the private build (imports `@rv-private/physics/*`).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Scene, Vector3 } from 'three';
import { RVMovingColliderRegistry } from '@rv-private/physics/rv-moving-collider-registry';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVPhysicsZone } from '../src/core/engine/rv-physics-zone';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type {
  KinematicManagerLike,
  KinematicMechanismHandle,
} from '../src/core/engine/rv-kinematic-registry';
import type {
  PhysicsContactLoad,
  PhysicsPose,
  PhysicsProvider,
  PhysicsShape,
} from '../src/core/engine/rv-physics-registry';

// ─── Mock provider (records what the registry asks for) ─────────────────────

interface AddedBody {
  id: string;
  shape: PhysicsShape;
  pose: { pos: { x: number; y: number; z: number } };
  reportContactForces: boolean;
}

class MockProvider implements PhysicsProvider {
  ready = true;
  failed = false;
  onSensorEvent = null;
  readonly kinematic: AddedBody[] = [];
  readonly statics: string[] = [];
  readonly removed: string[] = [];
  readonly poses: Array<{ id: string; x: number; y: number; z: number }> = [];
  /** Loads `forEachContactLoad` should hand out (Phase 4 fills these for real). */
  loads: PhysicsContactLoad[] = [];

  async init(): Promise<void> {}
  dispose(): void {}
  addZone(): void {}
  addStaticBox(id: string): void { this.statics.push(id); }
  addConveyor(): void {}
  setConveyorVelocity(): void {}
  addDynamicMU(): void {}
  addSensorBox(): void {}
  castRay(): null { return null; }
  step(): void {}
  syncPoses(): void {}
  getSettledBodies(): string[] { return []; }

  addKinematicBody(id: string, shape: PhysicsShape, pose: PhysicsPose, reportContactForces: boolean): void {
    // Snapshot the pose: the registry hands out module-lifetime scratch.
    this.kinematic.push({ id, shape, pose: { pos: { ...pose.pos } }, reportContactForces });
  }
  setKinematicPose(id: string, pose: PhysicsPose): void {
    this.poses.push({ id, x: pose.pos.x, y: pose.pos.y, z: pose.pos.z });
  }
  removeBody(id: string): void { this.removed.push(id); }
  forEachContactLoad(cb: (load: PhysicsContactLoad) => void): void {
    for (const l of this.loads) cb(l);
  }

  byId(id: string): AddedBody | undefined { return this.kinematic.find((b) => b.id === id); }
}

// ─── Scene helpers ──────────────────────────────────────────────────────────

const BOX_1M = { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } };

/** A node with a solid BoxCollider, parented into a scene and world-updated. */
function colliderNode(
  name: string,
  parent: Object3D,
  pos: [number, number, number] = [0, 0, 0],
  box: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } = BOX_1M,
  extra: Record<string, unknown> = {},
): Object3D {
  const node = new Object3D();
  node.name = name;
  node.position.set(...pos);
  node.userData.realvirtual = {
    colliders: [{ type: 'BoxCollider', ...box, enabled: true, isTrigger: false }],
    ...extra,
  };
  parent.add(node);
  parent.updateMatrixWorld(true);
  return node;
}

/** Root scene + a drive whose subtree is the moving candidate source. */
function makeScene(): { scene: Scene; driveNode: Object3D } {
  const scene = new Scene();
  const driveNode = new Object3D();
  driveNode.name = 'Drive';
  scene.add(driveNode);
  return { scene, driveNode };
}

/** A WholeScene-sized zone covering everything the tests build. */
function makeZone(cfgOverrides: Record<string, unknown> = {}): RVPhysicsZone {
  const node = new Object3D();
  node.name = 'Zone';
  node.updateMatrixWorld(true);
  const aabb = AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 200, y: 200, z: 200 });
  const zone = new RVPhysicsZone(node, aabb);
  zone.ShowGizmo = false;
  zone.init({ gizmoManager: undefined } as unknown as ComponentContext);
  if (Object.keys(cfgOverrides).length > 0) {
    const original = zone.toZoneConfig.bind(zone);
    zone.toZoneConfig = () => ({ ...original(), ...cfgOverrides });
  }
  return zone;
}

/** Minimal mechanism handle: links + optional followers per link. */
function makeMechanism(
  links: Object3D[],
  followers: Record<number, Object3D[]> = {},
): KinematicMechanismHandle & { version: number } {
  const handle = {
    node: links[0] ?? new Object3D(),
    version: 1,
    get topologyVersion(): number { return handle.version; },
    forEachOwnedNode(cb: (node: Object3D, linkIndex: number) => void): void {
      const seen = new Set<Object3D>();
      const blockers = new Set(links);
      links.forEach((link, i) => {
        const walk = (n: Object3D): void => {
          if (n !== link && blockers.has(n)) return;
          if (!seen.has(n)) { seen.add(n); cb(n, i); }
          for (const c of n.children) walk(c);
        };
        walk(link);
        for (const f of followers[i] ?? []) {
          const walkF = (n: Object3D): void => {
            if (blockers.has(n)) return;
            if (!seen.has(n)) { seen.add(n); cb(n, i); }
            for (const c of n.children) walkF(c);
          };
          walkF(f);
        }
      });
    },
  };
  return handle;
}

function makeManager(mechanisms: KinematicMechanismHandle[]): KinematicManagerLike & {
  loads: Array<{ linkIndex: number; fx: number; fy: number; fz: number; mx: number; my: number; mz: number }>;
} {
  const loads: Array<{ linkIndex: number; fx: number; fy: number; fz: number; mx: number; my: number; mz: number }> = [];
  return {
    loads,
    register(): void {},
    unregister(): void {},
    get size(): number { return mechanisms.length; },
    listMechanisms: () => mechanisms,
    setExternalLinkLoad(
      _m: KinematicMechanismHandle,
      linkIndex: number,
      fx: number, fy: number, fz: number,
      mx: number, my: number, mz: number,
    ): void {
      loads.push({ linkIndex, fx, fy, fz, mx, my, mz });
    },
  } as unknown as KinematicManagerLike & { loads: typeof loads };
}

let provider: MockProvider;
let registry: RVMovingColliderRegistry;

beforeEach(() => {
  RVPhysicsZone.clearAll();
  provider = new MockProvider();
  registry = new RVMovingColliderRegistry();
});

afterEach(() => {
  registry.dispose(provider);
  RVPhysicsZone.clearAll();
});

// ─── Discovery ──────────────────────────────────────────────────────────────

describe('moving-collider discovery (plan-467 F1)', () => {
  it('registers a collider node under a drive as a kinematic body', () => {
    const { driveNode } = makeScene();
    colliderNode('Pusher', driveNode);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);

    expect(provider.kinematic).toHaveLength(1);
    expect(provider.kinematic[0].id).toContain('Pusher');
    expect(provider.kinematic[0].shape.kind).toBe('cuboid');
    // No link → no contact query: a drive-only part collides but has no link to
    // attribute a payload to (F7).
    expect(provider.kinematic[0].reportContactForces).toBe(false);
  });

  it('registers a collider node owned by a mechanism LINK, with contact reporting on', () => {
    const scene = new Scene();
    const link = new Object3D();
    link.name = 'Arm';
    scene.add(link);
    colliderNode('Jaw', link);
    makeZone();

    const mech = makeMechanism([link]);
    registry.collectMovingSet([], makeManager([mech]));
    registry.build(provider);

    expect(provider.kinematic).toHaveLength(1);
    expect(provider.kinematic[0].reportContactForces).toBe(true);
  });

  it('registers a link FOLLOWER that lives OUTSIDE the link subtree (SOL R1 #8)', () => {
    const scene = new Scene();
    const link = new Object3D();
    link.name = 'Arm';
    const elsewhere = new Object3D();
    elsewhere.name = 'GroupHome';
    scene.add(link, elsewhere);
    const follower = colliderNode('GroupJaw', elsewhere);
    makeZone();

    // The follower is a kinematic-group member: it is moved rigidly by the
    // write-back but is nowhere near the link in the hierarchy.
    const mech = makeMechanism([link], { 0: [follower] });
    registry.collectMovingSet([], makeManager([mech]));
    registry.build(provider);

    expect(provider.kinematic.map((b) => b.id)).toEqual([expect.stringContaining('GroupJaw')]);
    expect(provider.kinematic[0].reportContactForces).toBe(true);
  });

  it('a node under a drive AND a link becomes ONE body, attributed to the LINK', () => {
    const scene = new Scene();
    const link = new Object3D();
    link.name = 'Arm';
    scene.add(link);
    const driveNode = new Object3D();
    driveNode.name = 'Drive';
    link.add(driveNode);
    colliderNode('Jaw', driveNode);
    scene.updateMatrixWorld(true);
    makeZone();

    const mech = makeMechanism([link]);
    registry.collectMovingSet([{ node: driveNode }], makeManager([mech]));
    registry.build(provider);

    expect(provider.kinematic).toHaveLength(1);
    // Attributed to the link — otherwise the part would collide but report no
    // payload, which is exactly the case a gripper on a driven axis is.
    expect(provider.kinematic[0].reportContactForces).toBe(true);
  });

  it('a node WITHOUT collider extras is never registered (no mesh-AABB fallback)', () => {
    const { driveNode } = makeScene();
    const bare = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    bare.name = 'BareMesh';
    driveNode.add(bare);
    // extras present, but no collider entry at all
    const noCollider = new Object3D();
    noCollider.name = 'NoCollider';
    noCollider.userData.realvirtual = { Metadata: {} };
    driveNode.add(noCollider);
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
  });

  it('excludes disabled and trigger colliders (SOL R1 #10)', () => {
    const { driveNode } = makeScene();
    colliderNode('Disabled', driveNode, [0, 0, 0], BOX_1M).userData.realvirtual = {
      colliders: [{ type: 'BoxCollider', ...BOX_1M, enabled: false, isTrigger: false }],
    };
    colliderNode('Trigger', driveNode, [2, 0, 0]).userData.realvirtual = {
      colliders: [{ type: 'BoxCollider', ...BOX_1M, enabled: true, isTrigger: true }],
    };
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
  });

  it('excludes simulation components, invisible nodes and deactivated nodes', () => {
    const { driveNode } = makeScene();
    colliderNode('Surface', driveNode, [0, 0, 0], BOX_1M, { TransportSurface: {} });
    const hidden = colliderNode('Hidden', driveNode, [2, 0, 0]);
    hidden.visible = false;
    colliderNode('Deactivated', driveNode, [4, 0, 0], BOX_1M, { activeSelf: false });
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
  });
});

// ─── Shape ──────────────────────────────────────────────────────────────────

describe('moving-collider shapes (plan-467 F2)', () => {
  it('carries the BoxCollider center into the shape, X-flipped and world-scaled (SOL R1 #6)', () => {
    const { driveNode } = makeScene();
    driveNode.scale.set(2, 2, 2);
    colliderNode('Off', driveNode, [0, 0, 0], {
      center: { x: 1, y: 0.5, z: -0.25 },
      size: { x: 1, y: 2, z: 3 },
    });
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);

    const shape = provider.kinematic[0].shape;
    expect(shape.kind).toBe('cuboid');
    if (shape.kind !== 'cuboid') return;
    // Unity LHS → glTF RHS negates X; the world scale of 2 multiplies both.
    expect(shape.localOffset.x).toBeCloseTo(-2, 6);
    expect(shape.localOffset.y).toBeCloseTo(1, 6);
    expect(shape.localOffset.z).toBeCloseTo(-0.5, 6);
    expect(shape.halfExtents.x).toBeCloseTo(1, 6);   // 1/2 × 2
    expect(shape.halfExtents.y).toBeCloseTo(2, 6);   // 2/2 × 2
    expect(shape.halfExtents.z).toBeCloseTo(3, 6);   // 3/2 × 2
  });

  it('a MeshCollider becomes a convex hull over the node render primitives', () => {
    const { driveNode } = makeScene();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    mesh.name = 'HullPart';
    mesh.userData.realvirtual = {
      colliders: [{ type: 'MeshCollider', convex: true, enabled: true, isTrigger: false }],
    };
    driveNode.add(mesh);
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);

    const shape = provider.kinematic[0].shape;
    expect(shape.kind).toBe('convexHull');
    if (shape.kind !== 'convexHull') return;
    expect(shape.points.length).toBe(24 * 3); // BoxGeometry has 24 vertices
    // Body frame = node world pose without scale; an unscaled unit cube spans ±0.5.
    for (const v of shape.points) expect(Math.abs(v)).toBeLessThanOrEqual(0.501);
  });

  it('a MULTI-MATERIAL MeshCollider (Group + primitive children) is hulled over all primitives', () => {
    const { driveNode } = makeScene();
    const group = new Group();
    group.name = 'MultiMat';
    group.userData.realvirtual = {
      colliders: [{ type: 'MeshCollider', convex: true, enabled: true, isTrigger: false }],
    };
    // GLTFLoader shape: one Mesh child per glTF primitive, no own rv extras.
    const p1 = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    const p2 = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    p2.position.set(2, 0, 0);
    group.add(p1, p2);
    driveNode.add(group);
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);

    const shape = provider.kinematic[0].shape;
    expect(shape.kind).toBe('convexHull');
    if (shape.kind !== 'convexHull') return;
    // Both primitives contributed — without renderPrimitivesOf the Group has no
    // geometry of its own and the part would be skipped entirely (SOL R1 #7).
    expect(shape.points.length).toBe(48 * 3);
    let maxX = -Infinity;
    for (let i = 0; i < shape.points.length; i += 3) maxX = Math.max(maxX, shape.points[i]);
    expect(maxX).toBeGreaterThan(2);
  });

  it('a MeshCollider node with no render geometry at all is skipped', () => {
    const { driveNode } = makeScene();
    const empty = new Object3D();
    empty.name = 'NoGeometry';
    empty.userData.realvirtual = {
      colliders: [{ type: 'MeshCollider', convex: true, enabled: true, isTrigger: false }],
    };
    driveNode.add(empty);
    driveNode.updateMatrixWorld(true);
    makeZone();

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
  });
});

// ─── Zone filter ────────────────────────────────────────────────────────────

describe('moving-collider zone filter (plan-467 F1)', () => {
  it('a part outside every zone is not registered', () => {
    const { driveNode } = makeScene();
    colliderNode('FarAway', driveNode, [1000, 1000, 1000]);
    driveNode.updateMatrixWorld(true);
    makeZone(); // ±100 m

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
  });

  it('movingColliders:false on the zone disables the whole feature there', () => {
    const { driveNode } = makeScene();
    colliderNode('Pusher', driveNode);
    makeZone({ movingColliders: false });

    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(provider.kinematic).toHaveLength(0);
    // …but the node is still in the MOVING set, so the static pass keeps
    // skipping it: "off" must not turn the part into a fixed ghost box.
    expect(registry.movingNodes.size).toBe(1);
  });
});

// ─── Pose push ──────────────────────────────────────────────────────────────

describe('moving-collider pose push (plan-467 F3)', () => {
  it('pushes the CURRENT world pose of every registered part each call', () => {
    const { driveNode } = makeScene();
    const part = colliderNode('Pusher', driveNode);
    makeZone();
    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);

    registry.pushPoses(provider);
    driveNode.position.set(0.5, 0, 0);
    driveNode.updateMatrixWorld(true);
    registry.pushPoses(provider);

    expect(provider.poses).toHaveLength(2);
    expect(provider.poses[0].x).toBeCloseTo(0, 6);
    expect(provider.poses[1].x).toBeCloseTo(0.5, 6);
    void part;
  });

  it('pushes nothing once disposed, and frees every body', () => {
    const { driveNode } = makeScene();
    colliderNode('A', driveNode, [0, 0, 0]);
    colliderNode('B', driveNode, [2, 0, 0]);
    makeZone();
    registry.collectMovingSet([{ node: driveNode }], null);
    registry.build(provider);
    expect(registry.size).toBe(2);

    registry.dispose(provider);
    expect(provider.removed).toHaveLength(2);
    expect(registry.size).toBe(0);
    registry.pushPoses(provider);
    expect(provider.poses).toHaveLength(0);
  });
});

// ─── Topology invalidation ──────────────────────────────────────────────────

describe('moving-collider topology guard (plan-467 F7, SOL R1 #9)', () => {
  it('a rebuild makes the cached link mapping stale — no load is forwarded', () => {
    const scene = new Scene();
    const link = new Object3D();
    link.name = 'Arm';
    scene.add(link);
    colliderNode('Jaw', link);
    makeZone();

    const mech = makeMechanism([link]);
    const manager = makeManager([mech]);
    registry.collectMovingSet([], manager);
    registry.build(provider);

    const bodyId = provider.kinematic[0].id;
    provider.loads = [{ bodyId, fx: 0, fy: -9.81, fz: 0, mx: 0, my: 0, mz: 0 }];

    // Same topology → the load reaches the link, unshifted (the moment is about
    // the world origin on BOTH sides, so nothing is transformed on the way).
    registry.aggregateLoads(provider, manager);
    expect(manager.loads).toEqual([{ linkIndex: 0, fx: 0, fy: -9.81, fz: 0, mx: 0, my: 0, mz: 0 }]);

    // A structural authoring edit reorders the link table.
    manager.loads.length = 0;
    mech.version = 2;
    registry.aggregateLoads(provider, manager);
    // Dropped rather than applied to link 0, which is now a DIFFERENT body.
    expect(manager.loads).toHaveLength(0);
  });

  it('invalidateMechanism frees exactly that mechanism\'s bodies', () => {
    const scene = new Scene();
    const linkA = new Object3D(); linkA.name = 'ArmA';
    const linkB = new Object3D(); linkB.name = 'ArmB';
    linkB.position.set(3, 0, 0);
    scene.add(linkA, linkB);
    colliderNode('JawA', linkA);
    colliderNode('JawB', linkB);
    scene.updateMatrixWorld(true);
    makeZone();

    const mechA = makeMechanism([linkA]);
    const mechB = makeMechanism([linkB]);
    registry.collectMovingSet([], makeManager([mechA, mechB]));
    registry.build(provider);
    expect(registry.size).toBe(2);

    expect(registry.invalidateMechanism(provider, mechA)).toBe(true);
    expect(registry.size).toBe(1);
    expect(provider.removed).toHaveLength(1);
    expect(provider.removed[0]).toContain('JawA');
    // A mechanism with nothing registered reports "nothing to do" rather than
    // triggering a pointless world rebuild.
    expect(registry.invalidateMechanism(provider, mechA)).toBe(false);
  });

  it('a drive-only body never reaches setExternalLinkLoad', () => {
    const { driveNode } = makeScene();
    colliderNode('Pusher', driveNode);
    makeZone();
    const manager = makeManager([]);
    registry.collectMovingSet([{ node: driveNode }], manager);
    registry.build(provider);

    provider.loads = [{ bodyId: provider.kinematic[0].id, fx: 1, fy: 2, fz: 3, mx: 0, my: 0, mz: 0 }];
    registry.aggregateLoads(provider, manager);
    expect(manager.loads).toHaveLength(0);
  });
});
