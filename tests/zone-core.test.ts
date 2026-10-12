// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * zone-core.test.ts — plan-521 §9.1: Zone box, activation, Detect, reset and
 * the 100 zones × 500 MUs measurement.
 *
 * Same deterministic style as transport-accumulation.test.ts: synchronous
 * fixed-dt loops over `manager.update(dt)`, mock drives, no rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import { Object3D, Scene, Vector3, type Material, type Mesh } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVZone, ZONE_COLOR_BLOCK, ZONE_COLOR_HOLD } from '../src/core/engine/rv-zone';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';

const DT = 1 / 60;
const MU_HALF = new Vector3(0.05, 0.05, 0.05);

function createMU(name: string, x: number, y: number, z: number, parent?: Object3D): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, y, z);
  parent?.add(node);
  return new RVMovingUnit(node, 'test-source', MU_HALF.clone());
}

function createSurface(x: number, y: number, z: number, half: Vector3, dir: Vector3, speed: number): RVTransportSurface {
  const node = new Object3D();
  node.position.set(x, y, z);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, half));
  surface.TransportDirection.copy(dir);
  surface.Radial = false;
  surface.TextureScale = 1;
  surface.HeightOffsetOverride = 0;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: speed, name: 'mock-drive' } as unknown as RVTransportSurface['drive'];
  return surface;
}

function createManager(): RVTransportManager {
  const m = new RVTransportManager();
  m.scene = new Scene();
  return m;
}

/** A zone registered directly (no loader) — box in mm on `node`. */
function createZone(manager: RVTransportManager, node: Object3D, size: [number, number, number], center: [number, number, number] = [0, 0, 0]): RVZone {
  const zone = new RVZone(node);
  zone.Size.set(...size);
  zone.Center.set(...center);
  manager.zones.add(zone);
  return zone;
}

function run(manager: RVTransportManager, ticks: number): void {
  for (let i = 0; i < ticks; i++) manager.update(DT);
}

interface MockDrive {
  currentPosition: number;
  isRunning: boolean;
  jogForward: boolean;
  jogBackward: boolean;
  claimedMoveThisTick: boolean;
}
function mockDrive(pos: number): MockDrive {
  return { currentPosition: pos, isRunning: false, jogForward: false, jogBackward: false, claimedMoveThisTick: false };
}

describe('Zone box (F1)', () => {
  it('follows its node: Center/Size in local mm, moved and rotated parent', () => {
    const manager = createManager();
    const parent = new Object3D();
    const node = new Object3D();
    parent.add(node);
    parent.position.set(1, 0, 0);
    const zone = createZone(manager, node, [200, 100, 50], [100, 0, 0]);
    zone.updateBounds();
    expect(zone.bounds.min.x).toBeCloseTo(1.0, 6);
    expect(zone.bounds.max.x).toBeCloseTo(1.2, 6);
    expect(zone.bounds.max.z - zone.bounds.min.z).toBeCloseTo(0.05, 6);

    parent.rotation.y = Math.PI / 2; // local +X → world −Z
    zone.updateBounds();
    expect(zone.bounds.max.x - zone.bounds.min.x).toBeCloseTo(0.05, 6);
    expect(zone.bounds.min.z).toBeCloseTo(-0.2, 6);
    expect(zone.bounds.max.z).toBeCloseTo(0, 6);

    zone.Size.set(0, 100, 100);
    zone.updateBounds();
    expect(zone.bounds.isEmpty()).toBe(true);
  });
});

