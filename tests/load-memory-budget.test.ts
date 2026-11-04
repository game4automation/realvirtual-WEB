// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import {
  assessLoadMemory, reportLoadMemoryBudget, HEAP_PER_GLB_BYTE,
  MEMORY_BUDGET_CODE, MEMORY_BUDGET_PROBLEM_ID, MIN_GLB_BYTES_FOR_CHECK,
} from '../src/core/engine/rv-load-memory-budget';
import { clearAllProblems, getProblems } from '../src/core/hmi/problems-store';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MAUSER = 242 * MiB;

describe('assessLoadMemory', () => {
  it('estimates the peak from the GLB size', () => {
    expect(assessLoadMemory({ bytes: MAUSER }).estimatedPeakBytes).toBe(Math.round(MAUSER * HEAP_PER_GLB_BYTE));
  });

  it('is silent for a small model whatever the browser says', () => {
    const v = assessLoadMemory({ bytes: MIN_GLB_BYTES_FOR_CHECK - 1, heapLimitBytes: 64 * MiB, deviceMemoryGiB: 1 });
    expect(v.severity).toBe('ok');
    expect(v.reasons).toEqual([]);
  });

  it('is silent when the browser exposes no numbers', () => {
    expect(assessLoadMemory({ bytes: MAUSER }).severity).toBe('ok');
  });

  it('warns when the estimated peak exceeds the reported heap limit (32-bit Chrome on ARM)', () => {
    const v = assessLoadMemory({ bytes: MAUSER, heapLimitBytes: 1120 * MiB, deviceMemoryGiB: 16 });
    expect(v.severity).toBe('warning');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toMatch(/limit of 1\.1 GB/);
  });

  it('stays ok for the same model in a native 64-bit browser', () => {
    expect(assessLoadMemory({ bytes: MAUSER, heapLimitBytes: 4192 * MiB, deviceMemoryGiB: 16 }).severity).toBe('ok');
  });

  it('warns on a low-memory device even with a generous heap limit', () => {
    const v = assessLoadMemory({ bytes: MAUSER, heapLimitBytes: 4 * GiB, deviceMemoryGiB: 4 });
    expect(v.severity).toBe('warning');
    expect(v.reasons[0]).toMatch(/4 GB of memory/);
  });

  it('does not warn for a device with 8 GB and a model that fits a quarter of it', () => {
    expect(assessLoadMemory({ bytes: 120 * MiB, heapLimitBytes: 4 * GiB, deviceMemoryGiB: 8 }).severity).toBe('ok');
  });
});

describe('reportLoadMemoryBudget', () => {
  beforeEach(() => {
    clearAllProblems();
    // jsdom exposes neither performance.memory nor navigator.deviceMemory;
    // stub both so the wrapper has something to read.
    Object.defineProperty(performance, 'memory', { configurable: true, value: { jsHeapSizeLimit: 1120 * MiB } });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 16 });
  });

  it('files ONE memory-budget problem naming the file, and clears it on the next fitting load', () => {
    const v = reportLoadMemoryBudget('/private-models/mauser3dhmi/MauserCageline30.glb', MAUSER);
    expect(v.severity).toBe('warning');
    const entries = getProblems().filter((p) => p.code === MEMORY_BUDGET_CODE);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(MEMORY_BUDGET_PROBLEM_ID);
    expect(entries[0]!.title).toMatch(/MauserCageline30\.glb \(242 MB\)/);
    expect(entries[0]!.detail).toMatch(/64-bit browser/);

    reportLoadMemoryBudget('/models/small.glb', 10 * MiB);
    expect(getProblems().filter((p) => p.code === MEMORY_BUDGET_CODE)).toHaveLength(0);
  });
});
