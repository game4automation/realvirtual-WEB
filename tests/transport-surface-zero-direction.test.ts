// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 Phase 3 — a TransportSurface exported with TransportDirection (0,0,0)
 * (Unity computes it only at runtime: `InverseTransformDirection(drive.GetGlobalDirection())`,
 * the blow-moulding line's inlet Part1/Part3) takes the Drive axis — ReverseDirection included, a
 * rotated DriveReference on another node included, and again after reapplyConfig().
 */

import { describe, it, expect, afterEach } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, Scene, Vector3 } from 'three';
import { loadBakedGLB } from './helpers/load-baked-glb';
import { clearAllProblems } from '../src/core/hmi/problems-store';
import { CR, node, sceneToGlb } from './helpers/migrate-769-fixtures';
import type { RVTransportSurface } from '../src/core/engine/rv-transport-surface';

interface Opts { reverse?: boolean; driveRef?: boolean; authored?: { x: number; y: number; z: number } }

const BELT_ROT_Y = 0.3;

async function load(o: Opts): Promise<RVTransportSurface> {
  const scene = new Scene();
  scene.name = 'Cell';
  const belt = new Mesh(new BoxGeometry(0.5, 0.05, 1), new MeshBasicMaterial());
  belt.name = 'Belt';
  belt.rotation.y = BELT_ROT_Y; // the axis must be expressed in the SURFACE frame
  const ts: Record<string, unknown> = { TransportDirection: o.authored ?? { x: 0, y: 0, z: 0 }, AnimateSurface: false };
  const rv: Record<string, unknown> = { TransportSurface: ts };
  if (o.driveRef) {
    const motor = node('Motor', { Drive: { Direction: 'LinearX', TargetSpeed: 100, JogForward: true, ReverseDirection: !!o.reverse } });
    motor.rotation.y = Math.PI / 2;
    motor.position.set(3, 0, 0);
    scene.add(motor);
    ts.DriveReference = CR('Motor', 'realvirtual.Drive');
  } else {
    rv.Drive = { Direction: 'LinearZ', TargetSpeed: 100, JogForward: true, ReverseDirection: !!o.reverse };
  }
  belt.userData.realvirtual = rv;
  scene.add(belt);
  const result = await loadBakedGLB('zero-dir.glb', new Scene(), { data: (await sceneToGlb(scene)).slice(0), loadKinematicsSidecar: false });
  return result.transportManager.surfaces.find((s) => s.node.name === 'Belt')!;
}

/** Expected world direction: a glTF-local axis through a Y rotation. */
function rotY(axisLocal: Vector3, angle: number): Vector3 {
  return axisLocal.clone().applyAxisAngle(new Vector3(0, 1, 0), angle).normalize();
}

afterEach(() => clearAllProblems());

describe('plan-2016 — TransportSurface direction from the Drive when TransportDirection is (0,0,0)', () => {
  it('Drive on the same node: LinearZ → local +Z, rotated with the surface', async () => {
    const s = await load({});
    expect(s.getWorldDirection().distanceTo(rotY(new Vector3(0, 0, 1), BELT_ROT_Y))).toBeLessThan(1e-5);
  });

  it('ReverseDirection flips it, and reapplyConfig() keeps the derived axis (no +X fallback)', async () => {
    const s = await load({ reverse: true });
    const e = rotY(new Vector3(0, 0, -1), BELT_ROT_Y);
    expect(s.getWorldDirection().distanceTo(e)).toBeLessThan(1e-5);
    s.reapplyConfig();
    expect(s.getWorldDirection().distanceTo(e)).toBeLessThan(1e-5);
    expect(s.TransportDirection.lengthSq(), 'the authored zero stays untouched').toBe(0);
  });

  it('rotated DriveReference on another node: its WORLD axis, expressed in the surface frame', async () => {
    const s = await load({ driveRef: true });
    // LinearX in glTF is -X (Unity +X); the motor is rotated +90° about Y.
    const e = rotY(new Vector3(-1, 0, 0), Math.PI / 2);
    expect(s.drive?.node.name).toBe('Motor');
    expect(s.getWorldDirection().distanceTo(e)).toBeLessThan(1e-5);
    s.reapplyConfig();
    expect(s.getWorldDirection().distanceTo(e)).toBeLessThan(1e-5);
  });

  it('rotated DriveReference with ReverseDirection points the other way', async () => {
    const s = await load({ driveRef: true, reverse: true });
    expect(s.getWorldDirection().distanceTo(rotY(new Vector3(1, 0, 0), Math.PI / 2))).toBeLessThan(1e-5);
  });

  it('an authored non-zero TransportDirection is not overridden by the Drive', async () => {
    const s = await load({ authored: { x: 1, y: 0, z: 0 } }); // Unity +X → glTF local -X
    expect(s.getWorldDirection().distanceTo(rotY(new Vector3(-1, 0, 0), BELT_ROT_Y))).toBeLessThan(1e-5);
  });
});
