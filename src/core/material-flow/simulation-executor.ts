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
  /**
   * Optional scene generation (plan-645 L4): the viewer counts it up whenever the
   * scene's material-flow content can have changed (placements materialised,
   * layout content added / removed). A DES runner that bound the scene remembers
   * the generation of that bind and rebinds on its next start when it moved on.
   */
  readonly sceneGeneration?: () => number;
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
  readonly simEvents?: import('../sim-event-facade').SimEventFacade;
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

  /**
   * Optional (plan-648): this executor stops being the active traffic kernel.
   * Releases every vehicle id its instances own (fleet handle, spacing, zones,
   * planner) and drops its planner state, so the incoming kernel's instances
   * can acquire them. Called by `SimulationKernel.setMode` after `clearMUs()`
   * and before the active traffic kernel changes; also on a failed switch for
   * the half-started incoming executor. The next `start()` restarts the
   * instances from their start pose.
   */
  suspend?(): void;
  /**
   * plan-2212: archive the executor's open run now (model clear / viewer
   * dispose call it BEFORE the plugins tear their state down). Optional.
   */
  archiveOpenRun?(): void;

  /**
   * Optional: the scene changed under a running executor (the deferred
   * placements of a load materialised after the executor started — boot into
   * DES). Drops what the executor discovered in the scene, discovers it anew
   * and restarts like `reset()`. Executors without scene discovery omit it;
   * the kernel then falls back to `reset()`. Never the user's reset button.
   */
  rebindScene?(): void;

  /** Tear down all resources (model-cleared / kernel dispose). */
  dispose(): void;

  /** Optional: enumerate the live instances (diagnostics / multiuser guard). */
  instances?(): ReadonlyArray<MaterialFlowInstance>;
}

/**
 * A definition whose instances own shared traffic entries per vehicle id
 * (plan-648 — the Agv). Two instances of one vehicle exist (the continuous
 * behaviour binding and the DES runner instance); only the instance of the
 * active traffic kernel may own the id. Declared on the definition so the
 * generic wiring (`defineLibraryComponent`, the DES runner) can mute and
 * release such instances without importing the behaviour.
 */
export interface TrafficOwnedDefinition {
  /** Marker: the instances own traffic ids (fleet, spacing, zones, planner). */
  readonly trafficOwned: true;
  /** True while this instance must stay silent (its kernel is not the active traffic kernel). */
  trafficMuted(self: MaterialFlowSelf): boolean;
  /** Give up everything this instance owns — a no-op for an instance that is not the owner. */
  trafficRelease(self: MaterialFlowSelf): void;
}

/** The traffic-ownership hooks of `def`, or `null` for every other definition (plan-648). */
export function trafficOwnedOf(def: MaterialFlowDefinition): TrafficOwnedDefinition | null {
  const d = def as Partial<TrafficOwnedDefinition>;
  return d.trafficOwned === true && typeof d.trafficMuted === 'function' && typeof d.trafficRelease === 'function'
    ? (d as TrafficOwnedDefinition)
    : null;
}

/** Re-export for runner authors. */
export type { MU };
