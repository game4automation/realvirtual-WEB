// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-yield.ts — cooperative main-thread yield for throughput loops (plan-262).
 *
 * `yieldToBrowser()` suspends a long-running drain loop (DES FastForward) for
 * one scheduling turn so input handling and rendering stay responsive:
 *   - Chromium / Firefox: `scheduler.yield()` — the continuation is resumed
 *     with PRIORITY (ahead of other queued tasks) instead of falling behind
 *     arbitrary work like a plain macrotask would.
 *   - Safari / others: MessageChannel macrotask fallback. Works everywhere;
 *     only the priority integration is lost (deliberate best-effort browser
 *     decision, plan-262 — no polyfill dependency).
 *
 * Deliberate divergence from the private `yieldMacrotask()` in
 * `rv-bvh-build-port.ts`: that helper is MessageChannel-only; this utility
 * adds the `scheduler.yield()` fast path. The BVH port can migrate to this
 * module when it is next touched.
 */

/** Structural view of the (not yet universally typed) Scheduler API. */
interface SchedulerLike {
  yield?(): Promise<void>;
}

/** Yield one scheduling turn — `scheduler.yield()` with MessageChannel fallback. */
export async function yieldToBrowser(): Promise<void> {
  const sched = (globalThis as { scheduler?: SchedulerLike }).scheduler;
  if (typeof sched?.yield === 'function') return sched.yield();
  if (typeof MessageChannel === 'undefined') {
    // Non-browser environment (SSR / bare node) — a microtask is the best we can do.
    return;
  }
  return new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}
