// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-659 — the two ANALOG devices of `WebOperatorPanel`: a setpoint slider
 * (writes a number) and a numeric readout (reads one).
 *
 * They exist because a policy-driven machine is commanded with a VALUE, not a
 * bit: a walk speed, the strength of a push, and the telemetry that answers
 * "how much?" rather than "is it so?". Every other device on this panel is
 * boolean and stays so.
 *
 * What this pins down:
 *  - both render from the config, on the grid, with unit and legend,
 *  - the slider WRITES its signal as a number (operator -> signal), live,
 *  - the readout READS its signal and shows `value * scale` (signal -> screen),
 *  - a readout never writes,
 *  - the structure validator rejects a broken range / step,
 *  - a config naming a signal the model lacks stays disabled, as before,
 *  - a boolean-only panel is unaffected: no `numbers` churn, no analog signals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { ConnectionModeController } from '../src/core/engine/rv-connection-mode';
import {
  OperatorPanel, OperatorPanelController, operatorPanelAnalogSignals, operatorPanelSignals,
  validateOperatorPanelConfig, type OperatorPanelConfig,
} from '../src/core/hmi/operator-devices';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

const CONFIG: OperatorPanelConfig = {
  version: 1,
  id: 'analog-panel',
  title: 'Robot',
  columns: 3,
  buttons: [{ label: 'Reset', signal: 'Reset', capColor: 'blue', row: 1, col: 1 }],
  selectors: [],
  estops: [],
  sliders: [
    { label: 'Walk speed', signal: 'CmdVx', min: -0.4, max: 0.6, step: 0.05, unit: 'm/s', decimals: 2, row: 2, col: 1, span: 3 },
  ],
  readouts: [
    { label: 'Distance', signal: 'Distance', unit: 'm', decimals: 2, row: 3, col: 1 },
    { label: 'Height', signal: 'BaseHeight', unit: 'mm', decimals: 0, scale: 1000, row: 3, col: 2 },
    // A vector instrument — the shape the robot's measured quantities have
    // (angular rate, projected gravity).
    {
      label: 'Ang vel',
      signals: ['AngVelX', 'AngVelY', 'AngVelZ'],
      componentLabels: ['X', 'Y', 'Z'],
      unit: 'rad/s',
      decimals: 2,
      row: 4,
      col: 1,
      span: 3,
    },
  ],
  stackLight: [],
  status: [{ kind: 'idle', tone: 'neutral', text: 'READY' }],
};

/** A real store, a real connection mode, a real controller — no doubles. */
function rig(config: OperatorPanelConfig = CONFIG) {
  const store = new SignalStore();
  for (const name of operatorPanelSignals(config)) store.register(name, `PLC/Robot/${name}`, false);
  for (const name of operatorPanelAnalogSignals(config)) store.register(name, `PLC/Robot/${name}`, 0, 'PLCInputFloat');
  let state: 'Connected' | 'Disconnected' = 'Disconnected';
  const mode = new ConnectionModeController({
    get connectionState() { return state; },
    setConnectionState: (s: 'Connected' | 'Disconnected') => { state = s; },
  });
  const panel = new OperatorPanelController(config);
  const viewer = { signalStore: store, connectionMode: mode, getPlugin: () => undefined };
  panel.start(viewer as never);
  return { store, panel, viewer };
}

function show(r: ReturnType<typeof rig>) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OperatorPanel viewer={r.viewer as any} panelId={CONFIG.id} source={r.panel} title="Robot" />
    </ThemeProvider>,
  );
}

let capture: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  capture.mockRestore();
});

