// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Component Capability Registry Tests
 *
 * Core registry CRUD, defaults, freeze, getTypesWithCapability,
 * registerComponent with capabilities, and registerComponentSchema with capabilities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  registerCapabilities,
  _resetCapabilitiesForTesting,
  getCapabilities,
  getTypesWithCapability,
  getRegisteredCapabilities,
  DEFAULT_CAPABILITIES,
  registerComponent,
  registerComponentSchema,
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
    expect(caps.hoverable).toBe(false);
    expect(caps.inspectorVisible).toBe(true);
    expect(caps.badgeColor).toBe('#90a4ae');
    expect(caps.tooltipType).toBeNull();
    expect(caps.filterLabel).toBeNull();
    expect(caps.simulationActive).toBe(false);
    expect(caps.hoverEnabledByDefault).toBe(false);
    expect(caps.exclusiveHoverGroup).toBe(false);
  });

  it('should merge with defaults on registerCapabilities', () => {
    registerCapabilities('TestType', { hoverable: true, badgeColor: '#ff0000' });
    const caps = getCapabilities('TestType');
    expect(caps.hoverable).toBe(true);
    expect(caps.badgeColor).toBe('#ff0000');
    expect(caps.inspectorVisible).toBe(true); // default
    expect(caps.tooltipType).toBeNull(); // default
  });

  it('should freeze registered capabilities', () => {
    registerCapabilities('FrozenType', { hoverable: true });
    const caps = getCapabilities('FrozenType');
    expect(Object.isFrozen(caps)).toBe(true);
    expect(() => { (caps as any).hoverable = false; }).toThrow();
  });

  it('getTypesWithCapability returns correct types', () => {
    registerCapabilities('HoverA', { hoverable: true });
    registerCapabilities('HoverB', { hoverable: true });
    registerCapabilities('NoHover', { hoverable: false });
    const types = getTypesWithCapability('hoverable');
    expect(types).toContain('HoverA');
    expect(types).toContain('HoverB');
    expect(types).not.toContain('NoHover');
  });

  it('should warn on double registration in DEV mode', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCapabilities('DupeType', { hoverable: true });
    registerCapabilities('DupeType', { hoverable: false }); // overwrites
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('already registered'));
    expect(getCapabilities('DupeType').hoverable).toBe(false); // last wins
    spy.mockRestore();
  });

  it('DEFAULT_CAPABILITIES should be frozen', () => {
    expect(Object.isFrozen(DEFAULT_CAPABILITIES)).toBe(true);
  });

  it('getRegisteredCapabilities returns all entries', () => {
    registerCapabilities('TypeA', { hoverable: true });
    registerCapabilities('TypeB', { selectable: true });
    const all = getRegisteredCapabilities();
    expect(all.size).toBe(2);
    expect(all.has('TypeA')).toBe(true);
    expect(all.has('TypeB')).toBe(true);
  });

  it('getTypesWithCapability works for non-boolean caps', () => {
    registerCapabilities('WithFilter', { filterLabel: 'Drives' });
    registerCapabilities('NoFilter', { filterLabel: null });
    const types = getTypesWithCapability('filterLabel');
    expect(types).toContain('WithFilter');
    expect(types).not.toContain('NoFilter');
  });

  it('_resetCapabilitiesForTesting clears all entries', () => {
    registerCapabilities('TestClear', { hoverable: true });
    expect(getCapabilities('TestClear').hoverable).toBe(true);
    _resetCapabilitiesForTesting();
    expect(getCapabilities('TestClear').hoverable).toBe(false); // back to default
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
      capabilities: { hoverable: true, tooltipType: 'test' },
      create: (node) => new FakeCmp(node),
    });
    const caps = getCapabilities('FactoryWithCaps');
    expect(caps.hoverable).toBe(true);
    expect(caps.tooltipType).toBe('test');
  });

  it('should work without capabilities field (backwards compat)', () => {
    registerComponent({
      type: 'FactoryNoCaps',
      schema: {},
      create: (node) => new FakeCmp(node),
    });
    const caps = getCapabilities('FactoryNoCaps');
    expect(caps.hoverable).toBe(false); // default
  });
});

// ─── Schema Capabilities Tests ──────────────────────────────────

describe('registerComponentSchema with capabilities', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should register capabilities alongside schema', () => {
    registerComponentSchema('SchemaWithCaps', {}, { badgeColor: '#29b6f6' });
    const caps = getCapabilities('SchemaWithCaps');
    expect(caps.badgeColor).toBe('#29b6f6');
  });

  it('should work without capabilities (backwards compat)', () => {
    registerComponentSchema('SchemaNoCaps', {});
    const caps = getCapabilities('SchemaNoCaps');
    expect(caps.hoverable).toBe(false); // default
  });
});
