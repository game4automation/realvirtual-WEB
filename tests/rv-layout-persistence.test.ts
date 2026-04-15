// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for Layout Persistence — JSON serialization/deserialization of layouts.
 */
import { describe, test, expect } from 'vitest';
import { serializeLayout, deserializeLayout, type PlacedComponent } from '../../realvirtual-WebViewer-Private~/src/plugins/layout-planner';

const testComponents: PlacedComponent[] = [
  { id: 'a1', catalogId: 'belt-1000', glbUrl: 'https://lib.example.com/belt.glb', label: 'Belt 1m', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  { id: 'b2', catalogId: 'ur10', glbUrl: 'https://lib.example.com/ur10.glb', label: 'UR10 Robot', position: [500, 0, 200], rotation: [0, 90, 0], scale: [1, 1, 1] },
];

describe('Layout Persistence', () => {
  test('serializeLayout produces valid LayoutFile JSON', () => {
    const layout = serializeLayout('Test Layout', testComponents, ['https://lib.example.com/catalog.json'], 500);
    expect(layout.version).toBe('1.0');
    expect(layout.name).toBe('Test Layout');
    expect(layout.catalogUrls).toEqual(['https://lib.example.com/catalog.json']);
    expect(layout.gridSizeMm).toBe(500);
    expect(layout.components).toHaveLength(2);
    expect(layout.createdAt).toBeDefined();
  });

  test('deserializeLayout restores all components', () => {
    const json = JSON.stringify({
      version: '1.0', name: 'Test', createdAt: '2026-03-28T00:00:00Z',
      catalogUrls: ['https://lib.example.com/catalog.json'], gridSizeMm: 500,
      components: testComponents,
    });
    const result = deserializeLayout(json);
    expect(result.components).toHaveLength(2);
    expect(result.components[0].catalogId).toBe('belt-1000');
    expect(result.components[1].glbUrl).toBe('https://lib.example.com/ur10.glb');
  });

  test('round-trip preserves all data', () => {
    const layout = serializeLayout('Round Trip', testComponents, ['https://lib.example.com/catalog.json'], 500);
    const json = JSON.stringify(layout);
    const restored = deserializeLayout(json);
    expect(restored.components).toEqual(testComponents);
    expect(restored.name).toBe('Round Trip');
    expect(restored.gridSizeMm).toBe(500);
  });

  test('deserializeLayout handles empty components array', () => {
    const json = JSON.stringify({ version: '1.0', name: 'Empty', createdAt: '', catalogUrls: [], gridSizeMm: 500, components: [] });
    const result = deserializeLayout(json);
    expect(result.components).toHaveLength(0);
  });

  test('deserializeLayout throws on invalid JSON', () => {
    expect(() => deserializeLayout('not-json')).toThrow();
  });
});
