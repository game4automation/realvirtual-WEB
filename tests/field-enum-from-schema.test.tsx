// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Enum fields render as a dropdown when the SCHEMA says so — not only when the
 * field name happens to be in the hand-kept `ENUM_FIELDS` list.
 *
 * Before 2026-09-07 `FieldRow` guessed the type from the value alone, so every
 * enum rv-odt.json declares outside that list (RibbonRoller.Axis, RibbonSide,
 * SpinMode, TravelAxis, SpeedSource, ...) was a free text box that accepted "Q".
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../src/core/engine/rv-signal-construction';
import { FieldRow } from '../src/core/hmi/rv-field-row';
import { loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';

afterEach(cleanup);

function renderRow(fieldName: string, value: unknown, descriptor?: Parameters<typeof FieldRow>[0]['descriptor']) {
  const onEdit = vi.fn();
  render(
    <FieldRow
      fieldName={fieldName}
      value={value}
      status="consumed"
      isOverridden={false}
      onEdit={onEdit}
      onReset={() => {}}
      viewer={null}
      signalStore={null}
      descriptor={descriptor}
    />,
  );
  return onEdit;
}

describe('FieldRow enum from schema', () => {
  it('renders a schema enum as a Select with the enumMap keys as options', () => {
    const schema = loadSchemaFromSpec('RibbonRoller');
    expect(schema.Axis.type).toBe('enum');
    const onEdit = renderRow('Axis', 'X', schema.Axis);

    const select = screen.getByRole('combobox');
    expect(select.textContent).toBe('X');
    fireEvent.mouseDown(select);
    const names = screen.getAllByRole('option').map(o => o.textContent);
    expect(names).toEqual(['X', 'Y', 'Z']);

    fireEvent.click(screen.getByRole('option', { name: 'Z' }));
    expect(onEdit).toHaveBeenCalledWith('Z');
  });

  it('covers the ribbon enums the ENUM_FIELDS list never knew', () => {
    const schema = loadSchemaFromSpec('RibbonRoller');
    for (const [field, value] of [['RibbonSide', 'Auto'], ['SpinMode', 'Transform']] as const) {
      cleanup();
      renderRow(field, value, schema[field]);
      expect(screen.getByRole('combobox').textContent).toBe(value);
      expect(screen.queryByRole('textbox')).toBeNull();
    }
  });

  it('keeps a value the schema does not list selectable instead of an out-of-range Select', () => {
    const schema = loadSchemaFromSpec('RibbonRoller');
    renderRow('Axis', 'W', schema.Axis);
    const select = screen.getByRole('combobox');
    expect(select.textContent).toBe('W');
    fireEvent.mouseDown(select);
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['W', 'X', 'Y', 'Z']);
  });

  it('still falls back to the name-keyed list without a descriptor (Direction)', () => {
    renderRow('Direction', 'RotationX', undefined);
    expect(screen.getByRole('combobox').textContent).toBe('RotationX');
  });

  it('leaves a plain string field without enum descriptor as a text editor', () => {
    renderRow('Label', 'hello', { type: 'string' });
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
