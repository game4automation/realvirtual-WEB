// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 Concept D — the surface: the row icon (states 2 and 3), the field popover
 * (state 4), the toolbar switcher with variant management, the read-only compare table and
 * the inspector's ⋮ mode switch (state 1).
 *
 * The three P0 points of the Codex review are what most of these cases are about:
 *   1. the edit target is named, and an edit of an INACTIVE variant applies nothing;
 *   2. rename / duplicate / delete exist, and deleting the active variant confirms;
 *   3. an override that currently EQUALS Base stays visible — in the row icon, in the
 *      popover and in the compare table — and is never removed automatically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ApplyResult, BaseValue, FieldKey, FieldOp } from '../../src/core/params/rv-param-apply';
import { VariantStore } from '../../src/core/variants/rv-variant-store';
import { VariantFieldIndex } from '../../src/core/variants/rv-variant-index';
import { overrideKey } from '../../src/core/variants/rv-variant-model';
import { VariantFieldMarker, markerApplies, markerRowSx } from '../../src/plugins/variants/VariantFieldMarker';
import { VariantFieldPopover } from '../../src/plugins/variants/VariantFieldPopover';
import { VariantToolbarSwitcher } from '../../src/plugins/variants/VariantToolbarSwitcher';
import { VariantCompareTable } from '../../src/plugins/variants/VariantCompareDialog';
import { InspectorBurgerMenu } from '../../src/core/hmi/InspectorBurgerMenu';
import { setVariantModeContext } from '../../src/core/hmi/rv-variant-ui-mode';
import {
  activateVariant,
  deleteVariant,
  duplicateVariant,
  renameVariant,
} from '../../src/plugins/variants/variant-commands';

vi.mock('../../src/plugins/variants/variant-commands', () => ({
  activateVariant: vi.fn(async () => ({ ok: true })),
  deleteVariant: vi.fn(async () => ({ ok: true })),
  duplicateVariant: vi.fn(async () => ({ ok: true })),
  renameVariant: vi.fn(async () => ({ ok: true })),
}));

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

const anchor = (): HTMLElement => {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
};

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); setVariantModeContext(null); localStorage.clear(); });

describe('Concept D — the row icon', () => {
  it('shows the three states and marks the overridden row', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const slow = h.store.create('Slow');
    await h.store.set((fast as { id: string }).id, INTERVAL, 4);
    await h.store.set((slow as { id: string }).id, MAXMUS, 3);
    await h.store.activate((fast as { id: string }).id);

    const ctx = { viewer: h.viewer, nodePath: 'Doc/Src', componentType: 'Source', fieldName: 'Interval' };
    expect(markerApplies(h.runtime, ctx)).toBe(true);
    expect(markerRowSx(h.runtime, ctx)).toBeTruthy();

    render(<VariantFieldMarker {...ctx} runtime={h.runtime} />);
    expect(screen.getByTestId('variant-field-marker').getAttribute('data-variant-state')).toBe('overridden');
    cleanup();

    render(<VariantFieldMarker {...ctx} fieldName="MaxMUs" runtime={h.runtime} />);
    expect(screen.getByTestId('variant-field-marker').getAttribute('data-variant-state')).toBe('elsewhere');
    cleanup();

    render(<VariantFieldMarker {...ctx} fieldName="Other" runtime={h.runtime} />);
    const none = screen.getByTestId('variant-field-marker');
    expect(none.getAttribute('data-variant-state')).toBe('none');
    expect(markerRowSx(h.runtime, { ...ctx, fieldName: 'Other' })).toBeUndefined();
  });

  it('P0 #3: an override equal to Base stays visible and is tagged', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const id = (fast as { id: string }).id;
    await h.store.set(id, INTERVAL, 10);          // exactly the Base value
    await h.store.activate(id);

    render(<VariantFieldMarker viewer={h.viewer} nodePath="Doc/Src" componentType="Source" fieldName="Interval" runtime={h.runtime} />);
    const marker = screen.getByTestId('variant-field-marker');
    expect(marker.getAttribute('data-variant-state')).toBe('overridden');
    expect(marker.getAttribute('data-variant-equals-base')).toBe('true');
    // Nothing removed it: the override is still in the block.
    expect(h.store.variant(id)?.overrides).toHaveLength(1);
  });

  it('no icon on a reference field and none in a multi-selection (P0 #2)', () => {
    const h = makeHarness();
    expect(markerApplies(h.runtime, { viewer: h.viewer, nodePath: 'Doc/Src', componentType: 'Source', fieldName: 'Ref' })).toBe(false);
    const multi = {
      registry: { getNode: () => ({}), getAddressForNode: () => '#src' },
      selectionManager: { getSnapshot: () => ({ nodes: [{}, {}] }) },
    } as never;
    expect(markerApplies(h.runtime, { viewer: multi, nodePath: 'Doc/Src', componentType: 'Source', fieldName: 'Interval' })).toBe(false);
  });
});

