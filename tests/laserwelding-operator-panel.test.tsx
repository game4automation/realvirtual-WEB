// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-539 F6b / plan-542 F6–F7 / plan-543 F5 — the Laser Welding Assembly
 * Station operator window, drawn as a control-box faceplate.
 *
 * The panel is DATA in the shipped demo GLB (plan-543): a `WebOperatorPanel`
 * component whose `Config` JSON replaces the former model plugin. Buttons write
 * the TIA inputs (%I), lamps show the TIA outputs (%Q), and the window cannot
 * be closed. The config is read from the served GLB; the window is rendered
 * against a real SignalStore and a real ConnectionModeController.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { ConnectionModeController } from '../src/core/engine/rv-connection-mode';
import {
  OperatorPanel, OperatorPanelController, RELEASE_HOLD_MS, operatorPanelSignals, resolveStatus,
  type OperatorPanelConfig,
} from '../src/core/hmi/operator-devices';
import { parseWebOperatorPanelConfig, webOperatorPanelRuleWarnings } from '../src/core/engine/rv-extras-validator';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

type ConnectionState = 'Connected' | 'Disconnected';

const START_TRUE = new Set(['BT1_ControlOnOff', 'BT2_OpMode', 'i_SS_ESTOP1', 'i_SS_ESTOP2']);

// ── The panel as shipped: the WebOperatorPanel of the demo GLB ─────────────

const DEMO_GLB = ['/demo-realvirtual/LaserWeldingAssemblyStation.glb', '/public/demo-realvirtual/LaserWeldingAssemblyStation.glb'];
const DEMO_PROJECT = ['/demo-realvirtual/project.json', '/public/demo-realvirtual/project.json'];

interface GltfNode { name?: string; extras?: { realvirtual?: Record<string, Record<string, unknown>> } }

async function fetchFirst(urls: readonly string[]): Promise<Response> {
  for (const url of urls) {
    const res = await fetch(url);
    if (res.ok && !(res.headers.get('content-type') ?? '').includes('text/html')) return res;
  }
  throw new Error(`none served: ${urls.join(', ')}`);
}

/** The glTF JSON chunk of a GLB. */
function gltfJson(bytes: ArrayBuffer): { nodes?: GltfNode[] } {
  const view = new DataView(bytes);
  const len = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, len)));
}

let NODES: GltfNode[] = [];
let PANEL_NODE: GltfNode;
let LASERWELDING_PANEL: OperatorPanelConfig;
let PANEL_SIGNALS: string[] = [];
let RESTART_HINT = '';

beforeAll(async () => {
  NODES = gltfJson(await (await fetchFirst(DEMO_GLB)).arrayBuffer()).nodes ?? [];
  const panels = NODES.filter((n) => n.extras?.realvirtual?.WebOperatorPanel);
  expect(panels).toHaveLength(1);
  PANEL_NODE = panels[0];
  const parsed = parseWebOperatorPanelConfig(PANEL_NODE.extras!.realvirtual!.WebOperatorPanel.Config);
  expect(parsed.errors).toEqual([]);
  LASERWELDING_PANEL = parsed.raw as OperatorPanelConfig;
  PANEL_SIGNALS = operatorPanelSignals(LASERWELDING_PANEL);
  RESTART_HINT = LASERWELDING_PANEL.restart!.hint;
}, 120_000);

interface Rig {
  store: SignalStore;
  mode: ConnectionModeController;
  panel: OperatorPanelController;
  viewer: Record<string, unknown>;
}

function rig(signals: readonly string[] = PANEL_SIGNALS): Rig {
  const store = new SignalStore();
  for (const name of signals) store.register(name, `PLC/ControlPanel/${name}`, START_TRUE.has(name));
  let state: ConnectionState = 'Disconnected';
  const mode = new ConnectionModeController({
    get connectionState() { return state; },
    setConnectionState: (s: ConnectionState) => { state = s; },
  });
  const panel = new OperatorPanelController(LASERWELDING_PANEL);
  const viewer = { signalStore: store, connectionMode: mode, getPlugin: () => undefined };
  panel.start(viewer as never);
  return { store, mode, panel, viewer };
}

function show(r: Rig) {
  return render(
    <ThemeProvider theme={rvDarkTheme}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OperatorPanel viewer={r.viewer as any} panelId={LASERWELDING_PANEL.id} source={r.panel} title="Operator panel" />
    </ThemeProvider>,
  );
}

