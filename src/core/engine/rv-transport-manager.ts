// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Scene } from 'three';
import type { RVTransportSurface } from './rv-transport-surface';
import type { RVSensor } from './rv-sensor';
import type { RVSource } from './rv-source';
import type { RVSink } from './rv-sink';
import type { RVGrip } from './rv-grip';
import type { RVGripTarget } from './rv-grip-target';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import { debug } from './rv-debug';

/**
 * RVTransportManager - Central coordinator for transport simulation.
 *
 * Manages the update order: Sources -> Transport -> Sensors -> Sinks.
 * Called from SimulationLoop.onFixedUpdate.
 */
export class RVTransportManager {
  surfaces: RVTransportSurface[] = [];
  sensors: RVSensor[] = [];
  sources: RVSource[] = [];
  sinks: RVSink[] = [];
  grips: RVGrip[] = [];
  gripTargets: RVGripTarget[] = [];
  mus: (RVMovingUnit | InstancedMovingUnit)[] = [];
  scene: Scene | null = null;

  /** Whether surface AABBs have been computed at least once (they are static). */
  private _surfaceAabbInitialized = false;

  /** Total MUs spawned since start */
  totalSpawned = 0;
  /** Total MUs consumed by sinks since start */
  totalConsumed = 0;

  /**
   * Main update loop - called every fixed timestep (16.67ms @ 60Hz).
   *
   * Order matters:
   * 1. Sources spawn new MUs
   * 2. Update surface AABBs
   * 3. Transport: each MU is moved by exactly one surface (currentSurface tracking)
   * 4. Update MU AABBs (after transport moved them)
   * 5. Sensors check overlap with MUs
   * 6. Sinks mark overlapping MUs for removal
   * 7. Remove marked MUs (reverse iteration, swap-and-pop)
   */
  update(dt: number): void {
    // 1. Sources: spawn new MUs
    for (const source of this.sources) {
      const mu = source.update(dt);
      if (mu) {
        this.mus.push(mu);
        this.totalSpawned++;
        debug('transport', `Source "${source.node.name}" spawned MU #${this.totalSpawned}: "${mu.getName()}"`);
      }
    }

    // 2. Update surface AABBs (skip for static surfaces — their mesh never moves)
    if (!this._surfaceAabbInitialized) {
      for (const surface of this.surfaces) {
        surface.updateAABB();
      }
      this._surfaceAabbInitialized = true;
    }

    // 3. Transport: each MU is moved by exactly one surface (currentSurface)
    //    Skip gripped MUs — they move with the grip node via Three.js parent chain
    for (const mu of this.mus) {
      if (mu.markedForRemoval) continue;
      if (!mu.isInstanced && (mu as RVMovingUnit).isGripped) continue;

      // Check if currentSurface still overlaps (XZ only — MUs sit ON surfaces)
      if (mu.currentSurface) {
        const curr = mu.currentSurface;
        if (curr.isActive && curr.aabb.overlapsXZ(mu.aabb)) {
          curr.transportMU(mu, dt);
          continue;
        }
        // Left the current surface
        mu.currentSurface = null;
      }

      // Find a new surface (XZ only — Y is irrelevant for belt conveyors)
      for (const surface of this.surfaces) {
        if (!surface.isActive) continue;
        if (surface.aabb.overlapsXZ(mu.aabb)) {
          mu.currentSurface = surface;
          surface.transportMU(mu, dt);
          debug('transport', `MU "${mu.getName()}" entered surface "${surface.node.name}"`);
          break;
        }
      }
    }

    // 3b. Grips: flank detection → pick/place
    for (const grip of this.grips) {
      grip.fixedUpdate();
    }

    // 4. Update MU AABBs after transport
    for (const mu of this.mus) {
      if (!mu.markedForRemoval) {
        mu.updateAABB();
      }
    }

    // 5. Sensors: check overlap
    for (const sensor of this.sensors) {
      sensor.updateAABB();
      sensor.checkOverlap(this.mus);
    }

    // 6. Sinks: mark overlapping MUs (skip gripped MUs)
    for (const sink of this.sinks) {
      sink.updateAABB();
      sink.markOverlapping(this.mus);
    }

    // 7. Remove marked MUs (reverse iteration, swap-and-pop — no splice!)
    for (let i = this.mus.length - 1; i >= 0; i--) {
      if (this.mus[i].markedForRemoval) {
        const removedMU = this.mus[i];
        // Notify grips of MU disposal
        if (!removedMU.isInstanced) {
          for (const grip of this.grips) {
            grip.onMUDisposed(removedMU as RVMovingUnit);
          }
        }
        // Clear gripTarget occupancy if this MU was placed on one
        for (const target of this.gripTargets) {
          if (target.occupiedBy === removedMU) {
            target.clearOccupied();
          }
        }
        removedMU.dispose();
        this.totalConsumed++;
        // Swap with last element and pop
        this.mus[i] = this.mus[this.mus.length - 1];
        this.mus.pop();
      }
    }

    // 8. Batch-update instance matrices after all position changes
    this.updatePoolMatrices();
  }

  /** Get counts for stats display */
  get stats() {
    let occupiedSensors = 0;
    for (const s of this.sensors) {
      if (s.occupied) occupiedSensors++;
    }
    return {
      mus: this.mus.length,
      sensors: this.sensors.length,
      sensorsOccupied: occupiedSensors,
      surfaces: this.surfaces.length,
      sources: this.sources.length,
      sinks: this.sinks.length,
      totalSpawned: this.totalSpawned,
      totalConsumed: this.totalConsumed,
    };
  }

  /**
   * Animate conveyor belt textures (scroll UV based on drive speed).
   * Called separately from update() so it also runs when the physics plugin handles transport.
   */
  updateTextureAnimations(dt: number): void {
    for (const surface of this.surfaces) {
      surface.updateTextureAnimation(dt);
    }
  }

  /**
   * Update all instance pool matrices after transport tick.
   * Call once per frame after all MU positions have been updated.
   */
  updatePoolMatrices(): void {
    for (const source of this.sources) {
      if (source.pool) {
        source.pool.updateInstanceMatrix();
      }
    }
  }

  /** Reset all state */
  reset(): void {
    // Reset grips before disposing MUs (so they release references cleanly)
    for (const grip of this.grips) {
      grip.reset();
    }
    for (const target of this.gripTargets) {
      target.clearOccupied();
    }
    for (const mu of this.mus) {
      mu.dispose();
    }
    this.mus.length = 0;
    this.totalSpawned = 0;
    this.totalConsumed = 0;
    this._surfaceAabbInitialized = false;
    for (const sensor of this.sensors) {
      sensor.occupied = false;
      sensor.occupiedMU = null;
    }
    // Dispose instance pools
    for (const source of this.sources) {
      if (source.pool) {
        source.pool.dispose();
      }
    }
  }
}
