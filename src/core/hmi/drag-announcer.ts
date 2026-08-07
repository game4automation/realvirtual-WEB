// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drag-announcer.ts — the screen-reader voice of a signal drag (plan-341 Phase 5, F12).
 *
 * ONE `aria-live="polite"` region for the whole shell, never one per row: a
 * live region has to exist in the DOM *before* its text changes, and a hundred
 * of them would either race or say nothing at all.
 *
 * ## Five moments, and where each comes from
 *
 * | Moment          | Source                                                    |
 * |-----------------|-----------------------------------------------------------|
 * | grabbed         | `subscribeSignalDrag()` — the `armed → dragging` promotion |
 * | over a valid    | `enter` transition with `reason: null`                     |
 * | over an invalid | `enter` transition with a reason                           |
 * | linked          | `outcome: 'accepted'`                                      |
 * | cancelled       | `outcome: 'rejected'` / `'none'`                           |
 *
 * Four of the five are registry transitions. The FIRST one cannot be: the
 * registry emits nothing at `beginCandidates()` (by contract — plan-341 §2.3
 * invariant 3 allows `enter`/`leave`/`outcome` and nothing else), and it never
 * sees the dragged payload's NAME, which is exactly what "Signal X grabbed"
 * needs. So the start is read from the drag store's phase transition, which is
 * the same event that triggers `beginCandidates()` one line earlier.
 *
 * ## Why a debounce
 *
 * The registry only emits on hover TRANSITIONS, never per pointermove, so the
 * stream is already quiet. The 100 ms debounce covers the remaining case: a
 * pointer sweeping across four rows on its way to the fifth would otherwise
 * queue four sentences nobody wants. A `leave` DROPS the pending sentence
 * instead of replacing it — a row that was crossed, not aimed at, says nothing.
 *
 * Identical consecutive messages are dropped as well, so re-entering the row
 * you just left is not narrated twice.
 *
 * ## The outcome closes the drag for this listener
 *
 * `dropAt()` emits the `outcome` and only THEN clears the hover, so the real
 * stream order on a successful drop is `outcome:accepted` followed by `leave`
 * — the plan's "outcome is always last" holds for the drop decision, not for
 * the byte order of the emissions. Taken literally, that trailing `leave` would
 * call `dropPending()` and swallow the success sentence while it is still
 * inside the debounce window, so the user would hear nothing at all about the
 * link they just made. Everything after the first `outcome` of a drag is
 * therefore ignored until the next `grabbed`.
 *
 * ## What is deliberately NOT here
 *
 * No `aria-grabbed`, no `aria-dropeffect`. Both are deprecated since ARIA 1.1
 * and are ignored (or mis-announced) by current screen readers; the live region
 * plus the keyboard path in `SignalSearchOverlay` is their replacement
 * (WCAG 2.2 SC 2.5.7). `tests/drag-announcer.test.ts` pins their absence.
 */

import {
  dropRejectText,
  plcKindOf,
  type DropRejectReason,
} from '../../plugins/signal-bind/drop-accept';
import {
  subscribeSignalDropTransitions,
  type SignalDropTransition,
} from './signal-drop-target';
import {
  getSignalDragPayload,
  getSignalDragPhase,
  subscribeSignalDrag,
  type SignalDragPayload,
} from './signal-drag-store';
import type { SignalDirection } from './rv-signal-badge';
import { NOT_LINKED_LABEL } from './signal-vocabulary';

/** Id of the single live region (one per document). */
export const DRAG_ANNOUNCER_ELEMENT_ID = 'rv-drag-announcer';

/** Settle time before a queued sentence is spoken. */
export const DRAG_ANNOUNCE_DEBOUNCE_MS = 100;

export interface DragAnnouncerOptions {
  /** Where the region is appended. Default `document.body`. */
  container?: HTMLElement;
  /** Override the debounce (tests). */
  debounceMs?: number;
}

export interface DragAnnouncer {
  /** The live region itself — exposed for assertions, not for writing. */
  readonly element: HTMLElement;
  /** The sentence currently in the region (post-debounce). */
  message(): string;
  dispose(): void;
}

// ── Sentences ────────────────────────────────────────────────────────────
//
// English, like the rest of the UI ("not linked", "pending", …). Every one
// follows object + state + available action, and a rejection ALWAYS quotes
// `dropRejectText()` verbatim so the tooltip, the picker's disabled option and
// this region say literally the same thing.

function kindLabel(plcType: string | undefined): string {
  switch (plcKindOf(plcType)) {
    case 'bool': return 'Bool';
    case 'int': return 'Int';
    case 'float': return 'Float';
    default: return 'unknown type';
  }
}

function directionLabel(direction: SignalDirection): string {
  switch (direction) {
    case 'output': return 'PLC output';
    case 'input': return 'PLC input';
    default: return 'unknown direction';
  }
}

