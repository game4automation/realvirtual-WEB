// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import {
  parseCameraPos,
  parseMaintenanceProcedure,
  parseMaintenanceProcedures,
  type CameraBookmark,
  type MaintenanceProcedure,
  type MaintenanceStep,
} from '../src/core/maintenance-parser';
import { Object3D } from 'three';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Create a mock Object3D with realvirtual userData. */
function mockNode(name: string, rv?: Record<string, unknown>): Object3D {
  const obj = new Object3D();
  obj.name = name;
  if (rv) {
    obj.userData = { realvirtual: rv };
  }
  return obj;
}

/** Create a mock GLB scene tree with a SerialContainer of MaintenanceSteps. */
function createMockSceneWithMaintenanceSteps(): Object3D {
  const root = new Object3D();
  root.name = 'Scene';

  const container = mockNode('Coolant Nozzle Cleaning', {
    'LogicStep_SerialContainer': {},
  });
  root.add(container);

  const step1 = mockNode('01 Power Off', {
    'LogicStep_MaintenanceStep': {
      Title: 'Power Off Machine',
      Instruction: 'Press the E-Stop button and turn power OFF',
      WarningNote: 'Do NOT proceed until all motion has stopped',
      Icon: 'warning',
      CameraPosition: {
        type: 'ScriptableObject',
        data: {
          CameraTransformPos: { x: -1, y: 2, z: 3 },
          TargetPos: { x: 0, y: 1, z: 0 },
        },
      },
      CameraDuration: 1.0,
      HighlightTargets: ['EStop', 'PowerSwitch'],
      CheckboxLabel: 'Machine is powered off',
      CompletionType: 'ConfirmWarning',
      EstimatedMinutes: 2,
    },
  });
  container.add(step1);

  const step2 = mockNode('02 Open Safety Gate', {
    'LogicStep_MaintenanceStep': {
      Title: 'Open Safety Gate',
      Instruction: 'Release the yellow safety latch',
      CameraPosition: {
        CameraTransformPos: { x: -2, y: 1.5, z: 2 },
        TargetPos: { x: -1, y: 0.5, z: 1 },
      },
      HighlightTargets: ['Gate/Handle'],
      CheckboxLabel: 'Gate is open',
      CompletionType: 'Checkbox',
      EstimatedMinutes: 1,
    },
  });
  container.add(step2);

  const step3 = mockNode('03 Locate Nozzles', {
    'LogicStep_MaintenanceStep': {
      Title: 'Locate Coolant Nozzles',
      Instruction: 'Identify all four coolant fittings on the spindle',
      HighlightTargets: ['Fitting1', 'Fitting2', 'Fitting3', 'Fitting4'],
      CheckboxLabel: 'Got it',
      CompletionType: 'Observation',
    },
  });
  container.add(step3);

  return root;
}

