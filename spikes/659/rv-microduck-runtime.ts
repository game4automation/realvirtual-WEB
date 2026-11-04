// plan-659 spike harness — Microduck headless runtime (Phase 1).
//
// Binds the production core (`@rv-private/mujoco/*`) to the Phase-0 fixtures and
// runs the loop in scheduler mode `parity`, SYNCHRONOUSLY: the observation is
// built, inference is awaited, `ctrl` is written, `decimation` physics steps
// follow. In simulation time that is exactly the training loop (finding M1) and
// therefore the parity reference the plan asks Phase 1 to measure in.
//
// Spike-local on purpose: the scheduler with its sub-accumulator, the dropped
// sim-time accounting and the `hold` comparison mode belong to the viewer plugin
// (Phase 2). Headless there is no render loop and no cap, so `droppedSimTime`
// is structurally 0 here and is NOT reported as a satisfied criterion
// (plan residual risk N2).

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  RVLocomotionPolicy,
  quatRotateInverse,
} from '@rv-private/mujoco/rv-locomotion-policy';
import { RVMuJoCoWorld, type RVMuJoCoFile } from '@rv-private/mujoco/rv-mujoco-world';
import {
  allFinite,
  FALL_DEBOUNCE_S,
  FALL_GZ_THRESHOLD,
  FALL_HEIGHT_THRESHOLD,
  GYRO_SENSOR,
  percentile,
  policyConfigFromContract,
  TRUNK_BODY,
  TRUNK_FREEJOINT,
  type MicroduckContract,
  type MicroduckFixture,
  type MicroduckReference,
} from './microduck-contract';

// Re-exported so the Phase-1 tests keep importing them from here (the contract
// module holds the definition, this file is the Node harness around it).
export {
  FALL_DEBOUNCE_S,
  FALL_GZ_THRESHOLD,
  FALL_HEIGHT_THRESHOLD,
  percentile,
  policyConfigFromContract,
};
export type { MicroduckContract, MicroduckFixture, MicroduckReference };

export const FIXTURE_DIR = resolve(__dirname, 'fixtures/microduck');

/** The Phase-0 reference fixtures, including `meta.contract` — the single
 *  source for dt, decimation, joint order and the default pose. */
export function loadReference(): MicroduckReference {
  return JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, 'reference/microduck-reference-fixtures.json'), 'utf8'),
  ) as MicroduckReference;
}

/** The deterministic `qpos` snapshot after 500 control steps (Python chain). */
export function loadQposAfter500(): { qpos: number[]; command: number[]; meta: unknown } {
  return JSON.parse(
    readFileSync(resolve(FIXTURE_DIR, 'reference/microduck-qpos-after-500-steps.json'), 'utf8'),
  ) as { qpos: number[]; command: number[]; meta: unknown };
}

/**
 * The scene the spike SIMULATES: the Apache-2.0 body tree with every collision
 * hull an original MuJoCo primitive (plan-659 stage 2, built by
 * `duck/build-collision-primitives.mjs`). It references no mesh file, so
 * nothing at run time needs the CC BY-NC-SA 4.0 STL fixture any more.
 */
export const PRIMITIVE_SCENE = resolve(__dirname, 'duck/rv-duck-collision.xml');

/** The original scene, whose eleven collision geoms are CC BY-NC-SA meshes.
 *  Those are gitignored and procured out of band, so on most checkouts they are
 *  ABSENT — see {@link hasMeshFixture}. Kept for the equivalence comparison. */
export const MESH_SCENE = resolve(FIXTURE_DIR, 'mjcf/prepared-scene.xml');

/** True when the third-party STL fixture happens to be present locally. */
export function hasMeshFixture(): boolean {
  if (!existsSync(MESH_SCENE)) return false;
  const xml = readFileSync(MESH_SCENE, 'utf8');
  const meshNames = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
  return meshNames.length > 0
    && meshNames.every((name) => existsSync(resolve(FIXTURE_DIR, 'mjcf/assets', name)));
}

