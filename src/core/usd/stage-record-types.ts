// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * stage-record-types — the TYPES of the plan-2229 recording capabilities of the
 * PluginContext (`ctx.stage`, `ctx.simTime`, `ctx.simCapture`,
 * `ctx.loadGeneration`, `ctx.whenSceneReady`). Types only, so the boot set
 * carries none of it.
 *
 * Registration (tier-boundary 7, eager-source ratchet): `PluginContext extends
 * StageRecordCapabilities` and the members are OPTIONAL. The implementation
 * lives in `facades/stage-record-facades.ts`, which the USD feature loads
 * lazily; its `installStageRecordCapabilities()` defines the getters on
 * `PluginContextImpl.prototype`, so contexts created before AND after the
 * feature loaded get them. Until then every member is `undefined` =
 * "USD recorder not loaded"; `stage` is also `null` without a model.
 */

import type { Object3D, Quaternion, Vector3 } from 'three';
import type { RuntimeStageInput } from './runtime-stage-export';
import type { MuExportEntry } from './mu-export';

/** One live MU as a sampler reads it every sample (same shape as `TrackedMu`). */
export interface StageMu {
  readonly id: number;
  readonly isInstanced: boolean;
  readonly node: Object3D;
  getPosition(): Vector3;
  getQuaternion(): Quaternion;
}

/** What a runtime-stage export reads from the loaded model, taken at one moment. */
export interface StageInputSnapshot {
  /** Load generation the snapshot belongs to. */
  readonly generation: number;
  /** Model root, MU templates, MU nodes to exclude, pre-placed MUs (timeline form). */
  readonly input: RuntimeStageInput;
  /** Every MU present now (pre-placed, also inactive ones, and spawned), once per MU id. */
  readonly mus: readonly MuExportEntry[];
}

/**
 * `ctx.stage`: the running model as a runtime-stage export sees it (plan-2229 S2).
 * Replaces direct `LoadResult.transportManager` access for new plugins.
 */
export interface StageInputFacade {
  readonly generation: number;
  collect(): StageInputSnapshot | null;
  /** Live MU inventory; called every sample, allocates nothing. */
  forEachMu(fn: (mu: StageMu) => void): void;
  /** The export entry of one live MU (own node, or its source template when instanced). */
  muEntry(mu: StageMu): MuExportEntry;
}

/** `ctx.simTime`: the time of the pose the scene shows after `TickStage.POST` (plan-2229 S4). */
export interface SimTimeFacade {
  readonly kernel: 'continuous' | 'des' | 'none';
  /** Seconds. Continuous: the sim clock; DES: the render clock the tweens show. */
  readonly poseTime: number;
  /** Why the CURRENT kernel state cannot be recorded (null = it can). */
  readonly recordRefusal: string | null;
  /** Master simulation speed factor (1 = normal, 0 = stopped). */
  readonly speed: number;
}

/** One deterministic stepping session (production fixed ticks, no render). */
export interface SimCaptureSession {
  /** Advance the simulation by `ticks` fixed ticks of 1/60 s. */
  step(ticks: number): void;
  /** Set when the viewer must leave the session (model change, dispose). */
  readonly abortReason: string | null;
  /** Hand the viewer back. Idempotent; always call it (finally). */
  end(): void;
}

/** `ctx.simCapture`: facade over the viewer's capture seams (`beginCapture/captureStep/endCapture`). */
export interface SimCaptureFacade {
  /** Why `begin()` would refuse now (pure, changes nothing), or null. */
  preflight(): string | null;
  begin(): { readonly session: SimCaptureSession } | { readonly refusal: string };
}

/** The plan-2229 members of `PluginContext` (undefined until the USD feature installed them). */
export interface StageRecordCapabilities {
  /** Running model as a runtime-stage export reads it; null without a model. */
  readonly stage?: StageInputFacade | null;
  /** Sim time of the shown pose + recording refusal + speed. */
  readonly simTime?: SimTimeFacade;
  /** Deterministic stepping without render. */
  readonly simCapture?: SimCaptureFacade;
  /** Increments on every model load; compare it across awaits. */
  readonly loadGeneration?: number;
  /** Resolves when the whole scene (placements + main logic) is ready (plugins rule 3). */
  whenSceneReady?(): Promise<void>;
}
