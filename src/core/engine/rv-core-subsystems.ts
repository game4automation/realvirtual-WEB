// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { DesSnapshotBlockers } from '../material-flow/des-snapshot-blockers';

/**
 * CoreSubsystems — the per-tick core subsystem pipeline, extracted VERBATIM
 * from `RVViewer.fixedUpdate` so the SimulationExecutors (ContinuousRunner /
 * DESRunner) can drive it instead of the viewer hard-wiring it.
 *
 * Split into the three stages the executors compose:
 *
 * - {@link early}  — pre-PRE subsystems: playback → logic → IK paths → replay
 *                    (runs BEFORE interfaces flush PLC signals, as always).
 * - {@link drives} — drive physics loop + render/shadow dirty flags +
 *                    MU-count spawn/despawn diff.
 * - {@link visuals} — belt texture animations + tank fill + gizmo blink +
 *                    pipe flow (always run, even when a physics plugin or the
 *                    DES event queue owns transport).
 *
 * The exact update ORDER of the legacy fixedUpdate is preserved; the executor
 * contract (`earlyTick` → kernel `tick` → `lateTick`) slots these stages into
 * the same positions. The dirty-flag choreography (belt-shadow refresh,
 * MU-count diff) is behavior-sensitive — do not reorder within a stage.
 *
 * The host is a narrow structural slice of RVViewer (same `*Like` pattern as
 * `TransportManagerLike` in continuous-runner.ts) so the pipeline is
 * unit-testable with plain mocks and the file stays free of heavy imports.
 * All host fields are read PER CALL — the viewer reassigns the underlying
 * managers/arrays on every model load, so nothing may be captured.
 */

import { isActiveForState, type ActiveOnly } from './rv-active-only';

/** Slice of RVDrivesPlayback the pipeline drives. */
export interface PlaybackLike {
  readonly isPlaying: boolean;
  readonly activeOnly: ActiveOnly;
  syncLiveControl(): void;
  update(dt: number): void;
}

/** Slice of RVLogicEngine the pipeline drives. */
export interface LogicEngineLike {
  snapshotBlockerReason?(): string | null;
  /** Names of the root containers that exist and are active for the current connection state (DES batch guard). */
  batchPresence?(): string[];
  readonly activeOnly: ActiveOnly;
  /** plan-538: per-root `Active` transitions for the connection state. Optional
   *  so plain test fakes can omit it. Runs even while `activeOnly` is closed. */
  updateConnection?(isConnected: boolean): void;
  fixedUpdate(dt: number): void;
}

/** Slice of RVIKPath the pipeline drives. */
export interface IKPathLike {
  readonly PathIsActive?: boolean;
  readonly node?: { readonly name: string };
  fixedUpdate(dt: number): void;
}

/** Slice of RVReplayRecording the pipeline drives. */
export interface ReplayRecordingLike {
  readonly isActive?: boolean;
  readonly activeOnly: ActiveOnly;
  fixedUpdate(dt: number): void;
}

/** Slice of RVDrive the pipeline drives (motion + dirty-flag inputs). */
export interface DriveLike {
  readonly isRunning: boolean;
  readonly positionOverwrite: boolean;
  readonly jogForward: boolean;
  readonly jogBackward: boolean;
  readonly isTransportSurface: boolean;
  /** A behavior claimed the axis AND moved it this tick (RVDrive getter).
   *  Optional so plain test fakes can omit it. */
  readonly claimedMoveThisTick?: boolean;
  update(dt: number): void;
}

/** Slice of RVTransportManager the pipeline reads (MU count + texture anims). */
export interface TransportVisualsLike {
  readonly mus: ReadonlyArray<unknown>;
  readonly surfaces: ReadonlyArray<{ readonly isActive: boolean }>;
  readonly hasVanishingMU: boolean;
  updateTextureAnimations(dt: number): void;
}

/**
 * Narrow host the pipeline reads — implemented by RVViewer via lazy getters.
 * Managers are nullable exactly where the viewer's fields are nullable
 * (populated on model load).
 */
