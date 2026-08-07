// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * flow-backend-park-release.test.ts — plan-259 §9.3.
 *
 * `createLocalFlowBackend` park/release seams wired to the connection hold
 * controller against a REAL RVTransportManager:
 *  - park → single-MU hold (`heldBy='connection'`): transport skips the MU,
 *    other MUs keep moving (belt keeps running);
 *  - release → the MU moves again;
 *  - `Accumulate = false` → belt stop (drive stopped), restore on release;
 *  - shared drive across two surfaces: the whole line halts (accepted, O4).
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { ConnectionHoldController } from '../src/core/engine/rv-connection-hold';
import { createLocalFlowBackend } from '../src/core/sdk/rv-sdk-flow';
import type { RVDrive } from '../src/core/engine/rv-drive';

const dt = 1 / 60;

function createMU(name: string, x: number, z = 0): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, z);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

interface MockDrive {
  jogForward: boolean;
  jogBackward: boolean;
  isRunning: boolean;
  currentSpeed: number;
  targetSpeed: number;
  stop(): void;
  startMove(): void;
}

function mockDrive(speedMmPerSec: number): MockDrive {
  return {
    jogForward: false,
    jogBackward: false,
    isRunning: true,
    currentSpeed: speedMmPerSec,
    targetSpeed: speedMmPerSec,
    stop() { this.isRunning = false; this.currentSpeed = 0; },
    startMove() { this.isRunning = true; this.currentSpeed = this.targetSpeed; },
  };
}

function createSurface(x: number, drive: MockDrive, accumulate = true): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, 0, 0);
  const aabb = AABB.fromHalfSize(node, new Vector3(2.5, 0.1, 0.6));
  const surface = new RVTransportSurface(node, aabb);
  surface.TransportDirection.copy(new Vector3(1, 0, 0));
  surface.Accumulate = accumulate;
  surface.initTransport();
  surface.drive = drive as unknown as RVDrive;
  return surface;
}

function makeManager(): RVTransportManager {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  return manager;
}

function makeFlow(holds: ConnectionHoldController, manager: RVTransportManager) {
  return createLocalFlowBackend({
    onPark: (mu) => { holds.hold(mu.id, manager); },
    onRelease: (mu) => { holds.release(mu.id); },
  });
}

describe('flow backend park/release (plan-259 engine wiring)', () => {
  it('park holds a single clone MU on an accumulating belt — belt keeps running', () => {
    const manager = makeManager();
    const drive = mockDrive(1500);
    manager.surfaces.push(createSurface(2.5, drive, true));
    const muA = createMU('A', 0.5);
    const muB = createMU('B', 1.5);
    manager.mus.push(muA, muB);
    manager.update(dt); // claim surfaces

    const holds = new ConnectionHoldController();
    const flow = makeFlow(holds, manager);
    flow.accept({ id: muA.id, type: 'box' });
    flow.park(muA.id);

    expect(muA.heldBy).toBe('connection');
    expect(flow.isParked(muA.id)).toBe(true);

    const xA = muA.node.position.x;
    const xB = muB.node.position.x;
    for (let i = 0; i < 10; i++) manager.update(dt);

    expect(muA.node.position.x).toBeCloseTo(xA, 6);      // held in place
    expect(muB.node.position.x).toBeGreaterThan(xB);     // belt still moving others
    expect(drive.currentSpeed).toBe(1500);               // NO belt stop

    // Release → the MU travels again.
    flow.release(muA.id);
    expect(muA.heldBy).toBeNull();
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(muA.node.position.x).toBeGreaterThan(xA);
  });

  it('Accumulate=false → belt stop (drive stopped), restored on release', () => {
    const manager = makeManager();
    const drive = mockDrive(1500);
    manager.surfaces.push(createSurface(2.5, drive, false));
    const muA = createMU('A', 0.5);
    const muB = createMU('B', 1.5);
    manager.mus.push(muA, muB);
    manager.update(dt);

    const holds = new ConnectionHoldController();
    const flow = makeFlow(holds, manager);
    flow.accept({ id: muA.id });
    flow.park(muA.id);

    expect(muA.heldBy).toBeNull();          // NOT a single-MU hold
    expect(drive.currentSpeed).toBe(0);     // belt stopped
    const xB = muB.node.position.x;
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(muB.node.position.x).toBeCloseTo(xB, 6); // whole belt halted

    flow.release(muA.id);
    expect(drive.currentSpeed).toBe(1500);  // restored (wasRunning → startMove)
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(muB.node.position.x).toBeGreaterThan(xB);
  });

  it('shared drive across two surfaces: belt stop halts the whole line (O4)', () => {
    const manager = makeManager();
    const drive = mockDrive(1500);
    // Two segments, one motor.
    manager.surfaces.push(createSurface(2.5, drive, false));
    manager.surfaces.push(createSurface(7.5, drive, false));
    const muA = createMU('A', 1.0);   // on segment 1
    const muB = createMU('B', 6.0);   // on segment 2
    manager.mus.push(muA, muB);
    manager.update(dt);

    const holds = new ConnectionHoldController();
    holds.hold(muA.id, manager);
    expect(drive.currentSpeed).toBe(0);

    const xB = muB.node.position.x;
    for (let i = 0; i < 10; i++) manager.update(dt);
    expect(muB.node.position.x).toBeCloseTo(xB, 6); // OTHER segment halted too

    holds.release(muA.id);
    expect(drive.currentSpeed).toBe(1500);
  });

  it('double release / double park are no-ops (ledger set guard)', () => {
    const manager = makeManager();
    const drive = mockDrive(1500);
    manager.surfaces.push(createSurface(2.5, drive, true));
    const mu = createMU('A', 0.5);
    manager.mus.push(mu);
    manager.update(dt);

    const holds = new ConnectionHoldController();
    let parks = 0;
    let releases = 0;
    const flow = createLocalFlowBackend({
      onPark: (m) => { parks++; holds.hold(m.id, manager); },
      onRelease: (m) => { releases++; holds.release(m.id); },
    });
    flow.accept({ id: mu.id });
    flow.park(mu.id);
    flow.park(mu.id);      // no-op
    expect(parks).toBe(1);
    flow.release(mu.id);
    flow.release(mu.id);   // no-op
    expect(releases).toBe(1);
    expect(mu.heldBy).toBeNull();
    expect(holds.heldCount).toBe(0);
  });

  it('reset() empties ledger + parked set without firing seams', () => {
    const holds = new ConnectionHoldController();
    let seamCalls = 0;
    const flow = createLocalFlowBackend({
      onPark: () => { seamCalls++; },
      onRelease: () => { seamCalls++; },
    });
    flow.accept({ id: 1 });
    flow.park(1);
    expect(seamCalls).toBe(1);
    flow.reset();
    expect(flow.held).toHaveLength(0);
    expect(flow.isParked(1)).toBe(false);
    expect(seamCalls).toBe(1); // reset fired no seams
    void holds;
  });
});
