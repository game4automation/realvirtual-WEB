// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.7 — SignalSlotRow two-column contract:
 *  - LEFT is always the slot NAME (label text, never a chip).
 *  - RIGHT covers the §2.4 states: empty / GLB-wired (+ chain indicator) /
 *    CONNECT-bound (status color WITH label) / unavailable (dimmed + reason).
 *  - keyboard: assignment cell + controls are focusable, Enter activates.
 *  - A11y floor assertions: 11px text minimum, ink >= 0.5 alpha, >= 24px
 *    interactive targets (DESIGN.md floors, plan Phase 5).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SignalSlotRow, type SlotRow } from '../src/core/hmi/rv-signal-slot-row';

afterEach(cleanup);

function row(overrides: Partial<SlotRow> = {}): SlotRow {
  return {
    kind: 'mapped-signal',
    componentPath: '.',
    slot: 'Forward',
    type: 'bool',
    direction: 'plcOutput',
    aliases: [],
    ...overrides,
  };
}

/** Parse an rgba()/rgb() color and return its alpha (1 for rgb/hex-solid). */
function alphaOf(color: string): number {
  const m = color.match(/rgba?\(([^)]+)\)/);
  if (!m) return 1;
  const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
  return parts.length === 4 ? parts[3] : 1;
}

