// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * picker-listbox-a11y.test.tsx — plan-341 §9.11.
 *
 * The signal picker as an APG combobox: the search field keeps focus and owns
 * every key, the virtualized list is a listbox of options that are never
 * focusable, and the active option is pointed at with `aria-activedescendant`.
 *
 * The interesting assertions are the ones a "looks accessible" review misses:
 * ordinals that skip group headers, an active descendant that still resolves
 * after a filter change, and two independently mounted overlays whose option
 * ids cannot collide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import {
  SignalSearchOverlay,
  type SignalSearchItem,
} from '../src/core/hmi/SignalSearchOverlay';
import { dropRejectText, type DropRejectReason } from '../src/plugins/signal-bind/drop-accept';

/** Two CONNECT signals and two model signals → the list renders TWO group headers. */
const SIGNALS: SignalSearchItem[] = [
  { name: 'MC07_Start', direction: 'output', plcType: 'PLCOutputBool', origin: 'connect' },
  { name: 'MC07_Stop', direction: 'output', plcType: 'PLCOutputBool', origin: 'connect' },
  { name: 'Conveyor.Run', direction: 'input', plcType: 'PLCInputBool', origin: 'internal' },
  { name: 'Conveyor.Speed', direction: 'input', plcType: 'PLCInputFloat', origin: 'internal' },
];

const TYPE_REASON: DropRejectReason = { kind: 'type', expected: 'bool', got: 'float' };

/** Refuse exactly the float signal, the way a bool slot would. */
function rejectFloats(item: SignalSearchItem): DropRejectReason | null {
  return item.plcType?.endsWith('Float') ? TYPE_REASON : null;
}

/**
 * A controlled host: `onClose` really closes, so Escape can be observed all the
 * way through unmount to the focus landing back on the trigger.
 */
function Host({
  onPick = vi.fn(),
  getRejectReason,
  signals = SIGNALS,
  label = 'Link Flow.Run',
}: {
  onPick?: (name: string, item?: SignalSearchItem) => void;
  getRejectReason?: (item: SignalSearchItem) => DropRejectReason | null;
  signals?: SignalSearchItem[];
  label?: string;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        ref={setAnchor}
        onClick={() => setOpen(true)}
        data-testid={`trigger-${label}`}
      >
        {label}
      </button>
      <SignalSearchOverlay
        open={open}
        anchorEl={anchor}
        onClose={() => setOpen(false)}
        signals={signals}
        onPick={onPick}
        title={label}
        getRejectReason={getRejectReason}
      />
    </>
  );
}

/** Open one host's picker and return its combobox + listbox. */
function openPicker(label = 'Link Flow.Run'): { input: HTMLElement; list: HTMLElement } {
  fireEvent.click(screen.getByTestId(`trigger-${label}`));
  const input = screen.getByRole('combobox', { name: label });
  const list = screen.getByRole('listbox', { name: label });
  return { input, list };
}

function activeOption(input: HTMLElement): HTMLElement | null {
  const id = input.getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

/**
 * Reveal the options the slot refuses. Since the User decision of 30.07. the
 * picker opens with COMPATIBLE options only; the refused ones live one click
 * away behind the footer, still carrying their reason. Every assertion about a
 * refused option therefore starts here.
 */
function showRefused(): void {
  fireEvent.click(screen.getByTestId('signal-picker-show-all'));
}

beforeEach(() => { document.body.innerHTML = ''; });
afterEach(() => cleanup());

describe('picker listbox — roles and focus ownership', () => {
  it('the search field is the combobox and keeps focus; the list is not focusable', () => {
    render(<Host />);
    const { input, list } = openPicker();

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe(list.id);
    expect(document.activeElement).toBe(input);

    // Neither the list nor any option may be a tab stop — arrowing must never
    // move real focus into a virtualized list, whose rows can unmount on scroll.
    expect(list.hasAttribute('tabindex')).toBe(false);
    for (const option of within(list).getAllByRole('option')) {
      expect(option.hasAttribute('tabindex')).toBe(false);
    }
  });

  it('arrow keys move the active descendant, not the DOM focus', () => {
    render(<Host />);
    const { input } = openPicker();

    expect(activeOption(input)?.getAttribute('aria-label')).toBe('MC07_Start');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption(input)?.getAttribute('aria-label')).toBe('MC07_Stop');
    fireEvent.keyDown(input, { key: 'End' });
    expect(activeOption(input)?.getAttribute('aria-label')).toBe('Conveyor.Speed');
    fireEvent.keyDown(input, { key: 'Home' });
    expect(activeOption(input)?.getAttribute('aria-label')).toBe('MC07_Start');

    expect(document.activeElement).toBe(input);
  });

  it('Enter picks the active option', () => {
    const onPick = vi.fn();
    render(<Host onPick={onPick} />);
    const { input } = openPicker();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('MC07_Stop', expect.objectContaining({ name: 'MC07_Stop' }));
  });
});

