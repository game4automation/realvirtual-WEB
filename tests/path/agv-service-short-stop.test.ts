// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, expect, it } from 'vitest';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { setReverseGateOpen } from '../../src/core/engine/rv-movement-authority';
import { clearShared } from '../helpers/agv-harness';
import { delay, FORK, FORK_MESH, forkCfg, makeStubWorld, stubLayout } from '../helpers/agv-stub-world';

beforeEach(() => { clearShared(); setReverseGateOpen(true); });
afterEach(() => setReverseGateOpen(true));

it.each(['animated', 'continuous'] as const)('A4 %s finishes a turn approach after an infeasible docking crawl', mode => {
  stubLayout();
  const w = makeStubWorld(mode, [{ name: 'F', cfg: forkCfg('L0', 3500), mesh: FORK_MESH, body: FORK }], 120);
  let assigned = false;
  let served = false;
  let shortStop = false;
  const poll = (): void => {
    const plan = w.mb.planOf('F');
    if (plan?.stopCause === 'service' && !plan.profile.feasible && plan.profile.xStop < plan.freeEnd - 0.001) shortStop = true;
    const loc = w.mb.locate('F', w.now())!;
    const rest = loc.path.length - loc.s;
    // 1.44 m emergency braking fits, but the last 0.5 m at 0.3 m/s
    // requires earlier braking. Mirrors Stapler_6 in the size-4 dump.
    if (!assigned && loc.path.id === 'Turn2' && rest < 1.7 && rest > 1.5 && loc.v > 1.19) {
      assigned = true;
      getDefaultAgvFleet().get('F')!.assign({ destination: 'S2', approach: 'reverse', serviceSec: 1,
        onServiceEnd: () => { served = true; } });
    }
    if (!served) delay(0.05, poll);
  };
  try {
    delay(0.05, poll);
    while (!w.done() && !served) w.step();
    expect(assigned).toBe(true);
    expect(shortStop).toBe(true);
    expect(served).toBe(true);
    expect(w.mb.stats.turnGuardTrips).toBe(0);
    expect(w.mb.stats.violations).toBe(0);
  } finally { w.dispose(); }
});
