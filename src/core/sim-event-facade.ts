// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { SnapshotProvider } from './sdk/rv-snapshot-contract-types';

export const SETTLE_MAX_ROUNDS = 64;
export const SETTLE_MAX_BATCHES = 1024;
export type SignalValue = boolean | number;

export interface EventParticipant {
  readSet(): Iterable<string>;
  /** Evaluate at t, reading only the process image; return whether own state changed. */
  settle(t: number, image: ReadonlyMap<string, SignalValue>): boolean;
  dueTime(now: number): number | null;
  onSettleOverflow?(message: string): void;
  holdsRun?(): boolean;
}

export interface CycleParticipant {
  step(dt: number): void;
  alive(): boolean;
}

export interface SimEventFacade {
  isEventDriven(): boolean;
  readonly now: number;
  readonly cycleTime: number;
  registerEventParticipant(id: string, order: number, p: EventParticipant): () => void;
  reorderEventParticipant?(id: string, order: number): void;
  refreshEventParticipant?(id: string, p: EventParticipant): void;
  wake(id: string): void;
  registerCycleParticipant(id: string, order: number, p: CycleParticipant): () => void;
  registerSnapshotProvider(id: string, provider: SnapshotProvider): () => void;
  registerResetHook(id: string, fn: () => void | Promise<void>): () => void;
  /** Keeps the simulation clock closed until `until` settles (an owner rebuilding its state at DES entry). */
  holdProgress?(until: Promise<unknown>): void;
  /** Refuses capture and synchronous restore while `check()` reports a transient owner state; async restores wait. */
  registerSnapshotGate?(id: string, gate: SnapshotGate): () => void;
}

export interface SnapshotGate {
  /** A refusal (snapshot problem code + detail) while the owner cannot be saved or loaded right now. */
  check(): { code: string; detail: string } | null;
  /** Settles once `check()` would pass again; never rejects. */
  whenClear(): Promise<void>;
}

const doubles = new Float64Array(1);
const bits = new BigInt64Array(doubles.buffer);

/** Next representable double toward positive infinity. */
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  doubles[0] = x;
  bits[0] += x > 0 ? 1n : -1n;
  return doubles[0];
}

/** First representable seconds at or above ms/1000 satisfying the owner's due test. */
export function ceilEventTimeFor(ms: number, isDueAtMs: (ms: number) => boolean): number {
  if (!Number.isFinite(ms)) throw new Error('finite event deadline required');
  let t = ms / 1000;
  while (!isDueAtMs(t * 1000)) {
    const next = nextUp(t);
    if (!Number.isFinite(next)) throw new Error('event deadline cannot be reached');
    t = next;
  }
  return t;
}
