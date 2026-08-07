// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { computeAutoBindSuggestions } from '../src/plugins/signal-bind/auto-bind';
import { SignalBindPopover } from '../src/plugins/signal-bind/SignalBindPopover';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';

afterEach(cleanup);

const slot: ResolvedSlot = {
  slot: 'Flow.Run', targetName: 'Machine.Flow.Run', type: 'bool', direction: 'plcInput',
  aliases: ['Run'], instance: null,
};

describe('auto-bind confirmation contract', () => {
  it('returns provenance-carrying suggestions without activating mappings', () => {
    const suggestions = computeAutoBindSuggestions([slot], new Set(), [{
      name: 'Run', interfaceId: 'mqtt-main', topic: 'line/run', direction: 'input',
    }]);

    expect(suggestions).toEqual([expect.objectContaining({
      slot: 'Flow.Run', signal: 'Run', interfaceId: 'mqtt-main', topic: 'line/run',
    })]);
    expect(suggestions[0]).not.toHaveProperty('enabled');
  });

  // `dataType` is not decoration: since plan-341 Phase 2 the picker asks the
  // same question the drop asks (one `slotRejectReason` for click, Enter and
  // drag), and a signal whose PLC type cannot be derived is refused with
  // "underivable type" — it would render `aria-disabled` and swallow the click.
  // Real CONNECT and model signals always carry a type, so a typeless fixture
  // signal tested nothing but the reject path.
  it('does not activate another slot when the user makes a manual binding', () => {
    const onBind = vi.fn();
    render(<SignalBindPopover
      label="Machine"
      slots={[slot, { ...slot, slot: 'Flow.Stop', targetName: 'Machine.Flow.Stop', aliases: ['Stop'] }]}
      signals={[
        { name: 'Run', interfaceId: 'mqtt-main', direction: 'input', dataType: 'PLCInputBool' },
        { name: 'Stop', interfaceId: 'mqtt-main', direction: 'input', dataType: 'PLCInputBool' },
      ]}
      state="unbound"
      onBind={onBind}
      onUnbind={vi.fn()}
      onClose={vi.fn()}
    />);

    fireEvent.click(within(screen.getByTestId('slot-row-Flow.Run')).getByLabelText('signal for Flow.Run'));
    fireEvent.click(screen.getByRole('option', { name: 'Run' }));

    expect(onBind).toHaveBeenCalledTimes(1);
    expect(onBind).toHaveBeenCalledWith(
      'Flow.Run', 'Run', 'plcInput', expect.objectContaining({ interfaceId: 'mqtt-main' }),
    );
  });

  // The explicit apply-confirmation flow for auto-assign moved to the
  // component-section header actions (plan-325 F5) and is covered by
  // tests/bulk-actions-header.test.tsx.
});
