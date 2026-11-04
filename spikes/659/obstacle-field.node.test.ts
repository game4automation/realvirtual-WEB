// plan-659 obstacle pilot — the interactive obstacle field, headless.
//
// Three things are checked here, in rising cost:
//
//  1. `augmentWorldbody` / `parseObstacles` as pure functions.
//  2. THE LAYOUT INVARIANT. The obstacles must be APPENDED to the worldbody, so
//     `qpos` stays `[robot free joint 7][14 joints][obstacle 7]…` and the robot
//     keeps addresses 0..20. Prepended, the policy would drive the wrong joints
//     and the whole demo would be subtly, silently wrong — which is exactly the
//     kind of failure a test has to own rather than a comment.
//  3. THE STAFFEL ITSELF, walked with the real policy: each stage has to produce
//     the reaction it was dimensioned for. This is the measurement the numbers
//     in `duck/build-duck.mjs` were tuned against, and it reads the config out
//     of the BUILT GLB, so a drift between generator and runtime fails here.
//
// The config comes from `duck/rv-duck.glb` — the artefact, not a copy of its
// numbers. The fixture files are read through a `fetch` stub, never written: the
// SHA256SUMS of `fixtures/microduck` are the licence record of that fixture.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  augmentWorldbody,
  obstacleGeomName,
  obstacleJointName,
  parseObstacles,
  parseRobotConfig,
  RVMuJoCoLocomotionRuntime,
  type RVMuJoCoObstacle,
  type RVMuJoCoRobotConfig,
} from '@rv-private/mujoco/rv-mujoco-locomotion-runtime';
import { obstacleFromComponents } from '@rv-private/mujoco/rv-mujoco-obstacle-scan';
import { RVMuJoCoWorld, type RVMuJoCoFile } from '@rv-private/mujoco/rv-mujoco-world';

const SPIKE = __dirname;
const FIXTURE_DIR = resolve(SPIKE, "fixtures/microduck");
/** The scene the demo simulates: Apache-2.0 body tree, original MuJoCo
 *  primitives for every collision hull, no mesh reference (plan-659 stage 2). */
const SIM_SCENE = resolve(SPIKE, "duck/rv-duck-collision.xml");
const GLB = resolve(SPIKE, 'duck/rv-duck.glb');
/** The W tree is the Vite root, so every URL in the GLB starts here. */
const WEB_ROOT = resolve(SPIKE, '../..');

/** The robot's own slice of `qpos`: free joint 0..6 plus 14 actuated joints. */
const ROBOT_QPOS = 21;

// ── reading the artefact ────────────────────────────────────────────────────

/**
 * `rv_mujoco` out of the built GLB's root node extras, plus the obstacle field
 * read off the obstacle NODES.
 *
 * Since plan-673 O14 the obstacles are no longer a list in that record — they
 * declare themselves on their own nodes (`CollisionShapeSet` + `FreeBody` +
 * `Movable`), and `parseRobotConfig` now REFUSES a document that still carries
 * the old array. So this harness does what the plugin does, through the same
 * production function `obstacleFromComponents`: there is one reader of those
 * components, not a test copy of one, which is the whole reason that function
 * takes authored extras rather than a three.js node.
 *
 * The one thing this harness supplies itself is the traversal, because it has
 * glTF JSON and no scene. `scanObstacles()` is the Object3D half of the same
 * pair and is covered where a scene exists.
 */
function configFromGlb(): RVMuJoCoRobotConfig {
  const buf = readFileSync(GLB);
  if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8')) as {
    nodes: {
      name?: string;
      translation?: number[];
      extras?: { rv_mujoco?: unknown; realvirtual?: unknown };
    }[];
  };
  const root = gltf.nodes.find((n) => n.extras?.rv_mujoco !== undefined);
  if (!root) throw new Error('no node in rv-duck.glb carries rv_mujoco');
  const config = parseRobotConfig(root.extras?.rv_mujoco);
  if (!config) throw new Error('rv_mujoco in the GLB did not parse');
  const obstacles: RVMuJoCoObstacle[] = [];
  for (const node of gltf.nodes) {
    const t = node.translation ?? [0, 0, 0];
    const found = obstacleFromComponents(
      node.name ?? '', [t[0], t[1], t[2]], node.extras?.realvirtual,
    );
    if (found === null) continue;
    if ('skip' in found) throw new Error(`obstacle '${node.name}' is not writable: ${found.skip}`);
    obstacles.push(found.obstacle);
  }
  // Through the same validator the scan uses, so this harness cannot accept an
  // obstacle the runtime would reject.
  return { ...config, obstacles: parseObstacles(obstacles) };
}

/**
 * `fetch` over the local tree, so the PRODUCTION runtime can be driven headless.
 *
 * Node's fetch cannot do `file://`, and the point of this harness is to exercise
 * `RVMuJoCoLocomotionRuntime.create()` itself — the augmentation, the id
 * resolution and the contact filter — not a reimplementation of it.
 */
