// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-collision-slot.ts — the eager stand-in for the on-demand collision manager
 * (plan-781 F21).
 *
 * Collision detection is the feature `collision` (`features/collision.body.ts`);
 * its manager exists only once the feature is active. Components (CollisionRole,
 * Grip, Zone, MUPusher, MachiningVolume) and the transport's MU spawn hook still
 * need ONE registrar from the init context, also on the synchronous build paths
 * that cannot await a feature (an editor "add component", `processExtras`, a
 * runtime role edit). The viewer hands them this slot:
 *
 *   - before the manager is installed it remembers the role nodes, stock-bound
 *     providers and role-carrying MUs, and the first participating entry (a role
 *     other than `None`) asks for the feature once (`onNeeded`);
 *   - `install(manager)` replays what it remembered and from then on forwards
 *     every call unchanged.
 *
 * Model loads do not rely on it: the loader's prescan activates the feature
 * before any component is built (`component:CollisionRole`, and the field
 * trigger for `Source.CollisionRoleForMUs`). The slot is the safety net.
 */

import type { Object3D } from 'three';
import type { CollisionRoleName, CollisionRoleRegistrar, StockBoundsSource } from './rv-collision-role';
import type { IMULifecycleHook } from './rv-transport-manager';

type SpawnedMU = Parameters<IMULifecycleHook['onMUSpawned']>[0];

/** What the slot forwards to — `RVCollisionManager` in production. */
export interface CollisionSlotTarget extends CollisionRoleRegistrar, IMULifecycleHook {
  registerStockBounds(source: StockBoundsSource): void;
  unregisterStockBounds(source: StockBoundsSource): void;
}

//! Registrar and MU hook that buffers until the collision feature installs its manager.
export class CollisionRegistrarSlot implements CollisionRoleRegistrar, IMULifecycleHook {
  private _target: CollisionSlotTarget | null = null;
  private readonly _roles = new Map<Object3D, CollisionRoleName>();
  private readonly _stock = new Set<StockBoundsSource>();
  private readonly _mus = new Map<SpawnedMU, string>();
  private _requested = false;

  /** `onNeeded` activates the feature (called at most once per model). */
  constructor(private readonly _onNeeded: (() => void) | null = null) {}

  /** The installed manager, or null. */
  get target(): CollisionSlotTarget | null { return this._target; }

  register(node: Object3D, role: CollisionRoleName): void {
    if (this._target) { this._target.register(node, role); return; }
    this._roles.set(node, role);
    if (role !== 'None') this._need();
  }

  unregister(node: Object3D): void {
    if (this._target) this._target.unregister(node);
    else this._roles.delete(node);
  }

  invalidate(): void {
    this._target?.invalidate();
  }

  registerStockBounds(source: StockBoundsSource): void {
    if (this._target) this._target.registerStockBounds(source);
    else this._stock.add(source);
  }

  unregisterStockBounds(source: StockBoundsSource): void {
    if (this._target) this._target.unregisterStockBounds(source);
    else this._stock.delete(source);
  }

  onMUSpawned(mu: SpawnedMU, role: string | undefined): void {
    if (this._target) { this._target.onMUSpawned(mu, role); return; }
    if (!role || role === 'None') return;
    this._mus.set(mu, role);
    this._need();
  }

  onMURemoved(mu: SpawnedMU): void {
    if (this._target) this._target.onMURemoved(mu);
    else this._mus.delete(mu);
  }

  /** Hands everything remembered to `target` and forwards from now on. Idempotent per target. */
  install(target: CollisionSlotTarget): void {
    if (this._target === target) return;
    this._target = target;
    for (const [node, role] of this._roles) target.register(node, role);
    for (const source of this._stock) target.registerStockBounds(source);
    for (const [mu, role] of this._mus) target.onMUSpawned(mu, role);
    this._roles.clear();
    this._stock.clear();
    this._mus.clear();
  }

  /** Model change: forget what was remembered for the old model (the manager clears itself). */
  clear(): void {
    this._roles.clear();
    this._stock.clear();
    this._mus.clear();
    this._requested = false;
  }

  private _need(): void {
    if (this._requested || !this._onNeeded) return;
    this._requested = true;
    try { this._onNeeded(); } catch { /* the loader reports a failed activation itself */ }
  }
}
