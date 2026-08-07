// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * drive-follow-speed-switch.test.ts — three IDriveBehavior ports:
 *
 *   Drive_FollowPosition — drive follows the PLC position exactly (scale/offset)
 *   Drive_Speed          — signed target speed → jog fwd/stop/bwd + feedback
 *   Drive_PositionSwitch — boolean output true when position is in any area
 *
 * Each is wired manually the way the loader would after resolveComponentRefs()
 * (signal slots hold resolved store paths), then driven via drive.update().
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Scene } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDriveFollowPosition } from '../src/core/engine/rv-drive-follow-position';
import { RVDriveSpeed } from '../src/core/engine/rv-drive-speed';
import { RVDrivePositionSwitch } from '../src/core/engine/rv-drive-position-switch';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function makeBase() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Root';
  scene.add(root);

  const node = new Object3D();
  node.name = 'Axis';
  root.add(node);
  const path = NodeRegistry.computeNodePath(node);
  registry.registerNode(path, node);

  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.initDrive();
  registry.register('Drive', path, drive);

  const ctx: ComponentContext = {
    registry,
    signalStore: store,
    scene,
    transportManager: new RVTransportManager(),
    root,
  };
  return { store, registry, scene, root, node, path, drive, ctx };
}

/** Register a signal at a path so getFloatByPath / getBoolByPath / setByPath resolve. */
function addSig(store: SignalStore, path: string, type: string, seed: boolean | number) {
  store.register(path, path, seed, type);
  store.buildIndex();
}

describe('RVDriveFollowPosition', () => {
  it('follows the PLC position with scale + offset', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const posPath = `${path}/Signals/Position`;
    const fbPath = `${path}/Signals/CurrentPosition`;
    addSig(store, posPath, 'PLCOutputFloat', 0);
    addSig(store, fbPath, 'PLCInputFloat', 0);

    const b = new RVDriveFollowPosition(node);
    b.Position = posPath;
    b.CurrentPosition = fbPath;
    b.Scale = 2;
    b.Offset = 10;
    b.init(ctx);

    expect(drive.driveBehaviors.length).toBe(1);

    store.setByPath(posPath, 30);
    drive.update(1 / 60);
    // 30 * 2 + 10 = 70
    expect(drive.currentPosition).toBeCloseTo(70, 6);
    // feedback = ((70 - 10) / 2) * 1 = 30
    expect(store.getFloatByPath(fbPath)).toBeCloseTo(30, 6);
  });

  it('does not fight recording playback (positionOverwrite)', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const posPath = `${path}/Signals/Position`;
    addSig(store, posPath, 'PLCOutputFloat', 0);
    const b = new RVDriveFollowPosition(node);
    b.Position = posPath;
    b.init(ctx);

    drive.positionOverwrite = true;
    drive.currentPosition = 12.5;
    store.setByPath(posPath, 99);
    drive.update(1 / 60);
    expect(drive.currentPosition).toBe(12.5);
  });
});

describe('RVDriveSpeed', () => {
  it('jogs forward on positive speed, backward on negative, stops on zero', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const spPath = `${path}/Signals/SignalTargetSpeed`;
    addSig(store, spPath, 'PLCOutputFloat', 0);
    const b = new RVDriveSpeed(node);
    b.SignalTargetSpeed = spPath;
    b.init(ctx);

    store.setByPath(spPath, 250);
    drive.update(1 / 60);
    expect(drive.jogForward).toBe(true);
    expect(drive.jogBackward).toBe(false);
    expect(drive.targetSpeed).toBeCloseTo(250, 6);

    store.setByPath(spPath, -120);
    drive.update(1 / 60);
    expect(drive.jogForward).toBe(false);
    expect(drive.jogBackward).toBe(true);
    expect(drive.targetSpeed).toBeCloseTo(120, 6);

    store.setByPath(spPath, 0);
    drive.update(1 / 60);
    expect(drive.jogForward).toBe(false);
    expect(drive.jogBackward).toBe(false);
  });

  it('writes IsDriving / CurrentPosition feedback', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const spPath = `${path}/Signals/SignalTargetSpeed`;
    const drvPath = `${path}/Signals/SignalIsDriving`;
    const cpPath = `${path}/Signals/SignalCurrentPosition`;
    addSig(store, spPath, 'PLCOutputFloat', 0);
    addSig(store, drvPath, 'PLCInputBool', false);
    addSig(store, cpPath, 'PLCInputFloat', 0);
    const b = new RVDriveSpeed(node);
    b.SignalTargetSpeed = spPath;
    b.SignalIsDriving = drvPath;
    b.SignalCurrentPosition = cpPath;
    b.init(ctx);

    drive.currentPosition = 42;
    store.setByPath(spPath, 100);
    drive.update(1 / 60);
    // Feedback reflects the drive's position this tick.
    expect(store.getFloatByPath(cpPath)).toBeCloseTo(42, 6);
  });
});

describe('RVDrivePositionSwitch', () => {
  it('sets the output true inside an area and false outside (OR logic)', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const outPath = `${path}/Signals/OutputSignal`;
    addSig(store, outPath, 'PLCInputBool', false);
    const b = new RVDrivePositionSwitch(node);
    b.OutputSignal = outPath;
    drive.BehaviorExtras['Drive_PositionSwitch'] = {
      Areas: [
        { StartPosition: 10, EndPosition: 20 },
        { StartPosition: 50, EndPosition: 60 },
      ],
    };
    b.init(ctx);

    drive.currentPosition = 15;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(true);

    drive.currentPosition = 35;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(false);

    drive.currentPosition = 55;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(true);
  });

  it('inverts the output when InvertAreas is set', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const outPath = `${path}/Signals/OutputSignal`;
    addSig(store, outPath, 'PLCInputBool', false);
    const b = new RVDrivePositionSwitch(node);
    b.OutputSignal = outPath;
    b.InvertAreas = true;
    drive.BehaviorExtras['Drive_PositionSwitch'] = {
      Areas: [{ StartPosition: 0, EndPosition: 100 }],
    };
    b.init(ctx);

    drive.currentPosition = 50; // inside area → inverted → false
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(false);

    drive.currentPosition = 200; // outside → inverted → true
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(true);
  });

  it('supports wrapped areas (StartPosition > EndPosition)', () => {
    const { store, node, path, drive, ctx } = makeBase();
    const outPath = `${path}/Signals/OutputSignal`;
    addSig(store, outPath, 'PLCInputBool', false);
    const b = new RVDrivePositionSwitch(node);
    b.OutputSignal = outPath;
    drive.BehaviorExtras['Drive_PositionSwitch'] = {
      Areas: [{ StartPosition: 350, EndPosition: 10 }], // wraps across 0/360
    };
    b.init(ctx);

    drive.currentPosition = 355;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(true);

    drive.currentPosition = 5;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(true);

    drive.currentPosition = 180;
    drive.update(1 / 60);
    expect(store.getBoolByPath(outPath)).toBe(false);
  });
});
