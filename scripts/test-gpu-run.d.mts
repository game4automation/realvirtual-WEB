// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `test-gpu-run.mjs` (imported by `vitest.gpu.config.ts` and
 * `tests/test-gpu-run.node.test.ts`). Keep in step with the .mjs — no compiler check ties the two.
 */

import type { Plugin } from 'vite';

export const GPU_LAUNCH_ARGS: readonly string[];
export const GPU_BROWSER_CHANNEL: 'chromium';
export const GPU_CACHE_DIR: string;
export const GPU_SETUP_FILE: string;
export const GPU_TEST_LIST: string;
export const QUARANTINE_LIST: string;
export const PRIVATE_PREFIX: string;
export const NO_ADAPTER_MARK: string;
export const NOW_PASSES_MARK: string;

export interface GpuTestEntry { file: string; why: string }

export function hasPrivateSibling(root: string): boolean;
export function readGpuTests(root: string): GpuTestEntry[];
export function gpuTestFiles(options: { root: string; hasPrivate?: boolean }): string[];
export function mainSuiteEntries(options: { root: string; include: readonly string[]; exclude?: readonly string[] }): Promise<string[]>;
export function readQuarantineIds(root: string): string[];

export interface GpuRunTest { id: string; state?: string; errors?: string[] }
export interface GpuRunFileError { file: string; message: string }
export interface GpuRunClassification {
  baseline: {
    reproduced: string[];
    nowPasses: string[];
    otherCause: { id: string; message: string }[];
    skipped: string[];
    notRun: string[];
  };
  outside: { passed: number; failed: { id: string; message: string }[]; skipped: string[] };
  fileErrors: GpuRunFileError[];
  noAdapter: boolean;
  quarantineSize: number;
}

export function classifyGpuRun(input: { tests?: GpuRunTest[]; fileErrors?: GpuRunFileError[]; quarantineIds?: string[] }): GpuRunClassification;
export function formatGpuRunSummary(classification: GpuRunClassification): string[];
export function collectGpuRun(testModules: ReadonlyArray<unknown> | undefined, root: string): { tests: GpuRunTest[]; fileErrors: GpuRunFileError[] };

export class GpuRunReporter {
  constructor(options?: { log?: (line: string) => void; failRun?: () => void });
  onInit(vitest: unknown): void;
  onTestRunEnd(testModules: ReadonlyArray<unknown>): void;
}

export function gpuRunReporterPlugin(): Plugin;