/** Create a mock scene with nested composable steps (SerialContainer in SerialContainer). */
function createMockSceneWithComposableSteps(): Object3D {
  const root = new Object3D();
  root.name = 'Scene';

  const container = mockNode('Advanced Cleaning', {
    'LogicStep_SerialContainer': {},
  });
  root.add(container);

  // Nested SerialContainer with composable sub-steps
  const subContainer = mockNode('Step 1: Power Off', {
    'LogicStep_SerialContainer': {},
  });
  container.add(subContainer);

  const setCam = mockNode('SetCamera1', {
    'LogicStep_SetCameraPosition': {
      CameraPosition: {
        CameraTransformPos: { x: -3, y: 4, z: 5 },
        TargetPos: { x: 0, y: 2, z: 0 },
      },
      Duration: 1.2,
    },
  });
  subContainer.add(setCam);

  const highlight = mockNode('Highlight1', {
    'LogicStep_Highlight': {
      Targets: ['EStop', 'PowerSwitch'],
      ClearPrevious: true,
    },
  });
  subContainer.add(highlight);

  const annotation = mockNode('Annotation1', {
    'LogicStep_ShowAnnotation': {
      Title: 'Power Off',
      Instruction: 'Press E-Stop and turn power OFF',
      WarningNote: 'Danger: moving parts',
      Icon: 'warning',
      Severity: 'Warning',
    },
  });
  subContainer.add(annotation);

  const confirm = mockNode('Confirm1', {
    'LogicStep_WaitForUserConfirm': {
      ButtonLabel: 'Machine is powered off',
      ConfirmationType: 'WarningAcknowledge',
    },
  });
  subContainer.add(confirm);

  // Second confirm in same sub-container (after some delay/signal steps)
  const confirm2 = mockNode('Confirm2', {
    'LogicStep_WaitForUserConfirm': {
      ButtonLabel: 'Verified safe',
      ConfirmationType: 'Checkbox',
    },
  });
  subContainer.add(confirm2);

  return root;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('parseCameraPos', () => {
  test('parses direct CameraTransformPos and TargetPos fields', () => {
    const raw = {
      CameraTransformPos: { x: 1, y: 2, z: 3 },
      TargetPos: { x: 0, y: 1, z: 0 },
    };
    const bookmark = parseCameraPos(raw);
    expect(bookmark).not.toBeNull();
    // Unity LHS → glTF RHS: X is negated
    expect(bookmark!.px).toBe(-1);
    expect(bookmark!.py).toBe(2);
    expect(bookmark!.pz).toBe(3);
    expect(bookmark!.tx).toBe(-0); // -0 from negating 0
    expect(bookmark!.ty).toBe(1);
    expect(bookmark!.tz).toBe(0);
  });

  test('parses ScriptableObject inline format with nested data', () => {
    const raw = {
      type: 'ScriptableObject',
      data: {
        CameraTransformPos: { x: -2, y: 5, z: 4 },
        TargetPos: { x: 1, y: 0, z: 0 },
      },
    };
    const bookmark = parseCameraPos(raw);
    expect(bookmark).not.toBeNull();
    expect(bookmark!.px).toBe(2); // negated -(-2) = 2
    expect(bookmark!.py).toBe(5);
    expect(bookmark!.pz).toBe(4);
    expect(bookmark!.tx).toBe(-1); // negated -(1) = -1
    expect(bookmark!.ty).toBe(0);
    expect(bookmark!.tz).toBe(0);
  });

  test('returns null when no camera position fields', () => {
    const result = parseCameraPos({ SomeOtherField: 42 });
    expect(result).toBeNull();
  });

  test('handles missing TargetPos gracefully', () => {
    const raw = { CameraTransformPos: { x: 1, y: 2, z: 3 } };
    const bookmark = parseCameraPos(raw);
    expect(bookmark).not.toBeNull();
    expect(bookmark!.tx).toBe(0);
    expect(bookmark!.ty).toBe(0);
    expect(bookmark!.tz).toBe(0);
  });
});

describe('parseMaintenanceProcedure (convenience function)', () => {
  test('parses MaintenanceStep GLB extras into procedure', () => {
    const stepExtras = [
      {
        name: 'Step1',
        rv: {
          'LogicStep_MaintenanceStep': {
            Title: 'First Step',
            Instruction: 'Do something',
            CheckboxLabel: 'Done',
            CompletionType: 'Checkbox',
            CameraPosition: {
              CameraTransformPos: { x: -1, y: 2, z: 3 },
              TargetPos: { x: 0, y: 1, z: 0 },
            },
            HighlightTargets: ['Target1'],
            EstimatedMinutes: 5,
          },
        },
      },
      {
        name: 'Step2',
        rv: {
          'LogicStep_MaintenanceStep': {
            Title: 'Second Step',
            Instruction: 'Do something else',
            CheckboxLabel: 'Completed',
            CompletionType: 'Observation',
            EstimatedMinutes: 3,
          },
        },
      },
    ];

    const procedure = parseMaintenanceProcedure('Test Procedure', stepExtras);
    expect(procedure.name).toBe('Test Procedure');
    expect(procedure.steps.length).toBe(2);
    expect(procedure.steps[0].title).toBe('First Step');
    expect(procedure.steps[0].camera).toBeDefined();
    expect(procedure.steps[0].camera).not.toBeNull();
    expect(procedure.steps[0].highlightPaths).toEqual(['Target1']);
    expect(procedure.steps[0].completionType).toBe('Checkbox');
    expect(procedure.steps[0].estimatedMinutes).toBe(5);
    expect(procedure.steps[1].title).toBe('Second Step');
    expect(procedure.steps[1].completionType).toBe('Observation');
    expect(procedure.estimatedMinutes).toBe(8);
  });

  test('handles empty step list', () => {
    const procedure = parseMaintenanceProcedure('Empty', []);
    expect(procedure.steps.length).toBe(0);
    expect(procedure.estimatedMinutes).toBe(0);
  });

  test('uses node name as title fallback', () => {
    const stepExtras = [
      {
        name: 'MyStepNode',
        rv: {
          'LogicStep_MaintenanceStep': {
            Instruction: 'Instructions here',
          },
        },
      },
    ];
    const procedure = parseMaintenanceProcedure('Test', stepExtras);
    expect(procedure.steps[0].title).toBe('MyStepNode');
  });
});

describe('parseMaintenanceProcedures (scene tree)', () => {
  test('parses combined MaintenanceStep format from scene tree', () => {
    const root = createMockSceneWithMaintenanceSteps();
    const procedures = parseMaintenanceProcedures(root);

    expect(procedures.length).toBe(1);
    const proc = procedures[0];
    expect(proc.name).toBe('Coolant Nozzle Cleaning');
    expect(proc.steps.length).toBe(3);

    // Step 1: Power Off
    const step1 = proc.steps[0];
    expect(step1.title).toBe('Power Off Machine');
    expect(step1.instruction).toContain('E-Stop');
    expect(step1.warningNote).toContain('motion has stopped');
    expect(step1.completionType).toBe('ConfirmWarning');
    expect(step1.camera).not.toBeNull();
    expect(step1.highlightPaths).toEqual(['EStop', 'PowerSwitch']);
    expect(step1.estimatedMinutes).toBe(2);

    // Step 2: Safety Gate
    const step2 = proc.steps[1];
    expect(step2.title).toBe('Open Safety Gate');
    expect(step2.completionType).toBe('Checkbox');
    expect(step2.highlightPaths).toEqual(['Gate/Handle']);

    // Step 3: Locate Nozzles (Observation type)
    const step3 = proc.steps[2];
    expect(step3.title).toBe('Locate Coolant Nozzles');
    expect(step3.completionType).toBe('Observation');
    expect(step3.highlightPaths.length).toBe(4);
  });

  test('flattens nested SerialContainers into wizard steps', () => {
    const root = createMockSceneWithComposableSteps();
    const procedures = parseMaintenanceProcedures(root);

    expect(procedures.length).toBe(1);
    const proc = procedures[0];
    expect(proc.name).toBe('Advanced Cleaning');

    // Two WaitForUserConfirm in the nested container = 2 visible steps
    expect(proc.steps.length).toBe(2);

    // First step should have accumulated camera + highlight + annotation
    const step1 = proc.steps[0];
    expect(step1.title).toBe('Power Off');
    expect(step1.instruction).toContain('E-Stop');
    expect(step1.warningNote).toContain('Danger');
    expect(step1.camera).not.toBeNull();
    expect(step1.camera!.px).toBe(3); // negated -(-3) = 3
    expect(step1.highlightPaths).toEqual(['EStop', 'PowerSwitch']);
    expect(step1.checkboxLabel).toBe('Machine is powered off');
    expect(step1.completionType).toBe('ConfirmWarning');

    // Second step should have reset accumulator (no camera, no highlights)
    const step2 = proc.steps[1];
    expect(step2.checkboxLabel).toBe('Verified safe');
    expect(step2.completionType).toBe('Checkbox');
    expect(step2.camera).toBeNull();
    expect(step2.highlightPaths.length).toBe(0);
  });

  test('step indices are sequential starting from 0', () => {
    const root = createMockSceneWithMaintenanceSteps();
    const procedures = parseMaintenanceProcedures(root);
    const steps = procedures[0].steps;
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i].index).toBe(i);
    }
  });

  test('ignores SerialContainers without maintenance content', () => {
    const root = new Object3D();
    root.name = 'Scene';

    const container = mockNode('NormalLogic', {
      'LogicStep_SerialContainer': {},
    });
    root.add(container);

    // Add a non-maintenance child
    const child = mockNode('Delay', {
      'LogicStep_Delay': { Duration: 2.0 },
    });
    container.add(child);

    const procedures = parseMaintenanceProcedures(root);
    expect(procedures.length).toBe(0);
  });

  test('returns empty array for scene with no maintenance steps', () => {
    const root = new Object3D();
    root.name = 'EmptyScene';
    const procedures = parseMaintenanceProcedures(root);
    expect(procedures.length).toBe(0);
  });
});