describe('Concept D — the field popover', () => {
  const open = (h: ReturnType<typeof makeHarness>) => render(
    <VariantFieldPopover
      viewer={h.viewer}
      runtime={h.runtime}
      anchorEl={anchor()}
      fieldKey={INTERVAL}
      componentType="Source"
      fieldName="Interval"
      onClose={() => {}}
    />,
  );

  it('P0 #1: names the edit target, and editing an INACTIVE variant applies nothing', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const slow = h.store.create('Slow');
    await h.store.set((fast as { id: string }).id, INTERVAL, 4);
    await h.store.activate((fast as { id: string }).id);
    h.applies.length = 0;

    open(h);
    expect(screen.getByTestId('variant-edit-target').textContent).toContain('Editing: Fast (in scene)');

    fireEvent.click(screen.getByRole('radio', { name: 'Edit Slow' }));
    expect(screen.getByTestId('variant-edit-target').textContent).toContain('Editing: Slow — not in the scene');

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    await waitFor(() => expect(h.store.variant((slow as { id: string }).id)?.overrides).toHaveLength(1));
    expect(h.applies).toEqual([]);                    // the scene was never touched
    expect(h.scene.get(overrideKey(INTERVAL))).toBe(4);
  });

  it('"← Base" removes the override instead of storing a null', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const id = (fast as { id: string }).id;
    await h.store.set(id, INTERVAL, 4);
    open(h);

    fireEvent.click(screen.getByRole('button', { name: 'Fast back to Base' }));
    await waitFor(() => expect(h.store.variant(id)?.overrides).toEqual([]));
  });

  it('P0 #3: an equal-to-Base override is tagged in the popover and keeps its "← Base"', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    await h.store.set((fast as { id: string }).id, INTERVAL, 10);
    await h.store.activate((fast as { id: string }).id);
    open(h);

    expect(screen.getAllByTestId('variant-equals-base-tag').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Fast back to Base' })).toBeTruthy();
  });

  it('Base is not editable while a variant drives the scene — it offers Switch to Base', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    await h.store.set((fast as { id: string }).id, INTERVAL, 4);
    await h.store.activate((fast as { id: string }).id);
    open(h);

    fireEvent.click(screen.getByRole('radio', { name: 'Edit Base' }));
    expect(screen.getByTestId('variant-edit-target').textContent).toContain('Base is edited in Base');
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Base' }));
    await waitFor(() => expect(vi.mocked(activateVariant)).toHaveBeenCalledWith(h.viewer, { id: 'base' }));
  });

  it('a Base edit that variants inherit names its effect and asks first', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    await h.store.set((fast as { id: string }).id, MAXMUS, 3);     // Fast inherits Interval
    open(h);

    expect(screen.getByTestId('variant-edit-target').textContent).toContain('Editing: Base');
    expect(screen.getByText('1 variant(s) inherit this value.')).toBeTruthy();
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '11' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Change Base' })).toBeTruthy());
    expect(screen.getByText(/1 variant\(s\) inherit this value and change with it/)).toBeTruthy();
  });

  it('asks once before an edit of the variant in the scene at t > 0', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const id = (fast as { id: string }).id;
    await h.store.set(id, INTERVAL, 4);
    await h.store.activate(id);
    (h.viewer as unknown as { simTime: number }).simTime = 5;
    h.applies.length = 0;
    open(h);

    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Apply variant value' })).toBeTruthy());
    expect(h.applies).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply and reset' }));
    await waitFor(() => expect(h.store.variant(id)?.overrides[0].value).toBe(6));
    expect(h.applies).toHaveLength(1);                // one apply = one reset
  });

  it('"+ New variant" creates one without putting it into the scene', async () => {
    const h = makeHarness();
    open(h);
    fireEvent.click(screen.getByRole('button', { name: '+ New variant' }));
    await waitFor(() => expect(h.store.block.variants).toHaveLength(1));
    expect(h.store.sceneVariant).toBeNull();
    expect(h.applies).toEqual([]);
    expect(screen.getByTestId('variant-edit-target').textContent).toContain('not in the scene');
  });
});

