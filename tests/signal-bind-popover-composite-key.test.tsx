// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SignalBindPopover,
  type PickerSignal,
  type SlotRow,
} from '../src/plugins/signal-bind/SignalBindPopover';

const SIGNALS: PickerSignal[] = [
  { name: 'Forward', interfaceId: 'connect', direction: 'output', dataType: 'PLCOutputBool' },
  { name: 'Motor.A', interfaceId: 'connect', direction: 'output', dataType: 'PLCOutputBool' },
  { name: 'Motor.B', interfaceId: 'connect', direction: 'output', dataType: 'PLCOutputBool' },
];

afterEach(cleanup);

function row(componentPath: string, signal?: string): SlotRow {
  return {
    kind: 'direct-property',
    componentPath,
    slot: 'Forward',
    type: 'bool',
    direction: 'plcOutput',
    aliases: [],
    mapping: signal ? {
      kind: 'direct-property',
      componentPath,
      slot: 'Forward',
      signal,
      interfaceId: 'connect',
      direction: 'plcOutput',
      enabled: true,
    } : undefined,
  };
}

function props(overrides: Partial<Parameters<typeof SignalBindPopover>[0]> = {}) {
  return {
    label: 'Cell',
    slots: [row('DriveA'), row('DriveB')],
    signals: SIGNALS,
    state: 'unbound' as const,
    onBind: vi.fn(),
    onUnbind: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function pickSignal(componentPath: string, signal: string): void {
  const target = screen.getByTestId(`slot-row-${componentPath}-direct-property-Forward`);
  fireEvent.click(within(target).getByLabelText('signal for Forward'));
  fireEvent.click(screen.getByRole('option', { name: signal }));
}

describe('SignalBindPopover composite-key persistence', () => {
  it('renders two same-slot component instances as independent composite-key rows', () => {
    render(<SignalBindPopover {...props()} />);
    expect(screen.getByTestId('slot-row-DriveA-direct-property-Forward')).toBeTruthy();
    expect(screen.getByTestId('slot-row-DriveB-direct-property-Forward')).toBeTruthy();
    expect(document.querySelectorAll('[data-rv-slot-kind="direct-property"]')).toHaveLength(2);
  });

  it('picker state targets the exact componentPath + kind + slot row', () => {
    const onBind = vi.fn();
    render(<SignalBindPopover {...props({ onBind })} />);
    pickSignal('DriveB', 'Motor.B');
    expect(onBind).toHaveBeenCalledWith(
      'Forward',
      'Motor.B',
      'plcOutput',
      expect.objectContaining({ interfaceId: 'connect' }),
      'DriveB',
      'direct-property',
    );
  });

  it('replacing one mapping does not address the same-named sibling row', () => {
    const onBind = vi.fn();
    render(<SignalBindPopover {...props({
      slots: [row('DriveA', 'Motor.A'), row('DriveB', 'Motor.B')],
      onBind,
    })} />);
    fireEvent.click(within(screen.getByTestId('slot-row-DriveA-direct-property-Forward'))
      .getByLabelText('change signal for Forward'));
    fireEvent.click(screen.getByRole('option', { name: 'Forward' }));
    expect(onBind.mock.calls[0].slice(4)).toEqual(['DriveA', 'direct-property']);
  });

  // Auto-assign moved to the component-section header actions (plan-325 F5);
  // its componentPath scoping is covered by tests/bulk-actions-header.test.tsx.

  it('unbind identifies only the selected composite-key row', () => {
    const onUnbind = vi.fn();
    render(<SignalBindPopover {...props({
      slots: [row('DriveA', 'Motor.A'), row('DriveB', 'Motor.B')],
      onUnbind,
    })} />);
    fireEvent.click(within(screen.getByTestId('slot-row-DriveA-direct-property-Forward'))
      .getByLabelText('unbind Forward'));
    expect(onUnbind).toHaveBeenCalledWith('Forward', 'DriveA', 'direct-property');
  });

  it('serialized mappings restore to their matching component identities', () => {
    const serialized = JSON.stringify([
      row('DriveA', 'Motor.A').mapping,
      row('DriveB', 'Motor.B').mapping,
    ]);
    const restored = JSON.parse(serialized) as SlotRow['mapping'][];
    expect(restored.map(mapping => `${mapping?.componentPath}:${mapping?.signal}`).sort())
      .toEqual(['DriveA:Motor.A', 'DriveB:Motor.B']);
  });

  it('shows pending as its own public state, not disconnected', () => {
    render(<SignalBindPopover {...props({ state: 'pending' })} />);
    expect(screen.getByTestId('signal-bind-state').textContent).toContain('Pending');
    expect(screen.getByTestId('signal-bind-state').textContent).not.toContain('disconnected');
  });
});
