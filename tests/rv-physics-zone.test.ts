// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-zone.test.ts — plan-276 test 9.2 (Phase 2 scope).
 *
 * Zone component: extras parsing, BoxCollider → AABB, WholeScene, F2
 * first-wins overlap rule, surface containment helpers, the Phase-4
 * `isPhysicsManaged` AND-gate and raw StaticColliders storage. The
 * handover/plugin wiring lives in rv-physics-handover/-surface.test.ts.
 *
 * Also smoke-loads the programmatic E2E fixture
 * `../realvirtual-WebViewer-Private~/projects/Development/fixtures/physics-zone-test.glb` (scripts/build-physics-test-glb.mjs).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Box3, Object3D, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVPhysicsZone, parseStaticColliderPaths } from '../src/core/engine/rv-physics-zone';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import {
  applySchema,
  getRegisteredFactories,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import type { PhysicsAABB } from '../src/core/engine/rv-physics-registry';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

// plan-395: everything in `DEV_GLB` lives in the private Development project
// and is absent from a public checkout. The suites below must then report
// `skipped` rather than `passed` - a probe-and-return would leave this file
// green while it checked nothing. The probe tests the CONTENT TYPE, not
// `res.ok`: without the private sibling nothing claims `/private-assets/`, so
// the dev server answers it with the SPA fallback, a 200 text/html.
const DEV_ASSETS = await devAssetAvailable(DEV_GLB.physicsZone);

// ─── Helpers (factory-driven construction, mirrors the scene loader) ────────

function zoneFactory() {
  const f = getRegisteredFactories().get('WebPhysicsZone');
  if (!f) throw new Error('WebPhysicsZone factory not registered');
  return f;
}

function makeCtx(): ComponentContext {
  // RVPhysicsZone.init only touches ctx.gizmoManager (optional).
  return { gizmoManager: undefined } as unknown as ComponentContext;
}

interface BuildOptions {
  name?: string;
  position?: [number, number, number];
  extras?: Record<string, unknown>;
  /** BoxCollider extras; null/omitted → degenerate loader AABB (empty node). */
  boxCollider?: { center: { x: number; y: number; z: number }; size: { x: number; y: number; z: number } } | null;
  init?: boolean;
}

/** Build a zone exactly like the loader does: create → beforeSchema →
 *  applySchema → init (createAABBFromExtras ≙ fromBoxCollider/fromNode). */
function buildZone(opts: BuildOptions = {}): RVPhysicsZone {
  const node = new Object3D();
  node.name = opts.name ?? 'Zone';
  if (opts.position) node.position.set(...opts.position);
  node.updateMatrixWorld(true);

  const aabb = opts.boxCollider
    ? AABB.fromBoxCollider(node, opts.boxCollider.center, opts.boxCollider.size)
    : AABB.fromNode(node); // meshless empty → degenerate (loader's last resort)

  const f = zoneFactory();
  const extras = opts.extras ?? {};
  const zone = f.create(node, aabb) as RVPhysicsZone;
  f.beforeSchema?.(zone, extras);
  applySchema(zone as unknown as Record<string, unknown>, f.schema, extras);
  if (opts.init !== false) zone.init(makeCtx());
  return zone;
}

/** Structural world-space AABB probe. */
function probe(min: [number, number, number], max: [number, number, number]): PhysicsAABB {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
  };
}

beforeEach(() => {
  RVPhysicsZone.clearAll();
});

afterEach(() => {
  RVPhysicsZone.clearAll();
  vi.restoreAllMocks();
});

// ─── Tests (plan-276 §9.2) ──────────────────────────────────────────────────

