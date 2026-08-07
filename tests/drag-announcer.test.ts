// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drag-announcer.test.ts — plan-341 §9.10.
 *
 * The screen-reader voice of a signal drag: five moments, one `polite` region,
 * debounced, and silent when nothing changed. Driven through the REAL drag
 * store and the REAL drop registry rather than a stub, because the whole point
 * of the announcer is that it reads the Phase-2 transition stream — a stub
 * would happily keep passing after that stream changed shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDragAnnouncer,
  DRAG_ANNOUNCE_DEBOUNCE_MS,
  type DragAnnouncer,
} from '../src/core/hmi/drag-announcer';
import {
  createSignalDropTarget,
  type SignalDropHandle,
} from '../src/core/hmi/signal-drop-target';
import {
  armSignalDrag,
  updateSignalDrag,
  endSignalDrag,
  cancelSignalDrag,
  consumeSignalDragClick,
  type SignalDragPayload,
} from '../src/core/hmi/signal-drag-store';
import { dropRejectText, type DropRejectReason } from '../src/plugins/signal-bind/drop-accept';

const PAYLOAD: SignalDragPayload = {
  name: 'MC07_Start',
  direction: 'output',
  plcType: 'PLCOutputBool',
  origin: 'connect',
  interfaceId: 'iface-1',
};

const TYPE_REASON: DropRejectReason = { kind: 'type', expected: 'float', got: 'bool' };

/** Somewhere with no registered target under it — the drag starts here. */
const EMPTY_POINT = { x: 20, y: 400 };

interface Target {
  el: HTMLElement;
  handle: SignalDropHandle;
  onDrop: ReturnType<typeof vi.fn>;
  centre: { x: number; y: number };
}

const targets: Target[] = [];
let announcer: DragAnnouncer | null = null;

/**
 * A fixed-position row registered as a V2 drop target. Real geometry matters:
 * the registry resolves the hit through `elementFromPoint` and a rect fallback.
 */
function makeTarget(
  id: string,
  label: string,
  reason: DropRejectReason | null,
  top: number,
): Target {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;left:40px;top:${top}px;width:180px;height:24px;background:#333;`;
  el.textContent = label;
  document.body.appendChild(el);
  const onDrop = vi.fn();
  const handle = createSignalDropTarget({
    reject: () => reason,
    describe: () => ({ targetId: id, accessibleLabel: label }),
    onDrop,
  });
  handle.attach(el);
  const t: Target = { el, handle, onDrop, centre: { x: 130, y: top + 12 } };
  targets.push(t);
  return t;
}

/** Promote armed → dragging away from every target, so only "grabbed" is queued. */
function startDrag(): void {
  armSignalDrag(PAYLOAD, EMPTY_POINT.x, EMPTY_POINT.y);
  updateSignalDrag(EMPTY_POINT.x + 30, EMPTY_POINT.y);
}

function settle(): void {
  vi.advanceTimersByTime(DRAG_ANNOUNCE_DEBOUNCE_MS + 1);
}

function say(): string {
  return announcer?.message() ?? '';
}

beforeEach(() => {
  vi.useFakeTimers();
  cancelSignalDrag();
  consumeSignalDragClick();
  announcer = createDragAnnouncer();
});

afterEach(() => {
  cancelSignalDrag();
  consumeSignalDragClick();
  announcer?.dispose();
  announcer = null;
  for (const t of targets.splice(0)) {
    t.handle.dispose();
    t.el.remove();
  }
  vi.useRealTimers();
});

describe('drag announcer — the live region itself', () => {
  it('is a single polite region and never uses the deprecated drag ARIA', () => {
    const el = announcer!.element;
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
    expect(document.querySelectorAll('#rv-drag-announcer').length).toBe(1);

    makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    updateSignalDrag(130, 112);
    settle();

    // `aria-grabbed` / `aria-dropeffect` are deprecated since ARIA 1.1: the live
    // region IS their replacement, so neither may appear anywhere.
    expect(document.querySelectorAll('[aria-grabbed]').length).toBe(0);
    expect(document.querySelectorAll('[aria-dropeffect]').length).toBe(0);
  });

  it('disposes cleanly: the region leaves the DOM and stops listening', () => {
    makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    announcer!.dispose();
    expect(document.querySelectorAll('#rv-drag-announcer').length).toBe(0);

    // A full drag after disposal must not resurrect or throw.
    startDrag();
    updateSignalDrag(130, 112);
    settle();
    expect(document.querySelectorAll('#rv-drag-announcer').length).toBe(0);
    announcer = null;
  });
});

