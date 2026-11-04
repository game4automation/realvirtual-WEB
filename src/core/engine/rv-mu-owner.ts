// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MU physics-owner register (plan-661 Phase 1).
 *
 * Exactly one engine moves an MU's pose at any time: the kinematic transport
 * (`'transport'`), the Rapier 3D provider (`'rapier'`) or the Box2D 2D zone
 * provider (`'box2d'`). This replaces the ownerless `physicsOwned` bool, which
 * could not tell two physics engines apart and so allowed double ownership.
 *
 * Scope: PHYSICS ownership only. Holding (grip, connection, hold zone, user
 * drag) stays on `heldBy` (`rv-mu.ts`, `rv-mu-hold.ts`) and is untouched; DES
 * never writes this field.
 *
 * Writes go through {@link setMuOwner}: a change is only legal from the
 * current owner (`by === mu.owner`) or as a claim out of `'transport'`. Any
 * other request is refused, counted and reported once per MU as the problem
 * `mu-owner-conflict` — the MU keeps its current owner.
 */

import { reportProblem } from '../hmi/problems-store';

/** Engine that owns an MU's pose. Physics ownership only — holding is `heldBy`. */
export type MuOwner = 'transport' | 'rapier' | 'box2d';

/** Minimal shape the register needs (both MU classes satisfy it). */
export interface MuOwnerTarget {
  owner: MuOwner;
  getName(): string;
}

/** Counters for diagnostics (`web_status`, tests). */
export interface MuOwnerStats {
  /** Accepted owner changes (a no-op same-owner write is not counted). */
  changes: number;
  /** Refused requests (`mu-owner-conflict`). */
  conflicts: number;
}

const _stats: MuOwnerStats = { changes: 0, conflicts: 0 };

/** True when a physics engine (Rapier or Box2D) owns the MU's pose. */
export function isPhysicsOwned(mu: { owner: MuOwner }): boolean {
  return mu.owner !== 'transport';
}

/**
 * Hands `mu` to `next`, requested by `by`. Legal when `by` is the current
 * owner, or when the MU is with the transport (a claim out of `'transport'`).
 * Returns true when the MU now belongs to `next`; false on a refused conflict.
 */
export function setMuOwner(mu: MuOwnerTarget, next: MuOwner, by: MuOwner): boolean {
  const current = mu.owner;
  if (current === next) return true;
  if (by !== current && current !== 'transport') {
    _stats.conflicts++;
    const name = mu.getName();
    reportProblem({
      id: `mu-owner-conflict:${name}`,
      severity: 'warning',
      code: 'mu-owner-conflict',
      title: `MU owner conflict on ${name}`,
      detail: `"${by}" tried to hand the MU "${name}" to "${next}", but it belongs to "${current}". `
        + 'Only the current owner may give an MU away; the MU stays with its current owner.',
    });
    return false;
  }
  mu.owner = next;
  _stats.changes++;
  return true;
}

/**
 * Unconditional reset to `'transport'` (snapshot restore, dispose). Not a
 * handover: no conflict check, not counted as a change.
 */
export function resetMuOwner(mu: { owner: MuOwner }): void {
  mu.owner = 'transport';
}

/** Read-only view of the counters. */
export function getMuOwnerStats(): Readonly<MuOwnerStats> {
  return _stats;
}

/** Test helper: zero the counters. */
export function resetMuOwnerStats(): void {
  _stats.changes = 0;
  _stats.conflicts = 0;
}
