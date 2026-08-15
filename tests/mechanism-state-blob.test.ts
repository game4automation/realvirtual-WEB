// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T2 — Mechanism topology + state-blob wire format (plan-404 §2.3, §9).
 *
 * Two layers, deliberately separated:
 *
 *  1. STRUCTURAL (always runs) — the topology port and the blob layout are
 *     checked against ABI.md's own rules: header fields, block order, block
 *     strides, the two documented total-size formulas, and the indexing
 *     conventions that differ between block 4 (Q-index, passive only) and
 *     blocks 9/10 (tree-dof index, all dofs). This is what catches a port that
 *     drifted from the C# original.
 *
 *  2. GOLDEN (fixture-guarded) — byte comparison against the ints/floats dumps
 *     the Unity EditMode fixture generator produces (plan-404 Phase 0). Those
 *     fixtures do not exist yet, so these cases SKIP with an explicit message
 *     rather than silently passing. See `requireFixture` below.
 */

import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { buildTopology, buildLinkTable, jointTypeWireValue }
  from '@rv-private/kinematic-mechanism/rv-kinematic-topology';
import { exportMechanismStateBlob, KINEMATIC_FORMAT_VERSION }
  from '@rv-private/kinematic-mechanism/rv-kinematic-state-export';
import {
  CONTROLLER_SCALE, fourBarRig, freeBodyRig, singleRevoluteRig, makeJoint, makeLink,
  type Rig,
} from './_mechanism-rigs';

// ─── Fixture guard (plan-404 Phase 0) ───────────────────────────────────────

/**
 * Golden blobs are produced by the Unity EditMode fixture generator and checked
 * in under `tests/fixtures/mechanism/`. Until Phase 0 has run they are absent,
 * and a fixture-dependent case must SKIP LOUDLY — never pass by default, which
 * would turn the strongest parity check in the suite into a no-op.
 *
 * Regenerate with the Unity menu command documented in the fixture header:
 *   realvirtual DEV/Testing/Kinematics/Dump Mechanism Golden Fixtures
 */
async function loadFixture(name: string): Promise<{ ints: number[]; floats: number[] } | null> {
  try {
    const res = await fetch(`/tests/fixtures/mechanism/${name}.json`);
    if (!res.ok) return null;
    return await res.json() as { ints: number[]; floats: number[] };
  } catch {
    return null;
  }
}

