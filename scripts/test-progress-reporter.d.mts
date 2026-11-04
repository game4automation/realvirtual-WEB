// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Type declarations for `test-progress-reporter.mjs` (imported by `vite.config.ts` and
 * `vitest.node.config.ts`). Keep in step with the .mjs — no compiler check ties the two.
 */

import type { Plugin } from 'vite';

export const PROGRESS_ENV: 'RV_TEST_LOCK_PROGRESS_FILE';
export const SKIP_LINE_TOP: number;
export const WRAPPER_SPAWN_ENV: 'RV_TEST_WRAPPER_SPAWN_MS';
export const NO_REASON: string;
export const FAILED_IN_SETUP: string;
export const STRICT_DEPS_ENV: 'RV_TEST_STRICT_DEPS';
export type StrictDepsMode = 'fail' | 'warn' | 'off';
export const DEFAULT_STRICT_DEPS_MODE: StrictDepsMode;
export function strictDepsMode(env?: Record<string, string | undefined>): StrictDepsMode;

export interface SkipGroup { key: string; count: number }

/** One progress record. `spec` (plan-900) names the FILE of a `file-start` / `file-end`. */
export interface ProgressRecord { ev: string; pid: number; ppid?: number; t: number; file?: string; files?: string[]; spec?: string }
export function writeProgress(file: string | undefined | null, ev: string, fields?: { pid?: number; ppid?: number; spec?: string; file?: string; files?: string[] }): void;
export function formatSkipLine(groups: SkipGroup[], options?: { top?: number }): string;
export function formatFirstTestLine(input: { now: number; runStart: number; config?: string; wrapperSpawn?: number }): string;
export function formatModuleStartLine(input: { now: number; runStart: number; config?: string; wrapperSpawn?: number }): string;
export function collectSkips(testModules: ReadonlyArray<unknown> | undefined, root?: string): SkipGroup[];

export const FAIL_LIVE_LIMIT: number;
export const FAIL_MESSAGE_MAX: number;
export const FAIL_LIMIT_LINE: string;
export interface FailState { shown: number; suppressed: number; entities: Set<unknown>; errors: WeakSet<object> }
export function failMessage(error: unknown): string;
export function failStackLine(error: unknown, root?: string): string;
export function formatFailLine(input: { file?: string; label?: string; error?: unknown; root?: string }): string;
export function formatFailRemainderLine(suppressed: number): string;
export function createFailState(): FailState;
export function noteFail(fails: FailState): 'show' | 'notice' | 'suppress';

export interface DepsHit { dep: string; reloaded: boolean }
export interface DepsState { mode: StrictDepsMode; before: string[]; after: string[]; hits: Map<string, DepsHit> }
export interface ProgressState { file: string; wrapperSpawn?: number; runStart: boolean; runStartAt?: number; moduleStart?: boolean; firstTest: boolean; runEnd: boolean; deps?: DepsState; fails?: FailState }

export function formatDepsHitLine(deps: string[], options?: { reloaded?: boolean }): string;
export function formatDepsSummary(hits: DepsHit[]): string;
export function createDepsState(mode?: StrictDepsMode): DepsState;
export function noteDepDiscovered(dep: string, state?: ProgressState): boolean;
export function noteDepReload(state?: ProgressState): string;
export function depsRunEnd(state?: ProgressState): { lines: string[]; fail: boolean };
export function watchDepsOptimizer(server: unknown, options?: { state?: ProgressState; log?: (line: string) => void }): number;

export class TestLockProgressReporter {
  constructor(state?: ProgressState, deps?: { write?: typeof writeProgress; log?: (line: string) => void; now?: () => number; failRun?: () => void });
  onInit(vitest: unknown): void;
  onTestRunStart(): void;
  onTestModuleQueued(testModule?: unknown): void;
  onTestModuleStart(testModule?: unknown): void;
  onTestCaseReady(): void;
  onTestCaseResult(testCase: unknown): void;
  onTestSuiteResult(testSuite: unknown): void;
  onTestModuleEnd(testModule: unknown): void;
  onTestRunEnd(testModules: ReadonlyArray<unknown>): void;
}

export function testLockProgressPlugin(): Plugin;
