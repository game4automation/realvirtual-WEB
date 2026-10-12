// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 Phase 4 — THE recipe of the shipped FMU demo model
 * `public/demo-realvirtual/fmu-demo.glb`.
 *
 * The model is built exactly the way the asset editor builds one, only without
 * the clicks: the package is parsed by the lazy editor parser
 * (`readModelDescription`), checked by the same gate as the "FMU anhängen…"
 * action (`checkFmuAttachable`), described by the same `buildFmuExtras`, its
 * bytes are put into the binary-resource store, and the file is written by THE
 * asset writer (`exportAssetGlb` → `embedFmuPackages`: one bufferView per SHA).
 *
 * Scene (metres, Y up):
 *   FmuDemo
 *   └── Ball    — sphere r = 0.1 m; Fmu (BouncingBall, Reference-FMUs v0.0.40)
 *                 + Drive (LinearY) + Drive_FollowPosition
 *                 Position = Ball/Signals/h  (the FMU output, metres),
 *                 Scale = 1000 (Drive positions are millimetres);
 *                 h = 0 → sphere centre at y = r (the ball touches y = 0);
 *                 FmuStartOverrides e = 0.95 (the package default 0.7 comes to
 *                 rest after ~2.5 s; 0.95 keeps bouncing for ~18 s)
 *   └── Sequence — LogicStep_SerialContainer (top level = loops, plan-502 F13)
 *       ├── RestartBall — LogicStep_SetSignalBool: Ball/Signals/Restart = true
 *       └── Wait        — LogicStep_Delay: Duration = 12 s (editable in the Inspector)
 *
 * The sequence restarts the BouncingBall every {@link SEQUENCE_DELAY_S} seconds
 * through the viewer-owned `Restart` control signal of the Fmu component (a
 * rising edge → the provisioning plugin restarts the CONNECT instance and puts
 * the signal back to false). The web LogicStep engine loops every TOP-LEVEL
 * serial container — there is no `Loop` field; hierarchy order is step order.
 *
 * No floor, no panel — the model is the ball and its one FMU only (user
 * feedback after Phase 4: a floor slab and a standing box read as a wall;
 * 2026-09-26: the Feedthrough `Panel` left the demo — Feedthrough stays a test
 * fixture only, its input path is proven by `fmu-live-smoke.e2e.test.tsx`).
 *
 * The FMU signal children (`<node>/Signals/<var>`) are NOT in the file: the
 * viewer creates them on load from `FmuVariables` (plan-498 decision log).
 * `Drive_FollowPosition.Position` therefore references a node that only the
 * runtime creates — the signal reference falls back to the raw path, which the
 * SignalStore knows once the Fmu component has registered its children.
 */

import {
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  SphereGeometry,
} from 'three';
import { buildFmuExtras, checkFmuAttachable, type FmuPackage } from '../../src/core/ops/rv-fmu-ops';
import { binaryResources } from '../../src/core/engine/rv-binary-resources';
import { exportAssetGlb } from '../../src/core/editor/rv-asset-glb-export';
import { setSceneCamera } from '../../src/core/engine/rv-asset-reference';

export const FMU_DEMO_ROOT = 'FmuDemo';
export const BALL_RADIUS = 0.1;
/** Drive_FollowPosition scale: FMU output `h` is in metres, a Drive in millimetres. */
export const BALL_DRIVE_SCALE = 1000;
/** Ball x position (m); the camera looks at this column. */
export const BALL_X = -0.2;
/** The file's SceneCamera: slightly from above onto the ball's column, h = 0…1 m in view. */
export const DEMO_CAMERA = { px: 0.6, py: 1.0, pz: 2.0, tx: BALL_X, ty: 0.55, tz: 0 } as const;
/**
 * plan-502 F13 — the restart period of the `Sequence` (LogicStep_Delay.Duration, seconds).
 * 12 s: with e = 0.95 the ball bounces ~18 s until `v_min`; 12 s shows many contacts
 * and then starts fresh (user request 2026-09-26: "die Kugel wirklich hüpft").
 */
export const SEQUENCE_DELAY_S = 12;
/**
 * plan-502 — the demo's stored start value of the coefficient of restitution
 * (`e` is parameter + tunable; the package default 0.7 rests after ~2.5 s).
 * A string, like every `FmuStartOverrides` entry.
 */
export const DEMO_E_START = '0.95';

/**
 * The file's DocumentInfo (plan-506): the description the dashboard tooltip,
 * the detail pane and Ask AI show for the shipped demo. Part of the recipe so
 * the drift gate keeps the shipped file and a fresh build identical; the stamp
 * is fixed for the same reason (a build must not differ from itself by a clock).
 */