describe('drag announcer — the five moments', () => {
  it('1. announces the grab with type and direction', () => {
    startDrag();
    settle();
    expect(say()).toContain('MC07_Start');
    expect(say()).toContain('grabbed');
    expect(say()).toContain('Bool');
    expect(say()).toContain('PLC output');
  });

  it('2. announces a compatible row with its name and the available action', () => {
    const ok = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    settle();
    updateSignalDrag(ok.centre.x, ok.centre.y);
    settle();
    expect(say()).toBe('Over slot Flow.Run — compatible. Release to link.');
  });

  it('3. announces an incompatible row with the SAME words the tooltip uses', () => {
    const bad = makeTarget('slot:Speed', 'Speed', TYPE_REASON, 160);
    startDrag();
    settle();
    updateSignalDrag(bad.centre.x, bad.centre.y);
    settle();
    expect(say()).toContain('Over slot Speed — not compatible.');
    // One wording for tooltip, disabled picker option and announcement.
    expect(say()).toContain(dropRejectText(TYPE_REASON));
  });

  it('4. announces the successful link with signal AND slot', () => {
    const ok = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    updateSignalDrag(ok.centre.x, ok.centre.y);
    settle();

    endSignalDrag(ok.centre.x, ok.centre.y);
    settle();
    expect(ok.onDrop).toHaveBeenCalledTimes(1);
    expect(say()).toBe('Signal MC07_Start linked to slot Flow.Run.');
  });

  it('5. announces the cancel on ESC', () => {
    makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    updateSignalDrag(130, 112);
    settle();

    cancelSignalDrag();
    settle();
    expect(say()).toBe('Cancelled. Signal returned to the list.');
  });

  it('a release over a rejecting row explains itself instead of just cancelling', () => {
    const bad = makeTarget('slot:Speed', 'Speed', TYPE_REASON, 160);
    startDrag();
    updateSignalDrag(bad.centre.x, bad.centre.y);

    // Released INSIDE the debounce window: the "over Speed" sentence never got
    // spoken, so the outcome has to carry the cause on its own.
    endSignalDrag(bad.centre.x, bad.centre.y);
    settle();
    expect(bad.onDrop).not.toHaveBeenCalled();
    expect(say()).toBe(`Not linked — ${dropRejectText(TYPE_REASON)}`);
  });
});

describe('drag announcer — debounce and silence', () => {
  it('says nothing until the debounce settles', () => {
    const ok = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    settle();
    const grabbed = say();

    updateSignalDrag(ok.centre.x, ok.centre.y);
    vi.advanceTimersByTime(DRAG_ANNOUNCE_DEBOUNCE_MS - 10);
    expect(say()).toBe(grabbed); // still the previous sentence
    vi.advanceTimersByTime(20);
    expect(say()).toContain('Over slot Flow.Run');
  });

  it('a row crossed on the way somewhere else is never announced', () => {
    const crossed = makeTarget('slot:Speed', 'Speed', TYPE_REASON, 160);
    const aimed = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    settle();

    // Sweep through the rejecting row well inside the debounce window.
    updateSignalDrag(crossed.centre.x, crossed.centre.y);
    vi.advanceTimersByTime(20);
    updateSignalDrag(aimed.centre.x, aimed.centre.y);
    settle();

    expect(say()).toContain('Over slot Flow.Run');
    expect(say()).not.toContain('Speed');
  });

  it('does not re-announce without a state change', () => {
    const ok = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    updateSignalDrag(ok.centre.x, ok.centre.y);
    settle();

    let writes = 0;
    const observer = new MutationObserver((records) => { writes += records.length; });
    observer.observe(announcer!.element, { childList: true, characterData: true, subtree: true });

    // Twenty pointermoves inside the same row: one state, therefore no speech.
    for (let i = 0; i < 20; i++) updateSignalDrag(ok.centre.x + (i % 3), ok.centre.y);
    settle();

    observer.disconnect();
    expect(writes).toBe(0);
    expect(say()).toContain('Over slot Flow.Run');
  });

  it('the success sentence survives the leave the registry emits after the drop', () => {
    // Regression: `dropAt()` emits `outcome:accepted` and only THEN clears the
    // hover, so a naive listener treats that trailing `leave` as "drop the
    // pending sentence" and the user hears nothing about the link they made.
    const ok = makeTarget('slot:Flow.Run', 'Flow.Run', null, 100);
    startDrag();
    updateSignalDrag(ok.centre.x, ok.centre.y);
    settle();
    endSignalDrag(ok.centre.x, ok.centre.y);
    settle();
    expect(say()).toBe('Signal MC07_Start linked to slot Flow.Run.');
  });
});