/** Load one MJCF plus every mesh it references into a MuJoCo world. */
async function loadScene(xmlPath: string): Promise<RVMuJoCoWorld> {
  const xml = readFileSync(xmlPath, 'utf8');
  const meshNames = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
  const files: RVMuJoCoFile[] = meshNames.map((name) => ({
    name,
    data: new Uint8Array(readFileSync(resolve(FIXTURE_DIR, 'mjcf/assets', name))),
  }));
  return RVMuJoCoWorld.load(xml, files);
}

/** The world the spike runs on: primitives only, no third-party mesh. */
export async function loadMicroduckWorld(): Promise<RVMuJoCoWorld> {
  return loadScene(PRIMITIVE_SCENE);
}

/** The original mesh-hull world. Throws when the CC fixture is absent, so
 *  guard every call with {@link hasMeshFixture}. */
export async function loadMicroduckMeshWorld(): Promise<RVMuJoCoWorld> {
  return loadScene(MESH_SCENE);
}

/** Load one of the two Phase-0 policies. */
export async function loadMicroduckPolicy(
  kind: 'walking' | 'stand',
  contract: MicroduckContract,
): Promise<RVLocomotionPolicy> {
  const file = kind === 'walking' ? 'BEST_alpha_walking.onnx' : 'BEST_alpha_stand.onnx';
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURE_DIR, 'policies', file)));
  return RVLocomotionPolicy.load(bytes, policyConfigFromContract(contract));
}

export interface MicroduckRunStats {
  controlSteps: number;
  simTimeS: number;
  baseHeightEndM: number;
  baseHeightMinM: number;
  distanceXyM: number;
  displacementXM: number;
  meanSpeedXMps: number;
  fallen: boolean;
  fallAtSimTimeS: number | null;
  finite: boolean;
  /** Wall-clock seconds spent inside the loop. */
  wallClockS: number;
  /** Policy inference latencies in ms, one per control step. */
  policyLatenciesMs: number[];
  /** Wall-clock seconds spent in `mj_step` batches. */
  physicsWallS: number;
  /** Contacts seen after the final step (`data.ncon`). */
  contactsAtEnd: number;
}

/**
 * One Microduck run: world + policy + index maps, stepped in `parity` mode.
 *
 * `dispose()` releases both the world and the ORT session; it is idempotent and
 * belongs in a `finally`.
 */
export class RVMicroduckRuntime {
  readonly world: RVMuJoCoWorld;
  readonly contract: MicroduckContract;

  /** The active policy. Swappable via {@link usePolicy} — walking and stand
   *  share one tensor contract (Phase 0), so recovery is a session swap. */
  policy: RVLocomotionPolicy;

  private readonly trunkBodyId: number;
  private readonly freeJointQposAdr: number;
  private readonly gyro: { adr: number; dim: number };
  private readonly qposAdr: Int32Array;
  private readonly dofAdr: Int32Array;

  private readonly jointPos: Float64Array;
  private readonly jointVel: Float64Array;
  private readonly quat = new Float64Array(4);
  private readonly angVel = new Float64Array(3);
  private readonly qposScratch: Float64Array;
  private readonly qvelScratch: Float64Array;
  private readonly gravityScratch = new Float32Array(3);

  private disposed = false;

  constructor(world: RVMuJoCoWorld, policy: RVLocomotionPolicy, contract: MicroduckContract) {
    this.world = world;
    this.policy = policy;
    this.contract = contract;
    this.trunkBodyId = world.idOf('body', TRUNK_BODY);
    if (this.trunkBodyId < 0) throw new Error(`body '${TRUNK_BODY}' not found`);
    if (world.idOf('joint', TRUNK_FREEJOINT) < 0) {
      throw new Error(`joint '${TRUNK_FREEJOINT}' not found`);
    }
    const gyro = world.sensorRange(GYRO_SENSOR);
    if (!gyro) throw new Error(`sensor '${GYRO_SENSOR}' not found`);
    this.gyro = gyro;
    this.qposAdr = world.actuatorQposAdr();
    this.dofAdr = world.actuatorDofAdr();
    this.freeJointQposAdr = freeJointQposAdr(world);
    this.jointPos = new Float64Array(world.nu);
    this.jointVel = new Float64Array(world.nu);
    this.qposScratch = new Float64Array(world.nq);
    this.qvelScratch = new Float64Array(world.nv);
  }