describe('Concept D — the toolbar switcher', () => {
  const open = (h: ReturnType<typeof makeHarness>) => {
    render(<VariantToolbarSwitcher viewer={h.viewer} runtime={h.runtime} />);
    fireEvent.click(screen.getByTestId('variant-switcher'));
  };

  it('requests a name before creating and Escape cancels without a mutation', async () => {
    const h = makeHarness();
    h.store.create('Variant 1');
    open(h);
    fireEvent.click(screen.getByText('+ New variant'));
    const input = await screen.findByRole('textbox', { name: 'Variant name' });
    expect(input).toHaveValue('Variant 2');
    expect(h.store.block.variants).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Variant 1' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(h.store.block.variants).toHaveLength(1);
    fireEvent.click(screen.getByTestId('variant-switcher'));
    fireEvent.click(screen.getByText('+ New variant'));
    fireEvent.click(await screen.findByRole('button', { name: 'Create' }));
    await waitFor(() => expect(h.store.block.variants).toHaveLength(2));
    expect(h.store.block.variants[1].name).toBe('Variant 2');
  });

  it('lists Base and every variant and switches without a question at t = 0', async () => {
    const h = makeHarness();
    h.store.create('Fast');
    open(h);
    expect(screen.getByRole('menuitem', { name: /Base/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Fast/ }));
    await waitFor(() => expect(vi.mocked(activateVariant)).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('asks before switching at t > 0', async () => {
    const h = makeHarness();
    h.store.create('Fast');
    (h.viewer as unknown as { simTime: number }).simTime = 3;
    open(h);
    fireEvent.click(screen.getByRole('menuitem', { name: /Fast/ }));
    await waitFor(() => expect(screen.getByRole('alertdialog', { name: 'Switch variant' })).toBeTruthy());
    expect(vi.mocked(activateVariant)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch and reset' }));
    await waitFor(() => expect(vi.mocked(activateVariant)).toHaveBeenCalled());
  });

  it('P0 #2: rename, duplicate and delete live here; renaming says it resets nothing', async () => {
    const h = makeHarness();
    h.store.create('Fast');
    open(h);

    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Fast' }));
    await waitFor(() => expect(vi.mocked(duplicateVariant)).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('variant-switcher'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename Fast' }));
    expect(screen.getByRole('alertdialog', { name: 'Rename variant' }).textContent).toContain('resets nothing');
    fireEvent.change(screen.getByRole('textbox', { name: 'New name for Fast' }), { target: { value: 'Faster' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(vi.mocked(renameVariant)).toHaveBeenCalledWith(h.viewer, { id: expect.any(String), name: 'Faster' }));
  });

  it('deleting the variant in the scene confirms and says the scene goes back to Base', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    await h.store.activate((fast as { id: string }).id);
    open(h);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Fast' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete variant' });
    expect(dialog.textContent).toContain('goes back to Base');
    expect(vi.mocked(deleteVariant)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(vi.mocked(deleteVariant)).toHaveBeenCalled());
  });
});

describe('Concept D — the compare table', () => {
  it('lists every varied field, shows inheritance and keeps equal-to-Base findable', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    const slow = h.store.create('Slow');
    await h.store.set((fast as { id: string }).id, INTERVAL, 4);
    await h.store.set((slow as { id: string }).id, INTERVAL, 10);   // equal to Base, but set
    await h.store.set((slow as { id: string }).id, MAXMUS, 3);

    render(<VariantCompareTable viewer={h.viewer} runtime={h.runtime} />);
    const rows = screen.getAllByTestId('variant-compare-row');
    expect(rows).toHaveLength(2);
    expect(screen.getAllByTestId('variant-compare-equals-base').length).toBe(1);
    expect(rows[1].textContent).toContain('·');          // Fast inherits MaxMUs

    fireEvent.click(rows[0]);
    expect((h.viewer as unknown as { selectionManager: { select: ReturnType<typeof vi.fn> } }).selectionManager.select)
      .toHaveBeenCalledWith('Doc/Src');
  });

  it('marks an orphaned override instead of hiding it', async () => {
    const h = makeHarness();
    const fast = h.store.create('Fast');
    await h.store.set((fast as { id: string }).id, { address: '#old', component: 'Source', field: 'Interval' }, 7);

    render(<VariantCompareTable viewer={h.viewer} runtime={h.runtime} />);
    expect(screen.getByTestId('variant-compare-missing').textContent).toContain('target missing');
  });
});

describe('Concept D — state 1: the inspector burger', () => {
  it('renders nothing without a document context', () => {
    const { container } = render(<InspectorBurgerMenu />);
    expect(container.firstChild).toBeNull();
  });

  it('switches the mode through the published context', async () => {
    const setMode = vi.fn(async () => {});
    setVariantModeContext({ docKey: 'a.glb', hasVariants: false, setMode });
    render(<InspectorBurgerMenu />);
    fireEvent.click(screen.getByTestId('inspector-burger'));
    const item = screen.getByTestId('inspector-variant-mode');
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    await waitFor(() => expect(setMode).toHaveBeenCalledWith(true));
  });

  it('a document with variants shows the mode already on', () => {
    setVariantModeContext({ docKey: 'a.glb', hasVariants: true, setMode: async () => {} });
    render(<InspectorBurgerMenu />);
    fireEvent.click(screen.getByTestId('inspector-burger'));
    expect(screen.getByTestId('inspector-variant-mode').getAttribute('aria-checked')).toBe('true');
  });
});