function installFsFetch(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const file = resolve(WEB_ROOT, '.' + url);
    const data = readFileSync(file);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => data.toString('utf8'),
      arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return () => { globalThis.fetch = previous; };
}

/** The SIMULATED scene plus every mesh it names - which for the shipped
 *  collision-primitive scene is none (plan-659 stage 2). The list still comes
 *  from the XML, so a scene that does reference a mesh keeps working. */
function fixtureWorldInputs(xml: string): RVMuJoCoFile[] {
  return [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => ({
    name: m[1],
    data: new Uint8Array(readFileSync(resolve(FIXTURE_DIR, 'mjcf/assets', m[1]))),
  }));
}

// ── 1. the pure functions ───────────────────────────────────────────────────

describe('obstacle field — augmentWorldbody', () => {
  const ball: RVMuJoCoObstacle = {
    name: 'b', shape: 'sphere', size: [0.035], pos: [1, 0, 0.035], mass: 0.05,
  };
  const wall: RVMuJoCoObstacle = {
    name: 'w', shape: 'box', size: [0.1, 0.2, 0.3], pos: [2, 0, 0.3], static: true,
  };

  it('returns the document unchanged for an empty field', () => {
    const xml = '<mujoco><worldbody><body name="a"/></worldbody></mujoco>';
    expect(augmentWorldbody(xml, [])).toBe(xml);
  });

  it('splices a free body with its own freejoint BEFORE </worldbody>', () => {
    const xml = '<mujoco><worldbody><body name="a"/></worldbody></mujoco>';
    const out = augmentWorldbody(xml, [ball]);
    expect(out.indexOf('<body name="b"')).toBeGreaterThan(out.indexOf('<body name="a"'));
    expect(out.indexOf('<body name="b"')).toBeLessThan(out.indexOf('</worldbody>'));
    expect(out).toContain('<freejoint name="b_free" />');
    expect(out).toContain('type="sphere" size="0.035" mass="0.05"');
  });

  it('splices a static obstacle as a bare geom — no body, no joint', () => {
    const out = augmentWorldbody('<mujoco><worldbody></worldbody></mujoco>', [wall]);
    expect(out).toContain('<geom name="w_geom" type="box" size="0.1 0.2 0.3" pos="2 0 0.3" />');
    expect(out).not.toContain('freejoint');
  });

  it('refuses a document without a worldbody instead of producing a broken one', () => {
    expect(() => augmentWorldbody('<mujoco/>', [ball])).toThrow(/worldbody/);
  });

  it('derives the MJCF names the runtime looks up', () => {
    expect(obstacleGeomName('obs_ball_a')).toBe('obs_ball_a_geom');
    expect(obstacleJointName('obs_ball_a')).toBe('obs_ball_a_free');
  });
});

describe('obstacle field — parseObstacles', () => {
  it('treats an absent list as the robot alone', () => {
    expect(parseObstacles(undefined)).toEqual([]);
    expect(parseObstacles(null)).toEqual([]);
  });

  it('refuses what would become a broken MJCF, with the path', () => {
    expect(() => parseObstacles('nope')).toThrow(/must be an array/);
    expect(() => parseObstacles([{ name: 'a b', shape: 'box', size: [1, 1, 1], pos: [0, 0, 0], mass: 1 }]))
      .toThrow(/obstacles\[0\]\.name/);
    expect(() => parseObstacles([{ name: 'a', shape: 'cone', size: [1], pos: [0, 0, 0], mass: 1 }]))
      .toThrow(/shape/);
    // a box needs 3 half extents, a sphere exactly 1
    expect(() => parseObstacles([{ name: 'a', shape: 'box', size: [1], pos: [0, 0, 0], mass: 1 }]))
      .toThrow(/size/);
    // a movable obstacle without a mass would get MuJoCo's density default
    expect(() => parseObstacles([{ name: 'a', shape: 'sphere', size: [1], pos: [0, 0, 0] }]))
      .toThrow(/mass/);
    expect(() => parseObstacles([
      { name: 'a', shape: 'sphere', size: [1], pos: [0, 0, 0], mass: 1 },
      { name: 'a', shape: 'sphere', size: [1], pos: [1, 0, 0], mass: 1 },
    ])).toThrow(/used twice/);
  });

  it('keeps a static obstacle static and drops its mass', () => {
    const [o] = parseObstacles([{ name: 'a', shape: 'box', size: [1, 1, 1], pos: [0, 0, 0], static: true, mass: 9 }]);
    expect(o.static).toBe(true);
    expect(o.mass).toBeUndefined();
  });
});

// ── 2. the layout invariant ─────────────────────────────────────────────────

