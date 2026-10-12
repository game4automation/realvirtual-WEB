// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-578 §9.2 + §9.3 — `ActionDropdownSegment`, the shared upward dropdown of
 * the bottom-right view cluster.
 *
 * Covered here: the anchor (opens UPWARD and stays in the viewport), the hover
 * timing and the shared trigger+paper hover zone, the touch path, the focus
 * policy per close reason, Escape / Tab / click-away, the suppressed trigger
 * tooltip, the no-shadow + UI-zoom contract, and the proxy-key attribute plus
 * the MCP press/afterglow it makes visible on a COLLAPSED trigger.
 *
 * `React` synthesizes `pointerenter`/`pointerleave` from the delegated
 * `pointerover`/`pointerout` pair, so the tests dispatch THOSE — a
 * non-bubbling `pointerenter` never reaches a React handler.
 *
 * The cases that need the private choreography itself
 * (`prepareCommandChoreography` → `simulateButtonClick`) live in the PRIVATE
 * sibling's test folder, as `tests/action-dropdown-proxy.test.tsx`. This file
 * must stay free of private imports — and of the private folder's NAME, which
 * `scripts/gen-private-test-excludes.mjs` also scans for, so even a mention in
 * a comment would classify it as private-dependent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  ActionDropdownSegment, ActionGroupPill, DROPDOWN_Z_INDEX, type ActionDropdownItem,
} from '../src/core/hmi/action-group';
import {
  _resetButtonSimStateForTest, setSimPhase, touchAfterglow,
} from '../src/core/hmi/button-sim-state';
import { getUIZoom, setUIZoom } from '../src/core/hmi/visual-settings-store';

const PROXY_KEYS = ['cmd.a', 'cmd.b'] as const;

const trigger = () => screen.getByTestId('dd-trigger');
const paper = () => document.querySelector<HTMLElement>('[data-rv-dropdown-paper]');
const popperRoot = () => document.querySelector<HTMLElement>('.MuiPopper-root');

/**
 * The cluster sits at the viewport's LOWER edge — that is the whole reason the
 * menu opens upward, so the fixture has to reproduce it. Rendered at the top of
 * the page the Popper's flip modifier would legitimately send the paper
 * downwards and the anchor assertion would measure the fixture, not the code.
 */
function renderSegment(
  items: ActionDropdownItem[],
  extra: Partial<React.ComponentProps<typeof ActionDropdownSegment>> = {},
) {
  return render(
    <div>
      <input data-testid="outside-input" />
      <button type="button" data-testid="outside-button">outside</button>
      <div style={{ position: 'fixed', bottom: 8, right: 8, zIndex: 1200 }}>
        <ActionGroupPill>
          <ActionDropdownSegment
            title="More view options"
            menuLabel="More view options"
            icon={<span data-testid="dd-icon">i</span>}
            items={items}
            buttonProps={{ 'data-testid': 'dd-trigger' }}
            {...extra}
          />
        </ActionGroupPill>
      </div>
    </div>,
  );
}

const localItems = (onA = () => {}, onB = () => {}): ActionDropdownItem[] => [
  { key: 'a', label: 'Alpha', active: true, onClick: onA, testId: 'dd-a' },
  { key: 'b', label: 'Beta', onClick: onB, testId: 'dd-b' },
];

/** A mouse hover that actually reaches React's synthesized enter handler. */
const hoverIn = (el: HTMLElement, pointerType = 'mouse') =>
  fireEvent.pointerOver(el, { pointerType });
const hoverOut = (el: HTMLElement, pointerType = 'mouse') =>
  fireEvent.pointerOut(el, { pointerType });

beforeEach(() => {
  _resetButtonSimStateForTest();
});

