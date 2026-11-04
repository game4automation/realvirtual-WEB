// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.2 (store half) — the variant store over a fake apply service: revision
 * only on override changes, the target set X → Y with base restores, the base cache refilled
 * on activation from Base, a field without a document value returns to "absent", undo/redo,
 * the `experiment-running` lock, commit only after a successful apply, coexistence refusal.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { ApplyResult, BaseValue, FieldKey, FieldOp } from '../../src/core/params/rv-param-apply';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { overrideKey } from '../../src/core/variants/rv-variant-model';

const A: FieldKey = { address: '#src', component: 'Source', field: 'Interval' };
const B: FieldKey = { address: '#m1', component: 'Module', field: 'Rate' };
const C: FieldKey = { address: '#src', component: 'Source', field: 'Batch' };   // absent in the document

/** The scene: present nodes and their field values (undefined = absent). */
let scene: Map<string, number | boolean | string | undefined>;
let nodes: Set<string>;
let applied: FieldOp[][];
let failNext: ApplyResult['error'] | null;
let blocker: string | null;
let sceneChanges: Array<string | null>;

function fakeApply(ops: readonly FieldOp[]): Promise<ApplyResult> {
  applied.push([...ops]);
  if (failNext) { const error = failNext; failNext = null; return Promise.resolve({ ok: false, written: [], unresolved: [], captured: [], error }); }
  const r: ApplyResult = { ok: true, written: [], unresolved: [], captured: [] };
  for (const op of ops) {
    if (!nodes.has(op.address)) { r.unresolved.push(op); continue; }
    scene.set(overrideKey(op), op.op === 'set' ? op.value : undefined);
    r.written.push(op);
  }
  return Promise.resolve(r);
}

function readBase(k: FieldKey): BaseValue | null {
  if (!nodes.has(k.address)) return null;
  const v = scene.get(overrideKey(k));
  return v === undefined ? { kind: 'absent' } : { kind: 'value', value: v };
}

function makeStore(): VariantStore {
  return new VariantStore({
    apply: fakeApply, readBase,
    coexistenceBlocker: () => blocker,
    onSceneChanged: (a) => sceneChanges.push(a),
    check: (component, field, value) => (field === 'Locked' ? { ok: false, detail: 'shared field' } : (value === -1 ? { ok: false, detail: 'bad' } : { ok: true })),
  });
}
const val = (k: FieldKey) => scene.get(overrideKey(k));

let store: VariantStore;
beforeEach(() => {
  scene = new Map([[overrideKey(A), 10], [overrideKey(B), 1]]);
  nodes = new Set(['#src', '#m1']);
  applied = [];
  failNext = null;
  blocker = null;
  sceneChanges = [];
  store = makeStore();
});

describe('variants and revisions', () => {
  it('create / rename / duplicate / remove; revision +1 only on override changes', async () => {
    const fast = store.create('Fast');
    expect(fast.ok).toBe(true);
    const id = (fast as { id: string }).id;
    expect(store.create('Fast')).toMatchObject({ ok: false, error: 'name-taken' });
    expect(store.create('  ')).toMatchObject({ ok: false, error: 'invalid-name' });
    await store.set(id, A, 4);
    expect(store.variant(id)!.revision).toBe(1);
    store.rename(id, 'Faster');
    expect(store.variant(id)).toMatchObject({ name: 'Faster', revision: 1 });
    const dup = store.duplicate(id, 'Copy') as { id: string };
    expect(store.variant(dup.id)!.overrides).toEqual([{ ...A, value: 4 }]);
    expect((await store.remove(dup.id)).ok).toBe(true);
    expect(store.block.variants.map((v) => v.name)).toEqual(['Faster']);
    expect(applied).toEqual([]);          // nothing in the scene, nothing applied
    expect(store.dirty).toBe(true);
  });

  it('an inadmissible value is refused before anything happens', async () => {
    const id = (store.create('V') as { id: string }).id;
    expect(await store.set(id, A, -1)).toMatchObject({ ok: false, error: 'invalid' });
    expect(await store.set(id, { ...A, field: 'Locked' }, 1)).toMatchObject({ ok: false, error: 'invalid' });
    expect(store.variant(id)!.overrides).toEqual([]);
  });
});

