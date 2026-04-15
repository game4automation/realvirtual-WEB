// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TooltipContentRegistry Tests
 *
 * Tests content provider registration, lookup by contentType, and priority ordering.
 */
import { describe, it, expect } from 'vitest';
import { TooltipContentRegistry } from '../src/core/hmi/tooltip/tooltip-registry';

// Dummy components (just need to be distinguishable)
const DummyA = () => null;
const DummyB = () => null;

describe('TooltipContentRegistry', () => {
  it('should register and lookup provider by contentType', () => {
    const registry = new TooltipContentRegistry();
    registry.register({ contentType: 'drive', component: DummyA as any });
    expect(registry.getProvider('drive')).toBe(DummyA);
  });

  it('should return null for unregistered contentType', () => {
    const registry = new TooltipContentRegistry();
    expect(registry.getProvider('sensor')).toBeNull();
  });

  it('should respect priority when multiple providers for same type', () => {
    const registry = new TooltipContentRegistry();
    registry.register({ contentType: 'drive', component: DummyA as any, priority: 100 });
    registry.register({ contentType: 'drive', component: DummyB as any, priority: 10 });
    // Lower priority number = higher priority => DummyB wins
    expect(registry.getProvider('drive')).toBe(DummyB);
  });

  it('should handle multiple content types independently', () => {
    const registry = new TooltipContentRegistry();
    registry.register({ contentType: 'drive', component: DummyA as any });
    registry.register({ contentType: 'sensor', component: DummyB as any });
    expect(registry.getProvider('drive')).toBe(DummyA);
    expect(registry.getProvider('sensor')).toBe(DummyB);
  });

  it('should use default priority 100 when not specified', () => {
    const registry = new TooltipContentRegistry();
    registry.register({ contentType: 'drive', component: DummyA as any }); // default 100
    registry.register({ contentType: 'drive', component: DummyB as any, priority: 50 });
    // DummyB has lower priority number => wins
    expect(registry.getProvider('drive')).toBe(DummyB);
  });
});

// ─── Controller Registry Tests ──────────────────────────────────────

describe('TooltipControllerRegistry', () => {
  it('should register and retrieve controllers', () => {
    const registry = new TooltipContentRegistry();
    const MockCtrl = (() => null) as any;
    registry.registerController({ types: ['Drive'], component: MockCtrl });
    const controllers = registry.getControllers();
    expect(controllers).toHaveLength(1);
    expect(controllers[0].types).toEqual(['Drive']);
    expect(controllers[0].component).toBe(MockCtrl);
  });

  it('should prevent duplicate controller registration (same component)', () => {
    const registry = new TooltipContentRegistry();
    const MockCtrl = (() => null) as any;
    registry.registerController({ types: ['Drive'], component: MockCtrl });
    registry.registerController({ types: ['Drive'], component: MockCtrl });
    expect(registry.getControllers()).toHaveLength(1);
  });

  it('should allow different controllers for different types', () => {
    const registry = new TooltipContentRegistry();
    const CtrlA = (() => null) as any;
    const CtrlB = (() => null) as any;
    registry.registerController({ types: ['Drive'], component: CtrlA });
    registry.registerController({ types: ['Pipe', 'Tank'], component: CtrlB });
    const controllers = registry.getControllers();
    expect(controllers).toHaveLength(2);
  });

  it('should return empty array when no controllers registered', () => {
    const registry = new TooltipContentRegistry();
    expect(registry.getControllers()).toHaveLength(0);
  });
});

// ─── Data Resolver Tests ───────────────────────────────────────────

describe('TooltipDataResolverRegistry', () => {
  it('should register and retrieve data resolver', () => {
    const registry = new TooltipContentRegistry();
    const resolver = () => ({ type: 'test' });
    registry.registerDataResolver('test', resolver);
    expect(registry.getDataResolver('test')).toBe(resolver);
  });

  it('should return null for unregistered content type', () => {
    const registry = new TooltipContentRegistry();
    expect(registry.getDataResolver('unknown')).toBeNull();
  });

  it('should handle multiple data resolvers independently', () => {
    const registry = new TooltipContentRegistry();
    const resolverA = () => ({ type: 'a' });
    const resolverB = () => ({ type: 'b' });
    registry.registerDataResolver('a', resolverA);
    registry.registerDataResolver('b', resolverB);
    expect(registry.getDataResolver('a')).toBe(resolverA);
    expect(registry.getDataResolver('b')).toBe(resolverB);
  });

  it('should overwrite resolver on re-registration', () => {
    const registry = new TooltipContentRegistry();
    const resolver1 = () => ({ type: 'v1' });
    const resolver2 = () => ({ type: 'v2' });
    registry.registerDataResolver('test', resolver1);
    registry.registerDataResolver('test', resolver2);
    expect(registry.getDataResolver('test')).toBe(resolver2);
  });
});
