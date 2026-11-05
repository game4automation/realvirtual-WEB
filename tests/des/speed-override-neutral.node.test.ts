// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVDrive } from '../../src/core/engine/rv-drive';
import { ContinuousRunner } from '../../src/core/material-flow/continuous-runner';
import { getDriveSpeedOverride, isSpeedOverrideNeutral, scaleSimDt, setDriveSpeedOverride,
  withSpeedOverrideNeutral } from '../../src/core/engine/rv-speed-override';
import { cycleRunnerFixture } from './cycle-runner-fixture';

afterEach(() => setDriveSpeedOverride(1));
it('scales Continuous/Live normally and preserves nested synchronous neutral scopes across throws', () => {
  setDriveSpeedOverride(2);
  const normal = () => {
    expect(isSpeedOverrideNeutral()).toBe(false); expect(scaleSimDt(0.01)).toBe(0.02);
    expect(getDriveSpeedOverride()).toBe(2);
  };
  const neutral = () => {
    expect(isSpeedOverrideNeutral()).toBe(true); expect(scaleSimDt(0.01)).toBe(0.01);
    expect(getDriveSpeedOverride()).toBe(1);
  };
  normal();
  withSpeedOverrideNeutral(() => {
    neutral(); withSpeedOverrideNeutral(neutral); neutral();
    expect(() => withSpeedOverrideNeutral(() => { throw new Error('test'); })).toThrow('test');
    neutral();
  }); normal();
  expect(() => withSpeedOverrideNeutral(() => { throw new Error('outer'); })).toThrow('outer'); normal();
});

it('rejects async callbacks and arbitrary thenables and immediately restores the factor', () => {
  setDriveSpeedOverride(2);
  expect(() => withSpeedOverrideNeutral(async () => 1)).toThrow(/synchronous/);
  expect(() => withSpeedOverrideNeutral(() => ({ then() {} }))).toThrow(/synchronous/);
  expect(getDriveSpeedOverride()).toBe(2); expect(isSpeedOverrideNeutral()).toBe(false);
});

it('preserves the Continuous CoreSubsystems drive tick at twice normal speed', () => {
  const drive = new RVDrive(new Object3D()); drive.initDrive(); drive.TargetSpeed = 100; drive.startMove(1000);
  const w = cycleRunnerFixture({ host: { drives: [drive] } });
  const continuous = new ContinuousRunner({ update() {}, reset() {} }, { tick() {} }, w.core!);
  setDriveSpeedOverride(2); continuous.earlyTick(0.01); continuous.tick(0.01);
  expect(drive.currentPosition).toBeCloseTo(2, 12);
});
