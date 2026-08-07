// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-370 §9.7 — the additive `lastOpenedSide` must not disturb anything that
 * was there before (R9). Covers the full transition table from plan §2.4,
 * including the early exit that a naive implementation would have tripped over,
 * plus a regression guard on the legacy alias and the persistence payload.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LeftPanelManager, peekPersistedActivePanels } from '../src/core/hmi/left-panel-manager';

const LS_KEY = 'rv-left-panel-active';

beforeEach(() => { localStorage.removeItem(LS_KEY); });

describe('LeftPanelManager — unchanged behaviour', () => {
  it('keeps activePanel pointing at the left slot', () => {
    const lpm = new LeftPanelManager();
    lpm.open('hierarchy', 300, 'left');
    lpm.open('connect', 280, 'right');
    expect(lpm.activePanel).toBe('hierarchy');
    expect(lpm.activePanelWidth).toBe(300);
    expect(lpm.getSnapshot().activePanel).toBe('hierarchy');
    expect(lpm.getActive('right')).toBe('connect');
    expect(lpm.isOpen('connect')).toBe(true);
  });

  it('persists exactly as before — no new key, no changed payload', () => {
    const lpm = new LeftPanelManager();
    lpm.open('hierarchy', 300, 'left');
    lpm.open('connect', 280, 'right');
    expect(JSON.parse(localStorage.getItem(LS_KEY)!)).toEqual({
      left: { id: 'hierarchy', width: 300 },
      right: { id: 'connect', width: 280 },
    });
    expect(peekPersistedActivePanels()).toEqual(new Set(['hierarchy', 'connect']));
  });

  it('still notifies exactly once per real state change', () => {
    const lpm = new LeftPanelManager();
    const listener = vi.fn();
    lpm.subscribe(listener);
    lpm.open('hierarchy', 300, 'left');
    expect(listener).toHaveBeenCalledTimes(1);
    lpm.close('nothing-open-under-this-id');
    expect(listener).toHaveBeenCalledTimes(1); // full no-op, as before
  });
});

describe('LeftPanelManager — lastOpenedSide', () => {
  it('starts as null and follows every open', () => {
    const lpm = new LeftPanelManager();
    expect(lpm.getSnapshot().lastOpenedSide).toBeNull();
    lpm.open('hierarchy', 300, 'left');
    expect(lpm.getSnapshot().lastOpenedSide).toBe('left');
    lpm.open('connect', 280, 'right');
    expect(lpm.getSnapshot().lastOpenedSide).toBe('right');
  });

  // The early exit at `slot.activePanel === id && slot.activePanelWidth === width`
  // must not swallow a change of side.
  it('still moves the side when the same window is opened again', () => {
    const lpm = new LeftPanelManager();
    const listener = vi.fn();
    lpm.open('hierarchy', 300, 'left');
    lpm.open('connect', 280, 'right');
    lpm.subscribe(listener);
    lpm.open('hierarchy', 300, 'left'); // identical slot state, different side
    expect(lpm.getSnapshot().lastOpenedSide).toBe('left');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('is a true no-op when state and side are both unchanged', () => {
    const lpm = new LeftPanelManager();
    lpm.open('hierarchy', 300, 'left');
    const listener = vi.fn();
    lpm.subscribe(listener);
    const before = lpm.getSnapshot();
    lpm.open('hierarchy', 300, 'left');
    expect(listener).not.toHaveBeenCalled();
    expect(lpm.getSnapshot()).toBe(before); // same snapshot object
  });

  it('falls back to the remaining side on close, and to null when nothing is left', () => {
    const lpm = new LeftPanelManager();
    lpm.open('hierarchy', 300, 'left');
    lpm.open('connect', 280, 'right');
    lpm.close('connect');
    expect(lpm.getSnapshot().lastOpenedSide).toBe('left');
    lpm.close('hierarchy');
    expect(lpm.getSnapshot().lastOpenedSide).toBeNull();
  });

  it('leaves the side alone when closing a panel that is not open', () => {
    const lpm = new LeftPanelManager();
    lpm.open('connect', 280, 'right');
    lpm.close('hierarchy');
    expect(lpm.getSnapshot().lastOpenedSide).toBe('right');
  });

  it('follows toggle in both directions', () => {
    const lpm = new LeftPanelManager();
    lpm.toggle('hierarchy', 300, 'left');
    expect(lpm.getSnapshot().lastOpenedSide).toBe('left');
    lpm.toggle('hierarchy', 300, 'left');
    expect(lpm.getSnapshot().lastOpenedSide).toBeNull();
  });

  it('is NOT persisted — restore re-derives it, right last', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({
      left: { id: 'hierarchy', width: 300 },
      right: { id: 'connect', width: 280 },
    }));
    expect(localStorage.getItem(LS_KEY)).not.toContain('lastOpenedSide');

    const lpm = new LeftPanelManager();
    lpm.restore();
    expect(lpm.getSnapshot().lastOpenedSide).toBe('right');
  });

  it('stays null when restore finds nothing', () => {
    const lpm = new LeftPanelManager();
    lpm.restore();
    expect(lpm.getSnapshot().lastOpenedSide).toBeNull();
  });

  it('restores the legacy single-panel payload on the left', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ id: 'hierarchy', width: 300 }));
    const lpm = new LeftPanelManager();
    lpm.restore();
    expect(lpm.getSnapshot().lastOpenedSide).toBe('left');
    expect(lpm.activePanel).toBe('hierarchy');
  });
});
