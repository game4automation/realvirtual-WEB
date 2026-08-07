// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-tooltip-model.test.ts — plan-234 §9.4.
 *
 * Covers the additive binding/activity fields on the pure tooltip-model builder
 * and the pure `activityLabel` helper:
 *  - buildSignalTooltipModel with boundTo / activity / activityLabel
 *  - backward-compatible shape when the new args are omitted
 *  - activityLabel for every SignalActivity (incl. the "stale Ns" age)
 */
import { describe, it, expect } from 'vitest';
import {
  buildSignalTooltipModel,
  activityLabel,
  resolveInterfaceOrigin,
  resolveInterfaceOriginForSignal,
} from '../src/core/hmi/rv-signal-badge';

describe('buildSignalTooltipModel — binding + activity (additive)', () => {
  const baseArgs = {
    name: 'MC07',
    plcType: 'PLCInputBool',
    direction: 'input' as const,
    shown: true,
    forced: false,
    meta: { address: '%I2.3', source: 'MQTT · Data_I_1' },
    hint: 'Click to force',
  };

  it('adds boundTo when components are resolved', () => {
    const model = buildSignalTooltipModel({
      ...baseArgs,
      boundTo: [{ componentType: 'Sensor', path: 'Conveyor01/EndStop' }],
      activity: 'live',
      activityLabel: 'live',
    });
    expect(model.boundTo).toEqual([{ componentType: 'Sensor', path: 'Conveyor01/EndStop' }]);
    expect(model.activity).toBe('live');
    expect(model.activityLabel).toBe('live');
    // Existing fields untouched.
    expect(model.name).toBe('MC07');
    expect(model.typePhrase).toBe('Input · Bool');
    expect(model.value).toBe('True');
    expect(model.address).toBe('%I2.3');
    expect(model.source).toBe('MQTT · Data_I_1');
  });

  it('carries multiple bindings in order', () => {
    const model = buildSignalTooltipModel({
      ...baseArgs,
      boundTo: [
        { componentType: 'Sensor', path: 'Conveyor01/EndStop' },
        { componentType: 'WebSensor', path: 'Panel/Lamp' },
      ],
    });
    expect(model.boundTo).toHaveLength(2);
    expect(model.boundTo?.[0].componentType).toBe('Sensor');
  });

  it('omits boundTo/activity when none supplied (backward-compatible shape)', () => {
    const model = buildSignalTooltipModel(baseArgs);
    expect(model.boundTo).toBeUndefined();
    expect(model.activity).toBeUndefined();
    expect(model.activityLabel).toBeUndefined();
    // Shape identical to the pre-plan-234 model.
    expect(Object.prototype.hasOwnProperty.call(model, 'boundTo')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(model, 'activity')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(model, 'activityLabel')).toBe(false);
  });

  it('drops an empty boundTo array (treated as "no binding")', () => {
    const model = buildSignalTooltipModel({ ...baseArgs, boundTo: [] });
    expect(model.boundTo).toBeUndefined();
  });

  it('carries the FULL binding list (plan-246 F7 — no first-entry truncation in the model)', () => {
    const boundTo = Array.from({ length: 12 }, (_, i) => ({
      componentType: 'Sensor',
      path: `Line/Conveyor${i}/EndStop`,
    }));
    const model = buildSignalTooltipModel({ ...baseArgs, boundTo });
    expect(model.boundTo).toHaveLength(12);
    expect(model.boundTo?.[11].path).toBe('Line/Conveyor11/EndStop');
  });

  it('carries interfaceOrigin when supplied and omits it otherwise (plan-246 F6)', () => {
    const withOrigin = buildSignalTooltipModel({ ...baseArgs, interfaceOrigin: 'MQTT1' });
    expect(withOrigin.interfaceOrigin).toBe('MQTT1');
    const without = buildSignalTooltipModel(baseArgs);
    expect(without.interfaceOrigin).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(without, 'interfaceOrigin')).toBe(false);
  });

  it('carries the signal nodePath for go-to-signal navigation and omits it otherwise (plan-246)', () => {
    const withPath = buildSignalTooltipModel({ ...baseArgs, nodePath: 'Turntable/Signals/Start' });
    expect(withPath.nodePath).toBe('Turntable/Signals/Start');
    const without = buildSignalTooltipModel(baseArgs);
    expect(without.nodePath).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(without, 'nodePath')).toBe(false);
  });
});

