// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Synchronous test-run classification and worker budgets (plan-2200). */
import os from 'node:os';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

export const LIGHT_FILE_LIMIT = 20;
const CLASSES = new Set(['light', 'heavy', 'exclusive']);
const VALUE_OPTIONS = new Set(['--config', '--reporter', '--bail', '-t', '--testNamePattern', '--project']);

function coreCount(env, cores) {
  const override = env.RV_TEST_CAPACITY_CORES;
  return /^\d+$/.test(override ?? '') && Number.isSafeInteger(Number(override)) && Number(override) > 0
    ? Number(override) : cores;
}

export function capacityMode(env = process.env, cores = os.availableParallelism()) {
  if (env.RV_TEST_CAPACITY === 'single' || env.RV_TEST_CAPACITY === 'budget') return env.RV_TEST_CAPACITY;
  return coreCount(env, cores) >= 24 ? 'budget' : 'single';
}

const scriptName = (file) => file.replaceAll('\\', '/').split('/').at(-1);

/** Only an explicit, bounded list of existing test files qualifies as light. */
export function classifyRun(runner, args, env = process.env, cwd = process.cwd()) {
  if (capacityMode(env) === 'single') return 'heavy';
  if (CLASSES.has(env.RV_TEST_LOCK_CLASS)) return env.RV_TEST_LOCK_CLASS;
  try {
    const explicit = args.find((arg) => arg.startsWith('--class=') && CLASSES.has(arg.slice(8)));
    if (explicit) return explicit.slice(8);
    if (/perf/i.test(scriptName(runner)) || args.some((arg) => arg.replaceAll('\\', '/').includes('e2e/perf'))) {
      return 'exclusive';
    }
    for (let i = 0; i < args.length; i++) {
      const config = args[i] === '--config' ? args[i + 1] : args[i].startsWith('--config=') ? args[i].slice(9) : null;
      if (config && /^vitest\.(perf|gpu)/i.test(scriptName(config))) return 'exclusive';
    }
    if (!/^vitest(?:\.mjs|\.js|\.cmd)?$/i.test(scriptName(runner))) return 'heavy';
    const positional = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      // Invalid class overrides are ignored, without changing the caller's arguments.
      if (arg.startsWith('--class=')) continue;
      if (!arg.startsWith('-')) {
        positional.push(arg);
        continue;
      }
      const equal = arg.indexOf('=');
      const option = equal < 0 ? arg : arg.slice(0, equal);
      if (option === '--silent') {
        if (equal >= 0 && !['true', 'false', 'passed-only'].includes(arg.slice(equal + 1))) return 'heavy';
        if (equal < 0 && ['true', 'false', 'passed-only'].includes(args[i + 1])) i++;
      } else if (VALUE_OPTIONS.has(option)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value || value.startsWith('-')) return 'heavy';
      } else {
        return 'heavy';
      }
    }
    if (positional.shift() !== 'run' || positional.length < 1 || positional.length > LIGHT_FILE_LIMIT) return 'heavy';
    return positional.every((file) =>
      !/[*?\[\]{}()!]/.test(file) && /\.(?:test\.(?:ts|tsx|mjs)|spec\.ts)$/.test(file) && statSync(resolve(cwd, file)).isFile(),
    ) ? 'light' : 'heavy';
  } catch {
    return 'heavy';
  }
}

export function workerBudget(klass, env = process.env, cores = os.availableParallelism()) {
  if (capacityMode(env, cores) === 'single') return undefined;
  if (klass === 'light') return 4;
  if (klass === 'heavy') return Math.floor(0.75 * coreCount(env, cores) / 2);
  return undefined;
}

/**
 * Environment patch; callers apply unset after copying the inherited environment.
 * `single` mode leaves the environment exactly as the wrapper always did (no class, no worker patch).
 */
export function childEnvFor(klass, env = process.env, cores = os.availableParallelism()) {
  if (capacityMode(env, cores) === 'single') return { set: {}, unset: [] };
  const set = { RV_TEST_LOCK_CLASS: klass };
  const unset = [];
  const budget = workerBudget(klass, env, cores);
  const override = env.RV_TEST_MAX_WORKERS;
  if (override !== undefined && override !== '') {
    // An explicit override always wins over a budget, including one inherited from an outer wrapper.
    if (/^\d+$/.test(override)) set.VITEST_MAX_WORKERS = override;
    else unset.push('VITEST_MAX_WORKERS');
  } else if (budget === undefined) {
    unset.push('VITEST_MAX_WORKERS');
  } else {
    set.VITEST_MAX_WORKERS = String(budget);
  }
  return { set, unset };
}

/**
 * A re-entering (nested) wrapper keeps the outer class and budget, but an explicit
 * `RV_TEST_MAX_WORKERS` of the nested run still wins over the inherited `VITEST_MAX_WORKERS`.
 */
export function reentryEnvFor(env = process.env, cores = os.availableParallelism()) {
  const override = env.RV_TEST_MAX_WORKERS;
  if (capacityMode(env, cores) === 'single' || override === undefined || override === '') return { set: {}, unset: [] };
  return /^\d+$/.test(override) ? { set: { VITEST_MAX_WORKERS: override }, unset: [] } : { set: {}, unset: ['VITEST_MAX_WORKERS'] };
}
