// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * stoponexit-instanced.test.ts — plan-259 §9.10 (decision O1).
 *
 * Instanced MUs (`useInstancing`) are never held individually — StopOnExit
 * falls back to the BELT STOP (`Accumulate=false` behavior) on their surface.
 * No silent pass-through: with a drive the belt halts; without one the hold
 * reports 'none' (warn) instead of pretending to hold.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene, BoxGeometry, MeshBasicMaterial, Quaternion } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { MUInstancePool } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { ConnectionHoldController } from '../src/core/engine/rv-connection-hold';
import type { RVDrive } from '../src/core/engine/rv-drive';

const dt = 1 / 60;

interface MockDrive {
  jogForward: boolean; jogBackward: boolean; isRunning: boolean;
  currentSpeed: number; targetSpeed: number;
  stop(): void; startMove(): void;
}

function mockDrive(speed: number): MockDrive {
  return {
    jogForward: false, jogBackward: false, isRunning: true,
    currentSpeed: speed, targetSpeed: speed,
    stop() { this.isRunning = false; this.currentSpeed = 0; },
    startMove() { this.isRunning = true; this.currentSpeed = this.targetSpeed; },
  };
}

function createSurface(drive: MockDrive | null, accumulate: boolean): RVTransportSurface {
  const node = new Object3D();
  node.position.set(2.5, 0, 0);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2.5, 0.1, 0.6)));
  surface.TransportDirection.copy(new Vector3(1, 0, 0));
  surface.Accumulate = accumulate;
  surface.initTransport();
  if (drive) surface.drive = drive as unknown as RVDrive;
  return surface;
}

function spawnInstanced(scene: Scene, x: number) {
  const pool = new MUInstancePool(
    new BoxGeometry(0.1, 0.1, 0.1), new MeshBasicMaterial(), 'box',
    new Vector3(0.05, 0.05, 0.05),
  );
  scene.add(pool.instancedMesh);
  const mu = pool.spawn(new Vector3(x, 0, 0), new Quaternion(), 'box#1', 'src');
  return { pool, mu };
}

describe('StopOnExit with instanced MUs (plan-259 O1 fallback)', () => {
  it('instanced MU on an ACCUMULATING surface still falls back to belt stop', () => {
    const scene = new Scene();
    const manager = new RVTransportManager();
    manager.scene = scene;
    const drive = mockDrive(1500);
    manager.surfaces.push(createSurface(drive, true)); // Accumulate=true — irrelevant for instanced
    const { mu } = spawnInstanced(scene, 1.0);
    manager.mus.push(mu);
    manager.update(dt); // claim the surface

    const holds = new ConnectionHoldController();
    const mode = holds.hold(mu.id, manager);
    expect(mode).toBe('belt-stop');       // NOT 'held' — no per-instance skip exists
    expect(drive.currentSpeed).toBe(0);   // the belt is stopped — no silent pass-through

    const posBefore = mu.getWorldPosition(new Vector3()).x;
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(mu.getWorldPosition(new Vector3()).x).toBeCloseTo(posBefore, 6);

    holds.release(mu.id);
    expect(drive.currentSpeed).toBe(1500);
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(mu.getWorldPosition(new Vector3()).x).toBeGreaterThan(posBefore);
  });

  it('numeric id bridges to the string muId (id spaces linked per instance)', () => {
    const scene = new Scene();
    const { mu } = spawnInstanced(scene, 0);
    expect(typeof mu.id).toBe('number');
    expect(mu.muId).toBe('box#1');
    const manager = new RVTransportManager();
    manager.mus.push(mu);
    expect(manager.muById(mu.id)).toBe(mu);
  });

  it('no drive on the surface → hold reports none (warned), never a fake hold', () => {
    const scene = new Scene();
    const manager = new RVTransportManager();
    manager.scene = scene;
    manager.surfaces.push(createSurface(null, true));
    const { mu } = spawnInstanced(scene, 1.0);
    manager.mus.push(mu);
    manager.update(dt);

    const holds = new ConnectionHoldController();
    expect(holds.hold(mu.id, manager)).toBe('none');
    expect(holds.heldCount).toBe(0);
  });
});
