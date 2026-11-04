// plan-659 spike — browser side of the Microduck/duck runtime (Phase 2).
//
// The Node twin of this file is `rv-microduck-runtime.ts`. They differ in
// exactly one thing: HOW the fixture bytes arrive (fs vs fetch). Everything
// that interprets them — the contract, the policy config, the index maps, the
// fall criterion — is shared (`microduck-contract.ts`) or lives in the
// production core (`@rv-private/mujoco/*`).
//
// What is new here and nowhere else:
//  - the driver interface the Phase-2 scheduler needs (`RVMuJoCoPolicyDriver`),
//  - fall detection and recovery as a STATE MACHINE over control steps, not as
//    a post-hoc analysis of a finished run,
//  - the policy swap at run time (walking ↔ stand), which must NOT reset
//    `lastAction` — the recovery policy has to continue the fall, not see a
//    fresh episode (Phase 1 finding 4).

import {
  RVLocomotionPolicy,
  quatRotateInverse,
} from '@rv-private/mujoco/rv-locomotion-policy';
import { RVMuJoCoWorld, type RVMuJoCoFile } from '@rv-private/mujoco/rv-mujoco-world';
import type { RVMuJoCoPolicyDriver } from '@rv-private/mujoco/rv-mujoco-scheduler';
import {
  allFinite,
  FALL_DEBOUNCE_S,
  FALL_GZ_THRESHOLD,
  FALL_HEIGHT_THRESHOLD,
  GYRO_SENSOR,
  policyConfigFromContract,
  RECOVERED_GZ_THRESHOLD,
  TRUNK_BODY,
  TRUNK_FREEJOINT,
  type MicroduckContract,
  type MicroduckReference,
} from './microduck-contract';

/** Where the Phase-0 fixtures are served from (dev server root). */
export const FIXTURE_BASE = '/spikes/659/fixtures/microduck';
/** The robot model the design agent produced (plan-659, own geometry). */
export const DUCK_GLB_URL = '/spikes/659/duck/rv-duck.glb';
/** The scene this demo SIMULATES: the Apache-2.0 body tree with every collision
 *  hull an original MuJoCo primitive (plan-659 stage 2,
 *  `duck/build-collision-primitives.mjs`). It references no mesh file, so the
 *  demo fetches none of the nine CC BY-NC-SA 4.0 STL files. */
export const COLLISION_SCENE_URL = '/spikes/659/duck/rv-duck-collision.xml';

