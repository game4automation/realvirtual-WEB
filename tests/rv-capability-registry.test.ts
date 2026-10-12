// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Component Capability Registry Tests
 *
 * Core registry CRUD, defaults, freeze, getTypesWhere / getTypesWithCapability,
 * registerComponent with capabilities, and registerComponentSchema with
 * capabilities — on the plan-753 shape (`pick` / `bake` / `ui` / `authorable`).
 * The legacy adapter has its own suite in capabilities-migration.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  registerCapabilities,
  _resetCapabilitiesForTesting,
  getCapabilities,
  getTypesWithCapability,
  getTypesWhere,
  getPickableTypes,
  getFilterableTypes,
  getRegisteredCapabilities,
  DEFAULT_CAPABILITIES,
  DEFAULT_BADGE_COLOR,
  registerComponent,
  registerComponentSchema,
  pickModeOf,
  bakeRoleOf,
  uiOf,
  type RVComponent,
  type ComponentContext,
  type ComponentSchema,
} from '../src/core/engine/rv-component-registry';

// ─── Core Registry Tests ────────────────────────────────────────

describe('ComponentCapabilities', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should return DEFAULT_CAPABILITIES for unknown type', () => {
    const caps = getCapabilities('NonExistentType');
    expect(caps.pick).toBe('none');
    expect(caps.bake).toBe('merge');
    expect(caps.ui.hidden).toBe(false);
    expect(caps.ui.badge).toBe(DEFAULT_BADGE_COLOR);
    expect(caps.ui.tooltip).toBeNull();
    expect(caps.ui.filter).toBeNull();
    expect(caps.ui.priority).toBe(5);
    expect(caps.authorable).toBe(false);
  });

  it('should merge with defaults on registerCapabilities (nested ui too)', () => {
    registerCapabilities('TestType', { pick: 'select', ui: { badge: '#ff0000' } });
    const caps = getCapabilities('TestType');
    expect(caps.pick).toBe('select');
    expect(caps.ui.badge).toBe('#ff0000');
    expect(caps.bake).toBe('merge');       // default
    expect(caps.ui.hidden).toBe(false);    // default
    expect(caps.ui.tooltip).toBeNull();    // default
    expect(caps.ui.priority).toBe(5);      // default
  });

  it('should freeze registered capabilities including the ui block', () => {
    registerCapabilities('FrozenType', { pick: 'select' });
    const caps = getCapabilities('FrozenType');
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps.ui)).toBe(true);
    expect(() => { (caps as any).pick = 'none'; }).toThrow();
    expect(() => { (caps.ui as any).badge = '#000'; }).toThrow();
  });

  it('getTypesWhere / getPickableTypes return the matching types', () => {
    registerCapabilities('HoverA', { pick: 'select' });
    registerCapabilities('HoverB', { pick: 'action' });
    registerCapabilities('NoHover', { pick: 'none' });
    const types = getPickableTypes();
    expect(types).toContain('HoverA');
    expect(types).toContain('HoverB');
    expect(types).not.toContain('NoHover');
    expect(getTypesWhere((c) => c.pick === 'action')).toEqual(['HoverB']);
  });

  it('getTypesWithCapability(pick|bake|authorable) reads the top-level fields', () => {
    registerCapabilities('P', { pick: 'select' });
    registerCapabilities('B', { bake: 'keep' });
    registerCapabilities('A', { authorable: true });
    registerCapabilities('Plain', {});
    expect(getTypesWithCapability('pick')).toEqual(['P']);
    expect(getTypesWithCapability('bake')).toEqual(['B']);
    expect(getTypesWithCapability('authorable')).toEqual(['A']);
  });

  it('should warn on double registration in DEV mode', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCapabilities('DupeType', { pick: 'select' });
    registerCapabilities('DupeType', { pick: 'none' }); // overwrites
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('already registered'));
    expect(getCapabilities('DupeType').pick).toBe('none'); // last wins
    spy.mockRestore();
  });

  it('DEFAULT_CAPABILITIES should be frozen', () => {
    expect(Object.isFrozen(DEFAULT_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_CAPABILITIES.ui)).toBe(true);
  });

  it('getRegisteredCapabilities returns all entries', () => {
    registerCapabilities('TypeA', { pick: 'select' });
    registerCapabilities('TypeB', { bake: 'chunk' });
    const all = getRegisteredCapabilities();
    expect(all.size).toBe(2);
    expect(all.has('TypeA')).toBe(true);
    expect(all.has('TypeB')).toBe(true);
  });

  it('getFilterableTypes returns only types with a ui.filter', () => {
    registerCapabilities('WithFilter', { ui: { filter: 'Drives' } });
    registerCapabilities('NoFilter', { ui: { filter: null } });
    const types = getFilterableTypes();
    expect(types).toContain('WithFilter');
    expect(types).not.toContain('NoFilter');
  });

  it('_resetCapabilitiesForTesting clears all entries', () => {
    registerCapabilities('TestClear', { pick: 'select' });
    expect(getCapabilities('TestClear').pick).toBe('select');
    _resetCapabilitiesForTesting();
    expect(getCapabilities('TestClear').pick).toBe('none'); // back to default
  });

  it('uiOf returns the resolved ui block (defaults for unknown types)', () => {
    registerCapabilities('UiType', { ui: { badge: '#123456', filter: 'X', tooltip: 'x', priority: 2, hidden: true } });
    expect(uiOf('UiType')).toEqual({ badge: '#123456', filter: 'X', category: null, tooltip: 'x', priority: 2, hidden: true });
    expect(uiOf('Nope')).toBe(DEFAULT_CAPABILITIES.ui);
  });
});

