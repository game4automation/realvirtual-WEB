// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mujoco-obstacle-visuals.node.test.ts — the obstacle field has to be VISIBLE in
 * motion, not merely present in the solver (plan-673, 2026-10-25).
 *
 * ## The defect this exists for
 *
 * Thomas: *"Der Walker kollidiert nicht mehr mit den Würfeln — er läuft durch sie
 * hindurch."* He was describing the screen, and the screen was right. The physics
 * was never broken. Measured in the PRODUCTION build (`npm run build` +
 * `vite preview`, `?doc=doc_mujocowalker_15i4u8p`):
 *
 *   runtime.obstacles.length      34
 *   robot/obstacle contact pairs  5  (obs_cube_s1, obs_ball_a, obs_ball_d,
 *                                     obs_ball_f, obs_ball_r0 — all `<-robot`)
 *   obs_cube_s1 pushed            [1, -0.04, 0.0249] -> [1.0712, -0.0655, 0.0249]
 *                                 = 75.6 mm
 *   runtime.obstacleVisualCount   0
 *   obstacle node transforms      unchanged, every one, for the whole run
 *
 * The walker shoved a cube 75.6 mm and the drawn cube never moved. There is no
 * other way to read that on screen than "it walks through them".
 *
 * The cause was the seam the mirror was bound through: `syncObstacleVisuals()`
 * looks the scene up via `window.__rvViewer`, and `main.ts` sets that global
 * inside `if (import.meta.env.DEV)`. So the obstacles moved under `npm run dev`
 * and could not move in ANY built bundle — `vite preview`, the /demo deploy, a
 * customer delivery. It had been that way since the obstacle field was
 * introduced (`52485c7`), through the components rework (`5e7feab`) which kept
 * the same lookup, which is why "it worked before" and "it is broken now" are
 * both true: dev before, production now.
 *
 * ## Why the existing coverage did not catch it, twice
 *
 * `spikes/659/obstacle-field.node.test.ts` walks the real policy for 60 s and
 * asserts contacts and `obstacleStates().movedM`. All of that was GREEN while the
 * demo was visibly broken, because every one of those numbers comes out of the
 * solver. A test that reads the solver cannot see a frozen scene, and a test that
 * only asserts the robot "runs" sees even less — that is the trap Thomas named.
 * So this file asserts the two things the solver cannot tell us:
 *
 *  1. a scene NODE moves when the physics moves its body, and
 *  2. the plugin — the component that owns the viewer — is what hands the scene
 *     over, so the binding does not depend on a dev-only global.
 *
 * (1) is a behaviour test over the real mirror; (2) is a source contract, because
 * the wiring is the thing that broke and no cheap runtime fixture reproduces a
 * plugin activation (it needs the WASM solver, a viewer and a GLB).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Group, Object3D, Quaternion } from 'three';
import { describe, expect, it } from 'vitest';
import { RVMuJoCoFreeBodyMirror } from '@rv-private/mujoco/rv-mujoco-joint-mirror';

const WEB_ROOT = resolve(__dirname, '..');
const PRIVATE_ROOT = resolve(WEB_ROOT, '../realvirtual-WebViewer-Private~');
const read = (p: string): string => readFileSync(resolve(PRIVATE_ROOT, p), 'utf8');

/** A node as the walker GLB authors an obstacle: name, local pose, components. */
function obstacleNode(name: string, pos: readonly [number, number, number]): Object3D {
  const n = new Group();
  n.name = name;
  n.position.set(pos[0], pos[1], pos[2]);
  n.userData.realvirtual = {
    CollisionShapeSet: { Shapes: [{ Kind: 'box', Center: [0, 0, 0], Size: [25, 25, 25] }], ReplacesMesh: true },
    FreeBody: { Enabled: true, MassKg: 0.1, CondDim: 'Sliding', FrictionSlide: 1 },
    Movable: { Enabled: true },
  };
  return n;
}

// ── 1. the mirror moves the scene ───────────────────────────────────────────

