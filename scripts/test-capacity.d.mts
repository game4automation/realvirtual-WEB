// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export type RunClass = 'light' | 'heavy' | 'exclusive';
export type CapacityMode = 'budget' | 'single';
export type CapacityEnv = Record<string, string | undefined>;

export const LIGHT_FILE_LIMIT: 20;
export function capacityMode(env?: CapacityEnv, cores?: number): CapacityMode;
export function classifyRun(runner: string, args: readonly string[], env?: CapacityEnv, cwd?: string): RunClass;
export function workerBudget(klass: RunClass, env?: CapacityEnv, cores?: number): number | undefined;
export function childEnvFor(klass: RunClass, env?: CapacityEnv, cores?: number): {
  set: Record<string, string>;
  unset: string[];
};
export function reentryEnvFor(env?: CapacityEnv, cores?: number): {
  set: Record<string, string>;
  unset: string[];
};
