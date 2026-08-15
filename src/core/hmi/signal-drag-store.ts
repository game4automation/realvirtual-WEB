// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-drag-store.ts — global drag state for signal chips (plan-246 F4/F8/F11,
 * plan-422 F6).
 *
 * A tiny module-level state machine (no React state on the hot path):
 *
 *   idle ──armSignalDrag (pointerdown on a chip)──▶ armed
 *   armed ──move ≥ 4 px──▶ dragging ──pointerup over target──▶ drop → idle
 *   armed ──pointerup without movement──▶ idle   (click, or nothing — see below)
 *   dragging ──pointerup without target──▶ cancel → idle
 *   dragging ──ESC──▶ cancel → idle
 *
 * ## Shift is no longer the gate (plan-422 F6)
 *
 * Requiring Shift made the drag undiscoverable — the one gesture nobody tries
 * first. It is not needed: the machine ALREADY separates a press from a drag by
 * movement, so a plain pointerdown can arm too, and the release decides. Under
 * the threshold it is a click; past it, a drag.
 *
 * The only thing that had to change is what happens to that trailing click.
 * Shift+Click meant nothing and was swallowed; a plain click is the force
 * gesture and must survive. That is {@link ArmSignalDragOptions.clickOnRelease},
 * and the Shift path keeps the old behaviour untouched.
 *
 * On touch there is no Shift and no hover, and a press that becomes a drag
 * competes with scrolling — so the chip arms on LONG PRESS and a move before it
 * fires stays a scroll. A tap never arms at all and reaches the chip as a
 * normal click.
 *
 * While `dragging`:
 *  - `document.body` gets the `rv-signal-dragging` class + a grabbing cursor,
 *  - tooltips are globally suppressed: hover bubbles of the central tooltip
 *    system via `tooltipStore.suppressHover` (pinned ones stay — they can BE
 *    the drop target), badge tooltips read {@link useSignalDragActive},
 *  - high-frequency position updates go to {@link subscribeSignalDragPos}
 *    subscribers only (the ghost overlay updates a DOM transform directly —
 *    no React re-render per pointermove),
 *  - drop-target hover feedback is driven via signal-drop-target.ts.
 *
 * Click suppression: any pointerup that ends an armed/dragging interaction
 * opens a short suppression window; the chip's click handler consumes it via
 * {@link consumeSignalDragClick} so a Shift+Click never forces and a completed
 * drag never triggers the force-click of the source chip.
 */

import { useSyncExternalStore } from 'react';
import type { SignalDirection } from './rv-signal-badge';
import {
  updateSignalDropHover,
  clearSignalDropHover,
  dropSignalAt,
  markSignalDropCandidates,
  clearSignalDropCandidates,
  disposeSignalDropDrag,
  setSignalDragActiveGetter,
} from './signal-drop-target';
import { tooltipStore } from './tooltip/tooltip-store';

/** Suppression token this store holds in the tooltip store while dragging. */
const TOOLTIP_SUPPRESS_TOKEN = 'signal-drag';

/** Everything a drop target needs to validate + apply a signal link without a store roundtrip (F11). */
export interface SignalDragPayload {
  name: string;
  /** Stable source provider identity carried end-to-end through drag/drop. */
  interfaceId?: string;
  /** MQTT topic portion of the provider key, when applicable. */
  topic?: string;
  direction: SignalDirection;
  plcType?: string;
  address?: string;
  comment?: string;
  source?: string;
  /**
   * Where the signal comes from — REQUIRED (plan-341 §2.8 a). Internal model
   * signals deliberately have no `interfaceId`; without `origin` they could not
   * be told apart from a CONNECT signal that lost its provider, and every
   * internal drag was silently misfiled as "no provider".
   */
  origin: 'connect' | 'internal';
}

export type SignalDragPhase = 'idle' | 'armed' | 'dragging';

/** Result of the last completed drag ('dropped' only when a target accepted the payload). */
export type SignalDragResult = 'dropped' | 'cancelled' | 'click';

