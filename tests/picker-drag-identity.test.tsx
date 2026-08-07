// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * picker-drag-identity.test.tsx — plan-341 §9.5.
 *
 * A drag STARTED IN THE PICKER used to lose everything the picker knew:
 * `SignalListItem` dropped `interfaceId`/`topic`/`origin` on its way to the
 * badge, so every picker drag arrived as "CONNECT signal without a provider"
 * and was refused. Internal model signals were refused for the same reason,
 * although they legitimately have no interface at all.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SignalListItem } from '../src/core/hmi/SignalListItem';
import { SignalSearchOverlay, type SignalSearchItem } from '../src/core/hmi/SignalSearchOverlay';
import {
  getSignalDragPayload,
  cancelSignalDrag,
  consumeSignalDragClick,
} from '../src/core/hmi/signal-drag-store';
import { slotRejectReason } from '../src/plugins/signal-bind/drop-accept';

/** Shift+pointerdown on the trailing chip — the badge's drag arming path. */
function armFromChip(container: HTMLElement): void {
  const chip = container.querySelector('.MuiChip-root') as HTMLElement;
  expect(chip).toBeTruthy();
  fireEvent.pointerDown(chip, { shiftKey: true, button: 0, clientX: 10, clientY: 10 });
}

beforeEach(() => { cancelSignalDrag(); consumeSignalDragClick(); });
afterEach(() => { cancelSignalDrag(); consumeSignalDragClick(); cleanup(); });

describe('drag identity from a picker row', () => {
  it('carries provider identity (interfaceId + topic + origin)', () => {
    const { container } = render(
      <SignalListItem
        name="MC07_Start"
        direction="output"
        plcType="PLCOutputBool"
        interfaceId="mqtt-1"
        topic="Data_O_1"
        origin="connect"
      />,
    );
    armFromChip(container);
    expect(getSignalDragPayload()).toMatchObject({
      name: 'MC07_Start',
      interfaceId: 'mqtt-1',
      topic: 'Data_O_1',
      origin: 'connect',
    });
  });

  it('tags an internal model signal as internal, not as a provider-less CONNECT signal', () => {
    const { container } = render(
      <SignalListItem name="Conveyor/Flow.Run" direction="output" plcType="PLCOutputBool" origin="internal" />,
    );
    armFromChip(container);
    const payload = getSignalDragPayload()!;
    expect(payload.origin).toBe('internal');
    expect(payload.interfaceId).toBeUndefined();
    // …and it is NOT misfiled as `no-provider` by the one acceptance rule.
    expect(slotRejectReason({ type: 'bool', direction: 'plcOutput' }, payload)).toBeNull();
  });
});

describe('picker option gating (the one seam)', () => {
  const ITEMS: SignalSearchItem[] = [
    { name: 'Good', direction: 'output', plcType: 'PLCOutputBool', interfaceId: 'iface-1' },
    { name: 'WrongType', direction: 'output', plcType: 'PLCOutputFloat', interfaceId: 'iface-1' },
  ];

  it('locks selection and marks aria-disabled with the SAME reason the drop gives', async () => {
    const picked: string[] = [];
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    render(
      <SignalSearchOverlay
        open
        anchorEl={anchor}
        onClose={() => {}}
        signals={ITEMS}
        onPick={(name) => picked.push(name)}
        getRejectReason={(item) => slotRejectReason(
          { type: 'bool', direction: 'plcOutput' },
          { plcType: item.plcType, direction: item.direction, origin: item.origin ?? 'connect', interfaceId: item.interfaceId },
        )}
      />,
    );

    // Refused options are one click away since the User decision of 30.07. —
    // the picker opens with the fitting ones only.
    fireEvent.click(screen.getByTestId('signal-picker-show-all'));

    // `aria-disabled` sits on the OPTION itself since plan-341 Phase 5 — it used
    // to be on the positioning wrapper, which carries no role and where no
    // screen reader would ever look for it. The wrapper keeps the `title`,
    // because the pointer-hover reason has to cover the whole row band.
    const good = await screen.findByRole('option', { name: 'Good' });
    const wrong = await screen.findByRole('option', { name: 'WrongType' });
    expect(good.getAttribute('aria-disabled')).toBeNull();
    expect(wrong.getAttribute('aria-disabled')).toBe('true');
    // The blocked option stays VISIBLE and states its cause (F11: nothing
    // vanishes silently) — same sentence the row tooltip would show.
    expect(wrong.parentElement!.getAttribute('title')).toMatch(/Type mismatch/);

    fireEvent.click(screen.getByRole('option', { name: 'WrongType' }));
    expect(picked).toEqual([]);
    fireEvent.click(screen.getByRole('option', { name: 'Good' }));
    expect(picked).toEqual(['Good']);
    anchor.remove();
  });
});