describe('RVPhysicsZone', () => {
  it('parses BoxCollider extras into the zone AABB and applies schema defaults', () => {
    const zone = buildZone({
      position: [1, 2, 3],
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 1, z: 4 } },
      extras: {}, // all defaults
    });

    // Defensive defaults (rv-odt.json)
    expect(zone.ZoneEnabled).toBe(true);
    expect(zone.WholeScene).toBe(false);
    expect(zone.Friction).toBeCloseTo(0.8);
    expect(zone.Restitution).toBe(0);
    expect(zone.RemoveBelowY).toBe(-10);
    expect(zone.ShowGizmo).toBe(true);
    expect(zone.StaticColliders).toEqual([]);

    // World AABB = node position ± size/2
    const aabb = zone.worldAabb;
    expect(aabb).not.toBeNull();
    expect(aabb!.min.x).toBeCloseTo(0);
    expect(aabb!.min.y).toBeCloseTo(1.5);
    expect(aabb!.min.z).toBeCloseTo(1);
    expect(aabb!.max.x).toBeCloseTo(2);
    expect(aabb!.max.y).toBeCloseTo(2.5);
    expect(aabb!.max.z).toBeCloseTo(5);

    expect(zone.active).toBe(true);
    expect(RVPhysicsZone.zones).toHaveLength(1);

    // Explicit extras override the defaults
    const zone2 = buildZone({
      name: 'Zone2',
      position: [10, 0, 0],
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      extras: { ZoneEnabled: false, Friction: 0.3, Restitution: 0.5, RemoveBelowY: -2, ShowGizmo: false },
    });
    expect(zone2.ZoneEnabled).toBe(false);
    expect(zone2.Friction).toBeCloseTo(0.3);
    expect(zone2.Restitution).toBeCloseTo(0.5);
    expect(zone2.RemoveBelowY).toBe(-2);
    expect(zone2.ShowGizmo).toBe(false);
    expect(zone2.toZoneConfig()).toEqual({ friction: 0.3, restitution: 0.5, removeBelowY: -2 });
  });

  it('zone without BoxCollider extras (and WholeScene=false) is ignored with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zone = buildZone({ name: 'NoVolume' }); // degenerate AABB, WholeScene=false

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NoVolume.*no BoxCollider/));
    expect(zone.active).toBe(false);
    expect(zone.worldAabb).toBeNull();
    expect(RVPhysicsZone.zones).toHaveLength(0); // never registered (§5.4)
    expect(RVPhysicsZone.findZoneOverlapping(probe([-100, -100, -100], [100, 100, 100]))).toBeNull();
  });

  it('WholeScene zone takes the scene bounding box via applySceneBounds', () => {
    const zone = buildZone({ name: 'SceneZone', extras: { WholeScene: true } }); // no box volume

    // Registered (holds its F2 slot) but not yet effective — bounds unknown.
    expect(RVPhysicsZone.zones).toHaveLength(1);
    expect(zone.active).toBe(false);
    expect(zone.worldAabb).toBeNull();
    expect(RVPhysicsZone.findZoneOverlapping(probe([0, 0, 0], [1, 1, 1]))).toBeNull();

    // Phase-3 idiom: LoadResult.boundingBox (a THREE.Box3) is structurally a PhysicsAABB.
    const sceneBox = new Box3(new Vector3(-5, 0, -5), new Vector3(5, 3, 5));
    zone.applySceneBounds(sceneBox);

    expect(zone.active).toBe(true);
    expect(zone.worldAabb).toEqual({ min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 3, z: 5 } });
    expect(RVPhysicsZone.findZoneOverlapping(probe([0, 0, 0], [1, 1, 1]))).toBe(zone);

    // Snapshot semantics: mutating the caller's Box3 must not move the zone.
    sceneBox.max.y = 999;
    expect(zone.worldAabb!.max.y).toBe(3);

    // Non-WholeScene zones refuse scene bounds.
    const boxZone = buildZone({
      name: 'BoxZone',
      position: [20, 0, 0],
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
    });
    boxZone.applySceneBounds(sceneBox);
    expect(boxZone.worldAabb!.max.x).toBeCloseTo(20.5);
  });

  it('overlapping zones: the first registered zone wins, configs are never mixed (F2)', () => {
    const zoneA = buildZone({
      name: 'ZoneA',
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } },
      extras: { Friction: 0.2 },
    });
    const zoneB = buildZone({
      name: 'ZoneB',
      position: [0.5, 0, 0], // overlaps ZoneA, extends to x = 2.5
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 2, z: 2 } },
      extras: { Friction: 0.9 },
    });

    expect(RVPhysicsZone.zones).toEqual([zoneA, zoneB]); // registration order

    // Probe inside BOTH volumes → first registered wins, deterministically.
    const inBoth = probe([-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]);
    expect(RVPhysicsZone.findZoneOverlapping(inBoth)).toBe(zoneA);

    // Configs never mixed: each zone keeps its own values.
    expect(zoneA.toZoneConfig().friction).toBeCloseTo(0.2);
    expect(zoneB.toZoneConfig().friction).toBeCloseTo(0.9);

    // Probe only inside ZoneB → ZoneB wins.
    const onlyB = probe([1.8, -0.1, -0.1], [2.2, 0.1, 0.1]);
    expect(RVPhysicsZone.findZoneOverlapping(onlyB)).toBe(zoneB);
  });

  it('disabled zone (ZoneEnabled=false) never wins an overlap query', () => {
    const disabled = buildZone({
      name: 'Disabled',
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } },
      extras: { ZoneEnabled: false },
    });
    const enabled = buildZone({
      name: 'Enabled',
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } },
    });

    expect(disabled.active).toBe(false);
    const inside = probe([-0.1, -0.1, -0.1], [0.1, 0.1, 0.1]);
    // Registered first, but disabled — the later ENABLED zone wins.
    expect(RVPhysicsZone.findZoneOverlapping(inside)).toBe(enabled);
  });

  it('surface AABB fully inside the zone → containsAABB (physics-managed candidate, §2.4)', () => {
    // Surface PhysicsMode itself is Phase 4 — here only the static zone-side
    // containment contract is verified.
    const zone = buildZone({
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 2, z: 4 } },
    });

    const surfaceInside = probe([-1, -0.5, -1], [1, -0.3, 1]);
    expect(zone.containsAABB(surfaceInside)).toBe(true);
    expect(zone.overlapsAABB(surfaceInside)).toBe(true);
    expect(RVPhysicsZone.findZoneOverlapping(surfaceInside)).toBe(zone);
  });

  it('surface AABB partially overlapping the zone → NOT contained (stays kinematic), overlap still detected', () => {
    const zone = buildZone({
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 2, z: 4 } },
    });

    // Half inside, half outside (+x) — belts are never cut (§2.4).
    const partial = probe([1, -0.5, -1], [3, -0.3, 1]);
    expect(zone.containsAABB(partial)).toBe(false);
    expect(zone.overlapsAABB(partial)).toBe(true); // F4: overlap ≠ containment
    expect(RVPhysicsZone.findZoneOverlapping(partial)).toBe(zone);

    // Fully outside → neither.
    const outside = probe([5, 0, 5], [6, 1, 6]);
    expect(zone.containsAABB(outside)).toBe(false);
    expect(zone.overlapsAABB(outside)).toBe(false);
    expect(RVPhysicsZone.findZoneOverlapping(outside)).toBeNull();
  });

  it('effective mode = PhysicsMode && physicsDefault && inZone (AND, Phase 4)', () => {
    const zone = buildZone({
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 4, y: 4, z: 4 } },
    });

    const node = new Object3D();
    node.updateMatrixWorld(true);
    const surface = new RVTransportSurface(
      node,
      AABB.fromBoxCollider(node, { x: 0, y: 0, z: 0 }, { x: 2, y: 0.2, z: 1 }),
    );

    try {
      // Default: PhysicsMode false → not managed even inside the zone.
      expect(surface.PhysicsMode).toBe(false);
      expect(RVTransportSurface.physicsDefault).toBe(true);
      expect(surface.isPhysicsManaged(zone)).toBe(false);

      // All three conditions true → managed.
      surface.PhysicsMode = true;
      expect(surface.isPhysicsManaged(zone)).toBe(true);

      // Deployment kill-switch off → not managed (settings.json
      // simulation.physicsSurfaceDefault, accumulateDefault pattern).
      RVTransportSurface.physicsDefault = false;
      expect(surface.isPhysicsManaged(zone)).toBe(false);
      RVTransportSurface.physicsDefault = true;

      // Containment is FULL containment, not overlap: shift the surface so it
      // only partially reaches the zone (belts are never cut, §2.4).
      node.position.set(1.5, 0, 0); // surface x ∈ [0.5, 2.5], zone x ∈ [-2, 2]
      node.updateMatrixWorld(true);
      surface.updateAABB();
      expect(zone.overlapsAABB(surface.aabb)).toBe(true);
      expect(surface.isPhysicsManaged(zone)).toBe(false);
    } finally {
      RVTransportSurface.physicsDefault = true;
    }
  });

  it('StaticColliders paths are stored RAW (defensive parsing, no resolution)', () => {
    const zone = buildZone({
      boxCollider: { center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } },
      extras: {
        StaticColliders: [
          'Container/WallLeft',
          // Catch-all export may serialize GameObject refs as ComponentReference
          { type: 'ComponentReference', path: 'Container/WallRight', componentType: 'GameObject' },
          42,          // dropped (defensive)
          '',          // dropped (empty)
          null,        // dropped
        ],
      },
    });

    // Raw path strings only — resolution via registry.getNode(path) is Phase 3 (F8).
    expect(zone.StaticColliders).toEqual(['Container/WallLeft', 'Container/WallRight']);

    // Parser unit checks
    expect(parseStaticColliderPaths(undefined)).toEqual([]);
    expect(parseStaticColliderPaths('not-an-array')).toEqual([]);
    expect(parseStaticColliderPaths([{ nopath: true }])).toEqual([]);
  });
});