export type DuckPolicyKind = 'walking' | 'stand';

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`);
  return response.text();
}

/** The Phase-0 reference fixtures, including `meta.contract`. */
export async function loadReference(): Promise<MicroduckReference> {
  return JSON.parse(
    await fetchText(`${FIXTURE_BASE}/reference/microduck-reference-fixtures.json`),
  ) as MicroduckReference;
}

/** Load the collision-primitive scene into a MuJoCo world.
 *
 *  The mesh list still comes from the XML itself — nothing is hardcoded — so a
 *  scene that DOES reference a mesh still loads, and the loop below is simply
 *  empty for the primitive scene. That is the assertion, not a comment: if this
 *  scene ever regained a `<mesh>` entry, the fetch would go to the gitignored
 *  CC BY-NC-SA fixture and fail loudly instead of silently shipping it. */
export async function loadDuckWorld(): Promise<RVMuJoCoWorld> {
  const xml = await fetchText(COLLISION_SCENE_URL);
  const meshNames = [...xml.matchAll(/<mesh[^>]*\bfile="([^"]+)"/g)].map((m) => m[1]);
  const files: RVMuJoCoFile[] = await Promise.all(
    meshNames.map(async (name) => ({
      name,
      data: await fetchBytes(`${FIXTURE_BASE}/mjcf/assets/${name}`),
    })),
  );
  return RVMuJoCoWorld.load(xml, files);
}

export async function loadDuckPolicy(
  kind: DuckPolicyKind,
  contract: MicroduckContract,
): Promise<RVLocomotionPolicy> {
  const file = kind === 'walking' ? 'BEST_alpha_walking.onnx' : 'BEST_alpha_stand.onnx';
  const bytes = await fetchBytes(`${FIXTURE_BASE}/policies/${file}`);
  return RVLocomotionPolicy.load(bytes, policyConfigFromContract(contract));
}

export interface DuckRuntimeState {
  /** Base position in MuJoCo coordinates (m). */
  base: [number, number, number];
  baseHeightM: number;
  baseHeightMinM: number;
  /** Travelled distance in the ground plane since the last reset (m). */
  distanceM: number;
  displacementXM: number;
  projectedGravityZ: number;
  controlSteps: number;
  simTimeS: number;
  activePolicy: DuckPolicyKind;
  fallen: boolean;
  /** Falls detected since the last reset. */
  fallCount: number;
  recoveries: number;
  finite: boolean;
  contacts: number;
  commandVx: number;
  commandVy: number;
  commandYaw: number;
}

/**
 * One duck: world, both policies, index maps, fall state machine.
 *
 * Implements {@link RVMuJoCoPolicyDriver}, so the scheduler drives it without
 * knowing anything about ducks.
 */
export class RVDuckBrowserRuntime implements RVMuJoCoPolicyDriver {
  readonly world: RVMuJoCoWorld;
  readonly contract: MicroduckContract;
  readonly qposAdr: Int32Array;
  readonly freeJointQposAdr: number;

  private readonly policies: Record<DuckPolicyKind, RVLocomotionPolicy>;
  private activeKind: DuckPolicyKind = 'walking';
  private policy: RVLocomotionPolicy;

  private readonly trunkBodyId: number;
  private readonly gyro: { adr: number; dim: number };
  private readonly dofAdr: Int32Array;

  private readonly jointPos: Float64Array;
  private readonly jointVel: Float64Array;
  private readonly quat = new Float64Array(4);
  private readonly angVel = new Float64Array(3);
  private readonly qposScratch: Float64Array;
  private readonly qvelScratch: Float64Array;
  private readonly gravityScratch = new Float32Array(3);

  private generationCounter = 0;
  private controlSteps = 0;
  private startX = 0;
  private startY = 0;
  private minHeight = Number.POSITIVE_INFINITY;
  private fallSince: number | null = null;
  private fallen = false;
  private fallCount = 0;
  private recoveries = 0;
  private recoverSince: number | null = null;
  private command = new Float32Array(3);
  private disposed = false;

  private constructor(
    world: RVMuJoCoWorld,
    policies: Record<DuckPolicyKind, RVLocomotionPolicy>,
    contract: MicroduckContract,
  ) {
    this.world = world;
    this.contract = contract;
    this.policies = policies;
    this.policy = policies.walking;
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
    // Same assertion as the Node harness (Phase 1 finding 6): the free joint is
    // joint 0 at address 0, and that only holds while no actuated joint sits
    // before index 7.
    const minAdr = Math.min(...Array.from(this.qposAdr));
    if (minAdr < 7) throw new Error(`unexpected qpos layout: actuated joint at ${minAdr}`);
    this.freeJointQposAdr = 0;
    this.jointPos = new Float64Array(world.nu);
    this.jointVel = new Float64Array(world.nu);
    this.qposScratch = new Float64Array(world.nq);
    this.qvelScratch = new Float64Array(world.nv);
  }

  /** Fetch everything and build the runtime in the start pose. */
  static async create(): Promise<RVDuckBrowserRuntime> {
    const reference = await loadReference();
    const contract = reference.meta.contract;
    const world = await loadDuckWorld();
    try {
      const [walking, stand] = await Promise.all([
        loadDuckPolicy('walking', contract),
        loadDuckPolicy('stand', contract),
      ]);
      const runtime = new RVDuckBrowserRuntime(world, { walking, stand }, contract);
      runtime.reset();
      return runtime;
    } catch (err) {
      world.dispose();
      throw err;
    }
  }

  // ── Driver contract ───────────────────────────────────────────────────────

  get decimation(): number {
    return this.contract.decimation;
  }

  get physicsDt(): number {
    return this.contract.timestep;
  }

  get generation(): number {
    return this.generationCounter;
  }

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

  infer(observation: Float32Array): Promise<Float32Array | null> {
    return this.policy.infer(observation);
  }

  applyAction(action: Float32Array): boolean {
    return this.world.setCtrl(this.policy.actionToCtrl(action));
  }

  /** Step the physics, then run the fall/recovery state machine for the control
   *  step that just completed. */
  step(steps: number): void {
    this.world.step(steps);
    this.controlSteps++;
    this.updateFallState();
  }

  // ── Duck-specific control ────────────────────────────────────────────────

  /** Twist command: `command[0..2] = [vx, vy, yaw]` (m/s, m/s, rad/s). */
  setCommand(vx: number, vy = this.command[1], yaw = this.command[2]): void {
    this.command[0] = vx;
    this.command[1] = vy;
    this.command[2] = yaw;
    // Both sessions share the tensor contract, so both carry the command.
    for (const policy of Object.values(this.policies)) {
      policy.setCommandAt(0, vx);
      policy.setCommandAt(1, vy);
      policy.setCommandAt(2, yaw);
    }
  }

  /** The live session — the parity self-test of the demo page feeds fixtures
   *  through exactly this one, not through a second session of its own. */
  get activePolicy(): RVLocomotionPolicy {
    return this.policy;
  }

  get activePolicyKind(): DuckPolicyKind {
    return this.activeKind;
  }

  /**
   * Swap the active session.
   *
   * `lastAction` is carried over DELIBERATELY (Phase 1 finding 4): the stand
   * policy must continue the fall it is handed, so the new session's carried
   * action is seeded with the old one's.
   */
  usePolicy(kind: DuckPolicyKind): void {
    if (kind === this.activeKind) return;
    const next = this.policies[kind];
    (next.lastActionView as Float32Array).set(this.policy.lastActionView);
    this.policy = next;
    this.activeKind = kind;
  }

  /**
   * Back to the Phase-0 start state: base at `(0, 0, init_base_z)`, identity
   * orientation, joints and `ctrl` on the default pose, walking policy, fresh
   * generation (so an inference in flight is discarded).
   */
  reset(): void {
    this.world.reset();
    const a = this.freeJointQposAdr;
    this.world.writeQpos(a, [0, 0, this.contract.init_base_z_m, 1, 0, 0, 0]);
    const pose = this.contract.default_pose;
    for (let i = 0; i < this.qposAdr.length; i++) {
      this.world.writeQpos(this.qposAdr[i], [pose[i]]);
    }
    this.world.setCtrl(Float64Array.from(pose));
    this.activeKind = 'walking';
    this.policy = this.policies.walking;
    for (const policy of Object.values(this.policies)) policy.reset();
    this.setCommand(this.command[0], this.command[1], this.command[2]);
    this.world.forward();
    this.generationCounter++;
    this.controlSteps = 0;
    const [x, y, z] = this.basePosition();
    this.startX = x;
    this.startY = y;
    this.minHeight = z;
    this.fallSince = null;
    this.fallen = false;
    this.fallCount = 0;
    this.recoveries = 0;
    this.recoverSince = null;
  }

  /** Lateral velocity impulse on the base (m/s) — the push of test 9.9. Phase 1
   *  measured that this policy absorbs 0.5 m/s and falls at 1.0 m/s. */
  pushBase(dvx: number, dvy: number, dvz = 0): void {
    const qvel = this.world.readQvel(this.qvelScratch);
    this.world.writeQvel(0, [qvel[0] + dvx, qvel[1] + dvy, qvel[2] + dvz]);
  }

  basePosition(): [number, number, number] {
    const qpos = this.world.readQpos(this.qposScratch);
    const a = this.freeJointQposAdr;
    return [qpos[a], qpos[a + 1], qpos[a + 2]];
  }

  /** Projected gravity z in the trunk frame — the fall indicator (M8). */
  projectedGravityZ(): number {
    const quat = this.world.readXquat(this.trunkBodyId, this.quat);
    return quatRotateInverse(quat, [0, 0, -1], this.gravityScratch)[2];
  }

  /** Live `qpos` copy — for the joint mirror. Never a cached heap view (M2). */
  readQpos(): Float64Array {
    return this.world.readQpos(this.qposScratch);
  }

  get simTimeS(): number {
    return this.controlSteps * this.contract.timestep * this.contract.decimation;
  }

  state(): DuckRuntimeState {
    const [x, y, z] = this.basePosition();
    const qpos = this.world.readQpos(this.qposScratch);
    const qvel = this.world.readQvel(this.qvelScratch);
    return {
      base: [x, y, z],
      baseHeightM: z,
      baseHeightMinM: this.minHeight,
      distanceM: Math.hypot(x - this.startX, y - this.startY),
      displacementXM: x - this.startX,
      projectedGravityZ: this.projectedGravityZ(),
      controlSteps: this.controlSteps,
      simTimeS: this.simTimeS,
      activePolicy: this.activeKind,
      fallen: this.fallen,
      fallCount: this.fallCount,
      recoveries: this.recoveries,
      finite: allFinite(qpos) && allFinite(qvel),
      contacts: this.world.contactCount(),
      commandVx: this.command[0],
      commandVy: this.command[1],
      commandYaw: this.command[2],
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generationCounter++;
    try {
      await Promise.all(Object.values(this.policies).map((p) => p.dispose()));
    } finally {
      this.world.dispose();
    }
  }

  /**
   * Fall criterion M8, debounced, plus the recovery swap.
   *
   * Entering the fallen state swaps in the stand policy; leaving it (projected
   * gravity below the recovery threshold for a second) swaps back to walking.
   * A non-finite state is not debounced at all — it is reset immediately.
   */
  private updateFallState(): void {
    const [, , z] = this.basePosition();
    if (z < this.minHeight) this.minHeight = z;
    const qpos = this.world.readQpos(this.qposScratch);
    if (!allFinite(qpos)) {
      this.reset();
      return;
    }
    const gz = this.projectedGravityZ();
    const now = this.simTimeS;
    const down = gz > FALL_GZ_THRESHOLD || z < FALL_HEIGHT_THRESHOLD;

    if (!this.fallen) {
      if (down) {
        if (this.fallSince === null) this.fallSince = now;
        else if (now - this.fallSince >= FALL_DEBOUNCE_S) {
          this.fallen = true;
          this.fallCount++;
          this.fallSince = null;
          this.recoverSince = null;
          this.usePolicy('stand');
        }
      } else {
        this.fallSince = null;
      }
      return;
    }

    // Fallen: wait for the stand policy to bring the trunk upright again.
    if (gz < RECOVERED_GZ_THRESHOLD) {
      if (this.recoverSince === null) this.recoverSince = now;
      else if (now - this.recoverSince >= 1) {
        this.fallen = false;
        this.recoveries++;
        this.recoverSince = null;
        this.usePolicy('walking');
      }
    } else {
      this.recoverSince = null;
    }
  }
}
