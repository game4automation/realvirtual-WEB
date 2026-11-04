// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des.register.ts — declares the on-demand DES feature (plan-652 Phase 3; part of
 * the AGPL core since plan-680, before that a private feature adapter).
 *
 * It DECLARES the feature only; the body (`des.body.ts`: the runner factory,
 * des-hmi plugin, DESManager and material-flow behaviour factories) is imported the
 * first time one of the triggers fires:
 *
 *   * `mode:des`              — the workspace enters DES (dropdown, `?mode=des`, MCP),
 *   * `command:sim.discrete`  — `viewer.runtime.setMode('discrete')`,
 *   * `component:<type>`      — a model carries DESManager or a supported behaviour.
 *     Retired native component types are reported as `des-legacy-component`
 *     Problems entries when the runner binds in DES mode.
 *
 * Called by `main.ts` before the private registrations. The DES workspace mode itself
 * stays registered there (`DESWorkspacePlugin`).
 *
 * RULE: no value import from `../plugins/des/**` here — only `import type`. The
 * lazy boundary (no DES body in the entry chunk) is checked by
 * `scripts/test-bundle-guard.mjs` and `tests/des/des-public-boundary.node.test.ts`.
 */

import type { RVViewer } from '../core/rv-viewer';

/** The activation triggers of `des`. */
const ACTIVATION = [
  'mode:des',
  'command:sim.discrete',
  'component:DESManager',
  'component:Station',
  'component:Storage',
  'component:Downtime',
  'component:Processing',
  'component:PalletSource',
  'component:IndexingConveyor',
  'component:RobotHandling',
  'component:PathTransport',
] as const;

//! Declares the DES feature on the viewer's FeatureLoader (lazy, origin `core`).
export function registerDesFeature(viewer: RVViewer): void {
  viewer.features.define({
    id: 'des',
    label: 'DES simulation',
    activation: [...ACTIVATION],
    origin: 'core',
    load: () => import('./des.body'),
  });
}
