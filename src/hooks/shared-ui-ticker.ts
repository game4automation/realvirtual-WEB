// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

const TICK_MS = 200;

const dirtyFlushes = new Set<() => void>();
const tickSubscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function stopTimerIfIdle(): void {
  if (timer === null || dirtyFlushes.size > 0 || tickSubscribers.size > 0) return;
  clearInterval(timer);
  timer = null;
}

function ensureTimer(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    if (dirtyFlushes.size > 0) {
      const batch = Array.from(dirtyFlushes);
      dirtyFlushes.clear();
      for (const flush of batch) flush();
    }

    if (tickSubscribers.size > 0) {
      const subscribers = Array.from(tickSubscribers);
      for (const subscriber of subscribers) subscriber();
    }

    stopTimerIfIdle();
  }, TICK_MS);
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