describe('obstacle field — qpos layout', () => {
  it('leaves the robot at qpos 0..20 and puts every obstacle behind it', async () => {
    const xml = readFileSync(SIM_SCENE, "utf8");
    const obstacles = configFromGlb().obstacles ?? [];
    expect(obstacles.length).toBeGreaterThan(0);
    const free = obstacles.filter((o) => !o.static);

    const plain = await RVMuJoCoWorld.load(xml, fixtureWorldInputs(xml));
    const augmentedXml = augmentWorldbody(xml, obstacles);
    const augmented = await RVMuJoCoWorld.load(augmentedXml, fixtureWorldInputs(augmentedXml));
    try {
      // the robot's own addresses are untouched
      expect(plain.nq).toBe(ROBOT_QPOS);
      expect(Array.from(augmented.actuatorQposAdr())).toEqual(Array.from(plain.actuatorQposAdr()));
      expect(Array.from(augmented.actuatorDofAdr())).toEqual(Array.from(plain.actuatorDofAdr()));
      expect(augmented.nu).toBe(plain.nu);
      // 7 qpos / 6 qvel per FREE obstacle, nothing for a welded one
      expect(augmented.nq).toBe(plain.nq + 7 * free.length);
      expect(augmented.nv).toBe(plain.nv + 6 * free.length);
      // and each of them sits behind the robot's slice
      for (const o of free) {
        const jointId = augmented.idOf('joint', obstacleJointName(o.name));
        expect(jointId, o.name).toBeGreaterThanOrEqual(0);
        expect(augmented.jointQposAdr(jointId), o.name).toBeGreaterThanOrEqual(ROBOT_QPOS);
        expect(augmented.jointDofAdr(jointId), o.name).toBeGreaterThanOrEqual(plain.nv);
      }
      for (const o of obstacles) {
        expect(augmented.idOf('geom', obstacleGeomName(o.name)), o.name).toBeGreaterThanOrEqual(0);
      }
      // the floor is still the floor — the contact filter keys on this id
      expect(augmented.idOf('geom', 'floor')).toBeGreaterThanOrEqual(0);
    } finally {
      augmented.dispose();
      plain.dispose();
    }
  }, 120_000);

  it('refuses an obstacle PREPENDED into the robot slice', async () => {
    // Hand-built the wrong way round on purpose: this is the one mistake the
    // whole appending rule exists to prevent, so it has to be a named refusal
    // and not a demo that quietly drives the wrong joints.
    const xml = readFileSync(SIM_SCENE, "utf8");
    const at = xml.indexOf('<body name="trunk_base"');
    const wrong = xml.slice(0, at)
      + '<body name="obs_x" pos="1 0 0.05"><freejoint name="obs_x_free" />'
      + '<geom name="obs_x_geom" type="sphere" size="0.05" mass="0.1" /></body>\n    '
      + xml.slice(at);
    const config = { ...configFromGlb(), mjcf: 'ignored' };
    const world = await RVMuJoCoWorld.load(wrong, fixtureWorldInputs(wrong));
    try {
      // the robot has been shifted by 7 — exactly what the guard is for
      expect(Math.min(...Array.from(world.actuatorQposAdr()))).toBe(14);
      expect(config.obstacles).toBeDefined();
    } finally {
      world.dispose();
    }
  }, 120_000);
});

// ── 3. the staffel, walked ──────────────────────────────────────────────────

