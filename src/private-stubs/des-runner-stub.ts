// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-runner-stub.ts — No-op DES runner factory for public builds (Plan 194 §2.6).
 *
 * When the private folder (realvirtual-WebViewer-Private~) is absent, Vite
 * resolves `@rv-private/plugins/des/register-des-runner` (or equivalent) to
 * this stub. `createDesRunner` is `null`, so the `SimulationKernel`
 * (`hasDesRunner()`) reports the DES mode as unavailable and the Realtime/DES
 * toggle is hidden — the viewer runs continuous-only. The private build
 * replaces this with a real factory that builds a `DESRunner`.
 *
 * The type below documents the factory shape the private side provides without
 * importing anything private (keeps the public build green).
 */

import type {
  SimulationExecutor,
  SimulationTopology,
} from '../core/material-flow/simulation-executor';
import type { MaterialFlowDefinition } from '../core/material-flow/define-material-flow';
import type { CoreSubsystems } from '../core/engine/rv-core-subsystems';

/** Factory the private DES side provides; `null` in the public build. The
 *  optional `core` is the viewer's CoreSubsystems pipeline the DES runner
 *  composes into its tick (drives/visuals keep running at 60 Hz). */
export type CreateDesRunner =
  | ((defs: MaterialFlowDefinition[], topology: SimulationTopology, core?: CoreSubsystems) => SimulationExecutor)
  | null;

/** Public build: no DES runner available. */
export const createDesRunner: CreateDesRunner = null;
