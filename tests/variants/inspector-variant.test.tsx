// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Object3D } from 'three';
import { registerComponentSchema, registerParamApply } from '../../src/core/engine/rv-component-registry';
import { RvExtrasEditorPlugin } from '../../src/core/hmi/rv-extras-editor';
import { FieldRow } from '../../src/core/hmi/rv-field-row';
import { ComponentSection } from '../../src/core/hmi/rv-component-section';
import { ResetAllButton, updateInspectorField } from '../../src/core/hmi/rv-property-inspector';
import { componentSetFields } from '../../src/core/hmi/component-commands';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';
import { createVariantsRuntime, type VariantsRuntime, type VariantsViewer } from '../../src/plugins/variants/variants-runtime';
import { _resetStoreForTests, getInstructions } from '../../src/core/hmi/instruction-store';
import { registerParamRebuild } from '../../src/core/params/rv-param-apply';

const TYPE = 'PartCInspectorTest';
const PATH = 'Root/Part';

beforeAll(() => {
  registerComponentSchema(TYPE, {
    Speed: { type: 'number' }, Enabled: { type: 'boolean' }, Count: { type: 'number' },
  });
  registerParamApply(TYPE, 'rebuild');
  registerParamRebuild(TYPE, async () => {});
});

beforeEach(() => _resetStoreForTests());
afterEach(() => {
  cleanup();
  setActiveEditTarget(null);
  _resetStoreForTests();
  vi.restoreAllMocks();
});

function variantTarget(overrides: Partial<EditTarget> = {}): EditTarget {
  return {
    available: true,
    persistsTo: 'variant',
    setField: vi.fn(),
    setFieldAsync: vi.fn(async () => {}),
    unsetField: vi.fn(),
    withTransaction: vi.fn(async (_label, fn) => fn()),
    ...overrides,
  };
}

