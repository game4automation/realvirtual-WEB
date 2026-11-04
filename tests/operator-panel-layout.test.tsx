// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Operator panel automatic layout — measured in the real browser.
 *
 * What a real control box gets right and what the plate must reproduce for ANY
 * config, not only the one it was tuned on:
 *  - every cell of a row is equally wide (an even grid, not content-sized);
 *  - every 22 mm device face (push button, selector) has the SAME footprint and
 *    the faces of a row sit on one centre line;
 *  - the legends under the devices of a row start on one baseline;
 *  - a lit lamp or a turned knob changes nothing that is laid out;
 *  - a selector's position marks sit symmetrically left / right above the knob,
 *    apart, and inside their cell;
 *  - a setpoint slider reads caption and value on one line above its track.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { ConnectionModeController } from '../src/core/engine/rv-connection-mode';
import {
  OperatorPanel, OperatorPanelController, operatorPanelAnalogSignals, operatorPanelSignals,
  type OperatorPanelConfig,
} from '../src/core/hmi/operator-devices';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

/** The shape of the walker's plate: narrow, four columns, compact, mixed devices. */
const WALKER_LIKE: OperatorPanelConfig = {
  version: 1,
  id: 'layout-panel',
  title: 'Robot',
  width: 290,
  columns: 4,
  density: 'compact',
  selectors: [
    {
      label: 'Drive', caption: 'Drive', variant: 'knob', signal: 'Enable',
      positions: [{ legend: 'Off', value: false }, { legend: 'Run', value: true }],
      lamp: { signal: 'Running', color: 'green' }, row: 1, col: 1,
    },
    {
      label: 'Camera follow', caption: 'Follow', variant: 'knob', signal: 'Follow',
      positions: [{ legend: 'Off', value: false }, { legend: 'On', value: true }], row: 1, col: 2,
    },
  ],
  buttons: [
    { label: 'Reset', capColor: 'blue', signal: 'Reset', row: 1, col: 3 },
    { label: 'Push', capColor: 'yellow', signal: 'Push', lamp: { signal: 'Recovering', color: 'yellow' }, row: 1, col: 4 },
  ],
  estops: [],
  sliders: [
    { label: 'Walk speed', signal: 'CmdVx', min: -0.4, max: 0.6, step: 0.05, unit: 'm/s', decimals: 2, row: 2, col: 1, span: 4 },
  ],
  readouts: [
    { label: 'Dist', signal: 'Distance', unit: 'm', decimals: 2, row: 3, col: 1 },
    { label: 'Height', signal: 'Height', unit: 'mm', row: 3, col: 2 },
    { label: 'Falls', signal: 'Falls', row: 3, col: 3 },
    { label: 'Get-ups', signal: 'GetUps', row: 3, col: 4 },
  ],
  stackLight: [],
  status: [{ kind: 'idle', tone: 'neutral', text: 'READY' }],
};

function rig(config: OperatorPanelConfig = WALKER_LIKE) {
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
  render(
    <ThemeProvider theme={rvDarkTheme}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OperatorPanel viewer={viewer as any} panelId={config.id} source={panel} title="Robot" />
    </ThemeProvider>,
  );
  return { store };
}

const rect = (el: Element) => el.getBoundingClientRect();
const cellsOfRow = (row: number) => [...document.querySelectorAll(`[data-cell^="${row}:"]`)] as HTMLElement[];
/** The 22 mm device face of a cell: the ring around a cap or a knob. */
const faceOf = (cell: Element) => cell.querySelector('[data-part="ring"]') as HTMLElement;
const legendOf = (cell: Element) => [...cell.querySelectorAll('[data-part="legend"]')].pop() as HTMLElement;

/** Every laid-out box of row 1 that the eye compares, as numbers. */
function rowOneGeometry() {
  return cellsOfRow(1).map((c) => {
    const f = rect(faceOf(c));
    const l = rect(legendOf(c));
    return { cell: rect(c).width, fx: f.left, fy: f.top, fw: f.width, fh: f.height, ly: l.top, lh: l.height };
  });
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); });