// ─── E2E fixture smoke test (scripts/build-physics-test-glb.mjs) ────────────

describe.skipIf(!DEV_ASSETS)('physics-zone-test.glb fixture', () => {
  function getPath(node: Object3D): string {
    const parts: string[] = [];
    let current: Object3D | null = node;
    while (current && current.parent) {
      parts.unshift(current.name);
      current = current.parent;
    }
    return parts.join('/');
  }

  it('loads and carries zone + conveyor + container extras', async () => {
    const head = await fetch(DEV_GLB.physicsZone, { method: 'HEAD' });
    if (!head.ok) {
      throw new Error(
        'physics-zone-test.glb missing — run: node scripts/build-physics-test-glb.mjs',
      );
    }

    const gltf = await new GLTFLoader().loadAsync(DEV_GLB.physicsZone);

    const byPath = new Map<string, Record<string, Record<string, unknown>>>();
    gltf.scene.traverse((node: Object3D) => {
      const rv = node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
      if (rv) byPath.set(getPath(node), rv);
    });

    // Zone node: WebPhysicsZone + BoxCollider extras
    const zoneRv = byPath.get('PhysicsZone');
    expect(zoneRv, 'PhysicsZone node with rv extras').toBeDefined();
    const zoneData = zoneRv!['WebPhysicsZone'] as Record<string, unknown>;
    expect(zoneData).toBeDefined();
    expect(zoneData['ZoneEnabled']).toBe(true);
    expect(zoneData['Friction']).toBeCloseTo(0.8);
    expect(zoneRv!['BoxCollider']).toBeDefined();

    // Conveyor: TransportSurface + Drive + BoxCollider (2 x 0.1 x 0.4 m)
    const conveyorRv = byPath.get('Conveyor');
    expect(conveyorRv?.['TransportSurface']).toBeDefined();
    expect(conveyorRv?.['Drive']).toBeDefined();
    expect(conveyorRv?.['BoxCollider']).toBeDefined();

    // Every StaticColliders path resolves to a real node with BoxCollider extras
    const wallPaths = zoneData['StaticColliders'] as string[];
    expect(wallPaths).toHaveLength(4);
    for (const path of wallPaths) {
      const wallRv = byPath.get(path);
      expect(wallRv, `StaticColliders path "${path}" must exist in the GLB`).toBeDefined();
      expect(wallRv!['BoxCollider'], `wall "${path}" needs BoxCollider extras`).toBeDefined();
    }

    // Source for the Phase-3 E2E (MU prototype on the belt start)
    expect(byPath.get('PartSource')?.['Source']).toBeDefined();
  }, 15000);

  it('zone volume built from the fixture covers the conveyor end (handover area)', async () => {
    const gltf = await new GLTFLoader().loadAsync(DEV_GLB.physicsZone);

    let zoneNode: Object3D | null = null;
    gltf.scene.traverse((node: Object3D) => {
      if (node.userData?.realvirtual?.WebPhysicsZone) zoneNode = node;
    });
    expect(zoneNode).not.toBeNull();

    const rv = (zoneNode as unknown as Object3D).userData.realvirtual as Record<string, Record<string, unknown>>;
    const bc = rv['BoxCollider'] as {
      center: { x: number; y: number; z: number };
      size: { x: number; y: number; z: number };
    };
    (zoneNode as unknown as Object3D).updateMatrixWorld(true);
    const aabb = AABB.fromBoxCollider(zoneNode as unknown as Object3D, bc.center, bc.size);

    const f = zoneFactory();
    const zone = f.create(zoneNode as unknown as Object3D, aabb) as RVPhysicsZone;
    f.beforeSchema?.(zone, rv['WebPhysicsZone']);
    applySchema(zone as unknown as Record<string, unknown>, f.schema, rv['WebPhysicsZone']);
    zone.init(makeCtx());

    expect(zone.active).toBe(true);
    // MU-sized probe at the conveyor end (belt top y=0.5, end z=0) → overlap (F4).
    const muAtBeltEnd = probe([-0.075, 0.5, -0.075], [0.075, 0.65, 0.075]);
    expect(zone.overlapsAABB(muAtBeltEnd)).toBe(true);
    expect(RVPhysicsZone.findZoneOverlapping(muAtBeltEnd)).toBe(zone);
    // Probe at the belt START (z=-1.8) stays outside the zone (kinematic area).
    const muAtBeltStart = probe([-0.075, 0.5, -1.875], [0.075, 0.65, -1.725]);
    expect(zone.overlapsAABB(muAtBeltStart)).toBe(false);
  }, 15000);
});
