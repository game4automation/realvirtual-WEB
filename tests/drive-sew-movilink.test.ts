// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-457 §9.4 — RVDriveSEWMovilink, the port of Drive_SEWMovilink.cs.
 *
 * MOVILINK is the profile where the obvious control word is the wrong one: bit 0
 * is the INVERTED controller inhibit and bits 1/2 are active low, so the enable
 * byte is 0x06 and 0x07 holds the drive inhibited. These tests pin that, the
 * priority cascade (Fault > Inhibit > RapidStop > Stop > Enable), the status
 * word of every state against the C# reference (Drive_SEWMovilink.cs L179–201),
 * both speed encodings and the rising-edge-only fault reset.
 *
 * GLB-free: components are built with `constructComponentOnNode`, the same
 * harness as tests/drive-behavior-runtime-attach.test.ts.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  constructComponentOnNode,
  type DriveLifecycleHost,
  type RuntimeNodeDeps,
} from '../src/core/engine/rv-scene-loader';
import { RVDrive } from '../src/core/engine/rv-drive';
import { RVDriveSEWMovilink } from '../src/core/engine/rv-drive-sew-movilink';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';

class FakeDriveHost implements DriveLifecycleHost {
  readonly drives: RVDrive[] = [];
  addDrive(drive: RVDrive): boolean {
    if (this.drives.includes(drive)) return false;
    this.drives.push(drive);
    return true;
  }
  removeDrive(drive: RVDrive): boolean {
    const i = this.drives.indexOf(drive);
    if (i < 0) return false;
    this.drives.splice(i, 1);
    return true;
  }
}

const SIGNALS = {
  ControlWord1: { path: 'Root/Axis/CW1', type: 'PLCOutputInt' },
  SpeedSetpoint: { path: 'Root/Axis/SP', type: 'PLCOutputInt' },
  StatusWord1: { path: 'Root/Axis/SW1', type: 'PLCInputInt' },
  SpeedActual: { path: 'Root/Axis/SA', type: 'PLCInputInt' },
} as const;

function harness() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);
  const registry = new NodeRegistry();
  registry.registerNode('Root', root);
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const events = new EventEmitter<ViewerEvents>();
  const deps: RuntimeNodeDeps = {
    registry, signalStore, scene, transportManager,
    driveHost: new FakeDriveHost(), events,
  };
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {};
  root.add(axis);
  registry.registerNode('Root/Axis', axis);

  // The four MOVILINK process-data signals, registered like a GLB export would.
  for (const [slot, { path, type }] of Object.entries(SIGNALS)) {
    const node = new Object3D();
    node.name = path.split('/').pop()!;
    axis.add(node);
    registry.registerNode(path, node);
    registry.register(type, path, { address: path, signalName: node.name });
    signalStore.register(node.name, path, 0, type);
    void slot;
  }
  signalStore.buildIndex();

  return { scene, root, axis, registry, signalStore, events, deps };
}

interface Rig {
  h: ReturnType<typeof harness>;
  drive: RVDrive;
  behavior: RVDriveSEWMovilink;
  /** Write control word 1 and the speed setpoint, then run one behavior tick. */
  tick(cw: number, setpoint?: number): void;
  sw(): number;
  speedActual(): number;
}

function rig(overrides: Record<string, unknown> = {}): Rig {
  const h = harness();
  const drive = constructComponentOnNode(h.deps, h.axis, 'Drive', {
    Direction: 'LinearX',
  }) as RVDrive;

  const refs = Object.fromEntries(Object.entries(SIGNALS).map(([slot, { path, type }]) => [
    slot,
    { type: 'ComponentReference', path, componentType: type },
  ]));
  const behavior = constructComponentOnNode(
    h.deps, h.axis, 'Drive_SEWMovilink', { ...refs, ...overrides },
  ) as RVDriveSEWMovilink;

  return {
    h, drive, behavior,
    tick(cw: number, setpoint = 0) {
      h.signalStore.setByPath(SIGNALS.ControlWord1.path, cw);
      h.signalStore.setByPath(SIGNALS.SpeedSetpoint.path, setpoint);
      behavior.update(1 / 60);
    },
    sw: () => h.signalStore.getFloatByPath(SIGNALS.StatusWord1.path),
    speedActual: () => h.signalStore.getFloatByPath(SIGNALS.SpeedActual.path),
  };
}

// Control word low bytes (MOVILINK): bit 0 = inhibit, bits 1/2 active low.
const CW_ZERO = 0x0000;      // fail-safe: inhibit released? no — bit1/2 = 0 → rapid stop
const CW_INHIBIT = 0x0001;
const CW_RAPID_STOP = 0x0004; // inhibit released, NoRapidStop = 0
const CW_STOP = 0x0002;       // inhibit released, NoRapidStop = 1, NoStop = 0
const CW_ENABLE = 0x0006;
const CW_ENABLE_WRONG = 0x0007; // the classic pitfall: bit 0 set = inhibit
const CW_RESET = 1 << 6;

let r: Rig;

