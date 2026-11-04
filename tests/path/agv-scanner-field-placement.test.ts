// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-558 — scanner field PLACEMENT regression.
 *
 * In the AGVFactory scene the fields were drawn beside / far ahead of the
 * vehicles: the Agv measures its footprint from the mesh bounds under its root,
 * and on a re-configure (mode switch → DES re-bind) that measurement included
 * the plugin's own field quad parented to the same root (front 0.48 m + 1.2 m
 * warning field = 1.68 m). The field then started 1.2 m in front of the body,
 * which on curves reads as "beside the vehicle".
 *
 * Each case poses a vehicle through the real runtime (`lookRotation(tangent,
 * align)` via the path traveler / DES tween) on a straight heading +X and +Z,
 * with an identity root and with the Unity export's mirrored root S[-1,1,1],
 * re-binds the SAME root once while the field group is attached (the mode
 * switch), and asserts in WORLD space: the field quad starts at the body front,
 * its centre lies ahead of the front along the travel direction, and it is
 * laterally centred on the body.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Box3, Mesh, Object3D, Quaternion, Vector3 } from 'three';
import { parsePathExtras } from '../../src/core/engine/rv-path';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultAgvFleet, type AgvMotionInfo } from '../../src/core/engine/rv-agv-fleet';
import { setOverlayVisible } from '../../src/core/overlay-visibility-store';
import { AgvScannerFieldPlugin } from '../../src/plugins/agv-scanner-field-plugin';
import type { RVViewer } from '../../src/core/rv-viewer';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { TICK, makeHost, makeAgvRoot, bindDes, clearShared } from '../helpers/agv-harness';

beforeEach(() => clearShared());

/** Body: 1.0 m long, 0.6 m wide, its centre 0.2 m AHEAD of the root → front 0.7 m, rear 0.3 m. */
const BODY = { length: 1.0, width: 0.6, rootOffset: 0.2 };
const BODY_FRONT_FROM_CENTRE = BODY.length / 2;

function course(): void {
  const net = getDefaultPathNetwork();
  const add = (raw: Record<string, unknown>): void => {
    net.register(parsePathExtras({ type: 'Path', version: 1, ...raw }, raw.id as string)!);
  };
  add({ id: 'AlongX', segments: [{ kind: 'line', from: [0, 0, 0], to: [60, 0, 0] }] });
  add({ id: 'AlongZ', segments: [{ kind: 'line', from: [0, 0, 10], to: [0, 0, 70] }] });
  net.resolveGraph();
}

const fakeViewer = { markRenderDirty: () => {} } as unknown as RVViewer;

interface Placement { along: number; lateral: number; nearEdge: number; width: number; front: number; travel: Vector3 }

function runCase(pathId: string, mirrorX: boolean): Placement {
  course();
  const host = makeHost();
  const root = makeAgvRoot('Veh', {
    PathId: pathId, StartPosition: 5000, TargetSpeed: 1000, VehicleLength: 0, VehicleWidth: 0,
  }, BODY);
  if (mirrorX) root.scale.set(-1, 1, 1);
  const body = root.children[0] as Mesh;
  const scene = new Object3D();
  scene.add(root);
  setOverlayVisible('safety-fields', true);
  const plugin = new AgvScannerFieldPlugin();
  plugin.init(fakeViewer);

  // First binding → the plugin parents its field group to the root.
  let runner = new DESRunner({ subMode: 'animated' });
  bindDes(runner, root, host);
  runner.start([], { root: new Object3D() });
  for (let i = 0; i < 30; i++) { runner.tick(TICK); runner.lateTick(TICK); plugin.onRender(); }
  expect(root.children.some((c) => c.name === '__agvScannerFields')).toBe(true);

  // Mode switch: the SAME root is configured again while the field is attached.
  runner.dispose();
  runner = new DESRunner({ subMode: 'animated' });
  bindDes(runner, root, host);
  runner.start([], { root: new Object3D() });
  for (let i = 0; i < 60; i++) { runner.tick(TICK); runner.lateTick(TICK); plugin.onRender(); }

  const info: AgvMotionInfo = {
    speed: 0, field: 'clear', protectiveLength: 0, warningLength: 0, front: 0, rear: 0, width: 0, dir: 1, scanner: false,
  };
  expect(getDefaultAgvFleet().get('Veh')!.motion!(info)).toBe(true);

  scene.updateMatrixWorld(true);
  const group = root.children.find((c) => c.name === '__agvScannerFields')!;
  const warn = group.children[0] as Mesh; // warning fill quad
  const fieldBox = new Box3().setFromObject(warn);
  const fieldCentre = fieldBox.getCenter(new Vector3());
  const vehCentre = body.getWorldPosition(new Vector3());
  // Travel direction = the posed root's +Z in world (the lookRotation tangent).
  const travel = new Vector3(0, 0, 1).applyQuaternion(root.getWorldQuaternion(new Quaternion())).normalize();
  const lateralAxis = new Vector3(0, 1, 0).cross(travel).normalize();
  const d = fieldCentre.clone().sub(vehCentre);
  // Near edge of the field along travel, relative to the body centre.
  const corners = [fieldBox.min, fieldBox.max].map((c) => c.clone().sub(vehCentre).dot(travel));
  const extentAcross = Math.abs(new Vector3().subVectors(fieldBox.max, fieldBox.min).dot(lateralAxis));

  plugin.dispose();
  runner.dispose();
  setOverlayVisible('safety-fields', false);
  return {
    along: d.dot(travel),
    lateral: d.dot(lateralAxis),
    nearEdge: Math.min(...corners),
    width: extentAcross,
    front: info.front,
    travel,
  };
}

describe('scanner field placement (plan-558)', () => {
  const cases: Array<[string, string, boolean, [number, number, number]]> = [
    ['heading +X, identity root', 'AlongX', false, [1, 0, 0]],
    ['heading +X, mirrored root S[-1,1,1]', 'AlongX', true, [1, 0, 0]],
    ['heading +Z, identity root', 'AlongZ', false, [0, 0, 1]],
    ['heading +Z, mirrored root S[-1,1,1]', 'AlongZ', true, [0, 0, 1]],
  ];
  for (const [label, pathId, mirror, dir] of cases) {
    it(`${label}: the field lies ahead of the body front, laterally centred`, () => {
      const p = runCase(pathId, mirror);
      // The runtime pose really points along the path.
      expect(p.travel.x).toBeCloseTo(dir[0], 3);
      expect(p.travel.z).toBeCloseTo(dir[2], 3);
      // Footprint measured from the body only — not from the field quad (re-configure).
      expect(p.front).toBeCloseTo(BODY.rootOffset + BODY.length / 2, 3);
      // Field centre ahead of the front along travel; near edge AT the body front.
      expect(p.along).toBeGreaterThan(BODY_FRONT_FROM_CENTRE);
      expect(Math.abs(p.nearEdge - BODY_FRONT_FROM_CENTRE)).toBeLessThan(0.01);
      expect(Math.abs(p.lateral)).toBeLessThan(0.05);
      // Width = body width + the plan's margin (0.1 m).
      expect(p.width).toBeCloseTo(BODY.width + 0.1, 3);
    });
  }
});
