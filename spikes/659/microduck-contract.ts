// plan-659 spike — the Microduck fixture contract, DOM-free and fs-free.
//
// Extracted from `rv-microduck-runtime.ts` in Phase 2 so the BROWSER demo and
// the Node harness read the SAME contract types and build the SAME policy
// config. Nothing here touches `node:fs` or `window`: the two callers differ
// only in HOW they obtain the bytes (fs vs fetch), never in how they interpret
// them.
//
// The contract itself lives in the fixture
// (`fixtures/microduck/reference/microduck-reference-fixtures.json`,
// `meta.contract`) — dt, decimation, joint order, default pose and observation
// layout are DATA. Phase 1 established the rule and Phase 2 keeps it: never
// duplicate those numbers as constants in code, or a fixture regeneration
// diverges silently.

import type {
  RVLocomotionPolicyConfig,
  RVObservationSegment,
} from '@rv-private/mujoco/rv-locomotion-policy';

export interface MicroduckContract {
  obs_size: number;
  action_size: number;
  command_size: number;
  observation_layout: string[];
  action_scale: number;
  timestep: number;
  decimation: number;
  policy_rate_hz: number;
  joint_names: string[];
  default_pose: number[];
  init_base_z_m: number;
  model_dims: { nq: number; nv: number; nu: number };
}

export interface MicroduckFixture {
  control_step: number;
  sim_time_s: number;
  input: {
    raw_state: {
      qpos: number[];
      qvel: number[];
      base_quat_xquat_wxyz: number[];
      base_ang_vel_gyro: number[];
      joint_pos: number[];
      joint_vel: number[];
    };
    command: number[];
    last_action: number[];
  };
  expected: {
    observation: number[];
    action: number[];
    ctrl_position_target: number[];
  };
}

export interface MicroduckReference {
  meta: {
    runtime_versions: Record<string, string>;
    browser_target_versions: Record<string, string>;
    contract: MicroduckContract;
    determinism: { two_identical_runs_bit_equal: boolean };
    runs: Record<string, Record<string, number | boolean>>;
  };
  fixtures: MicroduckFixture[];
}

/** Bodies, joints and sensors the Microduck loop addresses by NAME. */
export const TRUNK_BODY = 'trunk_base';
export const TRUNK_FREEJOINT = 'trunk_base_freejoint';
export const GYRO_SENSOR = 'imu_ang_vel';

/** Fall criterion (finding M8): projected gravity z above this means the trunk
 *  frame is no longer pointing down. */
export const FALL_GZ_THRESHOLD = -0.5;
/** Second fall criterion: base height below this (m). Value of the Space. */
export const FALL_HEIGHT_THRESHOLD = 0.02;
/** Both criteria are debounced for this long (s) before a fall is reported. */
export const FALL_DEBOUNCE_S = 0.2;
/** Recovery is complete once projected gravity z stays below this (M8/Phase 1). */
export const RECOVERED_GZ_THRESHOLD = -0.85;

/** Build the policy config from the fixture contract — never from constants
 *  duplicated here, so a fixture regeneration cannot silently diverge. */
export function policyConfigFromContract(contract: MicroduckContract): RVLocomotionPolicyConfig {
  return {
    jointNames: contract.joint_names,
    defaultJointPos: contract.default_pose,
    actionScale: contract.action_scale,
    decimation: contract.decimation,
    physicsDt: contract.timestep,
    observationSize: contract.obs_size,
    commandSize: contract.command_size,
    observationLayout: contract.observation_layout.map(segmentOf),
  };
}

export function segmentOf(layoutEntry: string): RVObservationSegment {
  // The contract names each segment with its provenance, e.g.
  // "joint_pos[14] = qpos - DEFAULT_POSE" — the leading identifier is the name.
  const name = layoutEntry.split('[')[0].trim();
  switch (name) {
    case 'base_ang_vel':
    case 'projected_gravity':
    case 'joint_pos':
    case 'joint_vel':
    case 'command':
      return name;
    case 'actions':
    case 'last_action':
      return 'last_action';
    default:
      throw new Error(`unknown observation segment '${layoutEntry}'`);
  }
}

/** Percentile of an unsorted sample (linear interpolation), in input units. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** True when every entry is finite. */
export function allFinite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}
