// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.5 — inline empty slot rows: a Drive_Simple WITHOUT a Backward
 * value in the GLB still shows a Backward row ("not linked"), the row opens
 * the two-group picker, and picking an internal model signal binds it live
 * through the manager (F1/F2/F3/F9).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import { makeInlineSlotFixture } from './_inline-slot-fixture';

afterEach(cleanup);

describe('inline empty slot rows (plan-325 9.5)', () => {
  it('shows Backward as a bindable "not linked" row although the GLB has no value', () => {
    const f = makeInlineSlotFixture();
    render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="Drive_Simple"
      data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
    />);

    // Forward (GLB-wired) AND Backward (empty) are both present (F1).
    expect(screen.getByTestId('slot-row-.-mapped-signal-Forward')).toBeTruthy();
    const backward = screen.getByTestId('slot-row-.-direct-property-Backward');
    expect(backward.textContent).toContain('not linked');
    expect(within(backward).getByLabelText('signal for Backward')).toBeTruthy();
  });

  it('opens the two-group picker and binds an internal model signal (live, no provider)', async () => {
    const f = makeInlineSlotFixture();
    render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="Drive_Simple"
      data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
    />);

    fireEvent.click(screen.getByLabelText('signal for Backward'));
    // Picker open, internal group present (no CONNECT interfaces in fixture).
    await screen.findByPlaceholderText('Search name, address, comment…');
    expect(await screen.findByText('Model signals')).toBeTruthy();

    fireEvent.click(await screen.findByRole('option', { name: 'ModelSig' }));

    // Bound through the manager: internal mapping is live immediately.
    f.mgr.tick(0.02);
    expect(f.mgr.getBindingLiveness(f.nodePath, 'Backward', '.')).toBe('live');
    // The row now shows the assignment chip + unlink.
    expect(await screen.findByLabelText('unbind Backward')).toBeTruthy();
    const backward = screen.getByTestId('slot-row-.-direct-property-Backward');
    expect(within(backward).getAllByText((c) => c.includes('ModelSig')).length).toBeGreaterThan(0);
  });

  it('excludes the slot\'s own target signal from the internal picker group (self-binding)', async () => {
    const f = makeInlineSlotFixture();
    render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="Drive_Simple"
      data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
    />);

    // Open the picker on the GLB-wired Forward row (target = Axis.Forward).
    const forward = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    fireEvent.click(within(forward).getByLabelText('signal for Forward'));
    await screen.findByPlaceholderText('Search name, address, comment…');
    expect(screen.queryByRole('option', { name: 'Axis.Forward' })).toBeNull();
    expect(await screen.findByRole('option', { name: 'ModelSig' })).toBeTruthy();
  });
});
