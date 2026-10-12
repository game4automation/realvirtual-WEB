// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-477 §9.2 — the three control-window building blocks.
 *
 * The load-bearing one is {@link MomentaryButton}: a press-and-hold whose
 * release is missed leaves the machine running. A3 enumerates every way a press
 * can end, and each of them is a test here.
 */

import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { ControlWindow, LatchGroup, MomentaryButton, ControlSlider } from '../src/core/hmi/ControlWindow';
import { isInteractive } from '../src/core/hmi/FloatingPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => false,
}));

vi.mock('../src/core/hmi/panel-anchor-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/hmi/panel-anchor-store')>(),
  getRecentAnchorPoint: () => null,
}));

function Wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider theme={rvDarkTheme}>{children}</ThemeProvider>;
}

let capture: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  localStorage.clear();
  capture = vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
});

afterEach(() => { cleanup(); capture.mockRestore(); localStorage.clear(); });

// ─── ControlWindow chrome ───────────────────────────────────────────────

describe('ControlWindow', () => {
  function renderWindow() {
    return render(
      <Wrapper>
        <ControlWindow title="Ribbon Tension" panelId="ribbon-tension-controls"
          defaultWidth={200} defaultPosition={{ x: 100, y: 100 }}>
          <div data-testid="controls">controls</div>
        </ControlWindow>
      </Wrapper>,
    );
  }

  it('is a labelled region that cannot be closed', () => {
    renderWindow();
    const region = screen.getByRole('region', { name: 'Ribbon Tension' });
    expect(region).toBeTruthy();
    expect(screen.queryByLabelText('Close window')).toBeNull();
  });

  it('rebinds dragging when the panel moves into the shell portal', () => {
    const content = <Wrapper><ControlWindow title="Portal drag" panelId="portal-drag" defaultWidth={200}
      defaultPosition={{ x: 100, y: 100 }}>content</ControlWindow></Wrapper>;
    const view = render(content);
    const oldHandle = document.querySelector('[data-drag-handle]');
    const host = document.createElement('div');
    host.id = 'rv-floating-panel-root';
    document.body.appendChild(host);
    try {
      view.rerender(<Wrapper><ControlWindow title="Portal drag" panelId="portal-drag" defaultWidth={200}
        defaultPosition={{ x: 100, y: 100 }}>content</ControlWindow></Wrapper>);
      const handle = host.querySelector('[data-drag-handle]')!;
      expect(handle).not.toBe(oldHandle);
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 120, clientY: 115 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 220, clientY: 165 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      expect(capture).toHaveBeenCalled();
      expect(getComputedStyle(screen.getByRole('region', { name: 'Portal drag' })).left).toBe('200px');
    } finally {
      view.unmount();
      host.remove();
    }
  });

  it('ignores Escape', () => {
    renderWindow();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('controls')).toBeTruthy();
  });

  it('collapses to its title bar and remembers it', () => {
    renderWindow();
    fireEvent.click(screen.getByLabelText('Collapse panel'));
    expect(screen.queryByTestId('controls')).toBeNull();
    expect(localStorage.getItem('rv-panel-collapsed:ribbon-tension-controls')).toBe('1');

    cleanup();
    renderWindow();
    expect(screen.queryByTestId('controls')).toBeNull();
  });

  it('has no resize handle', () => {
    renderWindow();
    expect(document.querySelector('[data-resize-handle]')).toBeNull();
  });
});

// ─── LatchGroup ─────────────────────────────────────────────────────────