export interface CoreSubsystemsHost {
  /** `connectionState === 'Connected'` — gates ActiveOnly subsystems. */
  readonly isConnected: boolean;
  readonly playback: PlaybackLike | null;
  readonly logicEngine: LogicEngineLike | null;
  readonly ikPaths: ReadonlyArray<IKPathLike>;
  readonly replayRecordings: ReadonlyArray<ReplayRecordingLike>;
  readonly drives: ReadonlyArray<DriveLike>;
  readonly transportManager: TransportVisualsLike | null;
  readonly tankFillManager: { update(): boolean } | null;
  readonly pipeFlowManager: { update(dt: number): boolean } | null;
  /** tick() returns true when a blinking material's opacity was written. */
  readonly gizmoManager: { tick(elapsedMs: number): boolean };
  readonly lampManager: { update(dt: number): boolean } | null;
  /** Scene-button press/turn animation + momentary timers (plan-417). A true
   *  return means geometry moved — render AND shadow dirty.
   *
   *  OPTIONAL like `machiningManager`: hosts without interactive buttons (the
   *  embed runtime, unit-test fakes) simply omit it. */
  readonly sceneButtonManager?: { update(dt: number): boolean } | null;
  /** EnergyChain bone update. A true return means BOTH render and shadow dirty. */
  readonly energyChainManager: { update(dt: number): boolean } | null;
  /** Chain element poses (plan-733). A true return means BOTH render and shadow
   *  dirty.
   *
   *  OPTIONAL like `machiningManager`: hosts that never load a chain (the embed
   *  runtime, unit-test fakes) simply omit it, so adding the subsystem does not
   *  force a `null` on every existing host implementation. */
  readonly chainManager?: { update(dt: number): boolean } | null;
  /** Web path advance (plan-459). A true return means BOTH render and shadow
   *  dirty — the band and the rolls are real geometry moved outside the drive
   *  loop.
   *
   *  OPTIONAL like `chainManager`: hosts that never load a web (the embed
   *  runtime, unit-test fakes) simply omit it. */
  readonly ribbonManager?: { update(dt: number): boolean } | null;
  /** CSG machining tick (plan-405): submits tool poses and applies the chunk
   *  meshes that came back from the worker. A true return means BOTH render and
   *  shadow dirty — a machined chunk changes the silhouette.
   *
   *  OPTIONAL, unlike its siblings: hosts that never load a machining model
   *  (the embed viewer, unit-test fakes) simply omit it. Making it required
   *  would force every host to carry a `null` for a subsystem it cannot use. */
  readonly machiningManager?: { update(dt: number): boolean } | null;
  /**
   * Following-error / overload diagnostics of the dynamic axes and the grip
   * loads (plan-673 Phase 4). Runs at the END of the drive stage: the drive
   * loop is what applies the position the physics reported and fires the
   * feedback bindings, so running earlier would publish last tick's numbers.
   * A true return means a published value changed — render dirty (a readout
   * moved), never shadows (nothing moved).
   *
   * OPTIONAL like `machiningManager`: a host without dynamic axes (the embed
   * runtime, unit-test fakes) simply omits it.
   */
  readonly axisDiagnostics?: { update(dt: number): boolean } | null;
  /** Collision check (plan-394). Runs LAST in the visuals stage so it sees the
   *  poses of this tick. A true return means a NEW collision was reported (new
   *  highlight) — render dirty, no shadow change (nothing moved). */
  readonly collisionManager: { update(dt: number): boolean } | null;
  markRenderDirty(): void;
  markShadowsDirty(): void;
  /** The viewer's own blocker registry; without one the subsystems cannot block a DES snapshot. */
  readonly snapshotBlockers?: DesSnapshotBlockers;
}

export class CoreSubsystems {
  private readonly host: CoreSubsystemsHost;
  /** Last-seen MU count for the spawn/despawn dirty diff (was RVViewer._prevMuCount). */
  private _prevMuCount = 0;

  private readonly offSnapshotBlocker: (() => void) | null;
  dispose(): void { this.offSnapshotBlocker?.(); }

  constructor(host: CoreSubsystemsHost) {
    this.host = host;
    this.offSnapshotBlocker = host.snapshotBlockers?.register('core', () => {
      const h = this.host;
      const reasons = [h.logicEngine?.snapshotBlockerReason?.(),
        h.ikPaths.some(p => p.PathIsActive) ? 'active IK path' : null,
        h.playback?.isPlaying ? 'playback playing' : null,
        h.replayRecordings.some(r => r.isActive) ? 'active replay recording' : null].filter(Boolean);
      return reasons.length ? reasons.join('; ') : null;
    }, () => {
      // Presence, not activity: the batch pauses the viewer, so logic that merely exists would stand still (plan-2062).
      const h = this.host;
      return [{ system: 'LogicStep', nodes: h.logicEngine?.batchPresence?.() ?? [] },
        { system: 'IK path', nodes: h.ikPaths.map(p => p.node?.name ?? 'IKPath') }];
    }) ?? null;
  }