function skipWithoutFixture(fixture: unknown, name: string, ctx: { skip: (note?: string) => void }): void {
  if (!fixture) {
    ctx.skip(`golden fixture "${name}" missing — plan-404 Phase 0 (Unity EditMode dump) has not run yet`);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function build(rig: Rig) {
  const result = buildTopology(rig.joints, rig.links, rig.worldNodeUsed, CONTROLLER_SCALE);
  if (!result.ok) throw new Error(`topology failed: ${result.error}`);
  return result.topology;
}

// ─── 1. Topology port ───────────────────────────────────────────────────────

describe('T2 — topology port (KinematicSolver.Initialize)', () => {
  it('roots an ungrounded mechanism at the first joint\'s Body A', () => {
    const topo = build(singleRevoluteRig());
    expect(topo.rootLinkIndex).toBe(0);
    expect(topo.treeDofs).toHaveLength(1);
    expect(topo.treeDofs[0].childLinkIndex).toBe(1);
    expect(topo.treeDofs[0].isActive).toBe(true);
    // An active dof is not an unknown, so it gets no q slot.
    expect(topo.treeDofs[0].qIndex).toBe(-1);
    expect(topo.qCount).toBe(0);
  });

  it('roots a world-grounded mechanism at the synthetic world frame', () => {
    const topo = build(fourBarRig());
    expect(topo.rootLinkIndex).toBe(-1);
  });

  it('an open chain produces NO loop residuals (solver fast path)', () => {
    const topo = build(singleRevoluteRig());
    expect(topo.loopResiduals).toHaveLength(0);
    expect(topo.residualCount).toBe(0);
  });

  it('a four-bar closes exactly one loop, with 5 residual rows for a Revolute', () => {
    const topo = build(fourBarRig());
    expect(topo.loopResiduals).toHaveLength(1);
    expect(topo.loopResiduals[0].residualCount).toBe(5);
    expect(topo.residualCount).toBe(5);
    // Three tree edges reach the three links; the fourth joint closes the loop.
    expect(topo.treeDofs).toHaveLength(3);
  });

  it('assigns passive q indices in tree-dof order, free-body slots after them', () => {
    const topo = build(fourBarRig());
    const passive = topo.treeDofs.filter((d) => !d.isActive);
    expect(passive.map((d) => d.qIndex)).toEqual([0, 1]);
    expect(topo.qJointIndices).toHaveLength(2);
    expect(topo.qCount).toBe(2); // no free bodies here
  });

  it('a link reachable only through a Spherical joint becomes a FREE BODY', () => {
    const topo = build(freeBodyRig());
    expect(topo.freeBodyDofs).toHaveLength(1);
    expect(topo.freeBodyDofs[0].linkIndex).toBe(2);
    // Six contiguous coordinates per free body, right after the passive tree q.
    expect(topo.freeBodyDofs[0].qIndexRot).toBe(topo.freeBodyDofs[0].qIndexPos + 3);
    expect(topo.qCount).toBe(topo.qJointIndices.length + 6);
    // A free body's pose comes from its own dofs, never from a tree ancestry.
    expect(topo.linkAncestorDofs[2]).toEqual([]);
    expect(topo.linkFreeBodyIndex[2]).toBe(0);
  });

  it('free-body initial position is stored in MILLIMETRES', () => {
    const topo = build(freeBodyRig());
    // Platform sits at (0.5, -0.3, 0) m → (500, -300, 0) mm.
    expect(topo.freeBodyDofs[0].initialPosMm.x).toBeCloseTo(500, 6);
    expect(topo.freeBodyDofs[0].initialPosMm.y).toBeCloseTo(-300, 6);
  });

  it('ancestor chains walk from the link up to the root', () => {
    const topo = build(fourBarRig());
    // Coupler (link 1) is reached through Crank, so its chain has two dofs.
    expect(topo.linkAncestorDofs[1].length).toBe(2);
    expect(topo.linkAncestorDofs[0].length).toBe(1);
  });

  it('charLengthMm is the largest anchor-to-anchor span, never below 1', () => {
    const topo = build(singleRevoluteRig());
    // Base at origin, Arm 0.5 m away → 500 mm.
    expect(topo.charLengthMm).toBeCloseTo(500, 3);

    // Degenerate rig: everything at the origin still yields at least 1 mm, so
    // the angular-residual normalisation can never divide by zero.
    const degenerate = buildTopology(
      [makeJoint({ bodyA: 0, bodyB: 1 })],
      [makeLink('A'), makeLink('B')],
      false, CONTROLLER_SCALE,
    );
    expect(degenerate.ok && degenerate.topology.charLengthMm).toBe(1);
  });

  it('mm/Unity conversion factors follow the controller scale', () => {
    const topo = build(singleRevoluteRig());
    expect(topo.unityToMm).toBe(CONTROLLER_SCALE);
    expect(topo.mmToUnity).toBeCloseTo(1 / CONTROLLER_SCALE, 12);
  });

  it('rejects a second independent grounding point instead of guessing', () => {
    // A mechanism rooted at a real link that ALSO grounds to world elsewhere has
    // two independent fixed frames — unsolvable in V1. The BFS meets it as
    // "the world node appeared as a CHILD", and the port must report it rather
    // than silently picking one of the two grounds.
    const result = buildTopology(
      [
        makeJoint({ name: 'J1', bodyA: 0, bodyB: 1 }),
        makeJoint({ name: 'Ground', bodyA: -1, bodyB: 1 }),
      ],
      [makeLink('A'), makeLink('B')],
      false, CONTROLLER_SCALE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/grounding points/);
  });

  it('buildLinkTable reproduces Unity discovery order (Body A then Body B)', () => {
    const table = buildLinkTable([
      { bodyA: 'Base', bodyB: 'Arm' },
      { bodyA: 'Arm', bodyB: 'Tool' },
      { bodyA: null, bodyB: 'Base' },
    ]);
    expect(table.order).toEqual(['Base', 'Arm', 'Tool']);
    expect(table.indexOf.get('Tool')).toBe(2);
  });

  it('the joint-type wire encoding is the crate\'s own stable mapping', () => {
    // Deliberately NOT the C# enum ordinal — a future enum reorder must not be
    // able to silently desync the wire format (ABI.md "JointType wire values").
    expect(jointTypeWireValue('Spherical')).toBe(0);
    expect(jointTypeWireValue('Revolute')).toBe(1);
    expect(jointTypeWireValue('Prismatic')).toBe(2);
    expect(jointTypeWireValue('Universal')).toBe(3);
  });
});

// ─── 2. Blob layout ─────────────────────────────────────────────────────────

describe('T2 — state blob wire format (ABI.md)', () => {
  it('writes FormatVersion 3 and a header that matches the topology', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    const { ints } = exportMechanismStateBlob(topo, rig.joints);

    expect(ints[0]).toBe(KINEMATIC_FORMAT_VERSION);
    expect(ints[0]).toBe(3);
    expect(ints[1]).toBe(topo.linkCount);
    expect(ints[2]).toBe(topo.rootLinkIndex);
    expect(ints[3]).toBe(rig.joints.length);
    expect(ints[4]).toBe(topo.treeDofs.length);
    expect(ints[5]).toBe(topo.qJointIndices.length);
    expect(ints[6]).toBe(topo.freeBodyDofs.length);
    expect(ints[7]).toBe(topo.loopResiduals.length);
    expect(ints[8]).toBe(topo.qCount);
    expect(ints[9]).toBe(topo.residualCount);
  });

  it('total sizes match the two formulas ABI.md states', () => {
    for (const rig of [singleRevoluteRig(), fourBarRig(), freeBodyRig()]) {
      const topo = build(rig);
      const { ints, floats } = exportMechanismStateBlob(topo, rig.joints);
      const td = topo.treeDofs.length;
      const qj = topo.qJointIndices.length;
      const lr = topo.loopResiduals.length;
      const fb = topo.freeBodyDofs.length;
      const anc = topo.linkAncestorDofs.reduce((n, c) => n + c.length, 0);

      // v3 (plan-412): LoopResidual records carry a 6th int (the owning joint index) and a
      // 10-float LinkMass record per link is appended.
      expect(ints.length).toBe(11 + td * 6 + lr * 6 + fb * 3 + qj + topo.linkCount * 3 + anc + td * 2);
      expect(floats.length).toBe(
        3 + td * 14 + qj * 2 + lr * 21 + fb * 7 + td * 4 + topo.linkCount * 10);
    }
  });

  it('the float header carries mmToUnity, unityToMm, charLengthMm in that order', () => {
    const rig = singleRevoluteRig();
    const topo = build(rig);
    const { floats } = exportMechanismStateBlob(topo, rig.joints);
    expect(floats[0]).toBeCloseTo(1 / CONTROLLER_SCALE, 6);
    expect(floats[1]).toBe(CONTROLLER_SCALE);
    expect(floats[2]).toBeCloseTo(500, 2);
  });

  it('block 4 (QLimits) is Q-INDEXED and covers only PASSIVE dofs', () => {
    const rig = fourBarRig();
    // Give the two passive joints distinguishable limits.
    rig.joints[1].useLimits = true;
    rig.joints[2].useLimits = false;
    const topo = build(rig);
    const { ints } = exportMechanismStateBlob(topo, rig.joints);

    const td = topo.treeDofs.length;
    const lr = topo.loopResiduals.length;
    const fb = topo.freeBodyDofs.length;
    const qBlockStart = 11 + td * 6 + lr * 6 + fb * 3; // LoopResidual is 6 ints in v3
    const qBlock = Array.from(ints.slice(qBlockStart, qBlockStart + topo.qJointIndices.length));
    // One entry per PASSIVE dof, in q-index order — not one per joint.
    expect(qBlock).toHaveLength(topo.qJointIndices.length);
    expect(qBlock).toEqual(topo.qJointIndices.map((j) => (rig.joints[j].useLimits ? 1 : 0)));
  });

  it('blocks 9/10 are TREE-DOF-INDEXED and cover EVERY dof, active included', () => {
    const rig = fourBarRig();
    rig.joints[0].useLimits = true;          // the ACTIVE joint
    rig.joints[0].driveUseLimits = true;
    rig.joints[0].driveLowerLimit = -45;
    rig.joints[0].driveUpperLimit = 45;
    const topo = build(rig);
    const { ints, floats } = exportMechanismStateBlob(topo, rig.joints);

    const td = topo.treeDofs.length;
    const block10Start = ints.length - td;        // TreeDofDriveUseLimits
    const block9Start = block10Start - td;        // TreeDofJointUseLimits
    const jointUse = Array.from(ints.slice(block9Start, block9Start + td));
    const driveUse = Array.from(ints.slice(block10Start));

    expect(jointUse).toHaveLength(td);
    expect(driveUse).toHaveLength(td);
    // Inverse mode frees active dofs too — an ACTIVE dof's limits must be here,
    // which is exactly what block 4 above structurally cannot express.
    expect(jointUse).toEqual(topo.treeDofs.map((d) => (rig.joints[d.jointIndex].useLimits ? 1 : 0)));
    expect(driveUse).toEqual(topo.treeDofs.map((d) =>
      (d.isActive && rig.joints[d.jointIndex].driveUseLimits ? 1 : 0)));
    expect(driveUse.some((v) => v === 1)).toBe(true);

    // Float blocks 5/6 use the same indexing; a passive dof's drive limits are 0/0.
    // In v3 the LinkMass block sits BEHIND them, so the tail offset accounts for it.
    const f6Start = floats.length - topo.linkCount * 10 - td * 2;
    const f5Start = f6Start - td * 2;
    for (let i = 0; i < td; i++) {
      const dof = topo.treeDofs[i];
      expect(floats[f5Start + i * 2]).toBeCloseTo(rig.joints[dof.jointIndex].lowerLimit, 4);
      if (!dof.isActive) {
        expect(floats[f6Start + i * 2]).toBe(0);
        expect(floats[f6Start + i * 2 + 1]).toBe(0);
      }
    }
  });

  it('a mechanism without free bodies emits a ZERO-LENGTH free-body block', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    const blob = exportMechanismStateBlob(topo, rig.joints);
    expect(blob.sizes.freeBodyCount).toBe(0);
    // ABI.md explicitly accepts a null/zero-length free_body_rot for exactly
    // this case (four-bar, scissor, slider-crank) — it must not be padded.
    expect(blob.sizes.invQCount).toBe(topo.treeDofs.length);
  });

  it('invQCount is treeDofCount + 6·freeBodyCount (larger than forward qCount)', () => {
    const rig = freeBodyRig();
    const topo = build(rig);
    const blob = exportMechanismStateBlob(topo, rig.joints);
    expect(blob.sizes.invQCount).toBe(topo.treeDofs.length + 6 * topo.freeBodyDofs.length);
    // Inverse mode has no active/passive split, so it is generally LARGER.
    expect(blob.sizes.invQCount).toBeGreaterThan(blob.sizes.qCount - 6 * topo.freeBodyDofs.length);
  });

  it('bakes the normalized axes, and keeps unused residual rows as zeros', () => {
    const rig = fourBarRig();
    rig.joints[3].axisA = new Vector3(0, 0, 7); // deliberately unnormalized
    const topo = build(rig);
    const { floats } = exportMechanismStateBlob(topo, rig.joints);

    const td = topo.treeDofs.length;
    const qj = topo.qJointIndices.length;
    const loopStart = 3 + td * 14 + qj * 2;
    // Record layout: AnchorA(3) AnchorB(3) AxisALocalRaw(3) …
    const axisRaw = [floats[loopStart + 6], floats[loopStart + 7], floats[loopStart + 8]];
    expect(Math.hypot(...axisRaw)).toBeCloseTo(1, 5);

    // TwistRef* are Prismatic-only; for a Revolute loop they stay zero but the
    // record stride is unchanged (21 floats), which is what the reader expects.
    const twistRefA = [floats[loopStart + 12], floats[loopStart + 13], floats[loopStart + 14]];
    expect(twistRefA).toEqual([0, 0, 0]);
  });

  it('a Prismatic loop joint DOES get anti-twist reference axes', () => {
    // Prismatic joints CAN be spanning-tree edges, so a rig where the Prismatic
    // merely exists is not enough — both its links must already be reachable
    // when the BFS meets it, which is what makes it a loop closure.
    const links = [makeLink('A', 0.1, 0, 0), makeLink('B', 0.2, 0, 0)];
    const joints = [
      makeJoint({ name: 'G1', bodyA: -1, bodyB: 0, isDriven: true }),
      makeJoint({ name: 'G2', bodyA: -1, bodyB: 1 }),
      makeJoint({ name: 'Slide', jointType: 'Prismatic', bodyA: 0, bodyB: 1,
        axisA: new Vector3(1, 0, 0) }),
    ];
    const result = buildTopology(joints, links, true, CONTROLLER_SCALE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const topo = result.topology;
    expect(topo.loopResiduals).toHaveLength(1);
    expect(topo.loopResiduals[0].jointType).toBe('Prismatic');

    const { floats } = exportMechanismStateBlob(topo, joints);
    const td = topo.treeDofs.length;
    const qj = topo.qJointIndices.length;
    const loopStart = 3 + td * 14 + qj * 2;
    const twistRefA = [floats[loopStart + 12], floats[loopStart + 13], floats[loopStart + 14]];
    expect(Math.hypot(...twistRefA)).toBeCloseTo(1, 5);
  });

  it('emits Int32Array / Float32Array — the exact types rvk_create reads', () => {
    const rig = singleRevoluteRig();
    const blob = exportMechanismStateBlob(build(rig), rig.joints);
    expect(blob.ints).toBeInstanceOf(Int32Array);
    expect(blob.floats).toBeInstanceOf(Float32Array);
  });
});

// ─── 2b. Wire v3 — mass block and loop joint index (plan-412 §9.4) ──────────

describe('T2 — wire v3 dynamics blocks', () => {
  /** Offset of the LinkMass block: it is the LAST float block. */
  const massBlockStart = (floats: Float32Array, linkCount: number) =>
    floats.length - linkCount * 10;

  it('appends exactly one LinkMass record per LINK, sentinel where no mass is authored', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    // No link carries a MechanismBody, so every record must be the sentinel — NOT an omitted
    // block. The blob is sequential; an "optional" block would shift every following offset.
    const { floats } = exportMechanismStateBlob(topo, rig.joints);
    const start = massBlockStart(floats, topo.linkCount);
    expect(floats.length - start).toBe(topo.linkCount * 10);
    for (let i = 0; i < topo.linkCount; i++) {
      expect(floats[start + i * 10]).toBe(-1);
    }
    expect(topo.massesComplete).toBe(false);
  });

  it('writes authored masses in AUTHORING units — the SI conversion belongs to the core', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    // Mass on every link, with one distinctive record to read back.
    topo.linkMasses = topo.linkMasses.map(() => ({
      massKg: 2.5,
      comLocalMm: new Vector3(10, -20, 30),
      inertiaLocalKgMm2: [1000, 2000, 3000, 10, 20, 30],
    }));
    topo.massesComplete = true;
    const { floats } = exportMechanismStateBlob(topo, rig.joints);
    const start = massBlockStart(floats, topo.linkCount);

    expect(floats[start]).toBeCloseTo(2.5, 6);
    // Millimetres, NOT metres: converting here as well would be invisible in a ratio and wrong by
    // a factor of 1e-3 in every reported force (ABI.md floats block 7).
    expect(floats[start + 1]).toBeCloseTo(10, 4);
    expect(floats[start + 2]).toBeCloseTo(-20, 4);
    expect(floats[start + 3]).toBeCloseTo(30, 4);
    // kg·mm², likewise unconverted.
    expect(floats[start + 4]).toBeCloseTo(1000, 2);
    expect(floats[start + 9]).toBeCloseTo(30, 2);
  });

  it('mixed authored/missing masses keep their LINK INDEX alignment', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    topo.linkMasses = topo.linkMasses.map((_, i) => (i === 1
      ? { massKg: 7, comLocalMm: new Vector3(), inertiaLocalKgMm2: [1, 1, 1, 0, 0, 0] }
      : null));
    const { floats } = exportMechanismStateBlob(topo, rig.joints);
    const start = massBlockStart(floats, topo.linkCount);
    const masses = Array.from({ length: topo.linkCount }, (_, i) => floats[start + i * 10]);
    expect(masses[1]).toBeCloseTo(7, 6);
    for (let i = 0; i < topo.linkCount; i++) {
      if (i !== 1) expect(masses[i]).toBe(-1);
    }
  });

  it('every LoopResidual record carries its owning joint index', () => {
    const rig = fourBarRig();
    const topo = build(rig);
    const { ints } = exportMechanismStateBlob(topo, rig.joints);
    const td = topo.treeDofs.length;
    const loopStart = 11 + td * 6;
    expect(topo.loopResiduals.length).toBeGreaterThan(0);
    topo.loopResiduals.forEach((lr, i) => {
      // The dynamics reports one reaction wrench per JOINT; without this the multipliers of a
      // closure could not be attributed to the joint the user selected in the panel.
      expect(ints[loopStart + i * 6 + 5]).toBe(lr.jointIndex);
    });
  });
});

