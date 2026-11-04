// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * robot-rig-derive.node.test.ts — plan-773 Phase 0/2: the rig derivation is a
 * MEASUREMENT, and these are the numbers it must produce.
 *
 * ## Why the fixture is the shipped library robot and not a new GLB
 *
 * plan-773 §F.3 asked for a committed fixture, because `DemoRobotIK.glb` — the
 * model the 239.9 mm measurement was taken on — lives only in the private
 * sibling repository, so a gate test against it is ABSENT in exactly the
 * checkout where it would have to bite (green by absence, R3).
 *
 * The fixture it asks for already exists:
 * `public/library/Robots/FanucCRX-10iA-L.glb` is committed, public, and the ONE
 * robot every user of the viewer gets. Adding a second rig fixture would have
 * meant maintaining a synthetic robot nobody ships next to the real one
 * everybody does. So the geometry half below asserts against that file, read
 * with gltf-transform like `robot-library-asset.node.test.ts` does.
 *
 * ## Measured on that file while this test was written (2026-10-23)
 *
 * It carries NINE `Drive` components and **no** `RobotIK`, no `WristType`, no
 * `ToolOffset` and no OPW parameter at all. The derivation path is therefore not
 * the fallback of decision E5 — it is the only path for the robot a first-time
 * user meets, which is why its provenance report is asserted here field by
 * field rather than "it returned some numbers".
 *
 * Since 2026-10-25 the file ships a `RobotIK` — written BY this derivation
 * (`scripts/author-robot-ik.mjs`, Thomas lifted E5 for the library CRX). The
 * geometry below has not changed, so every measurement here still holds.
 *
 * Its chain IS clean: `A1 → A2 → A3 → A4 → A5 → A6` each nested inside the
 * previous, all six rotary, plus a `TCP` node under `A6` — so the shipped robot
 * is riggable as it ships. The three further drives (the Schunk gripper's
 * virtual cylinder and its two linear fingers) are exactly the trap a
 * drive-COUNTING derivation would fall into.
 *
 * ## The two halves
 *
 * 1. the arithmetic, on a hand-built `JointChainParams` whose every expected
 *    value is analytic — a textbook spherical-wrist 6R and the same rig with
 *    its axis 6 moved 150 mm off the wrist line (the CRX's own defect, to the
 *    millimetre). Pure data, no loader, no browser.
 * 2. the authored geometry of the committed GLB, so a re-extraction, a hand
 *    edit or a Draco re-compression that moves an axis fails here.
 *
 * The end-to-end — the tools, on the baked tree — is
 * `tests/robot-mcp-tools.test.ts`, which must use `loadBakedGLB`.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document, type Node as GltfNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import type { JointChainParams } from '../src/core/engine/rv-ik-solver';
import { chainFk, positionErrorMm } from '../src/core/engine/rv-robot-fk';
import {
  chainGeometry, estimateOpwFromChain, measureWristType,
  closestPointBetweenLines, distancePointToLine,
} from '../src/core/engine/rv-robot-rig';

// ─── Half 1: the arithmetic, on an analytic rig ──────────────────────────

/**
 * A textbook OPW robot, built so every expected number below is derivable by
 * hand from these six lines rather than copied out of a run.
 *
 * Home rotations are all identity, so each `axisHomePos` is a plain offset from
 * the previous axis and each `axisDir` is already a robot-local direction:
 *
 *   axis 1  (0,     0,   0)  dir +Y   base, vertical
 *   axis 2  (0.15,  0.4, 0)  dir +Z   shoulder: 0.4 up, 0.15 forward
 *   axis 3  (0,     0.7, 0)  dir +Z   elbow: 0.7 m upper arm, parallel to axis 2
 *   axis 4  (0.05,  0.1, 0)  dir +X   forearm roll
 *   axis 5  (0.5,   0,   0)  dir +Z   wrist bend  → the WRIST POINT
 *   axis 6  (0.1,   0,   0)  dir +X   flange roll, ON the wrist line ⇒ spherical
 *   tcp     (0.12,  0,   0)           tool, along the flange axis
 */
function sphericalRig(): JointChainParams {
  return buildRig([
    { off: [0, 0, 0], dir: [0, 1, 0] },
    { off: [0.15, 0.4, 0], dir: [0, 0, 1] },
    { off: [0, 0.7, 0], dir: [0, 0, 1] },
    { off: [0.05, 0.1, 0], dir: [1, 0, 0] },
    { off: [0.5, 0, 0], dir: [0, 0, 1] },
    { off: [0.1, 0, 0], dir: [1, 0, 0] },
  ], [0.12, 0, 0]);
}

