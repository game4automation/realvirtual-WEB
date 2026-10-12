// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-507 §9.5 — `/` and Ctrl/Cmd+K belong to the open dashboard.
 *
 * The predicate alone cannot prove the claim, because the claim is about TWO
 * listeners on one document: the dashboard's capture-phase hook and the
 * BottomBar's bubble-phase consumer. The harness mounts both — the hook on a
 * real input, and a bubble listener that asks exactly what the BottomBar asks
 * (`isUnclaimedSearchShortcut`) — so "one press focuses one field" is observed,
 * not inferred.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { useRef } from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import {
  shouldFocusDashboardSearch, useDashboardSearchShortcut,
} from '../src/core/hmi/projects/dashboard-search-shortcut';
import { isUnclaimedSearchShortcut } from '../src/core/hmi/search-shortcut';

function ev(key: string, target: EventTarget | null, mods: Partial<{ ctrlKey: boolean; metaKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, altKey: false, target, ...mods };
}

describe('shouldFocusDashboardSearch', () => {
  it('`/` with the dashboard open on a project', () => {
    expect(shouldFocusDashboardSearch(ev('/', document.body), true, true)).toBe(true);
  });
  it('Ctrl+K and Cmd+K too', () => {
    expect(shouldFocusDashboardSearch(ev('k', document.body, { ctrlKey: true }), true, true)).toBe(true);
    expect(shouldFocusDashboardSearch(ev('K', document.body, { metaKey: true }), true, true)).toBe(true);
  });
  it('not on the project list', () => {
    expect(shouldFocusDashboardSearch(ev('/', document.body), true, false)).toBe(false);
  });
  it('not with the dashboard closed', () => {
    expect(shouldFocusDashboardSearch(ev('/', document.body), false, true)).toBe(false);
    expect(shouldFocusDashboardSearch(ev('k', document.body, { ctrlKey: true }), false, true)).toBe(false);
  });
  it('never while typing in an input', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      expect(shouldFocusDashboardSearch(ev('/', input), true, true)).toBe(false);
      expect(shouldFocusDashboardSearch(ev('k', input, { ctrlKey: true }), true, true)).toBe(false);
    } finally {
      input.remove();
    }
  });
});

// ─── Capture hook vs. bubble consumer ────────────────────────────────────

function Harness({ active, withInput = true }: { active: boolean; withInput?: boolean }) {
  const ref = useRef<HTMLInputElement | null>(null);
  useDashboardSearchShortcut(ref, active);
  return withInput ? <input data-testid="dash-search" ref={ref} defaultValue="abc" /> : null;
}

describe('useDashboardSearchShortcut with the BottomBar consumer beside it', () => {
  const spy = vi.fn();
  const prevented: boolean[] = [];
  const bubble = (e: KeyboardEvent) => {
    prevented.push(e.defaultPrevented);
    if (isUnclaimedSearchShortcut(e)) spy();
  };

  afterEach(() => {
    cleanup();
    document.removeEventListener('keydown', bubble);
    spy.mockReset();
    prevented.length = 0;
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  function mount(props: { active: boolean; withInput?: boolean }) {
    document.addEventListener('keydown', bubble);
    return render(<Harness {...props} />);
  }

  const input = () => document.querySelector<HTMLInputElement>('[data-testid="dash-search"]');

  it('active: `/` focuses and selects the field, the scene search never hears it', () => {
    mount({ active: true });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(input());
    expect(input()!.selectionStart).toBe(0);
    expect(input()!.selectionEnd).toBe(3);
    expect(spy).not.toHaveBeenCalled();
    expect(prevented).toEqual([true]);
  });

  it('active: Ctrl+K does the same', () => {
    mount({ active: true });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input());
    expect(spy).not.toHaveBeenCalled();
  });

  it('inactive: the press goes to the scene search, the field stays unfocused', () => {
    mount({ active: false });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(input());
  });

  it('active but no field mounted (dashboard open without a project): nothing is claimed', () => {
    mount({ active: true, withInput: false });
    fireEvent.keyDown(document.body, { key: '/' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prevented).toEqual([false]);
  });

  it('unmount removes the capture listener', () => {
    const view = mount({ active: true });
    view.unmount();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(prevented).toEqual([false]);
  });

  it('typing `/` inside the field is text: no focus change, no scene search', () => {
    mount({ active: true });
    const field = input()!;
    field.focus();
    field.setSelectionRange(1, 1);
    fireEvent.keyDown(field, { key: '/' });
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(1);
    expect(spy).not.toHaveBeenCalled();
    expect(prevented).toEqual([false]);
  });

  it('switching active off at runtime hands the key back', () => {
    const view = mount({ active: true });
    view.rerender(<Harness active={false} />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