// ─── 3. Golden fixtures (Phase 0) ───────────────────────────────────────────

/**
 * Reduce a FormatVersion 3 blob to the v2 shape the Unity EditMode generator still produces.
 *
 * WHY THIS EXISTS (plan-412). The blob has three writers and one reader. plan-412 moved the
 * TypeScript writer to v3 (per-link mass block + the loop joint index the dynamics needs) and
 * deliberately left the Unity C# writer on v2 — Unity-side authoring of mass properties is
 * explicitly out of that plan's scope, and the Rust reader accepts BOTH versions precisely so the
 * two can move independently.
 *
 * The golden fixtures are therefore v2 and cannot be regenerated from this side. The alternative
 * to this function would be skipping the parity test, which would silently retire the ONE guard
 * that catches a TypeScript/Unity topology divergence — the exact failure the fixtures exist for.
 * Stripping the v3-only additions keeps that guard at full strength: everything the two writers
 * still share is compared bit-for-bit, and the parts that legitimately differ are named here
 * rather than quietly tolerated.
 */
function downgradeToV2(
  blob: { ints: Int32Array; floats: Float32Array },
  topo: { loopResiduals: unknown[]; treeDofs: unknown[]; linkCount: number },
): { ints: number[]; floats: number[] } {
  const td = topo.treeDofs.length;
  const lr = topo.loopResiduals.length;
  const ints = Array.from(blob.ints);
  // Drop the 6th int of every LoopResidual record, back to front so the earlier offsets hold.
  const loopStart = 11 + td * 6;
  for (let i = lr - 1; i >= 0; i--) ints.splice(loopStart + i * 6 + 5, 1);
  ints[0] = 2;
  // The LinkMass block is the last thing in the float array.
  const floats = Array.from(blob.floats).slice(0, blob.floats.length - topo.linkCount * 10);
  return { ints, floats };
}

