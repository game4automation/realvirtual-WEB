// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-597 §9.1 — categoryOf(): capability → `_N` base → built-in rule → other,
 * normalisation of unknown ids, memo invalidation through the capability epoch.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCapabilitiesForTesting,
  getCapabilitiesEpoch,
  registerCapabilities,
  registerComponentSchema,
  registerPreBakeHook,
} from '../src/core/engine/rv-component-registry';
import {
  _resetCategoryCacheForTesting,
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  categoryOf,
} from '../src/core/engine/rv-component-category';

describe('categoryOf', () => {
  beforeEach(() => { _resetCapabilitiesForTesting(); _resetCategoryCacheForTesting(); });

  it('uses ui.category and ui.filter of a registered type', () => {
    registerCapabilities('Foo', { ui: { filter: 'Foos', category: 'transport' } });
    expect(categoryOf('Foo')).toEqual({ category: 'transport', label: 'Foos' });
  });

  it('strips the _N instance suffix to the base type', () => {
    registerCapabilities('Foo', { ui: { filter: 'Foos', category: 'transport' } });
    expect(categoryOf('Foo_2').category).toBe('transport');
    expect(categoryOf('Foo_2').label).toBe('Foos');
  });

  it('maps a _N duplicate of a rule type under the base label', () => {
    expect(categoryOf('LogicStep_Delay_1')).toEqual({ category: 'logic', label: 'Delay' });
    expect(categoryOf('PLCOutputBool_2')).toEqual({ category: 'signals', label: 'PLCOutputBool' });
  });

  it('does not strip a named subtype (Drive_Gear) but maps it by rule', () => {
    expect(categoryOf('Drive_Gear')).toEqual({ category: 'drives', label: 'Drive_Gear' });
  });

  it('classifies PLC signals, ConnectSignal and LogicStep_* by built-in rule', () => {
    expect(categoryOf('PLCOutputBool')).toEqual({ category: 'signals', label: 'PLCOutputBool' });
    expect(categoryOf('ConnectSignal').category).toBe('signals');
    expect(categoryOf('LogicStep_Wait')).toEqual({ category: 'logic', label: 'Wait' });
    expect(categoryOf('LogicSteppy').category).toBe('other'); // prefix needs the underscore
  });

  it('maps the other built-in rule types', () => {
    expect(categoryOf('Source').category).toBe('material-flow');
    expect(categoryOf('Sink').category).toBe('material-flow');
    expect(categoryOf('MU').category).toBe('material-flow');
    expect(categoryOf('DESStation').category).toBe('material-flow');
    expect(categoryOf('Grip').category).toBe('robotics');
    expect(categoryOf('GripTarget').category).toBe('robotics');
    expect(categoryOf('WebSafetyDoor').category).toBe('hmi');
    expect(categoryOf('BoxCollider').category).toBe('physics');
    expect(categoryOf('RVPlcProgram').category).toBe('logic');
    expect(categoryOf('DrivePulseEncoder').category).toBe('drives');
  });

  it('falls back to other with the type key as label', () => {
    expect(categoryOf('Unknown42')).toEqual({ category: 'other', label: 'Unknown42' });
  });

  it('normalises an unknown category id to other, keeping the filter label', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCapabilities('Bar', { ui: { filter: 'Bars', category: 'custom' } });
    expect(categoryOf('Bar')).toEqual({ category: 'other', label: 'Bars' });
    _resetCategoryCacheForTesting();
    warn.mockRestore();
  });

  it('treats category null/absent like no category', () => {
    registerCapabilities('Baz', { ui: { filter: 'Bazs', category: null } });
    expect(categoryOf('Baz')).toEqual({ category: 'other', label: 'Bazs' });
    registerCapabilities('Qux', { ui: { filter: 'Quxs' } });
    expect(categoryOf('Qux')).toEqual({ category: 'other', label: 'Quxs' });
  });

  it('invalidates the memo on a later registration', () => {
    expect(categoryOf('Late').category).toBe('other');
    registerCapabilities('Late', { ui: { filter: 'Lates', category: 'hmi' } });
    expect(categoryOf('Late').category).toBe('hmi');
  });

  it('bumps its own capability epoch on every capability change', () => {
    const e0 = getCapabilitiesEpoch();
    registerCapabilities('E1', {});
    const e1 = getCapabilitiesEpoch();
    expect(e1).toBeGreaterThan(e0);
    registerComponentSchema('E2', {}, { ui: { category: 'info' } });
    const e2 = getCapabilitiesEpoch();
    expect(e2).toBeGreaterThan(e1);
    registerPreBakeHook('E2', () => {});
    const e3 = getCapabilitiesEpoch();
    expect(e3).toBeGreaterThan(e2);
    _resetCapabilitiesForTesting();
    expect(getCapabilitiesEpoch()).toBeGreaterThan(e3);
  });

  it('has an English label for every category in the fixed order', () => {
    for (const id of CATEGORY_ORDER) expect(CATEGORY_LABEL[id]).toMatch(/^[A-Z]/);
    expect(CATEGORY_ORDER[CATEGORY_ORDER.length - 1]).toBe('other');
  });
});
