// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for TooltipDataResolver registration and per-type data extraction.
 */

import { describe, it, expect } from 'vitest';
import { TooltipContentRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import type { TooltipDataResolver } from '../src/core/hmi/tooltip/tooltip-registry';
import { Object3D } from 'three';

// Minimal viewer mock
const mockViewer = {
  drives: [] as any[],
  registry: {
    getPathForNode: () => '/Scene/TestNode',
    findInParent: () => null,
  },
} as any;

describe('TooltipDataResolver', () => {
  it('should register and retrieve data resolver', () => {
    const registry = new TooltipContentRegistry();
    const resolver: TooltipDataResolver = () => ({ type: 'test' });
    registry.registerDataResolver('test', resolver);
    expect(registry.getDataResolver('test')).toBe(resolver);
  });

  it('should return null for unregistered content type', () => {
    const registry = new TooltipContentRegistry();
    expect(registry.getDataResolver('unknown')).toBeNull();
  });

  it('should overwrite resolver on re-registration', () => {
    const registry = new TooltipContentRegistry();
    const resolver1: TooltipDataResolver = () => ({ type: 'v1' });
    const resolver2: TooltipDataResolver = () => ({ type: 'v2' });
    registry.registerDataResolver('test', resolver1);
    registry.registerDataResolver('test', resolver2);
    expect(registry.getDataResolver('test')).toBe(resolver2);
  });

  it('drive resolver returns driveName when drive found', () => {
    const node = new Object3D();
    const mockDrive = { name: 'Axis1', node };
    const viewer = { ...mockViewer, drives: [mockDrive] };

    const resolver: TooltipDataResolver = (n, v) => {
      const drive = (v as any).drives.find((d: any) => d.node === n);
      if (!drive) return null;
      return { type: 'drive', driveName: drive.name };
    };

    const result = resolver(node, viewer);
    expect(result).toEqual({ type: 'drive', driveName: 'Axis1' });
  });

  it('drive resolver returns null when no drive on node', () => {
    const node = new Object3D();
    const viewer = { ...mockViewer, drives: [] };

    const resolver: TooltipDataResolver = (n, v) => {
      const drive = (v as any).drives.find((d: any) => d.node === n);
      if (!drive) return null;
      return { type: 'drive', driveName: drive.name };
    };

    expect(resolver(node, viewer)).toBeNull();
  });

  it('aas resolver extracts aasId and description', () => {
    const node = new Object3D();
    node.userData = {
      _rvAasLink: { aasId: 'urn:test:aas:123', description: 'Test Motor' },
    };

    const resolver: TooltipDataResolver = (n) => {
      const aas = n.userData?._rvAasLink as { aasId: string; description: string } | undefined;
      if (!aas?.aasId) return null;
      return { type: 'aas', aasId: aas.aasId, description: aas.description };
    };

    expect(resolver(node, mockViewer)).toEqual({
      type: 'aas',
      aasId: 'urn:test:aas:123',
      description: 'Test Motor',
    });
  });

  it('aas resolver returns null when no aasId', () => {
    const node = new Object3D();
    node.userData = {};

    const resolver: TooltipDataResolver = (n) => {
      const aas = n.userData?._rvAasLink as { aasId: string; description: string } | undefined;
      if (!aas?.aasId) return null;
      return { type: 'aas', aasId: aas.aasId, description: aas.description };
    };

    expect(resolver(node, mockViewer)).toBeNull();
  });

  it('metadata resolver extracts content', () => {
    const node = new Object3D();
    node.userData = {
      _rvMetadata: { content: '<name>Test</name><text>Hello</text>' },
    };

    const resolver: TooltipDataResolver = (n, v) => {
      const meta = n.userData?._rvMetadata as { content: string } | undefined;
      if (!meta?.content) return null;
      const path = (v as any).registry?.getPathForNode(n) ?? '';
      return { type: 'metadata', nodePath: path, content: meta.content };
    };

    expect(resolver(node, mockViewer)).toEqual({
      type: 'metadata',
      nodePath: '/Scene/TestNode',
      content: '<name>Test</name><text>Hello</text>',
    });
  });

  it('pipe resolver returns nodePath', () => {
    const node = new Object3D();

    const resolver: TooltipDataResolver = (_n, v) => {
      const path = (v as any).registry?.getPathForNode(_n) ?? '';
      return path ? { type: 'pipe', nodePath: path } : null;
    };

    expect(resolver(node, mockViewer)).toEqual({
      type: 'pipe',
      nodePath: '/Scene/TestNode',
    });
  });
});
