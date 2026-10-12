// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * shared-ui-ticker — the wall-clock pumps of the HMI read-outs.
 *
 *  - push flushes (`markDirty`) and pull subscribers (`subscribeTick`) share ONE 200 ms timer;
 *  - per-hook polls (`subscribePoll`, used by `useSignalTick` / `useChangeGatedTick`) get their own
 *    interval at the requested period.
 *
 * Recording (plan-556 F4): a frame-by-frame video must show the HMI of exactly the frame's sim
 * state, so wall-clock timers cannot drive the read-outs. `setRecordingTicks(true)` REPLACES every
 * timer — the shared timer and every poll interval are torn down — and `flushNow()` runs all of
 * them synchronously once per video frame. `setRecordingTicks(false)` restarts the timers.
 */

const TICK_MS = 200;

const dirtyFlushes = new Set<() => void>();
const tickSubscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

interface Poll { fn: () => void; intervalMs: number; id: ReturnType<typeof setInterval> | null }
const polls = new Set<Poll>();
let recording = false;

function runShared(): void {
  if (dirtyFlushes.size > 0) {
    const batch = Array.from(dirtyFlushes);
    dirtyFlushes.clear();
    for (const flush of batch) flush();
  }
  if (tickSubscribers.size > 0) {
    const subscribers = Array.from(tickSubscribers);
    for (const subscriber of subscribers) subscriber();
  }
}

function stopTimerIfIdle(): void {
  if (timer === null || dirtyFlushes.size > 0 || tickSubscribers.size > 0) return;
  clearInterval(timer);
  timer = null;
}

function ensureTimer(): void {
  if (timer !== null || recording) return;
  timer = setInterval(() => {
    runShared();
    stopTimerIfIdle();
  }, TICK_MS);
}

function startPoll(p: Poll): void {
  if (p.id === null && !recording) p.id = setInterval(p.fn, p.intervalMs);
}

function stopPoll(p: Poll): void {
  if (p.id !== null) clearInterval(p.id);
  p.id = null;
}

/** Queue a one-shot push flush for the next shared UI tick. */
export function markDirty(flush: () => void): void {
  dirtyFlushes.add(flush);
  ensureTimer();
}

/** Remove a queued push flush when its consumer unmounts. */
export function clearDirty(flush: () => void): void {
  dirtyFlushes.delete(flush);
  stopTimerIfIdle();
}

/** Subscribe a persistent pull consumer to every shared UI tick. */
export function subscribeTick(callback: () => void): () => void {
  tickSubscribers.add(callback);
  ensureTimer();
  return () => {
    tickSubscribers.delete(callback);
    stopTimerIfIdle();
  };
}

/**
 * Subscribe a poll with its own period (ms). Runs on a wall-clock interval normally and once per
 * {@link flushNow} while recording. Returns the unsubscribe.
 */
export function subscribePoll(fn: () => void, intervalMs: number): () => void {
  const p: Poll = { fn, intervalMs, id: null };
  polls.add(p);
  startPoll(p);
  return () => {
    stopPoll(p);
    polls.delete(p);
  };
}

/**
 * Recording ticks (plan-556 F4): `true` tears down the shared timer and every poll interval —
 * from now on only {@link flushNow} drives the read-outs; `false` restarts the wall-clock timers.
 */
export function setRecordingTicks(on: boolean): void {
  if (recording === on) return;
  recording = on;
  if (on) {
    if (timer !== null) { clearInterval(timer); timer = null; }
    for (const p of polls) stopPoll(p);
  } else {
    if (dirtyFlushes.size > 0 || tickSubscribers.size > 0) ensureTimer();
    for (const p of polls) startPoll(p);
  }
}

/** True while recording ticks replace the wall-clock timers. */
export function isRecordingTicks(): boolean {
  return recording;
}

/** Number of wall-clock timers running right now (shared timer + poll intervals) — test seam. */
export function activeTimerCount(): number {
  let n = timer !== null ? 1 : 0;
  for (const p of polls) if (p.id !== null) n++;
  return n;
}

/**
 * Runs every queued push flush, every tick subscriber and every poll NOW, in this task. Returns
 * how many callbacks ran. The recording settle calls it once per video frame, before the React
 * commit barrier (otherwise ticker-driven read-outs lag one frame — plan-556 spike).
 */
export function flushNow(): number {
  let n = dirtyFlushes.size + tickSubscribers.size;
  runShared();
  for (const p of Array.from(polls)) { p.fn(); n++; }
  return n;
}
