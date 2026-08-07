// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * stoponexit-station.test.ts — plan-259 §9.5 (full-chain integration).
 *
 * Sensor (real RVSensor on a real RVTransportManager) → SensorMonitorPlugin
 * (component-event with MU ref) → ConnectionSystemPlugin (StopOnExit hold per
 * Accumulate) → QuickJS station script (`onArrival(mu)` → self.in(ProcessTime,
 * 'done', mu) → `mu.release()`) → MU travels on.
 *
 * Also: position accuracy of the hold (≤ one tick of travel after the stop),
 * double-release no-op, reset coupling (simulation-reset frees holds/replies).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D, Vector3, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import {
  RVConnectionRegistry,
  __setConnectionSystemForTests,
  getConnectionSystem,
} from '../src/core/engine/rv-connection-registry';
import {
  ConnectionHoldController,
  __setConnectionHoldsForTests,
  getConnectionHolds,
} from '../src/core/engine/rv-connection-hold';
import { createLocalFlowBackend } from '../src/core/sdk/rv-sdk-flow';
import { RV_ARRIVAL_HOOK } from '../src/core/sdk/rv-script-hook';
import { RVScriptHost } from '../src/core/engine/rv-script-host';
import { RVWebComponentRegistry, parseWebComponent } from '../src/core/engine/rv-web-component-registry';
import { SensorMonitorPlugin } from '../src/plugins/sensor-monitor-plugin';
import { ConnectionSystemPlugin } from '../src/plugins/connection-system-plugin';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVDrive } from '../src/core/engine/rv-drive';

const dt = 1 / 60;
const SPEED_MM = 1500; // 1.5 m/s → 25 mm per tick

// ── Fixture helpers ──────────────────────────────────────────────────────

function createMU(name: string, x: number): RVMovingUnit {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  return new RVMovingUnit(node, 'test-source', new Vector3(0.05, 0.05, 0.05));
}

function createSurface(accumulate: boolean): RVTransportSurface {
  const node = new Object3D();
  node.position.set(2.5, 0, 0);
  const surface = new RVTransportSurface(node, AABB.fromHalfSize(node, new Vector3(2.5, 0.1, 0.6)));
  surface.TransportDirection.copy(new Vector3(1, 0, 0));
  surface.Accumulate = accumulate;
  surface.initTransport();
  const drive = {
    jogForward: false, jogBackward: false, isRunning: true,
    currentSpeed: SPEED_MM, targetSpeed: SPEED_MM,
    stop() { drive.isRunning = false; drive.currentSpeed = 0; },
    startMove() { drive.isRunning = true; drive.currentSpeed = drive.targetSpeed; },
  };
  surface.drive = drive as unknown as RVDrive;
  return surface;
}

function createSensor(name: string, x: number): RVSensor {
  const node = new Object3D();
  node.name = name;
  node.position.set(x, 0, 0);
  const sensor = new RVSensor(node, AABB.fromHalfSize(node, new Vector3(0.05, 0.5, 0.5)));
  sensor.UseRaycast = false;
  sensor.invertSignal = false;
  return sensor;
}

/** Minimal event-bus viewer double (on/emit + transportManager). */
function makeFakeViewer(manager: RVTransportManager): RVViewer {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    transportManager: manager,
    on(name: string, cb: (data: unknown) => void) {
      let set = listeners.get(name);
      if (!set) { set = new Set(); listeners.set(name, set); }
      set.add(cb);
      return () => set!.delete(cb);
    },
    emit(name: string, data: unknown) {
      for (const cb of [...(listeners.get(name) ?? [])]) cb(data);
    },
  } as unknown as RVViewer;
}

const STATION_CODE = `
function setup(self) {
  return {
    onArrival: function (mu) {
      self.setState('processing');
      self.in(self.prop.ProcessTime, 'done', mu);
    },
    des: { on: function (hook, mu) {
      if (hook === 'done') {
        mu.release();
        mu.release(); // double release must be a no-op
        self.setState('idle');
      }
    } },
  };
}
`;

interface World {
  manager: RVTransportManager;
  viewer: RVViewer;
  mu: RVMovingUnit;
  sensorPlugin: SensorMonitorPlugin;
  connPlugin: ConnectionSystemPlugin;
  scripts: RVWebComponentRegistry;
  states: string[];
  tick(n: number): void;
  dispose(): void;
}