const button = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}(,|$)`) });
const stripText = () => screen.getByRole('status', { name: 'Station state' }).querySelector('[data-part="state-text"]')?.textContent;

let capture: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => { cleanup(); capture.mockRestore(); localStorage.clear(); vi.useRealTimers(); });

describe('plan-539 F6b / plan-542 F7 — operator faceplate', () => {
  it('is a labelled window that cannot be closed, with the restart steps outside Auto', () => {
    show(rig());
    expect(screen.getByRole('region', { name: 'Operator panel' })).toBeTruthy();
    expect(screen.queryByLabelText('Close window')).toBeNull();
    // F8c: the window tells the operator how to restart after a stop (3 steps).
    const hint = screen.getByRole('note', { name: /^Restart after a stop/ });
    expect(hint.textContent).toBe('123');
    expect(hint.getAttribute('aria-label')).toBe('Restart after a stop: step 3 of 3, Auto start');
    expect(hint.getAttribute('title')).toBe(RESTART_HINT);
    expect(RESTART_HINT).toMatch(/1 Release the E-stops.*2 Acknowledge.*3 Auto start/);
  });

  it('wires all 23 tags: every input is written, every lamp is read', () => {
    expect(PANEL_SIGNALS).toHaveLength(23);
    expect(new Set(PANEL_SIGNALS).size).toBe(23);
    // The TIA tags of the ControlPanel / Safety tables the window serves (SIGNALS.md).
    const TIA = [
      'BT1_ControlOnOff', 'BT1_ControlLight', 'BT2_OpMode',
      'BT3_SingleStep', 'BT3_SingleStepLight', 'BT4_AutoStart', 'BT4_AutoLight',
      'BT5_AutoStop', 'BT5_AutoStopLight', 'BT6_Ack', 'BT6_ErrFltLight',
      'BT7_Reset', 'BT7_HomingLight', 'BT8_ImmediateStop', 'BT8_ImmediateStopLight',
      'SignalTower_Blue', 'SignalTower_Red', 'SignalTower_Yellow', 'SignalTower_Green',
      'i_SS_ESTOP1', 'q_SS_ESTOP1', 'i_SS_ESTOP2', 'q_SS_ESTOP2',
    ];
    expect([...PANEL_SIGNALS].sort()).toEqual([...TIA].sort());
  });

  it('a momentary button writes its input true while held and false on release', () => {
    const r = rig();
    show(r);
    for (const b of LASERWELDING_PANEL.buttons) {
      const btn = button(b.label);
      fireEvent.pointerDown(btn);
      expect(r.store.get(b.signal), b.signal).toBe(true);
      fireEvent.pointerUp(btn);
      expect(r.store.get(b.signal), b.signal).toBe(false);
    }
    // Every release path counts — leaving the button releases it too.
    const bt8 = button('Immediate stop');
    fireEvent.pointerDown(bt8);
    expect(r.store.get('BT8_ImmediateStop')).toBe(true);
    fireEvent.pointerLeave(bt8);
    expect(r.store.get('BT8_ImmediateStop')).toBe(false);
  });

  it('caps carry the IEC function, rings the TIA lamp colour', () => {
    show(rig());
    const cap = (label: string) => button(label).querySelector('[data-part="cap"]')?.getAttribute('data-cap');
    expect(cap('Auto start')).toBe('green');
    expect(cap('Auto stop')).toBe('black');
    expect(cap('Immediate stop')).toBe('red');
    expect(cap('Single step')).toBe('white');
    expect(cap('Acknowledge')).toBe('blue');
    expect(cap('Home position')).toBe('white');
  });

  it('lamps follow their output signals', () => {
    const r = rig();
    show(r);
    expect(button('Auto start').getAttribute('data-lamp')).toBe('off');
    expect(screen.getByLabelText('Tower green').getAttribute('data-on')).toBe('false');
    act(() => {
      r.store.set('BT4_AutoLight', true);
      r.store.set('SignalTower_Green', true);
      r.store.set('q_SS_ESTOP2', true);
      r.store.set('BT1_ControlLight', true);
    });
    expect(button('Auto start').getAttribute('data-lamp')).toBe('on');
    expect(screen.getByRole('button', { name: 'Auto start, lamp on' })).toBeTruthy();
    expect(screen.getByLabelText('Tower green').getAttribute('data-on')).toBe('true');
    expect(screen.getByRole('button', { name: 'E-stop 2, lamp on' })).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Control, lamp on' })).toBeTruthy();
    act(() => { r.store.set('BT4_AutoLight', false); });
    expect(button('Auto start').getAttribute('data-lamp')).toBe('off');
  });

  it('lamps the virtual PLC never drives read "not driven" in Simulation, plain off with a PLC', () => {
    const r = rig();
    show(r);
    expect(button('Single step').getAttribute('data-lamp')).toBe('not-driven');
    expect(button('Home position').getAttribute('data-lamp')).toBe('not-driven');
    expect(screen.getByLabelText('Tower yellow').getAttribute('data-lamp')).toBe('not-driven');
    expect(button('Auto stop').getAttribute('data-lamp')).toBe('off');
    act(() => { r.mode.setMode('PLC'); });
    expect(button('Single step').getAttribute('data-lamp')).toBe('off');
    expect(screen.getByLabelText('Tower yellow').getAttribute('data-lamp')).toBe('off');
  });

  it('the selectors latch: CONTROL key 0 | I, MODE knob HAND | AUTO with a HAND chip', () => {
    const r = rig();
    show(r);
    const control = within(screen.getByRole('radiogroup', { name: /^Control/ }));
    fireEvent.click(control.getByRole('radio', { name: '0' }));
    expect(r.store.get('BT1_ControlOnOff')).toBe(false);
    fireEvent.click(control.getByRole('radio', { name: 'I' }));
    expect(r.store.get('BT1_ControlOnOff')).toBe(true);
    expect(screen.queryByRole('status', { name: 'Operating mode: Hand' })).toBeNull();
    const mode = within(screen.getByRole('radiogroup', { name: 'Mode' }));
    fireEvent.click(mode.getByRole('radio', { name: 'Hand' }));
    expect(r.store.get('BT2_OpMode')).toBe(false);
    expect(screen.getByRole('status', { name: 'Operating mode: Hand' }).textContent).toBe('HAND');
    fireEvent.keyDown(mode.getByRole('radio', { name: 'Hand' }), { key: 'ArrowRight' });
    expect(r.store.get('BT2_OpMode')).toBe(true);
  });

  it('an E-stop presses at once (normally closed: false) and releases only after a hold', () => {
    vi.useFakeTimers();
    const r = rig();
    show(r);
    const estop1 = screen.getByRole('button', { name: /^E-stop 1/ });
    expect(estop1.getAttribute('aria-pressed')).toBe('false');
    fireEvent.pointerDown(estop1, { pointerId: 1 });
    fireEvent.pointerUp(estop1, { pointerId: 1 });
    expect(r.store.get('i_SS_ESTOP1')).toBe(false);
    expect(r.store.get('i_SS_ESTOP2')).toBe(true);
    expect(estop1.getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerDown(estop1, { pointerId: 1 });
    fireEvent.pointerUp(estop1, { pointerId: 1 });
    expect(r.store.get('i_SS_ESTOP1')).toBe(false);   // a click does not release it
    fireEvent.pointerDown(estop1, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(RELEASE_HOLD_MS); });
    expect(r.store.get('i_SS_ESTOP1')).toBe(true);
  });

  it('the status strip names the state and the next step (plan-539 F8c)', () => {
    const r = rig();
    show(r);
    // Start: everything off, E-stops released → stopped.
    expect(stripText()).toMatch(/press AUTO START/);
    act(() => { r.store.set('SignalTower_Green', true); });
    expect(stripText()).toBe('AUTO');
    expect(screen.queryByRole('note', { name: /^Restart after a stop/ })).toBeNull();
    act(() => { r.store.set('SignalTower_Green', false); r.store.set('SignalTower_Blue', true); });
    expect(stripText()).toBe('STOPPING…');
    act(() => {
      r.store.set('SignalTower_Blue', false);
      r.store.set('SignalTower_Red', true);
      r.store.set('BT6_ErrFltLight', true);
      r.store.set('i_SS_ESTOP2', false);
    });
    expect(stripText()).toBe('FAULT: release E-stop 2');
    // Not acknowledgeable while an E-stop is pressed: Ack lit, not flashing.
    expect(button('Acknowledge').getAttribute('data-lamp')).toBe('on');
    act(() => { r.store.set('i_SS_ESTOP2', true); });
    expect(stripText()).toBe('FAULT: press ACK');
    expect(button('Acknowledge').getAttribute('data-lamp')).toBe('flash');
    expect(screen.getByRole('note', { name: /^Restart after a stop/ }).querySelector('[data-current="true"]')?.textContent)
      .toBe('2');
    act(() => { r.store.set('SignalTower_Red', false); r.store.set('BT6_ErrFltLight', false); });
    expect(stripText()).toMatch(/press AUTO START/);
  });

  it('the status rules cover both E-stops', () => {
    const v = (on: string[]) => (n: string) => on.includes(n);
    expect(resolveStatus(LASERWELDING_PANEL, v([]))?.text).toBe('FAULT: release E-stops 1 + 2');
    expect(resolveStatus(LASERWELDING_PANEL, v(['i_SS_ESTOP2']))?.text).toBe('FAULT: release E-stop 1');
  });

  it('shows the Simulation / PLC mode as a chip and follows it', () => {
    const r = rig();
    show(r);
    const chip = screen.getByRole('status', { name: 'Connection mode' });
    expect(chip.textContent).toBe('SIM');
    expect(chip.getAttribute('title')).toBe('Simulation');
    act(() => { r.mode.interfaceConnected('plc-1'); });
    expect(chip.getAttribute('title')).toBe('Simulation · interface connected');
    act(() => { r.mode.setMode('PLC'); });
    expect(screen.getByRole('status', { name: 'Connection mode' }).textContent).toBe('PLC');
  });

  it('collapsed, the title bar carries only the title — no chips, no stack light, no E-stop', async () => {
    show(rig());
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    await act(async () => { await Promise.resolve(); });
    const header = document.querySelector('[data-control-window-header]') as HTMLElement;
    expect(header.querySelector('[role="status"]')).toBeNull();
    expect(header.querySelector('[role="img"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^E-stop/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('Expand panel'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getAllByRole('button', { name: /^E-stop/ })).toHaveLength(2);
  });

  it('title-bar buttons have a 32 px hit area', () => {
    show(rig());
    const header = document.querySelector('[data-control-window-header]') as HTMLElement;
    const collapse = screen.getByLabelText('Collapse panel');
    expect(header.compareDocumentPosition(collapse) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getComputedStyle(collapse).width).toBe('32px');
    expect(getComputedStyle(collapse).height).toBe('32px');
  });

  it('stays disabled when the model lacks the panel signals, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = rig(PANEL_SIGNALS.filter((n) => n !== 'BT6_Ack'));
    show(r);
    expect((button('Auto start') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('alert', { name: 'Operator panel configuration' }).textContent)
      .toMatch(/buttons\[4\]\.signal 'BT6_Ack' not found in model/);
    r.panel.write('BT4_AutoStart', true);
    expect(r.store.get('BT4_AutoStart')).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('is data in the GLB (plan-543): one WebOperatorPanel, valid against the model, no model plugin', async () => {
    const rv = PANEL_NODE.extras!.realvirtual!.WebOperatorPanel;
    expect(PANEL_NODE.name).toBe('OperatorPanel');
    expect(rv.Title).toBe('Operator panel');
    expect(rv.Dock).toBe('top-left');
    expect(rv.StartCollapsed).toBe(false);
    expect(typeof rv.Config).toBe('string');
    // Every signal the panel names is a PLC signal node of the model.
    const signals = new Set<string>();
    for (const n of NODES) {
      for (const [type, data] of Object.entries(n.extras?.realvirtual ?? {})) {
        if (/^PLC(Input|Output)(Bool|Float|Int)$/.test(type)) signals.add(String(data.Name ?? n.name));
      }
    }
    expect(webOperatorPanelRuleWarnings(rv.Config, (name) => signals.has(name))).toEqual([]);
    // The demo row binds no model plugin any more.
    const project = await (await fetchFirst(DEMO_PROJECT)).json() as { documents: { id: string; scriptRef?: string }[] };
    const row = project.documents.find((d) => d.id === 'doc_laserweldingassemblystation_1n66y05');
    expect(row).toBeTruthy();
    expect(row!.scriptRef).toBeUndefined();
  });
});
