// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drop-target.ts — central drop-target registry for signal drags
 * (plan-246 F9; candidate state machine + transition stream, plan-341 Phase 2).
 *
 * A thin domain instance of the GENERIC `createDropTargetRegistry<T, R>()`
 * (drop-target-registry.ts) — the detection mechanics (elementFromPoint +
 * ancestor walk, united-rect row-band fallback, `data-rv-drop-state` feedback)
 * live there and are shared with the node-link drag domain. This module binds
 * the two domain types: the payload is `SignalDragPayload`, the rejection
 * reason is `DropRejectReason`.
 *
 * React usage (React 19 cleanup refs):
 *   const dropRef = useSignalDropTarget({ reject, describe, onDrop });
 *   <Box ref={dropRef} sx={SIGNAL_DROP_SX}>…</Box>   // multiple elements OK
 */

import type { SignalDragPayload } from './signal-drag-store';
import type { DropRejectReason } from '../../plugins/signal-bind/drop-accept';
import {
  createDropTargetRegistry,
  type DropTargetV2,
  type DropTargetInput,
  type DropHandle,
  type DropTransition,
} from './drop-target-registry';

/** A signal slot as a drop target: one rule, one description, one drop. */
export type SignalDropTarget = DropTargetV2<SignalDragPayload, DropRejectReason>;

/** What the hook/factory accept (the legacy `accepts` form still compiles). */
export type SignalDropTargetInput = DropTargetInput<SignalDragPayload, DropRejectReason>;

/** Handle for imperative registration (non-React callers / tests). */
export type SignalDropHandle = DropHandle;

/** One transition of a running signal drag. */
export type SignalDropTransition = DropTransition<DropRejectReason>;

/**
 * The drag phase, injected rather than imported: `signal-drag-store` already
 * imports THIS module, so importing it back would close a cycle. The store
 * pushes its getter in at module load; without it the registry falls back to
 * its own `beginCandidates`/`endDrag` bookkeeping.
 */
let dragPhaseGetter: (() => boolean) | null = null;

/** Called once by signal-drag-store — see {@link dragPhaseGetter}. */
export function setSignalDragActiveGetter(getter: () => boolean): void {
  dragPhaseGetter = getter;
}

/** The signal drag domain's registry instance (module singleton, plan-246). */
const registry = createDropTargetRegistry<SignalDragPayload, DropRejectReason>({
  isDragging: () => dragPhaseGetter?.() ?? false,
});

/** Create a drop target that can span multiple DOM elements (e.g. one grid row's cells). */
export function createSignalDropTarget(target: SignalDropTargetInput): SignalDropHandle {
  return registry.createDropTarget(target);
}

/**
 * Mark the base state of every registered slot row for a starting drag
 * (plan-341 F3) — called once at the `armed → dragging` promotion, never per
 * pointermove, and registry-wide so the inspector's InlineSignalSlots and the
 * bind popover light up together.
 */
export function markSignalDropCandidates(payload: SignalDragPayload): void {
  registry.beginCandidates(payload);
}

/**
 * End of the user's drag (drop, empty drop, ESC): clears candidate + hover
 * states and emits `outcome:none` unless the drop already produced an outcome.
 */
export function clearSignalDropCandidates(): void {
  registry.endDrag();
}

/** Lifecycle teardown (plugin unload / model switch): clears silently. */
export function disposeSignalDropDrag(): void {
  registry.disposeDrag();
}

/** Re-evaluate one target's base state after its availability changed. */
export function refreshSignalDropTarget(handle: SignalDropHandle): void {
  registry.refreshEntry(handle);
}

/** Update hover feedback during a drag (called by the drag store per pointermove). */
export function updateSignalDropHover(x: number, y: number, payload: SignalDragPayload): void {
  registry.updateHover(x, y, payload);
}

/** Clear the hover feedback only — candidate base states survive. */
export function clearSignalDropHover(): void {
  registry.clearHover();
}

/**
 * Attempt a drop at a viewport point. Returns true when a registered target
 * was under the point AND accepted the payload (onDrop was invoked).
 */
export function dropSignalAt(x: number, y: number, payload: SignalDragPayload): boolean {
  return registry.dropAt(x, y, payload);
}

/** Subscribe to the drag's transition stream (tooltip, leader line, announcer). */
export function subscribeSignalDropTransitions(
  cb: (t: SignalDropTransition) => void,
): () => void {
  return registry.subscribe(cb);
}

/**
 * React hook: returns a callback ref registering the element as a drop target.
 * May be attached to multiple elements (React 19 ref-cleanup handles unmount).
 * `reject`/`describe`/`onDrop` are read through a ref, so inline closures are fine.
 */
export function useSignalDropTarget(target: SignalDropTargetInput): (el: HTMLElement | null) => (() => void) | void {
  return registry.useDropTarget(target);
}

/** Instrument Blue — the one accent of the product (DESIGN.md). */
const INSTRUMENT_BLUE = '#4fc3f7';

/**
 * The three drop states of a SIGNAL row (plan-341 §2.5, strengthened 30.07.).
 *
 *   candidate — EVERY compatible row the moment the drag starts: a full 1 px
 *               ring plus the faintest tint. It began as a 1 px left edge, and
 *               that was too quiet to answer the only question a dragging user
 *               has — "where CAN this go?" A left edge reads as a list marker;
 *               an outlined, tinted band reads as a target. Non-candidates
 *               still stay completely untouched (User decision: no dimming) —
 *               the contrast between "outlined" and "plain" is what carries it.
 *   valid     — the hovered compatible row: same hue, ring at full strength,
 *               heavier tint, plus the 3 px leading edge that says "this one".
 *   invalid   — the hovered incompatible row. Deliberately NOT red: since
 *               plan-341 Phase 0 a saturated red means "PLC input is TRUE", so a
 *               rejection is carried by dimming + a neutral ring + the LinkOff
 *               gutter icon + the reason tooltip — never by hue.
 *
 * `inset` box-shadows instead of borders: no layout shift, no reflow of the row
 * grid when the state flips mid-drag. The 120 ms transition is state feedback,
 * not decoration, and it is dropped entirely under `prefers-reduced-motion`.
 *
 * The two class hooks let an EMPTY candidate row swap its "– not linked" text
 * for a "Drop here" invitation with no React state and no re-render per
 * pointermove — see `rv-signal-slot-row.tsx`.
 */
export const SIGNAL_DROP_SX = {
  transition: 'box-shadow 120ms ease-out, background-color 120ms ease-out',
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
  '&[data-rv-drop-state="candidate"]': {
    boxShadow: `inset 0 0 0 1px rgba(79,195,247,0.55)`,
    bgcolor: 'rgba(79,195,247,0.05)',
    borderRadius: 0.5,
  },
  '&[data-rv-drop-state="valid"]': {
    boxShadow: `inset 0 0 0 1px ${INSTRUMENT_BLUE}, inset 3px 0 0 ${INSTRUMENT_BLUE}`,
    bgcolor: 'rgba(79,195,247,0.16)',
    borderRadius: 0.5,
  },
  '&[data-rv-drop-state="invalid"]': {
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.28)',
    borderRadius: 0.5,
    opacity: 0.5,
  },
  // "Drop here" replaces the empty-slot text while the row is a live target.
  '& .rv-slot-drop-hint': { display: 'none' },
  '&[data-rv-drop-state="candidate"], &[data-rv-drop-state="valid"]': {
    '& .rv-slot-empty-text': { display: 'none' },
    '& .rv-slot-drop-hint': { display: 'block' },
  },
} as const;