async function buildWorld(host: RVScriptHost, accumulate: boolean, processTime = 0.5): Promise<World> {
  const manager = new RVTransportManager();
  manager.scene = new Scene();
  manager.surfaces.push(createSurface(accumulate));
  const sensor = createSensor('Sensor-In', 2.0);
  manager.sensors.push(sensor);
  const mu = createMU('Box_1', 0.5);
  manager.mus.push(mu);

  const viewer = makeFakeViewer(manager);
  const sensorPlugin = new SensorMonitorPlugin();
  const connPlugin = new ConnectionSystemPlugin();
  connPlugin.init(viewer);
  sensorPlugin.onModelLoaded({} as LoadResult, viewer);

  // The StopOnExit edge: sensor → station.
  getConnectionSystem().loadModel({
    connections: [{ id: 'c1', source: 'Sensor-In', target: 'Cell/Station', type: 'StopOnExit' }],
    connectionTypes: [],
  });

  // Station script component (env mirrors the web-component plugin wiring).
  const states: string[] = [];
  const scripts = new RVWebComponentRegistry({
    host,
    callDeadlineMs: 200,
    buildEnv: ({ nodePath, nodeName, node, props, scheduler, addTeardown }) => {
      const holds = getConnectionHolds();
      const flow = createLocalFlowBackend({
        onPark: (m) => { holds.hold(m.id, manager); },
        onRelease: (m) => { holds.release(m.id); },
      });
      addTeardown(getConnectionSystem().registerEndpoint(nodePath, {
        onArrival: (m) => {
          const ledger = flow.accept(m);
          flow.park(ledger.id);
          scheduler.in(0, RV_ARRIVAL_HOOK, ledger, null);
        },
      }));
      return {
        name: nodeName, path: nodePath, node, props, flow, scheduler,
        onSetState: (s) => states.push(s),
        log: () => {},
      };
    },
  });
  const node = new Object3D();
  node.name = 'Station';
  const meta = parseWebComponent({ Code: STATION_CODE, ProcessTime: processTime })!;
  scripts.create('Cell/Station', node, meta);

  return {
    manager, viewer, mu, sensorPlugin, connPlugin, scripts, states,
    tick(n: number) {
      for (let i = 0; i < n; i++) {
        scripts.tickAll(dt);
        manager.update(dt);
      }
    },
    dispose() {
      scripts.dispose();
      sensorPlugin.dispose();
      connPlugin.dispose();
    },
  };
}

let host: RVScriptHost;

describe('StopOnExit station (plan-259 full chain)', () => {
  beforeEach(() => {
    __setConnectionSystemForTests(new RVConnectionRegistry());
    __setConnectionHoldsForTests(new ConnectionHoldController());
  });

  afterEach(() => {
    __setConnectionSystemForTests(null);
    __setConnectionHoldsForTests(null);
  });

  it('holds the MU at the sensor (Accumulate=true), processes, releases — belt keeps running', async () => {
    host = host ?? await RVScriptHost.create();
    const w = await buildWorld(host, true, 0.5);
    try {
      // Travel to the sensor at x=2.0 (from 0.5 at 25 mm/tick — enter ≈ tick 57;
      // ProcessTime 0.5 s releases ≈ tick 88, so probe at 60/70/110).
      w.tick(60);
      expect(w.mu.heldBy).toBe('connection');
      expect(w.states).toContain('processing');

      // Position accuracy: the hold engages within ≤ 2 ticks of travel after
      // the sensor edge — record and verify it stays put while processing.
      const heldX = w.mu.node.position.x;
      expect(heldX).toBeGreaterThan(1.88);
      expect(heldX).toBeLessThan(2.0 + 2 * (SPEED_MM / 1000) * dt + 0.11); // sensor + MU half + 2 ticks
      w.tick(10);
      expect(w.mu.node.position.x).toBeCloseTo(heldX, 6);

      // ProcessTime 0.5 s = 30 ticks → released and moving again.
      w.tick(40);
      expect(w.mu.heldBy).toBeNull();
      expect(w.states).toContain('idle');
      expect(w.mu.node.position.x).toBeGreaterThan(heldX);
      expect(getConnectionHolds().heldCount).toBe(0);
    } finally {
      w.dispose();
    }
  });

  it('Accumulate=false stops the belt instead of the single MU', async () => {
    host = host ?? await RVScriptHost.create();
    const w = await buildWorld(host, false, 0.5);
    try {
      w.tick(60);
      expect(w.mu.heldBy).toBeNull(); // belt-stop mode, no owner tag
      const drive = w.manager.surfaces[0].drive!;
      expect(drive.currentSpeed).toBe(0);

      w.tick(45); // process time elapses on the station's event heap
      expect(drive.currentSpeed).toBe(SPEED_MM); // belt restored
    } finally {
      w.dispose();
    }
  });

  it('simulation-reset releases holds and invalidates reply handles', async () => {
    host = host ?? await RVScriptHost.create();
    const w = await buildWorld(host, true, 60 /* never finishes on its own */);
    try {
      w.tick(60);
      expect(w.mu.heldBy).toBe('connection');
      (w.viewer as unknown as { emit(n: string, d: unknown): void }).emit('simulation-reset', undefined);
      expect(getConnectionHolds().heldCount).toBe(0);
      expect(w.mu.heldBy).toBeNull();
      expect(getConnectionSystem().openReplyCount).toBe(0);
    } finally {
      w.dispose();
    }
  });
});