describe('Zone activation (F3)', () => {
  it('Always is active from the first tick', () => {
    const manager = createManager();
    const zone = createZone(manager, new Object3D(), [100, 100, 100]);
    run(manager, 1);
    expect(zone.active).toBe(true);
  });

  it('Signal follows the bool signal, InvertSignal flips it', () => {
    const manager = createManager();
    const store = new SignalStore();
    store.register('Act', 'Signals/Act', false);
    const zone = new RVZone(new Object3D());
    zone.Activation = 'Signal';
    zone.ActivationSignal = 'Signals/Act';
    const ctx = { transportManager: manager, signalStore: store } as unknown as ComponentContext;
    zone.init(ctx);
    run(manager, 1);
    expect(zone.active).toBe(false);
    store.setByPath('Signals/Act', true);
    run(manager, 1);
    expect(zone.active).toBe(true);
    zone.InvertSignal = true;
    run(manager, 1);
    expect(zone.active).toBe(false);
    zone.dispose();
    expect(manager.zones.has(zone)).toBe(false);
  });

  it('Axis: active only inside the window AND at standstill; a running drive deactivates at once', () => {
    const manager = createManager();
    const zone = createZone(manager, new Object3D(), [100, 100, 100]);
    const drive = mockDrive(0);
    zone.Activation = 'Axis';
    zone.ActivationDrive = drive as unknown as RVDrive;
    zone.AxisFrom = -15;
    zone.AxisTo = -15;
    run(manager, 2);
    expect(zone.active).toBe(false); // outside the window

    drive.isRunning = true;
    drive.currentPosition = -15;     // inside, but still moving
    run(manager, 1);
    expect(zone.active).toBe(false);
    drive.isRunning = false;         // arrived
    run(manager, 1);
    expect(zone.active).toBe(true);
    drive.jogForward = true;
    run(manager, 1);
    expect(zone.active).toBe(false);
    drive.jogForward = false;
    run(manager, 1);
    expect(zone.active).toBe(true);

    // From > To is normalised
    zone.AxisFrom = 10;
    zone.AxisTo = -20;
    run(manager, 1);
    expect(zone.active).toBe(true);
  });

  it('Axis standstill is robust: behaviour-driven motion (isRunning false) does not activate until the position stops', () => {
    const manager = createManager();
    const zone = createZone(manager, new Object3D(), [100, 100, 100]);
    const drive = mockDrive(0);
    zone.Activation = 'Axis';
    zone.ActivationDrive = drive as unknown as RVDrive;
    zone.AxisFrom = -100;
    zone.AxisTo = 100;
    run(manager, 1);
    for (let i = 0; i < 10; i++) {
      drive.currentPosition += 5; // PositionOverwrite-style motion, no flags
      manager.update(DT);
      expect(zone.active).toBe(false);
    }
    manager.update(DT); // position unchanged → standstill
    expect(zone.active).toBe(true);
    drive.claimedMoveThisTick = true; // a behaviour claimed and moved the axis
    manager.update(DT);
    expect(zone.active).toBe(false);
  });
});