/** Movement threshold (px) between armed and dragging — a Shift+Click stays below it. */
export const SIGNAL_DRAG_THRESHOLD_PX = 4;

/** How long after a drag/armed release the source chip's click stays suppressed (ms). */
const CLICK_SUPPRESS_WINDOW_MS = 400;

const BODY_DRAG_CLASS = 'rv-signal-dragging';

let phase: SignalDragPhase = 'idle';
let payload: SignalDragPayload | null = null;
let startX = 0;
let startY = 0;
let curX = 0;
let curY = 0;
let suppressClickUntil = 0;
let lastResult: SignalDragResult | null = null;
let prevBodyCursor = '';
/** Set by {@link armSignalDrag}; see {@link ArmSignalDragOptions.clickOnRelease}. */
let clickOnRelease = false;

const listeners = new Set<() => void>();
const posListeners = new Set<(x: number, y: number) => void>();

function notify(): void {
  for (const l of listeners) l();
}

// ── Window listeners (attached while armed/dragging) ──────────────────

function onWindowPointerMove(e: PointerEvent): void {
  updateSignalDrag(e.clientX, e.clientY);
}

function onWindowPointerUp(e: PointerEvent): void {
  endSignalDrag(e.clientX, e.clientY);
}

function onWindowKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    cancelSignalDrag();
  }
}

function attachWindowListeners(): void {
  // Capture phase so MUI popovers/overlays that stopPropagation can't swallow the drag.
  window.addEventListener('pointermove', onWindowPointerMove, true);
  window.addEventListener('pointerup', onWindowPointerUp, true);
  window.addEventListener('keydown', onWindowKeyDown, true);
}

function detachWindowListeners(): void {
  window.removeEventListener('pointermove', onWindowPointerMove, true);
  window.removeEventListener('pointerup', onWindowPointerUp, true);
  window.removeEventListener('keydown', onWindowKeyDown, true);
}

// ── State machine ─────────────────────────────────────────────────────

export interface ArmSignalDragOptions {
  /**
   * What a release BELOW the movement threshold means (plan-422 F6).
   *
   * The Shift gesture answers "nothing": Shift+Click was never a force, so the
   * trailing click is swallowed. Dropping the Shift requirement makes the same
   * pointerdown the beginning of BOTH gestures, and then the release is the
   * only thing that tells them apart — under the threshold it is the plain
   * click the user has always used to force, and it must reach the chip
   * untouched.
   *
   * `true` therefore leaves the click alone. Default `false` keeps the Shift
   * behaviour byte for byte, which is what the regression suite pins.
   */
  clickOnRelease?: boolean;
}

/** Arm a potential drag (pointerdown on a signal chip). */
export function armSignalDrag(
  p: SignalDragPayload,
  x: number,
  y: number,
  options: ArmSignalDragOptions = {},
): void {
  if (phase !== 'idle') cancelSignalDrag();
  phase = 'armed';
  payload = p;
  startX = x; startY = y;
  curX = x; curY = y;
  clickOnRelease = options.clickOnRelease === true;
  attachWindowListeners();
  notify();
}

/** Pointer moved. Promotes armed→dragging past the threshold; feeds ghost + drop hover. */
export function updateSignalDrag(x: number, y: number): void {
  if (phase === 'idle') return;
  curX = x; curY = y;
  if (phase === 'armed') {
    const dx = x - startX;
    const dy = y - startY;
    if (Math.hypot(dx, dy) < SIGNAL_DRAG_THRESHOLD_PX) return;
    phase = 'dragging';
    document.body.classList.add(BODY_DRAG_CLASS);
    prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'grabbing';
    tooltipStore.suppressHover(TOOLTIP_SUPPRESS_TOKEN);
    // Candidate pass — ONCE, at the promotion, registry-wide (plan-341 F3).
    // This store already owns the promotion and the central reset, so no extra
    // controller is involved (Review-Finding 11).
    if (payload) markSignalDropCandidates(payload);
    notify();
  }
  for (const l of posListeners) l(x, y);
  if (payload) updateSignalDropHover(x, y, payload);
}