/**
 * The same robot with axis 6 moved 150 mm off the wrist line — the CRX's own
 * geometry (`A6` sits at `(0.1, 0, 0.15)` relative to `A5`), so the
 * `unrepresentableOffsetMm` asserted below is the number the shipped robot
 * actually produces.
 */
function cobotRig(): JointChainParams {
  return buildRig([
    { off: [0, 0, 0], dir: [0, 1, 0] },
    { off: [0.15, 0.4, 0], dir: [0, 0, 1] },
    { off: [0, 0.7, 0], dir: [0, 0, 1] },
    { off: [0.05, 0.1, 0], dir: [1, 0, 0] },
    { off: [0.5, 0, 0], dir: [0, 0, 1] },
    { off: [0.1, 0, 0.15], dir: [1, 0, 0] },
  ], [0.12, 0, 0]);
}

function buildRig(
  axes: Array<{ off: [number, number, number]; dir: [number, number, number] }>,
  tcp: [number, number, number],
): JointChainParams {
  const axisHomePos = new Float64Array(18);
  const axisHomeRot = new Float64Array(24);
  const axisDir = new Float64Array(18);
  axes.forEach((a, i) => {
    axisHomePos.set(a.off, i * 3);
    axisHomeRot.set([0, 0, 0, 1], i * 4);
    axisDir.set(a.dir, i * 3);
  });
  return { axisHomePos, axisHomeRot, axisDir, tcpLocalOffset: tcp, tcpLocalRot: [0, 0, 0, 1] };
}