  /**
   * Geometry was moved outside the drive loop (e.g. DES tweens writing vehicle
   * or MU transforms) — request a render and a shadow refresh. Without it the
   * on-demand render loop only repaints on the next user input.
   */
  markGeometryMoved(): void {
    this.host.markRenderDirty();
    this.host.markShadowsDirty();
  }

  /**
   * Pre-PRE subsystems: playback → LogicStep engine → IK path replay →
   * ReplayRecordings. Runs BEFORE the TickStage.PRE plugin hooks (interfaces
   * flush incoming PLC signals there), exactly as the legacy fixedUpdate did.
   */
  early(dt: number): void {
    const h = this.host;
    const isConnected = h.isConnected;

    h.playback?.syncLiveControl();
    // Recording playback — guarded by DrivesRecorder.Active
    if (h.playback && h.playback.isPlaying && isActiveForState(h.playback.activeOnly, isConnected)) {
      h.playback.update(dt);
    }

    // LogicStep engine. plan-538: the per-root `Active` transitions (start /
    // stop of virtual-PLC roots on a connection change) are processed FIRST and
    // independently of the engine-wide guard — a closed guard must not hide a
    // transition. Only the tick itself is guarded.
    const logic = h.logicEngine;
    if (logic) {
      logic.updateConnection?.(isConnected);
      if (isActiveForState(logic.activeOnly, isConnected)) logic.fixedUpdate(dt);
    }

    // Robot IK path replay engine — runs after LogicStep (so LogicStep-started
    // paths advance the same frame) and BEFORE the drive loop (so target/overwrite
    // writes apply this frame).
    for (const ik of h.ikPaths) {
      ik.fixedUpdate(dt);
    }

    // ReplayRecording signal-triggered sequences — each has its own Active
    for (const rr of h.replayRecordings) {
      if (isActiveForState(rr.activeOnly, isConnected)) {
        rr.fixedUpdate(dt);
      }
    }
  }

  /**
   * Core drive physics loop (behaviors + motion; `drives` may be topologically
   * sorted) plus the render/shadow dirty flags and the MU-count spawn/despawn
   * diff. Runs at the head of the executor `tick`, BEFORE transport.
   */
  drives(dt: number): void {
    const h = this.host;

    for (const drive of h.drives) {
      drive.update(dt);
      // `claimedMoveThisTick`: a behavior (Drive_FollowPosition) wrote the
      // position without arming physics — only true on ticks where it moved.
      if (drive.isRunning || drive.positionOverwrite || drive.claimedMoveThisTick) {
        h.markRenderDirty();
        // TransportSurface drives don't move geometry — only belt speed changes.
        // Positioning drives can jog too and must refresh their moving shadows.
        if (!drive.isTransportSurface) {
          h.markShadowsDirty();
        }
      }
    }

    // Mark shadows + render dirty when the MU count changes (spawn/despawn).
    // Shadows for MUs that *move* (riding an active belt) are handled in the
    // visuals stage — conveyor drives are jogForward/jogBackward, so the drive
    // loop above intentionally skips the shadow flag for them.
    const muCount = h.transportManager ? h.transportManager.mus.length : 0;
    if (muCount !== this._prevMuCount) {
      h.markShadowsDirty();
      h.markRenderDirty();
    }
    this._prevMuCount = muCount;

    // plan-673 Phase 4 — net following error, torque, saturation, part slip.
    // Last in the stage, for the ordering reason documented on the host field.
    if (h.axisDiagnostics?.update(dt)) h.markRenderDirty();
  }

