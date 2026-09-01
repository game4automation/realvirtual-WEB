// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * T3 / T6 / T11 — Round-trip, parity and live-mode acceptance (plan-404 §9).
 *
 * These are the ACCEPTANCE tests of plan-404. Unlike every other mechanism
 * suite, which builds its rigs by hand in `_mechanism-rigs.ts`, these run
 * against REAL Unity artefacts produced by plan-404 Phase 0:
 *
 *   T6  `../realvirtual-WebViewer-Private~/projects/Development/fixtures/mechanism-{fourbar,scissor,delta}.glb` — the reference
 *       scenes exported through the normative
 *       `GLBManager.GetStandardExportSettings()` → `GLTFSceneExporter.SaveGLB()`
 *       chain, i.e. exactly what `WebViewerToolbar.ExportSceneToWebViewer()`
 *       produces. Proves the whole Unity→GLB→Web transport: components
 *       constructed, `BodyA`/`BodyB`/`DrivenBy` resolved, the world-anchor case
 *       (ABSENT `BodyA` key) read as authored, the deduplicated sibling name
 *       resolved, and the solver converging on the result.
 *   T3  `tests/fixtures/mechanism/fourbar-trajectory.json` — a 200-step Unity
 *       golden trajectory (crank 0→90°), compared at ≤ 1e-3 mm per step, which
 *       is plan-404's parity NFR.
 *   T11 the same reference GLB driven through a LIVE signal, proving the
 *       live-override rule holds for mechanism-driving drives too (F6).
 *
 * FRAME CONVENTION (the thing these tests really pin down). UnityGLTF exports
 * the scene MIRRORED about the X plane, while rv_extras carry RAW Unity vectors
 * — plan-404 §Phase-0-Transportmatrix finding 1. The read side reconciles the
 * two in one place (`jointAxisToGltf` in the private mechanism module, on top of
 * the schema's `unityCoords` X negation). A regression there does not produce a
 * subtle wobble: the mechanism runs BACKWARDS or assembles into the mirrored
 * branch, which the per-step comparison below catches on step 1.
 *
 * Regenerate the artefacts (Unity side):
 *   realvirtual DEV/Testing/Kinematics/Export Mechanism Reference GLBs
 *   realvirtual DEV/Testing/Kinematics/Dump Mechanism Golden Fixtures
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { clearLiveControl } from '../src/core/engine/rv-live-control';
import {
  register as registerMechanismFeature,
  unregister as unregisterMechanismFeature,
  getActiveMechanismManager,
} from '@rv-private/features/kinematic-mechanism.register';
import type { RVKinematicMechanism } from '@rv-private/kinematic-mechanism/rv-kinematic-mechanism';
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetsAvailable } from './fixtures/dev-asset-available';

// plan-395: everything in `DEV_GLB` lives in the private Development project
// and is absent from a public checkout. The suites below must then report
// `skipped` rather than `passed` - a probe-and-return would leave this file
// green while it checked nothing. The probe tests the CONTENT TYPE, not
// `res.ok`: without the private sibling nothing claims `/private-assets/`, so
// the dev server answers it with the SPA fallback, a 200 text/html.
const DEV_ASSETS = await devAssetsAvailable(DEV_GLB.mechanismFourbar, DEV_GLB.mechanismScissor, DEV_GLB.mechanismDelta);

/** True when a fixture/GLB asset is actually served (not an SPA fallback). */
async function assetExists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    // A dev server that rewrites unknown paths answers 200 text/html — that is
    // an ABSENT asset, not a present one.
    return !type.includes('text/html');
  } catch {
    return false;
  }
}

const REFERENCE_GLBS = [
  DEV_GLB.mechanismFourbar,
  DEV_GLB.mechanismScissor,
  DEV_GLB.mechanismDelta,
];

/** Test titles and messages stay on the bare file name; the URLs are the contract. */
const nameOf = (url: string): string => url.split('/').pop() ?? url;