afterEach(() => {
  cleanup();
  _resetButtonSimStateForTest();
  setUIZoom(1);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ActionDropdownSegment — anchor and hover mechanics', () => {
  it('opens upward: the paper sits above the trigger and inside the viewport', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(popperRoot()?.getAttribute('data-popper-placement')).toBe('top-end');
    const t = trigger().getBoundingClientRect();
    const p = paper()!.getBoundingClientRect();
    // Above the trigger (1px tolerance for sub-pixel rounding) …
    expect(p.bottom).toBeLessThanOrEqual(t.top + 1);
    // … and fully inside the viewport (the acceptance criterion of §5.2).
    expect(p.top).toBeGreaterThanOrEqual(0);
  });

  it('opens after the hover delay and not before', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(140); });
    expect(paper()).toBeNull();
    act(() => { vi.advanceTimersByTime(20); });
    expect(paper()).not.toBeNull();
  });

  it('a click on a hover-opened menu PINS it instead of closing it', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    expect(paper()).not.toBeNull();
    // The natural "rest, then click": the menu the user just watched appear
    // must stay — and now owns the keyboard focus like a click-opened menu.
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).not.toBeNull();
    expect(paper()!.contains(document.activeElement)).toBe(true);
    // Once pinned it is a click-opened menu: the NEXT click toggles it shut.
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).toBeNull();
  });

  it('stays open while the pointer moves from the trigger onto the paper', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    expect(paper()).not.toBeNull();
    // Leaving the trigger starts the close timer; arriving on the paper cancels
    // it — trigger and paper are ONE hover zone.
    act(() => { hoverOut(trigger()); });
    act(() => { hoverIn(paper()!); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(paper()).not.toBeNull();
  });

  it('closes 250 ms after both trigger and paper are left', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    act(() => { hoverOut(trigger()); });
    act(() => { hoverIn(paper()!); });
    act(() => { hoverOut(paper()!); });
    act(() => { vi.advanceTimersByTime(240); });
    expect(paper()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(20); });
    expect(paper()).toBeNull();
  });

  it('stationary hover over the paper does not close it', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    act(() => { hoverOut(trigger()); });
    act(() => { hoverIn(paper()!); });
    // No further pointer traffic at all — a resting cursor must not expire it.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(paper()).not.toBeNull();
  });

  it('click toggles; a touch pointer does not double-toggle', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).not.toBeNull();
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).toBeNull();
    // Touch: the synthetic enter must NOT open, so the following tap toggles
    // exactly once instead of opening and closing again.
    act(() => { hoverIn(trigger(), 'touch'); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(paper()).toBeNull();
    act(() => { fireEvent.click(trigger()); });
    expect(paper()).not.toBeNull();
  });
});

describe('ActionDropdownSegment — keyboard and focus policy', () => {
  it('repeated ArrowDown/ArrowUp moves focus and keeps the menu OPEN', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByTestId('dd-a')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByTestId('dd-b')).toHaveFocus();
    expect(paper()).not.toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(screen.getByTestId('dd-a')).toHaveFocus();
    expect(paper()).not.toBeNull();
  });

  it('Tab closes the menu and lets focus continue naturally', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    // `fireEvent` returns false when a handler called preventDefault — Tab must
    // keep its browser default so the focus walks on by itself.
    const notPrevented = fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(notPrevented).toBe(true);
    expect(paper()).toBeNull();
    expect(document.activeElement).not.toBe(trigger());
  });

  it('hover-open does not move focus; click/Enter focuses the active item', async () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    const input = screen.getByTestId('outside-input');
    act(() => { input.focus(); });
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    expect(paper()).not.toBeNull();
    // A mouse passing by must not steal the keyboard focus out of a text field.
    expect(input).toHaveFocus();
    act(() => { hoverOut(trigger()); });
    act(() => { vi.advanceTimersByTime(300); });
    vi.useRealTimers();
    // The click path (which Enter/Space on the trigger takes too) does focus.
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByTestId('dd-a')).toHaveFocus());
  });

  it('Esc from the menu returns focus to the trigger', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByTestId('dd-a')).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(paper()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it('a hover timeout close does not move focus at all', () => {
    vi.useFakeTimers();
    renderSegment(localItems());
    const input = screen.getByTestId('outside-input');
    act(() => { input.focus(); });
    act(() => { hoverIn(trigger()); });
    act(() => { vi.advanceTimersByTime(160); });
    act(() => { hoverOut(trigger()); });
    act(() => { vi.advanceTimersByTime(300); });
    expect(paper()).toBeNull();
    // The focus was never inside the menu, so nothing may claim it back.
    expect(input).toHaveFocus();
  });

  it('click-away leaves focus on the clicked target, not on the trigger', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(screen.getByTestId('dd-a')).toHaveFocus());
    // ClickAwayListener arms itself one macrotask after mounting.
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const outside = screen.getByTestId('outside-button');
    act(() => { outside.focus(); });
    fireEvent.click(outside);
    await waitFor(() => expect(paper()).toBeNull());
    expect(outside).toHaveFocus();
    expect(trigger()).not.toHaveFocus();
  });
});

