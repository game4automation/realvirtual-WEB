// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2010 §9.3 — `ToolFlyout`, the menu button of the floating tool toolbar.
 *
 * Covered: the ARIA menu-button contract, the three ways to open (click,
 * right-click, press-and-hold) and the keyboard one (Enter / ArrowDown), the
 * row kinds (a checkbox row toggles and stays open, an action row closes and
 * runs after), the focus policy per close reason — including the hand-off to a
 * popover an action row opens (gate finding SOL R1 #4) — Tab / Escape /
 * click-away, the active colour, the suppressed trigger tooltip and the surface
 * contract (no shadow, DROPDOWN_Z_INDEX).
 *
 * The trigger's Enter goes through a REAL key press (`vitest/browser`
 * userEvent): a native button turns Enter into a click itself, which a
 * synthetic `fireEvent.keyDown` would never do.
 */

import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { Popover, TextField } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { DROPDOWN_Z_INDEX } from '../src/core/hmi/action-group';
import { ACCENT } from '../src/core/hmi/shared-sx';
import {
  TOOL_FLYOUT_LONG_PRESS_MS, ToolFlyout, ToolFlyoutDivider, ToolFlyoutRow,
} from '../src/core/hmi/ToolFlyout';

// The vitest browser viewport is phone-sized (414 px) — pin the layout decision
// explicitly, desktop by default (the floating vertical toolbar).
const layout = vi.hoisted(() => ({ mobile: false }));

vi.mock('../src/hooks/use-mobile-layout', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/hooks/use-mobile-layout')>(),
  useMobileLayout: () => layout.mobile,
}));

const trigger = () => screen.getByTestId('fly');
const paper = () => document.querySelector<HTMLElement>('[data-rv-flyout-paper]');
const row = (id: string) => screen.getByTestId(id);

/** Hex `#rrggbb` → the `rgb(r, g, b)` a computed style reports. */
function rgbOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

interface HarnessProps {
  onAction?: (trigger: HTMLElement) => void;
  onCheck?: () => void;
  active?: boolean;
  disabledAction?: boolean;
}

/**
 * A toolbar-like column at the left edge with a control before and after the
 * flyout (Tab must reach the AFTER one), one checkbox row backed by real state,
 * a divider and two action rows.
 */
function Harness({ onAction, onCheck, active, disabledAction }: HarnessProps) {
  const [checked, setChecked] = useState(true);
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <div style={{ position: 'fixed', left: 40, top: 80, display: 'flex', flexDirection: 'column' }}>
        <button type="button" data-testid="before">before</button>
        <ToolFlyout title="Snap" menuLabel="Snap options" icon={<span>S</span>} active={active} testId="fly">
          <ToolFlyoutRow
            kind="checkbox"
            label="Grid snap"
            description="500 mm / 15°"
            checked={checked}
            onSelect={() => { setChecked((c) => !c); onCheck?.(); }}
            testId="row-grid"
          />
          <ToolFlyoutDivider />
          <ToolFlyoutRow label="Grid snap settings…" onSelect={(t) => onAction?.(t)} testId="row-settings" />
          <ToolFlyoutRow label="Refusing" disabled={disabledAction} onSelect={(t) => onAction?.(t)} testId="row-refusing" />
        </ToolFlyout>
        {/* Laid out but not focusable — Tab must skip it, not stall on it. */}
        <button type="button" data-testid="hidden-after" style={{ visibility: 'hidden' }}>hidden</button>
        <button type="button" data-testid="after">after</button>
      </div>
      <button type="button" data-testid="outside" style={{ position: 'fixed', right: 20, bottom: 20 }}>outside</button>
    </ThemeProvider>
  );
}

