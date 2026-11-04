// plan-659 test 9.7 — policy parity against the Phase-0 Python reference.
//
// Two stages, exactly as the plan specifies them:
//   stage 1: raw state        → TS observation = Python observation (1e-5)
//   stage 2: Python observation → ORT action    = Python action      (1e-4)
//
// Stage 2 deliberately feeds the PYTHON observation, not ours: a bug in the
// observation build would otherwise be able to hide behind a matching action.
// A third assertion chains both (our observation → our action) so the end-to-end
// path is covered too.
//
// This is the foundation of everything else in Phase 1: without it, any
// distance measurement is meaningless.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RVLocomotionPolicy } from '@rv-private/mujoco/rv-locomotion-policy';
import {
  loadMicroduckPolicy,
  loadReference,
  type MicroduckFixture,
  type MicroduckReference,
} from './rv-microduck-runtime';

const OBS_TOLERANCE = 1e-5;
const ACTION_TOLERANCE = 1e-4;

describe('9.7 Microduck policy parity (Python reference)', () => {
  let reference: MicroduckReference;
  let policy: RVLocomotionPolicy;

  beforeAll(async () => {
    reference = loadReference();
    policy = await loadMicroduckPolicy('walking', reference.meta.contract);
  });

  afterAll(async () => {
    await policy?.dispose();
  });

  it('has the fixtures and the contract Phase 0 produced', () => {
    expect(reference.fixtures.length).toBeGreaterThanOrEqual(5);
    expect(reference.meta.contract.obs_size).toBe(61);
    expect(reference.meta.contract.action_size).toBe(14);
    expect(reference.meta.contract.command_size).toBe(13);
    expect(reference.meta.contract.decimation).toBe(4);
    expect(reference.meta.contract.timestep).toBeCloseTo(0.005, 12);
  });

  it('stage 1: raw state produces the Python observation', () => {
    const maxErrors: number[] = [];
    for (const fixture of reference.fixtures) {
      const obs = observationOf(policy, fixture);
      maxErrors.push(maxAbsDiff(obs, fixture.expected.observation));
    }
    const worst = Math.max(...maxErrors);
    // eslint-disable-next-line no-console
    console.log(`[9.7] observation max |delta| = ${worst.toExponential(3)}`);
    expect(worst).toBeLessThan(OBS_TOLERANCE);
  });

  it('stage 2: the Python observation produces the Python action', async () => {
    const maxErrors: number[] = [];
    for (const fixture of reference.fixtures) {
      policy.reset();
      const action = await policy.infer(Float32Array.from(fixture.expected.observation));
      expect(action).not.toBeNull();
      maxErrors.push(maxAbsDiff(action as Float32Array, fixture.expected.action));
    }
    const worst = Math.max(...maxErrors);
    // eslint-disable-next-line no-console
    console.log(`[9.7] action max |delta| = ${worst.toExponential(3)}`);
    expect(worst).toBeLessThan(ACTION_TOLERANCE);
  });

  it('end to end: raw state produces the Python action and ctrl target', async () => {
    const obsErrors: number[] = [];
    const actionErrors: number[] = [];
    const ctrlErrors: number[] = [];
    for (const fixture of reference.fixtures) {
      const obs = observationOf(policy, fixture);
      obsErrors.push(maxAbsDiff(obs, fixture.expected.observation));
      const action = await policy.infer(obs);
      expect(action).not.toBeNull();
      actionErrors.push(maxAbsDiff(action as Float32Array, fixture.expected.action));
      const ctrl = policy.actionToCtrl(action as Float32Array);
      ctrlErrors.push(maxAbsDiff(ctrl, fixture.expected.ctrl_position_target));
    }
    // eslint-disable-next-line no-console
    console.log(
      `[9.7] end-to-end max |delta|: obs ${Math.max(...obsErrors).toExponential(3)}, ` +
        `action ${Math.max(...actionErrors).toExponential(3)}, ` +
        `ctrl ${Math.max(...ctrlErrors).toExponential(3)}`,
    );
    expect(Math.max(...actionErrors)).toBeLessThan(ACTION_TOLERANCE);
    expect(Math.max(...ctrlErrors)).toBeLessThan(ACTION_TOLERANCE);
  });

  it('rejects a non-finite policy output instead of writing it to ctrl', async () => {
    const config = {
      jointNames: ['a', 'b'],
      defaultJointPos: [0, 0],
      actionScale: 1,
      decimation: 1,
      physicsDt: 0.005,
      observationSize: 2,
      commandSize: 0,
      observationLayout: ['joint_pos', 'joint_vel'] as const,
    };
    const nanPolicy = await RVLocomotionPolicy.load(new Uint8Array(0), config).catch(() => null);
    // The real session cannot be built from empty bytes — the NaN guard is
    // checked on the policy that CAN load, by feeding a NaN observation and
    // asserting the guard path on the action instead.
    expect(nanPolicy).toBeNull();
    const action = await policy.infer(new Float32Array(61).fill(Number.NaN));
    expect(action).toBeNull();
    expect(Array.from(policy.lastActionView).every(Number.isFinite)).toBe(true);
  });
});

/** Feed a fixture's raw state + carried last action/command into the policy and
 *  assemble the observation. `lastAction` is injected by replaying it as the
 *  previous step's output is not available to the test. */
function observationOf(policy: RVLocomotionPolicy, fixture: MicroduckFixture): Float32Array {
  policy.reset();
  injectLastAction(policy, fixture.input.last_action);
  policy.setCommand(fixture.input.command);
  return policy.buildObservation({
    baseAngVel: fixture.input.raw_state.base_ang_vel_gyro,
    baseQuat: fixture.input.raw_state.base_quat_xquat_wxyz,
    jointPos: fixture.input.raw_state.joint_pos,
    jointVel: fixture.input.raw_state.joint_vel,
  });
}

/** `lastAction` is private state of the policy (it is the policy's own previous
 *  output). The fixture carries it, so the test writes it through the readonly
 *  view's backing array — the one place a test legitimately reaches in. */
function injectLastAction(policy: RVLocomotionPolicy, values: readonly number[]): void {
  const view = policy.lastActionView as Float32Array;
  view.set(values);
}

function maxAbsDiff(actual: ArrayLike<number>, expected: readonly number[]): number {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > worst) worst = d;
  }
  return worst;
}
