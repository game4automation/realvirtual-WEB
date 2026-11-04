// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-robot-program-gate.ts — the licence gate of the robot program export
 * (plan-773 E3, decided by Thomas 2026-10-23).
 *
 * > Rig and solve from `'free'`; **the program export only in the `'pro'` tier
 * > and only in a hosted delivery.** A local export would be the back door
 * > around the runtime licence (ADR-022/023), and an exported robot program is
 * > a delivery artifact for a real machine.
 *
 * ## Why the gate lives HERE and not in the Phase 5 tool
 *
 * There will be two callers, not one: `web_robot_program_export` (F18) and the
 * download button on the IKPath inspector (F19). A gate inside the MCP tool
 * would leave the button ungated, and the second caller is always the one that
 * gets forgotten. So the gate sits at the ONE function both of them must
 * traverse — {@link ikPathToProgram} calls it before it reads a single
 * waypoint — and this module exists separately only so the verdict can be
 * reported (tier, delivery, reason) without producing a program.
 *
 * Nothing in Phase 5 has to introduce it afterwards, which was the point of
 * deciding E3 before the converter was written rather than after.
 *
 * ## What counts as "hosted"
 *
 * `hostedDeploy` is written by the hosted deploy generator itself
 * (`generateHostedSettings`, plan-640) and a project file cannot set it — it is
 * the one flag that distinguishes a real hosted deploy from any other
 * served-project boot. That is the delivery ADR-022/023 permits.
 *
 * The dev server is admitted as well, and that is a deliberate reading rather
 * than a loophole: ADR-022/023 constrains what reaches a CUSTOMER, and
 * `RV_SERVE_INFO` is `null` in every built bundle by construction (Vite
 * `define` sets it for the `serve` command only — `rv-serve-info.ts`), so no
 * delivered artifact can take this branch. Without it the feature would be
 * undevelopable and unmeasurable on the engineering machine, which is exactly
 * where plan-773 R1 requires it to be measured.
 *
 * Everything else — a CONNECT-embedded build, a `file://` kiosk, a private
 * deploy without the hosted flag — is `'local'` and is refused.
 */

import { ikSolverRegistry, type IKTier } from '../engine/rv-ik-solver';
import { getAppConfig } from '../rv-app-config';
import { RV_SERVE_INFO } from '../rv-serve-info';
import type { RobotProgramRefusal } from './rv-robot-program';

/** How this viewer was delivered, as far as the export is allowed to care. */
export type RobotProgramDelivery = 'hosted' | 'dev' | 'local';

/** The gate's answer — always complete, so a caller can report it verbatim. */
export interface RobotProgramGateVerdict {
  /** True only when a program may be produced. */
  allowed: boolean;
  /** The solver tier that was read. */
  tier: IKTier;
  /** The delivery form that was read. */
  delivery: RobotProgramDelivery;
  /** Why not — null exactly when {@link allowed} is true. */
  refusal: RobotProgramRefusal | null;
}

/** Which of the three delivery forms this runtime is. See the module header. */
export function robotProgramDelivery(): RobotProgramDelivery {
  if (getAppConfig().hostedDeploy === true) return 'hosted';
  if (RV_SERVE_INFO !== null) return 'dev';
  return 'local';
}

/**
 * May this runtime produce a robot program at all?
 *
 * Read in this order on purpose: the tier is the licence statement, the
 * delivery is the channel. A `'free'` user on a hosted deploy should be told
 * about the tier, not about hosting.
 */
export function robotProgramExportGate(): RobotProgramGateVerdict {
  const tier = ikSolverRegistry.tier;
  const delivery = robotProgramDelivery();

  if (tier !== 'pro') {
    return {
      allowed: false,
      tier,
      delivery,
      refusal: {
        code: 'tier',
        message: `Exporting a robot program needs the "pro" solver tier; this viewer runs "${tier}". `
          + 'The numbers in an exported program come out of the licensed solver, and the program is a '
          + 'delivery artifact for a real machine — so it is not produced in a degraded form. '
          + 'Rigging, solving and authoring waypoints stay available at this tier.',
      },
    };
  }

  if (delivery === 'local') {
    return {
      allowed: false,
      tier,
      delivery,
      refusal: {
        code: 'delivery',
        message: 'Exporting a robot program is available in a hosted delivery only (ADR-022/023: IK is a '
          + 'hosted-only runtime from Community upwards). This build is delivered locally, so the export '
          + 'is declined here rather than produced where nobody can verify the tool frame against the '
          + 'machine. Open the same project on the hosted viewer to export it.',
      },
    };
  }

  return { allowed: true, tier, delivery, refusal: null };
}
