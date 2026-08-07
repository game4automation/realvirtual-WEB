// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * drop-target-registry.ts — generic, payload-typed drop-target registry
 * (plan-259; generalized from the plan-246 signal drop targets; candidate
 * state machine + transition stream added by plan-341 Phase 2).
 *
 * `createDropTargetRegistry<T, R>()` mints an ISOLATED registry instance for one
 * drag domain (signal linking, node linking, …) — separate registries never
 * see each other's targets, so a node-link drag can never drop onto a signal
 * slot and vice versa. `T` is the payload, `R` the DOMAIN-SPECIFIC rejection
 * reason; this module never inspects `R` and stays domain-free.
 *
 * Drop detection is deliberately NOT per-element pointer events: MUI popovers
 * and portals capture/stop pointer events, so a drop inside them would never
 * reach an element-level handler reliably. Targets register their DOM
 * elements; the drag store resolves the target at pointerup with
 * `document.elementFromPoint` + an ancestor walk, falling back to a
 * united-rect band test (portal stacking can never swallow the hit).
 *
 * ## Three states, not two (plan-341 §2.4)
 *
 * A drag now has a BASE state per entry, which hover only overrides temporarily:
 *
 *     beginCandidates(payload)
 *         accepts  → base = 'candidate'      (all compatible rows, registry-wide)
 *         rejects  → base = null             (unchanged, never dimmed)
 *     hover enter  → 'valid' | 'invalid'
 *     hover leave  → back to BASE, not to null
 *     endDrag()    → all → null
 *
 * Late mount (a popover that opens 250 ms into the drag) picks the base state up
 * in `attach()`; unmount invalidates the hover pointer and emits `leave`.
 *
 * ## Transition stream
 *
 * `subscribe()` yields `enter` / `leave` / exactly one `outcome` per drag, in
 * that order. It is the ONE data path for the reason tooltip, the panel leader
 * line and (plan-341 Phase 5) the aria-live announcer — a bare attribute
 * mutation triggers no React render, so a stream is required.
 *
 * ## Legacy targets
 *
 * A target may still register with `accepts`/`onDrop` (the node-link domain
 * does). Internally that normalizes onto a `unique symbol` which is NEVER
 * emitted, so `R` stays clean: a legacy target without `describe()` takes part
 * in NO transition at all. It still gets its `data-rv-drop-state`, so its
 * appearance is byte-for-byte what it was before.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

/** Identity + accessible name of a target — the only thing subscribers learn. */
export interface DropTargetDescription {
  targetId: string;
  accessibleLabel: string;
}

/** The current form: one rejection rule, one description, one drop. */
export interface DropTargetV2<T, R> {
  /** THE single source of truth. `null` = accepted, anything else = the reason. */
  reject: (payload: T) => R | null;
  /** Identity for the transition stream (tooltip / announcer). */
  describe: () => DropTargetDescription;
  /** Apply the drop. Only called when `reject()` returned null. */
  onDrop: (payload: T) => void;
}

/** Legacy form — kept verbatim so the node-link domain needs no change. */
export interface DropTargetLegacy<T> {
  /** Validate the payload. Invalid targets show rejecting feedback and ignore the drop. */
  accepts: (payload: T) => boolean;
  /** Apply the drop. Only called when accepts() passed. */
  onDrop: (payload: T) => void;
}

/** What `createDropTarget()` / `useDropTarget()` accept. Exported on purpose. */
export type DropTargetInput<T, R> = DropTargetV2<T, R> | DropTargetLegacy<T>;

/**
 * @deprecated Legacy alias. New targets use {@link DropTargetV2}; this keeps
 * `DropTarget<NodeLinkDragPayload>` and friends compiling unchanged.
 */
export type DropTarget<T> = DropTargetLegacy<T>;

/** What a drop-state attribute can say. */
export type DropVisualState = 'candidate' | 'valid' | 'invalid';

/**
 * One transition of the drag. Exactly one `outcome` per drag, always last
 * (plan-341 §2.3 invariant 3).
 */