  /**
   * Visual managers: belt texture animation (+ the active-belt / vanishing-MU
   * dirty flags), tank fill clip planes, gizmo blink loop, pipe flow rings.
   * Always runs — even when a physics plugin or the DES event queue owns
   * transport (texture anims and gizmos are render concerns, not transport).
   */
  visuals(dt: number): void {
    const h = this.host;

    // ── Texture animation (always runs, even when physics plugin handles transport) ──
    const tm = h.transportManager;
    if (tm) {
      tm.updateTextureAnimations(dt);
      // Mark render dirty when any surface is actively animating its belt texture.
      const muCount = tm.mus.length;
      for (const surface of tm.surfaces) {
        if (surface.isActive) {
          h.markRenderDirty();
          // MUs riding an active belt move every frame. Conveyor drives are
          // jogForward/jogBackward, so the drive loop above intentionally skips
          // the shadow flag for them — meaning the shadow map would otherwise stay
          // frozen at the MU's spawn position. Regenerate it each frame while a
          // belt carries MUs so MU shadows track the parts dynamically.
          if (muCount > 0) h.markShadowsDirty();
          break;
        }
      }
      // Keep the renderer awake while an MU plays its end-of-line burn dissolve
      // / spawn grow-out (the MU is parked, so nothing else would mark the frame
      // dirty). The MU footprint changes during these effects, so refresh shadows too.
      if (tm.hasVanishingMU) {
        h.markRenderDirty();
        h.markShadowsDirty();
      }
    }

    // ── Tank fill visualization (clip plane updates) ──
    if (h.tankFillManager && h.tankFillManager.update()) {
      h.markRenderDirty();
    }

    // ── Gizmo overlay blink loop (early-returns when no entries) ──
    // Smooth-pulsing gizmos write opacity every tick; without the dirty flag
    // the on-demand render loop would freeze the pulse mid-fade.
    if (h.gizmoManager.tick(dt * 1000)) {
      h.markRenderDirty();
    }

    // ── Lamp symmetric blink loop (early-returns when no lamps are flashing) ──
    if (h.lampManager?.update(dt)) {
      h.markRenderDirty();
    }

    // ── Scene-button caps (plan-417): press/turn animation and the momentary
    // release timers. Shadow dirty as well — the cap is real geometry moved
    // outside the drive loop, so its shadow would otherwise stay frozen.
    if (h.sceneButtonManager?.update(dt)) {
      h.markRenderDirty();
      h.markShadowsDirty();
    }

    // ── EnergyChain bone update (runs AFTER the drive stage, so the follower
    // pose of this frame is already applied). Marks SHADOW dirty as well: a
    // chain can be moved by a live PLC signal or an external transform, and
    // neither raises the drive-loop shadow flag above — its shadow would
    // otherwise stay frozen in the rest pose.
    if (h.energyChainManager?.update(dt)) {
      h.markRenderDirty();
      h.markShadowsDirty();
    }

    // ── Chain element poses (plan-733). Placed here for the same reason as the
    // energy chain: it must run AFTER the drive stage, because an element's pose
    // is derived from `drive.currentPosition` and reading a stale value would put
    // the whole chain one tick behind its own drive. Shadow dirty as well — the
    // drive loop skips the shadow flag for transport-surface drives, and a chain
    // hanging off one would otherwise drag a frozen shadow behind it.
    if (h.chainManager?.update(dt)) {
      h.markRenderDirty();
      h.markShadowsDirty();
    }

    // ── Web paths (plan-459). Same placement and the same reason as the two
    // above: the web speed and, in winder-master mode, the rotational master
    // reading both come from the drive values of THIS tick, so the stage has to
    // sit after `drives()`. Shadow dirty as well — a growing roll and a moving
    // band change the silhouette without ever touching the drive loop.
    if (h.ribbonManager?.update(dt)) {
      h.markRenderDirty();
      h.markShadowsDirty();
    }

    // ── CSG material removal (plan-405). Runs in the visuals stage AFTER the
    // drive stage on purpose: the tool poses submitted here must be the ones
    // the freshly applied axis positions of THIS tick produce, otherwise every
    // cut lags one tick behind the machine. Applying the chunk meshes that
    // arrived from the worker happens in the same call. A true return means the
    // workpiece silhouette changed — render AND shadow dirty (nothing else in
    // the pipeline raises the shadow flag for a geometry-only change).
    if (h.machiningManager?.update(dt)) {
      h.markRenderDirty();
      h.markShadowsDirty();
    }

    // ── Pipe flow visualization (animated rings) ──
    if (h.pipeFlowManager && h.pipeFlowManager.update(dt)) {
      h.markRenderDirty();
    }

    // ── Collision check (plan-394) — LAST, so drives, kinematics, transport
    // and the energy-chain rig of THIS tick are all applied. A new hit paints
    // the aux highlight and raises the modal within the same tick; the
    // simulation is never stopped.
    if (h.collisionManager?.update(dt)) {
      h.markRenderDirty();
    }
  }
}
