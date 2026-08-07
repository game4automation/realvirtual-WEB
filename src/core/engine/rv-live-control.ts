// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-live-control.ts — THIN ADAPTER (plan-320 Phase 2).
 *
 * The global "live-controlled" gate for Planner Signal Linking moved into the
 * slot-authority service ({@link module:rv-slot-authority}) together with the
 * claim/release registry and the model-switch reset owned by rv-viewer.ts.
 * This module only re-exports the unchanged function contract so existing
 * imports (engine consumers migrated; test suites and third-party code) keep
 * working with identical semantics.
 *
 * See rv-slot-authority.ts for the semantics documentation.
 */

export {
  setSignalLiveControlled,
  isSignalLiveControlled,
  isAnyLiveControlled,
  liveControlledCount,
  clearLiveControl,
} from './rv-slot-authority';
