// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Allocation measurement via the V8 sampling heap profiler over CDP (Chromium
 * only, vitest browser mode). `performance.memory` is quantised in headless
 * Chromium and cannot see per-call allocations; the sampling profiler with
 * `includeObjectsCollectedBy{Major,Minor}GC` reports (scaled) bytes of every
 * sampled allocation, including short-lived garbage, attributed per function.
 */
import { cdp } from 'vitest/browser';

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
}

export interface AllocationReport {
  /** Estimated bytes allocated inside `run` (scaled by the profiler). */
  totalBytes: number;
  /**
   * Bytes per source MODULE (file basename, query stripped), aggregated over
   * EVERY sampled frame BEFORE any truncation (plan-515 R3-5) — a module that
   * allocates a little in many frames cannot hide below a top-N cut.
   */
  byModule: Map<string, number>;
  /** Top allocating frames, `name (file:line)` → bytes (display only, truncated). */
  top: Array<{ frame: string; bytes: number }>;
  /** Every allocating frame, sorted by bytes (untruncated, for diagnostics). */
  allFrames: Array<{ frame: string; bytes: number }>;
}

/** Bytes the report attributes to modules whose basename matches `pattern`. */
export function bytesInModules(report: AllocationReport, pattern: RegExp): number {
  let sum = 0;
  for (const [file, bytes] of report.byModule) if (pattern.test(file)) sum += bytes;
  return sum;
}

/**
 * Profile the allocations of `run()`; returns null when CDP is unavailable (the
 * caller reports "not verified").
 *
 * `warmup` runs AFTER the forced GC and BEFORE sampling starts: DevTools'
 * `collectGarbage` is an all-available-garbage collection that may discard
 * optimised code, and the first calls after it run unoptimised — where every
 * double operation allocates a HeapNumber. Without a warm-up those transient
 * bytes land on whatever code is being measured (plan-515 R3-5). It may be
 * async: optimised code is compiled concurrently and installed later, so a
 * warm-up that yields once and warms again reaches the optimised steady state.
 */
export async function sampleAllocations(
  run: () => void,
  samplingInterval = 32,
  warmup?: () => void | Promise<void>,
): Promise<AllocationReport | null> {
  // The CDPSession type is only filled in by the provider's type augmentation.
  type Sender = { send(method: string, params?: unknown): Promise<any> };
  let session: Sender;
  try { session = cdp() as unknown as Sender; } catch { return null; }
  const send = session.send.bind(session);
  try { await send('HeapProfiler.enable'); } catch { return null; }
  await send('HeapProfiler.collectGarbage');
  if (warmup) await warmup();
  await send('HeapProfiler.startSampling', {
    samplingInterval,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  run();
  const { profile } = await send('HeapProfiler.stopSampling') as { profile: { head: ProfileNode } };
  const byFrame = new Map<string, number>();
  const byModule = new Map<string, number>();
  let total = 0;
  const walk = (n: ProfileNode): void => {
    if (n.selfSize > 0) {
      total += n.selfSize;
      const file = n.callFrame.url.split('/').pop()?.split('?')[0] ?? '';
      const key = `${n.callFrame.functionName || '(anonymous)'} (${file}:${n.callFrame.lineNumber + 1})`;
      byFrame.set(key, (byFrame.get(key) ?? 0) + n.selfSize);
      byModule.set(file, (byModule.get(file) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c);
  };
  walk(profile.head);
  const allFrames = [...byFrame.entries()].sort((a, b) => b[1] - a[1]).map(([frame, bytes]) => ({ frame, bytes }));
  return { totalBytes: total, byModule, top: allFrames.slice(0, 12), allFrames };
}
