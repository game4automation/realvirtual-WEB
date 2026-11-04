// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { spawnSync } from 'node:child_process';
import { realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WV = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Runs one browser-vitest child process of a node test and returns its (ANSI-stripped) output.
 * `label` names the workload in error messages. The child shares node_modules/.vite with every other
 * browser run; a cold cache is safe because vite.config.ts pre-bundles the whole app graph
 * (optimizeDeps.include) - the children keep their generated test file under node_modules, which
 * the dependency scan skips.
 */
export function runChildVitest(label: string, args: string[], options: {
  timeout?: number;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
  label?: string; // overrides the first argument in error messages (e.g. the run / seed)
} = {}): string {
  const modules = join(WV, 'node_modules');
  // Community prechecks link dependencies into a different root. Keep Node's Vitest
  // imports under that root too, matching Vite's resolve.preserveSymlinks setting.
  const linkedModules = realpathSync(modules) !== join(realpathSync(WV), 'node_modules');
  const nodeArgs = linkedModules ? ['--preserve-symlinks', '--preserve-symlinks-main'] : [];
  const timeout = options.timeout ?? 900_000;
  const r = spawnSync(process.execPath, [...nodeArgs, join(modules, 'vitest', 'vitest.mjs'), 'run', ...args], {
    cwd: WV, encoding: 'utf8',
    env: {
      ...process.env, ...options.env, FORCE_COLOR: '0', NO_COLOR: '1',
    },
    timeout, maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  if (options.logFile) writeFileSync(options.logFile, out);
  const excerpt = out.length <= 7500 ? out : `${out.slice(0, 1500)}\n... [output truncated] ...\n${out.slice(-6000)}`;
  if (r.error) throw new Error(`vitest child ${options.label ?? label} failed to run (timeout ${timeout} ms, root ${WV}, linked node_modules: ${linkedModules}): ${r.error.message}\n${excerpt}`);
  if (r.status !== 0) {
    throw new Error(`vitest child ${options.label ?? label} exit ${r.status}:\n${excerpt}`);
  }
  return out;
}
