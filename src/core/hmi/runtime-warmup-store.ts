// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * runtime-warmup-store — "a runtime the scene needs is still warming up"
 * (plan-673).
 *
 * The gap this closes is NOT the model load. It is what happens after it: a
 * lazy feature whose code is in but whose RUNTIME is not. On the MuJoCo walker
 * that is 8.2 MB of WASM over the wire (`mujoco.wasm` plus the ONNX runtime)
 * and a measured 8-17 s on a quiet machine, during which the model stands
 * complete on screen and absolutely nothing happens. With the autopilot off
 * (plan-673 O19) that is indistinguishable from a broken page: a robot that
 * stands still and a panel nobody can press.
 *
 * ## Why this is a store and not a `reportModelLoadStart()` call
 *
 * `model-load-progress-store` states its own contract in its header: the splash
 * in `main.ts` owns the DOM overlay and is the ONLY writer, because one writer
 * is what keeps the two presentations of a load from disagreeing. A plugin that
 * opened the loading channel itself would break that, and silently.
 *
 * So the division of labour is: whoever owns a runtime REPORTS here — a fact,
 * not a presentation — and `main.ts` alone decides what the user sees (today
 * the ordinary scene-transition overlay, on its own 200 ms delay, which is what
 * keeps a warm cache from flashing). Nothing here touches the DOM, and no
 * second loading indicator can appear.
 *
 * ## Contract
 *
 *  - `begin(id, label)` is idempotent per id; a second call only updates the
 *    label. `end(id)` of an unknown id is a no-op, so a failure path may call
 *    it defensively.
 *  - Several warmups may overlap (a feature's chunk and the runtime behind it);
 *    the snapshot is active until the LAST one ends, and shows the label of the
 *    most recently begun.
 *  - An owner that never calls `end` leaves the overlay up. Every owner
 *    therefore ends it on success AND on failure — there is deliberately no
 *    timeout here, because a timeout would hide a hang rather than report it.
 */

export interface RuntimeWarmupSnapshot {
  /** At least one runtime is warming up. */
  active: boolean;
  /** Label of the most recently begun warmup, for the overlay text. */
  label: string;
}

const IDLE: RuntimeWarmupSnapshot = { active: false, label: '' };

/** Insertion-ordered: the last entry is the most recently begun. */
const _warmups = new Map<string, string>();
let _snapshot: RuntimeWarmupSnapshot = IDLE;
const _listeners = new Set<() => void>();

function publish(): void {
  const labels = [..._warmups.values()];
  const next: RuntimeWarmupSnapshot = labels.length === 0
    ? IDLE
    : { active: true, label: labels[labels.length - 1] };
  if (next.active === _snapshot.active && next.label === _snapshot.label) return;
  _snapshot = next;
  for (const l of _listeners) {
    try { l(); } catch { /* a subscriber must never break a load */ }
  }
}

/** A runtime started warming up. `label` is user-facing ("Detail physics"). */
export function beginRuntimeWarmup(id: string, label: string): void {
  _warmups.delete(id);  // re-insert, so the label order stays "most recent last"
  _warmups.set(id, label);
  publish();
}

/** That runtime is ready, or failed. Safe to call more than once. */
export function endRuntimeWarmup(id: string): void {
  if (!_warmups.delete(id)) return;
  publish();
}

/** True while `id` is warming up — for an owner that has to stay idempotent. */
export function isRuntimeWarmingUp(id: string): boolean {
  return _warmups.has(id);
}

export function subscribeRuntimeWarmup(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Stable snapshot for `useSyncExternalStore` — same object until a change. */
export function getRuntimeWarmupSnapshot(): RuntimeWarmupSnapshot {
  return _snapshot;
}

/** Test seam: forget every warmup without notifying anybody's UI of a change. */
export function resetRuntimeWarmupsForTests(): void {
  _warmups.clear();
  _snapshot = IDLE;
  _listeners.clear();
}