// ─── Node-level getters ─────────────────────────────────────────

describe('pickModeOf / bakeRoleOf on nodes', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
    registerCapabilities('Sel', { pick: 'select', bake: 'chunk' });
    registerCapabilities('Act', { pick: 'action' });
    registerCapabilities('Keep', { bake: 'keep' });
    registerCapabilities('Plain', {});
  });

  function nodeWith(rv: Record<string, unknown>): Object3D {
    const n = new Object3D();
    n.userData.realvirtual = rv;
    return n;
  }

  it('pickModeOf(type) reads the type; pickModeOf(node) takes the strongest component', () => {
    expect(pickModeOf('Sel')).toBe('select');
    expect(pickModeOf('Unknown')).toBe('none');
    expect(pickModeOf(nodeWith({ Plain: {} }))).toBe('none');
    expect(pickModeOf(nodeWith({ Sel: {}, Act: {} }))).toBe('action');
    expect(pickModeOf(nodeWith({ Sel: {}, Plain: {} }))).toBe('select');
    expect(pickModeOf(new Object3D())).toBe('none');
  });

  it('bakeRoleOf is undefined without a registered component, else keep > chunk > merge', () => {
    expect(bakeRoleOf(new Object3D())).toBeUndefined();
    expect(bakeRoleOf(nodeWith({ NotRegistered: {} }))).toBeUndefined();
    expect(bakeRoleOf(nodeWith({ Plain: {} }))).toBe('merge');
    expect(bakeRoleOf(nodeWith({ Plain: {}, Sel: {} }))).toBe('chunk');
    expect(bakeRoleOf(nodeWith({ Sel: {}, Keep: {} }))).toBe('keep');
  });

  it('bakeRoleOf honours the rv.BakeRole override and the skip predicate', () => {
    expect(bakeRoleOf(nodeWith({ Plain: {}, BakeRole: 'keep' }))).toBe('keep');
    expect(bakeRoleOf(nodeWith({ Keep: {}, BakeRole: 'merge' }))).toBe('merge');
    expect(bakeRoleOf(nodeWith({ Keep: {}, BakeRole: 'bogus' }))).toBe('keep'); // invalid override ignored
    const node = nodeWith({ Keep: { SpinMode: 'Texture' }, Plain: {} });
    expect(bakeRoleOf(node, (type, cfg) => type === 'Keep' && (cfg as { SpinMode?: string }).SpinMode === 'Texture')).toBe('merge');
  });

  it('bakeRoleOf skips falsy component values', () => {
    expect(bakeRoleOf(nodeWith({ Keep: null, Plain: {} }))).toBe('merge');
  });
});

// ─── Factory Capabilities Tests ─────────────────────────────────

describe('registerComponent with capabilities', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  class FakeCmp implements RVComponent {
    static readonly schema: ComponentSchema = {};
    readonly node: Object3D;
    isOwner = true;
    constructor(node: Object3D) { this.node = node; }
    init(_ctx: ComponentContext): void { /* noop */ }
  }

  it('should auto-register capabilities from factory', () => {
    registerComponent({
      type: 'FactoryWithCaps',
      schema: {},
      capabilities: { pick: 'select', ui: { tooltip: 'test' } },
      create: (node) => new FakeCmp(node),
    });
    const caps = getCapabilities('FactoryWithCaps');
    expect(caps.pick).toBe('select');
    expect(caps.ui.tooltip).toBe('test');
  });

  it('should work without capabilities field (backwards compat)', () => {
    registerComponent({
      type: 'FactoryNoCaps',
      schema: {},
      create: (node) => new FakeCmp(node),
    });
    const caps = getCapabilities('FactoryNoCaps');
    expect(caps.pick).toBe('none'); // default
  });
});

// ─── Schema Capabilities Tests ──────────────────────────────────

describe('registerComponentSchema with capabilities', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should register capabilities alongside schema', () => {
    registerComponentSchema('SchemaWithCaps', {}, { ui: { badge: '#29b6f6' } });
    const caps = getCapabilities('SchemaWithCaps');
    expect(caps.ui.badge).toBe('#29b6f6');
  });

  it('should work without capabilities (backwards compat)', () => {
    registerComponentSchema('SchemaNoCaps', {});
    const caps = getCapabilities('SchemaNoCaps');
    expect(caps.pick).toBe('none'); // default
  });
});
