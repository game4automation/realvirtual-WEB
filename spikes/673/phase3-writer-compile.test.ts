// plan-673 Phase 3 — MUJOCO AS THE JUDGE.
//
//   node scripts/with-test-lock.mjs vitest run -c spikes/673/vitest.config.ts \
//     -t "mujoco as the judge"
//
// The golden in `P/tests/mjcf-writer-golden.node.test.ts` compares two XML
// documents with a reader of its own. This file does the thing that reader
// cannot: it hands both documents to MuJoCo and asks MuJoCo.
//
// Why that is the stronger witness, and why it belongs here rather than in the
// normal suite:
//
//  1. COMPILING IS A TEST. MuJoCo's own compiler checks every name, every
//     reference, the number of `size` components per geom type, that a moving
//     body has a mass and an inertia, that a `polycoef` names two real joints,
//     that an actuator's joint exists. A document that compiles has passed a few
//     hundred assertions nobody had to write.
//  2. `qfrc_bias` AT ZERO VELOCITY IS THE GRAVITY TERM — the RNEA term of
//     plan-412, which MuJoCo computes for free. It is a function of the body
//     tree, the frames, the masses and the centres of mass, and of NOTHING else:
//     not of the inertia tensors, not of the contacts, not of the actuators. So
//     comparing it between the hand-written model (eleven nested bodies) and the
//     written one (eight, because the writer welds the jointless nodes) is a
//     direct test that welding a `MechanismBody` with `mergePointMass` really
//     does produce the same composite body — and MuJoCo, not the test, does the
//     arithmetic.
//  3. `@mujoco/mujoco` is installed out of band (`spikes/659/ensure-deps.mjs`),
//     which is exactly why the normal suites must not reach it.
import { describe, expect, it } from 'vitest';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';
import { writeMjcf } from '@rv-private/mujoco/rv-mjcf-writer';
// Registers the `MechanismBody` factory — the scene builder's caller contract.
import '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { buildPegGameMjcf } from './peg-game-model';
import { buildPegGameScene } from './peg-game-scene';

/** The Phase-1 force limits, so both documents carry the same ones. */
const FORCE_RANGE_NM = [20, 370, 95, 20, 20, 20];

function handWritten(): string {
  return buildPegGameMjcf({ forceRangeNm: FORCE_RANGE_NM, roundSegments: 12 }).xml;
}

function written(opts: { withFloor?: boolean } = {}): { xml: string; problems: string[] } {
  const scene = buildPegGameScene({
    forceRangeNm: FORCE_RANGE_NM, roundSegments: 12, withFloor: opts.withFloor ?? false,
  });
  const doc = writeMjcf({ region: scene.region });
  return { xml: doc.xml, problems: doc.problems.map((p) => `${p.severity} ${p.code}@${p.node}`) };
}

