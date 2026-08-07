// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sdk-flow.ts — continuous MU/flow backend for script components
 * (plan-210 §9 phase 1b).
 *
 * `createLocalFlowBackend()` is the CONTINUOUS-kernel implementation of the
 * Tier-1 MU surface (`self.transfer/spawn/mus/currentLoad`, `mu.park/
 * release`): a self-contained MU ledger with explicit host seams.
 *
 * Semantics (mirrors `MaterialFlowSelf` continuous behavior):
 *  - `spawn()`  — mints a tracked MU (structural; the host may attach a scene
 *    node via `nodeOf`). The MU is ADDED to the ledger (`accept` semantics).
 *  - `accept(mu)` — books an externally-arriving MU into the ledger (hosts /
 *    the DES station dispatch call this on onAccept).
 *  - `transfer(mu, portId?)` — removes the MU from the ledger and calls the
 *    optional `onTransfer` seam (continuous default: the transport surface
 *    moves the part — the hand-off itself is implicit, exactly like
 *    `MaterialFlowSelf.transfer` without a DES backend).
 *  - `park/release` — the generic Tier-1 primitive (§6b survey gap):
 *    CONTINUOUS = surface halt. The ledger flags the MU (`prop.__parked`) and
 *    calls the `onPark/onRelease` seam; live hosts wire it to the transport
 *    halt (the same hold mechanism Grip uses: `RVMovingUnit.isGripped` blocks
 *    transport + sink consumption). DES = capacity slot — a parked MU keeps
 *    counting against `currentLoad` so the station's `canAccept` back-pressure
 *    holds; that contract is implemented by the DES-side backend (documented,
 *    see plan §9 phase 1b).
 *
 * The DES kernel does NOT use this backend — there the runner's MU management
 * is authoritative (runner-injected `SdkFlowBackend`).
 */

import type { Object3D } from 'three';
import type { ScriptMuRef } from './rv-script-hook';
import type { SdkFlowBackend } from './rv-sdk-self';

/** A ledger MU — a `ScriptMuRef` with a mutable prop bag. */
export interface LocalFlowMu {
  readonly id: number;
  readonly type: string;
  readonly prop: Record<string, unknown>;
}

export interface LocalFlowBackendOptions {
  /** MU template/type name stamped on spawned MUs. Default `''`. */
  muType?: string;
  /** Seed for the MU id counter (e.g. to avoid clashes across components). */
  firstId?: number;
  /** Downstream hand-off seam (`self.transfer`). Continuous default: none. */
  onTransfer?(mu: LocalFlowMu, portId: string | null): void;
  /** Surface-halt seam (`mu.park()`) — wire to the real transport hold. */
  onPark?(mu: LocalFlowMu): void;
  /** Surface-release seam (`mu.release()`). */
  onRelease?(mu: LocalFlowMu): void;
  /** Scene-node resolver for `mu.node` (optional). */
  nodeOf?(mu: LocalFlowMu): Object3D | null;
  /** Single-successor downstream interlock (`self.downstreamOccupied()`). */
  downstreamOccupied?(): boolean;
}

/** The continuous flow backend plus its host-side ledger controls. */
export interface LocalFlowBackend extends SdkFlowBackend {
  /** Always present on the local backend (optional on the base interface). */
  park(muId: number): void;
  /** Always present on the local backend (optional on the base interface). */
  release(muId: number): void;
  /** Book an externally-arriving MU into the ledger (accept semantics). */
  accept(mu: ScriptMuRef): LocalFlowMu;
  /** The live ledger (held MUs, including parked ones). */
  readonly held: ReadonlyArray<LocalFlowMu>;
  /** True when the MU with `muId` is currently parked. */
  isParked(muId: number): boolean;
  /**
   * Simulation-reset coupling (plan-259 §5.2): empty the ledger and the
   * parked set WITHOUT firing the park/release seams — the engine-side holds
   * are released by their own reset path (ConnectionHoldController).
   */
  reset(): void;
}

export function createLocalFlowBackend(opts: LocalFlowBackendOptions = {}): LocalFlowBackend {
  const held: LocalFlowMu[] = [];
  const parked = new Set<number>();
  let nextId = opts.firstId ?? 1;

  const find = (muId: number): LocalFlowMu | undefined => held.find((m) => m.id === muId);

  return {
    // ── SdkFlowBackend ─────────────────────────────────────────────────
    spawn(): ScriptMuRef {
      const mu: LocalFlowMu = { id: nextId++, type: opts.muType ?? '', prop: {} };
      held.push(mu);
      return mu;
    },
    transfer(mu: ScriptMuRef | null, portId?: string | null): void {
      if (!mu) return;
      const i = held.findIndex((m) => m.id === mu.id);
      const ledgerMu = i >= 0 ? held[i] : { id: mu.id, type: mu.type ?? '', prop: { ...(mu.prop ?? {}) } };
      if (i >= 0) held.splice(i, 1);
      parked.delete(mu.id);
      opts.onTransfer?.(ledgerMu, portId ?? null);
    },
    mus(): ReadonlyArray<ScriptMuRef> {
      return held;
    },
    currentLoad(): number {
      return held.length;
    },
    downstreamOccupied: opts.downstreamOccupied,
    park(muId: number): void {
      if (parked.has(muId)) return;
      parked.add(muId);
      const mu = find(muId);
      if (mu) {
        mu.prop['__parked'] = true;
        opts.onPark?.(mu);
      }
    },
    release(muId: number): void {
      if (!parked.delete(muId)) return;
      const mu = find(muId);
      if (mu) {
        mu.prop['__parked'] = false;
        opts.onRelease?.(mu);
      }
    },
    muNode(muId: number): Object3D | null {
      const mu = find(muId);
      return mu ? (opts.nodeOf?.(mu) ?? null) : null;
    },

    // ── Ledger controls (host side) ─────────────────────────────────────
    accept(mu: ScriptMuRef): LocalFlowMu {
      const existing = find(mu.id);
      if (existing) return existing;
      const ledgerMu: LocalFlowMu = { id: mu.id, type: mu.type ?? '', prop: { ...(mu.prop ?? {}) } };
      held.push(ledgerMu);
      return ledgerMu;
    },
    get held(): ReadonlyArray<LocalFlowMu> {
      return held;
    },
    isParked(muId: number): boolean {
      return parked.has(muId);
    },
    reset(): void {
      held.length = 0;
      parked.clear();
    },
  };
}