describe('activation', () => {
  it('Base → X → Y → Base: target sets carry base restores; one apply per switch', async () => {
    const x = (store.create('X') as { id: string }).id;
    const y = (store.create('Y') as { id: string }).id;
    await store.set(x, A, 4);
    await store.set(x, B, 9);
    await store.set(y, B, 5);
    expect((await store.activate(x)).ok).toBe(true);
    expect([val(A), val(B)]).toEqual([4, 9]);
    expect((await store.activate(y)).ok).toBe(true);
    expect(applied[1]).toEqual([{ ...B, op: 'set', value: 5 }, { ...A, op: 'set', value: 10 }]);
    expect([val(A), val(B)]).toEqual([10, 5]);
    expect((await store.activate(null)).ok).toBe(true);
    expect([val(A), val(B)]).toEqual([10, 1]);
    expect(applied).toHaveLength(3);
    expect(sceneChanges).toEqual([x, y, null]);
    expect(store.block.active).toBeNull();
  });

  it('the base cache is refilled from Base on every activation from Base', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    await store.activate(x);
    await store.activate(null);
    scene.set(overrideKey(A), 12);         // a base edit while in Base
    await store.activate(x);
    expect(store.baseOf(A)).toEqual({ kind: 'value', value: 12 });
    await store.activate(null);
    expect(val(A)).toBe(12);
  });

  it('a field without a document value returns to absent (unset), not to a value', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, C, 3);
    await store.activate(x);
    expect(val(C)).toBe(3);
    await store.activate(null);
    expect(applied[1]).toEqual([{ ...C, op: 'unset' }]);
    expect(scene.has(overrideKey(C)) && val(C) === undefined).toBe(true);
  });

  it('a failed apply changes nothing in the store', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    failNext = 'rebuild-failed';
    expect(await store.activate(x)).toMatchObject({ ok: false, error: 'rebuild-failed' });
    expect(store.sceneVariant).toBeNull();
    expect(store.block.active).toBeNull();
    expect(sceneChanges).toEqual([]);
  });

  it('coexistence: an old planning value pending → planning-pending; Base is always reachable', async () => {
    const x = (store.create('X') as { id: string }).id;
    blocker = 'planning-pending';
    expect(await store.activate(x)).toMatchObject({ ok: false, error: 'planning-pending' });
    expect(applied).toEqual([]);
    blocker = null;
    await store.activate(x);
    blocker = 'planning-pending';
    expect((await store.activate(null)).ok).toBe(true);
  });
});

describe('edits of the variant in the scene', () => {
  it('apply the FULL target state, commit only after success', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    await store.set(x, B, 9);
    await store.activate(x);
    await store.set(x, A, 5);
    expect(applied[1]).toEqual([{ ...A, op: 'set', value: 5 }, { ...B, op: 'set', value: 9 }]);
    failNext = 'invalid';
    expect((await store.set(x, A, 6)).ok).toBe(false);
    expect(store.variant(x)!.overrides.find((o) => o.field === 'Interval')!.value).toBe(5);
    expect(val(A)).toBe(5);
  });

  it('unset in the scene restores the base value of that field', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    await store.activate(x);
    await store.unset(x, A);
    expect(applied[1]).toEqual([{ ...A, op: 'set', value: 10 }]);
    expect(val(A)).toBe(10);
    expect(store.variant(x)!.overrides).toEqual([]);
  });

  it('a field added while in the scene caches its base before the first write', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.activate(x);
    await store.set(x, B, 7);
    expect(store.baseOf(B)).toEqual({ kind: 'value', value: 1 });
    await store.activate(null);
    expect(val(B)).toBe(1);
  });

  it('batch: several fields → one apply, one undo step', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.activate(x);
    const r = await store.batch(x, async () => { await store.set(x, A, 4); await store.set(x, B, 8); });
    expect(r.ok).toBe(true);
    expect(applied).toHaveLength(2);
    expect([val(A), val(B)]).toEqual([4, 8]);
    await store.undo();
    expect([val(A), val(B)]).toEqual([10, 1]);
  });
});

