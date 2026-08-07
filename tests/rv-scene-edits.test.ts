// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for the pure operation-log helpers in rv-scene-edits.ts:
 *   - materialise() determinism + composite flattening + tolerant transforms
 *   - canCoalesce() / mergeOps() rules across kinds
 *   - describeOp() label formatting
 *   - inverseOp() round-trips
 *   - opsEqual() identity semantics
 *   - freshOpId() stability properties
 */

import { describe, it, expect } from 'vitest';
import {
  type EditOp,
  type SetFieldOp,
  type AddPlacementOp,
  type RemovePlacementOp,
  type TransformPlacementOp,
  type SetCameraOp,
  type CompositeOp,
  type UnsetFieldOp,
  type PrimitiveEditOp,
  COALESCE_WINDOW_MS,
  MAX_OP_HISTORY,
  freshOpId,
  materialise,
  canCoalesce,
  mergeOps,
  describeOp,
  inverseOp,
  opsEqual,
  deepCloneJSON,
} from '../src/core/hmi/scene/rv-scene-edits';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

// ─── Builders ────────────────────────────────────────────────────────────

function setField(
  nodePath: string, comp: string, field: string, value: unknown, prev: unknown,
  ts = 1000,
): SetFieldOp {
  return {
    id: freshOpId(), ts, schemaV: 1,
    kind: 'setField', nodePath, componentType: comp, fieldName: field, value, prev,
  };
}

function unsetField(nodePath: string, comp: string, field: string, prev: unknown, ts = 1000): UnsetFieldOp {
  return {
    id: freshOpId(), ts, schemaV: 1,
    kind: 'unsetField', nodePath, componentType: comp, fieldName: field, prev,
  };
}

function placement(id: string, label = 'X'): PlacedComponent {
  return {
    id, catalogId: 'cat-x', glbUrl: '/models/x.glb', label,
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  };
}

function addP(p: PlacedComponent, ts = 1000): AddPlacementOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'addPlacement', placement: p };
}

function removeP(p: PlacedComponent, ts = 1000): RemovePlacementOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'removePlacement', placementId: p.id, placement: p };
}

function transformP(
  placementId: string,
  pos: [number, number, number],
  rot: [number, number, number] = [0, 0, 0],
  scl: [number, number, number] = [1, 1, 1],
  prev: TransformPlacementOp['prev'] = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  ts = 1000,
): TransformPlacementOp {
  return {
    id: freshOpId(), ts, schemaV: 1,
    kind: 'transformPlacement', placementId, position: pos, rotation: rot, scale: scl, prev,
  };
}

function setCamera(preset: { px: number; py: number; pz: number; tx: number; ty: number; tz: number } | null,
                   prev: typeof preset = null, ts = 1000): SetCameraOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'setCamera', preset, prev };
}

function composite(label: string, ops: PrimitiveEditOp[], ts = 1000): CompositeOp {
  return { id: freshOpId(), ts, schemaV: 1, kind: 'composite', label, ops };
}

// ─── freshOpId ───────────────────────────────────────────────────────────

describe('freshOpId', () => {
  it('starts with op_ prefix', () => {
    expect(freshOpId()).toMatch(/^op_[a-z0-9]+_[a-z0-9]+$/);
  });
  it('produces unique ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(freshOpId());
    expect(seen.size).toBe(100);
  });
});

// ─── materialise ─────────────────────────────────────────────────────────