describe('mujoco as the judge (plan-673 Phase 3)', () => {
  it('compiles the written document at all — the first and cheapest assertion', async () => {
    const { xml, problems } = written();
    const world = await RVMuJoCoWorld.load(xml);
    try {
      expect(world.nbody).toBeGreaterThan(1);
      expect(world.timestep).toBe(0.002);
      // No error-level refusal on a model that was measured and works.
      expect(problems.filter((p) => p.startsWith('error '))).toEqual([]);
    } finally {
      world.dispose();
    }
  });

  it('builds the same state space as the hand-written model: nq, nv, nu, ngeom', async () => {
    const hand = await RVMuJoCoWorld.load(handWritten());
    const mine = await RVMuJoCoWorld.load(written().xml);
    try {
      // 6 hinges + 2 slides + 2 free joints = 22 position / 20 velocity dofs.
      expect([mine.nq, mine.nv]).toEqual([hand.nq, hand.nv]);
      expect(mine.nq).toBe(22);
      expect(mine.nv).toBe(20);
      // 6 axis servos + 1 gripper setpoint, however it is attached.
      expect(mine.nu).toBe(hand.nu);
      expect(mine.nu).toBe(7);
      // One geom fewer: the hand-written model's floor is a `plane`, which is not
      // one of the five CollisionShapeSet kinds (named as a gap in the report).
      expect(mine.ngeom).toBe(hand.ngeom - 1);
      // ...and three bodies fewer: `base`, `TCP` and `gripper` carry no joint, so
      // the writer welds them instead of spending a kinematic row on each.
      expect(mine.nbody).toBe(hand.nbody - 3);
    } finally {
      hand.dispose();
      mine.dispose();
    }
  });

  it('carries the same total mass and the same mass per moving link', async () => {
    const hand = await RVMuJoCoWorld.load(handWritten());
    const mine = await RVMuJoCoWorld.load(written().xml);
    try {
      expect(mine.totalMass()).toBeCloseTo(hand.totalMass(), 6);
      expect(mine.totalMass()).toBeCloseTo(40.9, 6);
      // Per link, where both documents have a body of that name. A1..A5 are
      // single links; A6 is the composite of A6 + TCP + gripper in the written
      // document, so it is checked through the gravity term below instead.
      for (const name of ['A1', 'A2', 'A3', 'A4', 'A5', 'part', 'board']) {
        const h = hand.bodyMass(hand.mustFind('body', name));
        const m = mine.bodyMass(mine.mustFind('body', name));
        expect(m, `${name} mass`).toBeCloseTo(h, 9);
      }
      // The welded chain: A6 + TCP's 0 + gripper's 0.5 kg.
      const a6 = mine.bodyMass(mine.mustFind('body', 'A6'));
      expect(a6).toBeCloseTo(1.0 + 0.5, 9);
    } finally {
      hand.dispose();
      mine.dispose();
    }
  });

  it('produces the SAME GRAVITY TORQUES as the hand-written model, in every pose tested',
    async () => {
      const hand = await RVMuJoCoWorld.load(handWritten());
      const mine = await RVMuJoCoWorld.load(written().xml);
      try {
        // Six axis poses, in radians. The first is the home pose; the rest bend the
        // arm so that every link contributes a different lever arm — a composite
        // body with the right mass but the wrong centre of mass passes the home
        // pose and fails the others.
        const poses: number[][] = [
          [0, 0, 0, 0, 0, 0],
          [0, 0.4, -0.3, 0, 0.5, 0],
          [0.7, -0.6, 0.9, 0.3, -0.4, 1.1],
          [1.5, 1.0, -1.0, 0, 0, 0],
          [-0.9, 0.2, 0.6, -1.2, 0.8, -0.5],
          [0, Math.PI / 2, -Math.PI / 2, 0, Math.PI / 2, 0],
        ];
        const axes = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
        const handAdr = axes.map((a) => hand.jointQposAdr(hand.mustFind('joint', a)));
        const mineAdr = axes.map((a) => mine.jointQposAdr(mine.mustFind('joint', a)));
        const handDof = axes.map((a) => hand.jointDofAdr(hand.mustFind('joint', a)));
        const mineDof = axes.map((a) => mine.jointDofAdr(mine.mustFind('joint', a)));
        let maxDelta = 0;
        for (const pose of poses) {
          for (let i = 0; i < 6; i++) {
            hand.writeQpos(handAdr[i], [pose[i]]);
            mine.writeQpos(mineAdr[i], [pose[i]]);
          }
          hand.forward();
          mine.forward();
          const hb = hand.readQfrcBias();
          const mb = mine.readQfrcBias();
          for (let i = 0; i < 6; i++) {
            const delta = Math.abs(hb[handDof[i]] - mb[mineDof[i]]);
            maxDelta = Math.max(maxDelta, delta);
            // 1e-6 N·m against holding torques of up to ~150 N·m: the two models
            // are the same rigid-body tree, not merely a similar one.
            expect(delta, `${axes[i]} in pose [${pose.join(', ')}]`).toBeLessThan(1e-6);
          }
        }
        // eslint-disable-next-line no-console
        console.log(`[phase3] worst gravity-torque difference over 6 poses x 6 axes: `
          + `${maxDelta.toExponential(2)} N·m`);
      } finally {
        hand.dispose();
        mine.dispose();
      }
    });

  it('keeps the segmented board off the floor class — the 112-contact finding, measured',
    async () => {
      // Finding 3, through the writer and through MuJoCo: the board is 28 plate
      // primitives on one plane plus ONE foot. If the plate segments shared the
      // floor's collision class, this model would carry well over a hundred
      // contacts that say nothing.
      const world = await RVMuJoCoWorld.load(written({ withFloor: true }).xml);
      try {
        let maxNcon = 0;
        for (let i = 0; i < 400; i++) {
          world.step();
          maxNcon = Math.max(maxNcon, world.ncon);
        }
        // eslint-disable-next-line no-console
        console.log(`[phase3] max ncon over 400 steps with the floor present: ${maxNcon}`);
        expect(maxNcon).toBeLessThan(60);
      } finally {
        world.dispose();
      }
    });
});
