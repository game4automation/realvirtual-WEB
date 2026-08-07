// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { RVSensor } from '../src/core/engine/rv-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  constructDrive,
} from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import type { FeedbackSource } from '../src/core/engine/rv-binding-slot-resolver';

interface DriveFeedbackFixture {
  drive: RVDrive;
  source: FeedbackSource & Record<string, unknown>;
}

type FeedbackDriveBehavior =
  | 'Drive_Simple'
  | 'Drive_Cylinder'
  | 'Drive_DestinationMotor'
  | 'Drive_Speed'
  | 'Drive_FollowPosition'
  | 'Drive_PositionSwitch';

function driveFeedback(
  type: FeedbackDriveBehavior,
  extras: Record<string, unknown> = {},
): DriveFeedbackFixture {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  registry.registerNode('Axis', node);
  const rv = {
    Drive: { Direction: 'LinearX' },
    [type]: extras,
  };
  node.userData.realvirtual = rv;
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, signalStore);
  if (!result || result.pendingBehaviors.length !== 1) {
    throw new Error(`Could not construct ${type}`);
  }
  const pending = result.pendingBehaviors[0];
  registry.register(pending.type, pending.path, pending.component);
  resolveComponentRefs(pending.component as unknown as Record<string, unknown>, registry);
  pending.component.init({
    registry,
    signalStore,
    scene,
    root: node,
  } as ComponentContext);
  return {
    drive: result.drive,
    source: pending.component as unknown as FeedbackSource & Record<string, unknown>,
  };
}

describe('FeedbackSource slot value contract', () => {
  it('reports both Sensor slots, including SensorNotOccupied negation', () => {
    const sensor = new RVSensor(new Object3D(), new AABB());
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(false);
    expect(sensor.readFeedbackSlot('SensorNotOccupied')).toBe(true);

    sensor.applyPhysicsResult({ getName: () => 'MU' } as never);
    expect(sensor.readFeedbackSlot('SensorOccupied')).toBe(true);
    expect(sensor.readFeedbackSlot('SensorNotOccupied')).toBe(false);
  });

  it('reports every Drive_Simple feedback slot with authored scaling', () => {
    const { drive, source } = driveFeedback('Drive_Simple', {
      ScaleSpeed: 2,
      CurrentPositionScale: 4,
      CurrentPositionOffset: 5,
      ScaleFeedbackPosition: true,
    });
    drive.currentPosition = 25;
    drive.currentSpeed = 16;
    drive.isRunning = true;

    expect(source.readFeedbackSlot('IsAtPosition')).toBe(5);
    expect(source.readFeedbackSlot('IsAtSpeed')).toBe(8);
    expect(source.readFeedbackSlot('IsDriving')).toBe(true);
  });

  it('reports every Drive_DestinationMotor feedback slot', () => {
    const { drive, source } = driveFeedback('Drive_DestinationMotor', {
      CurrentPositionScale: 4,
      CurrentPositionOffset: 5,
      ScaleFeedbackPosition: true,
    });
    drive.currentPosition = 25;
    drive.targetPosition = 25;
    drive.currentSpeed = 16;
    drive.isRunning = true;

    expect(source.readFeedbackSlot('IsAtPosition')).toBe(5);
    expect(source.readFeedbackSlot('IsAtSpeed')).toBe(16);
    expect(source.readFeedbackSlot('IsAtDestination')).toBe(true);
    expect(source.readFeedbackSlot('IsDriving')).toBe(true);
  });

  it('reports every Drive_Speed feedback slot with position scaling', () => {
    const { drive, source } = driveFeedback('Drive_Speed', {
      CurrentPositionScale: 4,
      CurrentPositionOffset: 5,
      ScaleFeedbackPosition: true,
    });
    drive.currentPosition = 25;
    drive.currentSpeed = 16;
    drive.isRunning = true;

    expect(source.readFeedbackSlot('SignalCurrentSpeed')).toBe(16);
    expect(source.readFeedbackSlot('SignalCurrentPosition')).toBe(5);
    expect(source.readFeedbackSlot('SignalIsDriving')).toBe(true);
  });

  it('reports scaled Drive_FollowPosition feedback', () => {
    const { drive, source } = driveFeedback('Drive_FollowPosition', {
      Scale: 2,
      Offset: 5,
      CurrentPositionScale: 3,
      ScaleFeedbackPosition: true,
    });
    drive.currentPosition = 25;

    expect(source.readFeedbackSlot('CurrentPosition')).toBe(30);
  });

  it('reports normal, wrapped and inverted Drive_PositionSwitch areas', () => {
    const { drive, source } = driveFeedback('Drive_PositionSwitch', {
      Areas: [
        { StartPosition: 10, EndPosition: 20 },
        { StartPosition: 350, EndPosition: 5 },
      ],
    });

    for (const [position, expected] of [
      [10, true],
      [20, true],
      [0, true],
      [355, true],
      [30, false],
    ] as const) {
      drive.currentPosition = position;
      expect(source.readFeedbackSlot('OutputSignal')).toBe(expected);
    }
    source.InvertAreas = true;
    drive.currentPosition = 30;
    expect(source.readFeedbackSlot('OutputSignal')).toBe(true);
  });

  it('reports all six Drive_Cylinder boundary and motion values', () => {
    const { drive, source } = driveFeedback('Drive_Cylinder', {
      MinPos: 10,
      MaxPos: 90,
    });

    drive.currentPosition = 90;
    drive.targetPosition = 90;
    drive.isRunning = true;
    expect([
      source.readFeedbackSlot('IsOut'),
      source.readFeedbackSlot('IsIn'),
      source.readFeedbackSlot('IsMax'),
      source.readFeedbackSlot('IsMin'),
      source.readFeedbackSlot('IsMovingOut'),
      source.readFeedbackSlot('IsMovingIn'),
    ]).toEqual([true, false, true, false, true, false]);

    drive.currentPosition = 10;
    drive.targetPosition = 10;
    expect([
      source.readFeedbackSlot('IsOut'),
      source.readFeedbackSlot('IsIn'),
      source.readFeedbackSlot('IsMax'),
      source.readFeedbackSlot('IsMin'),
      source.readFeedbackSlot('IsMovingOut'),
      source.readFeedbackSlot('IsMovingIn'),
    ]).toEqual([false, true, false, true, false, true]);
  });
});
