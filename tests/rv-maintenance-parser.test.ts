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

// ─── plan-522 §9.3: web-authored procedure (one node per step) ─────────

const nodeRef = (path: string) => ({ type: 'ComponentReference', path, componentType: '' });

/**
 * Scene
 *  └─ Machine
 *      ├─ Door, NozzleTip_1, NozzleTip_2, Housing, Signals/Lamp   (reference targets)
 *      └─ Maintenance  [LogicStep_MaintenanceProcedure]
 *          ├─ 01 Cell stopped     [MaintenanceStep]
 *          ├─ 02 Open doors       [MaintenanceStep][DriveTo][DriveTo_1][SetSignalBool]
 *          └─ 03 Look inside      [MaintenanceStep][SetTransparency][Effect][AnimateTransform_1]
 */
function createWebProcedure(): { root: Object3D; proc: Object3D; steps: Object3D[] } {
  const root = new Object3D();
  root.name = 'Scene';
  const machine = mockNode('Machine');
  root.add(machine);
  for (const n of ['Door', 'NozzleTip_1', 'NozzleTip_2', 'Housing', 'Signals']) machine.add(mockNode(n));
  machine.children.find((c) => c.name === 'Signals')!.add(mockNode('Lamp'));
  const proc = mockNode('Maintenance', {
    LogicStep_MaintenanceProcedure: { ProcedureName: 'Coolant Nozzle Cleaning', EstimatedMinutes: 0 },
  });
  machine.add(proc);
  const s1 = mockNode('01 Cell stopped', {
    LogicStep_MaintenanceStep: {
      Title: 'Cell stopped', CompletionType: 'Checkbox', EstimatedMinutes: 2,
      CameraPosition: { x: 1.2, y: 1.45, z: 0.8 }, CameraTarget: { x: 0.3, y: 1.1, z: 0 },
      HighlightTargets: [nodeRef('Door')],
    },
  });
  const s2 = mockNode('02 Open doors', {
    LogicStep_MaintenanceStep: { Title: '', CompletionType: 'ConfirmWarning', EstimatedMinutes: 3 },
    LogicStep_DriveTo: { drive: { type: 'ComponentReference', path: 'Door', componentType: 'realvirtual.Drive' }, Destination: 500 },
    LogicStep_DriveTo_1: { drive: { type: 'ComponentReference', path: 'Machine/Door', componentType: 'realvirtual.Drive' }, Destination: 0 },
    LogicStep_SetSignalBool: { Signal: { type: 'ComponentReference', path: 'Signals/Lamp', componentType: 'realvirtual.PLCOutputBool' }, SetToTrue: true },
  });
  const s3 = mockNode('03 Look inside', {
    LogicStep_MaintenanceStep: { Title: 'Look inside', CompletionType: 'Observation' },
    LogicStep_SetTransparency: { Targets: [nodeRef('Housing')], Opacity: 0.25, StartDelay: 0.5 },
    LogicStep_Effect: { Type: 'CoolantSpray', Anchors: [nodeRef('NozzleTip_1'), nodeRef('NozzleTip_2')], Intensity: 1, StartDelay: 1.5 },
    LogicStep_AnimateTransform_1: { Targets: [nodeRef('NozzleTip_1')], RotationAngle: 720 },
  });
  proc.add(s1, s2, s3);
  return { root, proc, steps: [s1, s2, s3] };
}

type Rv = Record<string, Record<string, unknown>>;
const rvOf = (n: Object3D): Rv => n.userData.realvirtual as Rv;

