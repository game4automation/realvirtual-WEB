// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Integration tests for the Component Capability Registry.
 *
 * Verifies that capabilities registered by component modules are
 * correctly consumed by inspector helpers, raycast manager, and
 * the extras validator — on the plan-753 shape (`pick` / `bake` / `ui`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerCapabilities,
  _resetCapabilitiesForTesting,
  getCapabilities,
  claimsNodeOf,
  getPickableTypes,
  getFilterableTypes,
  getTypesWhere,
  getRegisteredCapabilities,
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

  it('should return ui.badge from capabilities', () => {
    registerCapabilities('ColoredType', { ui: { badge: '#ff5722' } });
    expect(componentColor('ColoredType')).toBe('#ff5722');
  });

  it('should hide types with ui.hidden', () => {
    registerCapabilities('HiddenType', { ui: { hidden: true } });
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

  it('should recognize pickable types from registry (select AND action)', () => {
    registerCapabilities('CustomHoverable', { pick: 'select' });
    registerCapabilities('CustomAction', { pick: 'action' });
    expect(isKnownHoverableType('CustomHoverable')).toBe(true);
    expect(isKnownHoverableType('CustomAction')).toBe(true);
  });

  it('should not recognize pick:none types', () => {
    registerCapabilities('InternalOnly', { pick: 'none', ui: { hidden: true } });
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
    registerCapabilities('Drive', { pick: 'select', bake: 'chunk', ui: { filter: 'Drives' } });
    registerCapabilities('Sensor', { pick: 'select', ui: { filter: 'Sensors' } });
    registerCapabilities('MU', { pick: 'select', bake: 'keep' });
    registerCapabilities('Pipe', { pick: 'select' });
    registerCapabilities('rigidbody', { ui: { hidden: true } });
  });

  it('the exclusive hover group (pickable + ui.filter) is Drive and Sensor', () => {
    const types = getTypesWhere((c) => c.pick !== 'none' && c.ui.filter !== null);
    expect(types).toContain('Drive');
    expect(types).toContain('Sensor');
    expect(types).not.toContain('MU');
    expect(types).not.toContain('Pipe');
    expect(types).not.toContain('rigidbody');
  });

  it('getPickableTypes includes Pipe (every pick type hovers by default now)', () => {
    const types = getPickableTypes();
    expect(types).toContain('Pipe');
    expect(types).toContain('Drive');
    expect(types).not.toContain('rigidbody');
  });

  it('getFilterableTypes returns filterable types', () => {
    const types = getFilterableTypes();
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
    expect(caps.pick).toBe('select');
    expect(caps.bake).toBe('chunk');
    expect(caps.ui.tooltip).toBe('drive');
    expect(caps.ui.badge).toBe('#4fc3f7');
    expect(caps.ui.filter).toBe('Drives');
    expect(caps.ui.priority).toBe(10);
  });

  it('Sensor should have capabilities after module import', async () => {
    await import('../src/core/engine/rv-sensor');
    const caps = getCapabilities('Sensor');
    expect(caps.pick).toBe('select');
    expect(caps.ui.tooltip).toBe('sensor');
    expect(caps.ui.badge).toBe('#66bb6a');
  });

  it('MU should have capabilities after module import', async () => {
    await import('../src/core/engine/rv-mu');
    const caps = getCapabilities('MU');
    expect(caps.pick).toBe('select');
    expect(caps.bake).toBe('keep');
    expect(caps.ui.badge).toBe('#78909c');
  });

  it('Pipeline types should have capabilities after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    expect(getCapabilities('Pipe').pick).toBe('select');
    expect(getCapabilities('Tank').pick).toBe('select');
    expect(getCapabilities('Pump').pick).toBe('select');
    expect(getCapabilities('ProcessingUnit').pick).toBe('select');
    expect(getCapabilities('Metadata').pick).toBe('select');
    // registerTooltipComponent stamps the class's tooltipType into ui.tooltip.
    expect(getCapabilities('Pipe').ui.tooltip).toBe('pipe');
    expect(getCapabilities('Tank').ui.tooltip).toBe('tank');
  });

  it('Structural types should be inspector-hidden after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    expect(getCapabilities('rigidbody').ui.hidden).toBe(true);
    expect(getCapabilities('renderer').ui.hidden).toBe(true);
    expect(getCapabilities('colliders').ui.hidden).toBe(true);
    // plan-525: BoxCollider is an authorable component now — visible, but
    // still a pure annotation for the bake.
    expect(getCapabilities('BoxCollider').ui.hidden).toBe(false);
    expect(getCapabilities('BoxCollider').claimsNode).toBe(false);
  });

  it('Kinematic is inspector-visible (authored in the asset editor) and a mover after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    const caps = getCapabilities('Kinematic');
    expect(caps.ui.hidden).toBe(false);
    expect(caps.bake).toBe('chunk');
    expect(caps.ui.badge).toBe('#ce93d8');
  });

  it('Group is inspector-visible and authorable after scene-loader import', async () => {
    await import('../src/core/engine/rv-scene-loader');
    const caps = getCapabilities('Group');
    expect(caps.ui.hidden).toBe(false);
    expect(caps.authorable).toBe(true);
    expect(caps.ui.badge).toBe('#66bb6a');
  });

  // plan-754 1c: 17456 Groups on the Mauser must not become 10737 chunk meshes
  // and a pick window per solid — a Group is metadata, not a boundary.
  it('Group is neither a chunk boundary nor a pick target', async () => {
    await import('../src/core/engine/rv-scene-loader');
    const caps = getCapabilities('Group');
    expect(caps.bake).toBe('merge');
    expect(caps.pick).toBe('none');
  });

  // plan-755 D7: whether a component keeps its node through a destructive bake
  // is declared, not inferred. The full `false` set is frozen in
  // tests/bake-claims-node.test.ts.
  it('claimsNode: Group is a pure annotation, a Drive claims, an unregistered type claims by default', async () => {
    await import('../src/core/engine/rv-scene-loader');
    expect(getCapabilities('Group').claimsNode).toBe(false);
    expect(getCapabilities('Drive').claimsNode).toBe(true);
    expect(getCapabilities('NeverRegisteredType').claimsNode).toBe(true);
    // `_N` dedup keys resolve to their base type; an unknown base still claims.
    expect(claimsNodeOf('Group')).toBe(false);
    expect(claimsNodeOf('Group_1')).toBe(false);
    expect(claimsNodeOf('Group_12')).toBe(false);
    expect(claimsNodeOf('Drive_1')).toBe(true);
    expect(claimsNodeOf('NeverRegisteredType_1')).toBe(true);
  });
});
