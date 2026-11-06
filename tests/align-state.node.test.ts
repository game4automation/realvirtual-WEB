// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Planner Align tool store (plan-779): slot flow, close semantics, defaults,
 * liveness, and the lazy-loading boundary of the statically imported files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { Object3D, Vector3, Mesh } from 'three';
import {
  _resetAlignStateForTests,
  alignClose,
  alignOpen,
  armAlignSlot,
  getAlignSnapshot,
  isSlotAlive,
  setAlignHooks,
  setAlignLiveness,
  setAlignOffsetM,
  setAlignSlot,
  type AlignSlot,
} from '../src/plugins/layout-planner/align/align-state';

function slot(root: Object3D | null, mesh = new Mesh()): AlignSlot {
  return { mesh, cornerLocal: new Vector3(), label: 'x', root };
}

beforeEach(() => _resetAlignStateForTests());

describe('align-state slot flow', () => {
  it('open arms A; filling A arms B; filling B disarms', () => {
    alignOpen();
    expect(getAlignSnapshot().armed).toBe('A');
    setAlignSlot('A', slot(new Object3D()));
    expect(getAlignSnapshot().armed).toBe('B');
    setAlignSlot('B', slot(null));
    expect(getAlignSnapshot().armed).toBeNull();
  });

  it('arming a filled slot re-picks it', () => {
    alignOpen();
    setAlignSlot('A', slot(new Object3D()));
    setAlignSlot('B', slot(null));
    armAlignSlot('A');
    expect(getAlignSnapshot().armed).toBe('A');
    expect(getAlignSnapshot().a).not.toBeNull();
  });

  it('a new A whose subtree contains B drops B', () => {
    alignOpen();
    const rootA = new Object3D();
    const meshB = new Mesh();
    rootA.add(meshB);
    setAlignSlot('A', slot(new Object3D()));
    setAlignSlot('B', slot(null, meshB));
    const inside = (n: Object3D, r: Object3D) => { for (let o: Object3D | null = n; o; o = o.parent) if (o === r) return true; return false; };
    setAlignSlot('A', slot(rootA), inside);
    expect(getAlignSnapshot().b).toBeNull();
    expect(getAlignSnapshot().armed).toBe('B');
  });

  it('close clears slots, disarms and runs the close hook exactly once', () => {
    const onClose = vi.fn();
    setAlignHooks({ onClose });
    alignOpen();
    setAlignSlot('A', slot(new Object3D()));
    alignClose();
    alignClose();
    const s = getAlignSnapshot();
    expect(s.open).toBe(false);
    expect(s.a).toBeNull();
    expect(s.armed).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('defaults: axes X/Z on, Y off; offset 0; non-finite offsets become 0', () => {
    const s = getAlignSnapshot();
    expect(s.axes).toEqual({ x: true, y: false, z: true });
    expect(s.offsetM).toEqual({ x: 0, y: 0, z: 0 });
    setAlignOffsetM({ x: NaN, y: Infinity, z: 12 });
    expect(getAlignSnapshot().offsetM).toEqual({ x: 0, y: 0, z: 12 });
  });

  it('liveness callback decides whether a slot is alive', () => {
    const s = slot(new Object3D());
    expect(isSlotAlive(null)).toBe(false);
    expect(isSlotAlive(s)).toBe(true);
    setAlignLiveness(() => false);
    expect(isSlotAlive(s)).toBe(false);
  });
});

describe('align lazy-loading boundary', () => {
  const HEAVY = /align-pick|align-overlay|align-action|AlignPanel(?!Host)/;

  function staticImports(file: string): string[] {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    // preProcessFile lists static imports and dynamic import() separately;
    // only the static ones count against the boundary.
    const info = ts.preProcessFile(src, true, false);
    return info.importedFiles.map((f) => f.fileName);
  }

  function dynamicImports(file: string): string[] {
    const src = readFileSync(resolve(__dirname, '..', file), 'utf8');
    return [...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  }

  for (const file of [
    'src/plugins/layout-planner/align/align-state.ts',
    'src/plugins/layout-planner/align/AlignPanelHost.tsx',
    'src/plugins/layout-planner/PlannerToolbarButtons.tsx',
  ]) {
    it(`${file} has no static import of the heavy align modules`, () => {
      const dyn = new Set(dynamicImports(file));
      const statics = staticImports(file).filter((f) => !dyn.has(f));
      expect(statics.filter((f) => HEAVY.test(f))).toEqual([]);
    });
  }
});