describe('Zone Detect (F4)', () => {
  it('occupied on a 3D overlap, not for an MU on another level; inactive = free', () => {
    const manager = createManager();
    const node = new Object3D();
    const zone = createZone(manager, node, [200, 200, 200]);
    const mu = createMU('part', 0, 0, 0);
    manager.mus.push(mu);
    run(manager, 1);
    expect(zone.occupied).toBe(true);

    mu.node.position.y = 1; // same XZ, another level
    run(manager, 1);
    expect(zone.occupied).toBe(false);

    mu.node.position.y = 0;
    zone.Activation = 'Signal'; // no signal → inactive
    run(manager, 1);
    expect(zone.occupied).toBe(false);

    zone.Activation = 'Always';
    zone.Detect = false;
    run(manager, 1);
    expect(zone.occupied).toBe(false);
  });

  it('SignalOccupied is written only on a change', () => {
    const manager = createManager();
    const store = new SignalStore();
    store.register('Occ', 'Signals/Occ', false);
    const writes: unknown[] = [];
    store.subscribeByPath('Signals/Occ', (v) => writes.push(v));
    const zone = new RVZone(new Object3D());
    zone.Size.set(200, 200, 200);
    zone.SignalOccupied = 'Signals/Occ';
    zone.init({ transportManager: manager, signalStore: store } as unknown as ComponentContext);
    const mu = createMU('part', 0, 0, 0);
    manager.mus.push(mu);
    run(manager, 5);
    expect(store.getBoolByPath('Signals/Occ')).toBe(true);
    expect(writes).toEqual([true]);
    mu.node.position.x = 2;
    run(manager, 5);
    expect(writes).toEqual([true, false]);
  });

  it('an MU spawned in the activation tick is seen in that tick; a moving parent carries the box', () => {
    const manager = createManager();
    const parent = new Object3D();
    const node = new Object3D();
    parent.add(node);
    const zone = createZone(manager, node, [200, 200, 200]);
    const mu = createMU('spawned', 0, 0, 0);
    manager.mus.push(mu); // arrives right before the first (activation) tick
    run(manager, 1);
    expect(zone.active).toBe(true);
    expect(zone.occupied).toBe(true);

    parent.position.x = 3; // the axis moves the box away
    run(manager, 1);
    expect(zone.occupied).toBe(false);
  });

  it('identical Detect result below and above bruteForceThreshold', () => {
    const results: boolean[][] = [];
    for (const threshold of [Infinity, 0]) {
      const manager = createManager();
      manager.bruteForceThreshold = threshold;
      const surface = createSurface(0, 0, 0, new Vector3(3, 0.1, 0.5), new Vector3(1, 0, 0), 800);
      manager.surfaces.push(surface);
      const zones: RVZone[] = [];
      for (let i = 0; i < 4; i++) {
        const n = new Object3D();
        n.position.set(-2 + i * 1.2, 0, 0);
        zones.push(createZone(manager, n, [150, 300, 300]));
      }
      for (let i = 0; i < 6; i++) manager.mus.push(createMU(`mu${i}`, -2.8 + i * 0.3, 0, 0));
      const trace: boolean[] = [];
      for (let t = 0; t < 240; t++) {
        manager.update(DT);
        for (const z of zones) trace.push(z.occupied);
      }
      results.push(trace);
    }
    expect(results[1]).toEqual(results[0]);
    expect(results[0].some(Boolean)).toBe(true);
  });
});

describe('Zone reset (F12)', () => {
  it('reset clears occupied, active and the edge memory', () => {
    const manager = createManager();
    const zone = createZone(manager, new Object3D(), [200, 200, 200]);
    zone.Hold = true;
    const mu = createMU('part', 0, 0, 0);
    manager.mus.push(mu);
    run(manager, 2);
    expect(zone.occupied).toBe(true);
    expect(zone.held).toHaveLength(1);
    manager.reset();
    expect(zone.occupied).toBe(false);
    expect(zone.active).toBe(false);
    expect(zone.held).toHaveLength(0);
    expect(mu.heldBy).toBeNull();
    // After the reset the rising edge fires again (OnActivate re-arms).
    const again = createMU('again', 0, 0, 0);
    manager.mus.push(again);
    run(manager, 1);
    expect(zone.held).toEqual([again]);
  });

  it('a zone without effects is reported once at init', () => {
    const manager = createManager();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const zone = new RVZone(new Object3D());
    zone.Detect = false;
    zone.Activation = 'Axis';
    zone.init({ transportManager: manager, signalStore: new SignalStore() } as unknown as ComponentContext);
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).toContain('no effect set');
    expect(text).toContain('needs ActivationDrive');
    warn.mockRestore();
    zone.dispose();
  });
});