describe('LatchGroup', () => {
  const OPTIONS = [
    { id: 'slack', label: 'Slack' },
    { id: 'normal', label: 'Normal' },
    { id: 'over', label: 'Overstretched' },
  ];

  it('reports the latched option through aria-pressed and latches only one', () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LatchGroup options={OPTIONS} value="normal" onChange={onChange} ariaLabel="Situation" />
      </Wrapper>,
    );
    expect(screen.getByRole('button', { name: 'Normal' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Slack' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Overstretched' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onChange with the option id', () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LatchGroup options={OPTIONS} value="normal" onChange={onChange} ariaLabel="Situation" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Slack' }));
    expect(onChange).toHaveBeenCalledWith('slack');
  });

  it('lights nothing when the model matches no option', () => {
    render(
      <Wrapper>
        <LatchGroup options={OPTIONS} value={null} onChange={vi.fn()} ariaLabel="Situation" />
      </Wrapper>,
    );
    for (const o of OPTIONS) {
      expect(screen.getByRole('button', { name: o.label }).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('never reports a deselect as a change — one is always latched', () => {
    const onChange = vi.fn();
    render(
      <Wrapper>
        <LatchGroup options={OPTIONS} value="normal" onChange={onChange} ariaLabel="Situation" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Normal' }));  // MUI sends null
    expect(onChange).not.toHaveBeenCalled();
  });
});

// ─── MomentaryButton (A3) ───────────────────────────────────────────────

describe('MomentaryButton — exactly one release per press', () => {
  function setup(props: Partial<React.ComponentProps<typeof MomentaryButton>> = {}) {
    const onPress = vi.fn();
    const onRelease = vi.fn();
    const utils = render(
      <Wrapper><MomentaryButton label="Load x2" onPress={onPress} onRelease={onRelease} {...props} /></Wrapper>,
    );
    return { onPress, onRelease, btn: screen.getByRole('button', { name: 'Load x2' }), ...utils };
  }

  it('down / up', () => {
    const { onPress, onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / leave / up — releases once, not twice', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.pointerLeave(btn, { pointerId: 1 });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / cancel', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.pointerCancel(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / lost pointer capture', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.lostPointerCapture(btn, { pointerId: 1 });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / window blur (alt-tab)', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.blur(window);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / tab hidden', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerDown(btn, { pointerId: 1 });
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    spy.mockRestore();
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('down / unmount', () => {
    function Host() {
      const [mounted, setMounted] = useState(true);
      return (
        <Wrapper>
          <button type="button" onClick={() => setMounted(false)}>drop</button>
          {mounted && <MomentaryButton label="Load x2" onPress={press} onRelease={rel} />}
        </Wrapper>
      );
    }
    const press = vi.fn();
    const rel = vi.fn();
    render(<Host />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Load x2' }), { pointerId: 1 });
    fireEvent.click(screen.getByText('drop'));
    expect(rel).toHaveBeenCalledTimes(1);
  });

  it('a release with no press does nothing', () => {
    const { onRelease, btn } = setup();
    fireEvent.pointerUp(btn, { pointerId: 1 });
    fireEvent.blur(window);
    expect(onRelease).not.toHaveBeenCalled();
  });

  it('Space presses and releases, and auto-repeat does not re-press', () => {
    const { onPress, onRelease, btn } = setup();
    fireEvent.keyDown(btn, { key: ' ' });
    fireEvent.keyDown(btn, { key: ' ', repeat: true });
    fireEvent.keyDown(btn, { key: ' ', repeat: true });
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(btn, { key: ' ' });
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('Enter behaves the same', () => {
    const { onPress, onRelease, btn } = setup();
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.keyUp(btn, { key: 'Enter' });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onRelease).toHaveBeenCalledTimes(1);
  });

  it('is a one-shot action when no onRelease is given', () => {
    const onPress = vi.fn();
    render(<Wrapper><MomentaryButton label="Reset" onPress={onPress} /></Wrapper>);
    const btn = screen.getByRole('button', { name: 'Reset' });
    fireEvent.pointerDown(btn, { pointerId: 1 });
    fireEvent.pointerUp(btn, { pointerId: 1 });
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does nothing while disabled', () => {
    const { onPress, btn } = setup({ disabled: true });
    fireEvent.pointerDown(btn, { pointerId: 1 });
    expect(onPress).not.toHaveBeenCalled();
  });
});

// ─── ControlSlider ──────────────────────────────────────────────────────

describe('ControlSlider', () => {
  function setup(value = 800) {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <Wrapper>
        <ControlSlider label="Nip 2" unit="mm/s" min={700} max={900} value={value}
          onChange={onChange} onCommit={onCommit} />
      </Wrapper>,
    );
    return { onChange, onCommit, input: screen.getByRole('slider') as HTMLInputElement };
  }

  it('shows the live value with its unit', () => {
    setup(784);
    expect(screen.getByText('784 mm/s')).toBeTruthy();
  });

  it('reports changes and the commit', () => {
    const { onChange, onCommit, input } = setup();
    fireEvent.change(input, { target: { value: '850' } });
    expect(onChange).toHaveBeenCalledWith(850);
    // MUI commits on the pointer/key release that ends the interaction.
    fireEvent.keyDown(input, { key: 'ArrowRight' });
    fireEvent.keyUp(input, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalled();
  });

  it('is exempt from the panel drag (F9)', () => {
    setup();
    const thumb = document.querySelector('.MuiSlider-thumb') as HTMLElement;
    const root = document.querySelector('.MuiSlider-root') as HTMLElement;
    expect(isInteractive(thumb)).toBe(true);
    expect(isInteractive(root)).toBe(true);
  });
});

describe('drag exemptions', () => {
  it('covers the latch buttons too', () => {
    render(
      <Wrapper>
        <LatchGroup options={[{ id: 'a', label: 'A' }]} value="a" onChange={vi.fn()} ariaLabel="x" />
      </Wrapper>,
    );
    const tb = document.querySelector('.MuiToggleButton-root') as HTMLElement;
    expect(isInteractive(tb)).toBe(true);
  });

  /**
   * The window grows with whatever a project puts in it, and it used to stop
   * moving once it outgrew the screen: `clampToViewport` collapsed its travel
   * to a single y, because the "fits on screen" value is below the top margin
   * for an oversized panel. The Ribbon Tension window lost its drag that way
   * TWICE — first at plan-477, then again when the regulated slitter added a
   * group. The old answer was to keep the window short, which is a diet, not a
   * fix: the next group breaks it again.
   *
   * So the panel caps itself at the viewport and scrolls its content instead.
   * That is what these two assert — a capped panel can never reach the
   * degenerate clamp in the first place.
   */
  it('caps itself at the viewport instead of growing off the screen', () => {
    render(
      <Wrapper>
        <ControlWindow title="Tall" panelId="tall-window" defaultWidth={200}
          defaultPosition={{ x: 100, y: 100 }}>
          <div style={{ height: 5000 }}>a group too many</div>
        </ControlWindow>
      </Wrapper>,
    );
    const panel = document.querySelector('[data-ui-panel]') as HTMLElement;
    expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight);
  });

  it('scrolls the content it had to cap, but never the title bar', () => {
    render(
      <Wrapper>
        <ControlWindow title="Tall" panelId="tall-window-2" defaultWidth={200}
          defaultPosition={{ x: 100, y: 100 }}>
          <div style={{ height: 5000 }}>a group too many</div>
        </ControlWindow>
      </Wrapper>,
    );
    const handle = document.querySelector('[data-drag-handle="true"]') as HTMLElement;
    const content = document.querySelector('[id^="rv-panel-content-"]') as HTMLElement;
    expect(getComputedStyle(content).overflowY).toBe('auto');
    // The grab handle stays put: scrolling it away would leave nothing to drag.
    expect(handle.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(getComputedStyle(handle).overflowY).not.toBe('auto');
  });

  it('does not drag the window when the slider inside it is grabbed', () => {
    render(
      <Wrapper>
        <ControlWindow title="T" panelId="drag-exempt" defaultWidth={200} defaultPosition={{ x: 100, y: 100 }}>
          <ControlSlider label="Nip 2" min={0} max={100} value={50} onChange={vi.fn()} />
        </ControlWindow>
      </Wrapper>,
    );
    const panel = document.querySelector('[data-ui-panel]') as HTMLElement;
    const before = getComputedStyle(panel).left;
    const thumb = document.querySelector('.MuiSlider-thumb') as HTMLElement;

    fireEvent.pointerDown(thumb, { pointerId: 7, clientX: 150, clientY: 150 });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 250, clientY: 150 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 250, clientY: 150 });

    expect(getComputedStyle(panel).left).toBe(before);
  });
});
