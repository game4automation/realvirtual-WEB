// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { FleetJobRunner } from '../../src/core/fleet/exec/job-runner';
import { FLEET_WAIT_TIMEOUT_CODE } from '../../src/core/fleet/exec/wait-watch';
import { getProblems } from '../../src/core/hmi/problems-store';

// Historical timeout counts/problems differ from a current blockage snapshot. Keep this
// contract intact; use ../helpers/expect-no-blockage for progress, cycles and coverage.
export function expectNoWaitTimeouts(runner: FleetJobRunner): void {
  const watch = runner.waitWatch;
  const counts = watch.kinds().filter(kind => watch.stats(kind).timeouts > 0)
    .map(kind => `${kind}: ${watch.stats(kind).timeouts} timeout(s)`);
  const problems = new Map([...watch.timeoutProblems(), ...getProblems().filter(p => p.code === FLEET_WAIT_TIMEOUT_CODE)]
    .map(p => [p.id, `${p.id}\n${p.detail}`]));
  if (counts.length || problems.size) throw new Error([...counts, ...problems.values()].join('\n'));
}
