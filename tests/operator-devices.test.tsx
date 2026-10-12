// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-542 F1–F5, F9–F11 — the core operator devices (illuminated push button,
 * selector switch, emergency stop, stack light, pilot lamp), the IEC tokens
 * they alone may use, the lamp light, the plate surface and the generic
 * config-driven OperatorPanel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactNode } from 'react';
import { rvDarkTheme } from '../src/core/hmi/theme';
import {
  IEC_BEZEL, IEC_CAP, IEC_LAMP, IEC_LAMP_OFF,
} from '../src/core/hmi/shared-sx';
import {
  EmergencyStop, IlluminatedPushButton, OperatorPanel, OperatorPanelPlugin, PilotLamp, RELEASE_HOLD_MS,
  SelectorSwitch, StackLight, validateOperatorPanelConfig, type OperatorPanelConfig,
} from '../src/core/hmi/operator-devices';
import { ControlWindow } from '../src/core/hmi/ControlWindow';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { ConnectionModeController } from '../src/core/engine/rv-connection-mode';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

const Wrapper = ({ children }: { children: ReactNode }) => <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;

function mockReducedMotion(reduce: boolean) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList);
}

beforeEach(() => {
  if (!window.matchMedia) {
    // jsdom has no matchMedia; give the spy something to replace.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

// ─── F1: IEC tokens ─────────────────────────────────────────────────────

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255]
    .map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a: string, b: string): number {
  const x = luminance(a); const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The plate = rgba(15,15,15,0.92) over the #505050 worst case and over white. */
const PLATES = ['#141414', '#222222'];

describe('F1 — IEC tokens', () => {
  it('every cap (black via its bezel) and every lit ring clears 3:1 against the plate', () => {
    for (const plate of PLATES) {
      for (const [name, hex] of Object.entries(IEC_CAP)) {
        if (name === 'black') continue;
        expect(contrast(hex, plate), `cap ${name} on ${plate}`).toBeGreaterThanOrEqual(3);
      }
      for (const [name, hex] of Object.entries(IEC_LAMP)) {
        expect(contrast(hex, plate), `lamp ${name} on ${plate}`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(IEC_BEZEL, plate)).toBeGreaterThanOrEqual(3);
      expect(contrast(IEC_LAMP_OFF, plate)).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(IEC_CAP.black, IEC_BEZEL)).toBeGreaterThanOrEqual(3);
  });

  it('only the operator devices import the IEC tokens', () => {
    const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
      query: '?raw', import: 'default', eager: true,
    }) as Record<string, string>;
    const offenders = Object.entries(sources)
      .map(([path, text]) => [path.replace(/^\.\.\/src\//, ''), text] as const)
      .filter(([rel]) => rel !== 'core/hmi/shared-sx.ts' && !rel.startsWith('core/hmi/operator-devices/'))
      .filter(([, text]) => /\bIEC_(CAP|LAMP|BEZEL|LAMP_OFF|PLATE)\b/.test(text))
      .map(([rel]) => rel);
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});

// ─── F2: IlluminatedPushButton ─────────────────────────────────────────

describe('F2 — IlluminatedPushButton', () => {
  function setup(props: Partial<React.ComponentProps<typeof IlluminatedPushButton>> = {}) {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    render(
      <Wrapper>
        <IlluminatedPushButton label="Auto start" cap="green" lamp={{ color: 'green', on: false }}
          onPress={onPress} onRelease={onRelease} {...props} />
      </Wrapper>,
    );
    return { onPress, onRelease, btn: screen.getByRole('button', { name: /^Auto start/ }) };
  }

  it('writes once on press and once on release — pointerleave and window blur count', () => {
    const { onPress, onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.pointerLeave(btn, { pointerId: 1 });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute('aria-pressed')).toBe('false');

    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.blur(window);
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(2);
    expect(onRelease).toHaveBeenCalledTimes(2);
  });

  it('Space presses and releases without auto-repeat re-pressing', () => {
    const { onPress, onRelease, btn } = setup();
    fireEvent.keyDown(btn, { key: ' ' });
    fireEvent.keyDown(btn, { key: ' ', repeat: true });
    fireEvent.keyUp(btn, { key: ' ' });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('draws the cap in its IEC colour and does nothing while disabled', () => {
    const { onPress, btn } = setup({ disabled: true, cap: 'black' });
    expect(btn.querySelector('[data-part="cap"]')?.getAttribute('data-cap')).toBe('black');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('lamp off: solid unlit ring, no dot; lamp on: ring lit, dot in the legend, state in the name', () => {
    const { rerender } = render(
      <Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={{ color: 'red', on: false }} onPress={() => {}} /></Wrapper>,
    );
    let btn = screen.getByRole('button', { name: 'Ack, lamp off' });
    expect(btn.getAttribute('data-lamp')).toBe('off');
    expect(btn.querySelector('[data-part="lamp-dot"]')).toBeNull();
    rerender(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={{ color: 'red', on: true }} onPress={() => {}} /></Wrapper>);
    btn = screen.getByRole('button', { name: 'Ack, lamp on' });
    expect(btn.getAttribute('data-lamp')).toBe('on');
    expect(btn.querySelector('[data-part="lamp-dot"]')).not.toBeNull();
  });

  it('flash animates the ring at 2 Hz; reduced motion draws it dashed instead', () => {
    const lamp = { color: 'red' as const, on: true, flash: true };
    const { unmount } = render(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={lamp} onPress={() => {}} /></Wrapper>);
    let btn = screen.getByRole('button', { name: 'Ack, lamp flashing' });
    let ring = btn.querySelector('[data-part="ring"]') as HTMLElement;
    expect(btn.getAttribute('data-ring')).toBe('solid');
    expect(ring.style.animation).toMatch(/0\.5s/);
    unmount();

    mockReducedMotion(true);
    render(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={lamp} onPress={() => {}} /></Wrapper>);
    btn = screen.getByRole('button', { name: 'Ack, lamp flashing' });
    ring = btn.querySelector('[data-part="ring"]') as HTMLElement;
    expect(btn.getAttribute('data-ring')).toBe('dashed');
    expect(ring.style.animation).toBe('');
  });

  it('a lamp nothing drives is dotted and says so', () => {
    render(<Wrapper><IlluminatedPushButton label="Home" cap="white" lamp={{ color: 'green', on: false, driven: false }} onPress={() => {}} /></Wrapper>);
    const btn = screen.getByRole('button', { name: 'Home, lamp not driven in Simulation' });
    expect(btn.getAttribute('data-ring')).toBe('dotted');
    expect(btn.getAttribute('title')).toMatch(/not driven in Simulation/);
  });
});

// ─── F3: SelectorSwitch ─────────────────────────────────────────────────

describe('F3 — SelectorSwitch', () => {
  function setup(value: string | null = 'auto') {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <SelectorSwitch label="Mode" variant="knob" value={value} onChange={onChange}
          positions={[{ id: 'hand', legend: 'Hand' }, { id: 'auto', legend: 'Auto' }]} />
      </Wrapper>,
    );
    return { onChange, group: screen.getByRole('radiogroup', { name: 'Mode' }) };
  }

  it('is a radiogroup of the two positions with the set one checked and the pointer at +45°', () => {
    const { group } = setup('auto');
    expect(screen.getByRole('radio', { name: 'Auto' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Hand' }).getAttribute('aria-checked')).toBe('false');
    expect(group.querySelector('[data-part="knob"]')?.getAttribute('data-angle')).toBe('45');
  });

  it('clicking the knob turns it to the other position; clicking a legend selects it', () => {
    const { onChange, group } = setup('auto');
    fireEvent.click(group.querySelector('[data-part="ring"]') as HTMLElement);
    expect(onChange).toHaveBeenLastCalledWith('hand');
    fireEvent.click(screen.getByRole('radio', { name: 'Hand' }));
    expect(onChange).toHaveBeenLastCalledWith('hand');
    fireEvent.click(screen.getByRole('radio', { name: 'Auto' }));   // already set — no write
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('ArrowLeft / ArrowRight select the left / right position', () => {
    const { onChange } = setup('auto');
    const auto = screen.getByRole('radio', { name: 'Auto' });
    fireEvent.keyDown(auto, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('hand');
    fireEvent.keyDown(auto, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledTimes(1);   // Auto is already set
  });

  it('a key switch carries its lamp in the group name', () => {
    render(
      <Wrapper>
        <SelectorSwitch label="Control" variant="key" value="on" onChange={() => {}}
          positions={[{ id: 'off', legend: '0' }, { id: 'on', legend: 'I' }]} lamp={{ color: 'green', on: true }} />
      </Wrapper>,
    );
    const group = screen.getByRole('radiogroup', { name: 'Control, lamp on' });
    expect(group.getAttribute('data-variant')).toBe('key');
  });
});

// ─── F4: EmergencyStop ──────────────────────────────────────────────────

describe('F4 — EmergencyStop', () => {
  function Host({ initial = true, onWrite }: { initial?: boolean; onWrite: (v: boolean) => void }) {
    return <Wrapper><EmergencyStop label="E-stop 1" value={initial} onWrite={onWrite} lamp={{ on: false }} /></Wrapper>;
  }

  it('press is instant and writes false (normally closed)', () => {
    const onWrite = vi.fn();
    render(<Host onWrite={onWrite} />);
    const btn = screen.getByRole('button', { name: /^E-stop 1/ });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onWrite).toHaveBeenCalledWith(false);
  });

  it('released shows no state word — never green; pressed says PRESSED', () => {
    const { rerender } = render(<Host onWrite={() => {}} />);
    expect(screen.queryByText('PRESSED')).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/66bb6a|2e9e54|4cd679/i);
    rerender(<Host initial={false} onWrite={() => {}} />);
    expect(screen.getByText('PRESSED')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^E-stop 1/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('release needs a hold of at least 600 ms — letting go early releases nothing', () => {
    vi.useFakeTimers();
    const onWrite = vi.fn();
    render(<Host initial={false} onWrite={onWrite} />);
    const btn = screen.getByRole('button', { name: /^E-stop 1/ });
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(btn.getAttribute('data-holding')).toBe('true');
    act(() => { vi.advanceTimersByTime(RELEASE_HOLD_MS - 50); });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onWrite).not.toHaveBeenCalled();

    fireEvent.pointerDown(btn, { pointerId: 1 });
    act(() => { vi.advanceTimersByTime(RELEASE_HOLD_MS); });
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledWith(true);
  });

  it('keyboard: Enter held releases after the hold, R releases at once', () => {
    vi.useFakeTimers();
    const onWrite = vi.fn();
    render(<Host initial={false} onWrite={onWrite} />);
    const btn = screen.getByRole('button', { name: /^E-stop 1/ });
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.keyDown(btn, { key: 'Enter', repeat: true });
    act(() => { vi.advanceTimersByTime(RELEASE_HOLD_MS); });
    expect(onWrite).toHaveBeenCalledWith(true);
    onWrite.mockClear();
    fireEvent.keyDown(btn, { key: 'r' });
    expect(onWrite).toHaveBeenCalledWith(true);
  });

  it('a normally-open E-stop writes true when pressed', () => {
    const onWrite = vi.fn();
    render(<Wrapper><EmergencyStop label="E-stop NO" value={false} normallyClosed={false} onWrite={onWrite} /></Wrapper>);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'E-stop NO' }), { pointerId: 1 });
    expect(onWrite).toHaveBeenCalledWith(true);
  });

  it('the collar lamp is part of the name', () => {
    render(<Wrapper><EmergencyStop label="E-stop 2" value lamp={{ on: true }} onWrite={() => {}} /></Wrapper>);
    expect(screen.getByRole('button', { name: 'E-stop 2, lamp on' })).toBeTruthy();
  });
});

// ─── F5: StackLight / PilotLamp ─────────────────────────────────────────

describe('F5 — StackLight and PilotLamp', () => {
  it('stack light: segments top to bottom, lit ones named in words, undriven ones dotted', () => {
    render(
      <Wrapper>
        <StackLight segments={[
          { name: 'Blue', color: 'blue', on: false },
          { name: 'Red', color: 'red', on: true },
          { name: 'Yellow', color: 'yellow', on: false, driven: false },
          { name: 'Green', color: 'green', on: false },
        ]} />
      </Wrapper>,
    );
    const tower = screen.getByRole('img', { name: 'Signal tower: red on' });
    const segs = Array.from(tower.querySelectorAll('[data-lamp]')).map((s) => s.getAttribute('aria-label'));
    expect(segs).toEqual(['Tower blue', 'Tower red', 'Tower yellow', 'Tower green']);
    expect(screen.getByLabelText('Tower red').getAttribute('data-on')).toBe('true');
    expect(screen.getByLabelText('Tower yellow').getAttribute('data-lamp')).toBe('not-driven');
  });

  it('pilot lamp: role img, "<name> lamp, on/off"', () => {
    const { rerender } = render(<Wrapper><PilotLamp name="Control on" color="green" on={false} /></Wrapper>);
    expect(screen.getByRole('img', { name: 'Control on lamp, off' })).toBeTruthy();
    rerender(<Wrapper><PilotLamp name="Control on" color="green" on /></Wrapper>);
    expect(screen.getByRole('img', { name: 'Control on lamp, on' }).getAttribute('data-on')).toBe('true');
  });
});

// ─── F10: lamp light ────────────────────────────────────────────────────

describe('F10 — a lit lamp glows, an unlit one never', () => {
  it('push button: halo on the ring and a lit lens only while the lamp is on', () => {
    const { rerender } = render(
      <Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={{ color: 'red', on: false }} onPress={() => {}} /></Wrapper>,
    );
    let btn = screen.getByRole('button', { name: /^Ack/ });
    let ring = btn.querySelector('[data-part="ring"]') as HTMLElement;
    expect(btn.getAttribute('data-glow')).toBe('false');
    expect(ring.style.boxShadow).toBe('');
    rerender(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={{ color: 'red', on: true }} onPress={() => {}} /></Wrapper>);
    btn = screen.getByRole('button', { name: /^Ack/ });
    ring = btn.querySelector('[data-part="ring"]') as HTMLElement;
    expect(btn.getAttribute('data-glow')).toBe('true');
    expect(ring.style.boxShadow).toMatch(/8px 1px/);
    expect(getComputedStyle(btn.querySelector('[data-part="cap"]') as HTMLElement).backgroundImage).toMatch(/radial-gradient/);
  });

  it('flashing modulates the light; reduced motion keeps it steady', () => {
    const lamp = { color: 'red' as const, on: true, flash: true };
    const { unmount } = render(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={lamp} onPress={() => {}} /></Wrapper>);
    let ring = screen.getByRole('button', { name: /^Ack/ }).querySelector('[data-part="ring"]') as HTMLElement;
    expect(ring.style.getPropertyValue('--rv-lamp-glow')).toMatch(/8px 1px/);
    expect(ring.style.animation).toMatch(/0\.5s/);
    unmount();
    mockReducedMotion(true);
    render(<Wrapper><IlluminatedPushButton label="Ack" cap="blue" lamp={lamp} onPress={() => {}} /></Wrapper>);
    ring = screen.getByRole('button', { name: /^Ack/ }).querySelector('[data-part="ring"]') as HTMLElement;
    expect(ring.style.animation).toBe('');
    expect(ring.style.boxShadow).toMatch(/8px 1px/);
  });

  it('pilot lamp, stack light segment and E-stop collar glow only when lit', () => {
    render(
      <Wrapper>
        <PilotLamp name="A" color="green" on />
        <PilotLamp name="B" color="green" on={false} />
        <StackLight segments={[{ name: 'Red', color: 'red', on: true }, { name: 'Green', color: 'green', on: false }]} />
        <EmergencyStop label="E-stop 1" value lamp={{ on: true, color: 'yellow' }} onWrite={() => {}} />
        <EmergencyStop label="E-stop 2" value lamp={{ on: false, color: 'yellow' }} onWrite={() => {}} />
      </Wrapper>,
    );
    expect(screen.getByRole('img', { name: 'A lamp, on' }).getAttribute('data-glow')).toBe('true');
    expect(screen.getByRole('img', { name: 'B lamp, off' }).getAttribute('data-glow')).toBe('false');
    expect(screen.getByLabelText('Tower red').getAttribute('data-glow')).toBe('true');
    expect(screen.getByLabelText('Tower green').getAttribute('data-glow')).toBe('false');
    const ring = (name: string) => screen.getByRole('button', { name }).querySelector('[data-part="ring"]') as HTMLElement;
    expect(ring('E-stop 1, lamp on').style.boxShadow).toMatch(/8px 1px/);
    expect(ring('E-stop 2, lamp off').style.boxShadow).toBe('');
  });
});

// ─── F11: plate surface ─────────────────────────────────────────────────

describe('F11 — ControlWindow surface="plate"', () => {
  it('puts the window on the darkest glass, the default stays glass', () => {
    render(
      <Wrapper>
        <ControlWindow title="Plate" panelId="t-plate" surface="plate"><span>p</span></ControlWindow>
        <ControlWindow title="Glass" panelId="t-glass"><span>g</span></ControlWindow>
      </Wrapper>,
    );
    const bg = (name: string) => getComputedStyle(screen.getByRole('region', { name })).backgroundColor;
    expect(bg('Plate')).toBe('rgba(15, 15, 15, 0.92)');
    expect(bg('Glass')).toBe('rgba(30, 30, 30, 0.6)');
  });
});

// ─── F9: config-driven panel ────────────────────────────────────────────

/** A second, tiny station: one button, one E-stop, a two-rule strip. */
const MINI: OperatorPanelConfig = {
  version: 1,
  id: 'mini-panel',
  title: 'Mini panel',
  columns: 2,
  buttons: [{ label: 'Start', signal: 'S_Start', capColor: 'green', lamp: { signal: 'S_Run', color: 'green' }, row: 1, col: 1 }],
  selectors: [],
  estops: [{ label: 'E-stop', signal: 'S_Estop', lamp: { signal: 'S_EstopLamp', color: 'yellow' }, row: 1, col: 2 }],
  stackLight: [{ name: 'Green', signal: 'S_Run', color: 'green' }],
  status: [
    { kind: 'running', tone: 'ok', text: 'RUNNING', when: { signal: 'S_Run', is: true } },
    { kind: 'idle', tone: 'action', text: 'press START' },
  ],
};

function panelRig(config: unknown, signals: string[]) {
  const store = new SignalStore();
  for (const name of signals) store.register(name, `PLC/${name}`, name === 'S_Estop');
  let state: 'Connected' | 'Disconnected' = 'Disconnected';
  const mode = new ConnectionModeController({
    get connectionState() { return state; },
    setConnectionState: (s: 'Connected' | 'Disconnected') => { state = s; },
  });
  const plugin = new OperatorPanelPlugin(config);
  const viewer = { signalStore: store, connectionMode: mode, getPlugin: (id: string) => (id === plugin.id ? plugin : undefined) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin.onModelLoaded({} as any, viewer as any);
  const utils = render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <Wrapper><OperatorPanel viewer={viewer as any} panelId={plugin.id} /></Wrapper>,
  );
  return { store, plugin, ...utils };
}

const MINI_SIGNALS = ['S_Start', 'S_Run', 'S_Estop', 'S_EstopLamp'];

describe('F9 — OperatorPanel from a JSON config', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it('renders a second, tiny station config and wires it', () => {
    const r = panelRig(MINI, MINI_SIGNALS);
    expect(screen.getByRole('region', { name: 'Mini panel' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Station state' }).getAttribute('data-state')).toBe('idle');
    const start = screen.getByRole('button', { name: 'Start, lamp off' });
    fireEvent.pointerDown(start);
    expect(r.store.get('S_Start')).toBe(true);
    fireEvent.pointerUp(start);
    expect(r.store.get('S_Start')).toBe(false);
    act(() => { r.store.set('S_Run', true); });
    expect(screen.getByRole('status', { name: 'Station state' }).textContent).toBe('RUNNING');
    expect(screen.getByRole('img', { name: 'Signal tower: green on' })).toBeTruthy();
    fireEvent.pointerDown(screen.getByRole('button', { name: /^E-stop/ }), { pointerId: 1 });
    expect(r.store.get('S_Estop')).toBe(false);
    // Two equal columns.
    expect(getComputedStyle(r.container.ownerDocument.querySelector('[data-part="device-grid"]') as HTMLElement).gridTemplateColumns)
      .toMatch(/^(\S+) \1$/);
  });

  it('a config survives JSON.stringify / parse and renders identically', () => {
    const a = panelRig(MINI, MINI_SIGNALS);
    const htmlA = (document.querySelector('[role="region"]') as HTMLElement).innerHTML;
    a.unmount();
    cleanup();
    const copy = JSON.parse(JSON.stringify(MINI));
    expect(copy).toEqual(MINI);
    panelRig(copy, MINI_SIGNALS);
    const htmlB = (document.querySelector('[role="region"]') as HTMLElement).innerHTML;
    expect(htmlB).toBe(htmlA);
  });

  it('validation names the path and the problem; errors show in the window', () => {
    const bad = JSON.parse(JSON.stringify(MINI));
    bad.buttons[0].capColor = 'purple';
    bad.status[0].when = { signal: 'S_Run' };
    expect(validateOperatorPanelConfig(bad).errors).toEqual([
      "buttons[0].capColor must be one of red, yellow, green, blue, white, black (got \"purple\")",
      'status[0].when.is must be true or false',
    ]);
    const missing = validateOperatorPanelConfig(MINI, (n) => n !== 'S_Run');
    expect(missing.config).not.toBeNull();
    expect(missing.errors).toEqual(["buttons[0].lamp.signal 'S_Run' not found in model"]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    panelRig(MINI, MINI_SIGNALS.filter((n) => n !== 'S_Start'));
    expect(screen.getByRole('alert', { name: 'Operator panel configuration' }).textContent)
      .toMatch(/buttons\[0\]\.signal 'S_Start' not found in model/);
    expect((screen.getByRole('button', { name: /^Start/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    panelRig(bad, MINI_SIGNALS);
    expect(screen.getByRole('alert', { name: 'Operator panel configuration' }).textContent).toMatch(/capColor must be one of/);
    expect(screen.queryByRole('button', { name: /^Start/ })).toBeNull();
    warn.mockRestore();
  });

  it('legend boxes are fixed: every button legend has the same height, centred under its cap', () => {
    panelRig(MINI, MINI_SIGNALS);
    const legend = screen.getByRole('button', { name: /^Start/ }).querySelector('[data-part="legend"]') as HTMLElement;
    expect(getComputedStyle(legend).height).toBe('28px');
    expect(getComputedStyle(legend).textAlign).toBe('center');
  });
});
