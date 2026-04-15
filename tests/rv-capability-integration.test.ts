// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Integration tests for the Component Capability Registry.
 *
 * Verifies that capabilities registered by component modules are
 * correctly consumed by inspector helpers, raycast manager, and
 * the extras validator.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCapabilities,
  _resetCapabilitiesForTesting,
  getCapabilities,
  getTypesWithCapability,
  getRegisteredCapabilities,
  DEFAULT_CAPABILITIES,
} from '../src/core/engine/rv-component-registry';
import { isKnownHoverableType } from '../src/core/engine/rv-raycast-manager';
import {
  isHiddenComponentType,
  componentColor,
} from '../src/core/hmi/rv-inspector-helpers';

// ─── Inspector Helpers Integration ───────────────────────────────

describe('Inspector helpers from registry', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should return badgeColor from capabilities', () => {
    registerCapabilities('ColoredType', { badgeColor: '#ff5722' });
    expect(componentColor('ColoredType')).toBe('#ff5722');
  });

  it('should hide types with inspectorVisible=false', () => {
    registerCapabilities('HiddenType', { inspectorVisible: false });
    expect(isHiddenComponentType('HiddenType')).toBe(true);
  });

  it('should still handle prefix-based colors for LogicStep_*', () => {
    expect(componentColor('LogicStep_SerialContainer')).toBe('#8d6e63');
  });

  it('should still handle prefix-based colors for PLCInput*', () => {
    expect(componentColor('PLCInputBool')).toBe('#ef5350');
  });

  it('should still handle prefix-based colors for Drive_*', () => {
    expect(componentColor('Drive_Cylinder')).toBe('#29b6f6');
  });

  it('should return default color for unknown type', () => {
    expect(componentColor('CompletelyUnknownType')).toBe('#90a4ae');
  });
});

// ─── Raycast Manager Integration ────────────────────────────────

describe('RaycastManager registry integration', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should recognize hoverable types from registry', () => {
    registerCapabilities('CustomHoverable', { hoverable: true });
    expect(isKnownHoverableType('CustomHoverable')).toBe(true);
  });

  it('should not recognize non-hoverable types', () => {
    registerCapabilities('InternalOnly', { hoverable: false, inspectorVisible: false });
    expect(isKnownHoverableType('InternalOnly')).toBe(false);
  });

  it('should not recognize unregistered types as hoverable', () => {
    expect(isKnownHoverableType('UnknownType')).toBe(false);
  });
});

// ─── Capability Query Integration ───────────────────────────────

describe('Capability queries across registered types', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
    // Simulate typical registration pattern
    registerCapabilities('Drive', { hoverable: true, exclusiveHoverGroup: true, hoverEnabledByDefault: true, filterLabel: 'Drives' });
    registerCapabilities('Sensor', { hoverable: true, exclusiveHoverGroup: true, hoverEnabledByDefault: true, filterLabel: 'Sensors' });
    registerCapabilities('MU', { hoverable: true, exclusiveHoverGroup: true, hoverEnabledByDefault: true });
    registerCapabilities('Pipe', { hoverable: true, hoverEnabledByDefault: true });
    registerCapabilities('rigidbody', { inspectorVisible: false });
  });

  it('getTypesWithCapability(exclusiveHoverGroup) returns Drive, Sensor, MU', () => {
    const types = getTypesWithCapability('exclusiveHoverGroup');
    expect(types).toContain('Drive');
    expect(types).toContain('Sensor');
    expect(types).toContain('MU');
    expect(types).not.toContain('Pipe');
    expect(types).not.toContain('rigidbody');
  });

  it('getTypesWithCapability(hoverEnabledByDefault) includes Pipe', () => {
    const types = getTypesWithCapability('hoverEnabledByDefault');
    expect(types).toContain('Pipe');
    expect(types).toContain('Drive');
  });

  it('getTypesWithCapability(filterLabel) returns filterable types', () => {
    const types = getTypesWithCapability('filterLabel');
    expect(types).toContain('Drive');
    expect(types).toContain('Sensor');
    expect(types).not.toContain('MU');
  });

  it('getRegisteredCapabilities contains all registered types', () => {
    const all = getRegisteredCapabilities();
    expect(all.has('Drive')).toBe(true);
    expect(all.has('rigidbody')).toBe(true);
    expect(all.size).toBe(5);
  });
});

// ─── Self-Registration Verification ─────────────────────────────

describe('Component self-registration', () => {
  // This test imports the actual component modules to verify their
  // side-effect registration works correctly.
  it('Drive should have capabilities after module import', async () => {
    // Import triggers side-effect registration
    await import('../src/core/engine/rv-drive');
    const caps = getCapabilities('Drive');
    expect(caps.hoverable).toBe(true);
    expect(caps.tooltipType).toBe('drive');
    expect(caps.badgeColor).toBe('#4fc3f7');
    expect(caps.exclusiveHoverGroup).toBe(true);
  });

  it('Sensor should have capabilities after module import', async () => {
    await import('../src/core/engine/rv-sensor');
    const caps = getCapabilities('Sensor');
    expect(caps.hoverable).toBe(true);
    expect(caps.tooltipType).toBe('sensor');
    expect(caps.badgeColor).toBe('#66bb6a');
  });

  it('MU should have capabilities after module import', async () => {
    await import('../src/core/engine/rv-mu');
    const caps = getCapabilities('MU');
    expect(caps.hoverable).toBe(true);
    expect(caps.exclusiveHoverGroup).toBe(true);
    expect(caps.badgeColor).toBe('#78909c');
  });

  it('Pipeline types should have capabilities after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    expect(getCapabilities('Pipe').hoverable).toBe(true);
    expect(getCapabilities('Tank').hoverable).toBe(true);
    expect(getCapabilities('Pump').hoverable).toBe(true);
    expect(getCapabilities('ProcessingUnit').hoverable).toBe(true);
    expect(getCapabilities('Metadata').hoverable).toBe(true);
  });

  it('Structural types should be inspector-invisible after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    expect(getCapabilities('rigidbody').inspectorVisible).toBe(false);
    expect(getCapabilities('renderer').inspectorVisible).toBe(false);
    expect(getCapabilities('colliders').inspectorVisible).toBe(false);
    expect(getCapabilities('BoxCollider').inspectorVisible).toBe(false);
    expect(getCapabilities('Group').inspectorVisible).toBe(false);
    expect(getCapabilities('Kinematic').inspectorVisible).toBe(false);
  });
});
