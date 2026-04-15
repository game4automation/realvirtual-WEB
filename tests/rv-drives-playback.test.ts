// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DrivesPlayback Unit Tests
 *
 * Tests frame-based drive recording playback with accumulator,
 * looping, seeking, and drive binding.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import { RVDrivesPlayback, type CompactRecording } from '../src/core/engine/rv-drives-playback';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

function makeDrive(name: string): RVDrive {
  const node = new Object3D();
  node.name = name;
  const drive = new RVDrive(node);
  drive.Direction = DriveDirection.LinearX;
  drive.ReverseDirection = false;
  drive.Offset = 0;
  drive.StartPosition = 0;
  drive.TargetSpeed = 100;
  drive.Acceleration = 100;
  drive.UseAcceleration = false;
  drive.UseLimits = false;
  drive.LowerLimit = 0;
  drive.UpperLimit = 1000;
  drive.initDrive();
  return drive;
}

function makeRecording(frames: number, driveCount: number, positions: number[]): CompactRecording {
  const drives = Array.from({ length: driveCount }, (_, i) => ({
    id: i,
    path: `drive${i}`,
  }));
  return {
    fixedDeltaTime: 0.02,
    numberFrames: frames,
    driveCount,
    drives,
    positions,
  };
}

/** Helper: create a NodeRegistry with drives registered by path */
function makeRegistry(entries: [string, RVDrive][]): NodeRegistry {
  const registry = new NodeRegistry();
  for (const [path, drive] of entries) {
    const node = new Object3D();
    node.name = path;
    registry.registerNode(path, node);
    registry.register('Drive', path, drive);
  }
  return registry;
}

describe('RVDrivesPlayback', () => {
  it('should bind drives by path', () => {
    const registry = makeRegistry([
      ['drive0', makeDrive('d0')],
      ['drive1', makeDrive('d1')],
    ]);

    const rec = makeRecording(2, 2, [0, 0, 10, 20]);
    const pb = new RVDrivesPlayback(rec, registry);

    expect(pb.totalFrames).toBe(2);
    expect(pb.frame).toBe(0);
    expect(pb.isPlaying).toBe(false);
  });

  it('should apply frame 0 positions on play', () => {
    const d0 = makeDrive('d0');
    const d1 = makeDrive('d1');
    const registry = makeRegistry([
      ['drive0', d0],
      ['drive1', d1],
    ]);

    const rec = makeRecording(2, 2, [100, 200, 300, 400]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.play();

    expect(d0.positionOverwrite).toBe(true);
    expect(d1.positionOverwrite).toBe(true);
    expect(d0.currentPosition).toBe(100);
    expect(d1.currentPosition).toBe(200);
  });

  it('should advance frames based on accumulator', () => {
    const d0 = makeDrive('d0');
    const registry = makeRegistry([['drive0', d0]]);

    // 3 frames, dt=0.02
    const rec = makeRecording(3, 1, [0, 50, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.play();

    expect(d0.currentPosition).toBe(0); // frame 0

    pb.update(0.02); // exactly one frame step
    expect(pb.frame).toBe(1);
    expect(d0.currentPosition).toBe(50);

    pb.update(0.02);
    expect(pb.frame).toBe(2);
    expect(d0.currentPosition).toBe(100);
  });

  it('should loop back to frame 0 when reaching end', () => {
    const d0 = makeDrive('d0');
    const registry = makeRegistry([['drive0', d0]]);

    const rec = makeRecording(3, 1, [0, 50, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.loop = true;
    pb.play();

    pb.update(0.02); // frame 1
    pb.update(0.02); // frame 2
    pb.update(0.02); // would be frame 3 → loops to 0
    expect(pb.frame).toBe(0);
    expect(d0.currentPosition).toBe(0);
  });

  it('should stop at last frame when not looping', () => {
    const d0 = makeDrive('d0');
    const registry = makeRegistry([['drive0', d0]]);

    const rec = makeRecording(3, 1, [0, 50, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.loop = false;
    pb.play();

    pb.update(0.02); // frame 1
    pb.update(0.02); // frame 2
    pb.update(0.02); // would be frame 3 → clamps to 2, stops
    expect(pb.frame).toBe(2);
    expect(pb.isPlaying).toBe(false);
    expect(d0.currentPosition).toBe(100);
  });

  it('should seek to percentage', () => {
    const d0 = makeDrive('d0');
    const registry = makeRegistry([['drive0', d0]]);

    const rec = makeRecording(5, 1, [0, 25, 50, 75, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.play();

    pb.seekToPercent(0.5);
    expect(pb.frame).toBe(2); // floor(0.5 * 4) = 2
    expect(d0.currentPosition).toBe(50);
  });

  it('should stop and disable positionOverwrite', () => {
    const d0 = makeDrive('d0');
    const registry = makeRegistry([['drive0', d0]]);

    const rec = makeRecording(2, 1, [0, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.play();
    expect(d0.positionOverwrite).toBe(true);

    pb.stop();
    expect(pb.isPlaying).toBe(false);
    expect(pb.frame).toBe(0);
    expect(d0.positionOverwrite).toBe(false);
  });

  it('should warn on missing drives', () => {
    const registry = new NodeRegistry(); // empty — drive0 missing

    const rec = makeRecording(2, 1, [0, 100]);
    const pb = new RVDrivesPlayback(rec, registry);
    pb.play();

    // Should not crash when applying frame
    pb.update(0.02);
    expect(pb.frame).toBe(1);
  });

  it('should throw on invalid recording', () => {
    const registry = new NodeRegistry();

    expect(() => {
      new RVDrivesPlayback(
        { fixedDeltaTime: 0, numberFrames: 1, driveCount: 1, drives: [{ id: 0, path: 'd' }], positions: [0] },
        registry,
      );
    }).toThrow();

    expect(() => {
      new RVDrivesPlayback(
        { fixedDeltaTime: 0.02, numberFrames: 2, driveCount: 1, drives: [{ id: 0, path: 'd' }], positions: [0] },
        registry,
      );
    }).toThrow(); // positions.length mismatch
  });

  it('should report progress correctly', () => {
    const registry = makeRegistry([['drive0', makeDrive('d0')]]);

    const rec = makeRecording(10, 1, new Array(10).fill(0));
    const pb = new RVDrivesPlayback(rec, registry);

    expect(pb.progress).toBe(0);
    pb.play();
    pb.seekToPercent(0.5);
    // frame = floor(0.5 * 9) = 4, progress = 4/10 = 0.4
    expect(pb.progress).toBeCloseTo(0.4);
  });
});
