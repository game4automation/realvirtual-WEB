// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Regression coverage for mounted inspector rows and shared-field guidance. */
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { VariantFieldIndex } from '../../src/core/variants/rv-variant-index';
import { overrideKey } from '../../src/core/variants/rv-variant-model';
import type { FieldKey, FieldOp, BaseValue } from '../../src/core/params/rv-param-field';
import type { ApplyResult } from '../../src/core/params/rv-param-apply';
import { FieldRow } from '../../src/core/hmi/rv-field-row';
import { registerFieldRowAction } from '../../src/core/hmi/rv-field-row-actions';
import { variantFieldRowAction } from '../../src/plugins/variants/VariantFieldMarker';
afterEach(cleanup);
const INTERVAL: FieldKey = { address: '#src', component: 'Source', field: 'Interval' };
const MAXMUS: FieldKey = { address: '#src', component: 'Source', field: 'MaxMUs' };

type Scalar = number | boolean | string;

/** The scene: one node `Src` with two number fields, plus a gone node `#old`. */
function makeHarness() {
  const scene = new Map<string, Scalar | undefined>([
    [overrideKey(INTERVAL), 10],
    [overrideKey(MAXMUS), 0],
  ]);
  const applies: FieldOp[][] = [];
  const index = new VariantFieldIndex();
  const node = { name: 'Src', userData: {} } as unknown as import('three').Object3D;

  const store = new VariantStore({
    apply: (ops) => {
      applies.push([...ops]);
      for (const op of ops) scene.set(overrideKey(op), op.op === 'set' ? op.value : undefined);
      return Promise.resolve({ ok: true, written: [...ops], unresolved: [], captured: [] } as ApplyResult);
    },
    readBase: (k): BaseValue | null => {
      if (k.address !== '#src') return null;
      const v = scene.get(overrideKey(k));
      return v === undefined ? { kind: 'absent' } : { kind: 'value', value: v };
    },
    check: () => ({ ok: true }),
  });
  store.subscribe(() => index.sync(store.block, store.sceneVariant));

  const runtime = {
    store,
    index,
    service: {
      checkValue: (_c: string, field: string) => (field === 'Ref'
        ? { ok: false as const, reason: 'unsupported', detail: 'a reference' }
        : { ok: true as const, mode: 'field', info: { type: 'number', unit: 'ms' } }),
      readBase: (k: FieldKey) => {
        if (k.address !== '#src') return null;
        const v = scene.get(overrideKey(k));
        return v === undefined ? { kind: 'absent' as const } : { kind: 'value' as const, value: v };
      },
      resolve: (k: FieldKey) => (k.address === '#src' ? node : null),
    },
    create: (name: string) => store.create(name),
    subscribeBinding: () => () => {},
    getBindingGeneration: () => 1,
  };

  const viewer = {
    simTime: 0,
    registry: {
      getNode: () => node,
      getAddressForNode: () => '#src',
      getPathForNode: () => 'Doc/Src',
    },
    selectionManager: { getSnapshot: () => ({ nodes: [node] }), select: vi.fn() },
    getPlugin: () => undefined,
  };

  return { store, index, runtime: runtime as never, viewer: viewer as never, applies, scene };
}


it('updates a mounted field after activate, set, rename and unset', async () => {
  const h = makeHarness();
  const made = h.store.create('Fast');
  if (!made.ok || !made.id) throw new Error('create failed');
  const id = made.id;
  await h.store.set(id, INTERVAL, 18);
  const unregister = registerFieldRowAction(variantFieldRowAction(h.runtime));
  try {
    render(<FieldRow fieldName="Interval" value={10} status="consumed" isOverridden={false}
      onEdit={vi.fn()} onReset={vi.fn()} viewer={h.viewer} signalStore={null}
      componentType="Source" nodePath="Doc/Src" descriptor={{ type: 'number' }} />);
    expect(screen.getByDisplayValue('10')).toBeTruthy();
    await act(async () => { await h.store.activate(id); });
    await waitFor(() => expect(screen.getByDisplayValue('18')).toBeTruthy());
    await act(async () => { await h.store.set(id, INTERVAL, 22); });
    await waitFor(() => expect(screen.getByDisplayValue('22')).toBeTruthy());
    act(() => { h.store.rename(id, 'Renamed'); });
    expect(screen.getByDisplayValue('22')).toBeTruthy();
    await act(async () => { await h.store.unset(id, INTERVAL); });
    await waitFor(() => expect(screen.getByDisplayValue('10')).toBeTruthy());
  } finally { unregister(); }
});

it('shows the edited Base value after returning from a variant with a cached Base', async () => {
  const h = makeHarness();
  const made = h.store.create('Fast');
  if (!made.ok || !made.id) throw new Error('create failed');
  await h.store.set(made.id, INTERVAL, 18);
  await h.store.activate(made.id);
  const action = variantFieldRowAction(h.runtime);
  const subscribe = vi.spyOn(action, 'subscribeValue');
  const unregister = registerFieldRowAction(action);
  const row = (value: number) => <FieldRow fieldName="Interval" value={value} status="consumed" isOverridden={false}
    onEdit={vi.fn()} onReset={vi.fn()} viewer={h.viewer} signalStore={null}
    componentType="Source" nodePath="Doc/Src" descriptor={{ type: 'number' }} />;
  try {
    const { rerender } = render(row(10));
    expect(screen.getByDisplayValue('18')).toBeTruthy();
    const subscriptions = subscribe.mock.calls.length;
    rerender(row(10));
    expect(subscribe).toHaveBeenCalledTimes(subscriptions);
    await act(async () => { await h.store.activate(null); });
    expect(h.store.sceneVariant).toBeNull();
    expect(screen.getByDisplayValue('10')).toBeTruthy();
    h.scene.set(overrideKey(INTERVAL), 35);
    rerender(row(35));
    expect(screen.getByDisplayValue('35')).toBeTruthy();
    expect(screen.queryByDisplayValue('10')).toBeNull();
  } finally { unregister(); }
});

it('shows shared-field guidance and confirms switching to Base', async () => {
  const activate = vi.fn(async () => ({ ok: true }));
  const viewer = { simTime: 5, getPlugin: () => ({ commandRuntime: async () => ({ activate }) }) };
  render(<FieldRow fieldName="Shared" value={10} status="consumed" isOverridden={false}
    onEdit={vi.fn()} onReset={vi.fn()} viewer={viewer as never} signalStore={null}
    editState={{ kind: 'error', code: 'shared-field', reason: 'Shared field — edit in Base', revision: 1 }} />);
  expect(screen.getByText('Shared by all variants. Edit in Base configuration.')).not.toHaveStyle({ color: '#ef5350' });
  fireEvent.click(screen.getByRole('button', { name: 'Switch to Base…' }));
  expect(activate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Switch and reset' }));
  await waitFor(() => expect(activate).toHaveBeenCalledWith(null));
});
