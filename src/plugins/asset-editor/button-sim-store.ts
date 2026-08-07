// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * button-sim-store — humanized "the AI clicks this button" choreography.
 *
 * When an MCP editor tool performs an action that has an equivalent button in
 * the Quick Edit (Kinematics) or Materials panel, the bridge simulates a real
 * click on that button: scroll it into view, hover (~0.5s), press (~0.5s),
 * release — and the tool executes its action AT the release, so watching the
 * viewer reads exactly like another person driving the UI. No pulsing badge,
 * no artificial cursor; the button's own hover/pressed visuals do the acting.
 *
 * The store only publishes the current phase per button id; the buttons render
 * the matching hover/pressed styles themselves (CSS `:hover` cannot be set
 * synthetically). The DOM element is located via `data-rv-button-id` — purely
 * for scrollIntoView; no DOM events are dispatched, so the button's onClick
 * never double-fires.
 *
 * Module singleton following the button-flash-store pattern it replaces:
 * useSyncExternalStore-compatible subscribe/getSnapshot + a plain async
 * orchestrator callable from non-React code (the MCP feedback layer).
 */

import { useSyncExternalStore } from 'react';

export type ButtonSimPhase = 'hover' | 'pressed';

export interface ButtonSimSnapshot {
  /** Stable button id, e.g. 'qe.to-ground' or 'mat.assign'. */
  id: string;
  phase: ButtonSimPhase;
}

/** Hover dwell before the press — "the user found the button". */
export const SIM_HOVER_MS = 500;
/** Pressed dwell before the release — "a deliberate click". */
export const SIM_PRESS_MS = 500;

let snapshot: ButtonSimSnapshot | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function setPhase(id: string, phase: ButtonSimPhase | null): void {
  snapshot = phase ? { id, phase } : null;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Current simulation state (null while idle) — non-React consumers and tests. */
export function getButtonSimSnapshot(): ButtonSimSnapshot | null {
  return snapshot;
}

/**
 * React hook for panel buttons: returns this button's current simulated
 * phase, or null. Safe to call with '' (never matches), so components can
 * pass `simId ?? ''` unconditionally.
 */
export function useButtonSim(id: string): ButtonSimPhase | null {
  const snap = useSyncExternalStore(subscribe, getButtonSimSnapshot);
  return snap && id && snap.id === id ? snap.phase : null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Test hook: shrink the dwell times. */
let hoverMs = SIM_HOVER_MS;
let pressMs = SIM_PRESS_MS;
export function _setSimTimingsForTest(hover: number, press: number): void {
  hoverMs = hover;
  pressMs = press;
}

/**
 * Simulate a human click on the button with the given id: scroll it into
 * view, hover, press, release. Resolves at the release — callers execute
 * the actual action right after, so cause and effect line up on screen.
 * Resolves immediately (no dwell) when the button is not in the DOM
 * (panel closed, action without a visible button). Never throws.
 */
export async function simulateButtonClick(id: string): Promise<boolean> {
  try {
    const el = document.querySelector<HTMLElement>(`[data-rv-button-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    setPhase(id, 'hover');
    await sleep(hoverMs);
    setPhase(id, 'pressed');
    await sleep(pressMs);
    setPhase(id, null);
    return true;
  } catch {
    setPhase(id, null);
    return false;
  }
}
