// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, test, expect } from 'vitest';
import {
  assetOpHeader,
  dedupeComponentKey,
  canCoalesceAssetOps,
  mergeAssetOps,
  describeAssetOp,
  type AssetSetFieldOp,
  type TransformNodeOp,
  type ImportCadOp,
  type SetNodeVisibleOp,
} from '../src/core/editor/rv-asset-ops';

function setFieldOp(overrides: Partial<AssetSetFieldOp> = {}): AssetSetFieldOp {
  return {
    ...assetOpHeader(),
    kind: 'setField',
    nodePath: 'Root/Node',
    componentType: 'Drive',
    fieldName: 'TargetSpeed',
    value: 100,
    prev: 50,
    ...overrides,
  };
}

describe('dedupeComponentKey', () => {
  test('returns base type on empty node', () => {
    expect(dedupeComponentKey(undefined, 'Drive')).toBe('Drive');
    expect(dedupeComponentKey({}, 'Drive')).toBe('Drive');
  });

  test('suffixes _N against existing keys (loader convention)', () => {
    expect(dedupeComponentKey({ Drive: {} }, 'Drive')).toBe('Drive_1');
    expect(dedupeComponentKey({ Drive: {}, Drive_1: {} }, 'Drive')).toBe('Drive_2');
    expect(dedupeComponentKey({ PLCOutputBool: {}, PLCOutputBool_1: {} }, 'PLCOutputBool')).toBe('PLCOutputBool_2');
  });
});

describe('coalescing', () => {
  test('same-target setField ops coalesce; merged op keeps first prev, last value', () => {
    const a = setFieldOp({ value: 60 });
    const b = setFieldOp({ value: 70, ts: a.ts + 100 });
    expect(canCoalesceAssetOps(a, b)).toBe(true);
    const merged = mergeAssetOps(a, b) as AssetSetFieldOp;
    expect(merged.id).toBe(a.id);
    expect(merged.prev).toBe(50);
    expect(merged.value).toBe(70);
  });

  test('different field / node / outside window do not coalesce', () => {
    const a = setFieldOp();
    expect(canCoalesceAssetOps(a, setFieldOp({ fieldName: 'Acceleration', ts: a.ts + 10 }))).toBe(false);
    expect(canCoalesceAssetOps(a, setFieldOp({ nodePath: 'Root/Other', ts: a.ts + 10 }))).toBe(false);
    expect(canCoalesceAssetOps(a, setFieldOp({ ts: a.ts + 10_000 }))).toBe(false);
  });

  test('transformNode coalesces per node (drag stream)', () => {
    const t = (ts: number, x: number): TransformNodeOp => ({
      ...assetOpHeader(), ts,
      kind: 'transformNode', nodePath: 'Root/Node',
      transform: { position: [x, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      prev: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    const a = t(1000, 1);
    const b = t(1100, 2);
    expect(canCoalesceAssetOps(a, b)).toBe(true);
    const merged = mergeAssetOps(a, b) as TransformNodeOp;
    expect(merged.transform.position[0]).toBe(2);
    expect(merged.prev.position[0]).toBe(0);
  });

  test('structural ops never coalesce', () => {
    const imp: ImportCadOp = {
      ...assetOpHeader(),
      kind: 'importCad', rootPath: 'Root/Gearbox',
      cadlink: { File: 'gearbox.step', Sha256: 'abc', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true },
      transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
    };
    expect(canCoalesceAssetOps(imp, { ...imp, ...assetOpHeader() })).toBe(false);
  });

  test('setNodeVisible never coalesces — each toggle is a discrete undo step', () => {
    const vis = (visible: boolean, ts: number): SetNodeVisibleOp => ({
      ...assetOpHeader(), ts,
      kind: 'setNodeVisible', nodePath: 'Root/Node', visible, prev: !visible,
    });
    // Same node, well inside the coalesce window — still no merge.
    expect(canCoalesceAssetOps(vis(false, 1000), vis(true, 1050))).toBe(false);
    expect(canCoalesceAssetOps(vis(false, 1000), vis(false, 1050))).toBe(false);
  });
});

describe('describeAssetOp', () => {
  test('produces readable labels', () => {
    expect(describeAssetOp(setFieldOp())).toContain('Drive.TargetSpeed');
    expect(describeAssetOp({
      ...assetOpHeader(), kind: 'addComponent', nodePath: 'Root/Node',
      componentType: 'Sensor', fields: {},
    })).toBe('Add Sensor to Node');
  });

  test('setNodeVisible labels reflect direction', () => {
    const base = { ...assetOpHeader(), kind: 'setNodeVisible' as const, nodePath: 'Root/Housing' };
    expect(describeAssetOp({ ...base, visible: false, prev: true })).toBe('Hide Housing');
    expect(describeAssetOp({ ...base, visible: true, prev: false })).toBe('Show Housing');
  });
});