describe('ActionDropdownSegment — execution, tooltip, surface', () => {
  it('closes the menu BEFORE executing the item command', async () => {
    const calls: string[] = [];
    renderSegment(localItems(() => calls.push('a')));
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    fireEvent.click(screen.getByTestId('dd-a'));
    expect(calls).toEqual(['a']);
    expect(paper()).toBeNull();
  });

  it('suppresses the trigger tooltip while the menu is open', async () => {
    // A touch hover shows the tooltip without opening the menu — so the
    // suppression can be observed without racing the 150 ms hover delay.
    // Queried by the Tooltip's OWN class: MUI's Popper root hardcodes
    // `role="tooltip"`, so `getByRole('tooltip')` would also match the menu.
    // Only the TRIGGER's tooltip counts: an open menu's rows have their own.
    const tip = () => [...document.querySelectorAll('.MuiTooltip-popper')]
      .find((t) => t.textContent === 'More view options') ?? null;
    renderSegment(localItems());
    hoverIn(trigger(), 'touch');
    await waitFor(() => expect(tip()).not.toBeNull());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    await waitFor(() => expect(tip()).toBeNull());
  });

  it('the paper carries no box-shadow and scales with useUIZoom', async () => {
    setUIZoom(1.25);
    expect(getUIZoom()).toBe(1.25);
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    // DESIGN.md §4, The No-Shadow Rule — and the portal does not inherit the
    // HMIShell zoom, so the component applies it itself (F17).
    expect(paper()!.style.boxShadow).toBe('none');
    expect(paper()!.style.zoom).toBe('1.25');
    expect(getComputedStyle(paper()!).boxShadow === 'none'
      || getComputedStyle(paper()!).boxShadow === '').toBe(true);
  });

  it('the open menu stacks above the floating HMI surfaces', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    // The Popper root once ignored its `sx` z-index: the menu rendered with NO
    // stacking at all and the message tiles (z-index 1000) drew through it.
    let node: HTMLElement | null = paper();
    let z = 'auto';
    while (node && node !== document.body && z === 'auto') {
      z = getComputedStyle(node).zIndex;
      node = node.parentElement;
    }
    expect(Number(z)).toBe(DROPDOWN_Z_INDEX);
    // Above the cluster (1200) and the AGPL watermark (index.html, 9999).
    expect(DROPDOWN_Z_INDEX).toBeGreaterThan(9999);
  });

  it('the menu is a labelled radio group of menuitemradio rows', async () => {
    renderSegment(localItems());
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(trigger()).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(menu).toHaveAttribute('aria-label', 'More view options');
    expect(screen.getByTestId('dd-a')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('dd-b')).toHaveAttribute('aria-checked', 'false');
  });
});

describe('ActionDropdownSegment — proxy keys (§9.3)', () => {
  it('the collapsed trigger carries data-rv-button-proxy for every key', () => {
    renderSegment(localItems(), { proxyKeys: PROXY_KEYS });
    expect(trigger()).toHaveAttribute('data-rv-button-proxy', 'cmd.a cmd.b');
  });

  it('the OPEN trigger drops the proxy attribute', async () => {
    renderSegment(localItems(), { proxyKeys: PROXY_KEYS });
    fireEvent.click(trigger());
    await waitFor(() => expect(paper()).not.toBeNull());
    expect(trigger()).not.toHaveAttribute('data-rv-button-proxy');
  });

  it('a trigger without proxy keys behaves exactly as before (no attribute)', () => {
    renderSegment(localItems());
    expect(trigger()).not.toHaveAttribute('data-rv-button-proxy');
  });

  it('the afterglow of any proxied key is visible on the collapsed trigger', () => {
    renderSegment(localItems(), { proxyKeys: PROXY_KEYS });
    const before = getComputedStyle(trigger()).animationName;
    act(() => { touchAfterglow('cmd.b', 'cmd.b'); });
    const after = getComputedStyle(trigger()).animationName;
    expect(after).not.toBe(before);
    expect(after === 'rvAiGlowA' || after === 'rvAiGlowB').toBe(true);
  });

  it('the newest touch wins when two keys glow within the afterglow window', () => {
    renderSegment(localItems(), { proxyKeys: PROXY_KEYS });
    act(() => { touchAfterglow('cmd.a', 'cmd.a'); });
    const first = getComputedStyle(trigger()).animationName;
    act(() => { touchAfterglow('cmd.b', 'cmd.b'); });
    const second = getComputedStyle(trigger()).animationName;
    // `seq` alternates the keyframe name, so the newer touch RESTARTS the fade
    // instead of being swallowed by the older one.
    expect(second).not.toBe(first);
  });

  it('a press phase takes precedence over a pending afterglow', () => {
    renderSegment(localItems(), { proxyKeys: PROXY_KEYS });
    act(() => { touchAfterglow('cmd.a', 'cmd.a'); });
    expect(getComputedStyle(trigger()).animationName).not.toBe('none');
    act(() => { setSimPhase('cmd.b', 'pressed'); });
    // While the choreography presses, the trigger shows the press — the
    // afterglow animation must not run on top of it.
    expect(getComputedStyle(trigger()).animationName).toBe('none');
    act(() => { setSimPhase('cmd.b', null); });
    expect(getComputedStyle(trigger()).animationName).not.toBe('none');
  });
});
