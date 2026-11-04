// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-memoize-async.ts — a promise cache that forgets failures (plan-652).
 *
 * Generalises the one existing pattern of the code base
 * (`loadFileExportDialogs` in `hmi/scene/DocumentCard.tsx`): the promise of a
 * running or finished load is shared, so parallel callers start ONE load — but
 * a rejected promise is dropped again, so the next call loads anew instead of
 * replaying the failure for the rest of the session (the trap of `React.lazy`).
 */

/** A memoised async loader: call it to get the shared promise, `reset()` to forget it. */
export interface MemoizedAsync<T> {
  (): Promise<T>;
  /** Forget the cached promise (also a successful one). */
  reset(): void;
  /** True while a load is running or its result is cached. */
  readonly pending: boolean;
}

//! Wraps an async loader so parallel calls share one promise and a rejection is not cached.
export function memoizeAsync<T>(load: () => Promise<T>): MemoizedAsync<T> {
  let promise: Promise<T> | null = null;
  const call = (() => {
    if (!promise) {
      const p: Promise<T> = Promise.resolve()
        .then(load)
        .catch((error: unknown) => {
          // Only the promise that failed may clear the slot — a reset() plus a
          // new call in between owns it now.
          if (promise === p) promise = null;
          throw error;
        });
      promise = p;
    }
    return promise;
  }) as MemoizedAsync<T>;
  call.reset = () => { promise = null; };
  Object.defineProperty(call, 'pending', { get: () => promise !== null });
  return call;
}