describe('plan-522 §9.3 — web-authored procedure', () => {
  test('steps = direct children with MaintenanceStep, in hierarchy order; reordering changes the order', () => {
    const { root, proc, steps } = createWebProcedure();
    let [p] = parseMaintenanceProcedures(root);
    expect(p.name).toBe('Coolant Nozzle Cleaning');
    expect(p.steps.map((s) => s.title)).toEqual(['Cell stopped', '02 Open doors', 'Look inside']);
    expect(p.steps.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(p.estimatedMinutes).toBe(5); // 0 = sum of the steps
    expect(p.warnings).toEqual([]);

    // Hierarchy drag & drop: step 3 moves to the front.
    proc.remove(steps[2]);
    proc.add(steps[2]);
    proc.children.unshift(proc.children.pop()!);
    [p] = parseMaintenanceProcedures(root);
    expect(p.steps.map((s) => s.title)).toEqual(['Look inside', 'Cell stopped', '02 Open doors']);
    expect(p.steps.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  test('empty Title / ProcedureName fall back to the AUTHORED name a loader dedup kept in _rvOrigName (Phase 5)', () => {
    const { root, proc, steps } = createWebProcedure();
    proc.userData.realvirtual = { LogicStep_MaintenanceProcedure: { ProcedureName: '' } };
    proc.name = 'Maintenance_1';
    proc.userData._rvOrigName = 'Maintenance';
    steps[1].name = '02_Open_doors_1';
    steps[1].userData._rvOrigName = '02 Open doors';
    const [p] = parseMaintenanceProcedures(root);
    expect(p.name).toBe('Maintenance');
    expect(p.steps[1].title).toBe('02 Open doors');
  });

  test('a declared EstimatedMinutes > 0 wins over the sum; empty ProcedureName = node name', () => {
    const { root, proc } = createWebProcedure();
    proc.userData.realvirtual = { LogicStep_MaintenanceProcedure: { ProcedureName: '', EstimatedMinutes: 25 } };
    const [p] = parseMaintenanceProcedures(root);
    expect(p.name).toBe('Maintenance');
    expect(p.estimatedMinutes).toBe(25);
  });

  test('actions per step from the components of the node, incl. `_N` keys, with startDelay', () => {
    const { root, steps } = createWebProcedure();
    const [p] = parseMaintenanceProcedures(root);
    expect(p.steps[0].actions).toEqual([]);

    const a2 = p.steps[1].actions;
    expect(a2.map((a) => a.type)).toEqual(['DriveTo', 'DriveTo', 'SetSignalBool']);
    expect(a2.map((a) => a.data['Destination'])).toEqual([500, 0, undefined]);
    expect(a2.every((a) => a.node === steps[1])).toBe(true);
    expect(a2.every((a) => a.startDelay === 0)).toBe(true);

    const a3 = p.steps[2].actions;
    expect(a3.map((a) => [a.type, a.startDelay])).toEqual([
      ['SetTransparency', 0.5],
      ['Effect', 1.5],
      ['AnimateTransform', 0],
    ]);
    // data is the component's rv_extras block (the runtime interprets it).
    expect(a3[0].data).toBe(rvOf(steps[2])['LogicStep_SetTransparency']);
  });

  test('unsupported steps on a step node and children without MaintenanceStep → warnings', () => {
    const { root, proc, steps } = createWebProcedure();
    Object.assign(rvOf(steps[0]), {
      LogicStep_Delay: { Duration: 2 },
      LogicStep_WaitForSignalBool: { WaitForTrue: true },
      LogicStep_Enable_1: {},
    });
    proc.add(mockNode('Notes'));
    // Deeper nodes do not belong to the procedure (no warning, no step).
    steps[0].add(mockNode('Deep', { LogicStep_MaintenanceStep: { Title: 'Deep' } }));
    const [p] = parseMaintenanceProcedures(root);
    expect(p.steps).toHaveLength(3);
    expect(p.steps[0].actions).toEqual([]);
    const w = p.warnings.join('\n');
    expect(p.warnings).toHaveLength(4);
    expect(w).toContain('LogicStep_Delay');
    expect(w).toContain('LogicStep_WaitForSignalBool');
    expect(w).toContain('LogicStep_Enable_1');
    expect(w).toContain('"Notes"');
    expect(w).not.toContain('Deep');
  });

  test('unresolvable references → warning, the action stays in the list', () => {
    const { root, steps } = createWebProcedure();
    rvOf(steps[2])['LogicStep_SetTransparency'].Targets = [nodeRef('Housing'), nodeRef('Gone/Part')];
    const [p] = parseMaintenanceProcedures(root);
    expect(p.steps[2].actions.map((a) => a.type)).toContain('SetTransparency');
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toContain('Gone/Part');
    expect(p.warnings[0]).toContain('LogicStep_SetTransparency');
  });

  test('CameraPosition / CameraTarget are taken without conversion; (0,0,0)+(0,0,0) = no camera', () => {
    const { root, steps } = createWebProcedure();
    rvOf(steps[1])['LogicStep_MaintenanceStep'].CameraPosition = { x: 0, y: 0, z: 0 };
    rvOf(steps[1])['LogicStep_MaintenanceStep'].CameraTarget = { x: 0, y: 0, z: 0 };
    const [p] = parseMaintenanceProcedures(root);
    expect(p.steps[0].camera).toEqual({ px: 1.2, py: 1.45, pz: 0.8, tx: 0.3, ty: 1.1, tz: 0 });
    expect(p.steps[1].camera).toBeNull();
    expect(p.steps[2].camera).toBeNull();
    expect(p.steps[0].highlightPaths).toEqual(['Door']);
  });

  test('the old CameraPos format inside a MaintenanceStep keeps the Unity conversion', () => {
    const { root, steps } = createWebProcedure();
    rvOf(steps[0])['LogicStep_MaintenanceStep'].CameraPosition = {
      type: 'ScriptableObject', data: { CameraTransformPos: { x: -1, y: 2, z: 3 }, TargetPos: { x: 4, y: 0, z: 0 } },
    };
    const [p] = parseMaintenanceProcedures(root);
    expect(p.steps[0].camera).toEqual({ px: 1, py: 2, pz: 3, tx: -4, ty: 0, tz: 0 });
  });

  test('old SerialContainer formats parse as before, with empty actions / warnings', () => {
    const [combined] = parseMaintenanceProcedures(createMockSceneWithMaintenanceSteps());
    expect(combined.steps).toHaveLength(3);
    expect(combined.warnings).toEqual([]);
    expect(combined.steps.every((s) => Array.isArray(s.actions) && s.actions.length === 0)).toBe(true);
    // Unity CameraPos conversion unchanged (x negated).
    expect(combined.steps[1].camera).toEqual({ px: 2, py: 1.5, pz: 2, tx: 1, ty: 0.5, tz: 1 });

    const [composable] = parseMaintenanceProcedures(createMockSceneWithComposableSteps());
    expect(composable.steps).toHaveLength(2);
    expect(composable.warnings).toEqual([]);
    expect(composable.steps.every((s) => s.actions.length === 0)).toBe(true);
  });

  test('a procedure without any step node yields no procedure', () => {
    const root = mockNode('Scene');
    const proc = mockNode('Maintenance', { LogicStep_MaintenanceProcedure: {} });
    root.add(proc);
    proc.add(mockNode('Notes'));
    expect(parseMaintenanceProcedures(root)).toEqual([]);
  });
});
