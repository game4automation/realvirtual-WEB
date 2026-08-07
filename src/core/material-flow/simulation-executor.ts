// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * simulation-executor.ts — the executor contract (Plan 194 §2.6).
 *
 * A `SimulationExecutor` is the active engine behind the `SimulationKernel`
 * (P1). The kernel owns exactly one at a time — the public `ContinuousRunner`
 * (owns the TransportManager, 60 Hz) or the private `DESRunner` (event queue).
 * The kernel switches via Reset-on-Switch: `clearMUs()` on the outgoing
 * executor, then `start()` on the incoming one. There is intentionally NO
 * `KernelSnapshot` — Plan 194 §3.3 chose Reset-on-Switch for v1.
 */

import type { Object3D } from 'three';
import type { MaterialFlowDefinition } from './define-material-flow';
import type { MaterialFlowSelf, MU } from './material-flow-self';
import type { BindContextHost } from '../behavior-runtime';

/** Topology handed to an executor at start (resolved ports per instance). */
export interface SimulationTopology {
  /** Scene root the executor operates on. */
  readonly root: Object3D;
  /**
   * Optional bind-context host (the RVViewer) the DES runner uses on `start()`
   * to discover placed material-flow components in the scene and build a
   * per-node `self`. Absent in programmatic/unit-test setups, where instances
   * are added directly via `runner.addInstance(...)`. Kept structural (no
   * private import) so the public core stays DES-runner-independent.
   */
  readonly host?: BindContextHost;
}

/**
 * One live material-flow component: its definition, the shared `self`, and the
 * adapter that bridges it to the active runner. `adapter` is `unknown` here so
 * the public core never depends on the (private) DES adapter concretely.
 */
export interface MaterialFlowInstance {
  readonly def: MaterialFlowDefinition;
  readonly self: MaterialFlowSelf;
  /** Bridge to the active runner (MaterialFlowAdapter or a ContinuousRunner bind handle). */
  readonly adapter: unknown;
}

/**
 * The executor a `SimulationKernel` drives. Both the continuous and DES runners
 * implement this so the kernel is mode-agnostic.
 */
export interface SimulationExecutor {
  /** Mode tag for the kernel/UI ('continuous' | 'des'). */
  readonly mode: 'continuous' | 'des';

  /** Live MU count (Reset-on-Switch assertions read this). */
  readonly muCount: number;

  /** Begin simulating the given definitions over `topology` (fresh, empty). */
  start(defs: MaterialFlowDefinition[], topology: SimulationTopology): void;

  /**
   * Optional pre-PRE pass — the CoreSubsystems early stage (playback → logic →
   * IK → replay). Runs BEFORE the TickStage.PRE plugin hooks so these
   * subsystems see last tick's signals, exactly as the legacy fixedUpdate did.
   */
  earlyTick?(dt: number): void;

  /** Advance one fixed tick (continuous: drives → transport.update → fixedUpdate → visuals). */
  tick(dt: number): void;

  /** Optional post-tick pass (mirrors lateFixedUpdate / late-phase transport). */
  lateTick?(dt: number): void;

  /** Remove all MUs (Reset-on-Switch outgoing step) without disposing the executor. */
  clearMUs(): void;

  /** Reset to the initial state (re-seedable; used by resetSimulation). */
  reset(): void;

  /** Tear down all resources (model-cleared / kernel dispose). */
  dispose(): void;

  /** Optional: enumerate the live instances (diagnostics / multiuser guard). */
  instances?(): ReadonlyArray<MaterialFlowInstance>;
}

/** Re-export for runner authors. */
export type { MU };