describe('plan-659 analog operator devices', () => {
  it('renders both devices with their legends and units', () => {
    show(rig());
    expect(screen.getByRole('slider', { name: 'Walk speed' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Distance' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Height' })).toBeTruthy();
    // The legend plate, uppercased by CSS, carries the readable text.
    expect(screen.getByText('Walk speed')).toBeTruthy();
  });

  it('the slider writes its signal as a NUMBER, not a bool', () => {
    const r = rig();
    show(r);
    const slider = screen.getByRole('slider', { name: 'Walk speed' }) as HTMLInputElement;
    act(() => { fireEvent.change(slider, { target: { value: '0.25' } }); });
    const written = r.store.get('CmdVx');
    expect(typeof written).toBe('number');
    expect(written).toBeCloseTo(0.25, 6);
  });

  it('the slider follows the signal when something else writes it (the signal owns the value)', () => {
    const r = rig();
    show(r);
    act(() => { r.store.set('CmdVx', -0.3); });
    const slider = screen.getByRole('slider', { name: 'Walk speed' }) as HTMLInputElement;
    expect(Number(slider.value)).toBeCloseTo(-0.3, 6);
  });

  it('the readout shows the signal scaled, and writes nothing', () => {
    const r = rig();
    show(r);
    act(() => { r.store.set('Distance', 6.7231); r.store.set('BaseHeight', 0.1234); });
    const distance = screen.getByRole('status', { name: 'Distance' });
    const height = screen.getByRole('status', { name: 'Height' });
    expect(distance.querySelector('[data-part="value"]')?.textContent).toBe('6.72');
    // scale 1000: metres shown as millimetres.
    expect(height.querySelector('[data-part="value"]')?.textContent).toBe('123');
    // Nothing the readout did changed its own signal.
    expect(r.store.get('Distance')).toBeCloseTo(6.7231, 6);
  });

  it('a slider spans the columns its config asks for', () => {
    show(rig());
    const cell = document.querySelector('[data-cell="2:1"]') as HTMLElement;
    expect(cell).toBeTruthy();
    // `sx` lands in a generated class, not in the inline style.
    expect(getComputedStyle(cell).gridColumn).toBe('1 / span 3');
    // A boolean device in the same panel keeps its single column.
    const buttonCell = document.querySelector('[data-cell="1:1"]') as HTMLElement;
    expect(getComputedStyle(buttonCell).gridColumn).toBe('1');
  });

  describe('validation', () => {
    const base = { ...CONFIG, sliders: undefined, readouts: undefined };

    it('rejects max <= min and step <= 0', () => {
      const bad = {
        ...base,
        sliders: [{ label: 'X', signal: 'CmdVx', min: 1, max: 1, step: 0, row: 1, col: 1 }],
      };
      const { config, errors } = validateOperatorPanelConfig(bad);
      expect(config).toBeNull();
      expect(errors.join(' | ')).toContain('sliders[0].max must be greater than min');
      expect(errors.join(' | ')).toContain('sliders[0].step must be greater than 0');
    });

    it('rejects a non-numeric range', () => {
      const bad = { ...base, sliders: [{ label: 'X', signal: 'CmdVx', min: 'a', max: 2, row: 1, col: 1 }] };
      expect(validateOperatorPanelConfig(bad).errors.join(' | ')).toContain('sliders[0].min must be a finite number');
    });

    it('reports an analog signal the model lacks, with its JSON path', () => {
      const { errors } = validateOperatorPanelConfig(CONFIG, (n) => n !== 'BaseHeight');
      expect(errors.join(' | ')).toContain("readouts[1].signal 'BaseHeight' not found in model");
    });

    it('reports a missing VECTOR component with its index in the path', () => {
      const { errors } = validateOperatorPanelConfig(CONFIG, (n) => n !== 'AngVelY');
      expect(errors.join(' | ')).toContain("readouts[2].signals[1] 'AngVelY' not found in model");
    });

    it('refuses a readout that names both signal and signals, or neither', () => {
      const both = { ...base, readouts: [{ label: 'X', signal: 'Distance', signals: ['A', 'B'], row: 1, col: 1 }] };
      expect(validateOperatorPanelConfig(both).errors.join(' | ')).toContain("must have either 'signal' or 'signals'");
      const neither = { ...base, readouts: [{ label: 'X', row: 1, col: 1 }] };
      expect(validateOperatorPanelConfig(neither).errors.join(' | ')).toContain("must have either 'signal' or 'signals'");
    });

    it('refuses a vector of the wrong size and mismatched component labels', () => {
      const one = { ...base, readouts: [{ label: 'X', signals: ['A'], row: 1, col: 1 }] };
      expect(validateOperatorPanelConfig(one).errors.join(' | ')).toContain('must be 2 to 4 non-empty signal names');
      const mismatched = {
        ...base,
        readouts: [{ label: 'X', signals: ['A', 'B', 'C'], componentLabels: ['X', 'Y'], row: 1, col: 1 }],
      };
      expect(validateOperatorPanelConfig(mismatched).errors.join(' | ')).toContain('must be 3 strings (one per signal)');
    });

    it('accepts the config unchanged and lists the analog signals apart', () => {
      expect(validateOperatorPanelConfig(CONFIG).errors).toEqual([]);
      expect(operatorPanelAnalogSignals(CONFIG)).toEqual([
        'CmdVx', 'Distance', 'BaseHeight', 'AngVelX', 'AngVelY', 'AngVelZ',
      ]);
      // The boolean list stays boolean-only — the pre-plan-659 meaning.
      expect(operatorPanelSignals(CONFIG)).toEqual(['Reset']);
    });
  });

  it('a vector readout shows every component under ONE legend', () => {
    const r = rig();
    show(r);
    act(() => {
      r.store.set('AngVelX', 0.123);
      r.store.set('AngVelY', -1.5);
      r.store.set('AngVelZ', 0);
    });
    const meter = screen.getByRole('status', { name: 'Ang vel' });
    const parts = [...meter.querySelectorAll('[data-part="value"]')].map((e) => e.textContent);
    expect(parts).toEqual(['0.12', '-1.50', '0.00']);
    const labels = [...meter.querySelectorAll('[data-part="component-label"]')].map((e) => e.textContent);
    expect(labels).toEqual(['X', 'Y', 'Z']);
    // One instrument, one unit, one legend — not three.
    expect(meter.querySelectorAll('[data-part="unit"]')).toHaveLength(1);
    expect(screen.getAllByText('Ang vel')).toHaveLength(1);
  });

  // ── density (plan-659 follow-up) ───────────────────────────────────────
  //
  // A plate that sits next to the machine it operates has to get out of the
  // way. `density: 'compact'` is how, and it is OPT-IN: the laser station and
  // every other existing panel must render exactly as before without it.

  it('density defaults to comfortable: a panel without the key is unchanged', () => {
    const r = rig();
    const { container } = show(r);
    const grid = container.querySelector('[data-part="device-grid"]')!;
    const meter = screen.getByRole('status', { name: 'Distance' });
    // The original metrics: a 22 px meter window and a 14 px legend line.
    expect(getComputedStyle(meter).minHeight).toBe('22px');
    expect(getComputedStyle(meter.parentElement!.querySelector('[data-part="legend"]')!).height).toBe('14px');
    expect(grid).toBeTruthy();
  });

  it('density compact tightens the meter window and the legend, not the layout', () => {
    const r = rig({ ...CONFIG, density: 'compact' });
    const { container } = show(r);
    const meter = screen.getByRole('status', { name: 'Distance' });
    expect(getComputedStyle(meter).minHeight).toBe('17px');
    expect(getComputedStyle(meter.parentElement!.querySelector('[data-part="legend"]')!).height).toBe('12px');
    // Same devices, same cells: compact is a metric, never a different panel.
    const grid = container.querySelector('[data-part="device-grid"]')!;
    expect(grid.querySelectorAll('[data-cell]').length)
      .toBe(show(rig()).container.querySelectorAll('[data-cell]').length);
  });

  it('the structure validator rejects a density it does not know', () => {
    const bad = validateOperatorPanelConfig({ ...CONFIG, density: 'tiny' });
    expect(bad.config).toBeNull();
    expect(bad.errors.join(' ')).toMatch(/density/);
    // Both known values pass.
    expect(validateOperatorPanelConfig({ ...CONFIG, density: 'compact' }).config).not.toBeNull();
    expect(validateOperatorPanelConfig({ ...CONFIG, density: 'comfortable' }).config).not.toBeNull();
  });

  it('a boolean-only panel has no analog signals and an empty numbers map', () => {
    const boolOnly: OperatorPanelConfig = {
      ...CONFIG, sliders: undefined, readouts: undefined,
    };
    expect(operatorPanelAnalogSignals(boolOnly)).toEqual([]);
    const r = rig(boolOnly);
    expect(r.panel.getSnapshot().numbers).toEqual({});
    expect(r.panel.signalNames).toEqual(['Reset']);
  });
});
