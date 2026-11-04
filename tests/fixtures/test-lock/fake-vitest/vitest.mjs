// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Test-lock startup-limit fixture — a stand-in for the vitest CLI. Named `vitest.mjs` on
 * purpose: the wrapper treats a runner file with that name as a vitest run.
 *
 *   node vitest.mjs <dir> <steps>
 *
 * Appends its pid to <dir>/pids.txt, then runs the comma-separated <steps>:
 *   start | module | first | end
 *                        → the progress record the real reporter would write (`run-start` /
 *                          `module-start` / `first-test` / `run-end`) into RV_TEST_LOCK_PROGRESS_FILE
 *   files:a|b | file-start:a | file-end:a → expected files / per-file progress (stall limit, `file`)
 *   file:a | fileend:a   → the plan-900 per-file records (`spec`): the only way to have SEVERAL
 *                          files in flight from ONE pid, which is the case in which a pid-global
 *                          clock names the wrong file. Written through the production
 *                          `writeProgress`, never by hand (plan-900 E15)
 *   sleep:<ms>           → wait
 *   idle                 → wait until killed (at most 120 s)
 * and exits 0 after the last step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROGRESS_ENV, writeProgress } from '../../../../scripts/test-progress-reporter.mjs';

const [dir, steps = ''] = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'pids.txt'), `${process.pid}\n`);
const file = process.env[PROGRESS_ENV];
const EVENTS = { start: 'run-start', module: 'module-start', first: 'first-test', end: 'run-end' };

for (const step of steps.split(',').filter(Boolean)) {
  const [name, arg] = step.split(':');
  if (EVENTS[name]) writeProgress(file, EVENTS[name]);
  else if (name === 'files') writeProgress(file, 'run-start', { files: arg.split('|') });
  else if (name === 'file-start' || name === 'file-end') writeProgress(file, name, { file: arg });
  else if (name === 'file') writeProgress(file, 'file-start', { spec: arg });
  else if (name === 'fileend') writeProgress(file, 'file-end', { spec: arg });
  else if (name === 'sleep') await new Promise((r) => setTimeout(r, Number(arg)));
  else if (name === 'idle') await new Promise((r) => setTimeout(r, 120_000));
  else throw new Error(`unknown step ${step}`);
}
process.exit(0);