export type DropTransition<R> =
  | { phase: 'enter'; targetId: string; accessibleLabel: string; rect: DOMRect; reason: null }
  | { phase: 'enter'; targetId: string; accessibleLabel: string; rect: DOMRect; reason: R }
  | { phase: 'leave'; targetId: string }
  | { phase: 'outcome'; result: 'accepted'; targetId: string; accessibleLabel: string }
  | { phase: 'outcome'; result: 'rejected'; targetId: string; accessibleLabel: string; reason: R }
  | { phase: 'outcome'; result: 'none' };

/** Handle for imperative registration (non-React callers / tests). */
export interface DropHandle {
  /** Register one DOM element for this target. Returns its unregister function. */
  attach(el: HTMLElement): () => void;
  /** Unregister all elements of this target. */
  dispose(): void;
}

/** One isolated drag-domain registry (see module doc). */
export interface DropTargetRegistry<T, R = never> {
  /** Create a drop target that can span multiple DOM elements. */
  createDropTarget(target: DropTargetInput<T, R>): DropHandle;
  /** Mark the base state of EVERY entry for a starting drag (registry-wide). */
  beginCandidates(payload: T): void;
  /** Re-evaluate one entry's base state after its availability changed. */
  refreshEntry(handle: DropHandle): void;
  /** Update hover feedback during a drag (called by the drag store per pointermove). */
  updateHover(x: number, y: number, payload: T): void;
  /** Clear any hover feedback (keeps base states). */
  clearHover(): void;
  /** Attempt a drop at a viewport point. True when a target accepted it. */
  dropAt(x: number, y: number, payload: T): boolean;
  /** User-side end of the drag: emits `outcome:none` unless an outcome already went out. */
  endDrag(): void;
  /** Lifecycle teardown (plugin unload, model switch): clears silently, NO emission. */
  disposeDrag(): void;
  /** Subscribe to the transition stream. */
  subscribe(cb: (t: DropTransition<R>) => void): () => void;
  /** React hook: callback ref registering the element as a drop target. */
  useDropTarget(target: DropTargetInput<T, R>): (el: HTMLElement | null) => (() => void) | void;
}

/** Vertical padding (px) around an entry's united rect for the rect-based fallback hit-test. */
const RECT_HIT_PAD_Y_PX = 4;
/** Generous horizontal padding (px) — a slot ROW accepts drops across its whole band. */
const RECT_HIT_PAD_X_PX = 40;

/**
 * The rejection marker a LEGACY target produces. Never leaves this module and
 * is never handed to a subscriber, which is what keeps `R` sound without an
 * unchecked `as R` cast on the legacy path.
 */
const LEGACY_REJECT: unique symbol = Symbol('rv-drop-legacy-reject');
type LegacyReject = typeof LEGACY_REJECT;

/**
 * Diagnostics for the performance contract (plan-341 §2.8 e): `rejectCalls` may
 * grow at most once per hover TRANSITION, never per pointermove. Shared by all
 * registries; a single integer increment costs nothing in production.
 */
export interface RvDropDiagnostics { rejectCalls: number }
export const dropDiagnostics: RvDropDiagnostics = { rejectCalls: 0 };
(globalThis as unknown as { __rvDropDiag?: RvDropDiagnostics }).__rvDropDiag = dropDiagnostics;

interface DropEntry<T, R> {
  /** Normalized rule. Returns null (accept), `R` (V2) or LEGACY_REJECT (legacy). */
  reject: (payload: T) => R | LegacyReject | null;
  /**
   * Present ONLY for V2 targets. Its presence is exactly the invariant that
   * lets the emit path treat a non-null rejection as `R`: a legacy target has
   * no describe and therefore never reaches the emit path.
   */
  describe: (() => DropTargetDescription) | null;
  onDrop: (payload: T) => void;
  els: Set<HTMLElement>;
  /** Base state while a drag runs; hover overrides it temporarily. */
  base: 'candidate' | null;
}

