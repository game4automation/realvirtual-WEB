// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Migration identities and lease-authorized scene transitions over a fake apply service. */
import { afterEach, expect, it, vi } from 'vitest';
import { acquireRunLease, currentRunLease, getSceneVariantProvenance, setSceneVariantProvenanceProvider } from '../../src/core/hmi/rv-run-lease';
import type { ApplyOptions, ApplyResult, FieldOp } from '../../src/core/params/rv-param-apply';
import { VariantStore } from '../../src/core/variants/rv-variant-store';

const a = { address: '#a', component: 'Source', field: 'Interval' };
const b = { ...a, address: '#b' };
function setup() {
  const values = new Map([['#a', 10], ['#b', 20]]);
  const apply = vi.fn(async (ops: readonly FieldOp[], _options?: ApplyOptions): Promise<ApplyResult> => {
    for (const o of ops) if (o.op === 'set') values.set(o.address, o.value as number);
    return { ok: true, written: [...ops], captured: [], unresolved: [] };
  });
  const changed = vi.fn();
  const store = new VariantStore({ apply, readBase: (k) => ({ kind: 'value', value: values.get(k.address)! }), onSceneChanged: changed });
  return { store, apply, values, changed };
}
afterEach(() => { currentRunLease()?.release(); setSceneVariantProvenanceProvider(null); });

it('creates stable identities, compares unordered overrides, and refuses conflicts without mutation', () => {
  const { store } = setup();
  const overrides = [{ ...a, value: 1 }, { ...b, value: 2 }];
  expect(store.createWithId('x', 'Fast', overrides)).toEqual({ ok: true, id: 'x' });
  const version = store.version;
  expect(store.createWithId('x', 'Renamed', [...overrides].reverse())).toEqual({ ok: true, id: 'x' });
  expect(store.version).toBe(version);
  expect(store.createWithId('x', 'Fast', [{ ...a, value: 3 }])).toEqual({ ok: false, error: 'conflict' });
  expect(store.variant('x')).toMatchObject({ name: 'Fast', revision: 0, overrides });
  store.createWithId('y', 'Fast');
  store.createWithId('z', 'Fast');
  expect(store.variant('y')?.name).toBe('Fast (migrated)');
  expect(store.variant('z')?.name).toBe('Fast (migrated 2)');
  store.lock();
  // An identical copy changes nothing, so it succeeds even while locked; a differing one does not.
  expect(store.createWithId('x', 'Fast', overrides)).toEqual({ ok: true, id: 'x' });
  expect(store.createWithId('x', 'Fast', [{ ...a, value: 3 }], 5)).toEqual({ ok: false, error: 'locked' });
  expect(store.createWithId('new', 'New')).toEqual({ ok: false, error: 'locked' });
});

it('authenticates the lease object and restores full scene state and provenance without undo', async () => {
  const { store, apply, values, changed } = setup();
  store.createWithId('x', 'X', [{ ...a, value: 1 }]);
  store.createWithId('y', 'Y', [{ ...b, value: 2 }]);
  setSceneVariantProvenanceProvider(() => {
    const v = store.sceneVariant ? store.variant(store.sceneVariant) : undefined;
    return v ? { variantId: v.id, revision: v.revision, overrides: v.overrides } : null;
  });
  store.lock();
  expect(await store.activateAsHolder('x', null)).toEqual({ ok: false, error: 'locked' });
  const lease = acquireRunLease('doc', 'batch')!;
  expect(await store.activateAsHolder('x', { ...lease })).toEqual({ ok: false, error: 'locked' });
  expect(apply).not.toHaveBeenCalled();
  expect(await store.activateAsHolder('x', lease)).toEqual({ ok: true, id: 'x' });
  expect(apply).toHaveBeenLastCalledWith([{ ...a, value: 1, op: 'set' }], { origin: 'experiment', holder: 'batch' });
  expect(store.baseOf(a)).toEqual({ kind: 'value', value: 10 });
  expect(getSceneVariantProvenance()?.variantId).toBe('x');
  await store.activateAsHolder('y', lease);
  expect(values.get('#a')).toBe(10);
  expect(values.get('#b')).toBe(2);
  expect(store.sceneVariant).toBe('y');
  expect(getSceneVariantProvenance()?.variantId).toBe('y');
  await store.activateAsHolder(null, lease);
  expect(values.get('#b')).toBe(20);
  expect(store.sceneVariant).toBeNull();
  expect(getSceneVariantProvenance()).toBeNull();
  expect(changed.mock.calls).toEqual([['x'], ['y'], [null]]);
  expect(apply).toHaveBeenCalledTimes(3);
  expect(store.canUndo).toBe(false);
  lease.release();
  expect(await store.activateAsHolder('x', lease)).toEqual({ ok: false, error: 'locked' });
  store.unlock();
  expect((await store.activateAsHolder('x', null)).ok).toBe(true);
});

it('keeps scene identity and provenance when apply fails', async () => {
  const { store, apply, changed } = setup();
  store.createWithId('x', 'X', [{ ...a, value: 1 }]);
  const lease = acquireRunLease('doc', 'batch')!;
  store.lock();
  apply.mockResolvedValueOnce({ ok: false, written: [], captured: [], unresolved: [], error: 'locked' });
  expect((await store.activateAsHolder('x', lease)).ok).toBe(false);
  expect(store.sceneVariant).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it('preserves ordinary activation and custom lock reasons while holder calls return locked', async () => {
  const { store, apply } = setup();
  store.createWithId('x', 'X', [{ ...a, value: 1 }]);
  store.lock('custom-lock');
  expect(await store.activate('x')).toEqual({ ok: false, error: 'custom-lock' });
  expect(await store.activateAsHolder('x')).toEqual({ ok: false, error: 'locked' });
  expect(store.createWithId('y', 'Y')).toEqual({ ok: false, error: 'locked' });
  store.unlock();
  await store.activate('x');
  expect(apply).toHaveBeenLastCalledWith([{ ...a, value: 1, op: 'set' }]);
});
