// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { Object3D, Vector3, Quaternion } from 'three';
import { RVIKPath } from '../src/core/engine/rv-ik-path';

// Pin the original private stepper before extraction: the deceleration latch
// snaps the final pose when discrete integration runs out of speed.
it('preserves the original fixed-step LIN profile', () => {
  const path = new RVIKPath(new Object3D()) as any;
  Object.assign(path, { _linTarget: { LinearSpeedToTarget: 200, LinearAcceleration: 1000 },
    _linDist: 0.02, _linStartPos: new Vector3(), _linEndPos: new Vector3(0.02, 0, 0),
    _linStartQuat: new Quaternion(), _linEndQuat: new Quaternion(),
    _axisDrives: Array.from({ length: 6 }, () => ({ currentPosition: 0, Direction: 'Rotation', UseLimits: false,
      commandPosition() {}, applyToNode() {} })) });
  const fractions: number[] = [];
  path.solveStep = (p: Vector3) => { fractions.push(+ (p.x / 0.02).toFixed(8)); return [0, 0, 0, 0, 0, 0]; };
  for (let i = 0; i < 20 && path._linTarget; i++) path.stepLinear(0.02);
  expect(fractions).toEqual([0.02, 0.06, 0.12, 0.2, 0.3, 0.42, 0.56, 0.68, 0.78, 0.86, 0.92, 0.96, 0.98, 1]);
});
