// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * button-sim-state — the OPEN, pure state of "the AI is operating this button"
 * (plan-499). It is also the AI-touch (afterglow) store the plan calls
 * `ai-touch-store`: one module, because the phase a button renders is ONE value
 * (hover/pressed win over afterglow) and two stores would have to agree on it.
 *
 * Per button key one visual phase: `hover` / `pressed` (written by the private
 * click choreography, button-sim-store.ts) or `afterglow` (written after an
 * MCP-originated command execution, ~3 s). No DOM, no timers per button — one
 * sweep timer drops expired afterglows. Hover/press win over afterglow while
 * both are present.
 *
 * Lives in the open core so `useCommandView` works in the community build,
 * where the private choreography is a no-op stub.
 */

import { useSyncExternalStore } from 'react';

export type ButtonSimPhase = 'hover' | 'pressed' | 'afterglow';

export interface AiTouch {
  readonly commandId: string;
  readonly buttonKey: string;
  readonly at: number;
  readonly seq: number;
}

export const AI_TOUCH_MS = 3000;

let touchMs = AI_TOUCH_MS;
let seq = 0;
let clock: () => number = () => Date.now();
const simPhases = new Map<string, 'hover' | 'pressed'>();
let touches: AiTouch[] = [];
let sweepTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function armSweep(): void {
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  if (touches.length === 0) return;
  const next = Math.min(...touches.map((t) => t.at + touchMs));
  sweepTimer = setTimeout(sweep, Math.max(0, next - clock()));
}

function sweep(): void {
  sweepTimer = null;
  const t = clock();
  const before = touches.length;
  touches = touches.filter((x) => x.at + touchMs > t);
  for (const key of [...touchViews.keys()]) {
    if (!touches.some((x) => x.buttonKey === key)) touchViews.delete(key);
  }
  if (touches.length !== before) notify();
  armSweep();
}

/** Written by the private choreography (hover → pressed → null). */
export function setSimPhase(buttonKey: string, phase: 'hover' | 'pressed' | null): void {
  if (phase) simPhases.set(buttonKey, phase);
  else simPhases.delete(buttonKey);
  notify();
}

/** Start (or restart) the afterglow on a button. A repeat touch restarts it. */
export function touchAfterglow(buttonKey: string, commandId: string): void {
  touches = touches.filter((t) => t.buttonKey !== buttonKey);
  touches.push({ commandId, buttonKey, at: clock(), seq: ++seq });
  notify();
  armSweep();
}

/** Current phase of a button (null while idle). */
export function getButtonSimPhase(buttonKey: string): ButtonSimPhase | null {
  if (!buttonKey) return null;
  const p = simPhases.get(buttonKey);
  if (p) return p;
  return touches.some((t) => t.buttonKey === buttonKey) ? 'afterglow' : null;
}

/** The afterglow of one button: `seq` changes on every (re)trigger, `progress` is 0 → 1 over {@link AI_TOUCH_MS}. */
export interface AiTouchView {
  readonly active: boolean;
  readonly seq: number;
  readonly progress: number;
}

const NO_TOUCH: AiTouchView = Object.freeze({ active: false, seq: 0, progress: 1 });
const touchViews = new Map<string, AiTouchView>();

/** The afterglow state of a button at this instant (null key → inactive). */
export function getAiTouch(buttonKey: string): AiTouchView {
  if (!buttonKey) return NO_TOUCH;
  const t = touches.find((x) => x.buttonKey === buttonKey);
  if (!t) return NO_TOUCH;
  // Cached per (key, seq) so useSyncExternalStore sees a stable snapshot; the
  // fade itself runs in CSS, progress is only the value at (re)render time.
  const cached = touchViews.get(buttonKey);
  if (cached && cached.seq === t.seq) return cached;
  const view: AiTouchView = { active: true, seq: t.seq, progress: Math.min(1, Math.max(0, (clock() - t.at) / touchMs)) };
  touchViews.set(buttonKey, view);
  return view;
}

/** React hook: the button's afterglow (active / seq for restarting the CSS fade). */
export function useAiTouch(buttonKey: string): AiTouchView {
  return useSyncExternalStore(subscribe, () => getAiTouch(buttonKey));
}

/** Current afterglow duration in ms (tests shorten it). */
export function getAiTouchMs(): number {
  return touchMs;
}

/** Active afterglows (tests, diagnostics). */
export function getAiTouches(): readonly AiTouch[] {
  return touches;
}

/** React hook: the button's phase. Safe with '' (never matches). */
export function useButtonSimState(buttonKey: string): ButtonSimPhase | null {
  return useSyncExternalStore(subscribe, () => getButtonSimPhase(buttonKey));
}

/** Test hook: afterglow duration. */
export function _setAiTouchMsForTest(ms: number, testClock?: () => number): void {
  touchMs = ms;
  if (testClock) clock = testClock;
}

/** Test hook: drop all state. */
export function _resetButtonSimStateForTest(): void {
  simPhases.clear();
  touches = [];
  touchViews.clear();
  if (sweepTimer !== null) clearTimeout(sweepTimer);
  sweepTimer = null;
  touchMs = AI_TOUCH_MS;
  clock = () => Date.now();
  notify();
}
