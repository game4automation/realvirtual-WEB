// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Two Quick Edit authoring rules of the asset editor (private):
 *
 *  - a step clicked while a LogicStep CONTAINER is selected goes inside it —
 *    `isLogicStepContainer` is the test the placement uses;
 *  - a drive takes one behaviour that MOVES it; Position Switch only reads the
 *    position and combines with anything (`movingBehaviorConflict`).
 */
import { describe, it, expect } from 'vitest';
import { isLogicStepContainer } from '@rv-private/plugins/asset-editor/kinematics/create-actions';
import { movingBehaviorConflict } from '@rv-private/plugins/asset-editor/kinematics/KinematicsPanel';

describe('Quick Edit authoring rules', () => {
  it('recognises serial and parallel containers', () => {
    expect(isLogicStepContainer({ userData: { realvirtual: { LogicStep_SerialContainer: {} } } })).toBe(true);
    expect(isLogicStepContainer({ userData: { realvirtual: { LogicStep_ParallelContainer: {} } } })).toBe(true);
    expect(isLogicStepContainer({ userData: { realvirtual: { LogicStep_Delay: { Duration: 1 } } } })).toBe(false);
    expect(isLogicStepContainer({ userData: {} })).toBe(false);
  });

  it('refuses a second moving behaviour and names the first', () => {
    expect(movingBehaviorConflict('Drive_DestinationMotor', new Set(['Drive_Cylinder'])))
      .toBe('This drive is already moved by Cylinder — remove it first');
  });

  it('Position Switch combines with a moving behaviour, in both orders', () => {
    expect(movingBehaviorConflict('Drive_PositionSwitch', new Set(['Drive_Cylinder']))).toBeUndefined();
    expect(movingBehaviorConflict('Drive_Cylinder', new Set(['Drive_PositionSwitch']))).toBeUndefined();
  });

  it('a drive without behaviours takes any', () => {
    expect(movingBehaviorConflict('Drive_Simple', new Set())).toBeUndefined();
  });
});
