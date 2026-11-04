// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { activeHistoryStep, setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { RvDocument } from '../../src/core/ops/rv-document';
import type { RvExecutor } from '../../src/core/ops/rv-unified-executors';
import type { RvOp } from '../../src/core/ops/rv-unified-ops';
import { createVariantEditTarget, type VariantEditTarget } from '../../src/core/variants/rv-variant-edit-target';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import type { FieldKey } from '../../src/core/variants/rv-variant-model';

class StubExecutor implements RvExecutor {
  async applyForward(op: RvOp): Promise<void> { if (op.kind === 'composite') for (const child of op.ops) await this.applyForward(child); }
  async applyInverse(op: RvOp): Promise<void> { if (op.kind === 'composite') for (let i = op.ops.length - 1; i >= 0; i--) await this.applyInverse(op.ops[i]); }
}

let seq = 0;
const layout = (value: number, path = 'Cell/Slide'): RvOp => ({
  id: `op_variant_journal_${++seq}`, ts: Date.now(), schemaV: 1, kind: 'setField',
  nodePath: path, componentType: 'Transform', fieldName: 'x', value, prev: value - 1,
} as RvOp);
const key: FieldKey = { address: '#source', component: 'Source', field: 'Interval' };

function setup() {
  const document = new RvDocument({ id: 'scene', name: 'Scene', mode: 'scene', executor: new StubExecutor() });
  const messages: string[] = [];
  let target: VariantEditTarget | null = null;
  const store = new VariantStore({
    apply: async () => ({ ok: true, written: [], unresolved: [], captured: [] }),
    readBase: () => ({ kind: 'value', value: 10 }),
    onCommit: () => target?.recordVariantCommit(),
  });
  const id = (store.create('Fast') as { id: string }).id;
  const activate = async () => {
    await store.activate(id);
    target = createVariantEditTarget({
      store, variantId: id, host: {}, check: () => ({ ok: true }),
      historyHost: { document, undo: () => document.undo(), redo: () => document.redo() },
      message: (text) => messages.push(text),
    });
    setActiveEditTarget(target);
  };
  return { document, messages, store, id, activate, target: () => target };
}

afterEach(() => { setActiveEditTarget(null); });

describe('plan-2013 9.6 — variant undo journal', () => {
  it('undoes layout then variant, redoes in reverse, and a new action clears redo', async () => {
    const h = setup();
    await h.activate();
    await h.store.set(h.id, key, 4);
    await h.document.applyOp(layout(1));

    expect(await activeHistoryStep('undo')).toBe(true);
    expect(h.document.opCount).toBe(0);
    expect(h.store.variant(h.id)?.overrides[0]?.value).toBe(4);
    expect(await activeHistoryStep('undo')).toBe(true);
    expect(h.store.variant(h.id)?.overrides).toEqual([]);
    expect(await activeHistoryStep('redo')).toBe(true);
    expect(h.store.variant(h.id)?.overrides[0]?.value).toBe(4);
    expect(await activeHistoryStep('redo')).toBe(true);
    expect(h.document.opCount).toBe(1);

    expect(await activeHistoryStep('undo')).toBe(true);
    await h.store.set(h.id, key, 6);
    expect(await activeHistoryStep('redo')).toBe(false);
    h.target()?.dispose();
  });

  it('does not reach a scene op from before activation and explains how to undo it', async () => {
    const h = setup();
    await h.document.applyOp(layout(1));
    await h.activate();

    expect(await activeHistoryStep('undo')).toBe(false);
    expect(h.document.opCount).toBe(1);
    expect(h.messages).toContain('Switch to Base to undo earlier base changes');
    h.target()?.dispose();
  });

  it('sets a coalesce floor around a variant edit and shows the layout message once', async () => {
    const h = setup();
    await h.activate();
    await h.document.applyOp(layout(1));
    await h.store.set(h.id, key, 4);
    await h.document.applyOp(layout(2));
    await h.document.applyOp(layout(3));

    expect(h.document.opCount).toBe(2);
    expect(h.messages.filter((m) => m === 'Layout change applied to Base (all variants)')).toHaveLength(1);
    expect(await activeHistoryStep('undo')).toBe(true);
    expect(await activeHistoryStep('undo')).toBe(true);
    expect(await activeHistoryStep('undo')).toBe(true);
    expect(await activeHistoryStep('undo')).toBe(false);
    expect(h.document.opCount).toBe(0);
    expect(h.store.variant(h.id)?.overrides).toEqual([]);

    for (let i = 0; i < 3; i++) expect(await activeHistoryStep('redo')).toBe(true);
    expect(h.document.opCount).toBe(2);
    expect(h.store.variant(h.id)?.overrides[0]?.value).toBe(4);
    h.target()?.dispose();
  });
});
