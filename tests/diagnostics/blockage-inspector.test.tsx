// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BlockageBudgetFieldRenderer } from '../../src/core/hmi/rv-blockage-budget-field-renderer';
import { ComponentSection } from '../../src/core/hmi/rv-component-section';
import { getSignalSlotFields, loadSchemaFromSpec, getCapabilities } from '../../src/core/engine/rv-component-registry';
afterEach(cleanup);
function field(fieldName: string, value: unknown) {
  const onEdit = vi.fn();
  render(<BlockageBudgetFieldRenderer fieldName={fieldName} value={value} nodePath="Line"
    componentType="BlockageBudget" viewer={null} signalStore={null} onEdit={onEdit} />);
  return onEdit;
}
it('shows seconds and rejects idle below wait at the field', () => {
  const edit = field('MaxIdleSec', 120);
  expect(screen.getByText('s')).toBeTruthy();
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '59' } }); fireEvent.blur(input);
  expect(screen.getByRole('alert').textContent).toContain('at least Max Wait'); expect(edit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '60' } }); fireEvent.blur(input);
  expect(edit).toHaveBeenCalledWith(60);
});
it('clears to inheritance and shows inherited value and source', () => {
  const edit = field('MaxWaitSec', 80);
  const input = screen.getByRole('textbox');
  expect(input.getAttribute('placeholder')).toBe('60 s (default)');
  fireEvent.change(input, { target: { value: '' } }); fireEvent.blur(input);
  expect(edit).toHaveBeenCalledWith(null);
});
it('rejects negative warmup and accepts decimal commas', () => {
  const edit = field('WarmupSec', 30); const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '-1' } }); fireEvent.blur(input); expect(edit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '0,5' } }); fireEvent.blur(input); expect(edit).toHaveBeenCalledWith(0.5);
});
it('offers known wait kinds as a multi-select without free text', () => {
  const edit = field('ExpectedWaits', ['charge']);
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.mouseDown(screen.getByRole('combobox'));
  expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
  fireEvent.click(screen.getByRole('option', { name: 'setup' }));
  expect(edit).toHaveBeenCalledWith(['charge', 'setup']);
});
it('uses the standard signal-slot rows and exposes inherited fields on an empty declaration', () => {
  const data = {};
  render(<ComponentSection nodePath="Line" componentType="BlockageBudget" data={data}
    overriddenFields={new Set()} consumedOnly viewer={null} signalStore={null}
    onFieldEdit={vi.fn()} onFieldReset={vi.fn()} onResetComponent={vi.fn()} />);
  expect(screen.getByLabelText('Max Idle')).toBeTruthy();
  for (const field of ['SignalSuppress', 'SignalBlockageFound']) {
    expect(screen.getByTestId(`slot-row-.-mapped-signal-${field}`)).toBeTruthy();
  }
  expect(data).toEqual({});
  expect(getSignalSlotFields('BlockageBudget').map(s => s.field)).toEqual(['SignalSuppress', 'SignalBlockageFound']);
  expect(loadSchemaFromSpec('BlockageBudget').ExpectedWaits.type).toBe('json');
  expect(loadSchemaFromSpec('BlockageBudget').MaxIdleSec).toMatchObject({ type: 'number', unit: 's' });
  expect(getCapabilities('BlockageBudget')).toMatchObject({ claimsNode: false, pick: 'none' });
});