describe('picker listbox — set position without group headers', () => {
  it('counts items only, across both groups', () => {
    render(<Host />);
    const { list } = openPicker();

    // Two headers are rendered; the ordinals must not know about them.
    expect(within(list).getAllByText(/CONNECT \(live\)|Model signals/).length).toBe(2);

    const options = within(list).getAllByRole('option');
    expect(options.length).toBe(4);
    expect(options.map((o) => o.getAttribute('aria-posinset'))).toEqual(['1', '2', '3', '4']);
    for (const option of options) {
      expect(option.getAttribute('aria-setsize')).toBe('4');
    }
  });

  it('opens with the fitting signals only and offers the rest by count', () => {
    render(<Host getRejectReason={rejectFloats} />);
    const { list } = openPicker();

    // The float is gone: three of four signals fit the bool slot.
    expect(within(list).queryByRole('option', { name: 'Conveyor.Speed' })).toBeNull();
    expect(within(list).getAllByRole('option').length).toBe(3);

    const footer = screen.getByTestId('signal-picker-show-all');
    expect(footer.textContent).toBe('1 signal does not fit — show');

    showRefused();
    expect(within(list).getByRole('option', { name: 'Conveyor.Speed' })).toBeTruthy();
    expect(screen.getByTestId('signal-picker-show-all').textContent)
      .toBe('Hide signals that do not fit');
  });

  it('an option refused by the slot is aria-disabled and says why', () => {
    render(<Host getRejectReason={rejectFloats} />);
    const { list } = openPicker();
    showRefused();

    const float = within(list).getByRole('option', { name: 'Conveyor.Speed' });
    expect(float.getAttribute('aria-disabled')).toBe('true');

    // The reason is a DESCRIPTION, verbatim from the one shared formatter, so
    // the tooltip and this option cannot drift apart.
    const describedBy = float.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(dropRejectText(TYPE_REASON));

    // Accepted options carry no disabled state and no description.
    const bool = within(list).getByRole('option', { name: 'MC07_Start' });
    expect(bool.hasAttribute('aria-disabled')).toBe(false);
    expect(bool.hasAttribute('aria-describedby')).toBe(false);
  });

  it('a duplicate-name conflict is aria-disabled, not merely dimmed', () => {
    render(<Host signals={[{ ...SIGNALS[0], conflict: true }]} />);
    const { list } = openPicker();
    showRefused();
    expect(within(list).getByRole('option', { name: 'MC07_Start' }).getAttribute('aria-disabled'))
      .toBe('true');
  });

  it('Enter on a refused option does nothing', () => {
    const onPick = vi.fn();
    render(<Host onPick={onPick} getRejectReason={rejectFloats} />);
    const { input } = openPicker();
    showRefused();
    fireEvent.keyDown(input, { key: 'End' }); // Conveyor.Speed — the float
    expect(activeOption(input)?.getAttribute('aria-label')).toBe('Conveyor.Speed');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('picker listbox — filtering', () => {
  it('the active descendant stays resolvable after a filter change', async () => {
    render(<Host />);
    const { input } = openPicker();
    fireEvent.keyDown(input, { key: 'End' }); // ordinal 3, about to disappear

    fireEvent.change(input, { target: { value: 'MC07' } });
    await waitFor(() => expect(screen.getAllByRole('option').length).toBe(2));

    // Never left dangling: the attribute points at an element that exists, and
    // a filter change snaps back to the top of the new result set.
    const active = activeOption(input);
    expect(active).not.toBeNull();
    expect(active!.getAttribute('aria-label')).toBe('MC07_Start');
    expect(active!.getAttribute('aria-posinset')).toBe('1');
    expect(screen.getAllByRole('option')[0].getAttribute('aria-setsize')).toBe('2');
  });

  it('an empty result set REMOVES the active descendant instead of pointing nowhere', async () => {
    render(<Host />);
    const { input } = openPicker();
    fireEvent.change(input, { target: { value: 'nothing-matches-this' } });

    await waitFor(() => expect(screen.getByText('No matches')).toBeTruthy());
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(screen.queryAllByRole('option').length).toBe(0);

    // Keys on an empty list are inert, not a crash.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });
});

describe('picker listbox — Escape and focus return', () => {
  it('Escape closes and hands focus back to the assignment cell', async () => {
    render(<Host />);
    const trigger = screen.getByTestId('trigger-Link Flow.Run');
    const { input } = openPicker();
    expect(document.activeElement).toBe(input);

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('picker listbox — two overlays at once', () => {
  it('option ids are namespaced per instance and never cross-resolve', () => {
    // The real reason for the namespaced scheme: SignalBindPopover and
    // InlineSignalSlots mount this overlay independently, and a global
    // `sigopt-{i}` would make one combobox point at the other one's row.
    render(
      <>
        <Host label="Link Flow.Run" />
        <Host label="Link Forward" />
      </>,
    );
    const a = openPicker('Link Flow.Run');
    const b = openPicker('Link Forward');

    // Queried through the DOM, not through the accessibility tree: MUI's Modal
    // marks the first popover `aria-hidden` once the second opens, while
    // `aria-activedescendant` resolves by plain id and does NOT care — which is
    // exactly the collision the namespaced scheme exists to prevent.
    const optionIds = (list: HTMLElement): string[] =>
      [...list.querySelectorAll('[role="option"]')].map((o) => o.id);

    expect(a.list.id).not.toBe(b.list.id);
    const idsA = optionIds(a.list);
    const idsB = optionIds(b.list);
    expect(idsA.length).toBe(SIGNALS.length);
    expect(idsA.every((id) => id.length > 0)).toBe(true);
    expect(new Set([...idsA, ...idsB]).size).toBe(idsA.length + idsB.length);

    // Each combobox's active descendant lives inside ITS OWN listbox.
    fireEvent.keyDown(b.input, { key: 'ArrowDown' });
    expect(a.list.contains(activeOption(a.input))).toBe(true);
    expect(b.list.contains(activeOption(b.input))).toBe(true);
    expect(activeOption(a.input)).not.toBe(activeOption(b.input));

    // Every option id is document-unique, which is what makes the above hold.
    const all = [...document.querySelectorAll('[role="option"]')].map((o) => o.id);
    expect(new Set(all).size).toBe(all.length);
  });
});