  /**
   * Load world + policy + runtime in one call.
   *
   * `scene` defaults to `'primitives'` — the shipping scene (plan-659 stage 2).
   * `'meshes'` loads the original CC BY-NC-SA mesh hulls and is only for the
   * equivalence comparison; it throws when the fixture is absent.
   */
  static async create(
    kind: 'walking' | 'stand' = 'walking',
    scene: 'primitives' | 'meshes' = 'primitives',
  ): Promise<RVMicroduckRuntime> {
    const reference = loadReference();
    const contract = reference.meta.contract;
    const world = scene === 'meshes' ? await loadMicroduckMeshWorld() : await loadMicroduckWorld();
    try {
      const policy = await loadMicroduckPolicy(kind, contract);
      return new RVMicroduckRuntime(world, policy, contract);
    } catch (err) {
      world.dispose();
      throw err;
    }
  }

  /**
   * Put the duck into the Phase-0 start state: base at `(0, 0, init_base_z)`,
   * identity orientation, joints and `ctrl` on the default pose, then
   * `mj_forward` so the first observation reads valid sensors.
   */
  initStartState(): void {
    this.world.reset();
    const a = this.freeJointQposAdr;
    this.world.writeQpos(a, [0, 0, this.contract.init_base_z_m, 1, 0, 0, 0]);
    const pose = this.contract.default_pose;
    for (let i = 0; i < this.qposAdr.length; i++) {
      this.world.writeQpos(this.qposAdr[i], [pose[i]]);
    }
    this.world.setCtrl(Float64Array.from(pose));
    this.policy.reset();
    this.world.forward();
  }

  /** Base position `[x, y, z]` read from the free joint's qpos slot. */
  basePosition(): [number, number, number] {
    const qpos = this.world.readQpos(this.qposScratch);
    const a = this.freeJointQposAdr;
    return [qpos[a], qpos[a + 1], qpos[a + 2]];
  }

  /** Projected gravity z in the trunk frame — the fall indicator (M8). */
  projectedGravityZ(): number {
    const quat = this.world.readXquat(this.trunkBodyId, this.quat);
    const g = quatRotateInverse(quat, [0, 0, -1], this.gravityScratch);
    return g[2];
  }

  /** Assemble the observation from the live world state. */
  buildObservation(): Float32Array {
    const qpos = this.world.readQpos(this.qposScratch);
    const qvel = this.world.readQvel(this.qvelScratch);
    for (let i = 0; i < this.qposAdr.length; i++) {
      this.jointPos[i] = qpos[this.qposAdr[i]];
      this.jointVel[i] = qvel[this.dofAdr[i]];
    }
    return this.policy.buildObservation({
      baseAngVel: this.world.readSensor(this.gyro.adr, 3, this.angVel),
      baseQuat: this.world.readXquat(this.trunkBodyId, this.quat),
      jointPos: this.jointPos,
      jointVel: this.jointVel,
    });
  }

  /**
   * One control step in `parity` mode: observation → AWAITED inference →
   * `ctrl` → `decimation` physics steps.
   *
   * A non-finite action is dropped: `ctrl` keeps its previous target and the
   * physics steps still run (finding M8). Returns the inference latency in ms
   * and whether the action was adopted.
   */
  async controlStep(): Promise<{ latencyMs: number; actionAccepted: boolean }> {
    const obs = this.buildObservation();
    const t0 = performance.now();
    const action = await this.policy.infer(obs);
    const latencyMs = performance.now() - t0;
    let actionAccepted = false;
    if (action) {
      actionAccepted = this.world.setCtrl(this.policy.actionToCtrl(action));
    }
    this.world.step(this.contract.decimation);
    return { latencyMs, actionAccepted };
  }

