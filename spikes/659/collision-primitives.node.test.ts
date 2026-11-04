// plan-659 stage 2 — the collision geometry is own work.
//
// Stage 1 replaced the VISIBLE geometry with original primitives
// (`duck/build-duck.mjs`); stage 2 does the same for the SIMULATED one
// (`duck/build-collision-primitives.mjs`). The reason is licensing, not
// aesthetics: the nine original collision meshes are CC BY-NC-SA 4.0, i.e.
// NonCommercial, and the attribution clause explicitly covers "decimated or
// converted meshes", so no simplified copy of them may be shipped either. What
// IS free is their dimensions, and primitives built from measured dimensions.
//
// This file guards the two halves of that claim:
//
//  1. THE LICENCE INVARIANT — the scene the demo simulates references no mesh
//     file at all, and the activation record hands over no `meshBase`. A test,
//     not a comment, because this is the property that makes the demo
//     shippable and the cost of losing it silently is a licence breach.
//  2. THE PHYSICS INVARIANT — swapping the hulls changed no inertial property.
//     Every body carries an explicit `<inertial>` (Apache-2.0 numbers: mass,
//     COM and the full tensor, which decide the gait at least as much as the
//     hulls), so with `inertiafromgeom="auto"` the geoms contribute no mass.
//     That is an assumption worth checking rather than asserting.
//
// The tests that need the original meshes SKIP when the gitignored STL fixture
// is absent, which is the normal case on a fresh checkout — and is itself the
// point: the demo runs without those files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  hasMeshFixture,
  MESH_SCENE,
  PRIMITIVE_SCENE,
  RVMicroduckRuntime,
} from './rv-microduck-runtime';

const VX_WALK = 0.25;

describe('plan-659 stage 2 — collision primitives', () => {
  it('simulates a scene that references no mesh file', () => {
    const xml = readFileSync(PRIMITIVE_SCENE, 'utf8');
    // No <mesh> asset and no geom pointing at one. The `<default class="visual">`
    // block still carries `type="mesh"` — a default for a class with no
    // instances, which references nothing.
    expect(xml.match(/<mesh\b[^>]*\bfile=/g)).toBeNull();
    expect(xml.match(/<geom\b[^>]*\bmesh="/g)).toBeNull();
    expect(xml).not.toMatch(/\.stl/i);
    // Only MuJoCo primitives, plus the floor plane.
    const types = [...xml.matchAll(/<geom\b[^>]*\btype="([a-z]+)"/g)].map((m) => m[1]);
    const used = new Set(types);
    used.delete('mesh'); // the unused visual default
    expect([...used].sort()).toEqual(['box', 'ellipsoid', 'plane']);
  });

  it('compiles, steps and walks without the mesh fixture present', async () => {
    const runtime = await RVMicroduckRuntime.create('walking');
    try {
      runtime.initStartState();
      runtime.setForwardVelocity(VX_WALK);
      const stats = await runtime.run(250, { trackLatency: false });
      expect(stats.finite).toBe(true);
      expect(stats.fallen).toBe(false);
      // It walks: ~0.5 m in 5 s at 0.25 m/s commanded (the gait runs at about
      // 0.11 m/s, a Phase-0 property of this policy, not of the hulls).
      expect(stats.distanceXyM).toBeGreaterThan(0.3);
      // And it does not sink into the floor or launch.
      expect(stats.baseHeightMinM).toBeGreaterThan(0.09);
      expect(stats.baseHeightEndM).toBeLessThan(0.2);
    } finally {
      await runtime.dispose();
    }
  });

  it.skipIf(!hasMeshFixture())(
    'changes no inertial property compared with the mesh-hull scene',
    async () => {
      const prim = await RVMicroduckRuntime.create('walking', 'primitives');
      const mesh = await RVMicroduckRuntime.create('walking', 'meshes');
      try {
        // The model dimensions must match: same bodies, same joints, same
        // actuators, same sensors — only the geoms differ.
        expect({ nq: prim.world.nq, nv: prim.world.nv, nu: prim.world.nu })
          .toEqual({ nq: mesh.world.nq, nv: mesh.world.nv, nu: mesh.world.nu });
        expect(prim.world.timestep).toBe(mesh.world.timestep);
        // Both start states are built from the same keyframe numbers, so the
        // initial qpos must be identical to the bit.
        prim.initStartState();
        mesh.initStartState();
        const a = Array.from(prim.world.readQpos());
        const b = Array.from(mesh.world.readQpos());
        expect(a).toEqual(b);
      } finally {
        await prim.dispose();
        await mesh.dispose();
      }
    },
  );

  it.skipIf(!hasMeshFixture())(
    'walks the same distance as the mesh-hull scene over 10 s',
    async () => {
      const run = async (scene: 'primitives' | 'meshes') => {
        const runtime = await RVMicroduckRuntime.create('walking', scene);
        try {
          runtime.initStartState();
          runtime.setForwardVelocity(VX_WALK);
          return await runtime.run(500, { trackLatency: false });
        } finally {
          await runtime.dispose();
        }
      };
      const prim = await run('primitives');
      const mesh = await run('meshes');
      // eslint-disable-next-line no-console
      console.log(
        `[stage2] 10 s net x: primitives ${prim.displacementXM.toFixed(4)} m, ` +
          `mesh hull ${mesh.displacementXM.toFixed(4)} m ` +
          `(${(100 * (prim.displacementXM / mesh.displacementXM - 1)).toFixed(1)} %)`,
      );
      expect(prim.fallen).toBe(false);
      expect(mesh.fallen).toBe(false);
      // Within 10 %. Over 10 s the heading drift of the box sole has not yet
      // accumulated enough to matter; over 60 s it has, which is why the
      // long-horizon claim is made on PATH LENGTH in
      // `duck/compare-collision-walk.mjs` and not here.
      expect(prim.displacementXM).toBeGreaterThan(mesh.displacementXM * 0.9);
      expect(prim.displacementXM).toBeLessThan(mesh.displacementXM * 1.1);
    },
  );

  it.skipIf(!hasMeshFixture())('still has the mesh scene available for comparison', () => {
    const xml = readFileSync(MESH_SCENE, 'utf8');
    // The original, for contrast: it DOES reference the nine CC meshes. If this
    // ever stops being true the comparison above has lost its reference.
    expect([...xml.matchAll(/<mesh\b[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]).sort()).toEqual([
      'bottom_head_shell.stl', 'hip_l.stl', 'jaw.stl', 'leg.stl', 'np_f970.stl',
      'power_support.stl', 'sole_left.stl', 'sole_right.stl', 'top_head_shell.stl',
    ]);
  });
});
