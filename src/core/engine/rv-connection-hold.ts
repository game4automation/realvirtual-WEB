// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connection-hold.ts — the MU hold controller behind StopOnExit
 * (plan-259 F6: the TRANSPORT SURFACE decides HOW an MU is stopped).
 *
 * Hold mode per MU, decided at hold time from its current surface:
 *
 *  - **Single-MU hold** (`Accumulate = true`, clone MU): the MU gets the
 *    connection owner tag (`heldBy = 'connection'`) — the transport loop
 *    skips it, the belt keeps running, following MUs accumulate behind it
 *    (gap clamp, plan-255). Preferred mode.
 *  - **Belt stop** (`Accumulate = false` OR instanced MU, decision O1): the
 *    surface's DRIVE is stopped (jog flags saved). Refcounted per drive so
 *    two held MUs on one belt release correctly; NOTE (accepted, O4): a
 *    drive shared across several surfaces stops the whole line.
 *
 * Instanced MUs (`useInstancing`) are NEVER held individually — they have no
 * per-instance transport skip — so they always use the belt-stop fallback
 * (documented limitation, plan-259 O1).
 *
 * All holds are idempotent per MU id; `releaseHold` only releases what THIS
 * controller acquired (owner rule O1b — grip-held MUs are never touched).
 */

import type { RVDrive } from './rv-drive';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { RVTransportSurface } from './rv-transport-surface';

/** Narrow lookup surface (satisfied by RVTransportManager). */
export interface MuLookup {
  muById(id: number): (RVMovingUnit | InstancedMovingUnit) | null;
}

interface DriveStopRecord {
  drive: RVDrive;
  jogForward: boolean;
  jogBackward: boolean;
  wasRunning: boolean;
  /** Number of held MUs currently stopping this drive. */
  refs: number;
}

interface HoldRecord {
  kind: 'held' | 'belt-stop';
  mu: RVMovingUnit | InstancedMovingUnit;
  drive: RVDrive | null;
}

export type HoldMode = 'held' | 'belt-stop' | 'none';

/** Per-session hold controller (one per connection system). */
export class ConnectionHoldController {
  private readonly holds = new Map<number, HoldRecord>();
  private readonly driveStops = new Map<RVDrive, DriveStopRecord>();

  /** Number of currently held MUs (tests/diagnostics). */
  get heldCount(): number {
    return this.holds.size;
  }

  /** True when the MU with `muId` is currently held by a connection. */
  isHeld(muId: number): boolean {
    return this.holds.has(muId);
  }

  /**
   * Hold the MU with engine id `muId`. Idempotent. Returns the applied hold
   * mode ('none' when the MU is unknown or already grip-held by another
   * subsystem — a grip-held MU is never re-owned, plan-259 O1b).
   */
  hold(muId: number, lookup: MuLookup): HoldMode {
    const existing = this.holds.get(muId);
    if (existing) return existing.kind;

    const mu = lookup.muById(muId);
    if (!mu) return 'none';

    const surface = mu.currentSurface ?? mu.lastSurface ?? null;
    const accumulate = surface
      ? surface.Accumulate !== false && RVTransportSurface.accumulateDefault
      : true;

    // Preferred: single-MU hold via the owner tag (clone MUs on accumulating
    // surfaces). Instanced MUs cannot be held individually (O1).
    if (!mu.isInstanced && accumulate) {
      const clone = mu as RVMovingUnit;
      if (clone.heldBy === 'grip') return 'none'; // grip owns it — never steal
      clone.heldBy = 'connection';
      this.holds.set(muId, { kind: 'held', mu, drive: null });
      return 'held';
    }

    // Fallback: belt stop via the surface's drive (Accumulate=false or
    // instanced MU). O4 accepted: a shared drive halts the whole line.
    const drive = surface?.drive ?? null;
    if (!drive) {
      console.warn(`[connections] StopOnExit: MU #${muId} has no surface drive to stop — MU passes through`);
      return 'none';
    }
    let rec = this.driveStops.get(drive);
    if (!rec) {
      rec = {
        drive,
        jogForward: drive.jogForward,
        jogBackward: drive.jogBackward,
        wasRunning: drive.isRunning || drive.currentSpeed !== 0,
        refs: 0,
      };
      this.driveStops.set(drive, rec);
      drive.jogForward = false;
      drive.jogBackward = false;
      drive.stop();
    }
    rec.refs++;
    this.holds.set(muId, { kind: 'belt-stop', mu, drive });
    return 'belt-stop';
  }

  /** Release the hold on `muId`. Only frees what THIS controller holds
   *  (owner rule); double release is a warn + no-op upstream (flow ledger). */
  release(muId: number): void {
    const rec = this.holds.get(muId);
    if (!rec) return;
    this.holds.delete(muId);

    if (rec.kind === 'held') {
      const clone = rec.mu as RVMovingUnit;
      if (clone.heldBy === 'connection') clone.heldBy = null;
      return;
    }

    // Belt stop: decrement the drive refcount; restore at zero.
    const drive = rec.drive!;
    const stop = this.driveStops.get(drive);
    if (!stop) return;
    stop.refs--;
    if (stop.refs > 0) return;
    this.driveStops.delete(drive);
    drive.jogForward = stop.jogForward;
    drive.jogBackward = stop.jogBackward;
    if (stop.wasRunning && !stop.jogForward && !stop.jogBackward) {
      drive.startMove();
    }
  }

  /** Release everything (simulation reset / model clear). */
  releaseAll(): void {
    for (const muId of [...this.holds.keys()]) this.release(muId);
    this.holds.clear();
    this.driveStops.clear();
  }
}

// ─── Session singleton (viewer wiring) ──────────────────────────────────────

let activeHolds: ConnectionHoldController | null = null;

/** The shared per-session hold controller (lazy). The web-component plugin's
 *  flow seams (`onPark`/`onRelease`) and the connection-system plugin share it. */
export function getConnectionHolds(): ConnectionHoldController {
  activeHolds ??= new ConnectionHoldController();
  return activeHolds;
}

/** Test seam: replace the session hold controller. */
export function __setConnectionHoldsForTests(c: ConnectionHoldController | null): void {
  activeHolds = c;
}
