// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-maintenance-components.test.ts — plan-522 §9.0: the web-only maintenance
 * schemas are registered, authorable, categorised as Logic ▸ Maintenance, carry
 * the planned reference bake targets and sane defaults; `LogicStep_DriveTo` /
 * `LogicStep_SetSignalBool` become authorable WITHOUT a schema, so the bake
 * role of a node carrying them is unchanged.
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  bakeTargetOf,
  getCapabilities,
  getFieldDescriptor,
  getRegisteredSchema,
  getSchemaDefaults,
  getTypesWithCapability,
} from '../src/core/engine/rv-component-registry';
import { categoryOf } from '../src/core/engine/rv-component-category';
import { makeOwnRoleResolver } from '../src/core/engine/rv-bake-pipeline';
import {
  MAINTENANCE_COMPONENT_TYPES,
  MAINTENANCE_REUSED_STEP_TYPES,
} from '../src/core/engine/rv-maintenance-components';
// Registration is a side effect of the scene loader's import list (production path).
import '../src/core/engine/rv-scene-loader';

describe('plan-522 §9.0 — maintenance component schemas', () => {
  it('all seven types are registered, authorable and categorised Logic ▸ Maintenance', () => {
    expect(MAINTENANCE_COMPONENT_TYPES).toEqual([
      'LogicStep_MaintenanceProcedure',
      'LogicStep_MaintenanceStep',
      'LogicStep_AnimateTransform',
      'LogicStep_SetTransparency',
      'LogicStep_Effect',
      'LogicStep_Arrow',
      'LogicStep_MaintenanceTrigger',
    ]);
    const authorable = getTypesWithCapability('authorable');
    for (const type of MAINTENANCE_COMPONENT_TYPES) {
      expect(getRegisteredSchema(type), type).toBeDefined();
      expect(authorable, type).toContain(type);
      expect(getCapabilities(type).ui.category, type).toBe('logic');
      expect(getCapabilities(type).ui.filter, type).toBe('Maintenance');
      expect(categoryOf(type), type).toEqual({ category: 'logic', label: 'Maintenance' });
      // `_N` dedup keys land in the same chip.
      expect(categoryOf(`${type}_1`).label, type).toBe('Maintenance');
    }
  });

  it('LogicStep_DriveTo / LogicStep_SetSignalBool are authorable without a schema; their chip is unchanged', () => {
    const authorable = getTypesWithCapability('authorable');
    expect(MAINTENANCE_REUSED_STEP_TYPES).toEqual(['LogicStep_DriveTo', 'LogicStep_SetSignalBool']);
    for (const type of MAINTENANCE_REUSED_STEP_TYPES) {
      expect(authorable, type).toContain(type);
      expect(getRegisteredSchema(type), type).toBeUndefined();
      expect(getCapabilities(type).bake, type).toBe('merge');
      expect(getCapabilities(type).pick, type).toBe('none');
    }
    expect(categoryOf('LogicStep_DriveTo')).toEqual({ category: 'logic', label: 'DriveTo' });
    expect(categoryOf('LogicStep_SetSignalBool')).toEqual({ category: 'logic', label: 'SetSignalBool' });
  });

  it('defaults of the reused steps come from the authoring table (fresh copies)', () => {
    expect(getSchemaDefaults('LogicStep_DriveTo')).toEqual({ Destination: 0, Relative: false });
    expect(getSchemaDefaults('LogicStep_SetSignalBool')).toEqual({ SetToTrue: true });
    const a = getSchemaDefaults('LogicStep_DriveTo');
    a.Destination = 99;
    expect(getSchemaDefaults('LogicStep_DriveTo').Destination).toBe(0);
    // Other schema-less LogicSteps stay without defaults.
    expect(getSchemaDefaults('LogicStep_Delay')).toEqual({});
  });

  it('a node carrying LogicStep_DriveTo keeps its bake role (no behavioural role of its own)', () => {
    const own = makeOwnRoleResolver();
    const drive = new Object3D();
    drive.userData.realvirtual = { LogicStep_DriveTo: { Destination: 10 } };
    const signal = new Object3D();
    signal.userData.realvirtual = { LogicStep_SetSignalBool: { SetToTrue: true } };
    const plain = new Object3D();
    plain.userData.realvirtual = { LogicStep_Delay: { Duration: 1 } };
    // Same answer as any schema-less LogicStep before plan-522: no own role.
    expect(own(plain)).toBeUndefined();
    expect(own(drive)).toBeUndefined();
    expect(own(signal)).toBeUndefined();
  });

  it('reference fields carry the planned bakeTarget and refTarget node', () => {
    const expected: Array<[string, string, 'merge' | 'chunk']> = [
      ['LogicStep_MaintenanceStep', 'HighlightTargets', 'merge'],
      ['LogicStep_AnimateTransform', 'Targets', 'chunk'],
      ['LogicStep_SetTransparency', 'Targets', 'chunk'],
      ['LogicStep_Effect', 'Anchors', 'chunk'],
      ['LogicStep_Effect', 'ReducedAnchors', 'chunk'],
    ];
    for (const [type, field, target] of expected) {
      const desc = getFieldDescriptor(type, field);
      expect(desc?.type, `${type}.${field}`).toBe('componentRefArray');
      expect(bakeTargetOf(desc), `${type}.${field}`).toBe(target);
      expect(desc?.refTarget, `${type}.${field}`).toBe('node');
    }
    // plan-522 Phase 6: two single node references, both keep their target (merge, the default).
    const single: Array<[string, string]> = [
      ['LogicStep_MaintenanceProcedure', 'TriggerDrive'],
      ['LogicStep_MaintenanceStep', 'DocumentSource'],
    ];
    for (const [type, field] of single) {
      const desc = getFieldDescriptor(type, field);
      expect(desc?.type, `${type}.${field}`).toBe('componentRef');
      expect(bakeTargetOf(desc), `${type}.${field}`).toBe('merge');
      expect(desc?.refTarget, `${type}.${field}`).toBe('node');
    }
    // plan-522 Phase 7: the trigger's Drive (node) and Signal (any PLC type), the
    // procedure's output signal slots — all keep their target (merge).
    expect(getFieldDescriptor('LogicStep_MaintenanceTrigger', 'Drive')?.refTarget).toBe('node');
    expect(getFieldDescriptor('LogicStep_MaintenanceTrigger', 'Signal')?.refSignalTypes).toHaveLength(6);
    const signals: Array<[string, string, string]> = [
      ['LogicStep_MaintenanceProcedure', 'DueSignal', 'PLCInputBool'],
      ['LogicStep_MaintenanceProcedure', 'OverdueSignal', 'PLCInputBool'],
      ['LogicStep_MaintenanceProcedure', 'StateSignal', 'PLCInputInt'],
      ['LogicStep_MaintenanceProcedure', 'RemainingSignal', 'PLCInputFloat'],
    ];
    for (const [type, field, signal] of signals) {
      const desc = getFieldDescriptor(type, field);
      expect(desc?.signal, `${type}.${field}`).toBe(signal);
      expect(bakeTargetOf(desc), `${type}.${field}`).toBe('merge');
    }
    const phase7 = [['LogicStep_MaintenanceTrigger', 'Drive'], ['LogicStep_MaintenanceTrigger', 'Signal'], ...signals.map(([t, f]) => [t, f])];
    // No other reference field in the schemas.
    for (const type of MAINTENANCE_COMPONENT_TYPES) {
      for (const [field, desc] of Object.entries(getRegisteredSchema(type)!)) {
        if (desc.type !== 'componentRef' && desc.type !== 'componentRefArray') continue;
        const known = expected.some(([t, f]) => t === type && f === field) || single.some(([t, f]) => t === type && f === field)
          || phase7.some(([t, f]) => t === type && f === field);
        expect(known, `${type}.${field}`).toBe(true);
      }
    }
  });

  it('defaults: Opacity 0.25 within 0.05..1, ReducedIntensity 0.2, RotationAxis (0,1,0), arrays fresh', () => {
    const transparency = getSchemaDefaults('LogicStep_SetTransparency');
    expect(transparency.Opacity).toBe(0.25);
    expect(transparency.Opacity as number).toBeGreaterThanOrEqual(0.05);
    expect(transparency.Opacity as number).toBeLessThanOrEqual(1);
    expect(transparency.StartDelay).toBe(0);

    const effect = getSchemaDefaults('LogicStep_Effect');
    expect(effect.ReducedIntensity).toBe(0.2);
    expect(effect.Type).toBe('CoolantSpray');
    expect(effect.Anchors).toEqual([]);

    const anim = getSchemaDefaults('LogicStep_AnimateTransform');
    expect(anim.RotationAxis).toEqual({ x: 0, y: 1, z: 0 });
    expect(anim.PositionOffset).toEqual({ x: 0, y: 0, z: 0 });
    expect(anim.ScrewMotion).toBe(false);

    const step = getSchemaDefaults('LogicStep_MaintenanceStep');
    expect(step.CompletionType).toBe('Checkbox');
    expect(step.Severity).toBe('Info');
    expect(step.CameraPosition).toEqual({ x: 0, y: 0, z: 0 });
    expect(step.CameraTarget).toEqual({ x: 0, y: 0, z: 0 });

    // Stamped defaults never share a mutable object with the schema or each other.
    (anim.Targets as unknown[]).push('x');
    (step.CameraPosition as { x: number }).x = 5;
    expect(getSchemaDefaults('LogicStep_AnimateTransform').Targets).toEqual([]);
    expect(getSchemaDefaults('LogicStep_MaintenanceStep').CameraPosition).toEqual({ x: 0, y: 0, z: 0 });
    expect(step.CameraTarget).not.toBe(step.CameraPosition);
  });
});