export const FMU_DEMO_DOCUMENT_INFO = {
  v: 1,
  summary: 'Co-simulation example: a bouncing ball driven by an embedded FMU (Modelica Reference FMUs BouncingBall.fmu).',
  description: [
    '# FMU Demo (BouncingBall)',
    '',
    'The smallest possible **FMI co-simulation** scene. The node *Ball* carries an `Fmu` component that embeds the unmodified `BouncingBall.fmu` from the Modelica Reference FMUs v0.0.40 and a `Drive` with `Drive_FollowPosition`, so the ball\'s height in the 3D scene follows the FMU\'s `h` output every fixed step.',
    '',
    'A small `LogicStep` sequence (*Sequence → RestartBall → Wait*) drops the ball again every 12 s so the demo keeps running.',
    '',
    '## What to look at',
    '',
    '- The **Signals** panel shows the FMU outputs updating live.',
    '- Change the restitution parameter `e` in the Fmu component to see the bounce decay differently.',
    '',
    'License of the embedded FMU: see *fmu-demo.LICENSE.txt* (2-Clause BSD, Modelica Association Project "FMI").',
  ].join('\n'),
  updatedAt: '2026-09-27T00:00:00.000Z',
  updatedBy: 'realvirtual',
} as const;

/** The binary-resource document id the builder files its packages under. */
const BUILD_DOCUMENT = 'fmu-demo-build';

async function packageOf(fileName: string, bytes: Uint8Array): Promise<FmuPackage> {
  const { readModelDescription, sha256OfPackage } = await import('../../src/core/engine/rv-fmu-model-description');
  const pkg: FmuPackage = {
    fileName,
    sha256: await sha256OfPackage(bytes),
    bytes,
    description: await readModelDescription(bytes),
  };
  checkFmuAttachable(pkg);
  return pkg;
}

function ref(path: string, componentType: string): Record<string, unknown> {
  return { type: 'ComponentReference', path, componentType };
}

/** Options of the demo recipe (plan-512). */
export interface FmuDemoSceneOptions {
  /**
   * `false` builds the UNBOUND fixture of the unit acceptance (plan-512 F12):
   * `Drive_FollowPosition` without the `Position` reference and without
   * `Scale`, so the binding — and with it the unit factor — is made
   * interactively. Default `true` = the shipped demo, byte-identical recipe.
   */
  bindPosition?: boolean;
}

/** The demo scene graph with the BouncingBall FMU attached (bytes in the store). */
export async function buildFmuDemoScene(
  bouncingBall: Uint8Array,
  opts: FmuDemoSceneOptions = {},
): Promise<{ root: Group; ball: FmuPackage }> {
  const ball = await packageOf('BouncingBall.fmu', bouncingBall);
  binaryResources.put(ball.sha256, ball.bytes, BUILD_DOCUMENT);

  const root = new Group();
  root.name = FMU_DEMO_ROOT;

  const ballMesh = new Mesh(
    new SphereGeometry(BALL_RADIUS, 32, 16),
    new MeshStandardMaterial({ color: 0xe8590c, roughness: 0.4, metalness: 0.0 }),
  );
  ballMesh.name = 'Ball';
  // h = 0 → sphere centre at y = r.
  ballMesh.position.set(BALL_X, BALL_RADIUS, 0);
  ballMesh.userData.realvirtual = {
    Drive: { Direction: 'LinearY', TargetSpeed: 5000, UseLimits: false },
    Drive_FollowPosition: opts.bindPosition === false
      // Unbound (plan-512): the schema defaults of the scale fields, spelled
      // out the way a Unity export carries every field.
      ? { Offset: 0, Scale: 1, CurrentPositionScale: 1, ScaleFeedbackPosition: true }
      : {
        Position: ref('Ball/Signals/h', 'PLCOutputFloat'),
        Scale: BALL_DRIVE_SCALE,
        Offset: 0,
      },
    Fmu: buildFmuExtras(ball, undefined, { e: DEMO_E_START }),
  };
  root.add(ballMesh);

  // plan-502 F13 — Sequence: restart the ball, wait, loop (top-level container).
  const sequence = new Group();
  sequence.name = 'Sequence';
  sequence.userData.realvirtual = { LogicStep_SerialContainer: {} };
  const restartStep = new Group();
  restartStep.name = 'RestartBall';
  restartStep.userData.realvirtual = {
    LogicStep_SetSignalBool: { Signal: ref('Ball/Signals/Restart', 'PLCInputBool'), SetToTrue: true },
  };
  const waitStep = new Group();
  waitStep.name = 'Wait';
  waitStep.userData.realvirtual = { LogicStep_Delay: { Duration: SEQUENCE_DELAY_S } };
  sequence.add(restartStep, waitStep);
  root.add(sequence);

  setSceneCamera(root, { ...DEMO_CAMERA, duration: 1, source: 'author' });
  // Root-level file metadata is lifted onto the scene by the asset writer
  // (`liftRootExtrasToScene`), next to the SceneCamera above.
  (root.userData.realvirtual as Record<string, unknown>).DocumentInfo = { ...FMU_DEMO_DOCUMENT_INFO };
  return { root, ball };
}

/** Build and write the demo GLB (the BouncingBall package embedded). */
export async function buildFmuDemoGlb(bouncingBall: Uint8Array, opts: FmuDemoSceneOptions = {}): Promise<{
  glb: ArrayBuffer;
  root: Object3D;
  ball: FmuPackage;
}> {
  const { root, ball } = await buildFmuDemoScene(bouncingBall, opts);
  const glb = await exportAssetGlb(root, FMU_DEMO_ROOT);
  return { glb, root, ball };
}
