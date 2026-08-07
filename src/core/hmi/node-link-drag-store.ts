// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * node-link-drag-store.ts — global Shift+Drag state for creating typed
 * connections between nodes (plan-259 F10; state machine modelled on the
 * plan-246 signal drag store).
 *
 *   idle ──armNodeLinkDrag (pointerdown+shift on a node row/chip)──▶ armed
 *   armed ──move ≥ 4 px──▶ dragging ──pointerup over target──▶ drop → idle
 *   armed ──pointerup without movement──▶ idle   (plain Shift+Click)
 *   dragging ──pointerup without target──▶ cancel → idle
 *   dragging ──ESC──▶ cancel → idle
 *
 * Drop targets register through this module's OWN registry instance
 * (`createDropTargetRegistry<NodeLinkDragPayload>()`) — fully isolated from
 * the signal drag domain: a node-link drag can never drop onto a signal slot.
 * The accepting target creates the `addConnection` edit op.
 */

import { useSyncExternalStore } from 'react';
import {
  createDropTargetRegistry,
  type DropTarget,
  type DropHandle,
} from './drop-target-registry';
import { tooltipStore } from './tooltip/tooltip-store';

/** Suppression token this store holds in the tooltip store while dragging. */
const TOOLTIP_SUPPRESS_TOKEN = 'node-link-drag';

/** Everything a drop target needs to create the connection edge. */
export interface NodeLinkDragPayload {
  /** Node path of the SOURCE end of the connection-to-be. */
  sourcePath: string;
  /** Connection type of the edge to create (e.g. 'StopOnExit'). */
  linkType: string;
}

export type NodeLinkDragPhase = 'idle' | 'armed' | 'dragging';

/** Result of the last completed drag ('dropped' only when a target accepted). */
export type NodeLinkDragResult = 'dropped' | 'cancelled' | 'click';

/** Movement threshold (px) between armed and dragging. */
export const NODE_LINK_DRAG_THRESHOLD_PX = 4;

/** How long after a drag/armed release the source's click stays suppressed (ms). */
const CLICK_SUPPRESS_WINDOW_MS = 400;

const BODY_DRAG_CLASS = 'rv-node-link-dragging';

// ── Drop-target domain (isolated registry instance) ───────────────────

const registry = createDropTargetRegistry<NodeLinkDragPayload>();

export type NodeLinkDropTarget = DropTarget<NodeLinkDragPayload>;
export type NodeLinkDropHandle = DropHandle;

/** Register a node-link drop target (imperative form; multi-element capable). */
export function createNodeLinkDropTarget(target: NodeLinkDropTarget): NodeLinkDropHandle {
  return registry.createDropTarget(target);
}

/** React hook: callback ref registering an element as a node-link drop target. */
export function useNodeLinkDropTarget(target: NodeLinkDropTarget): (el: HTMLElement | null) => (() => void) | void {
  return registry.useDropTarget(target);
}

// ── 3D drop fallback ───────────────────────────────────────────────────

/**
 * Fallback drop resolver consulted when no DOM target accepted the drop —
 * the ConnectionSystemPlugin registers a raycast-into-the-3D-scene resolver
 * here (scene-drag-open pattern). Returns true when it consumed the drop.
 */
let dropFallback: ((x: number, y: number, payload: NodeLinkDragPayload) => boolean) | null = null;

export function setNodeLinkDropFallback(
  fn: ((x: number, y: number, payload: NodeLinkDragPayload) => boolean) | null,
): void {
  dropFallback = fn;
}

// ── State machine ──────────────────────────────────────────────────────

let phase: NodeLinkDragPhase = 'idle';
let payload: NodeLinkDragPayload | null = null;
let startX = 0;
let startY = 0;
let curX = 0;
let curY = 0;
let suppressClickUntil = 0;
let lastResult: NodeLinkDragResult | null = null;
let prevBodyCursor = '';

const listeners = new Set<() => void>();
const posListeners = new Set<(x: number, y: number) => void>();

function notify(): void {
  for (const l of listeners) l();
}

function onWindowPointerMove(e: PointerEvent): void {
  updateNodeLinkDrag(e.clientX, e.clientY);
}