describe('obstacle visuals — a qpos change reaches the scene node', () => {
  it('binds the free obstacles, skips the welded one and the robot base, and writes the pose', () => {
    // The walker's shape: an asset root, a container with no component of its
    // own (the bake drops it, which is why the mirror walks the whole subtree),
    // the robot's floating base and three obstacles.
    const root = new Group();
    root.name = 'rv_duck';
    const base = new Group();
    base.name = 'trunk_base';
    // The base is a FreeBody too since plan-673 O13 — and it must NOT be taken
    // for an obstacle: `RVMuJoCoJointMirror` owns it through `rv_free_joint`.
    base.userData.realvirtual = { FreeBody: { Enabled: true, MassKg: 0.2 } };
    base.userData.rv_free_joint = { name: 'trunk_base_freejoint' };
    const container = new Group();
    container.name = 'rv_obstacles';
    const cube = obstacleNode('obs_cube_s1', [1, -0.04, 0.025]);
    const ball = obstacleNode('obs_ball_a', [0.55, 0, 0.035]);
    const post = obstacleNode('obs_post_e', [3.4, 0, 0.12]);
    // A welded obstacle has no free joint and therefore no qpos to mirror.
    (post.userData.realvirtual as { FreeBody: Record<string, unknown> }).FreeBody.Enabled = false;
    container.add(cube, ball, post);
    root.add(base, container);

    // qpos as the spliced worldbody lays it out: the robot's 21 addresses first,
    // then 7 per movable obstacle, in body order (the invariant the splice owns).
    const adr: Record<string, number> = { obs_cube_s1: 21, obs_ball_a: 28 };
    const mirror = RVMuJoCoFreeBodyMirror.fromObject3D(root, (name) => adr[name]);

    expect(mirror.bodies.map((b) => b.name)).toEqual(['obs_cube_s1', 'obs_ball_a']);
    // Nothing unexplained: the base is owned elsewhere and the post is welded,
    // so neither is an obstacle that "could not be bound".
    expect(mirror.skipped).toEqual([]);

    const qpos = new Float64Array(42);
    // The cube, shoved 75.6 mm in +x and rotated a quarter turn about Z — the
    // measured displacement of the production run quoted in the header.
    qpos.set([1.0756, -0.0655, 0.0249, Math.SQRT1_2, 0, 0, Math.SQRT1_2], 21);
    qpos.set([0.61, 0.12, 0.035, 1, 0, 0, 0], 28);
    mirror.apply(qpos);

    expect(cube.position.toArray()).toEqual([1.0756, -0.0655, 0.0249]);
    // MuJoCo writes w,x,y,z and three.js stores x,y,z,w — a mirror that got this
    // wrong would tilt every obstacle instead of turning it.
    expect(cube.quaternion.angleTo(new Quaternion(0, 0, Math.SQRT1_2, Math.SQRT1_2))).toBeLessThan(1e-9);
    expect(ball.position.toArray()).toEqual([0.61, 0.12, 0.035]);
    // Untouched, because it has no qpos — not reset to the origin.
    expect(post.position.toArray()).toEqual([3.4, 0, 0.12]);
  });

  it('reports an obstacle whose node is missing instead of mirroring nothing in silence', () => {
    const root = new Group();
    root.add(obstacleNode('obs_cube_s1', [1, 0, 0.025]));
    const mirror = RVMuJoCoFreeBodyMirror.fromObject3D(root, () => undefined);
    expect(mirror.bodies).toEqual([]);
    expect(mirror.skipped.map((s) => s.node)).toEqual(['obs_cube_s1']);
  });
});

// ── 2. the plugin is what hands the scene over ──────────────────────────────

describe('obstacle visuals — the binding does not depend on a dev-only global', () => {
  const plugin = read('src/mujoco/rv-mujoco-plugin.ts');
  const runtime = read('src/mujoco/rv-mujoco-locomotion-runtime.ts');

  it('the plugin binds the visuals from the viewer scene it owns', () => {
    // The one line whose absence was the whole defect. The plugin HAS the
    // viewer; it must not leave the binding to the runtime's fallback probe.
    expect(plugin).toMatch(/attachObstacleVisuals\(\s*scene\s*\)/);
    expect(plugin).toMatch(/const scene = this\.viewer\?\.scene/);
  });

  it('`window.__rvViewer` stays the fallback of the spikes only', () => {
    // Still in the runtime, inside the bounded probe — the headless spikes have
    // no plugin and need it.
    expect(runtime).toMatch(/__rvViewer/);
    // And the plugin must never READ it. Named in its comments it may be (the
    // comment is where the defect is explained), so the check is per line and
    // skips comments rather than banning the word.
    const reads = plugin.split('\n')
      .filter((l) => l.includes('__rvViewer'))
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    expect(reads).toEqual([]);
  });

  it('obstacles in the physics with no bound node are reported', () => {
    // `obstacleVisualCount` 0 next to 34 obstacles was readable in the console of
    // the broken build only because we went looking. Now it says so by itself.
    expect(plugin).toMatch(/collide invisibly/);
  });

  it('the viewer-global rule is owned by the dev-only-globals guard', () => {
    // This case used to pin the OPPOSITE: that `main.ts` assigns `__rvViewer`
    // somewhere below an `import.meta.env.DEV` gate, "so the next reader learns
    // that the fallback would start working in production". That gate was the
    // trap and not the safeguard — the official-sounding of the two viewer
    // globals was the one that silently did not exist in a build — and it was
    // removed hours later on 2026-10-25: `__rvViewer` is now a plain alias of
    // `window.viewer`, published in every build, proven identical in a
    // `vite preview` of a production bundle.
    //
    // Worth keeping the failure in mind: the old assertion did not go stale, it
    // stayed GREEN while asserting something false. It searched the text BEFORE
    // the first `__rvViewer` occurrence for a DEV gate, and after the change
    // that first occurrence is the comment explaining the removal, with DEV
    // branches aplenty above it. An assertion over raw source sees prose.
    //
    // So the contract is not re-pinned by text here. It is owned by guard (c)
    // of tests/dev-only-globals.node.test.ts, which works on the AST: it
    // asserts the ungated alias and bans every `src/` read of either viewer
    // global, with this runtime's bounded fallback as the one listed exemption.
    // This case asserts only that the owner exists and still names it.
    const guard = readFileSync(resolve(WEB_ROOT, 'tests/dev-only-globals.node.test.ts'), 'utf8');
    expect(guard).toContain('VIEWER_GLOBAL_READERS');
    expect(guard).toContain('src/mujoco/rv-mujoco-locomotion-runtime.ts');
  });
});
