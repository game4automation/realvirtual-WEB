// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 S6 — Unity parity (TransportSurface.AfterDriveStartInit): a surface
 * whose exported `TransportDirection` is (0,0,0) (a Unity scene exported before
 * it ever ran — the blow-moulding line's TransportAuslauf) takes its axis from the linear
 * drive instead of the old (1,0,0) fallback. An authored direction still wins.
 */
import { describe, it, expect } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import { DriveDirection, directionToGltfAxis } from '../src/core/engine/rv-coordinate-utils';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';

function setup(dir: DriveDirection, reverse: boolean, authored: Vector3, driveYaw = 0): RVTransportSurface {
  const root = new Object3D();
  const driveNode = new Object3D();
  driveNode.rotation.y = driveYaw;
  root.add(driveNode);
  const surfNode = new Object3D();
  surfNode.rotation.y = -Math.PI / 2; // surface frame differs from the drive frame
  driveNode.add(surfNode);
  root.updateMatrixWorld(true);
  const surface = new RVTransportSurface(surfNode, new AABB());
  surface.TransportDirection.copy(authored);
  // Drive stand-in with the RVDrive contract the surface reads: `getAxis()` = the
  // drive's LOCAL glTF axis with ReverseDirection applied (RVDrive.initDrive).
  const axis = directionToGltfAxis(dir).clone();
  if (reverse) axis.negate();
  surface.DriveReference = {
    Direction: dir, ReverseDirection: reverse, node: driveNode,
    getAxis: (out = new Vector3()) => out.copy(axis),
  } as unknown as RVTransportSurface['drive'];
  const ctx = {
    registry: { findInParent: () => null },
    transportManager: { surfaces: [] as RVTransportSurface[] },
  } as unknown as ComponentContext;
  surface.init(ctx);
  return surface;
}

const close = (a: Vector3, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 6); expect(a.y).toBeCloseTo(b[1], 6); expect(a.z).toBeCloseTo(b[2], 6);
};

describe('plan-2016 S6 — TransportSurface direction from the drive when unauthored', () => {
  it('a zero TransportDirection follows a LinearZ drive (world +Z)', () => {
    close(setup(DriveDirection.LinearZ, false, new Vector3()).getWorldDirection(), [0, 0, 1]);
  });

  it('ReverseDirection and the drive node rotation are applied', () => {
    close(setup(DriveDirection.LinearZ, true, new Vector3()).getWorldDirection(), [0, 0, -1]);
    // Drive turned 90 deg about Y: its local +Z points to world +X.
    close(setup(DriveDirection.LinearZ, false, new Vector3(), Math.PI / 2).getWorldDirection(), [1, 0, 0]);
    // Unity LinearX is glTF -X.
    close(setup(DriveDirection.LinearX, false, new Vector3()).getWorldDirection(), [-1, 0, 0]);
  });

  it('an authored TransportDirection still wins', () => {
    // Authored local +X of the surface node (rotated -90 deg about Y) = world +Z.
    close(setup(DriveDirection.LinearX, false, new Vector3(1, 0, 0)).getWorldDirection(), [0, 0, 1]);
  });
});