function onWindowPointerUp(e: PointerEvent): void {
  endNodeLinkDrag(e.clientX, e.clientY);
}

function onWindowKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopPropagation();
    cancelNodeLinkDrag();
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

/** Arm a potential drag (pointerdown with Shift on a node source). */
export function armNodeLinkDrag(p: NodeLinkDragPayload, x: number, y: number): void {
  if (phase !== 'idle') cancelNodeLinkDrag();
  phase = 'armed';
  payload = p;
  startX = x; startY = y;
  curX = x; curY = y;
  attachWindowListeners();
  notify();
}

/** Pointer moved. Promotes armed→dragging past the threshold; feeds drop hover. */
export function updateNodeLinkDrag(x: number, y: number): void {
  if (phase === 'idle') return;
  curX = x; curY = y;
  if (phase === 'armed') {
    const dx = x - startX;
    const dy = y - startY;
    if (Math.hypot(dx, dy) < NODE_LINK_DRAG_THRESHOLD_PX) return;
    phase = 'dragging';
    document.body.classList.add(BODY_DRAG_CLASS);
    prevBodyCursor = document.body.style.cursor;
    document.body.style.cursor = 'grabbing';
    tooltipStore.suppressHover(TOOLTIP_SUPPRESS_TOKEN);
    notify();
  }
  for (const l of posListeners) l(x, y);
  if (payload) registry.updateHover(x, y, payload);
}

/**
 * Pointer released. From `dragging` this attempts a drop at (x, y); from
 * `armed` it is a plain Shift+Click (suppressed). Returns what happened.
 */
export function endNodeLinkDrag(x: number, y: number): NodeLinkDragResult | 'noop' {
  if (phase === 'idle') return 'noop';
  const wasDragging = phase === 'dragging';
  const p = payload;
  suppressClickUntil = performance.now() + CLICK_SUPPRESS_WINDOW_MS;
  let result: NodeLinkDragResult;
  if (wasDragging && p) {
    result = registry.dropAt(x, y, p) || (dropFallback?.(x, y, p) ?? false)
      ? 'dropped' : 'cancelled';
  } else {
    result = 'click';
  }
  lastResult = result;
  reset();
  return result;
}

/** Abort the interaction (ESC, teardown). Never drops; suppresses the trailing click. */
export function cancelNodeLinkDrag(): void {
  if (phase === 'idle') return;
  suppressClickUntil = performance.now() + CLICK_SUPPRESS_WINDOW_MS;
  lastResult = 'cancelled';
  reset();
}

function reset(): void {
  phase = 'idle';
  payload = null;
  detachWindowListeners();
  document.body.classList.remove(BODY_DRAG_CLASS);
  document.body.style.cursor = prevBodyCursor;
  tooltipStore.releaseHover(TOOLTIP_SUPPRESS_TOKEN);
  registry.clearHover();
  notify();
}

// ── Reads / subscriptions ─────────────────────────────────────────────

export function getNodeLinkDragPhase(): NodeLinkDragPhase {
  return phase;
}

export function getNodeLinkDragPayload(): NodeLinkDragPayload | null {
  return payload;
}

export function getNodeLinkDragPosition(): { x: number; y: number } {
  return { x: curX, y: curY };
}

/** Result of the most recently completed drag interaction (null before the first). */
export function getLastNodeLinkDragResult(): NodeLinkDragResult | null {
  return lastResult;
}

/** True when the click about to be handled came from a Shift+press / drag —
 *  the caller must ignore it. One-shot. */
export function consumeNodeLinkDragClick(): boolean {
  const suppress = performance.now() < suppressClickUntil;
  suppressClickUntil = 0;
  return suppress;
}

/** Subscribe to phase changes (armed/dragging/idle). */
export function subscribeNodeLinkDrag(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Subscribe to high-frequency pointer positions while dragging (DOM ghost). */
export function subscribeNodeLinkDragPos(cb: (x: number, y: number) => void): () => void {
  posListeners.add(cb);
  return () => { posListeners.delete(cb); };
}

/** React hook — true while a node-link drag is in progress. */
export function useNodeLinkDragActive(): boolean {
  return useSyncExternalStore(
    (cb) => subscribeNodeLinkDrag(cb),
    () => phase === 'dragging',
  );
}
