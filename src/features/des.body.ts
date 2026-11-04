// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des.body.ts — body of the on-demand DES feature (plan-652 Phase 3; core since plan-680).
 *
 * Imported ONLY through `des.register.ts`'s `load: () => import('./des.body')`. Importing
 * it registers the DES material-flow definitions as a module
 * side effect (idempotent Map.set) — before `activate` runs.
 *
 * `activate` runs two idempotent steps in a fixed order; a failure in a later step
 * leaves the feature `failed`, and a retry continues with the missing step:
 *   1. hand the runner factory to the viewer (also a kernel built only later),
 *   2. the HMI plugin — it reads the active DES runner.
 */

import type { RVViewer } from '../core/rv-viewer';
import { createDesRunner } from '../plugins/des/register-des-runner';
import { DESHMIPlugin } from '../plugins/des/hmi/des-hmi-plugin';
import '../plugins/des/material-flow';

//! Activates DES in the viewer. Idempotent — a retry after a failure is safe.
export function activate(viewer: RVViewer): void {
  viewer.setDesRunnerFactory(createDesRunner);
  if (!viewer.getPlugin('des-hmi')) viewer.use(new DESHMIPlugin(), 'core');
}
