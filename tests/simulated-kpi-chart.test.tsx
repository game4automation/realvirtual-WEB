// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2016 — a click on a simulated KPI chip opens ONE trend window, a second
 * chip replaces it, and X / Escape / a press outside close it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { ComponentType } from 'react';
import { SimulatedKpiPlugin } from '../src/plugins/simulated-kpi-plugin';
import type { UISlotProps } from '../src/core/rv-ui-plugin';

const KPIS = [
  { label: 'OEE', base: 95, amplitude: 0.4, period: 40, unit: '%', decimals: 1, seed: 1 },
  { label: 'Output', base: 45, amplitude: 2, period: 30, unit: 'pcs/h', seed: 2 },
];

function mount() {
  const plugin = new SimulatedKpiPlugin({ id: 'test-kpis', kpis: KPIS });
  const props = {} as UISlotProps;
  const comps = plugin.slots.map((s) => s.component as ComponentType<UISlotProps>);
  render(
    <div>
      <div data-testid="outside">3D view</div>
      {comps.map((C, i) => <C key={i} {...props} />)}
    </div>,
  );
  return plugin;
}

const chip = (label: string) => screen.getByText(label).closest('button')!;
const windowOf = (label: string) => screen.queryByRole('dialog', { name: `${label} trend` });

describe('simulated KPI trend window', () => {
  afterEach(() => cleanup());

  it('opens on chip click, replaces on another chip, closes via Escape', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(chip('OEE'));
    expect(windowOf('OEE')).not.toBeNull();
    expect(screen.getByTestId('simulated-kpi-chart')).toBeTruthy();
    expect(screen.getByText(/Last 8 h/)).toBeTruthy();

    // A press on another chip is not "outside": the window is replaced, not closed.
    fireEvent.pointerDown(chip('Output'));
    fireEvent.click(chip('Output'));
    expect(windowOf('OEE')).toBeNull();
    expect(windowOf('Output')).not.toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    act(() => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on a press outside, not on a press inside the window', () => {
    mount();
    fireEvent.click(chip('Output'));
    const dlg = windowOf('Output')!;
    fireEvent.pointerDown(screen.getByTestId('simulated-kpi-chart'));
    expect(windowOf('Output')).toBe(dlg);

    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes via the title-bar close button and on dispose', () => {
    const plugin = mount();
    fireEvent.click(chip('OEE'));
    const dlg = windowOf('OEE')!;
    const close = Array.from(dlg.querySelectorAll('button')).find((b) =>
      /close/i.test(b.getAttribute('aria-label') ?? b.title ?? ''));
    expect(close).toBeTruthy();
    fireEvent.click(close!);
    expect(screen.queryByRole('dialog')).toBeNull();

    fireEvent.click(chip('OEE'));
    expect(windowOf('OEE')).not.toBeNull();
    act(() => plugin.dispose());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
