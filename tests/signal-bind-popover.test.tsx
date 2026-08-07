// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.6 signal-bind-popover — the picker renders slots and binds.
 *
 * Per the plan §9.6 "Falle": render ONLY the pure content `SignalBindPopover`,
 * NOT the AnchoredPopover wrapper (which needs useViewer()/projectPointToScreen).
 * The viewer side is passed as plain props (pattern: camera-startpos-tab.test.tsx).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { SignalBindPopover, type PickerSignal } from '../src/plugins/signal-bind/SignalBindPopover';
import { mapDiscoveredDirection } from '../src/plugins/signal-bind/signal-bind-store';

const SLOTS = [
  { slot: 'Flow.Run', type: 'bool' as const, direction: 'plcInput' as const, aliases: ['run', 'start'] },
  { slot: 'Flow.Occupied', type: 'bool' as const, direction: 'plcOutput' as const, aliases: ['occupied'] },
];

// Since plan-341 the picker asks the SAME question the drop asks, so a fixture
// signal must be as complete as a real one: a PLC type (or the kind cannot be
// derived) and provider identity (or it is genuinely unbindable).
const SIGNALS: PickerSignal[] = [
  { name: 'Motor.Run', direction: 'input', dataType: 'PLCInputBool', interfaceId: 'iface-1' },
  { name: 'Cell.Occupied', direction: 'output', dataType: 'PLCOutputBool', interfaceId: 'iface-1' },
  // exact alias match for the Flow.Run slot
  { name: 'Run', direction: 'input', dataType: 'PLCInputBool', interfaceId: 'iface-1' },
];

afterEach(() => cleanup());

describe('SignalBindPopover — content', () => {
  it('renders one row per slot, grouped into Input and Output sections', () => {
    render(
      <SignalBindPopover
        label="Conveyor_03" slots={SLOTS} signals={SIGNALS} state="unbound"
        onBind={vi.fn()} onUnbind={vi.fn()} onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('slot-row-Flow.Run')).toBeTruthy();
    expect(screen.getByTestId('slot-row-Flow.Occupied')).toBeTruthy();
    // Direction is conveyed by PLC-angle group headers now (no per-row →PLC/PLC→ badge).
    expect(screen.getByText('PLC Inputs')).toBeTruthy();
    expect(screen.getByText('PLC Outputs')).toBeTruthy();
  });

  it('selecting a signal calls onBind with the mapped direction', async () => {
    const onBind = vi.fn();
    render(
      <SignalBindPopover
        label="Conveyor_03" slots={SLOTS} signals={SIGNALS} state="unbound"
        onBind={onBind} onUnbind={vi.fn()} onClose={vi.fn()}
      />,
    );
    // Open the Flow.Run link → search overlay → pick Motor.Run.
    fireEvent.click(within(screen.getByTestId('slot-row-Flow.Run')).getByLabelText('signal for Flow.Run'));
    const search = await screen.findByPlaceholderText('Search name, address, comment…');
    fireEvent.change(search, { target: { value: 'Motor' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Motor.Run' }));
    // The provider-identified pick carries its source through (plan-325 F11).
    expect(onBind).toHaveBeenCalledWith(
      'Flow.Run', 'Motor.Run', 'plcInput',
      expect.objectContaining({ name: 'Motor.Run', interfaceId: 'iface-1' }),
    );
  });

  // Auto-assign / Unbind-all moved to the component-section header actions
  // (plan-325 F5) — covered by tests/bulk-actions-header.test.tsx.
  it('renders no bulk footer actions anymore (plan-325 F5)', () => {
    render(
      <SignalBindPopover
        label="X" slots={SLOTS} signals={SIGNALS} state="live"
        onBind={vi.fn()} onUnbind={vi.fn()} onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText('Auto-assign')).toBeNull();
    expect(screen.queryByText('Unbind all')).toBeNull();
  });

  it('renders an empty-state when the element has no bindable slots', () => {
    render(
      <SignalBindPopover
        label="X" slots={[]} signals={SIGNALS} state="unbound"
        onBind={vi.fn()} onUnbind={vi.fn()} onClose={vi.fn()}
      />,
    );
    expect(screen.getByText(/No bindable signals/i)).toBeTruthy();
  });
});

describe('mapDiscoveredDirection', () => {
  it('maps CONNECT input/output to plcInput/plcOutput, unknown → slot default', () => {
    expect(mapDiscoveredDirection('output', 'plcInput')).toBe('plcOutput');
    expect(mapDiscoveredDirection('input', 'plcOutput')).toBe('plcInput');
    expect(mapDiscoveredDirection('unknown', 'plcOutput')).toBe('plcOutput');
    expect(mapDiscoveredDirection('unknown', 'plcInput')).toBe('plcInput');
  });
});