function isLegacyTarget<T, R>(t: DropTargetInput<T, R>): t is DropTargetLegacy<T> {
  return typeof (t as DropTargetLegacy<T>).accepts === 'function';
}

/** DOMRect for an entry — never null, so emission never depends on layout. */
function toDomRect(left: number, top: number, right: number, bottom: number): DOMRect {
  const width = right - left;
  const height = bottom - top;
  if (typeof DOMRect === 'function') return new DOMRect(left, top, width, height);
  // Non-DOM harness fallback: a structurally complete, inert rect.
  return {
    x: left, y: top, left, top, right, bottom, width, height,
    toJSON() { return { x: left, y: top, width, height, top, left, right, bottom }; },
  } as DOMRect;
}

export function createDropTargetRegistry<T, R = never>(
  opts?: { isDragging?: () => boolean },
): DropTargetRegistry<T, R> {
  const entriesByEl = new Map<HTMLElement, DropEntry<T, R>>();
  const allEntries = new Set<DropEntry<T, R>>();
  const entryByHandle = new WeakMap<DropHandle, DropEntry<T, R>>();
  const listeners = new Set<(t: DropTransition<R>) => void>();
  let hoverEntry: DropEntry<T, R> | null = null;
  /** Payload of the running drag — the base-state source for late mounts. */
  let dragPayload: T | null = null;
  /** Internal drag flag; the injected getter wins when the domain supplies one. */
  let internalDragging = false;
  let outcomeEmitted = false;

  function isDragging(): boolean {
    return opts?.isDragging ? opts.isDragging() : internalDragging;
  }

  function emit(transition: DropTransition<R>): void {
    for (const listener of listeners) listener(transition);
  }

  function evaluate(entry: DropEntry<T, R>, payload: T): R | LegacyReject | null {
    dropDiagnostics.rejectCalls++;
    return entry.reject(payload);
  }

  function createDropTarget(target: DropTargetInput<T, R>): DropHandle {
    const legacy = isLegacyTarget(target);
    const entry: DropEntry<T, R> = {
      reject: legacy
        ? (p: T) => (target.accepts(p) ? null : LEGACY_REJECT)
        : (p: T) => target.reject(p),
      describe: legacy ? null : () => target.describe(),
      onDrop: (p: T) => target.onDrop(p),
      els: new Set(),
      base: null,
    };
    allEntries.add(entry);
    const handle: DropHandle = {
      attach(el: HTMLElement): () => void {
        entry.els.add(el);
        entriesByEl.set(el, entry);
        // Late mount during a live drag (plan-341 §2.3 invariant 4): the entry
        // must show the state the rest of the surface already shows.
        if (isDragging() && dragPayload !== null) {
          entry.base = evaluate(entry, dragPayload) === null ? 'candidate' : null;
          if (hoverEntry !== entry) setEntryState(entry, entry.base);
        }
        return () => {
          entry.els.delete(el);
          entriesByEl.delete(el);
          if (hoverEntry === entry && entry.els.size === 0) leaveHover();
        };
      },
      dispose(): void {
        // Invalidate the hover pointer FIRST so the leave transition still
        // carries this entry's identity (plan-341 §2.3 invariant 5).
        if (hoverEntry === entry) leaveHover();
        for (const el of entry.els) {
          el.removeAttribute('data-rv-drop-state');
          entriesByEl.delete(el);
        }
        entry.els.clear();
        entry.base = null;
        allEntries.delete(entry);
      },
    };
    entryByHandle.set(handle, entry);
    return handle;
  }

  /** United bounding rect of all (visible) elements of an entry. */
  function entryUnionRect(entry: DropEntry<T, R>): { left: number; top: number; right: number; bottom: number } | null {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const el of entry.els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // hidden / not laid out
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return left === Infinity ? null : { left, top, right, bottom };
  }

  function entryRect(entry: DropEntry<T, R>): DOMRect {
    const r = entryUnionRect(entry);
    return r ? toDomRect(r.left, r.top, r.right, r.bottom) : toDomRect(0, 0, 0, 0);
  }

  /**
   * Resolve the registered drop entry under a viewport point.
   * Primary: `elementFromPoint` + ancestor walk (exact, respects stacking).
   * Fallback: united-rect containment (row bands, portal-safe). When several
   * bands contain the point, the entry with the nearest center wins.
   */
  function entryAt(x: number, y: number): DropEntry<T, R> | null {
    let cur: Element | null = document.elementFromPoint(x, y);
    while (cur) {
      const entry = entriesByEl.get(cur as HTMLElement);
      if (entry) return entry;
      cur = cur.parentElement;
    }
    let best: DropEntry<T, R> | null = null;
    let bestDist = Infinity;
    for (const entry of allEntries) {
      const r = entryUnionRect(entry);
      if (!r) continue;
      if (x < r.left - RECT_HIT_PAD_X_PX || x > r.right + RECT_HIT_PAD_X_PX) continue;
      if (y < r.top - RECT_HIT_PAD_Y_PX || y > r.bottom + RECT_HIT_PAD_Y_PX) continue;
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const dist = Math.hypot(x - cx, y - cy);
      if (dist < bestDist) { best = entry; bestDist = dist; }
    }
    return best;
  }

  function setEntryState(entry: DropEntry<T, R>, state: DropVisualState | null): void {
    for (const el of entry.els) {
      if (state) el.setAttribute('data-rv-drop-state', state);
      else el.removeAttribute('data-rv-drop-state');
    }
  }

  /** Drop the current hover: restore its BASE state and announce the leave. */
  function leaveHover(): void {
    const entry = hoverEntry;
    if (!entry) return;
    hoverEntry = null;
    setEntryState(entry, entry.base);
    if (entry.describe) emit({ phase: 'leave', targetId: entry.describe().targetId });
  }

  function beginCandidates(payload: T): void {
    internalDragging = true;
    dragPayload = payload;
    outcomeEmitted = false;
    hoverEntry = null;
    for (const entry of allEntries) {
      entry.base = evaluate(entry, payload) === null ? 'candidate' : null;
      setEntryState(entry, entry.base);
    }
  }

  function refreshEntry(handle: DropHandle): void {
    const entry = entryByHandle.get(handle);
    if (!entry) return;
    if (!isDragging() || dragPayload === null) {
      // Idle: touch neither the rule nor the DOM (this runs after every render).
      if (entry.base !== null) {
        entry.base = null;
        setEntryState(entry, null);
      }
      return;
    }
    const reason = evaluate(entry, dragPayload);
    entry.base = reason === null ? 'candidate' : null;
    // The hovered entry keeps showing its hover state, refreshed in place; a
    // refresh is not a hover transition and therefore emits nothing.
    setEntryState(entry, hoverEntry === entry ? (reason === null ? 'valid' : 'invalid') : entry.base);
  }

  function updateHover(x: number, y: number, payload: T): void {
    dragPayload = payload;
    const entry = entryAt(x, y);
    if (entry === hoverEntry) return;
    leaveHover();
    if (!entry) return;
    hoverEntry = entry;
    const reason = evaluate(entry, payload);
    setEntryState(entry, reason === null ? 'valid' : 'invalid');
    if (!entry.describe) return;
    const { targetId, accessibleLabel } = entry.describe();
    const rect = entryRect(entry);
    if (reason === null) emit({ phase: 'enter', targetId, accessibleLabel, rect, reason: null });
    // Only V2 targets have a `describe`, and only legacy targets can produce
    // LEGACY_REJECT — so a rejection reaching this line is an `R` by construction.
    else emit({ phase: 'enter', targetId, accessibleLabel, rect, reason: reason as R });
  }

  function clearHover(): void {
    leaveHover();
  }

  function dropAt(x: number, y: number, payload: T): boolean {
    // Evaluate BEFORE the hover reset (plan-341 §2.3 invariant 2): the outcome
    // must carry the target's identity, which clearing the hover would erase.
    const entry = entryAt(x, y);
    const reason = entry ? evaluate(entry, payload) : null;
    const accepted = entry !== null && reason === null;
    if (entry?.describe) {
      const { targetId, accessibleLabel } = entry.describe();
      outcomeEmitted = true;
      if (accepted) emit({ phase: 'outcome', result: 'accepted', targetId, accessibleLabel });
      else emit({ phase: 'outcome', result: 'rejected', targetId, accessibleLabel, reason: reason as R });
    } else if (accepted) {
      // A legacy target consumed the drop: it announces nothing, but a later
      // `outcome:none` would be a lie, so the slot counts as used.
      outcomeEmitted = true;
    }
    clearHover();
    if (!accepted) return false;
    entry!.onDrop(payload);
    return true;
  }

  /** Clear every base/hover state without emitting anything. */
  function clearAllStates(): void {
    hoverEntry = null;
    for (const entry of allEntries) {
      entry.base = null;
      setEntryState(entry, null);
    }
    internalDragging = false;
    dragPayload = null;
  }

  function endDrag(): void {
    if (!outcomeEmitted) emit({ phase: 'outcome', result: 'none' });
    outcomeEmitted = true;
    clearAllStates();
  }

  function disposeDrag(): void {
    outcomeEmitted = true;
    clearAllStates();
  }

  function subscribe(cb: (t: DropTransition<R>) => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }

  function useDropTarget(target: DropTargetInput<T, R>): (el: HTMLElement | null) => (() => void) | void {
    /* eslint-disable react-hooks/rules-of-hooks -- stable method on a registry object */
    const latest = useRef(target);
    latest.current = target;
    const handle = useMemo(() => createDropTarget({
      // Read through the ref so inline closures stay fine, and normalize the
      // shape ONCE at creation — the ref may not switch forms mid-life.
      ...(isLegacyTarget(target)
        ? { accepts: (p: T) => (latest.current as DropTargetLegacy<T>).accepts(p) }
        : {
          reject: (p: T) => (latest.current as DropTargetV2<T, R>).reject(p),
          describe: () => (latest.current as DropTargetV2<T, R>).describe(),
        }),
      onDrop: (p: T) => latest.current.onDrop(p),
    } as DropTargetInput<T, R>), []);
    // Availability of a slot can change mid-drag (a parallel live update): the
    // `latest` ref is already fresh, but nothing re-evaluated the base state.
    useEffect(() => { refreshEntry(handle); });
    useEffect(() => () => handle.dispose(), [handle]);
    return useCallback((el: HTMLElement | null) => {
      if (!el) return;
      return handle.attach(el);
    }, [handle]);
    /* eslint-enable react-hooks/rules-of-hooks */
  }

  return {
    createDropTarget,
    beginCandidates,
    refreshEntry,
    updateHover,
    clearHover,
    dropAt,
    endDrag,
    disposeDrag,
    subscribe,
    useDropTarget,
  };
}

/**
 * Shared sx for GENERIC drop-target cells (node-link domain): green outline when
 * valid, red/dimmed when invalid — unchanged from plan-259.
 *
 * The SIGNAL domain deliberately does NOT reuse this any more: since plan-341
 * Phase 0 red means "PLC input is TRUE" and green "PLC output" on signal
 * surfaces, so a rejecting signal row may not be red. See `SIGNAL_DROP_SX`.
 */
export const DROP_TARGET_SX = {
  '&[data-rv-drop-state="valid"]': {
    outline: '1px solid #66bb6a',
    outlineOffset: '1px',
    borderRadius: 0.5,
    bgcolor: 'rgba(102,187,106,0.10)',
  },
  '&[data-rv-drop-state="invalid"]': {
    outline: '1px solid #ef5350',
    outlineOffset: '1px',
    borderRadius: 0.5,
    opacity: 0.55,
  },
} as const;
