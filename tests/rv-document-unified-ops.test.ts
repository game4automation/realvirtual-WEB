// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-703 §9.1 — `RvDocument` over the unified op union.
 *
 * Every kind of the union: apply -> undo -> redo -> the executor-visible state
 * and the op-log snapshot are identical to the state right after the first
 * apply. Plus the document machinery both legacy classes each carried once:
 * single-flight queue, coalescing (window AND no intervening foreign op),
 * transactions with rollback, the undo floor, the history cap, derived dirty.
 *
 * The executor here is a RECORDING STUB, on purpose. This file tests the
 * DOCUMENT; the live-scene semantics of the ops are pinned against the real
 * executors in `rv-op-semantics-pinning.test.ts`. A stub is what makes the
 * "every kind" sweep possible at all (mergeMesh/importCad would otherwise need
 * real geometry and a CAD cache) — and it keeps the file renderer-free.
 */
import { describe, it, expect } from 'vitest';
import { allKindFixtures } from './helpers/rv-op-fixtures';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvExecutor } from '../src/core/ops/rv-unified-executors';
import { RV_OP_KINDS, type RvOp, type RvSetFieldOp } from '../src/core/ops/rv-unified-ops';
import { COALESCE_WINDOW_MS, MAX_OP_HISTORY } from '../src/core/ops/rv-op-utils';

/** Executor stub: keeps a net application count per op id + an ordered trace. */
class RecordingExecutor implements RvExecutor {
  readonly trace: string[] = [];
  readonly net = new Map<string, number>();
  /** Op ids that should reject on forward. */
  failForward = new Set<string>();
  disposed = false;

  // Composites fan out exactly like RvUnifiedExecutor: forward in order,
  // inverse in reverse. Without that a composite undo would be a no-op here and
  // the test would pass for the wrong reason.
  async applyForward(op: RvOp): Promise<void> {
    if (op.kind === 'composite') {
      for (const child of op.ops) await this.applyForward(child);
      return;
    }
    if (this.failForward.has(op.id)) throw new Error('forward refused: ' + op.id);
    this.trace.push('+' + op.id);
    this.net.set(op.id, (this.net.get(op.id) ?? 0) + 1);
  }

  async applyInverse(op: RvOp): Promise<void> {
    if (op.kind === 'composite') {
      for (let i = op.ops.length - 1; i >= 0; i--) await this.applyInverse(op.ops[i]);
      return;
    }
    this.trace.push('-' + op.id);
    this.net.set(op.id, (this.net.get(op.id) ?? 0) - 1);
  }

  dispose(): void { this.disposed = true; }

