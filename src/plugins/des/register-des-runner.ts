// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * register-des-runner.ts -- the DES runner factory the kernel injects
 * (Plan 194 §2.6 P5).
 *
 * Exports `createDesRunner`, typed as the kernel's `DesRunnerFactory`. The
 * on-demand DES feature (`src/features/des.body.ts`) hands it to the viewer via
 * `setDesRunnerFactory()`, so the kernel's `registerDesRunnerFactory` /
 * `hasDesRunner` see a real factory once DES is activated. Since plan-680 this
 * module is part of the AGPL core (it used to live in the private repo, with a
 * `null` stub in the community build).
 *
 * The factory builds a `DESRunner` (which owns the `DESManager` + `TweenRegistry`
 * and runs the event loop / sub-modes). Per-node instance construction (binding
 * each matched scene node to a `MaterialFlowAdapter`) is the model-load wiring's
 * job via `runner.addInstance(...)`; the factory hands back a started-capable
 * runner so `setMode('des')` builds and starts it and `setMode('continuous')`
 * restores the continuous runner (Reset-on-Switch).
 */

import type {
  SimulationExecutor,
  SimulationTopology,
} from '../../core/material-flow/simulation-executor';
import type { MaterialFlowDefinition } from '../../core/material-flow/define-material-flow';
import type { CoreSubsystems } from '../../core/engine/rv-core-subsystems';
import type { DesRunnerFactory } from '../../core/material-flow/simulation-kernel';
import { DESRunner } from './des-runner';

/**
 * Factory consumed by `SimulationKernel.registerDesRunnerFactory` (and the
 * viewer's lazy kernel construction, `rv-viewer._getKernel`). Builds a fresh
 * `DESRunner` for the given definitions/topology. The kernel forwards the
 * viewer's CoreSubsystems pipeline so drives/logic/visuals keep ticking at
 * 60 Hz around the event advance (Phase B runtime unification).
 */
export const createDesRunner: NonNullable<DesRunnerFactory> = (
  defs: MaterialFlowDefinition[],
  _topology: SimulationTopology,
  core?: CoreSubsystems,
): SimulationExecutor => {
  void defs; // definitions are (re)passed to runner.start() by the kernel
  return new DESRunner({ core });
};