const TRAJECTORY_URL = '/tests/fixtures/mechanism/fourbar-trajectory.json';

/** One step of the Unity golden trajectory dump. */
interface GoldenStep {
  step: number;
  jointValues: number[];
  converged: boolean;
  residualMm: number;
  /** Link world positions in Unity mm, in the fixture's `links` order. */
  linkPosMm: [number, number, number][];
  linkRot: [number, number, number, number][];
}

interface GoldenTrajectory {
  mechanism: string;
  steps: number;
  sweepDegrees: number;
  activeJointIndices: number[];
  links: string[];
  trajectory: GoldenStep[];
}

let viewerHandle: TestViewerHandle;
let solverAvailable = false;

beforeAll(async () => {
  viewerHandle = await createTestViewer('webgl');
  await registerMechanismFeature(viewerHandle.viewer);
  // `attach()` kicks the artefact load off without awaiting it; a mechanism
  // constructed before it resolves waits in the manager's pending set. Awaiting
  // here makes every test below see a ready solver deterministically.
  solverAvailable = (await getActiveMechanismManager()?.ensureSolverLoaded()) ?? false;
}, 60_000);

afterAll(() => {
  unregisterMechanismFeature();
  viewerHandle?.dispose();
});

afterEach(() => {
  clearLiveControl();
});

/**
 * Skip loudly when an acceptance artefact is missing. A silent pass here would
 * hide precisely the transport this plan exists to prove.
 */
async function requireArtefacts(
  ctx: { skip: (note?: string) => void },
  ...urls: string[]
): Promise<boolean> {
  for (const url of urls) {
    if (!await assetExists(url)) {
      ctx.skip(`acceptance artefact "${url}" missing — plan-404 Phase 0 has not run`);
      return false;
    }
  }
  if (!solverAvailable) {
    ctx.skip('rv_kinematic_solver.wasm unavailable — plan-404 Phase 1 artifact missing');
    return false;
  }
  return true;
}

/** Load a reference GLB (by URL) and return its single mechanism. */
async function loadMechanism(viewer: RVViewer, url: string): Promise<RVKinematicMechanism> {
  await viewer.loadModel(url);
  const manager = getActiveMechanismManager();
  if (!manager) throw new Error('mechanism feature is not registered');
  const mechanisms = manager.listMechanisms();
  if (mechanisms.length !== 1) {
    throw new Error(`${nameOf(url)}: expected exactly 1 mechanism, found ${mechanisms.length}`);
  }
  return mechanisms[0];
}

/** The drive of the mechanism's first actively driven joint. */
function drivenJointDrive(mech: RVKinematicMechanism): RVDrive {
  const joint = mech.joints.find((j) => j.DrivenBy !== null);
  if (!joint?.DrivenBy) throw new Error(`${mech.node.name}: no actively driven joint`);
  return joint.DrivenBy;
}

/**
 * A link's world position in UNITY millimetres — the frame the golden fixture
 * is written in, so the comparison stays readable.
 *
 * Two conversions, both of them the project-wide convention and neither of them
 * mechanism-specific: metres → millimetres via the controller scale, and the
 * glTF X mirror undone (`rv-coordinate-utils.ts`: UnityGLTF exports positions
 * as `(x, y, z) → (-x, y, z)`).
 */
function linkWorldPosUnityMm(link: Object3D, controllerScale: number): Vector3 {
  const world = link.getWorldPosition(new Vector3()).multiplyScalar(controllerScale);
  world.x = -world.x;
  return world;
}

/**
 * Advance one solve step: put the drive on an absolute commanded position (the
 * web equivalent of Unity writing `Drive.CurrentPosition`, transform included)
 * and run the manager's Prepare → Solve → WriteBack pass.
 *
 * Deliberately NOT `viewer._tickOnce()`: the golden trajectory is a sequence of
 * exact joint values, and letting the drive's own ramp physics interpolate
 * toward them would compare a different motion profile, not the solver.
 */
