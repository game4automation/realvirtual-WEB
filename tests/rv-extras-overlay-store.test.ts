// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for rv-extras-overlay-store.ts
 *
 * Validates overlay merge semantics (RFC 7396), localStorage persistence,
 * missing node handling, null-delete, and field query.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadOverlay,
  saveOverlay,
  clearOverlay,
  applyOverlayToNode,
  getOverriddenFields,
  type RVExtrasOverlay,
} from '../src/core/engine/rv-extras-overlay-store';

/** Minimal Object3D-like stub for testing. */
function makeNode(rvData?: Record<string, Record<string, unknown>>): { userData: Record<string, unknown> } {
  const userData: Record<string, unknown> = {};
  if (rvData) {
    userData['realvirtual'] = rvData;
  }
  return { userData };
}

function makeOverlay(
  nodes: Record<string, Record<string, Record<string, unknown>>>,
  source = 'test',
): RVExtrasOverlay {
  return {
    $schema: 'rv-extras-overlay/1.0',
    $source: source,
    nodes,
  };
}

describe('rv-extras-overlay-store', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // ─── TestOverlayMerge ───────────────────────────────────────────────

  it('TestOverlayMerge: partial field update preserves non-overridden fields', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100, Acceleration: 50, UseLimits: true },
    });

    const overlay = makeOverlay({
      'DemoCell/Conveyor1': {
        Drive: { TargetSpeed: 200 },
      },
    });

    const changed = applyOverlayToNode(node as any, 'DemoCell/Conveyor1', overlay);

    expect(changed).toBe(true);
    const rv = node.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(rv['Drive']['TargetSpeed']).toBe(200);
    // Non-overridden fields must be preserved
    expect(rv['Drive']['Acceleration']).toBe(50);
    expect(rv['Drive']['UseLimits']).toBe(true);
  });

  // ─── TestOverlayPersistence ─────────────────────────────────────────

  it('TestOverlayPersistence: localStorage round-trip', () => {
    const overlay = makeOverlay({
      'Robot/Axis1': {
        Drive: { TargetSpeed: 500 },
      },
    });

    saveOverlay('demo.glb', overlay);
    const loaded = loadOverlay('demo.glb');

    expect(loaded).not.toBeNull();
    expect(loaded!.$schema).toBe('rv-extras-overlay/1.0');
    expect(loaded!.nodes['Robot/Axis1']['Drive']['TargetSpeed']).toBe(500);
  });

  it('loadOverlay returns null for missing key', () => {
    const loaded = loadOverlay('nonexistent.glb');
    expect(loaded).toBeNull();
  });

  it('loadOverlay returns null for invalid JSON', () => {
    localStorage.setItem('rv-extras-overlay:bad.glb', '{not valid json');
    const loaded = loadOverlay('bad.glb');
    expect(loaded).toBeNull();
  });

  it('loadOverlay returns null for wrong schema', () => {
    localStorage.setItem(
      'rv-extras-overlay:wrong.glb',
      JSON.stringify({ $schema: 'wrong/1.0', nodes: {} }),
    );
    const loaded = loadOverlay('wrong.glb');
    expect(loaded).toBeNull();
  });

  it('clearOverlay removes from localStorage', () => {
    saveOverlay('demo.glb', makeOverlay({}));
    expect(loadOverlay('demo.glb')).not.toBeNull();
    clearOverlay('demo.glb');
    expect(loadOverlay('demo.glb')).toBeNull();
  });

  // ─── TestOverlayMissingNode ─────────────────────────────────────────

  it('TestOverlayMissingNode: non-existent node path is ignored', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100 },
    });

    const overlay = makeOverlay({
      'SomeOther/Path': {
        Drive: { TargetSpeed: 999 },
      },
    });

    const changed = applyOverlayToNode(node as any, 'DemoCell/Conveyor1', overlay);

    expect(changed).toBe(false);
    const rv = node.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(rv['Drive']['TargetSpeed']).toBe(100);
  });

  // ─── TestOverlayNullDelete ──────────────────────────────────────────

  it('TestOverlayNullDelete: null removes field (RFC 7396)', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100, Acceleration: 50 },
    });

    const overlay = makeOverlay({
      'DemoCell/Conveyor1': {
        Drive: { Acceleration: null as unknown as unknown },
      },
    });

    const changed = applyOverlayToNode(node as any, 'DemoCell/Conveyor1', overlay);

    expect(changed).toBe(true);
    const rv = node.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(rv['Drive']['TargetSpeed']).toBe(100);
    expect('Acceleration' in rv['Drive']).toBe(false);
  });

  it('null delete on non-existent field returns false (no change)', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100 },
    });

    const overlay = makeOverlay({
      'DemoCell/Conveyor1': {
        Drive: { NonExistent: null as unknown as unknown },
      },
    });

    const changed = applyOverlayToNode(node as any, 'DemoCell/Conveyor1', overlay);
    expect(changed).toBe(false);
  });

  // ─── TestGetOverriddenFields ────────────────────────────────────────

  it('TestGetOverriddenFields: returns correct field list', () => {
    const overlay = makeOverlay({
      'DemoCell/Conveyor1': {
        Drive: { TargetSpeed: 200, Acceleration: 75 },
        TransportSurface: { TextureScale: 2.0 },
      },
    });

    const driveFields = getOverriddenFields('DemoCell/Conveyor1', 'Drive', overlay);
    expect(driveFields).toEqual(['TargetSpeed', 'Acceleration']);

    const tsFields = getOverriddenFields('DemoCell/Conveyor1', 'TransportSurface', overlay);
    expect(tsFields).toEqual(['TextureScale']);
  });

  it('getOverriddenFields returns empty for missing node', () => {
    const overlay = makeOverlay({});
    const fields = getOverriddenFields('Missing/Path', 'Drive', overlay);
    expect(fields).toEqual([]);
  });

  it('getOverriddenFields returns empty for missing component', () => {
    const overlay = makeOverlay({
      'DemoCell/Conveyor1': {
        Drive: { TargetSpeed: 200 },
      },
    });
    const fields = getOverriddenFields('DemoCell/Conveyor1', 'Sensor', overlay);
    expect(fields).toEqual([]);
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────

  it('applyOverlayToNode creates userData.realvirtual if missing', () => {
    const node = { userData: {} } as any;

    const overlay = makeOverlay({
      'NewNode': {
        Drive: { TargetSpeed: 300 },
      },
    });

    const changed = applyOverlayToNode(node, 'NewNode', overlay);

    expect(changed).toBe(true);
    const rv = node.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(rv['Drive']['TargetSpeed']).toBe(300);
  });

  it('applyOverlayToNode creates component if missing', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100 },
    });

    const overlay = makeOverlay({
      'Path': {
        Sensor: { UseRaycast: true },
      },
    });

    const changed = applyOverlayToNode(node as any, 'Path', overlay);

    expect(changed).toBe(true);
    const rv = node.userData['realvirtual'] as Record<string, Record<string, unknown>>;
    expect(rv['Sensor']['UseRaycast']).toBe(true);
    // Drive should still be there
    expect(rv['Drive']['TargetSpeed']).toBe(100);
  });

  it('setting same value returns false (no change)', () => {
    const node = makeNode({
      Drive: { TargetSpeed: 100 },
    });

    const overlay = makeOverlay({
      'Path': {
        Drive: { TargetSpeed: 100 },
      },
    });

    const changed = applyOverlayToNode(node as any, 'Path', overlay);
    expect(changed).toBe(false);
  });
});
