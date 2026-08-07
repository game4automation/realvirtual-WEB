// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BoxGeometry, Euler, Group, Mesh, MeshBasicMaterial } from 'three';
import { DriveDirection, RVDrive } from '../src/core/engine/rv-drive';
import { processMeshes } from '../src/core/engine/rv-scene-loader';

function makeDrive(direction: typeof DriveDirection[keyof typeof DriveDirection]): RVDrive {
  const node = new Group();
  const drive = new RVDrive(node);
  drive.Direction = direction;
  drive.TargetSpeed = 90;
  drive.initDrive();
  return drive;
}

describe('RVDrive jog motion', () => {
  it('rotates a positioning drive while jogging forward', () => {
    const drive = makeDrive(DriveDirection.RotationZ);
    const before = drive.node.quaternion.clone();

    drive.jogForward = true;
    drive.update(1);
    drive.update(1);

    expect(drive.currentPosition).toBe(90);
    expect(drive.node.quaternion.equals(before)).toBe(false);
  });

  it('moves backward and respects position limits', () => {
    const drive = makeDrive(DriveDirection.LinearX);
    drive.UseLimits = true;
    drive.LowerLimit = -25;
    drive.UpperLimit = 25;
    drive.jogBackward = true;

    drive.update(1);
    drive.update(1);

    expect(drive.currentPosition).toBe(-25);
    expect(drive.currentSpeed).toBe(0);
    // Unity +X maps to glTF -X, so a negative drive position moves toward +X.
    expect(drive.node.position.x).toBeCloseTo(0.025);
  });

  it('updates TransportSurface drive state while keeping its frame stationary', () => {
    const drive = makeDrive(DriveDirection.LinearX);
    drive.isTransportSurface = true;
    const before = drive.node.position.clone();

    drive.jogForward = true;
    drive.update(1);
    drive.update(1);

    expect(drive.currentPosition).toBe(90);
    expect(drive.currentSpeed).toBe(90);
    expect(drive.node.position.equals(before)).toBe(true);
  });

  it('restores the authored frame when a Drive is identified as a TransportSurface', () => {
    const node = new Group();
    node.position.set(1, 2, 3);
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.StartPosition = 100;
    drive.initDrive();

    expect(node.position.x).toBeCloseTo(0.9);

    drive.isTransportSurface = true;

    expect(drive.currentPosition).toBe(100);
    expect(node.position.toArray()).toEqual([1, 2, 3]);
  });

  it('uses acceleration and decelerates after the jog command is released', () => {
    const drive = makeDrive(DriveDirection.LinearX);
    drive.TargetSpeed = 100;
    drive.targetSpeed = 100;
    drive.Acceleration = 20;
    drive.UseAcceleration = true;
    drive.jogForward = true;

    drive.update(1); // speed 0 -> 20, position remains 0 (Unity tick order)
    drive.update(1); // position 20, speed 20 -> 40
    expect(drive.currentPosition).toBe(20);
    expect(drive.currentSpeed).toBe(40);

    drive.jogForward = false;
    drive.update(1); // position 60, speed 40 -> 20
    drive.update(1); // position 80, speed 20 -> 0

    expect(drive.currentPosition).toBe(80);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
  });

  it('Stop clears jog commands like Unity Drive.Stop()', () => {
    const drive = makeDrive(DriveDirection.RotationY);
    drive.jogForward = true;
    drive.update(1);

    drive.stop();

    expect(drive.jogForward).toBe(false);
    expect(drive.jogBackward).toBe(false);
    expect(drive.currentSpeed).toBe(0);
    expect(drive.isRunning).toBe(false);
  });
});

describe('Drive mesh classification', () => {
  it('keeps a Mesh carrying a Drive dynamic', () => {
    const root = new Group();
    const driveMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    driveMesh.userData.realvirtual = { Drive: { Direction: 'RotationZ' } };
    root.add(driveMesh);

    processMeshes(root);

    expect(driveMesh.matrixAutoUpdate).toBe(true);
  });

  it('keeps descendant meshes below a Drive dynamic', () => {
    const root = new Group();
    const driveNode = new Group();
    driveNode.userData.realvirtual = { Drive: { Direction: 'RotationZ' } };
    const childMesh = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    driveNode.add(childMesh);
    root.add(driveNode);

    processMeshes(root);

    expect(childMesh.matrixAutoUpdate).toBe(true);
  });
});

describe('RVDrive linear motion respects the object own local rotation (Space.Self)', () => {
  it('moves a locally-rotated linear drive along its OWN axis, not the parent axis', () => {
    const node = new Group();
    node.quaternion.setFromEuler(new Euler(0, Math.PI / 2, 0)); // 90° about Y
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.initDrive();            // captures the home orientation + axis
    drive.currentPosition = -25;  // mm (Unity +X → glTF -X → +local-X travel)
    drive.applyToNode();

    // Object-local +X after a 90° Y rotation points along world -Z, so the
    // 0.025 m travel lands on Z — parent-space motion would have put it on X.
    expect(drive.node.position.x).toBeCloseTo(0, 6);
    expect(drive.node.position.z).toBeCloseTo(-0.025, 6);
  });

  it('un-rotated node still travels on X (control — unchanged behavior)', () => {
    const node = new Group();
    const drive = new RVDrive(node);
    drive.Direction = DriveDirection.LinearX;
    drive.initDrive();
    drive.currentPosition = -25;
    drive.applyToNode();
    expect(drive.node.position.x).toBeCloseTo(0.025, 6);
    expect(drive.node.position.z).toBeCloseTo(0, 6);
  });
});