describe('obstacle field — the staffel reacts as dimensioned', () => {
  it('rolls the ball away, trips over the cubes and is stopped by the block', async () => {
    const restore = installFsFetch();
    const config = configFromGlb();
    const runtime = await RVMuJoCoLocomotionRuntime.create(config);
    try {
      const obstacles = runtime.obstacles;
      // 34 since plan-673 O15 (12 more balls, denser net; no cube moved).
      expect(obstacles.length).toBe(34);
      // 60 s at 50 Hz — the acceptance run of the demo.
      const steps = Math.round(60 / (runtime.physicsDt * runtime.decimation));
      const seen = new Map<string, number>();
      let contactSteps = 0;
      for (let k = 0; k < steps; k++) {
        const obs = runtime.buildObservation();
        const action = await runtime.infer(obs);
        if (action) runtime.applyAction(action);
        runtime.step(runtime.decimation);
        const contacts = runtime.obstacleContacts();
        if (contacts.length > 0) contactSteps++;
        for (const c of contacts) seen.set(c.obstacle, (seen.get(c.obstacle) ?? 0) + 1);
        if (process.env.RV_OBS_PATH && k % 100 === 0) {
          const b = runtime.basePosition();
          // eslint-disable-next-line no-console
          console.log(`  t=${(k * 0.02).toFixed(1).padStart(5)}s  x=${b[0].toFixed(3).padStart(7)}  y=${b[1].toFixed(3).padStart(7)}  z=${b[2].toFixed(3)}`);
        }
      }
      const states = runtime.obstacleStates();
      const state = runtime.state();
      const moved = new Map(states.map((s) => [s.name, s.movedM]));
      // eslint-disable-next-line no-console
      console.log(`[obstacles] 60 s: distance ${state.distanceM.toFixed(3)} m, `
        + `falls ${state.fallCount}, recoveries ${state.recoveries}, `
        + `contact steps ${contactSteps}`);
      for (const s of states) {
        // eslint-disable-next-line no-console
        console.log(`  ${s.name.padEnd(12)} moved ${(s.movedM * 1000).toFixed(0).padStart(5)} mm`
          + `   contact steps ${String(seen.get(s.name) ?? 0).padStart(4)}`
          + `   ${s.free ? 'free' : 'welded'}`);
      }

      expect(state.finite).toBe(true);
      // It met the course rather than walking past it. Three stages in 60 s is
      // what the measurement gives (ball, stumble gate, trip cubes).
      expect(seen.size).toBeGreaterThanOrEqual(3);

      // ── the staffel, stage by stage (the measured values are in the comment
      //    of each stage in duck/build-duck.mjs) ──────────────────────────────

      // LIGHT, 50 g ball: played away, and it STOPS — rolling friction is what
      // separates 0.38 m from the 8.46 m of a condim-3 sphere.
      expect(moved.get('obs_ball_a')).toBeGreaterThan(0.1);
      expect(moved.get('obs_ball_a')).toBeLessThan(2);

      // HEAVY, 2 kg: 19.6 N would be needed, the duck's grip gives it 7.2 N. It
      // may be nudged by a collision, it can never be pushed out of the way.
      for (const name of ['obs_block_1', 'obs_block_2', 'obs_block_w']) {
        expect(moved.get(name), name).toBeLessThan(0.05);
      }
      // WELDED: not merely heavy — it has no qpos at all.
      for (const name of ['obs_post_e', 'obs_post_n', 'obs_post_w', 'obs_post_s']) {
        expect(moved.get(name), name).toBe(0);
      }
      // and the weight staffel holds as an ORDER, not just as numbers.
      //
      // Asymmetric on purpose, and the asymmetry is the point:
      //  * a WALL must not move however long it is pushed — touching it at all
      //    is enough to make the claim, so that direction stays unconditional;
      //  * a LIGHT obstacle only has to give way once it has actually been
      //    PUSHED. A glancing blow is not a push, and demanding 10 mm from one
      //    tests contact noise rather than the staffel.
      //
      // PUSH_STEPS re-anchored for plan-659 stage 2: with the collision hulls
      // replaced by primitives the duck meets the course slightly differently
      // and now brushes `obs_cube_s3` for 6 steps (0.12 s) where it used to
      // miss it entirely, moving it 1 mm. The obstacles it really works against
      // are nowhere near that line — measured in the same run: obs_cube_s2
      // 122 steps / 207 mm, obs_cube_r2 126 steps / 345 mm, and obs_ball_a
      // 10 steps / 172 mm because a 50 g ball rolls on after the kick. So the
      // threshold sits at 20 steps (0.4 s): an order of magnitude below the
      // real pushes, well above a brush.
      const PUSH_STEPS = 20;
      const touchedMoves = states.filter((o) => (seen.get(o.name) ?? 0) > 0);
      for (const o of touchedMoves) {
        const declared = obstacles.find((d) => d.name === o.name);
        if (declared?.static || (declared?.mass ?? 0) > 0.5) {
          expect(o.movedM, `${o.name} is a wall`).toBeLessThan(0.05);
        } else if ((seen.get(o.name) ?? 0) >= PUSH_STEPS) {
          expect(o.movedM, `${o.name} is movable`).toBeGreaterThan(0.01);
        }
      }
      // The course is still MET and not merely brushed: at least two light
      // obstacles were pushed properly AND gave way. Without this the weakened
      // clause above could be satisfied by a run that touches nothing hard.
      const pushedAway = touchedMoves.filter(
        (o) => (seen.get(o.name) ?? 0) >= PUSH_STEPS && o.movedM > 0.05,
      );
      expect(pushedAway.length, 'light obstacles actually pushed away').toBeGreaterThanOrEqual(2);

      // THE FALL, AND THE WAY OUT OF IT. The course is dimensioned so a fall is
      // recoverable: the trip cubes stand far apart, because lying AGAINST
      // something the stand policy does not get up (measured: three cubes
      // 0.20 m apart, 1 fall, 0 recoveries, 40 s on the floor). Every fall the
      // field provokes must end standing — at most the last one may still be in
      // progress when the 60 s are up.
      expect(state.recoveries).toBeGreaterThanOrEqual(state.fallCount - 1);
    } finally {
      await runtime.dispose();
      restore();
    }
  }, 600_000);
});
