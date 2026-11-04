// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 §9.3 — the planning window renders a DECLARATION, not a model.
 *
 * One declaration with one parameter of every kind must produce the four
 * controls of §2.6, the effect badges, the pending note with its withdrawal and
 * the footer count — and a published snapshot that did not change must not
 * re-render the window (the value-stable snapshot is the whole reason the window
 * can sit over a running plant).
 */

import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { PlanningWindow } from '../../src/plugins/planning-parameters/PlanningOverlay';
import { PlanningParametersPlugin } from '../../src/plugins/planning-parameters';
import type { PlanningParamDef } from '../../src/core/planning/rv-planning-params';
import type { UISlotProps } from '../../src/core/rv-ui-plugin';

vi.mock('../../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

const PARAMS: PlanningParamDef[] = [
  // bounded number → slider
  { key: 'rate', label: 'A1', type: 'number', unit: 'Pal/h', min: 0, max: 120, default: 40, group: 'Eingangslast', apply: 'live' },
  // unbounded number → typed field
  { key: 'pause', label: 'Pause alle', type: 'integer', unit: 's', default: 1200, group: 'Versand', apply: 'live' },
  // booleans of one chip row
  { key: 'station.A1', label: 'A1', type: 'boolean', default: true, group: 'Stationen', apply: 'reset', ui: { chipRow: 'Ausgänge' } },
  { key: 'station.A2', label: 'A2', type: 'boolean', default: true, group: 'Stationen', apply: 'reset', ui: { chipRow: 'Ausgänge' } },
  // enum → latch group. `Flotte` deliberately holds BOTH effects, so the rows
  // of a mixed group carry their own badge while a uniform group's heading
  // carries it once.
  {
    key: 'retrieval', label: 'Auslagerung', type: 'enum', default: 'new', group: 'Flotte', apply: 'reset',
    options: [{ id: 'new', label: 'Neu' }, { id: 'old', label: 'Alt' }],
  },
  { key: 'battery.threshold', label: 'Ladeschwelle', type: 'number', unit: '%', min: 5, max: 95, default: 30, group: 'Flotte', apply: 'live', order: 1 },
];

let plugin: PlanningParametersPlugin;
let renders = 0;

function Counting({ viewer }: UISlotProps) {
  // A Profiler, not a counter in a wrapper component: the store subscription
  // lives INSIDE PlanningWindow, so a wrapper above it would never see the
  // re-render we are measuring. `onRender` fires once per commit of this
  // subtree — exactly "the window rendered again".
  return (
    <Profiler id="planning" onRender={() => { renders += 1; }}>
      <PlanningWindow viewer={viewer} />
    </Profiler>
  );
}

function renderWindow() {
  const viewer = { getPlugin: () => plugin } as unknown as UISlotProps['viewer'];
  const result = render(
    <ThemeProvider theme={rvDarkTheme}>
      <Counting viewer={viewer} />
    </ThemeProvider>,
  );
  // Expand the title bar before interacting with the planning controls.
  const opener = screen.queryByRole('button', { name: 'Expand panel' });
  if (opener) fireEvent.click(opener);
  return result;
}

beforeEach(() => {
  localStorage.clear();
  renders = 0;
  plugin = new PlanningParametersPlugin();
  vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('PlanningWindow', () => {
  it('renders nothing while no model has declared anything', () => {
    renderWindow();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('renders one control per declared kind, grouped, with its effect badge', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();

    expect(screen.getByRole('region', { name: 'Legacy planning' })).toBeTruthy();
    // bounded number → slider
    expect(screen.getByRole('slider', { name: 'A1' })).toBeTruthy();
    // unbounded number → typed field
    expect(screen.getByRole('textbox', { name: 'Pause alle' })).toBeTruthy();
    // chip row → one chip per boolean, inside a named group
    const chips = screen.getByRole('group', { name: 'Ausgänge' });
    expect(chips.querySelectorAll('button')).toHaveLength(2);
    // enum → latched one-of-N
    expect(screen.getByRole('group', { name: 'Auslagerung' })).toBeTruthy();

    // A group whose rows share one effect says it ONCE, in its heading.
    expect(screen.getByText('Stationen ↻')).toBeTruthy();
    expect(screen.getByText('Eingangslast ⚡')).toBeTruthy();
    // A group with both says so, and then every row of it names its own.
    expect(screen.getByText('Flotte ⚡ ↻')).toBeTruthy();
    expect(screen.getByText('Auslagerung ↻')).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Ladeschwelle ⚡' })).toBeTruthy();
  });

  it('labels a standalone boolean On / Off', () => {
    plugin.registry.declare({
      owner: 'yard',
      title: 'Planung · Yard',
      params: [{ key: 'night', label: 'Night shift', type: 'boolean', default: true, group: 'Shifts', apply: 'live' }],
    });
    renderWindow();

    const latch = screen.getByRole('group', { name: 'Night shift' });
    expect([...latch.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['On', 'Off']);
  });

  it('puts a chip row where its first member was declared, not at the end', () => {
    plugin.registry.declare({
      owner: 'yard',
      title: 'Planung · Yard',
      params: [
        { key: 'station.A1', label: 'A1', type: 'boolean', default: true, group: 'Stationen', apply: 'reset', ui: { chipRow: 'Ausgänge' } },
        { key: 'station.V1', label: 'V1', type: 'boolean', default: true, group: 'Stationen', apply: 'reset', order: 1, ui: { chipRow: 'Eingänge' } },
        { key: 'slots', label: 'Pufferplätze', type: 'integer', min: 0, max: 8, default: 6, group: 'Stationen', apply: 'reset', order: 2 },
      ],
    });
    renderWindow();

    const texts = [...screen.getByRole('region', { name: 'Legacy planning' })
      .querySelectorAll('[role="group"], .MuiSlider-root')]
      .map((e) => e.getAttribute('aria-label') ?? e.querySelector('input')?.getAttribute('aria-label'));
    expect(texts).toEqual(['Ausgänge', 'Eingänge', 'Pufferplätze']);
  });

  it('shows a reset change as pending, names it in the button, and takes it back', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();

    // Nothing pending: the button stays enabled — "jederzeit neu aufbauen" (Thomas
    // 2026-10-26) — and rebuilds + resets.
    const rebuild = screen.getByRole('button', { name: 'Rebuild & reset' }) as HTMLButtonElement;
    expect(rebuild.disabled).toBe(false);
    // The window can be collapsed, never closed (plan-630 §2.6 / Thomas 2026-10-26).
    expect(screen.queryByRole('button', { name: 'Close window' })).toBeNull();

    act(() => { plugin.registry.set('yard.station.A2', false, 'ui'); });
    expect(screen.getByRole('button', { name: /Reset & apply \(1 pending\)/ })).toBeTruthy();
    // the chip says "about to be off", and the value itself is untouched
    const chip = screen.getByRole('button', { name: 'A2 (pending: off)' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');

    // enum: the pending note is a button that withdraws it
    act(() => { plugin.registry.set('yard.retrieval', 'old', 'ui'); });
    fireEvent.click(screen.getByRole('button', { name: 'Revert pending Auslagerung' }));
    expect(screen.getByRole('button', { name: /Reset & apply \(1 pending\)/ })).toBeTruthy();
  });

  it('Reset to defaults: disabled at the defaults; live back at once, reset values pending for the apply', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();
    const button = () => screen.getByRole('button', { name: 'Reset to defaults' }) as HTMLButtonElement;
    expect(button().disabled).toBe(true);

    act(() => { plugin.registry.setMany({ 'yard.rate': 80, 'yard.station.A2': false }, 'ui'); });
    expect(button().disabled).toBe(false);
    expect(screen.getByRole('button', { name: /Reset & apply \(1 pending\)/ })).toBeTruthy();

    fireEvent.click(button());
    const rate = plugin.registry.list().find((p) => p.key === 'yard.rate')!;
    expect(rate.value).toBe(40);                                  // live: back at once
    expect(plugin.registry.list().find((p) => p.key === 'yard.station.A2')!.pending).toBeUndefined();
    expect(button().disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Rebuild & reset' })).toBeTruthy();
  });

  it('leaves sim and measured key figures to the Statistics hub', () => {
    plugin.registry.declare({
      owner: 'yard',
      title: 'Planung · Yard',
      params: PARAMS,
      kpis: [
        { key: 'shipped', label: 'Versand', unit: 'Pal/h', kind: 'sim', read: () => 78 },
        { key: 'fps', label: 'FPS', kind: 'measured', read: () => 58 },
        { key: 'heap', label: 'JS-Heap', unit: 'MB', kind: 'measured', read: () => null },
      ],
    });
    renderWindow();

    expect(screen.queryByText('KPIs')).toBeNull();
    expect(screen.queryByText('Measured (wall clock, not deterministic)')).toBeNull();
    expect(screen.queryByText('78')).toBeNull();
    expect(screen.queryByText('58')).toBeNull();
    expect(screen.queryByText('FPS')).toBeNull();
    expect(screen.queryByText('JS-Heap')).toBeNull();
    expect(screen.queryByText('n/a')).toBeNull();
    expect(screen.getByRole('slider', { name: 'A1' })).toBeTruthy();
  });

  it('does not re-render when the published snapshot did not change', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();
    const before = renders;

    // The load-bearing claim: a write that changes nothing publishes nothing,
    // so the window does not commit at all. This is what lets the window sit
    // over a running plant — the sim writes the same values every tick.
    act(() => { plugin.registry.set('yard.rate', 40, 'ui'); });
    expect(renders).toBe(before);

    // A real change costs a small CONSTANT number of commits (measured 2, the
    // same as the mount) — per change, never per frame.
    act(() => { plugin.registry.set('yard.rate', 60, 'ui'); });
    expect(renders).toBeGreaterThan(before);
    expect(renders - before).toBeLessThanOrEqual(2);
  });

  it('scenario bar (plan-630 Phase 3): no project open = not saveable, Save disabled; a change marks it unsaved', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();

    expect((screen.getByRole('combobox', { name: 'Scenario' }) as HTMLSelectElement).value).toBe('Basis');
    expect(screen.getByRole('note', { name: 'Not saveable' }).textContent).toMatch(/Not saveable/);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save as…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: 'Scenario status' }).textContent).toBe('saved · 0 deviations');

    act(() => { plugin.registry.set('yard.rate', 60, 'ui'); });
    expect(screen.getByRole('status', { name: 'Scenario status' }).textContent).toBe('● unsaved · 1 deviation');
    // the collapsed title line names the scenario
    expect(screen.getAllByText(/Basis/).length).toBeGreaterThan(1);
  });

  it('is read-only while an experiment batch runs (plan-2005 Phase 7): inputs inert, apply and reset disabled', () => {
    plugin.registry.declare({ owner: 'yard', title: 'Planung · Yard', params: PARAMS });
    renderWindow();
    act(() => { plugin.registry.setExperimentRunning(true); });
    expect(screen.getByTestId('planning-experiment-lock').textContent).toMatch(/read-only/);
    expect(screen.getByTestId('planning-inputs').hasAttribute('inert')).toBe(true);
    expect((screen.getByRole('button', { name: /Rebuild & reset|Reset & apply/ }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { plugin.registry.setExperimentRunning(false); });
    expect(screen.queryByTestId('planning-experiment-lock')).toBeNull();
    expect(screen.getByTestId('planning-inputs').hasAttribute('inert')).toBe(false);
  });
});