describe('Zone gizmo (F9, Phase 5)', () => {
  it('box under the node, colour by effect, state by activation/occupancy, gone after dispose', () => {
    const scene = new Scene();
    const gizmos = new GizmoOverlayManager(scene);
    const manager = createManager();
    const store = new SignalStore();
    store.register('Act', 'Signals/Act', false);
    const node = new Object3D();
    scene.add(node);
    const zone = new RVZone(node);
    zone.Size.set(200, 100, 50);
    zone.Center.set(10, 0, 0);
    zone.Block = true;
    zone.Activation = 'Signal';
    zone.ActivationSignal = 'Signals/Act';
    zone.init({ transportManager: manager, signalStore: store, gizmoManager: gizmos } as unknown as ComponentContext);
    const { edges, faces } = zone.gizmo;
    expect(edges).not.toBeNull();
    expect(faces).not.toBeNull();
    expect(edges!.root.parent).toBe(node);
    expect(faces!.root.parent).toBe(node);
    expect(edges!.root.userData._rvGizmo).toBe(true);
    expect(edges!.root.position.x).toBeCloseTo(0.01, 9);
    expect(edges!.root.scale.x).toBeCloseTo(0.2, 9);
    expect(faces!.root.scale.z).toBeCloseTo(0.05, 9);
    const edgeMat = (): Material & { opacity: number; color: { getHex(): number } } =>
      (edges!.root as unknown as Mesh).material as never;
    const faceMat = (): Material & { opacity: number } => (faces!.root as unknown as Mesh).material as never;

    run(manager, 1);
    expect(edgeMat().color.getHex()).toBe(ZONE_COLOR_BLOCK);
    expect(edgeMat().opacity).toBeCloseTo(0.35, 6); // inactive: faint
    expect(faceMat().opacity).toBeCloseTo(0.05, 6);

    store.setByPath('Signals/Act', true);
    run(manager, 1);
    expect(edgeMat().opacity).toBeCloseTo(0.95, 6); // active: solid
    expect(faceMat().opacity).toBeCloseTo(0.15, 6);

    manager.mus.push(createMU('part', 0, 0, 0));
    run(manager, 1);
    expect(zone.occupied).toBe(true);
    expect(faceMat().opacity).toBeCloseTo(0.3, 6);

    zone.Hold = true; // strongest effect wins: Hold > Block > Detect
    run(manager, 1);
    expect(edgeMat().color.getHex()).toBe(ZONE_COLOR_HOLD);

    zone.dispose();
    expect(edges!.root.parent).toBeNull();
    expect(faces!.root.parent).toBeNull();
    expect(zone.gizmo.edges).toBeNull();
    gizmos.destroy();
  });
});

describe('Zone performance (plan-521 NFR)', () => {
  it('100 zones × 500 MUs: zone share per tick, mean over 300 ticks', () => {
    const build = (withZones: boolean): RVTransportManager => {
      const manager = createManager();
      // 10 parallel belts, 50 MUs each, running +X.
      for (let lane = 0; lane < 10; lane++) {
        const z = lane * 1.5;
        manager.surfaces.push(createSurface(0, 0, z, new Vector3(20, 0.1, 0.5), new Vector3(1, 0, 0), 500));
        for (let i = 0; i < 50; i++) manager.mus.push(createMU(`mu${lane}_${i}`, -19 + i * 0.75, 0, z));
        if (withZones) {
          for (let k = 0; k < 10; k++) {
            const n = new Object3D();
            n.position.set(-18 + k * 4, 0, z);
            const zone = createZone(manager, n, [100, 300, 300]);
            // All detect; a third also Block but switched off by its signal
            // (an active Block would stop the lanes and make the loaded run
            // cheaper than the baseline).
            if (k % 3 === 0) { zone.Block = true; zone.Activation = 'Signal'; }
          }
        }
      }
      return manager;
    };
    const measure = (manager: RVTransportManager): number => {
      run(manager, 60); // warm-up (JIT, grid)
      const t0 = performance.now();
      run(manager, 300);
      return (performance.now() - t0) / 300;
    };
    // ABBA to damp drift.
    const a1 = measure(build(false));
    const b1 = measure(build(true));
    const b2 = measure(build(true));
    const a2 = measure(build(false));
    const base = (a1 + a2) / 2;
    const withZones = (b1 + b2) / 2;
    const share = withZones - base;
    console.log(`[plan-521] 100 zones × 500 MUs: base ${base.toFixed(3)} ms/tick, with zones ${withZones.toFixed(3)} ms/tick, zone share ${share.toFixed(3)} ms/tick`);
    expect(Number.isFinite(share)).toBe(true);
    expect(share).toBeLessThan(0.5);
  });
});
