// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.6 — editability contract:
 *  - isFieldEditable opens ONLY for signal references (isSignalRefType);
 *    sensor/other structural references stay read-only.
 *  - Rendering-precedence invariant (S3/S4): signal-slot fields never render a
 *    generic FieldRow editor (a null Forward would otherwise become a 'string'
 *    editor) and NEVER call onFieldEdit/onFieldReset.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '../src/core/engine/rv-signal-construction';
import { FieldRow, isFieldEditable } from '../src/core/hmi/rv-field-row';
import { isSignalRefType, isSensorRefType } from '../src/core/hmi/rv-inspector-helpers';
import { ComponentSection } from '../src/core/hmi/rv-component-section';

afterEach(cleanup);

describe('isFieldEditable signal-ref opening (plan-325 9.6)', () => {
  it('stays false for plain references, opens for signal references', () => {
    // Pre-plan-325 behavior unchanged for structural refs …
    expect(isFieldEditable('consumed', true, { type: 'componentRef' })).toBe(false);
    // … and opens when the reference is a signal ref (Unlink/Change path).
    expect(isFieldEditable('consumed', true, { type: 'componentRef', signal: 'PLCOutputBool' }, true)).toBe(true);
    // Sensor refs are never signal refs.
    expect(isSignalRefType('PLCOutputBool')).toBe(true);
    expect(isSignalRefType('Sensor')).toBe(false);
    expect(isSensorRefType('Sensor')).toBe(true);
    expect(isFieldEditable('consumed', true, { type: 'componentRef' }, isSignalRefType('Sensor'))).toBe(false);
  });

  it('keeps readonly/DES descriptors closed even for signal refs', () => {
    expect(isFieldEditable('consumed', true, { type: 'componentRef', signal: 'PLCOutputBool', readonly: true }, true)).toBe(false);
    expect(isFieldEditable('consumed', true, { type: 'componentRef', signal: 'PLCOutputBool', scope: 'des' }, true)).toBe(false);
  });
});

describe('FieldRow accessibility floor (plan-325 Phase 5)', () => {
  it('labels the reset dot and keeps its hit target at least 24px', () => {
    const onReset = vi.fn();
    render(<FieldRow
      fieldName="ScaleSpeed"
      value={1}
      status="consumed"
      isOverridden
      onEdit={vi.fn()}
      onReset={onReset}
      viewer={null}
      signalStore={null}
    />);

    const reset = screen.getByLabelText('reset ScaleSpeed to default');
    expect(reset.getAttribute('title')).toBe('Reset to default');
    const rect = reset.getBoundingClientRect();
    expect(rect.width).toBeGreaterThanOrEqual(24);
    expect(rect.height).toBeGreaterThanOrEqual(24);
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});

describe('rendering precedence invariant (plan-325 S3/S4)', () => {
  it('renders NO generic editor for a null signal-slot field and never calls onFieldEdit', () => {
    const onFieldEdit = vi.fn();
    const onFieldReset = vi.fn();
    render(<ComponentSection
      nodePath="Axis"
      componentType="Drive_Simple"
      data={{ Forward: null, ScaleSpeed: 1 }}
      overriddenFields={new Set<string>()}
      consumedOnly
      onFieldEdit={onFieldEdit}
      onFieldReset={onFieldReset}
      onResetComponent={vi.fn()}
      viewer={null}
      signalStore={null}
    />);

    // The signal slot renders as a SignalSlotRow (read-only without a viewer) …
    const row = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    expect(row.textContent).toContain('not linked');
    // … not as a text editor (inferFieldType(null) would say 'string').
    expect(row.querySelector('input')).toBeNull();

    // Clicking around the row never reaches the field-edit pipeline.
    fireEvent.click(row);
    expect(onFieldEdit).not.toHaveBeenCalled();
    expect(onFieldReset).not.toHaveBeenCalled();
  });

  it('keeps ordinary fields on the FieldRow pipeline', () => {
    render(<ComponentSection
      nodePath="Axis"
      componentType="Drive_Simple"
      data={{ ScaleSpeed: 1 }}
      overriddenFields={new Set<string>()}
      consumedOnly
      onFieldEdit={vi.fn()}
      onFieldReset={vi.fn()}
      onResetComponent={vi.fn()}
      viewer={null}
      signalStore={null}
    />);
    expect(screen.getByTitle('ScaleSpeed')).toBeTruthy();
    expect(screen.queryByTestId('slot-row-.-mapped-signal-ScaleSpeed')).toBeNull();
  });
});