  /** The executor-visible state: which ops are currently applied. */
  state(): string[] {
    return [...this.net.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort();
  }
}

function makeDoc(opts?: { baselineFloor?: number; mode?: 'scene' | 'asset' }) {
  const executor = new RecordingExecutor();
  const doc = new RvDocument({
    id: 'doc_1',
    name: 'Untitled',
    mode: opts?.mode ?? 'asset',
    executor,
    baselineFloor: opts?.baselineFloor,
  });
  return { doc, executor };
}

// ══════════════════════════════════════════════════════════════════════
// Every kind: apply -> undo -> redo is a fixed point
// ══════════════════════════════════════════════════════════════════════

describe('RvDocument — apply/undo/redo round-trip for every op kind', () => {
  it('has a fixture for every kind in the union (a new kind fails here first)', () => {
    const covered = allKindFixtures().map((op) => op.kind).slice().sort();
    expect(covered).toEqual(RV_OP_KINDS.slice().sort());
  });

  for (const fixture of allKindFixtures()) {
    it(`${fixture.kind}: apply -> undo -> redo restores the exact state`, async () => {
      const { doc, executor } = makeDoc();

      await doc.applyOp(fixture);
      const stateAfterApply = executor.state();
      const logAfterApply = doc.ops.map((o) => o.id);
      // A composite reaches the executor through its children, so the id that
      // shows up in the state is the child's — hence "non-empty", not "=== id".
      expect(stateAfterApply.length).toBeGreaterThan(0);
      expect(logAfterApply).toEqual([fixture.id]);
      expect(doc.canUndo()).toBe(true);
      expect(doc.dirty).toBe(true);

      await doc.undo();
      expect(executor.state()).toEqual([]);
      expect(doc.canUndo()).toBe(false);
      expect(doc.canRedo()).toBe(true);

      await doc.redo();
      expect(executor.state()).toEqual(stateAfterApply);
      expect(doc.ops.map((o) => o.id)).toEqual(logAfterApply);
      expect(doc.canRedo()).toBe(false);
      doc.dispose();
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// Coalescing
// ══════════════════════════════════════════════════════════════════════

describe('RvDocument — coalescing', () => {
  const setField = (
    id: string, ts: number, value: number, fieldName = 'TargetSpeed',
  ): RvSetFieldOp => ({
    id, ts, schemaV: 1, kind: 'setField',
    nodePath: 'A/B', componentType: 'Drive', fieldName, value, prev: 0,
  });

  it('merges same-target ops inside the window into ONE history entry', async () => {
    const { doc } = makeDoc();
    await doc.applyOp(setField('op_a', 1000, 10));
    await doc.applyOp(setField('op_b', 1100, 20));
    expect(doc.opCount).toBe(1);
    // The merged op keeps the FIRST id (and therefore the first `prev`), so one
    // undo reverts the whole run.
    expect(doc.ops[0].id).toBe('op_a');
    expect((doc.ops[0] as { value: number }).value).toBe(20);
    doc.dispose();
  });

  it('does NOT merge outside the coalescing window', async () => {
    const { doc } = makeDoc();
    await doc.applyOp(setField('op_a', 1000, 10));
    await doc.applyOp(setField('op_b', 1000 + COALESCE_WINDOW_MS + 1, 20));
    expect(doc.opCount).toBe(2);
    doc.dispose();
  });

  it('does NOT merge across an intervening foreign op', async () => {
    const { doc } = makeDoc();
    await doc.applyOp(setField('op_a', 1000, 10));
    await doc.applyOp({
      id: 'op_x', ts: 1010, schemaV: 1, kind: 'renameNode',
      nodePath: 'A/B', name: 'C', prevName: 'B',
    });
    await doc.applyOp(setField('op_b', 1020, 20));
    expect(doc.opCount).toBe(3);
    doc.dispose();
  });

  it('does NOT merge a different target inside the window', async () => {
    const { doc } = makeDoc();
    await doc.applyOp(setField('op_a', 1000, 10));
    await doc.applyOp(setField('op_b', 1010, 20, 'Acceleration'));
    expect(doc.opCount).toBe(2);
    doc.dispose();
  });

  it('never coalesces INTO a protected baseline op (the stricter scene rule)', async () => {
    const { doc } = makeDoc();
    // Seed a baseline op, then declare it the floor.
    await doc.replayOps([setField('op_base', 1000, 5)]);
    doc.markSaved({ floor: 1 });
    expect(doc.canUndo()).toBe(false);

    await doc.applyOp(setField('op_a', 1050, 10));
    // Would have coalesced by window+target, but the head IS the baseline.
    expect(doc.opCount).toBe(2);
    expect(doc.canUndo()).toBe(true);
    doc.dispose();
  });

  it('never coalesces structural ops', async () => {
    const { doc } = makeDoc();
    const del = (id: string, ts: number): RvOp => ({
      id, ts, schemaV: 1, kind: 'deleteNode', nodePath: 'A/B',
    });
    await doc.applyOp(del('op_a', 1000));
    await doc.applyOp(del('op_b', 1010));
    expect(doc.opCount).toBe(2);
    doc.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Transactions
// ══════════════════════════════════════════════════════════════════════

describe('RvDocument — transactions', () => {
  const op = (id: string): RvOp => ({
    id, ts: 1000, schemaV: 1, kind: 'setNodeVisible',
    nodePath: 'A/' + id, visible: false, prev: true,
  });

  it('collects into ONE composite undo unit', async () => {
    const { doc, executor } = makeDoc();
    await doc.withTransaction('Bulk hide', async () => {
      await doc.applyOp(op('op_1'));
      await doc.applyOp(op('op_2'));
      await doc.applyOp(op('op_3'));
    });
    expect(doc.opCount).toBe(1);
    expect(doc.ops[0].kind).toBe('composite');
    expect((doc.ops[0] as { ops: RvOp[] }).ops.map((o) => o.id)).toEqual(['op_1', 'op_2', 'op_3']);
    expect(executor.state()).toEqual(['op_1', 'op_2', 'op_3']);

    await doc.undo();
    expect(executor.state()).toEqual([]);
    // Inverse runs in REVERSE order.
    expect(executor.trace.slice(-3)).toEqual(['-op_3', '-op_2', '-op_1']);
    doc.dispose();
  });

  it('is re-entrant — a nested transaction folds into the outer one', async () => {
    const { doc } = makeDoc();
    await doc.withTransaction('Outer', async () => {
      await doc.applyOp(op('op_1'));
      await doc.withTransaction('Inner', async () => {
        await doc.applyOp(op('op_2'));
      });
      await doc.applyOp(op('op_3'));
    });
    expect(doc.opCount).toBe(1);
    expect((doc.ops[0] as { label: string }).label).toBe('Outer');
    expect((doc.ops[0] as { ops: RvOp[] }).ops).toHaveLength(3);
    doc.dispose();
  });

  it('is ALL-OR-NOTHING: a throwing body rolls back and records nothing', async () => {
    const { doc, executor } = makeDoc();
    await expect(doc.withTransaction('Bulk', async () => {
      await doc.applyOp(op('op_1'));
      await doc.applyOp(op('op_2'));
      throw new Error('boom');
    })).rejects.toThrow('boom');

    expect(doc.opCount).toBe(0);
    expect(doc.dirty).toBe(false);
    expect(executor.state()).toEqual([]); // the scene is back where it started
    doc.dispose();
  });

  it('rolls back when a DETACHED op inside the transaction failed', async () => {
    const { doc, executor } = makeDoc();
    executor.failForward.add('op_2');
    await expect(doc.withTransaction('Bulk', async () => {
      await doc.applyOp(op('op_1'));
      doc.applyOpDetached(op('op_2'));
      await doc.whenIdle();
    })).rejects.toThrow('forward refused');

    expect(doc.opCount).toBe(0);
    expect(executor.state()).toEqual([]);
    doc.dispose();
  });

  it('an explicit abort rolls back too (unlike the legacy SceneStore abort)', async () => {
    const { doc, executor } = makeDoc();
    const token = doc.beginTransaction('Bulk');
    await doc.applyOp(op('op_1'));
    expect(executor.state()).toEqual(['op_1']);
    await doc.abortTransaction(token);
    expect(doc.opCount).toBe(0);
    expect(executor.state()).toEqual([]);
    doc.dispose();
  });

  it('an empty transaction records nothing', async () => {
    const { doc } = makeDoc();
    await doc.withTransaction('Nothing', async () => {});
    expect(doc.opCount).toBe(0);
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════════
// Queue, dirty, cap, redo branch
// ══════════════════════════════════════════════════════════════════════

describe('RvDocument — document invariants', () => {
  const op = (id: string): RvOp => ({
    id, ts: 1000, schemaV: 1, kind: 'setNodeVisible',
    nodePath: 'A/' + id, visible: false, prev: true,
  });

  it('is single-flight: ops apply in submission order even when issued together', async () => {
    const { doc, executor } = makeDoc();
    await Promise.all([doc.applyOp(op('op_1')), doc.applyOp(op('op_2')), doc.applyOp(op('op_3'))]);
    expect(executor.trace).toEqual(['+op_1', '+op_2', '+op_3']);
    doc.dispose();
  });

  it('a failed op is observable at the caller but does not poison the queue', async () => {
    const { doc, executor } = makeDoc();
    executor.failForward.add('op_bad');
    await expect(doc.applyOp(op('op_bad'))).rejects.toThrow('forward refused');
    expect(doc.opCount).toBe(0); // never recorded
    await doc.applyOp(op('op_ok')); // the queue still works
    expect(doc.opCount).toBe(1);
    doc.dispose();
  });

  it('dirty is DERIVED from the op log, not a side flag', async () => {
    const { doc } = makeDoc();
    expect(doc.dirty).toBe(false);
    await doc.applyOp(op('op_1'));
    expect(doc.dirty).toBe(true);
    await doc.undo();
    expect(doc.dirty).toBe(false); // back at the clean point by op identity
    await doc.redo();
    expect(doc.dirty).toBe(true);
    doc.markSaved();
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('a document rename dirties without producing an op', async () => {
    const { doc } = makeDoc();
    doc.renameDocument('Gripper');
    expect(doc.name).toBe('Gripper');
    expect(doc.opCount).toBe(0);
    expect(doc.dirty).toBe(true);
    doc.markSaved();
    expect(doc.dirty).toBe(false);
    doc.dispose();
  });

  it('a new edit invalidates the redo branch', async () => {
    const { doc } = makeDoc();
    await doc.applyOp(op('op_1'));
    await doc.undo();
    expect(doc.canRedo()).toBe(true);
    await doc.applyOp(op('op_2'));
    expect(doc.canRedo()).toBe(false);
    doc.dispose();
  });

  it('undo stops at the baseline floor', async () => {
    const { doc, executor } = makeDoc();
    await doc.replayOps([op('op_base_1'), op('op_base_2')]);
    doc.markSaved({ floor: 2 });
    expect(doc.canUndo()).toBe(false);
    await doc.undo();
    expect(doc.opCount).toBe(2); // untouched
    expect(executor.state()).toEqual(['op_base_1', 'op_base_2']);

    await doc.applyOp(op('op_3'));
    await doc.undo();
    expect(doc.opCount).toBe(2);
    await doc.undo();
    expect(doc.opCount).toBe(2); // still floored
    doc.dispose();
  });

  it('enforces the history cap and keeps the undo floor aligned to the kept window', async () => {
    const { doc } = makeDoc();
    const many: RvOp[] = [];
    for (let i = 0; i < MAX_OP_HISTORY + 10; i++) many.push(op('op_' + i));
    await doc.replayOps(many);
    expect(doc.opCount).toBe(MAX_OP_HISTORY);
    expect(doc.ops[0].id).toBe('op_10'); // the oldest 10 dropped off the front
    doc.dispose();
  });

  it('exposes a stable snapshot that changes only when the document does', async () => {
    const { doc } = makeDoc();
    const first = doc.getSnapshot();
    expect(doc.getSnapshot()).toBe(first); // memoised
    expect(first.mode).toBe('asset');
    expect(first.undoLabel).toBeNull();

    await doc.applyOp(op('op_1'));
    const second = doc.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.opCount).toBe(1);
    expect(second.canUndo).toBe(true);
    expect(second.undoLabel).toBe('Hide op_1');
    doc.dispose();
  });

  it('notifies subscribers and disposes its executor', async () => {
    const { doc, executor } = makeDoc();
    let woken = 0;
    const off = doc.subscribe(() => { woken++; });
    await doc.applyOp(op('op_1'));
    expect(woken).toBeGreaterThan(0);
    off();
    doc.dispose();
    expect(executor.disposed).toBe(true);
    expect(doc.isDisposed).toBe(true);
  });

  it('replayOps reproduces a history without clearing redo or coalescing', async () => {
    const { doc, executor } = makeDoc();
    const a: RvOp = {
      id: 'op_a', ts: 1000, schemaV: 1, kind: 'setField',
      nodePath: 'A/B', componentType: 'Drive', fieldName: 'TargetSpeed', value: 1, prev: 0,
    };
    const b: RvOp = { ...a, id: 'op_b', ts: 1010, value: 2 };
    await doc.replayOps([a, b]);
    // Two coalescible ops stay TWO — a replay reproduces, it does not author.
    expect(doc.opCount).toBe(2);
    expect(executor.trace).toEqual(['+op_a', '+op_b']);
    doc.dispose();
  });
});