describe('SignalSlotRow (plan-325 9.7)', () => {
  it('renders the slot name LEFT as plain label text — never a chip', () => {
    render(<SignalSlotRow row={row()} onOpenPicker={vi.fn()} />);
    const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    const label = within(el).getByTitle('Forward');
    expect(label.textContent).toBe('Forward');
    // The label cell carries no interactive chip role.
    expect(label.getAttribute('role')).toBeNull();
  });

  it('empty state: "not linked" text + link icon; picker opens from both', () => {
    const onOpenPicker = vi.fn();
    render(<SignalSlotRow row={row()} onOpenPicker={onOpenPicker} />);
    expect(screen.getByText(/not linked/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('signal for Forward'));
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByLabelText('change signal for Forward'));
    expect(onOpenPicker).toHaveBeenCalledTimes(2);
  });

  it('GLB-wired state: internal chip; CONNECT-bound adds chain indicator + liveness label', () => {
    render(<SignalSlotRow
      row={row({
        targetName: 'Cell.Forward',
        mapping: {
          kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
          signal: 'PLC.DB1.Fwd', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
        },
        liveness: 'live',
      })}
      onOpenPicker={vi.fn()}
      onUnbind={vi.fn()}
    />);
    // Internal signal stays the assignment; the CONNECT source is its own cell.
    expect(screen.getByText((c) => c.includes('Cell.Forward'))).toBeTruthy();
    expect(screen.getByTestId('slot-linked-Forward').textContent).toContain('PLC.DB1.Fwd');
    // A plainly live binding carries NO status token any more (User decision
    // 30.07.): both chips show their live value, so the word only restated
    // them — and it did so in the width the two signal names need.
    expect(screen.queryByTestId('slot-status-Forward')).toBeNull();
    expect(screen.getByLabelText('unbind Forward')).toBeTruthy();
  });

  it('internal assignment: chip of the model signal with its own CONNECT chain', () => {
    render(<SignalSlotRow
      row={row({
        targetName: 'Cell.Forward',
        mapping: {
          kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
          sourceKind: 'internal', signal: 'EntryConveyorStart', direction: 'plcOutput', enabled: true,
        },
        chainSource: 'PLC.DB1.Fwd',
        liveness: 'live',
      })}
      onOpenPicker={vi.fn()}
      onUnbind={vi.fn()}
    />);
    expect(screen.getByText((c) => c.includes('EntryConveyorStart'))).toBeTruthy();
    expect(screen.getByTestId('slot-linked-Forward').textContent).toContain('PLC.DB1.Fwd');
  });

  it('an empty slot carries a "Drop here" invitation, CSS-swapped during a drag', () => {
    render(<SignalSlotRow row={row()} onOpenPicker={vi.fn()} />);
    // Both texts exist; SIGNAL_DROP_SX shows exactly one, keyed on the row's
    // data-rv-drop-state — no React state, so a drag re-renders nothing.
    expect(screen.getByText(/not linked/).className).toContain('rv-slot-empty-text');
    expect(screen.getByText('Drop here').className).toContain('rv-slot-drop-hint');
  });

  it('unavailable state: dimmed row with the reason, no controls', () => {
    render(<SignalSlotRow row={{ kind: 'unavailable', slot: 'Speed', reason: 'Missing command contract' }} />);
    const el = screen.getByTestId('slot-row-unavailable-Speed');
    expect(el.getAttribute('data-rv-slot-kind')).toBe('unavailable');
    expect(el.textContent).toContain('Missing command contract');
    expect(screen.queryByLabelText('signal for Speed')).toBeNull();
    expect(screen.queryByLabelText('change signal for Speed')).toBeNull();
  });

  it('keyboard: the assignment cell is focusable and Enter opens the picker', () => {
    const onOpenPicker = vi.fn();
    render(<SignalSlotRow row={row()} onOpenPicker={onOpenPicker} />);
    const cell = screen.getByLabelText('change signal for Forward');
    expect(cell.getAttribute('tabindex')).toBe('0');
    cell.focus();
    fireEvent.keyDown(cell, { key: 'Enter' });
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(cell, { key: ' ' });
    expect(onOpenPicker).toHaveBeenCalledTimes(2);
  });

  // plan-341 §2.8 (c): liveness and authority collapsed into ONE status token
  // (`slot-status-<slot>`) with ONE tooltip. Without liveness the row falls to
  // priority level 8, whose label is still the plan-320 word "bound".
  it('authority display keeps the plan-320 contract (value text + testid)', () => {
    render(<SignalSlotRow
      row={row({
        targetName: 'Cell.Forward',
        mapping: {
          kind: 'mapped-signal', componentPath: '.', slot: 'Forward',
          signal: 'PLC.DB1.Fwd', interfaceId: 'plc', direction: 'plcOutput', enabled: true,
        },
        authority: 'bound',
        authorityReason: 'authority-bound',
      })}
      onOpenPicker={vi.fn()}
      onUnbind={vi.fn()}
    />);
    expect(screen.getByTestId('slot-status-Forward').textContent).toBe('bound');
  });

  it('read-only mode (no manager, A1): chip only — no link icon, no picker, no drop attrs', () => {
    const onOpenPicker = vi.fn();
    render(<SignalSlotRow row={row({ targetName: 'Cell.Forward' })} readOnly onOpenPicker={onOpenPicker} />);
    expect(screen.getByText((c) => c.includes('Cell.Forward'))).toBeTruthy();
    expect(screen.queryByLabelText('signal for Forward')).toBeNull();
    expect(screen.queryByLabelText('change signal for Forward')).toBeNull();
  });

  // ── A11y floor assertions (plan Phase 5 — own assertion group) ──
  describe('a11y floors', () => {
    it('renders no text below 11px and no ink below 0.5 alpha in the row', () => {
      render(<SignalSlotRow
        row={row({ liveness: 'pending', mapping: { kind: 'mapped-signal', componentPath: '.', slot: 'Forward', signal: 'X', interfaceId: 'p', direction: 'plcOutput', enabled: true } })}
        onOpenPicker={vi.fn()}
        onUnbind={vi.fn()}
      />);
      const el = screen.getByTestId('slot-row-.-mapped-signal-Forward');
      const texts = el.querySelectorAll('p, span');
      let checked = 0;
      for (const t of texts) {
        const style = window.getComputedStyle(t);
        const size = parseFloat(style.fontSize);
        if (!t.textContent?.trim() || Number.isNaN(size)) continue;
        checked++;
        expect(size, `font-size of "${t.textContent}"`).toBeGreaterThanOrEqual(11);
        expect(alphaOf(style.color), `ink of "${t.textContent}"`).toBeGreaterThanOrEqual(0.5);
      }
      expect(checked).toBeGreaterThan(0);
    });

    it('keeps interactive targets at >= 24px', () => {
      render(<SignalSlotRow row={row()} onOpenPicker={vi.fn()} />);
      const link = screen.getByLabelText('signal for Forward');
      const rect = link.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(24);
      expect(rect.height).toBeGreaterThanOrEqual(24);
    });
  });
});