function stepTo(mech: RVKinematicMechanism, drive: RVDrive, value: number): void {
  drive.applySyncData(value);
  getActiveMechanismManager()!.tickMechanisms();
  void mech;
}

describe.skipIf(!DEV_ASSETS)('T6 — GLB round-trip against real Unity exports', () => {
  for (const glb of REFERENCE_GLBS) {
    it(`loads ${nameOf(glb)}, resolves BodyA/BodyB/DrivenBy and solves`, async (ctx) => {
      if (!await requireArtefacts(ctx, glb)) return;
      const mech = await loadMechanism(viewerHandle.viewer, glb);

      // The component came out of the generic rv_extras path, not a hand-built
      // rig: joints collected, links discovered, topology accepted, no blocking
      // finding, wasm handle attached.
      expect(mech.joints.length).toBeGreaterThan(0);
      expect(mech.status.disabledReason).toBe('');
      expect(mech.findings.filter((f) => f.severity === 'Error')).toEqual([]);
      expect(mech.topology).not.toBeNull();
      expect(mech.canSolve).toBe(true);

      // Every reference has at least one driven joint, and BodyB is mandatory
      // on all of them — a `null` here would mean the shared reference
      // resolution silently dropped a ComponentReference.
      for (const joint of mech.joints) {
        expect(joint.BodyB, `${joint.node.name}.BodyB`).not.toBeNull();
        expect(joint.hasUnresolvedBodyA, `${joint.node.name}.BodyA unresolved`).toBe(false);
        expect(joint.hasUnresolvedBodyB, `${joint.node.name}.BodyB unresolved`).toBe(false);
      }
      const driven = mech.joints.filter((j) => j.DrivenBy !== null);
      expect(driven.length).toBeGreaterThan(0);
      for (const joint of driven) expect(joint.DrivenBy).toBeInstanceOf(RVDrive);

      // Forward steps must CONVERGE, not merely return. A mirrored frame or a
      // dropped anchor still "solves" — damped least squares always returns
      // something — but it stops converging within Tolerance.
      const drive = drivenJointDrive(mech);
      for (let i = 1; i <= 20; i++) stepTo(mech, drive, i * 0.45);
      expect(mech.status.disabledReason).toBe('');
      expect(mech.Converged, `${glb} residual ${mech.ResidualError}`).toBe(true);
      expect(Number.isFinite(mech.ResidualError)).toBe(true);
      expect(mech.ResidualError).toBeLessThanOrEqual(mech.Tolerance);
    }, 60_000);
  }

  it('an ABSENT BodyA in a real export reads as a world anchor', async (ctx) => {
    if (!await requireArtefacts(ctx, REFERENCE_GLBS[0])) return;
    const mech = await loadMechanism(viewerHandle.viewer, REFERENCE_GLBS[0]);

    // plan-404 §2.4, normative: the Unity serializer omits null fields entirely,
    // so an ABSENT `BodyA` key is the authored world anchor. The four-bar's J_A
    // and J_D are exactly that (ground pivots); J_B and J_C carry a real body.
    const byName = new Map(mech.joints.map((j) => [j.node.name, j]));
    expect([...byName.keys()].sort()).toEqual(['J_A', 'J_B', 'J_C', 'J_D']);

    for (const name of ['J_A', 'J_D']) {
      const joint = byName.get(name)!;
      expect(joint.BodyA, `${name}.BodyA`).toBeNull();
      expect(joint.bodyAWasSpecified, `${name} carried a BodyA key`).toBe(false);
      expect(joint.isWorldAnchored, `${name} world-anchored`).toBe(true);
      expect(joint.hasUnresolvedBodyA, `${name} misread as a defect`).toBe(false);
    }
    for (const name of ['J_B', 'J_C']) {
      const joint = byName.get(name)!;
      expect(joint.BodyA, `${name}.BodyA`).not.toBeNull();
      expect(joint.isWorldAnchored, `${name} must NOT be world-anchored`).toBe(false);
    }

    // The world anchor is a real topology fact, not just a flag: the four-bar
    // closes a loop against ground, so the topology carries loop residuals.
    expect(mech.topology!.loopResiduals.length).toBeGreaterThan(0);
  }, 60_000);

  it('a DEDUPED sibling node name still resolves its body reference', async (ctx) => {
    if (!await requireArtefacts(ctx, REFERENCE_GLBS[0])) return;
    const mech = await loadMechanism(viewerHandle.viewer, REFERENCE_GLBS[0]);

    // Regression guard for R5, aimed at the form that a REAL export produces.
    // plan-404 §Phase-0-Transportmatrix finding 2: name deduplication happens
    // in the UNITY exporter, not in three.js — the four-bar deliberately has two
    // siblings called `Coupler`, and the exporter renames the second to
    // `Coupler_rv1` AND rewrites every `ComponentReference.path` to match. So
    // the case to prove is the `_rv<N>` form, not three.js's `_1` suffix.
    const coupler = mech.joints.find((j) => j.node.name === 'J_B')!.BodyB!;
    expect(coupler.name).toBe('Coupler_rv1');

    // Resolution went through the SHARED alias-aware registry, never a
    // mechanism-specific path fixup (SOL finding 6).
    const registry = viewerHandle.viewer.registry!;
    const path = NodeRegistry.computeNodePath(coupler);
    expect(registry.getNode(path)).toBe(coupler);

    // Both joints that name the deduped node resolved to the SAME object — a
    // path fixup that guessed would land on the other `Coupler` for one of them.
    const jC = mech.joints.find((j) => j.node.name === 'J_C')!;
    expect(jC.BodyA).toBe(coupler);
    // And the decoy sibling is a different, unreferenced node.
    const decoy = viewerHandle.viewer.scene.getObjectByName('Coupler');
    expect(decoy).toBeDefined();
    expect(decoy).not.toBe(coupler);
  }, 60_000);
});

