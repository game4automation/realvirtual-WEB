// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-maintenance-reference-picker.browser.test.tsx — plan-522 §9.8: the
 * existing reference picker, extended for the maintenance components.
 *
 * - `referenceTargetOf` / `pickableReferenceFields`: `node` target and list
 *   mode come from the registered web schema; rv-ODT fields unchanged.
 * - `ReferencePickerRow` list mode: "Add" appends an object-form reference with
 *   the AUTHORED path and `componentType: ''`, the chip cross removes it; an
 *   ambiguous candidate (sibling twins) is not selectable.
 * - `MaintenanceViewRow`: writes CameraPosition / CameraTarget from
 *   `captureView()`; without `captureView` it renders nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Object3D } from 'three';
import '../../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../../src/core/rv-viewer';
import { ReferencePickerRow } from '../../src/core/hmi/ReferencePickerRow';
import { MaintenanceViewRow } from '../../src/core/hmi/MaintenanceViewRow';
import { pickableReferenceFields, referenceTargetOf, webSchemaReferenceOf } from '../../src/core/hmi/rv-reference-field';
import { setActiveEditTarget, type EditTarget } from '../../src/core/hmi/rv-edit-target';

function child(parent: Object3D, name: string, extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  if (extras) n.userData.realvirtual = extras;
  parent.add(n);
  return n;
}

/** CNC / Tip (bare), Tip_1 stamped `Tip` (twin of Tip), Nozzle_3 stamped `Nozzle:3`, Maintenance / 05 Step (owner). */
function makeViewer(): RVViewer {
  const root = new Object3D();
  root.name = 'CNC';
  const tip = child(root, 'Tip');
  const twin = child(root, 'Tip_1');
  twin.userData._rvOrigName = 'Tip';
  const nozzle = child(root, 'Nozzle_3');
  nozzle.userData._rvOrigName = 'Nozzle:3';
  const proc = child(root, 'Maintenance', { LogicStep_MaintenanceProcedure: {} });
  const step = child(proc, '05 Step', { LogicStep_MaintenanceStep: {}, LogicStep_Effect: {} });
  const entries: Array<[string, Object3D]> = [
    ['CNC/Tip', tip], ['CNC/Tip_1', twin], ['CNC/Nozzle_3', nozzle],
    ['CNC/Maintenance', proc], ['CNC/Maintenance/05 Step', step],
  ];
  return {
    currentModelRoot: root,
    registry: {
      forEachNode: (cb: (p: string, n: Object3D) => void) => entries.forEach(([p, n]) => cb(p, n)),
      getNode: (p: string) => entries.find(([q]) => q === p)?.[1] ?? null,
    },
  } as unknown as RVViewer;
}

afterEach(() => { cleanup(); setActiveEditTarget(null); });

describe('plan-522 §9.8 — reference targets from the web schema', () => {
  it('maintenance fields: node target, list mode for componentRefArray', () => {
    expect(webSchemaReferenceOf('LogicStep_Effect', 'Anchors')).toEqual({ target: { kind: 'node' }, array: true });
    expect(webSchemaReferenceOf('LogicStep_MaintenanceStep', 'HighlightTargets')).toEqual({ target: { kind: 'node' }, array: true });
    const fields = pickableReferenceFields('LogicStep_Effect').map((f) => [f.field, f.array]);
    expect(fields).toEqual([['Anchors', true], ['ReducedAnchors', true]]);
    // A list field is never answered as a single reference.
    expect(referenceTargetOf('LogicStep_Effect', 'Anchors')).toBeNull();
    // Value fields stay value fields.
    expect(webSchemaReferenceOf('LogicStep_Effect', 'Intensity')).toBeNull();
  });

  it('existing rv-ODT fields are unchanged', () => {
    expect(referenceTargetOf('LogicStep_DriveTo', 'drive')).toEqual({ kind: 'component', componentType: 'Drive' });
    expect(webSchemaReferenceOf('LogicStep_DriveTo', 'drive')).toBeNull();
    for (const f of pickableReferenceFields('LogicStep_DriveTo')) expect(f.array).toBe(false);
    const body = referenceTargetOf('KinematicJoint', 'BodyA');
    expect(body?.kind).not.toBe('node');
  });
});

describe('plan-522 §9.8 — ReferencePickerRow list mode', () => {
  const nodeRef = (path: string) => ({ type: 'ComponentReference', path, componentType: '' });

  it('Add appends the authored path with componentType "", a twin is not selectable', () => {
    const onEdit = vi.fn();
    render(
      <ReferencePickerRow
        fieldName="Anchors"
        value={[nodeRef('Tip')]}
        target={{ kind: 'node' }}
        array
        viewer={makeViewer()}
        nodePath="CNC/Maintenance/05 Step"
        onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const listbox = screen.getByRole('listbox');
    const opts = within(listbox).getAllByRole('option');
    const labels = opts.map((o) => o.textContent);
    // The owner is not a candidate; the present Tip is not offered again …
    expect(labels).not.toContain('05 Step');
    const nozzle = opts.find((o) => o.textContent === 'Nozzle:3')!;
    fireEvent.click(nozzle);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit.mock.calls[0][0]).toEqual([nodeRef('Tip'), nodeRef('Nozzle:3')]);
  });

  it('an ambiguous twin path is listed disabled and never written', () => {
    const onEdit = vi.fn();
    render(
      <ReferencePickerRow
        fieldName="Anchors" value={[]} target={{ kind: 'node' }} array
        viewer={makeViewer()} nodePath="CNC/Maintenance/05 Step" onEdit={onEdit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox'));
    const tip = within(screen.getByRole('listbox')).getAllByRole('option').find((o) => o.textContent === 'Tip')!;
    expect(tip.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(tip);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('the chip cross removes the reference', () => {
    const onEdit = vi.fn();
    render(
      <ReferencePickerRow
        fieldName="Anchors" value={[nodeRef('Tip'), nodeRef('Nozzle:3')]} target={{ kind: 'node' }} array
        viewer={makeViewer()} nodePath="CNC/Maintenance/05 Step" onEdit={onEdit}
      />,
    );
    const chip = screen.getByTitle('Tip');
    fireEvent.click(within(chip).getByTestId('CancelIcon'));
    expect(onEdit).toHaveBeenCalledWith([nodeRef('Nozzle:3')]);
  });
});

describe('plan-522 §9.8 — Save current view', () => {
  const baseTarget = (): EditTarget => ({
    available: true,
    setField: vi.fn(),
    unsetField: vi.fn(),
    withTransaction: async (_l, fn) => { await fn(); },
  });

  it('renders nothing without captureView', () => {
    setActiveEditTarget(baseTarget());
    const { container } = render(<MaintenanceViewRow onEdit={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('writes CameraPosition / CameraTarget from captureView()', async () => {
    setActiveEditTarget({ ...baseTarget(), captureView: () => ({ position: [1, 2, 3], target: [4, 5, 6] }) });
    const onEdit = vi.fn();
    render(<MaintenanceViewRow onEdit={onEdit} />);
    fireEvent.click(screen.getByText('Save current view'));
    await Promise.resolve();
    expect(onEdit).toHaveBeenCalledWith('CameraPosition', { x: 1, y: 2, z: 3 });
    expect(onEdit).toHaveBeenCalledWith('CameraTarget', { x: 4, y: 5, z: 6 });
    onEdit.mockClear();
    fireEvent.click(screen.getByText('Clear view'));
    await Promise.resolve();
    expect(onEdit).toHaveBeenCalledWith('CameraPosition', { x: 0, y: 0, z: 0 });
  });
});