describe('Inspector (K4)', () => {
  it('keeps a refused field unchanged and records only its row-local reason', () => {
    const node = new Object3D();
    node.userData.realvirtual = { [TYPE]: { Speed: 10 } };
    const setField = vi.fn();
    setActiveEditTarget(variantTarget({
      trySetField: () => ({ ok: false, reason: 'Shared field — edit in Base (unsupported)' }),
      setField,
    }));
    const editor = new RvExtrasEditorPlugin();
    (editor as unknown as { _viewer: object })._viewer = {
      registry: { getNode: (path: string) => path === PATH ? node : null },
    };

    const applyLiveEdit = vi.fn();
    expect(updateInspectorField(editor, {} as never, PATH, TYPE, 'Speed', 20, applyLiveEdit)).toBe(false);
    expect(editor.getFieldEditState(PATH, TYPE, 'Speed')).toMatchObject({
      kind: 'error', reason: 'Shared field — edit in Base (unsupported)',
    });
    expect(node.userData.realvirtual[TYPE].Speed).toBe(10);
    expect(editor.getSnapshot().overlay).toBeNull();
    expect(setField).not.toHaveBeenCalled();
    expect(applyLiveEdit).not.toHaveBeenCalled();
  });

  it('shows Applying… during the await, then an error beside the old value', () => {
    const common = {
      fieldName: 'Speed', value: 10, status: 'consumed' as const, isOverridden: true,
      onEdit: vi.fn(), onReset: vi.fn(), viewer: null, signalStore: null,
      descriptor: { type: 'number' as const },
    };
    const { rerender } = render(<FieldRow {...common} editState={{ kind: 'applying', revision: 1 }} />);
    expect(screen.getByText('Applying…')).toBeTruthy();
    expect(screen.queryByDisplayValue('10')).toBeNull();

    rerender(<FieldRow {...common} editState={{ kind: 'error', reason: 'rebuild-failed: boom', revision: 1 }} />);
    expect(screen.getByDisplayValue('10')).toBeTruthy();
    expect(screen.getByText('rebuild-failed: boom')).toBeTruthy();
    expect(screen.getByTestId('variant-field-error')).toHaveStyle({ color: '#ef5350' });
    expect(screen.queryByText(/Varied|Varies in/)).toBeNull();
  });

  it('confirms an active-variant edit at t > 0, while t = 0 applies immediately', async () => {
    const node = new Object3D();
    node.userData.realvirtual = { [TYPE]: { Speed: 10 } };
    const setField = vi.fn();
    setActiveEditTarget(variantTarget({ trySetField: () => ({ ok: true }), setField }));
    const editor = new RvExtrasEditorPlugin();
    const viewer = {
      simTime: 2,
      registry: { getNode: (path: string) => path === PATH ? node : null },
    };
    (editor as unknown as { _viewer: object })._viewer = viewer;

    expect(updateInspectorField(editor, viewer as never, PATH, TYPE, 'Speed', 20)).toBe(true);
    let state = editor.getFieldEditState(PATH, TYPE, 'Speed');
    expect(state).toMatchObject({ kind: 'confirm', value: 20, previous: 10 });
    const row = render(
      <FieldRow
        fieldName="Speed" value={10} status="consumed" isOverridden onEdit={vi.fn()} onReset={vi.fn()}
        viewer={null} signalStore={null} descriptor={{ type: 'number' }} editState={state}
        onConfirmEdit={() => editor.confirmFieldEdit(PATH, TYPE, 'Speed')}
        onCancelEdit={() => editor.cancelFieldEdit(PATH, TYPE, 'Speed')}
      />,
    );
    expect(screen.getByText('Applying this value resets the simulation to t = 0.')).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    expect(setField).not.toHaveBeenCalled();
    expect(editor.getFieldEditState(PATH, TYPE, 'Speed')).toBeUndefined();

    updateInspectorField(editor, viewer as never, PATH, TYPE, 'Speed', 20);
    state = editor.getFieldEditState(PATH, TYPE, 'Speed');
    row.rerender(
      <FieldRow
        fieldName="Speed" value={10} status="consumed" isOverridden onEdit={vi.fn()} onReset={vi.fn()}
        viewer={null} signalStore={null} descriptor={{ type: 'number' }} editState={state}
        onConfirmEdit={() => editor.confirmFieldEdit(PATH, TYPE, 'Speed')}
        onCancelEdit={() => editor.cancelFieldEdit(PATH, TYPE, 'Speed')}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply and reset' }));
    expect(setField).toHaveBeenCalledWith(PATH, TYPE, 'Speed', 20, 10);

    viewer.simTime = 0;
    updateInspectorField(editor, viewer as never, PATH, TYPE, 'Speed', 30);
    expect(setField).toHaveBeenLastCalledWith(PATH, TYPE, 'Speed', 30, 10);
    expect(editor.getFieldEditState(PATH, TYPE, 'Speed')).toBeUndefined();
  });

  it('disables all three base reset offers with the Base tooltip', async () => {
    const reset = vi.fn();
    const row = render(
      <FieldRow
        fieldName="Speed" value={10} status="consumed" isOverridden onEdit={vi.fn()} onReset={reset}
        viewer={null} signalStore={null} descriptor={{ type: 'number' }} resetDisabled
      />,
    );
    const resetField = screen.getByRole('button', { name: 'reset Speed to default' });
    expect(resetField).toBeDisabled();
    fireEvent.mouseOver(resetField.parentElement!);
    expect(await screen.findByText('Switch to Base to reset base values')).toBeTruthy();
    row.unmount();

    const section = render(
      <ComponentSection
        nodePath={PATH} componentType={TYPE} data={{ Speed: 10 }} overriddenFields={new Set(['Speed'])}
        consumedOnly={false} onFieldEdit={vi.fn()} onFieldReset={vi.fn()} onResetComponent={reset}
        viewer={null} signalStore={null} baseResetDisabled
      />,
    );
    const resetComponent = screen.getByRole('button', { name: 'Reset 1 override for PartCInspectorTest' });
    expect(resetComponent).toHaveAttribute('aria-disabled', 'true');
    fireEvent.mouseOver(resetComponent);
    expect(await screen.findByText('Switch to Base to reset base values')).toBeTruthy();
    section.unmount();

    render(<ResetAllButton disabled onClick={reset} />);
    const resetAll = screen.getByRole('button', { name: 'Reset All' });
    expect(resetAll).toBeDisabled();
    fireEvent.mouseOver(resetAll.parentElement!);
    expect(await screen.findByText('Switch to Base to reset base values')).toBeTruthy();
    expect(reset).not.toHaveBeenCalled();
  });
});

describe('component.setFields in variant mode', () => {
  const node = new Object3D();
  node.userData.realvirtual = { [TYPE]: { Speed: 10, Enabled: false, Count: 1 } };
  const viewer = {
    modes: { activeMode: 'hmi' },
    registry: { getNode: (path: string) => path === PATH ? node : null },
    getPlugin: () => undefined,
  };

  async function run(props: Record<string, unknown>) {
    return componentSetFields.run({ viewer } as never, { path: PATH, type: TYPE, props: JSON.stringify(props) }) as Promise<Record<string, unknown>>;
  }

  it('uses one transaction for three awaited fields', async () => {
    let applies = 0;
    let undoSteps = 0;
    const target = variantTarget({
      trySetField: () => ({ ok: true }),
      setFieldAsync: vi.fn(async () => {}),
      withTransaction: vi.fn(async (_label, fn) => { await fn(); applies++; undoSteps++; }),
    });
    setActiveEditTarget(target);

    expect(await run({ Speed: 20, Enabled: true, Count: 2 })).toMatchObject({
      applied: { Speed: 20, Enabled: true, Count: 2 }, rejected: [],
    });
    expect(target.withTransaction).toHaveBeenCalledWith('Set fields', expect.any(Function));
    expect(target.setFieldAsync).toHaveBeenCalledTimes(3);
    expect(applies).toBe(1);
    expect(undoSteps).toBe(1);
  });

  it('returns {ok:false, reason} on refusal and apply failure', async () => {
    setActiveEditTarget(variantTarget({ trySetField: () => ({ ok: false, reason: 'Shared field — edit in Base' }) }));
    await expect(run({ Speed: 20 })).resolves.toEqual({ ok: false, reason: 'Shared field — edit in Base' });

    setActiveEditTarget(variantTarget({
      trySetField: () => ({ ok: true }),
      setFieldAsync: vi.fn(async () => { throw new Error('apply failed'); }),
    }));
    await expect(run({ Speed: 20 })).resolves.toEqual({ ok: false, reason: 'apply failed' });
  });
});

describe('asset editor entry', () => {
  let runtime: VariantsRuntime | null = null;
  afterEach(() => { runtime?.dispose(); runtime = null; });

  it('returns to Base before the editor guard allows entry, and refuses entry when that return fails', async () => {
    const node = new Object3D(); node.userData.realvirtual = { [TYPE]: { Speed: 10 } };
    let guard: (() => boolean | Promise<boolean>) | null = null;
    const viewer = {
      isSimulationPaused: false,
      setSimulationPaused() {},
      resetSimulation() {},
      structuralEdit: async <T,>(fn: () => T | Promise<T>) => fn(),
      simulationKernel: null,
      registry: {
        getNodeByAddress: (id: string) => id === 'part' ? node : null,
        getNode: (path: string) => path === PATH ? node : null,
        getAddressForNode: (candidate: Object3D) => candidate === node ? '#part' : null,
      },
      modes: { registerEnterGuard: (_id: string, fn: () => boolean | Promise<boolean>) => { guard = fn; return () => { guard = null; }; } },
      getPlugin: () => undefined,
    };
    runtime = createVariantsRuntime({ viewer: () => viewer as unknown as VariantsViewer, documentLoadId: () => 'doc' });
    await runtime.bindDocument({ userData: {} }, { applyActive: false });
    const id = (runtime.create('Fast') as { id: string }).id;
    await runtime.store.set(id, { address: '#part', component: TYPE, field: 'Speed' }, 20);
    await runtime.activate(id);

    expect(await guard!()).toBe(true);
    expect(runtime.store.sceneVariant).toBeNull();
    expect(getInstructions().at(-1)?.text).toBe('Switched to Base for asset editing');

    await runtime.activate(id);
    runtime.store.lock('experiment-running');
    expect(await guard!()).toBe(false);
    expect(runtime.store.sceneVariant).toBe(id);
    expect(getInstructions().at(-1)?.text).toBe('experiment-running');
  });
});


it.each(['Enter', 'blur'])('H2 keeps the complete numeric draft until %s, then applies 750', async commit => {
  const node = new Object3D();
  node.userData.realvirtual = { [TYPE]: { Speed: 10 } };
  const setField = vi.fn();
  setActiveEditTarget(variantTarget({ trySetField: () => ({ ok: true }), setField }));
  const editor = new RvExtrasEditorPlugin();
  const viewer = { simTime: 2, registry: { getNode: () => node } };
  (editor as unknown as { _viewer: object })._viewer = viewer;
  function Row() {
    const [, refresh] = useState(0);
    return <FieldRow fieldName="Speed" value={10} status="consumed" isOverridden
      viewer={viewer as never} signalStore={null} descriptor={{ type: 'number' }} onReset={() => {}}
      editState={editor.getFieldEditState(PATH, TYPE, 'Speed')}
      onEdit={v => { updateInspectorField(editor, viewer as never, PATH, TYPE, 'Speed', v); refresh(n => n + 1); }}
      onConfirmEdit={() => { editor.confirmFieldEdit(PATH, TYPE, 'Speed'); refresh(n => n + 1); }}
      onCancelEdit={() => { editor.cancelFieldEdit(PATH, TYPE, 'Speed'); refresh(n => n + 1); }} />;
  }
  render(<Row />);
  const input = screen.getByDisplayValue('10');
  for (const value of ['7', '75', '750']) {
    fireEvent.change(input, { target: { value } });
    expect(screen.getByDisplayValue(value)).toBe(input);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  }
  if (commit === 'Enter') fireEvent.keyDown(input, { key: 'Enter' });
  else fireEvent.blur(input);
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  expect(screen.getByDisplayValue('750')).toBeTruthy();
  expect(setField).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByDisplayValue('10')).toBeTruthy();
  const again = screen.getByDisplayValue('10');
  fireEvent.change(again, { target: { value: '750' } });
  fireEvent.keyDown(again, { key: 'Enter' });
  fireEvent.click(await screen.findByRole('button', { name: 'Apply and reset' }));
  expect(setField).toHaveBeenCalledWith(PATH, TYPE, 'Speed', 750, 10);
});


it.each(['base', 'variant-at-zero'])('H2 preserves live numeric commits for %s', mode => {
  if (mode === 'variant-at-zero') setActiveEditTarget(variantTarget());
  const edit = vi.fn();
  render(<FieldRow fieldName="Speed" value={10} status="consumed" isOverridden
    viewer={{ simTime: mode === 'base' ? 2 : 0 } as never} signalStore={null}
    descriptor={{ type: 'number' }} onEdit={edit} onReset={() => {}} />);
  fireEvent.change(screen.getByDisplayValue('10'), { target: { value: '7' } });
  expect(edit).toHaveBeenCalledWith(7);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