describe('materialise', () => {
  it('empty ops → empty buffers', () => {
    const m = materialise([]);
    expect(m.overlay.nodes).toEqual({});
    expect(m.placements).toEqual([]);
    expect(m.cameraStart).toBeNull();
  });

  it('setField writes into overlay.nodes[path][type][field]', () => {
    const m = materialise([setField('Conv1', 'Drive', 'TargetSpeed', 250, 100)]);
    expect(m.overlay.nodes['Conv1'].Drive.TargetSpeed).toBe(250);
  });

  it('unsetField clears the override and prunes empty containers', () => {
    const ops: EditOp[] = [
      setField('Conv1', 'Drive', 'TargetSpeed', 250, 100),
      setField('Conv1', 'Drive', 'Acceleration', 50, 100),
      unsetField('Conv1', 'Drive', 'TargetSpeed', 250),
    ];
    const m = materialise(ops);
    expect(m.overlay.nodes['Conv1'].Drive.TargetSpeed).toBeUndefined();
    expect(m.overlay.nodes['Conv1'].Drive.Acceleration).toBe(50);
  });

  it('unsetField on the LAST field on a node prunes node entry entirely', () => {
    const ops: EditOp[] = [
      setField('Conv1', 'Drive', 'TargetSpeed', 250, 100),
      unsetField('Conv1', 'Drive', 'TargetSpeed', 250),
    ];
    const m = materialise(ops);
    expect(m.overlay.nodes['Conv1']).toBeUndefined();
  });

  it('addPlacement adds to placements; removePlacement removes by id', () => {
    const a = placement('p1');
    const m = materialise([addP(a), removeP(a)]);
    expect(m.placements).toEqual([]);
  });

  it('transformPlacement updates position/rotation/scale', () => {
    const a = placement('p1');
    const m = materialise([
      addP(a),
      transformP('p1', [10, 0, 5], [0, 1.5, 0]),
    ]);
    expect(m.placements[0].position).toEqual([10, 0, 5]);
    expect(m.placements[0].rotation).toEqual([0, 1.5, 0]);
  });

  it('transformPlacement on a missing id is tolerated (skipped)', () => {
    const m = materialise([transformP('does-not-exist', [1, 2, 3])]);
    expect(m.placements).toEqual([]);
  });

  it('setCamera last-write-wins', () => {
    const a = { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 };
    const b = { px: 7, py: 8, pz: 9, tx: 1, ty: 1, tz: 1 };
    const m = materialise([setCamera(a), setCamera(b)]);
    expect(m.cameraStart).toEqual(b);
  });

  it('composite ops are flattened in apply order', () => {
    const ops: EditOp[] = [
      composite('Reset Drive', [
        setField('Conv1', 'Drive', 'TargetSpeed', 100, 100),
        setField('Conv1', 'Drive', 'Acceleration', 25, 25),
      ]),
    ];
    const m = materialise(ops);
    expect(m.overlay.nodes['Conv1'].Drive.TargetSpeed).toBe(100);
    expect(m.overlay.nodes['Conv1'].Drive.Acceleration).toBe(25);
  });

  it('determinism: same op array produces structurally-equal output across calls', () => {
    const ops: EditOp[] = [
      setField('Conv1', 'Drive', 'TargetSpeed', 250, 100),
      addP(placement('p1', 'A')),
      transformP('p1', [1, 2, 3]),
    ];
    const m1 = materialise(ops);
    const m2 = materialise(ops);
    expect(JSON.stringify(m1)).toBe(JSON.stringify(m2));
  });
});

// ─── canCoalesce / mergeOps ─────────────────────────────────────────────

describe('canCoalesce', () => {
  it('coalesces same-target setField inside the window', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = setField('Conv1', 'Drive', 'TargetSpeed', 250, 200, 1100);
    expect(canCoalesce(a, b)).toBe(true);
  });

  it('does NOT coalesce when window is exceeded', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = setField('Conv1', 'Drive', 'TargetSpeed', 250, 200, 1000 + COALESCE_WINDOW_MS + 1);
    expect(canCoalesce(a, b)).toBe(false);
  });

  it('does NOT coalesce different fields', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = setField('Conv1', 'Drive', 'Acceleration', 50, 25, 1100);
    expect(canCoalesce(a, b)).toBe(false);
  });

  it('does NOT coalesce different node paths', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = setField('Conv2', 'Drive', 'TargetSpeed', 200, 100, 1100);
    expect(canCoalesce(a, b)).toBe(false);
  });

  it('does NOT coalesce different kinds', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = unsetField('Conv1', 'Drive', 'TargetSpeed', 200, 1100);
    expect(canCoalesce(a, b)).toBe(false);
  });

  it('coalesces transformPlacement on same id', () => {
    const a = transformP('p1', [1, 0, 0], [0, 0, 0], [1, 1, 1],
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 1000);
    const b = transformP('p1', [2, 0, 0], [0, 0, 0], [1, 1, 1],
      { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 1100);
    expect(canCoalesce(a, b)).toBe(true);
  });

  it('does NOT coalesce add/removePlacement', () => {
    const p = placement('p1');
    expect(canCoalesce(addP(p, 1000), addP(p, 1100))).toBe(false);
    expect(canCoalesce(removeP(p, 1000), removeP(p, 1100))).toBe(false);
  });

  it('does NOT coalesce composites', () => {
    const a = composite('A', [setField('n', 'c', 'f', 1, 0)], 1000);
    const b = setField('n', 'c', 'f', 2, 1, 1100);
    expect(canCoalesce(a, b)).toBe(false);
    expect(canCoalesce(b, a)).toBe(false);
  });
});

