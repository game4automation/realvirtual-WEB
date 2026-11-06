// SPDX-License-Identifier: AGPL-3.0-only
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

export interface ContinuationEvent {
  time: number;
  action: string;
  componentId: string | null;
  muId: number;
}

/** Factories must create independent owners and deterministic initial state.
 * Browser factories should pause the viewer loop, load the real GLB, await
 * whenSceneReady()/script wiring/document hashes, then return this same port.
 * Deliberately no parity-harness runtime import: it pulls WebGL into Node tests.
 * trace() returns the accumulated dispatch log; the harness slices at the cut.
 * Key KPIs by participant id so a KPI-only difference can name its owner.
 */
export interface ContinuationWorld {
  runner: { fullSnapshot(): DESSnapshotV4; restoreFull(raw: unknown): void };
  step(toT: number): void | Promise<void>;
  kpis(): Record<string, unknown>;
  trace(): readonly ContinuationEvent[];
  dispose?(): void | Promise<void>;
}
export interface UndeclaredState {
  code: 'des-state-not-declared';
  participant: string;
  path: string;
  expected: unknown;
  actual: unknown;
}
export class ContinuationMismatch extends Error implements UndeclaredState {
  readonly code = 'des-state-not-declared' as const;
  constructor(readonly participant: string, readonly path: string,
    readonly expected: unknown, readonly actual: unknown) {
    super(`des-state-not-declared: ${participant} ${path}`);
  }
}

export interface ContinuationOptions {
  buildWorld(): ContinuationWorld | Promise<ContinuationWorld>;
  mode: 'A' | 'B' | 'B-immediate';
  T: number;
  TPrime: number;
  T2: number;
  /** Test-only fault injection, after either in-place or fresh-world restore. */
  afterRestore?(world: ContinuationWorld): void | Promise<void>;
}

/** Sort object keys only. Array order, floats, envelope and fingerprint are exact. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
}

function compare(expected: unknown, actual: unknown, participant: string, path = '$'): void {
  if (canonicalJson(expected) === canonicalJson(actual)) return;
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object'
    && Array.isArray(expected) === Array.isArray(actual)) {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    keys.sort(Array.isArray(expected) ? (x, y) => Number(x) - Number(y) : undefined);
    for (const key of keys) {
      const child = Array.isArray(expected) ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
      if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) throw new ContinuationMismatch(participant, child, a[key], b[key]);
      compare(a[key], b[key], participant, child);
    }
  }
  throw new ContinuationMismatch(participant, path, expected, actual);
}

export function compareFullSnapshots(expected: DESSnapshotV4, actual: DESSnapshotV4): void {
  // Participant order is the registry's dependency order. Report the first part
  // before secondary consequences in the queue or display metadata.
  const keys = [...new Set([...expected.parts.map(p => p.key), ...actual.parts.map(p => p.key)])];
  for (const key of keys) compare(expected.parts.find(p => p.key === key), actual.parts.find(p => p.key === key), key);
  compare(expected, actual, 'envelope');
}

export async function assertContinuation(options: ContinuationOptions): Promise<void> {
  const { buildWorld, mode, T, TPrime, T2 } = options;
  if (![T, TPrime, T2].every(Number.isFinite) || T < 0 || !(TPrime > T && T2 > T)) {
    throw new Error('Continuation requires finite times, T >= 0, TPrime > T and T2 > T');
  }
  const end = mode === 'B-immediate' ? T : T2;
  let world: ContinuationWorld | undefined;
  const observe = (w: ContinuationWorld, start: number) => ({
    snapshot: w.runner.fullSnapshot(),
    kpis: JSON.parse(JSON.stringify(w.kpis())) as Record<string, unknown>,
    trace: w.trace().slice(start).map(e => ({ ...e })),
  });
  try {
    world = await buildWorld();
    await world.step(T);
    const refStart = world.trace().length;
    if (end > T) await world.step(end);
    const reference = observe(world, refStart);
    await world.dispose?.(); world = undefined;

    world = await buildWorld();
    await world.step(T);
    const saved = world.runner.fullSnapshot();
    if (mode === 'A') {
      await world.step(TPrime); // Must mutate the very owners being restored.
      world.runner.restoreFull(saved);
    } else {
      const text = JSON.stringify(saved);
      await world.dispose?.(); world = undefined;
      world = await buildWorld();
      world.runner.restoreFull(JSON.parse(text));
    }
    await options.afterRestore?.(world);
    const start = world.trace().length;
    if (end > T) await world.step(end);
    const actual = observe(world, start);
    compareFullSnapshots(reference.snapshot, actual.snapshot);
    for (const key of [...new Set([...Object.keys(reference.kpis), ...Object.keys(actual.kpis)])].sort()) {
      compare(reference.kpis[key], actual.kpis[key], key, '$.kpis');
    }
    for (let i = 0; i < Math.max(reference.trace.length, actual.trace.length); i++) {
      compare(reference.trace[i], actual.trace[i], reference.trace[i]?.componentId ?? actual.trace[i]?.componentId ?? 'envelope', `$.trace[${i}]`);
    }
  } finally { await world?.dispose?.(); }
}