describe('Edge cases', () => {
  test('highlight targets as component references', () => {
    const stepExtras = [{
      name: 'Step',
      rv: {
        'LogicStep_MaintenanceStep': {
          Title: 'Test',
          HighlightTargets: [
            { path: 'Robot/Arm1', component: 'MeshRenderer' },
            { path: 'Robot/Arm2', component: 'MeshRenderer' },
            'DirectPath/Target',
          ],
        },
      },
    }];
    const proc = parseMaintenanceProcedure('Test', stepExtras);
    expect(proc.steps[0].highlightPaths).toEqual([
      'Robot/Arm1',
      'Robot/Arm2',
      'DirectPath/Target',
    ]);
  });

  test('default values when fields are missing', () => {
    const stepExtras = [{
      name: 'Minimal',
      rv: { 'LogicStep_MaintenanceStep': {} },
    }];
    const proc = parseMaintenanceProcedure('Test', stepExtras);
    const step = proc.steps[0];
    expect(step.title).toBe('Minimal'); // fallback to node name
    expect(step.instruction).toBe('');
    expect(step.warningNote).toBe('');
    expect(step.icon).toBe('build');
    expect(step.severity).toBe('Info');
    expect(step.camera).toBeNull();
    expect(step.cameraDuration).toBe(0.8);
    expect(step.highlightPaths).toEqual([]);
    expect(step.checkboxLabel).toBe('Done');
    expect(step.completionType).toBe('Checkbox');
    expect(step.estimatedMinutes).toBe(0);
  });
});