describe('undo / redo', () => {
  it('undo and redo a value of the variant in the scene (each one apply)', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.activate(x);
    await store.set(x, A, 4);
    await store.set(x, A, 5);
    expect((await store.undo()).ok).toBe(true);
    expect(val(A)).toBe(4);
    expect((await store.undo()).ok).toBe(true);
    expect(val(A)).toBe(10);
    expect(store.variant(x)!.overrides).toEqual([]);
    expect((await store.redo()).ok).toBe(true);
    expect(val(A)).toBe(4);
    await store.set(x, B, 3);            // a new action empties redo
    expect(store.canRedo).toBe(false);
  });

  it('undo of an inactive variant edits only the store', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    await store.undo();
    expect(store.variant(x)!.overrides).toEqual([]);
    expect(applied).toEqual([]);
  });
});

describe('experiment lock', () => {
  it('every change refuses with experiment-running; unlock lifts it', async () => {
    const x = (store.create('X') as { id: string }).id;
    store.lock();
    expect(store.create('Y')).toMatchObject({ ok: false, error: 'experiment-running' });
    expect(await store.set(x, A, 4)).toMatchObject({ ok: false, error: 'experiment-running' });
    expect(await store.activate(x)).toMatchObject({ ok: false, error: 'experiment-running' });
    expect(await store.undo()).toMatchObject({ ok: false, error: 'experiment-running' });
    store.unlock();
    expect((await store.set(x, A, 4)).ok).toBe(true);
  });
});

describe('unresolved fields', () => {
  it('a value whose node is missing stays in the variant and is marked unresolved', async () => {
    const x = (store.create('X') as { id: string }).id;
    const gone: FieldKey = { address: '#m9', component: 'Module', field: 'Rate' };
    await store.set(x, gone, 3);
    await store.activate(x);
    expect(store.isUnresolved(gone)).toBe(true);
    expect(store.variant(x)!.overrides).toEqual([{ ...gone, value: 3 }]);
  });
});

describe('serialised mutations (review #4)', () => {
  it('an edit issued while an activation awaits its apply runs after it, against the variant in the scene', async () => {
    const x = (store.create('X') as { id: string }).id;
    await store.set(x, A, 4);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = makeStore();
    (slow as unknown as { deps: { apply: typeof fakeApply } }).deps.apply = async (ops) => { await gate; return fakeApply(ops); };
    slow.load(store.block);
    const activating = slow.activate(x);
    const editing = slow.set(x, A, 5);          // issued while the activation is still in flight
    release();
    expect((await activating).ok).toBe(true);
    expect((await editing).ok).toBe(true);
    expect(val(A)).toBe(5);                       // applied, because X was in the scene by then
    expect(applied.at(-1)).toEqual([{ ...A, op: 'set', value: 5 }]);
  });
});

describe('descriptions', () => {
  it('describes a variant and Base without a revision bump; empty text removes it', async () => {
    const id = (store.create('Fast') as { id: string }).id;
    await store.set(id, A, 4);
    const revision = store.variant(id)!.revision;
    expect(store.describe(id, '  One AGV less, same breakdowns  ')).toMatchObject({ ok: true });
    expect(store.variant(id)!.description).toBe('One AGV less, same breakdowns');
    expect(store.variant(id)!.revision).toBe(revision);
    expect(store.describe(null, 'Three AGVs with breakdowns')).toMatchObject({ ok: true });
    expect(store.block.baseDescription).toBe('Three AGVs with breakdowns');
    store.describe(id, '   ');
    expect(store.variant(id)!.description).toBeUndefined();
    store.describe(null, '');
    expect(store.block.baseDescription).toBeUndefined();
    expect(store.describe('nope', 'x')).toMatchObject({ ok: false, error: 'unknown-variant' });
  });
});