describe.skipIf(!DEV_ASSETS)('T3 — forward parity against the Unity golden trajectory', () => {
  it('tracks a 200-step drive ramp within 1e-3 mm', async (ctx) => {
    if (!await requireArtefacts(ctx, REFERENCE_GLBS[0], TRAJECTORY_URL)) return;

    const golden = await (await fetch(TRAJECTORY_URL)).json() as GoldenTrajectory;
    expect(golden.mechanism).toBe('fourbar');
    expect(golden.trajectory).toHaveLength(golden.steps);

    const mech = await loadMechanism(viewerHandle.viewer, REFERENCE_GLBS[0]);
    const scale = mech.controllerScale;
    const drive = drivenJointDrive(mech);

    // The fixture's link order is the blob's link order (Body A first, then
    // Body B, per joint, in joint order) — the same order `mech.links` carries.
    // The names differ by the exporter's dedup suffix, hence the prefix check.
    expect(mech.links).toHaveLength(golden.links.length);
    mech.links.forEach((link, i) => {
      expect(link.name.startsWith(golden.links[i])).toBe(true);
    });

    // plan-404 NFR: ≤ 1e-3 mm position deviation over the 200-step reference
    // trajectory. Not bit-parity — wasm forbids FMA fusing and LLVM vectorizes
    // per target, so the contract is a tolerance (plan §5.1 R3).
    const TOLERANCE_MM = 1e-3;
    let worstMm = 0;
    let worstAt = '';

    for (const step of golden.trajectory) {
      // The crank is the single active joint; drive it to the exact value Unity
      // recorded for this step so only the SOLVE is under comparison.
      const command = step.jointValues[golden.activeJointIndices[0]];
      stepTo(mech, drive, command);

      expect(mech.status.disabledReason, `step ${step.step}`).toBe('');
      expect(mech.Converged, `step ${step.step} did not converge`).toBe(step.converged);

      for (let li = 0; li < mech.links.length; li++) {
        const actual = linkWorldPosUnityMm(mech.links[li], scale);
        const expectedPos = step.linkPosMm[li];
        const deviation = Math.hypot(
          actual.x - expectedPos[0],
          actual.y - expectedPos[1],
          actual.z - expectedPos[2],
        );
        if (deviation > worstMm) {
          worstMm = deviation;
          worstAt = `step ${step.step}, link ${mech.links[li].name}: `
            + `(${actual.x}, ${actual.y}, ${actual.z}) vs Unity `
            + `(${expectedPos[0]}, ${expectedPos[1]}, ${expectedPos[2]})`;
        }
      }
    }

    expect(worstMm, `worst deviation ${worstMm} mm — ${worstAt}`)
      .toBeLessThanOrEqual(TOLERANCE_MM);
  }, 120_000);
});

