// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-load-memory-budget — "will this GLB fit into this browser?" asked BEFORE
 * the parse, answered as a Problems entry the user can read instead of a dead
 * tab.
 *
 * Why: a large CAD line crashes the renderer process with
 * `RangeError: Array buffer allocation failed` (or Chrome's "Aw, Snap") when
 * the JS heap runs out in the middle of the bake. Nothing in the page gets to
 * say why. Measured 2026-10-19 on the large CAD line (242 MB GLB, 70 k nodes,
 * 7.5 M triangles): peak JS heap 1.7–1.8 GB during load, 1.4 GB steady — in a
 * 32-bit x86 Chrome (emulated on Windows-on-ARM, heap limit reported as
 * 1.1 GB) that is a coin toss, in a native 64-bit browser (limit 4 GB) it is
 * fine. So the budget is a function of the file size and of what the browser
 * will give us, and the message names the three things that actually help:
 * a 64-bit browser, fewer tabs, a reduced export.
 *
 * Pure: {@link assessLoadMemory} takes numbers, returns a verdict. The impure
 * wrapper {@link reportLoadMemoryBudget} reads `performance.memory` and
 * `navigator.deviceMemory` (both Chromium-only; absent → unknown → silent) and
 * files or clears the ONE `memory-budget` problem.
 */

import { clearProblem, reportProblem } from '../hmi/problems-store';

/** Peak JS heap per GLB byte during load (the large CAD line: 1.77 GB / 242 MB ≈ 7.3). */
export const HEAP_PER_GLB_BYTE = 7.5;
/** Below this a GLB never triggers the check — the small-model path stays silent. */
export const MIN_GLB_BYTES_FOR_CHECK = 100 * 1024 * 1024;
/** Problems-panel code and the fixed entry id (one budget verdict at a time). */
export const MEMORY_BUDGET_CODE = 'memory-budget';
export const MEMORY_BUDGET_PROBLEM_ID = 'memory-budget';

export interface LoadMemoryInput {
  /** GLB size in bytes. */
  bytes: number;
  /** `performance.memory.jsHeapSizeLimit` in bytes, or undefined when the browser hides it. */
  heapLimitBytes?: number;
  /** `navigator.deviceMemory` in GiB (coarse, capped at 8 by the spec), or undefined. */
  deviceMemoryGiB?: number;
}

export interface LoadMemoryVerdict {
  severity: 'ok' | 'warning';
  /** Estimated peak JS heap during load, bytes. */
  estimatedPeakBytes: number;
  /** Why it is a warning — empty when ok. One sentence each, for the detail line. */
  reasons: string[];
}

/** Pure budget check. Unknown inputs never produce a warning on their own. */
export function assessLoadMemory(input: LoadMemoryInput): LoadMemoryVerdict {
  const estimatedPeakBytes = Math.round(input.bytes * HEAP_PER_GLB_BYTE);
  const reasons: string[] = [];
  if (input.bytes >= MIN_GLB_BYTES_FOR_CHECK) {
    if (input.heapLimitBytes !== undefined && input.heapLimitBytes > 0 && estimatedPeakBytes > input.heapLimitBytes) {
      reasons.push(
        `Loading needs about ${formatGiB(estimatedPeakBytes)} of JavaScript heap, this browser reports a limit of ${formatGiB(input.heapLimitBytes)}.`,
      );
    }
    if (input.deviceMemoryGiB !== undefined && input.deviceMemoryGiB > 0 && input.deviceMemoryGiB <= 8
      && estimatedPeakBytes > input.deviceMemoryGiB * 1024 * 1024 * 1024 * 0.25) {
      reasons.push(
        `The device reports ${input.deviceMemoryGiB} GB of memory; the load alone takes about ${formatGiB(estimatedPeakBytes)}.`,
      );
    }
  }
  return { severity: reasons.length ? 'warning' : 'ok', estimatedPeakBytes, reasons };
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** What the user can do — the same three lines whatever the reason. */
export const MEMORY_BUDGET_ADVICE =
  'Use a 64-bit browser (on Windows on ARM: the ARM64 build of Chrome, or Edge), close other tabs with 3D content, or open a reduced export of this model.';

/** Read the browser's own numbers; both are Chromium-only and may be absent. */
export function readBrowserMemoryInfo(): { heapLimitBytes?: number; deviceMemoryGiB?: number } {
  const out: { heapLimitBytes?: number; deviceMemoryGiB?: number } = {};
  try {
    const mem = (performance as unknown as { memory?: { jsHeapSizeLimit?: number } }).memory;
    if (mem && typeof mem.jsHeapSizeLimit === 'number' && mem.jsHeapSizeLimit > 0) out.heapLimitBytes = mem.jsHeapSizeLimit;
  } catch { /* not exposed */ }
  try {
    const dm = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    if (typeof dm === 'number' && dm > 0) out.deviceMemoryGiB = dm;
  } catch { /* not exposed */ }
  return out;
}

/**
 * File the budget verdict for the GLB about to be parsed, or clear a stale one.
 * Also logs the warning, so a crash that follows leaves a trace in the console.
 */
export function reportLoadMemoryBudget(url: string, bytes: number): LoadMemoryVerdict {
  const verdict = assessLoadMemory({ bytes, ...readBrowserMemoryInfo() });
  if (verdict.severity === 'ok') {
    clearProblem(MEMORY_BUDGET_PROBLEM_ID);
    return verdict;
  }
  const name = url.replace(/^.*\//, '') || url;
  const detail = `${verdict.reasons.join(' ')} ${MEMORY_BUDGET_ADVICE}`;
  reportProblem({
    id: MEMORY_BUDGET_PROBLEM_ID,
    severity: 'warning',
    code: MEMORY_BUDGET_CODE,
    title: `${name} (${(bytes / (1024 * 1024)).toFixed(0)} MB) may exceed this browser's memory`,
    detail,
  });
  console.warn(`[loader] memory budget: ${detail}`);
  return verdict;
}