describe('T2 — golden blob parity against the Unity dump', () => {
  for (const name of ['fourbar', 'scissor', 'delta']) {
  it(`matches the ${name} golden blob (v3 reduced to the v2 the Unity writer emits)`, async (ctx) => {
    const fixture = await loadFixture(name);
    skipWithoutFixture(fixture, name, ctx);
    if (!fixture) return;

    // The fixture header carries the KinematicSolver.cs source hash; a drift
    // without regeneration is caught Unity-side by the freshness test (plan-404
    // §5.3), so this side only has to compare.
    const rig = name === 'fourbar' ? fourBarRig() : name === 'delta' ? freeBodyRig() : singleRevoluteRig();
    const topo = build(rig);
    const v3 = exportMechanismStateBlob(topo, rig.joints);
    const blob = downgradeToV2(v3, topo);

    // Ints are the wire LAYOUT — indices, counts, flags. They must match
    // bit-for-bit; a tolerance there would hide a shifted block.
    expect(blob.ints).toEqual(fixture.ints);

    // Floats get a RELATIVE tolerance, and that is a structural necessity, not
    // a convenience. Both sides store float32, whose spacing grows with the
    // magnitude: at the four-bar's `charLengthMm` ≈ 670.82 one ulp is already
    // 6.1e-5, so an ABSOLUTE `toBeCloseTo(…, 5)` (±5e-6) demands a difference
    // twelve times SMALLER than the smallest difference float32 can represent
    // there — unreachable no matter how correct the port is. C# computes in
    // float32 throughout while JS computes in float64 and narrows once on
    // store, so a chained quaternion product legitimately lands one ulp apart.
    // 1e-6 relative ≈ 8 significant decimal digits, comfortably tighter than
    // float32's ~7, with an absolute floor for values at or near zero.
    expect(blob.floats.length).toBe(fixture.floats.length);
    for (let i = 0; i < fixture.floats.length; i++) {
      const actual = blob.floats[i];
      const expected = fixture.floats[i];
      const tolerance = Math.max(1e-9, 1e-6 * Math.abs(expected));
      expect(
        Math.abs(actual - expected),
        `floats[${i}]: ${actual} vs golden ${expected} (tolerance ${tolerance})`,
      ).toBeLessThanOrEqual(tolerance);
    }
  });
  }
});