describe('resolveInterfaceOrigin — source label → CONNECT interface (plan-246 F6)', () => {
  const interfaces = [
    { id: 'MQTT1', type: 'MQTT' },
    { id: 'S7-Main', type: 'S7' },
    { id: 'OpcUa1', type: 'OpcUa' },
  ];

  it('resolves bare type labels and "type · detail" labels', () => {
    expect(resolveInterfaceOrigin('MQTT', interfaces)).toBe('MQTT1');
    expect(resolveInterfaceOrigin('MQTT · Data_I_1', interfaces)).toBe('MQTT1');
    expect(resolveInterfaceOrigin('S7 · DB1', interfaces)).toBe('S7-Main');
  });

  it('returns undefined for unknown/absent sources', () => {
    expect(resolveInterfaceOrigin('Simulation', interfaces)).toBeUndefined();
    expect(resolveInterfaceOrigin(undefined, interfaces)).toBeUndefined();
    expect(resolveInterfaceOrigin('', interfaces)).toBeUndefined();
    expect(resolveInterfaceOrigin('MQTT', [])).toBeUndefined();
  });
});

describe('resolveInterfaceOriginForSignal — membership-first resolution (plan-246 F6)', () => {
  const interfaces = [
    {
      id: 'MQTT1',
      type: 'MQTT',
      topics: [
        { signals: [{ name: 'MC07_Start' }, { name: 'MC07_Occupied' }] },
        { signals: [{ name: 'Turntable_Dest' }] },
      ],
    },
    { id: 'S7-Main', type: 'S7', signals: [{ name: 'DB1_Speed' }] },
  ];

  it('resolves via topic-signal membership (primary path)', () => {
    expect(resolveInterfaceOriginForSignal('MC07_Start', undefined, interfaces)).toBe('MQTT1');
    expect(resolveInterfaceOriginForSignal('Turntable_Dest', undefined, interfaces)).toBe('MQTT1');
  });

  it('resolves via flat-signal membership', () => {
    expect(resolveInterfaceOriginForSignal('DB1_Speed', undefined, interfaces)).toBe('S7-Main');
  });

  it('membership wins even when the source label points elsewhere', () => {
    expect(resolveInterfaceOriginForSignal('DB1_Speed', 'MQTT · Data_I_1', interfaces)).toBe('S7-Main');
  });

  it('falls back to the source-label heuristic for unknown signals', () => {
    expect(resolveInterfaceOriginForSignal('UnknownSig', 'MQTT · Data_I_1', interfaces)).toBe('MQTT1');
    expect(resolveInterfaceOriginForSignal('UnknownSig', 'S7 · DB1', interfaces)).toBe('S7-Main');
  });

  it('returns undefined when neither membership nor source resolve', () => {
    expect(resolveInterfaceOriginForSignal('UnknownSig', undefined, interfaces)).toBeUndefined();
    expect(resolveInterfaceOriginForSignal(undefined, undefined, interfaces)).toBeUndefined();
    expect(resolveInterfaceOriginForSignal('X', 'Simulation', interfaces)).toBeUndefined();
  });
});

describe('activityLabel — pure helper', () => {
  it('maps each activity to a compact label', () => {
    expect(activityLabel('live')).toBe('live');
    expect(activityLabel('supplied')).toBe('supplied');
    expect(activityLabel('local')).toBe('local');
    expect(activityLabel('stale')).toBe('stale');
    expect(activityLabel('no-source')).toBe('no source');
  });

  it('renders the "stale Ns" age when given a positive ageMs', () => {
    expect(activityLabel('stale', 45_000)).toBe('stale 45s');
    expect(activityLabel('stale', 1_400)).toBe('stale 1s');
    expect(activityLabel('stale', 0)).toBe('stale 0s');
  });

  it('ignores a negative/non-finite age (bare "stale")', () => {
    expect(activityLabel('stale', -5)).toBe('stale');
    expect(activityLabel('stale', Number.NaN)).toBe('stale');
    expect(activityLabel('stale', Number.POSITIVE_INFINITY)).toBe('stale');
  });

  it('ignores an age for non-stale states', () => {
    expect(activityLabel('live', 45_000)).toBe('live');
  });
});
