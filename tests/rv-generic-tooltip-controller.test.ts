// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for GenericTooltipController logic — rv_extras iteration,
 * capability checking, data resolver dispatch, and priority handling.
 *
 * Tests the core algorithm without React rendering by simulating
 * the rv_extras iteration logic directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { TooltipContentRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import {
  registerCapabilities,
  getCapabilities,
  _resetCapabilitiesForTesting,
} from '../src/core/engine/rv-component-registry';

// ── Test helpers ──

/** Simulates the core rv_extras iteration from GenericTooltipController. */
function resolveHoverSections(
  node: Object3D,
  registry: TooltipContentRegistry,
  viewer: any,
): Array<{ id: string; type: string; data: Record<string, unknown>; priority: number }> {
  const sections: Array<{ id: string; type: string; data: Record<string, unknown>; priority: number }> = [];
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  if (!rv) return sections;

  for (const key of Object.keys(rv)) {
    if (typeof rv[key] !== 'object') continue;
    const caps = getCapabilities(key);
    if (!caps.tooltipType) continue;
    const resolver = registry.getDataResolver(caps.tooltipType);
    if (!resolver) continue;
    const data = resolver(node, viewer);
    if (!data) continue;
    sections.push({
      id: `tooltip-hover:${caps.tooltipType}`,
      type: caps.tooltipType,
      data,
      priority: caps.hoverPriority ?? 5,
    });
  }
  return sections;
}

const mockViewer = {
  drives: [] as any[],
  registry: {
    getPathForNode: () => '/Scene/TestNode',
    findInParent: () => null,
  },
} as any;

describe('GenericTooltipController rv_extras iteration', () => {
  beforeEach(() => {
    _resetCapabilitiesForTesting();
  });

  it('should produce tooltip section for node with Drive rv_extras', () => {
    registerCapabilities('Drive', { tooltipType: 'drive', hoverPriority: 10 });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    const mockDrive = { name: 'Axis1', node };
    const viewer = { ...mockViewer, drives: [mockDrive] };

    registry.registerDataResolver('drive', (n, v) => {
      const drive = (v as any).drives.find((d: any) => d.node === n);
      return drive ? { type: 'drive', driveName: drive.name } : null;
    });

    node.userData = {
      realvirtual: { Drive: { TargetSpeed: 100 } },
    };

    const sections = resolveHoverSections(node, registry, viewer);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('drive');
    expect(sections[0].data).toEqual({ type: 'drive', driveName: 'Axis1' });
    expect(sections[0].priority).toBe(10);
  });

  it('should produce multiple sections for node with Drive + AASLink', () => {
    registerCapabilities('Drive', { tooltipType: 'drive', hoverPriority: 10 });
    registerCapabilities('AASLink', { tooltipType: 'aas', hoverPriority: 3 });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    const mockDrive = { name: 'Motor1', node };
    const viewer = { ...mockViewer, drives: [mockDrive] };

    registry.registerDataResolver('drive', (n, v) => {
      const drive = (v as any).drives.find((d: any) => d.node === n);
      return drive ? { type: 'drive', driveName: drive.name } : null;
    });
    registry.registerDataResolver('aas', (n) => {
      const aas = n.userData?._rvAasLink;
      return aas ? { type: 'aas', aasId: aas.aasId } : null;
    });

    node.userData = {
      realvirtual: {
        Drive: { TargetSpeed: 100 },
        AASLink: { aasId: 'urn:test' },
      },
      _rvAasLink: { aasId: 'urn:test' },
    };

    const sections = resolveHoverSections(node, registry, viewer);
    expect(sections).toHaveLength(2);

    const driveSection = sections.find(s => s.type === 'drive');
    const aasSection = sections.find(s => s.type === 'aas');
    expect(driveSection).toBeDefined();
    expect(aasSection).toBeDefined();
    expect(driveSection!.priority).toBe(10);
    expect(aasSection!.priority).toBe(3);
  });

  it('should skip scalar rv_extras keys', () => {
    registerCapabilities('Drive', { tooltipType: 'drive', hoverPriority: 10 });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    registry.registerDataResolver('drive', () => ({ type: 'drive', driveName: 'X' }));

    node.userData = {
      realvirtual: {
        Drive: { TargetSpeed: 100 },
        _rvType: 'Drive',   // scalar — should be skipped
        layer: 0,            // scalar — should be skipped
      },
    };
    const viewer = { ...mockViewer, drives: [{ name: 'X', node }] };

    const sections = resolveHoverSections(node, registry, viewer);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('drive');
  });

  it('should skip types without registered resolver', () => {
    registerCapabilities('Sensor', { tooltipType: 'sensor', hoverPriority: 5 });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    // No resolver registered for 'sensor'

    node.userData = {
      realvirtual: { Sensor: { Range: 100 } },
    };

    const sections = resolveHoverSections(node, registry, mockViewer);
    expect(sections).toHaveLength(0);
  });

  it('should skip when resolver returns null', () => {
    registerCapabilities('Drive', { tooltipType: 'drive', hoverPriority: 10 });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    registry.registerDataResolver('drive', () => null); // always null

    node.userData = {
      realvirtual: { Drive: { TargetSpeed: 100 } },
    };

    const sections = resolveHoverSections(node, registry, mockViewer);
    expect(sections).toHaveLength(0);
  });

  it('should produce no sections for node without realvirtual userData', () => {
    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    node.userData = {};

    const sections = resolveHoverSections(node, registry, mockViewer);
    expect(sections).toHaveLength(0);
  });

  it('should use default hoverPriority when not specified in capabilities', () => {
    registerCapabilities('CustomType', { tooltipType: 'custom' });

    const registry = new TooltipContentRegistry();
    const node = new Object3D();
    registry.registerDataResolver('custom', () => ({ type: 'custom' }));

    node.userData = {
      realvirtual: { CustomType: { foo: 'bar' } },
    };

    const sections = resolveHoverSections(node, registry, mockViewer);
    expect(sections).toHaveLength(1);
    expect(sections[0].priority).toBe(5); // default
  });
});
