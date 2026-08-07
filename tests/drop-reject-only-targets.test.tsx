// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-reject-only-targets.test.tsx — plan-341 §9.3.
 *
 * `unavailable` and disabled rows used to be absent from the drop registry
 * entirely, so a drop on them died in silence: no state, no reason, no
 * explanation. They now register as REJECT-ONLY targets — always a reason,
 * always an inert `onDrop`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { SignalSlotRow, slotRowKey, type SlotRow } from '../src/core/hmi/rv-signal-slot-row';
import {
  armSignalDrag,
  updateSignalDrag,
  endSignalDrag,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import { getSignalDropHover } from '../src/core/hmi/signal-drop-hover-store';

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  origin: 'connect',
  interfaceId: 'iface-1',
};

const UNAVAILABLE: SlotRow = {
  kind: 'unavailable',
  componentPath: '.',
  slot: 'Flow.Run',
  reason: 'no runtime contract',
};

const DISABLED: SlotRow = {
  kind: 'mapped-signal',
  componentPath: '.',
  slot: 'Forward',
  type: 'bool',
  direction: 'plcOutput',
};

/** Hover the centre of a rendered row (drag still running afterwards). */
function hoverOnto(el: HTMLElement): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  act(() => {
    armSignalDrag(PAYLOAD, x - 50, y);
    updateSignalDrag(x, y);
  });
  return { x, y };
}

/** Hover, sample the live state, THEN release — the states only exist mid-drag. */
function dragOnto(el: HTMLElement): {
  dropped: boolean;
  hoverReasonKind: string | undefined;
  stateWhileHovering: string | null;
} {
  const { x, y } = hoverOnto(el);
  const hoverReasonKind = getSignalDropHover()?.reason?.kind;
  const stateWhileHovering = el.getAttribute('data-rv-drop-state');
  let dropped = false;
  act(() => { dropped = endSignalDrag(x, y) === 'dropped'; });
  return { dropped, hoverReasonKind, stateWhileHovering };
}

beforeEach(() => { cancelSignalDrag(); consumeSignalDragClick(); });
afterEach(() => { cancelSignalDrag(); consumeSignalDragClick(); cleanup(); });

describe('reject-only drop targets', () => {
  it('an unavailable row is registered, reports its reason and never drops', () => {
    const onDropSignal = vi.fn();
    render(<SignalSlotRow row={UNAVAILABLE} onDropSignal={onDropSignal} />);
    const el = screen.getByTestId('slot-row-unavailable-Flow.Run');

    const { dropped, hoverReasonKind, stateWhileHovering } = dragOnto(el);
    expect(stateWhileHovering).toBe('invalid');
    expect(hoverReasonKind).toBe('unavailable');
    expect(dropped).toBe(false);
    expect(onDropSignal).not.toHaveBeenCalled();
  });

  it('a disabled row is registered, reports its reason and never drops', () => {
    const onDropSignal = vi.fn();
    render(<SignalSlotRow row={DISABLED} onDropSignal={onDropSignal} disabledReason="Signal linking unavailable here" />);
    const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');

    const { dropped, hoverReasonKind, stateWhileHovering } = dragOnto(el);
    expect(stateWhileHovering).toBe('invalid');
    expect(hoverReasonKind).toBe('unavailable');
    expect(dropped).toBe(false);
    expect(onDropSignal).not.toHaveBeenCalled();
  });

  it('shows the reason in the reserved gutter — never colour alone', () => {
    render(<SignalSlotRow row={DISABLED} onDropSignal={vi.fn()} disabledReason="Signal linking unavailable here" />);
    const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    expect(screen.queryByTestId('slot-reject-Forward')).toBeNull();

    hoverOnto(el);
    // The 14 px gutter InspectorRow always reserved now carries the LinkOff icon.
    expect(screen.getByTestId('slot-reject-Forward')).toBeTruthy();
  });

  it('a compatible row still accepts and carries the payload through', () => {
    const onDropSignal = vi.fn();
    render(<SignalSlotRow row={DISABLED} onDropSignal={onDropSignal} />);
    const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');

    const { dropped } = dragOnto(el);
    expect(dropped).toBe(true);
    expect(onDropSignal).toHaveBeenCalledWith(
      DISABLED,
      expect.objectContaining({ name: 'MC07_Start', interfaceId: 'iface-1', origin: 'connect' }),
    );
  });

  it('describes itself under its stable row key', () => {
    render(<SignalSlotRow row={DISABLED} onDropSignal={vi.fn()} disabledReason="nope" />);
    const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    hoverOnto(el);
    expect(getSignalDropHover()?.targetId).toBe(slotRowKey(DISABLED));
  });
});