describe('mergeOps', () => {
  it('setField merge keeps original prev, adopts new value', () => {
    const a = setField('Conv1', 'Drive', 'TargetSpeed', 200, 100, 1000);
    const b = setField('Conv1', 'Drive', 'TargetSpeed', 250, 200, 1100);
    const merged = mergeOps(a, b) as SetFieldOp;
    expect(merged.value).toBe(250);
    expect(merged.prev).toBe(100);
    expect(merged.id).toBe(a.id);
    expect(merged.ts).toBe(a.ts);
  });

  it('transformPlacement merge keeps original prev pose, adopts new pose', () => {
    const a = transformP('p1', [1, 0, 0], [0, 0, 0], [1, 1, 1],
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 1000);
    const b = transformP('p1', [5, 0, 0], [0, 0, 0], [1, 1, 1],
      { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, 1100);
    const merged = mergeOps(a, b) as TransformPlacementOp;
    expect(merged.position).toEqual([5, 0, 0]);
    expect(merged.prev.position).toEqual([0, 0, 0]);
  });
});

// ─── describeOp ─────────────────────────────────────────────────────────

describe('describeOp', () => {
  it('formats setField with leaf node + value', () => {
    expect(describeOp(setField('Robot/Cell/Conv1', 'Drive', 'TargetSpeed', 250, 100)))
      .toBe('Set Drive.TargetSpeed = 250 on Conv1');
  });
  it('formats float values trimmed', () => {
    expect(describeOp(setField('A', 'C', 'F', 1.5, 0)))
      .toBe('Set C.F = 1.5 on A');
  });
  it('formats string values quoted', () => {
    expect(describeOp(setField('A', 'C', 'F', 'hello', '')))
      .toBe('Set C.F = "hello" on A');
  });
  it('formats unsetField', () => {
    expect(describeOp(unsetField('A/B', 'Drive', 'X', 1)))
      .toBe('Reset Drive.X on B');
  });
  it('formats add/remove placement', () => {
    expect(describeOp(addP(placement('p1', 'My Robot')))).toBe('Add My Robot');
    expect(describeOp(removeP(placement('p1', 'My Robot')))).toBe('Remove My Robot');
  });
  it('formats setCamera', () => {
    expect(describeOp(setCamera({ px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 })))
      .toBe('Set camera view');
    expect(describeOp(setCamera(null))).toBe('Clear camera view');
  });
  it('formats composite using its label', () => {
    expect(describeOp(composite('Reset Drive', [setField('A', 'B', 'C', 0, 1)])))
      .toBe('Reset Drive');
  });
});

// ─── inverseOp ──────────────────────────────────────────────────────────

describe('inverseOp', () => {
  it('setField → setField with swapped value/prev', () => {
    const op = setField('A', 'B', 'C', 200, 100);
    const inv = inverseOp(op) as SetFieldOp;
    expect(inv.kind).toBe('setField');
    expect(inv.value).toBe(100);
    expect(inv.prev).toBe(200);
  });
  it('setField with prev=undefined inverts to unsetField', () => {
    const op = setField('A', 'B', 'C', 200, undefined);
    const inv = inverseOp(op);
    expect(inv.kind).toBe('unsetField');
  });
  it('addPlacement → removePlacement carrying same id + snapshot', () => {
    const p = placement('p1');
    const inv = inverseOp(addP(p)) as RemovePlacementOp;
    expect(inv.kind).toBe('removePlacement');
    expect(inv.placementId).toBe('p1');
  });
  it('removePlacement → addPlacement', () => {
    const p = placement('p1');
    const inv = inverseOp(removeP(p)) as AddPlacementOp;
    expect(inv.kind).toBe('addPlacement');
    expect(inv.placement.id).toBe('p1');
  });
  it('transformPlacement → swapped pose', () => {
    const op = transformP('p1', [5, 0, 0], [0, 1, 0], [1, 1, 1],
      { position: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    const inv = inverseOp(op) as TransformPlacementOp;
    expect(inv.position).toEqual([1, 0, 0]);
    expect(inv.prev.position).toEqual([5, 0, 0]);
  });
  it('setCamera → swapped preset/prev', () => {
    const a = { px: 1, py: 2, pz: 3, tx: 0, ty: 0, tz: 0 };
    const b = { px: 7, py: 8, pz: 9, tx: 1, ty: 1, tz: 1 };
    const inv = inverseOp(setCamera(b, a)) as SetCameraOp;
    expect(inv.preset).toEqual(a);
    expect(inv.prev).toEqual(b);
  });
  it('composite → reversed children, each inverted', () => {
    const op = composite('Reset', [
      setField('A', 'B', 'F1', 10, 1),
      setField('A', 'B', 'F2', 20, 2),
    ]);
    const inv = inverseOp(op) as CompositeOp;
    expect(inv.kind).toBe('composite');
    expect(inv.ops.length).toBe(2);
    // Reversed: F2 inverse first, then F1 inverse
    expect((inv.ops[0] as SetFieldOp).fieldName).toBe('F2');
    expect((inv.ops[0] as SetFieldOp).value).toBe(2);
    expect((inv.ops[1] as SetFieldOp).fieldName).toBe('F1');
    expect((inv.ops[1] as SetFieldOp).value).toBe(1);
  });

  it('forward then inverse round-trip leaves materialised state unchanged', () => {
    const baseline = materialise([setField('A', 'D', 'X', 50, 10)]);
    const op = setField('A', 'D', 'X', 99, 50);
    const after = materialise([setField('A', 'D', 'X', 50, 10), op, inverseOp(op)]);
    expect(JSON.stringify(after)).toBe(JSON.stringify(baseline));
  });
});

// ─── opsEqual ───────────────────────────────────────────────────────────

describe('opsEqual', () => {
  it('two empty arrays are equal', () => {
    expect(opsEqual([], [])).toBe(true);
  });
  it('different lengths not equal', () => {
    const a = setField('N', 'C', 'F', 1, 0);
    expect(opsEqual([a], [])).toBe(false);
  });
  it('same id sequence is equal', () => {
    const a = setField('N', 'C', 'F', 1, 0);
    const b = setField('N', 'C', 'F', 2, 1);
    expect(opsEqual([a, b], [a, b])).toBe(true);
  });
  it('different ids at same position not equal', () => {
    const a = setField('N', 'C', 'F', 1, 0);
    const a2 = setField('N', 'C', 'F', 1, 0);  // different id
    expect(opsEqual([a], [a2])).toBe(false);
  });
});

// ─── Constants ──────────────────────────────────────────────────────────

describe('constants', () => {
  it('MAX_OP_HISTORY is generous', () => {
    expect(MAX_OP_HISTORY).toBeGreaterThanOrEqual(100);
  });
  it('COALESCE_WINDOW_MS is sensible', () => {
    expect(COALESCE_WINDOW_MS).toBeGreaterThan(100);
    expect(COALESCE_WINDOW_MS).toBeLessThan(2000);
  });
});

// ─── deepCloneJSON ──────────────────────────────────────────────────────

describe('deepCloneJSON', () => {
  it('returns the same primitive', () => {
    expect(deepCloneJSON(42)).toBe(42);
    expect(deepCloneJSON(null)).toBe(null);
    expect(deepCloneJSON('x')).toBe('x');
  });
  it('clones arrays deeply', () => {
    const a: number[][] = [[1, 2], [3, 4]];
    const b = deepCloneJSON(a);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);
    expect(b[0]).not.toBe(a[0]);
  });
  it('clones objects deeply', () => {
    const a = { x: { y: 1 } };
    const b = deepCloneJSON(a);
    expect(b).toEqual(a);
    expect(b.x).not.toBe(a.x);
  });
});

// ─── setNodeTransform ───────────────────────────────────────────────────

describe('setNodeTransform', () => {
  const P0: [number, number, number] = [0, 0, 0];
  const Q0: [number, number, number, number] = [0, 0, 0, 1];

  function transformN(
    nodePath: string,
    pos: [number, number, number],
    quat: [number, number, number, number] = Q0,
    prev: { position: [number, number, number]; quaternion: [number, number, number, number] } = { position: P0, quaternion: Q0 },
    ts = 1000,
  ) {
    return {
      id: freshOpId(), ts, schemaV: 1 as const,
      kind: 'setNodeTransform' as const, nodePath, position: pos, quaternion: quat, prev,
    };
  }

  function addNodeOp(nodePath: string, ts = 1000) {
    return {
      id: freshOpId(), ts, schemaV: 1 as const, kind: 'addNode' as const, nodePath,
      spec: {
        parentPath: nodePath.slice(0, nodePath.lastIndexOf('/')),
        name: nodePath.slice(nodePath.lastIndexOf('/') + 1),
        position: P0, quaternion: Q0, scale: [1, 1, 1] as [number, number, number],
        components: { IKTarget: {} },
      },
    };
  }

  it('materialises a base-GLB node transform (last write wins)', () => {
    const m = materialise([
      transformN('Robot/Path/T1', [1, 2, 3]),
      transformN('Robot/Path/T1', [4, 5, 6], [0, 0.707, 0, 0.707]),
    ]);
    expect(m.nodeTransforms).toHaveLength(1);
    expect(m.nodeTransforms[0]).toEqual({
      nodePath: 'Robot/Path/T1',
      position: [4, 5, 6],
      quaternion: [0, 0.707, 0, 0.707],
    });
  });

  it('folds a transform for an op-created node into its addNode spec', () => {
    const m = materialise([
      addNodeOp('Robot/Path/New1'),
      transformN('Robot/Path/New1', [7, 8, 9]),
    ]);
    expect(m.nodeTransforms).toHaveLength(0); // NOT in the loader-side pass
    expect(m.addedNodes).toHaveLength(1);
    expect(m.addedNodes[0].spec.position).toEqual([7, 8, 9]);
  });

  it('drops a pending transform when the node is removed', () => {
    const add = addNodeOp('Robot/Path/New1');
    const m = materialise([
      transformN('Robot/Path/Orig', [1, 1, 1]),
      add,
      { id: freshOpId(), ts: 1001, schemaV: 1 as const, kind: 'removeNode' as const, nodePath: 'Robot/Path/Orig', spec: add.spec },
    ]);
    expect(m.nodeTransforms).toHaveLength(0);
  });

  it('inverseOp swaps transform and prev', () => {
    const op = transformN('Robot/Path/T1', [1, 2, 3], [0, 1, 0, 0], { position: [9, 9, 9], quaternion: Q0 });
    const inv = inverseOp(op);
    expect(inv.kind).toBe('setNodeTransform');
    if (inv.kind === 'setNodeTransform') {
      expect(inv.position).toEqual([9, 9, 9]);
      expect(inv.quaternion).toEqual(Q0);
      expect(inv.prev.position).toEqual([1, 2, 3]);
      expect(inv.prev.quaternion).toEqual([0, 1, 0, 0]);
    }
  });

  it('coalesces consecutive transforms of the same node only', () => {
    const a = transformN('Robot/Path/T1', [1, 0, 0], Q0, { position: P0, quaternion: Q0 }, 1000);
    const b = transformN('Robot/Path/T1', [2, 0, 0], Q0, { position: [1, 0, 0], quaternion: Q0 }, 1100);
    const c = transformN('Robot/Path/T2', [3, 0, 0], Q0, { position: P0, quaternion: Q0 }, 1150);
    expect(canCoalesce(a, b)).toBe(true);
    expect(canCoalesce(a, c)).toBe(false);
    const merged = mergeOps(a, b);
    expect(merged.kind).toBe('setNodeTransform');
    if (merged.kind === 'setNodeTransform') {
      expect(merged.position).toEqual([2, 0, 0]); // next payload
      expect(merged.prev.position).toEqual(P0);   // first prev survives
      expect(merged.id).toBe(a.id);
    }
  });

  it('describes the op with the node leaf name', () => {
    expect(describeOp(transformN('Robot/Path/T1', [1, 2, 3]))).toBe('Move T1');
  });
});