function grabbedText(payload: SignalDragPayload): string {
  return `Signal ${payload.name} grabbed, ${kindLabel(payload.plcType)} `
    + `${directionLabel(payload.direction)}. Drag it onto a matching slot row.`;
}

function overValidText(slot: string): string {
  return `Over slot ${slot} — compatible. Release to link.`;
}

function overInvalidText(slot: string, reason: DropRejectReason): string {
  return `Over slot ${slot} — not compatible. ${dropRejectText(reason)}`;
}

function linkedText(signalName: string | null, slot: string): string {
  return signalName
    ? `Signal ${signalName} linked to slot ${slot}.`
    : `Signal linked to slot ${slot}.`;
}

/**
 * A drop released over a rejecting row. The same moment as a cancel, but it
 * carries the cause: the `enter` sentence that named it may still have been
 * inside the debounce window when the pointer came up, so without this the
 * user would hear nothing at all about why the link did not happen.
 */
function rejectedText(reason: DropRejectReason): string {
  return `${NOT_LINKED_LABEL} — ${dropRejectText(reason)}`;
}

function cancelledText(): string {
  return 'Cancelled. Signal returned to the list.';
}

// ── Region ───────────────────────────────────────────────────────────────

/** Off-screen but readable: `display:none` / `visibility:hidden` mute a live region. */
function styleVisuallyHidden(el: HTMLElement): void {
  const s = el.style;
  s.position = 'absolute';
  s.width = '1px';
  s.height = '1px';
  s.margin = '-1px';
  s.padding = '0';
  s.border = '0';
  s.overflow = 'hidden';
  s.clip = 'rect(0 0 0 0)';
  s.clipPath = 'inset(50%)';
  s.whiteSpace = 'nowrap';
}

export function createDragAnnouncer(options: DragAnnouncerOptions = {}): DragAnnouncer {
  const container = options.container ?? document.body;
  const debounceMs = options.debounceMs ?? DRAG_ANNOUNCE_DEBOUNCE_MS;

  const element = document.createElement('div');
  element.id = DRAG_ANNOUNCER_ELEMENT_ID;
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-atomic', 'true');
  styleVisuallyHidden(element);
  container.appendChild(element);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;
  let spoken = '';
  /** The payload of the running drag — the `outcome` carries the slot, not the signal. */
  let dragged: SignalDragPayload | null = null;
  let wasDragging = false;
  /** Set by the first `outcome` of a drag; mutes the trailing `leave` (see module doc). */
  let settled = false;

  function flush(): void {
    timer = null;
    const next = pending;
    pending = null;
    if (next === null || next === spoken) return; // no state change → no speech
    spoken = next;
    element.textContent = next;
  }

  function queue(text: string): void {
    pending = text;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  /** Drop a queued sentence unspoken (a row that was crossed, not aimed at). */
  function dropPending(): void {
    pending = null;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  const unsubDrag = subscribeSignalDrag(() => {
    const dragging = getSignalDragPhase() === 'dragging';
    if (dragging && !wasDragging) {
      wasDragging = true;
      settled = false;
      dragged = getSignalDragPayload();
      if (dragged) queue(grabbedText(dragged));
      return;
    }
    if (!dragging && wasDragging) {
      // The end was already announced by the `outcome`, which the store emits
      // (via clearSignalDropCandidates) BEFORE it notifies phase subscribers.
      // The lifecycle teardown (`disposeSignalDrag`) emits nothing by contract,
      // so the payload is released here rather than in the outcome branch.
      wasDragging = false;
      dragged = null;
    }
  });

  const unsubDrop = subscribeSignalDropTransitions((t: SignalDropTransition) => {
    if (settled) return; // the drag is decided; the trailing `leave` says nothing
    switch (t.phase) {
      case 'enter':
        queue(t.reason === null
          ? overValidText(t.accessibleLabel)
          : overInvalidText(t.accessibleLabel, t.reason));
        break;
      case 'leave':
        dropPending();
        break;
      case 'outcome':
        settled = true;
        if (t.result === 'accepted') queue(linkedText(dragged?.name ?? null, t.accessibleLabel));
        else if (t.result === 'rejected') queue(rejectedText(t.reason));
        else queue(cancelledText());
        break;
    }
  });

  return {
    element,
    message: () => element.textContent ?? '',
    dispose(): void {
      dropPending();
      unsubDrag();
      unsubDrop();
      element.remove();
    },
  };
}

// ── Shell mounting ───────────────────────────────────────────────────────

let singleton: DragAnnouncer | null = null;
let refCount = 0;

/**
 * Mount the shared region (idempotent, ref-counted). Returns the release
 * function; the region is torn down when the last holder releases it, so
 * StrictMode's mount/unmount/mount cycle cannot leave two regions behind.
 */
export function mountDragAnnouncer(options?: DragAnnouncerOptions): () => void {
  refCount += 1;
  singleton ??= createDragAnnouncer(options);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount -= 1;
    if (refCount > 0) return;
    singleton?.dispose();
    singleton = null;
  };
}
