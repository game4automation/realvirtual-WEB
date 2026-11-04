// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

type Readiness = 'idle' | 'pending' | 'committed' | 'failed';
let state: Readiness = 'idle';
let failure: unknown;
const waiters = new Set<(error?: Error) => void>();

function settle(error?: Error): void {
  for (const waiter of Array.from(waiters)) waiter(error);
}

function loadError(): Error {
  const message = failure instanceof Error ? failure.message : String(failure);
  return new Error(`The CONNECT panel failed to load: ${message}`, { cause: failure });
}

export function markConnectPanelPending(): void {
  if (state !== 'committed') {
    state = 'pending';
    failure = undefined;
  }
}

export function markConnectPanelIdle(): void {
  if (state === 'pending' || state === 'failed') {
    state = 'idle';
    settle();
  }
}

export function markConnectPanelCommitted(): void {
  state = 'committed';
  failure = undefined;
  settle();
}

export function markConnectPanelFailed(err: unknown): void {
  // A late failure after the panel was closed again concerns the next open attempt, not a recording.
  if (state !== 'pending') return;
  state = 'failed';
  failure = err;
  settle(loadError());
}

export function whenConnectPanelCommitted(
  o: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  if (o.signal?.aborted) return Promise.reject(new Error('Recording aborted.'));
  if (state === 'idle' || state === 'committed') return Promise.resolve();
  if (state === 'failed') return Promise.reject(loadError());
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (error?: Error): void => {
      if (timer !== undefined) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      waiters.delete(done);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => done(new Error('Recording aborted.'));
    waiters.add(done);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = o.timeoutMs ?? 10_000;
    timer = setTimeout(() => done(new Error(
      `The CONNECT panel did not load within ${timeoutMs / 1000} s.`,
    )), timeoutMs);
  });
}

/** The host unmounted: a committed/pending mark of that mount must not confirm a later one. */
export function markConnectPanelUnmounted(): void {
  state = 'idle';
  failure = undefined;
  settle();
}

export function resetConnectPanelReadinessForTests(): void {
  state = 'idle';
  failure = undefined;
  settle();
}