/** Harness whose action row opens a MUI Popover at the trigger (the snap settings case). */
function PopoverHarness() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <div style={{ position: 'fixed', left: 40, top: 80 }}>
        <ToolFlyout title="Snap" icon={<span>S</span>} testId="fly">
          <ToolFlyoutRow kind="checkbox" label="Grid snap" checked onSelect={() => {}} testId="row-grid" />
          <ToolFlyoutRow label="Grid snap settings…" onSelect={(t) => setAnchor(t)} testId="row-settings" />
        </ToolFlyout>
      </div>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)}>
        <TextField label="Translation" inputProps={{ 'data-testid': 'settings-field' }} />
      </Popover>
    </ThemeProvider>
  );
}

/** ClickAwayListener arms itself one macrotask after mounting. */
const armClickAway = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  layout.mobile = false;
});

describe('ToolFlyout — opening and ARIA', () => {
  it('a click opens it: aria-expanded, aria-controls → a named role="menu"', async () => {
    render(<Harness />);
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(trigger().getAttribute('aria-label')).toBe('Snap');

    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('menu', { name: 'Snap options' });
    expect(trigger().getAttribute('aria-controls')).toBe(menu.id);
    expect(row('row-grid').getAttribute('role')).toBe('menuitemcheckbox');
    expect(row('row-settings').getAttribute('role')).toBe('menuitem');
    // A click open puts the focus on the first row (keyboard can continue).
    expect(row('row-grid')).toHaveFocus();
  });

  it('a click on the open trigger closes it', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).toBeNull());
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('right-click opens it and suppresses the browser context menu', async () => {
    render(<Harness />);
    const notPrevented = fireEvent.contextMenu(trigger());
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(paper()).not.toBeNull());
  });

  it('Enter on the focused trigger opens it and focuses the first row; ArrowDown moves on', async () => {
    render(<Harness />);
    act(() => { trigger().focus(); });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    // The divider is skipped.
    expect(row('row-settings')).toHaveFocus();
    expect(paper()).not.toBeNull();
  });

  it('ArrowDown on the focused trigger opens it too', async () => {
    render(<Harness />);
    act(() => { trigger().focus(); });
    fireEvent.keyDown(trigger(), { key: 'ArrowDown' });
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
  });

  it(`press-and-hold (${TOOL_FLYOUT_LONG_PRESS_MS} ms) opens it; the click ending the press does not toggle it shut`, () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<Harness />);
    act(() => { fireEvent.pointerDown(trigger(), { button: 0, pointerType: 'touch' }); });
    act(() => { vi.advanceTimersByTime(TOOL_FLYOUT_LONG_PRESS_MS - 10); });
    expect(paper()).toBeNull();
    act(() => { vi.advanceTimersByTime(10); });
    expect(paper()).not.toBeNull();

    act(() => {
      fireEvent.pointerUp(trigger(), { button: 0, pointerType: 'touch' });
      // A pointer click (detail ≥ 1) — the one that ends the press.
      fireEvent.click(trigger(), { detail: 1 });
    });
    expect(paper()).not.toBeNull();
    // The NEXT click is an ordinary toggle again.
    act(() => { fireEvent.click(trigger(), { detail: 1 }); });
    expect(paper()).toBeNull();
  });

  it('a hold released OUTSIDE the trigger does not swallow the next keyboard click (Codex P1 #1)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<Harness />);
    act(() => { fireEvent.pointerDown(trigger(), { button: 0 }); });
    act(() => { vi.advanceTimersByTime(TOOL_FLYOUT_LONG_PRESS_MS); });
    expect(paper()).not.toBeNull();
    // The pointer leaves and is released elsewhere: no closing click on the trigger.
    act(() => { fireEvent.pointerLeave(trigger(), { button: 0 }); });
    act(() => { fireEvent.keyDown(document.activeElement!, { key: 'Escape' }); });
    expect(paper()).toBeNull();
    expect(trigger()).toHaveFocus();
    // Enter / Space on the focused trigger = a click with detail 0 → opens.
    act(() => { fireEvent.click(trigger(), { detail: 0 }); });
    expect(paper()).not.toBeNull();
  });

  it('a keyboard click right after a hold-open is never mistaken for the release click', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<Harness />);
    act(() => { fireEvent.pointerDown(trigger(), { button: 0 }); });
    act(() => { vi.advanceTimersByTime(TOOL_FLYOUT_LONG_PRESS_MS); });
    expect(paper()).not.toBeNull();
    // detail 0 = keyboard activation of the trigger → an ordinary toggle.
    act(() => { fireEvent.click(trigger(), { detail: 0 }); });
    expect(paper()).toBeNull();
  });

  it('a short press is an ordinary click (the hold timer is cancelled)', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<Harness />);
    act(() => {
      fireEvent.pointerDown(trigger(), { button: 0 });
      fireEvent.pointerUp(trigger(), { button: 0 });
      fireEvent.click(trigger());
    });
    expect(paper()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(TOOL_FLYOUT_LONG_PRESS_MS * 2); });
    // Still exactly one open menu, and a click closes it.
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).toBeNull();
  });
});