  /**
   * Run `controlSteps` control steps from the current state, tracking distance,
   * base height, the debounced fall criterion and the cost split.
   */
  async run(controlSteps: number, options: { trackLatency?: boolean } = {}): Promise<MicroduckRunStats> {
    const trackLatency = options.trackLatency ?? true;
    const dtControl = this.contract.timestep * this.contract.decimation;
    const [startX, startY] = this.basePosition();
    let minHeight = this.basePosition()[2];
    let fallAt: number | null = null;
    let fallSince: number | null = null;
    const latencies: number[] = [];
    let physicsWall = 0;
    const wall0 = performance.now();

    for (let k = 0; k < controlSteps; k++) {
      const obs = this.buildObservation();
      const t0 = performance.now();
      const action = await this.policy.infer(obs);
      const t1 = performance.now();
      if (trackLatency) latencies.push(t1 - t0);
      if (action) this.world.setCtrl(this.policy.actionToCtrl(action));
      this.world.step(this.contract.decimation);
      physicsWall += performance.now() - t1;

      const [, , z] = this.basePosition();
      if (z < minHeight) minHeight = z;
      const down = this.projectedGravityZ() > FALL_GZ_THRESHOLD || z < FALL_HEIGHT_THRESHOLD;
      const simTime = (k + 1) * dtControl;
      if (down) {
        if (fallSince === null) fallSince = simTime;
        else if (fallAt === null && simTime - fallSince >= FALL_DEBOUNCE_S) fallAt = fallSince;
      } else {
        fallSince = null;
      }
    }

    const wallClockS = (performance.now() - wall0) / 1000;
    const [endX, endY, endZ] = this.basePosition();
    const qpos = this.world.readQpos(this.qposScratch);
    const qvel = this.world.readQvel(this.qvelScratch);
    const simTimeS = controlSteps * dtControl;
    return {
      controlSteps,
      simTimeS,
      baseHeightEndM: endZ,
      baseHeightMinM: minHeight,
      distanceXyM: Math.hypot(endX - startX, endY - startY),
      displacementXM: endX - startX,
      meanSpeedXMps: (endX - startX) / simTimeS,
      fallen: fallAt !== null,
      fallAtSimTimeS: fallAt,
      finite: allFinite(qpos) && allFinite(qvel),
      wallClockS,
      policyLatenciesMs: latencies,
      physicsWallS: physicsWall / 1000,
      contactsAtEnd: this.world.contactCount(),
    };
  }

  /** Commanded forward velocity in m/s (`command[0]`, the twist x slot). */
  setForwardVelocity(vx: number): void {
    this.policy.setCommandAt(0, vx);
  }

  /**
   * Swap the active policy (walking ↔ stand). The caller keeps ownership of the
   * previous policy; `lastAction` of the new one is NOT reset, because the
   * observation the recovery policy sees must continue the fall, not pretend a
   * fresh episode.
   */
  usePolicy(policy: RVLocomotionPolicy): void {
    this.policy = policy;
  }

  /** Add a velocity impulse to the base (m/s), the push of test 9.9. The free
   *  joint's linear dofs are the first three entries of `qvel`. */
  pushBase(dvx: number, dvy: number, dvz = 0): void {
    const qvel = this.world.readQvel(this.qvelScratch);
    this.world.writeQvel(0, [qvel[0] + dvx, qvel[1] + dvy, qvel[2] + dvz]);
  }

  /** Release world and session. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.policy.dispose();
    } finally {
      this.world.dispose();
    }
  }
}

/**
 * qpos address of the trunk free joint.
 *
 * The free joint has no actuator, so the actuator map cannot name it. For the
 * Microduck it is joint 0 at address 0 (verified in Phase 0: nq 21 = 7 free +
 * 14 joints). Rather than reach into model internals the spike ASSERTS the
 * invariant it relies on — every actuated joint sits at or after index 7 — so a
 * changed MJCF fails loudly instead of silently reading the wrong slots.
 */
function freeJointQposAdr(world: RVMuJoCoWorld): number {
  const adrs = Array.from(world.actuatorQposAdr());
  const min = Math.min(...adrs);
  if (min < 7) {
    throw new Error(`unexpected qpos layout: actuated joint at index ${min}, expected >= 7`);
  }
  return 0;
}