/**
 * Pointer released. From `dragging` this attempts a drop at (x, y) via the
 * drop-target registry; from `armed` it is a press that never became a drag.
 *
 * What that press MEANT depends on how it was armed (plan-422 F6): a Shift
 * press means nothing and its click is swallowed; a plain press is the force
 * click, and `clickOnRelease` lets it through. A completed DRAG always
 * suppresses — the release landed on a drop target, not on the source chip.
 */
export function endSignalDrag(x: number, y: number): SignalDragResult | 'noop' {
  if (phase === 'idle') return 'noop';
  const wasDragging = phase === 'dragging';
  const p = payload;
  if (wasDragging || !clickOnRelease) {
    suppressClickUntil = performance.now() + CLICK_SUPPRESS_WINDOW_MS;
  }
  let result: SignalDragResult;
  if (wasDragging && p) {
    result = dropSignalAt(x, y, p) ? 'dropped' : 'cancelled';
  } else {
    result = 'click';
  }
  lastResult = result;
  reset();
  return result;
}

/** Abort the interaction (ESC). Never drops; suppresses the trailing click.
 *  For a LIFECYCLE abort use {@link disposeSignalDrag} — it announces nothing. */
export function cancelSignalDrag(): void {
  if (phase === 'idle') return;
  suppressClickUntil = performance.now() + CLICK_SUPPRESS_WINDOW_MS;
  lastResult = 'cancelled';
  reset();
}

/**
 * Abort the interaction WITHOUT announcing an outcome — the lifecycle path
 * (plugin teardown, model switch). Distinct from {@link cancelSignalDrag},
 * which is the user's ESC and therefore part of the transition sequence
 * (plan-341 §2.3, "two operations instead of one").
 */
export function disposeSignalDrag(): void {
  if (phase === 'idle') return;
  lastResult = 'cancelled';
  reset(true);
}

function reset(silent = false): void {
  phase = 'idle';
  payload = null;
  clickOnRelease = false;
  detachWindowListeners();
  document.body.classList.remove(BODY_DRAG_CLASS);
  document.body.style.cursor = prevBodyCursor;
  tooltipStore.releaseHover(TOOLTIP_SUPPRESS_TOKEN);
  clearSignalDropHover();
  // Central end of the drag: candidate states go, and the ONE `outcome` is
  // emitted here when the drop did not already produce one (ESC, empty drop).
  if (silent) disposeSignalDropDrag();
  else clearSignalDropCandidates();
  notify();
}

// The drop registry needs "is a drag running?" for late mounts, but importing
// this store from there would close an import cycle — so the getter is pushed.
setSignalDragActiveGetter(() => phase === 'dragging');

// ── Reads / subscriptions ─────────────────────────────────────────────

export function getSignalDragPhase(): SignalDragPhase {
  return phase;
}

export function getSignalDragPayload(): SignalDragPayload | null {
  return payload;
}

export function getSignalDragPosition(): { x: number; y: number } {
  return { x: curX, y: curY };
}

/** Result of the most recently completed drag interaction (null before the first). */
export function getLastSignalDragResult(): SignalDragResult | null {
  return lastResult;
}

/**
 * True when the click that is about to be handled originated from a
 * Shift+press / drag interaction — the caller must ignore it. One-shot.
 */
export function consumeSignalDragClick(): boolean {
  const suppress = performance.now() < suppressClickUntil;
  suppressClickUntil = 0;
  return suppress;
}

/** Subscribe to phase changes (armed/dragging/idle). */
export function subscribeSignalDrag(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Subscribe to high-frequency pointer positions while dragging. Subscribers
 * must not allocate or set React state — the ghost writes a DOM transform.
 */
export function subscribeSignalDragPos(cb: (x: number, y: number) => void): () => void {
  posListeners.add(cb);
  return () => { posListeners.delete(cb); };
}

/** React hook — true while a signal drag is in progress (tooltip suppression, F5). */
export function useSignalDragActive(): boolean {
  return useSyncExternalStore(
    (cb) => subscribeSignalDrag(cb),
    () => phase === 'dragging',
  );
}
