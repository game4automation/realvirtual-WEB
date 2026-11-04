// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * behavior-kit.ts — the ONE-LINE authoring barrel for library components
 * (Plan 197 §2.4a / §12.3).
 *
 * A component author writes a single import:
 *
 *   import { defineLibraryComponent, type RV } from './_shared/behavior-kit';
 *
 * and gets the factory plus the `RV` type namespace (Self / MU / Port / Node /
 * BeltHandle / DriveHandle). The common toolkit helpers (findTransport,
 * attachBelt, surfaceOccupied, declareFlowSignals, downstreamInterlock,
 * disable, …) live on `self`, so no symbol enumeration is needed.
 *
 * `three` VALUES are deliberately NOT re-exported — `RV.Node` is a pure type
 * alias for `Object3D`, sparing the author a `three` import for typing only.
 * Power-users can still import the niche `_shared` functions directly.
 */

import type { Object3D } from 'three';
import type {
  MaterialFlowSelf,
  MU as MaterialFlowMU,
  Port as MaterialFlowPort,
  BeltHandle as MaterialFlowBeltHandle,
  DriveHandle as MaterialFlowDriveHandle,
  SignalShape as MaterialFlowSignalShape,
} from '../../core/material-flow/material-flow-self';

// ── Factory + options ──────────────────────────────────────────────────────
export {
  defineLibraryComponent,
  type LibraryComponentOptions,
} from './define-library-component';

// ── Transit-timing helper (Plan 197 §2b — already landed) ──────────────────
export {
  createTransitTimer,
  POSE_ALIGN_TOLERANCE_M,
  type TransitTimer,
  type PoseProjection,
} from './transit-timing';

/**
 * `RV` — the type namespace for component authors. Pure types only; importing
 * `type { RV }` pulls in NO runtime code.
 */
export namespace RV {
  /**
   * The shared `self` context, parameterised by the local-state slot `L` and the
   * optional signals shape `SIG` (so `self.sig.<key>` is key-checked + typed when
   * the definition declares a `signals` block).
   */
  export type Self<L = Record<string, never>, SIG extends MaterialFlowSignalShape = Record<string, never>> =
    MaterialFlowSelf<L, SIG>;
  /** A movable unit as seen by the material-flow layers. */
  export type MU = MaterialFlowMU;
  /** A unified material-flow port. */
  export type Port = MaterialFlowPort;
  /** A scene node — pure alias for `three`'s `Object3D` (no value import). */
  export type Node = Object3D;
  /** Lazy belt handle returned by `self.attachBelt`. */
  export type BeltHandle = MaterialFlowBeltHandle;
  /** Lazy positioned-drive handle returned by `self.attachDrive`. */
  export type DriveHandle = MaterialFlowDriveHandle;
}
