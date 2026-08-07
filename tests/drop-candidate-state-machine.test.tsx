// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-candidate-state-machine.test.tsx — plan-341 §9.2.
 *
 * The base/hover state machine of §2.4, driven through the real drag store so
 * the trigger points (promotion, reset) are exercised, not simulated:
 *
 *   candidate → valid → candidate      (leaving returns to the BASE)
 *   candidate → invalid → neutral
 *   drag end clears everything
 *   mount DURING the drag picks the base state up
 *   unmount DURING the drag invalidates the hover and emits `leave`
 *   availability change re-evaluates the base
 *   several surfaces at once, registry-wide
 *   no stale entries after unmount
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  armSignalDrag,
  updateSignalDrag,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import {
  createSignalDropTarget,
  refreshSignalDropTarget,
  subscribeSignalDropTransitions,
  type SignalDropTransition,
} from '../src/core/hmi/signal-drop-target';

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  origin: 'connect',
  interfaceId: 'iface-1',
};

function zone(left: number, top: number, w = 100, h = 40): HTMLDivElement {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.style.zIndex = '99999';
  el.style.background = 'rgba(0,0,0,0.01)';
  document.body.appendChild(el);
  return el;
}

const state = (el: HTMLElement): string | null => el.getAttribute('data-rv-drop-state');

/** Start a real drag (arm + promote past the 4 px threshold). */
function startDrag(x = 900, y = 900): void {
  armSignalDrag(PAYLOAD, x, y);
  updateSignalDrag(x + 20, y);
}

const cleanup: Array<() => void> = [];
function track<T extends { dispose(): void }>(handle: T): T {
  cleanup.push(() => handle.dispose());
  return handle;
}

beforeEach(() => { cancelSignalDrag(); consumeSignalDragClick(); });
afterEach(() => {
  cancelSignalDrag();
  consumeSignalDragClick();
  for (const fn of cleanup.splice(0)) fn();
  document.querySelectorAll('div[style*="fixed"]').forEach((el) => el.remove());
});

describe('candidate base state', () => {
  it('marks every compatible entry at drag start and leaves the rest untouched', () => {
    const yes = zone(10, 10);
    const no = zone(10, 100);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'yes', accessibleLabel: 'Yes' }), onDrop: () => {},
    })).attach(yes);
    track(createSignalDropTarget({
      reject: () => ({ kind: 'no-provider' as const }),
      describe: () => ({ targetId: 'no', accessibleLabel: 'No' }),
      onDrop: () => {},
    })).attach(no);

    startDrag();
    expect(state(yes)).toBe('candidate');
    // Non-candidates stay UNCHANGED — the User decision was explicitly "no dimming".
    expect(state(no)).toBeNull();
  });

  it('goes candidate → valid → candidate, and clears only at drag end', () => {
    const el = zone(10, 10);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'a', accessibleLabel: 'A' }), onDrop: () => {},
    })).attach(el);

    startDrag();
    expect(state(el)).toBe('candidate');
    updateSignalDrag(50, 30);
    expect(state(el)).toBe('valid');
    updateSignalDrag(800, 600);
    expect(state(el)).toBe('candidate');
    cancelSignalDrag();
    expect(state(el)).toBeNull();
  });

  it('goes neutral → invalid → neutral for an incompatible row', () => {
    const el = zone(10, 10);
    track(createSignalDropTarget({
      reject: () => ({ kind: 'no-provider' as const }),
      describe: () => ({ targetId: 'b', accessibleLabel: 'B' }),
      onDrop: () => {},
    })).attach(el);

    startDrag();
    expect(state(el)).toBeNull();
    updateSignalDrag(50, 30);
    expect(state(el)).toBe('invalid');
    updateSignalDrag(800, 600);
    expect(state(el)).toBeNull();
  });
});

describe('lifecycle during a running drag', () => {
  it('a target mounted mid-drag adopts the base state immediately', () => {
    startDrag();
    const late = zone(10, 10);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'late', accessibleLabel: 'Late' }), onDrop: () => {},
    })).attach(late);
    // The popover opens ~250 ms into the drag; it must not look inert.
    expect(state(late)).toBe('candidate');
  });

  it('unmounting the hovered target invalidates the hover and emits leave', () => {
    const el = zone(10, 10);
    const handle = createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'gone', accessibleLabel: 'Gone' }), onDrop: () => {},
    });
    handle.attach(el);
    const seen: SignalDropTransition[] = [];
    const unsub = subscribeSignalDropTransitions((t) => seen.push(t));

    startDrag();
    updateSignalDrag(50, 30);
    expect(seen.at(-1)).toMatchObject({ phase: 'enter', targetId: 'gone' });
    handle.dispose();
    expect(seen.at(-1)).toEqual({ phase: 'leave', targetId: 'gone' });
    // No stale entry: the vanished row must not be resolvable any more.
    updateSignalDrag(51, 31);
    expect(seen.filter((t) => t.phase === 'enter')).toHaveLength(1);
    unsub();
  });

  it('re-evaluates the base state when availability changes mid-drag', () => {
    const el = zone(10, 10);
    let available = true;
    const handle = track(createSignalDropTarget({
      reject: () => (available ? null : { kind: 'unavailable' as const, detail: 'gone' }),
      describe: () => ({ targetId: 'flip', accessibleLabel: 'Flip' }),
      onDrop: () => {},
    }));
    handle.attach(el);

    startDrag();
    expect(state(el)).toBe('candidate');
    available = false;
    // The closure was already fresh; nothing re-evaluated it before.
    refreshSignalDropTarget(handle);
    expect(state(el)).toBeNull();
    available = true;
    refreshSignalDropTarget(handle);
    expect(state(el)).toBe('candidate');
  });
});

describe('registry-wide reach', () => {
  it('marks candidates across several surfaces at once (inspector AND popover)', () => {
    const inspectorRow = zone(10, 10);
    const popoverRow = zone(400, 300);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'inline', accessibleLabel: 'Inline' }), onDrop: () => {},
    })).attach(inspectorRow);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'popover', accessibleLabel: 'Popover' }), onDrop: () => {},
    })).attach(popoverRow);

    startDrag();
    expect(state(inspectorRow)).toBe('candidate');
    expect(state(popoverRow)).toBe('candidate');
  });

  it('emits exactly one outcome per drag, last', () => {
    const el = zone(10, 10);
    track(createSignalDropTarget({
      reject: () => null, describe: () => ({ targetId: 'c', accessibleLabel: 'C' }), onDrop: () => {},
    })).attach(el);
    const seen: SignalDropTransition[] = [];
    const unsub = subscribeSignalDropTransitions((t) => seen.push(t));

    startDrag();
    updateSignalDrag(50, 30);
    updateSignalDrag(800, 600);
    cancelSignalDrag();

    const outcomes = seen.filter((t) => t.phase === 'outcome');
    expect(outcomes).toEqual([{ phase: 'outcome', result: 'none' }]);
    expect(seen.at(-1)).toEqual({ phase: 'outcome', result: 'none' });
    unsub();
  });
});