describe('operator panel automatic layout', () => {
  it('cells of a row are equally wide', () => {
    rig();
    for (const row of [1, 3]) {
      const widths = cellsOfRow(row).map((c) => rect(c).width);
      expect(widths).toHaveLength(4);
      for (const w of widths) expect(Math.abs(w - widths[0])).toBeLessThan(0.5);
    }
  });

  it('every device face has the same footprint, on one centre line', () => {
    rig();
    const faces = cellsOfRow(1).map(faceOf);
    expect(faces).toHaveLength(4);
    const first = rect(faces[0]);
    for (const f of faces.map(rect)) {
      expect(f.width).toBeCloseTo(first.width, 1);
      expect(f.height).toBeCloseTo(first.height, 1);
      expect(f.top + f.height / 2).toBeCloseTo(first.top + first.height / 2, 0);
    }
    // ... centred in its own cell.
    for (const c of cellsOfRow(1)) {
      const cr = rect(c);
      const fr = rect(faceOf(c));
      expect(Math.abs((fr.left + fr.width / 2) - (cr.left + cr.width / 2))).toBeLessThan(1);
    }
  });

  it('the legends of a row share one baseline and one height', () => {
    rig();
    const legends = cellsOfRow(1).map(legendOf).map(rect);
    for (const l of legends) {
      expect(l.top).toBeCloseTo(legends[0].top, 0);
      expect(l.height).toBeCloseTo(legends[0].height, 0);
    }
    const readouts = cellsOfRow(3).map(legendOf).map(rect);
    for (const l of readouts) expect(l.top).toBeCloseTo(readouts[0].top, 0);
  });

  it('a lit lamp or a turned knob moves nothing', () => {
    const { store } = rig();
    const before = rowOneGeometry();
    act(() => {
      store.set('Enable', true);
      store.set('Running', true);
      store.set('Recovering', true);
      store.set('Follow', true);
    });
    expect(document.querySelector('[data-part="ring"][data-glow="true"]')).not.toBeNull();
    const after = rowOneGeometry();
    expect(after).toEqual(before);
  });

  it('selector marks sit symmetrically left / right above the knob, apart and inside the cell', () => {
    rig();
    for (const name of ['Drive', 'Camera follow']) {
      const group = screen.getByRole('radiogroup', { name: new RegExp(`^${name}`) });
      const cell = group.closest('[data-cell]') as HTMLElement;
      const knob = rect(group.querySelector('[data-part="ring"]')!);
      const [left, right] = [...group.querySelectorAll('[role="radio"] [data-part="mark-text"]')].map(rect);
      const cx = knob.left + knob.width / 2;
      // Symmetric: both marks' centres equally far from the knob's axis (±1 px of text width rounding).
      const dl = cx - (left.left + left.width / 2);
      const dr = (right.left + right.width / 2) - cx;
      expect(dl).toBeGreaterThan(0);
      expect(Math.abs(dl - dr)).toBeLessThan(3);
      // Apart: never crowded into one word.
      expect(right.left - left.right).toBeGreaterThanOrEqual(10);
      // On one line, above the knob's centre (the pointer's end positions).
      expect(Math.abs(left.top - right.top)).toBeLessThan(0.5);
      expect(left.bottom).toBeLessThan(knob.top + knob.height / 2);
      // Inside the cell: a mark never reaches into the neighbour.
      const cr = rect(cell);
      expect(left.left).toBeGreaterThanOrEqual(cr.left - 0.5);
      expect(right.right).toBeLessThanOrEqual(cr.right + 0.5);
    }
  });

  it('a slider reads caption and value on one line above its track', () => {
    rig();
    const slider = document.querySelector('[data-device="setpoint-slider"]') as HTMLElement;
    const caption = rect(slider.querySelector('[data-part="caption"]')!);
    const value = rect(slider.querySelector('[data-part="value"]')!);
    const rail = rect(slider.querySelector('.MuiSlider-rail')!);
    expect(Math.abs((caption.top + caption.height / 2) - (value.top + value.height / 2))).toBeLessThan(2);
    expect(caption.right).toBeLessThanOrEqual(value.left);
    expect(value.bottom).toBeLessThanOrEqual(rail.top);
    // The caption starts where the track starts; the value ends where it ends.
    expect(Math.abs(caption.left - rail.left)).toBeLessThan(2);
    expect(Math.abs(value.right - rail.right)).toBeLessThan(2);
  });
});
