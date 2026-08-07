// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-325 §9.12 — no-manager state (A1): with the feature flag off
 * (`signalBindingManager === null`, e.g. embeds/tests) the inline rows render
 * the GLB wiring READ-ONLY — chip without link icon, no picker, no drop
 * target, and no crash. No promise without function.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComponentSignalSlots } from '../src/plugins/signal-bind/InlineSignalSlots';
import { makeInlineSlotFixture } from './_inline-slot-fixture';

afterEach(cleanup);

describe('inline linking without a manager (plan-325 9.12)', () => {
  it('renders read-only GLB chips — no link icon, no picker, no crash', () => {
    const f = makeInlineSlotFixture({ withManager: false });
    render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="Drive_Simple"
      data={f.node.userData.realvirtual.Drive_Simple as Record<string, unknown>}
    />);

    // GLB-wired Forward renders its chip read-only.
    const forward = screen.getByTestId('slot-row-.-mapped-signal-Forward');
    expect(forward.textContent).toContain('Axis.Forward');
    // Empty Backward renders as plain "not linked".
    const backward = screen.getByTestId('slot-row-.-mapped-signal-Backward');
    expect(backward.textContent).toContain('not linked');

    // No interactive affordances anywhere.
    expect(screen.queryByLabelText('signal for Forward')).toBeNull();
    expect(screen.queryByLabelText('signal for Backward')).toBeNull();
    expect(screen.queryByLabelText('change signal for Forward')).toBeNull();
    expect(screen.queryByLabelText('unbind Forward')).toBeNull();

    // Clicking is inert (no picker opens).
    fireEvent.click(forward);
    expect(screen.queryByPlaceholderText('Search name, address, comment…')).toBeNull();
  });

  it('renders nothing for component types without signal-slot fields', () => {
    const f = makeInlineSlotFixture({ withManager: false });
    const { container } = render(<ComponentSignalSlots
      viewer={f.viewer}
      signalStore={f.store}
      nodePath={f.nodePath}
      componentType="LayoutObject"
      data={{}}
    />);
    expect(container.innerHTML).toBe('');
  });
});