describe.skipIf(!DEV_ASSETS)('T11 — live-mode signal drive', () => {
  it('signal-driven drives move the mechanism identically to standalone', async (ctx) => {
    if (!await requireArtefacts(ctx, REFERENCE_GLBS[0], TRAJECTORY_URL)) return;

    const golden = await (await fetch(TRAJECTORY_URL)).json() as GoldenTrajectory;
    const viewer = viewerHandle.viewer;
    const mech = await loadMechanism(viewer, REFERENCE_GLBS[0]);
    const scale = mech.controllerScale;
    const drive = drivenJointDrive(mech);

    // Wire the crank as a LIVE axis the way the viewer does it: a
    // `Drive_FollowPosition` behavior consuming a PLC signal out of the
    // SignalStore. That store IS the live path — every adapter (WebSocket,
    // MQTT, REST) writes into it and nothing else, so a value set here is
    // indistinguishable from one arriving from a PLC.
    const store = viewer.signalStore!;
    const registry = viewer.registry!;
    const path = NodeRegistry.computeNodePath(drive.node);

    const follow = new RVDriveFollowPosition(drive.node);
    follow.Position = `${path}/Crank.Position`;
    store.register('Crank.Position', follow.Position, 0, 'PLCOutputFloat');
    follow.init({ registry, signalStore: store } as never);
    registry.register('Drive_FollowPosition', path, follow);

    // "Live signals always override local behavior — immediately, per
    // component." Arm a LOCAL jog first, then let ONE live tick land: the drive
    // must sit exactly on the live value, not somewhere along its own ramp
    // (0.02 s at 90 °/s would have carried it to 1.8°).
    drive.JogForward = true;
    drive.TargetSpeed = 90;
    store.set('Crank.Position', 0.45);
    viewer._tickOnce(0.02);
    expect(drive.currentPosition).toBeCloseTo(0.45, 10);
    expect(mech.joints.find((j) => j.DrivenBy === drive)!.CurrentValue).toBeCloseTo(0.45, 10);

    // And the mechanism it drives must land where the standalone/Unity run does.
    // Same 0.45° increments as the golden trajectory, so no jump sub-stepping
    // is involved and every step is directly comparable.
    const STEPS = 40;
    const TOLERANCE_MM = 1e-3;
    for (let i = 0; i < STEPS; i++) {
      const step = golden.trajectory[i];
      store.set('Crank.Position', step.jointValues[golden.activeJointIndices[0]]);
      viewer._tickOnce(0.02);

      expect(mech.status.disabledReason, `live step ${step.step}`).toBe('');
      expect(mech.Converged, `live step ${step.step} did not converge`).toBe(true);
      for (let li = 0; li < mech.links.length; li++) {
        const actual = linkWorldPosUnityMm(mech.links[li], scale);
        const expectedPos = step.linkPosMm[li];
        expect(
          Math.hypot(
            actual.x - expectedPos[0],
            actual.y - expectedPos[1],
            actual.z - expectedPos[2],
          ),
          `live step ${step.step}, link ${mech.links[li].name}`,
        ).toBeLessThanOrEqual(TOLERANCE_MM);
      }
    }
  }, 120_000);
});