describe('ToolFlyout — rows', () => {
  it('a checkbox row: click runs onSelect, the menu stays OPEN, aria-checked follows the prop', async () => {
    const onCheck = vi.fn();
    render(<Harness onCheck={onCheck} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(row('row-grid').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(row('row-grid'));

    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(paper()).not.toBeNull();
    expect(row('row-grid').getAttribute('aria-checked')).toBe('false');
    expect(row('row-grid').getAttribute('aria-description')).toBe('500 mm / 15°');
  });

  it('Space on a checkbox row toggles it without closing; Enter does the same', async () => {
    const onCheck = vi.fn();
    render(<Harness onCheck={onCheck} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());

    fireEvent.keyDown(row('row-grid'), { key: ' ' });
    fireEvent.keyUp(row('row-grid'), { key: ' ' });
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(row('row-grid').getAttribute('aria-checked')).toBe('false');
    expect(paper()).not.toBeNull();

    fireEvent.keyDown(row('row-grid'), { key: 'Enter' });
    expect(onCheck).toHaveBeenCalledTimes(2);
    expect(row('row-grid').getAttribute('aria-checked')).toBe('true');
    expect(paper()).not.toBeNull();
  });

  it('an action row closes the menu and THEN runs onSelect with the trigger; focus is already back on it', async () => {
    const seen: Array<{ trigger: HTMLElement; focusOnTrigger: boolean }> = [];
    render(<Harness onAction={(t) => seen.push({ trigger: t, focusOnTrigger: document.activeElement === t })} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(row('row-settings')).toHaveFocus();

    fireEvent.keyDown(row('row-settings'), { key: 'Enter' });

    expect(seen).toHaveLength(1);
    expect(seen[0].trigger).toBe(trigger());
    // Close runs first and hands the focus back BEFORE the row's action.
    expect(seen[0].focusOnTrigger).toBe(true);
    await waitFor(() => expect(paper()).toBeNull());
    expect(trigger()).toHaveFocus();
  });

  it('a mouse-chosen action row closes the menu too', async () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    fireEvent.click(row('row-settings'));
    expect(onAction).toHaveBeenCalledWith(trigger());
    await waitFor(() => expect(paper()).toBeNull());
  });

  it('a disabled row neither runs nor closes, but stays focusable', async () => {
    const onAction = vi.fn();
    render(<Harness onAction={onAction} disabledAction />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(row('row-refusing').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(row('row-refusing'));
    expect(onAction).not.toHaveBeenCalled();
    expect(paper()).not.toBeNull();
    act(() => { row('row-settings').focus(); });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(row('row-refusing')).toHaveFocus();
  });

  it('keyboard path into a popover: Enter on "settings…" → popover → Escape → focus is on the trigger (SOL R1 #4)', async () => {
    render(<PopoverHarness />);
    act(() => { trigger().focus(); });
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(row('row-settings')).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByTestId('settings-field')).toBeTruthy());
    await waitFor(() => expect(paper()).toBeNull());
    // The popover took the focus …
    await waitFor(() => expect(document.querySelector('.MuiPopover-paper')?.contains(document.activeElement)).toBe(true));

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('settings-field')).toBeNull());
    // … and gave it back to the trigger it remembered.
    await waitFor(() => expect(trigger()).toHaveFocus());
  });
});