describe('RVDriveSEWMovilink', () => {
  beforeEach(() => { r = rig(); });

  it('starts Inhibited and writes status word 0x0104', () => {
    expect(r.behavior.State).toBe('Inhibited');
    r.tick(CW_INHIBIT);
    expect(r.behavior.State).toBe('Inhibited');
    // Bit 2 (PoDataEnabled) is ALWAYS set, high byte 1 = controller inhibit.
    expect(r.sw()).toBe(0x0104);
  });

  it('status word per state matches the C# reference', () => {
    r.tick(CW_INHIBIT);
    expect(r.sw()).toBe(0x0104);

    r.tick(CW_RAPID_STOP);
    expect(r.behavior.State).toBe('RapidStop');
    expect(r.sw()).toBe(0x0206);

    r.tick(CW_STOP);
    expect(r.behavior.State).toBe('Stop');
    expect(r.sw()).toBe(0x0206);

    r.tick(CW_ENABLE);
    expect(r.behavior.State).toBe('Enabled');
    expect(r.sw()).toBe(0x0407);

    r.behavior.SimulateFault = true;
    r.tick(CW_ENABLE);
    expect(r.behavior.State).toBe('Fault');
    expect(r.sw()).toBe(0x0624); // FaultCode 6 in the high byte, bit 5 set
  });

  it('enable byte 0x06 with setpoint 0x4000 drives at MaxSpeed forward', () => {
    r.behavior.MaxSpeed = 250;
    r.tick(CW_ENABLE, 0x4000);
    expect(r.behavior.State).toBe('Enabled');
    expect(r.drive.targetSpeed).toBeCloseTo(250, 6);
    expect(r.drive.jogForward).toBe(true);
    expect(r.drive.jogBackward).toBe(false);
  });

  it('0x07 keeps the drive inhibited (bit 0 is the inhibit)', () => {
    r.tick(CW_ENABLE_WRONG, 0x4000);
    expect(r.behavior.State).toBe('Inhibited');
    expect(r.drive.jogForward).toBe(false);
    expect(r.sw()).toBe(0x0104);
  });

  it('a zeroed control word is the fail-safe no-enable state', () => {
    r.tick(CW_ZERO, 0x4000);
    expect(r.behavior.State).toBe('RapidStop');
    expect(r.drive.jogForward).toBe(false);
  });

  it('negative setpoint jogs backward', () => {
    r.behavior.MaxSpeed = 100;
    r.tick(CW_ENABLE, -8192); // -50 %
    expect(r.drive.jogBackward).toBe(true);
    expect(r.drive.jogForward).toBe(false);
    expect(r.drive.targetSpeed).toBeCloseTo(50, 6);
  });

  it('Rpm encoding: 15000 raw = 3000 rpm = MaxSpeed', () => {
    r.behavior.Encoding = 'Rpm';
    r.behavior.MaxSpeedRpm = 3000;
    r.behavior.MaxSpeed = 100;
    r.tick(CW_ENABLE, 15000); // 15000 / 5 = 3000 rpm = nmax
    expect(r.drive.targetSpeed).toBeCloseTo(100, 6);
    expect(r.drive.jogForward).toBe(true);

    // Feedback uses the same encoding in reverse.
    r.drive.currentSpeed = 100;
    r.tick(CW_ENABLE, 15000);
    expect(r.speedActual()).toBe(15000);
  });

  it('priority: inhibit beats rapid stop beats stop beats enable', () => {
    // Inhibit bit set together with every enable bit → still inhibited.
    r.tick(CW_INHIBIT | CW_ENABLE, 0x4000);
    expect(r.behavior.State).toBe('Inhibited');

    // Rapid stop (bit 1 low) wins over stop being fine and enable bits set.
    r.tick(0x0004, 0x4000); // inhibit released, NoRapidStop = 0, NoStop = 1
    expect(r.behavior.State).toBe('RapidStop');

    // Only the stop bit low → Stop, not Enabled.
    r.tick(0x0002, 0x4000);
    expect(r.behavior.State).toBe('Stop');

    // All three released → Enabled.
    r.tick(CW_ENABLE, 0x4000);
    expect(r.behavior.State).toBe('Enabled');
  });

  it('SimulateFault sets fault bit 5 and the FaultCode high byte; reset only on a rising edge', () => {
    r.behavior.FaultCode = 6;
    r.behavior.SimulateFault = true;
    r.tick(CW_ENABLE);
    expect(r.behavior.State).toBe('Fault');
    expect(r.sw() & (1 << 5)).toBe(1 << 5);
    expect((r.sw() >> 8) & 0xff).toBe(6);

    // Reset bit held while the fault source is still on → stays faulted.
    r.tick(CW_ENABLE | CW_RESET);
    expect(r.behavior.State).toBe('Fault');

    // Source cleared but the reset bit is STILL high (no new edge) → stays faulted.
    r.behavior.SimulateFault = false;
    r.tick(CW_ENABLE | CW_RESET);
    expect(r.behavior.State).toBe('Fault');

    // Falling edge, then a rising edge → acknowledged.
    r.tick(CW_ENABLE);
    expect(r.behavior.State).toBe('Fault');
    r.tick(CW_ENABLE | CW_RESET);
    expect(r.behavior.State).toBe('Inhibited');
  });

  it('writes feedback while liveControlled', () => {
    r.behavior.liveControlled = true;
    r.drive.liveControlled = true;
    r.behavior.MaxSpeed = 100;
    r.drive.currentSpeed = 50;
    r.tick(CW_ENABLE, 0x4000);
    expect(r.sw()).toBe(0x0407);
    expect(r.speedActual()).toBe(8192); // 50 % of MaxSpeed → 0x2000
  });

  it('schema field list matches the C# field names', () => {
    expect(Object.keys(RVDriveSEWMovilink.schema)).toEqual([
      'ControlWord1',
      'SpeedSetpoint',
      'StatusWord1',
      'SpeedActual',
      'MaxSpeed',
      'Encoding',
      'MaxSpeedRpm',
      'Acceleration',
      'SimulateFault',
      'FaultCode',
    ]);
  });

  it('attaches to the Drive and is listed as its behavior', () => {
    expect(r.drive.driveBehaviors).toContain(r.behavior);
    expect(r.drive.Behaviors).toEqual(['Drive_SEWMovilink']);
  });
});