describe('chain geometry and FK (analytic rig)', () => {
  it('places every axis where the offsets put it', () => {
    const g = chainGeometry(sphericalRig());
    expect(g.origins[0].map(r4)).toEqual([0, 0, 0]);
    expect(g.origins[1].map(r4)).toEqual([0.15, 0.4, 0]);
    expect(g.origins[2].map(r4)).toEqual([0.15, 1.1, 0]);
    expect(g.origins[3].map(r4)).toEqual([0.2, 1.2, 0]);
    expect(g.origins[4].map(r4)).toEqual([0.7, 1.2, 0]);
    expect(g.origins[5].map(r4)).toEqual([0.8, 1.2, 0]);
    // The directions survive as given (identity home rotations).
    expect(g.directions[0].map(r4)).toEqual([0, 1, 0]);
    expect(g.directions[1].map(r4)).toEqual([0, 0, 1]);
    expect(g.directions[3].map(r4)).toEqual([1, 0, 0]);
  });

  it('finds the wrist point where the axis-4 and axis-5 lines meet', () => {
    const g = chainGeometry(sphericalRig());
    // Line 4 runs +X through (0.2, 1.2, 0); line 5 runs +Z through (0.7, 1.2, 0).
    expect(g.wrist.map(r4)).toEqual([0.7, 1.2, 0]);
    expect(g.wristLineGapM).toBeCloseTo(0, 9);
  });

  it('FK at zero is the home pose, and the TCP offset is applied in the flange frame', () => {
    const fk = chainFk(sphericalRig(), [0, 0, 0, 0, 0, 0]);
    expect(fk.flange.pos.map(r4)).toEqual([0.8, 1.2, 0]);
    expect(fk.tcp.pos.map(r4)).toEqual([0.92, 1.2, 0]);
  });

  it('FK turns the whole arm with axis 1 — +90 deg about +Y maps (x,y,z) to (z,y,-x)', () => {
    const fk = chainFk(sphericalRig(), [90, 0, 0, 0, 0, 0]);
    expect(fk.tcp.pos.map(r4)).toEqual([0, 1.2, -0.92]);
  });

  it('treats a missing or non-finite angle as zero instead of producing NaN', () => {
    const fk = chainFk(sphericalRig(), [0, Number.NaN, 0]);
    expect(fk.tcp.pos.every((v) => Number.isFinite(v))).toBe(true);
    expect(positionErrorMm(fk.tcp.pos, [0.92, 1.2, 0])).toBeCloseTo(0, 6);
  });

  it('measures the distance from a point to a line and between two lines', () => {
    expect(distancePointToLine([0, 1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(1, 9);
    const { point, gap } = closestPointBetweenLines([0, 0, 0], [1, 0, 0], [0, 0, 0.3], [0, 1, 0]);
    expect(gap).toBeCloseTo(0.3, 9);
    expect(point.map(r4)).toEqual([0, 0, 0.15]);
  });
});

describe('WristType is measured, not defaulted (plan-773 E5 / R7)', () => {
  it('calls a wrist spherical when axis 6 passes through the wrist point', () => {
    const v = measureWristType(chainGeometry(sphericalRig()));
    expect(v.wristType).toBe('Spherical');
    expect(v.offsetMm).toBeCloseTo(0, 6);
    expect(v.evidence).toContain('spherical');
  });

  it('calls the CRX geometry non-spherical and names the 150 mm it measured', () => {
    const v = measureWristType(chainGeometry(cobotRig()));
    expect(v.wristType).toBe('NonSpherical');
    expect(v.offsetMm).toBeCloseTo(150, 6);
    // The sentence has to carry the number: "NonSpherical" alone does not let a
    // reader judge whether the rig is right.
    expect(v.evidence).toContain('150.0 mm');
    expect(v.evidence).toContain('cobot solver');
  });
});

describe('OPW estimation reports provenance per field (plan-773 E5)', () => {
  it('derives every parameter from the geometry of the spherical rig', () => {
    const e = estimateOpwFromChain(sphericalRig());
    expect(r4(e.params.c1)).toBe(0.4);    // 0.4 up along the base axis
    expect(r4(e.params.a1)).toBe(0.15);   // 0.15 across it
    expect(r4(e.params.c2)).toBe(0.7);    // the upper arm
    expect(r4(e.params.c3)).toBe(0.55);   // axis 3 to the wrist, along the forearm
    expect(r4(e.params.a2)).toBe(0.1);    // and across it
    expect(r4(e.params.c4)).toBe(0.1);    // wrist to flange, along the tool axis
    expect(r4(e.params.b)).toBe(0);       // no lateral offset
    expect(e.toolOffset.map(r4)).toEqual([0.12, 0, 0]);
  });

  it('is "exact" for the spherical rig and says why', () => {
    const e = estimateOpwFromChain(sphericalRig());
    expect(e.confidence).toBe('exact');
    expect(e.unrepresentableOffsetMm).toBeCloseTo(0, 6);
    expect(e.summary).toContain('measured');
    // Even an exact estimate must not hide that one value is inferred.
    expect(e.sources.ElbowInUnityX).toBe('inferred');
    expect(e.summary).toContain('ElbowInUnityX');
  });

  it('is "seed-only" for the cobot rig and names the offset OPW cannot carry', () => {
    const e = estimateOpwFromChain(cobotRig());
    expect(e.confidence).toBe('seed-only');
    expect(e.unrepresentableOffsetMm).toBeCloseTo(150, 6);
    expect(e.summary).toContain('150.0 mm');
    expect(e.summary).toContain('SEED');
    expect(e.summary).toContain('must not be read as a kinematic datasheet');
    // The lengths are still measured — "seed-only" is about the MODEL, not about
    // the measurement, and an answer that blurred the two would be the lie E5 bans.
    expect(e.sources.c1).toBe('measured');
    expect(e.sources.c2).toBe('measured');
    expect(r4(e.params.c2)).toBe(0.7);
  });

  it('marks a measured zero as such, so "0" is never mistaken for "unknown"', () => {
    const e = estimateOpwFromChain(sphericalRig());
    expect(e.sources.b).toBe('measured-zero');
    expect(e.sources.a1).toBe('measured');
  });

  it('takes an explicit ElbowInUnityX as given and stops calling it inferred', () => {
    const e = estimateOpwFromChain(sphericalRig(), true);
    expect(e.params.elbowInUnityX).toBe(true);
    expect(e.sources.ElbowInUnityX).toBe('measured');
  });

  it('reports the OPW model assumptions with the deviation measured on this robot', () => {
    const e = estimateOpwFromChain(cobotRig());
    const by = new Map(e.assumptions.map((a) => [a.name, a]));
    // Axes 2 and 3 are parallel here, axis 1 is perpendicular to axis 2.
    expect(by.get('axis2-axis3-parallel')!.value).toBeCloseTo(0, 6);
    expect(by.get('axis1-axis2-perpendicular')!.value).toBeCloseTo(0, 6);
    expect(by.get('wrist-axis4-axis5-gap')!.value).toBeCloseTo(0, 6);
    // …and the one that is NOT satisfied is the one that makes it seed-only.
    expect(by.get('wrist-axis6-offset')!.value).toBeCloseTo(150, 6);
  });

  it('measures b on a robot whose upper arm points straight up (the degenerate cross product)', () => {
    // `b` used to come from cross(baseAxis, upperArm), which is ZERO for this
    // very common robot — so a non-zero lateral offset would have been reported
    // as 0 by accident. It is taken from the axis-2 direction instead.
    const rig = buildRig([
      { off: [0, 0, 0], dir: [0, 1, 0] },
      { off: [0.15, 0.4, 0.07], dir: [0, 0, 1] },
      { off: [0, 0.7, 0], dir: [0, 0, 1] },
      { off: [0.05, 0.1, 0], dir: [1, 0, 0] },
      { off: [0.5, 0, 0], dir: [0, 0, 1] },
      { off: [0.1, 0, 0], dir: [1, 0, 0] },
    ], [0.12, 0, 0]);
    expect(r4(estimateOpwFromChain(rig).params.b)).toBe(0.07);
  });
});

// ─── Half 2: the committed library robot ─────────────────────────────────

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ASSET = resolve(ROOT, 'public/library/Robots/FanucCRX-10iA-L.glb');
const AXES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'] as const;

async function readWithDraco(path: string): Promise<Document> {
  const decoder = await draco3d.createDecoderModule();
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': decoder })
    .read(path);
}

describe('public/library/Robots/FanucCRX-10iA-L.glb: the geometry the rig is derived from', () => {
  let byName: Map<string, GltfNode>;
  let parentOf: Map<string, string | null>;

  beforeAll(async () => {
    const doc = await readWithDraco(ASSET);
    const nodes = doc.getRoot().listNodes();
    byName = new Map(nodes.map((n) => [n.getName(), n]));
    parentOf = new Map(nodes.map((n) => [n.getName(), null as string | null]));
    for (const n of nodes) {
      for (const c of n.listChildren()) parentOf.set(c.getName(), n.getName());
    }
  }, 60_000);

  it('ships ONE RobotIK on its root, written from this derivation (E5 lifted for this asset, 2026-10-25)', () => {
    // Until 2026-10-25 this asserted the opposite: the part shipped unrigged and
    // derivation was its only path. Thomas lifted E5 for the library CRX;
    // scripts/author-robot-ik.mjs writes the rig with the derivation tested in
    // this file, and tests/crx-library-physics.node.test.ts re-derives every
    // field against it. The geometry assertions below are unchanged — they are
    // what the derivation measures, rigged or not.
    const carriers = [...byName.values()].filter((n) =>
      'RobotIK' in (((n.getExtras() ?? {}) as { realvirtual?: Record<string, unknown> }).realvirtual ?? {}));
    expect(carriers.map((n) => n.getName())).toEqual(['FanucCRX-10iA-L']);
  });

  it('nests A1..A6 serially — each axis inside the previous one', () => {
    expect(parentOf.get('A1')).toBe('FanucCRX-10iA-L');
    for (let i = 1; i < AXES.length; i++) {
      expect(parentOf.get(AXES[i]), `${AXES[i]} must be a child of ${AXES[i - 1]}`).toBe(AXES[i - 1]);
    }
  });

  it('drives all six axes rotationally, and the gripper drives are NOT rotary', () => {
    const dirOf = (name: string): string => {
      const rv = ((byName.get(name)!.getExtras() ?? {}) as { realvirtual?: Record<string, { Direction?: string }> }).realvirtual ?? {};
      return rv['Drive']?.Direction ?? '';
    };
    expect(AXES.map(dirOf)).toEqual([
      'RotationY', 'RotationZ', 'RotationZ', 'RotationX', 'RotationZ', 'RotationX',
    ]);
    // The three the derivation must skip. A rig built by COUNTING drives would
    // see nine axes on a six-axis robot.
    expect(dirOf('SchunkEGH80Gripper')).toBe('Virtual');
    expect(dirOf('LeftFinger')).toBe('LinearX');
    expect(dirOf('RightFinger')).toBe('LinearX');
  });

  it('has a TCP node under A6, which is what carries the tool pose', () => {
    expect(parentOf.get('TCP')).toBe('A6');
  });

  it('is a NON-SPHERICAL wrist by its authored geometry — A6 sits 150 mm off the A5 axis', () => {
    // A6's translation relative to A5 is the measurement `measureWristType`
    // makes on the loaded chain; asserting it on the FILE is what keeps a
    // re-extraction from quietly turning the cobot into a spherical robot.
    const a6 = byName.get('A6')!.getTranslation();
    expect(a6.map(r4)).toEqual([0.1, 0, 0.15]);
    // The 0.15 is perpendicular to A6's own rotation axis (RotationX), so no
    // OPW parameter can absorb it.
    expect(Math.hypot(a6[1], a6[2])).toBeCloseTo(0.15, 6);
  });

  it('keeps the arm geometry the OPW derivation measures', () => {
    expect(byName.get('A2')!.getTranslation().map(r4)).toEqual([0, 0.245, 0]);
    expect(byName.get('A3')!.getTranslation().map(r4)).toEqual([0, 0.71, 0]);
    expect(byName.get('A4')!.getTranslation().map(r4)).toEqual([0.15, 0, 0]);
    expect(byName.get('A5')!.getTranslation().map(r4)).toEqual([0.39, 0, 0]);
    expect(byName.get('TCP')!.getTranslation().map(r4)).toEqual([0.06, 0, 0]);
  });
});

/** Round to 0.1 mm — the precision the export carries and the reports print. */
function r4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