describe('ToolFlyout — closing and focus policy', () => {
  it('Escape closes and focuses the trigger', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    const notPrevented = fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(paper()).toBeNull());
    expect(trigger()).toHaveFocus();
  });

  it('Tab closes and moves the focus to the control AFTER the trigger', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    await waitFor(() => expect(paper()).toBeNull());
    expect(screen.getByTestId('after')).toHaveFocus();
  });

  it('Shift+Tab closes and moves the focus to the control BEFORE the trigger', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(paper()).toBeNull());
    expect(screen.getByTestId('before')).toHaveFocus();
  });

  it('a click away closes it and leaves the focus on what was clicked', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(row('row-grid')).toHaveFocus());
    await armClickAway();
    const outside = screen.getByTestId('outside');
    act(() => { outside.focus(); });
    fireEvent.click(outside);
    await waitFor(() => expect(paper()).toBeNull());
    expect(outside).toHaveFocus();
  });
});

describe('ToolFlyout — trigger state and surface', () => {
  it('active colours the trigger with the accent; inactive does not', () => {
    const { rerender } = render(<Harness active />);
    expect(getComputedStyle(trigger()).color).toBe(rgbOf(ACCENT));
    expect(trigger().getAttribute('data-active')).toBe('true');
    rerender(<Harness active={false} />);
    expect(getComputedStyle(trigger()).color).not.toBe(rgbOf(ACCENT));
    // The "opens a menu" corner wedge.
    expect(trigger().querySelector('[data-rv-caret]')).not.toBeNull();
  });

  it('the trigger tooltip shows while closed and is suppressed while the menu is open', async () => {
    // Only the TRIGGER's tooltip (MUI's Popper root says role="tooltip" for menus too).
    const tip = () => [...document.querySelectorAll('.MuiTooltip-popper')]
      .find((t) => t.textContent === 'Snap') ?? null;
    render(<Harness />);
    fireEvent.mouseOver(trigger());
    await waitFor(() => expect(tip()).not.toBeNull());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    await waitFor(() => expect(tip()).toBeNull());
  });

  it('the paper has no box-shadow and its layer stacks at DROPDOWN_Z_INDEX', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(paper()!.style.boxShadow).toBe('none');
    const shadow = getComputedStyle(paper()!).boxShadow;
    expect(shadow === 'none' || shadow === '').toBe(true);
    expect(paper()!.dataset.testid).toBe('fly-menu');

    let node: HTMLElement | null = paper();
    let z = 'auto';
    while (node && node !== document.body && z === 'auto') {
      z = getComputedStyle(node).zIndex;
      node = node.parentElement;
    }
    expect(Number(z)).toBe(DROPDOWN_Z_INDEX);
  });

  it('opens to the RIGHT of the trigger on desktop', async () => {
    render(<Harness />);
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(document.querySelector('.MuiPopper-root[role="presentation"]')?.getAttribute('data-popper-placement'))
      .toMatch(/^right/);
    const t = trigger().getBoundingClientRect();
    const p = paper()!.getBoundingClientRect();
    expect(p.left).toBeGreaterThanOrEqual(t.right);
  });

  it('opens ABOVE the trigger on the mobile bottom row', async () => {
    layout.mobile = true;
    render(
      <ThemeProvider theme={rvDarkTheme}>
        <div style={{ position: 'fixed', left: 40, bottom: 8 }}>
          <ToolFlyout title="Snap" icon={<span>S</span>} testId="fly">
            <ToolFlyoutRow label="One" onSelect={() => {}} />
          </ToolFlyout>
        </div>
      </ThemeProvider>,
    );
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(document.querySelector('.MuiPopper-root[role="presentation"]')?.getAttribute('data-popper-placement'))
      .toMatch(/^top/);
    expect(paper()!.getBoundingClientRect().bottom).toBeLessThanOrEqual(trigger().getBoundingClientRect().top + 1);
  });
});
