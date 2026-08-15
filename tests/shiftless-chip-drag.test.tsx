// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * shiftless-chip-drag — one pointerdown, three gestures (plan-422 F6, test 9.5).
 *
 * Dropping the Shift requirement makes the press ambiguous on purpose: the same
 * pointerdown now begins both the force click and the link drag, and only what
 * happens NEXT tells them apart. That is cheap to get subtly wrong in a way no
 * type checks — a plain click that silently stops forcing, or a drag that
 * forces the source signal on the way out — so each branch is pinned here.
 *
 *   mouse, press + release under 4 px   → force click, drag never started
 *   mouse, press + move past 4 px       → drag, and NO force on the source
 *   mouse, Shift + press                → unchanged: armed, click inert
 *   touch, tap                          → force click, nothing armed
 *   touch, hold then move               → drag
 *   touch, move before the hold elapses → scroll; nothing armed, click intact
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { SignalBadge } from '../src/core/hmi/rv-signal-badge';
import {
  getSignalDragPhase,
  getSignalDragPayload,
  consumeSignalDragClick,
  disposeSignalDrag,
} from '../src/core/hmi/signal-drag-store';

/** The chip's own long-press window, mirrored from rv-signal-badge. */
const LONG_PRESS_MS = 500;

function chipOf(container: HTMLElement): HTMLElement {
  return container.querySelector('.MuiChip-root') as HTMLElement;
}

/** Window-level pointer event — the drag store listens in the capture phase. */
function winPointer(type: 'pointermove' | 'pointerup', x: number, y: number): void {
  window.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true }));
}

function badge() {
  return render(
    <SignalBadge direction="output" plcType="PLCOutputBool" raw={true} signalName="PLC.ExitConveyorRun" />,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  disposeSignalDrag();
  consumeSignalDragClick();
  vi.useRealTimers();
  cleanup();
});

// ── Mouse ────────────────────────────────────────────────────────────────

describe('mouse — the release decides', () => {
  it('a press that never moves stays a force click', () => {
    const { container } = badge();
    fireEvent.pointerDown(chipOf(container), { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    expect(getSignalDragPhase(), 'a plain press must arm — that is what makes the drag reachable')
      .toBe('armed');

    winPointer('pointerup', 102, 101);   // 2.2 px — under the threshold
    expect(getSignalDragPhase()).toBe('idle');
    expect(consumeSignalDragClick(), 'the force click was swallowed').toBe(false);
  });

  it('a press that moves past the threshold becomes a drag, carrying the payload', () => {
    const { container } = badge();
    fireEvent.pointerDown(chipOf(container), { pointerType: 'mouse', button: 0, clientX: 100, clientY: 100 });
    winPointer('pointermove', 140, 100);
    expect(getSignalDragPhase()).toBe('dragging');
    expect(getSignalDragPayload()?.name).toBe('PLC.ExitConveyorRun');

    winPointer('pointerup', 140, 100);
    expect(getSignalDragPhase()).toBe('idle');
    // A completed drag must NEVER force the signal it started from.
    expect(consumeSignalDragClick()).toBe(true);
  });

  it('leaves the Shift path exactly as it was: armed, and inert on release', () => {
    const { container } = badge();
    fireEvent.pointerDown(chipOf(container), { pointerType: 'mouse', shiftKey: true, button: 0, clientX: 100, clientY: 100 });
    expect(getSignalDragPhase()).toBe('armed');
    winPointer('pointerup', 101, 100);
    expect(getSignalDragPhase()).toBe('idle');
    expect(consumeSignalDragClick(), 'Shift+Click has never forced and must not start now').toBe(true);
  });

  it('ignores a non-primary button', () => {
    const { container } = badge();
    fireEvent.pointerDown(chipOf(container), { pointerType: 'mouse', button: 2, clientX: 100, clientY: 100 });
    expect(getSignalDragPhase()).toBe('idle');
  });
});

// ── Touch ────────────────────────────────────────────────────────────────

describe('touch — the hold decides, and scrolling wins the tie', () => {
  it('a tap arms nothing and leaves the click alone', () => {
    const { container } = badge();
    const chip = chipOf(container);
    fireEvent.pointerDown(chip, { pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    expect(getSignalDragPhase(), 'a touch must not arm before the hold elapses').toBe('idle');

    fireEvent.pointerUp(chip, { pointerType: 'touch', clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(getSignalDragPhase(), 'the cancelled hold still fired').toBe('idle');
    expect(consumeSignalDragClick()).toBe(false);
  });

  it('a long press arms, and the following move drags', () => {
    const { container } = badge();
    fireEvent.pointerDown(chipOf(container), { pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(getSignalDragPhase()).toBe('armed');

    winPointer('pointermove', 150, 100);
    expect(getSignalDragPhase()).toBe('dragging');
    expect(getSignalDragPayload()?.name).toBe('PLC.ExitConveyorRun');
  });

  it('a move BEFORE the hold elapses is a scroll — nothing arms, ever', () => {
    const { container } = badge();
    const chip = chipOf(container);
    fireEvent.pointerDown(chip, { pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(chip, { pointerType: 'touch', clientX: 100, clientY: 140 });

    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(getSignalDragPhase(), 'a scroll fling started a drag').toBe('idle');
  });

  it('a cancelled pointer (browser took over the gesture) arms nothing', () => {
    const { container } = badge();
    const chip = chipOf(container);
    fireEvent.pointerDown(chip, { pointerType: 'touch', button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(chip, { pointerType: 'touch' });

    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(getSignalDragPhase()).toBe('idle');
  });
});
