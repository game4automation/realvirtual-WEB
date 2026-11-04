// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { agvZoneScenario } from '../helpers/agv-zone-scenario';
import { runBlockageChecker } from '../../src/core/diagnostics/rv-blockage-checker';
import { enumerateCycles } from '../../src/core/diagnostics/rv-blockage-probes';

it.each(['continuous', 'fastforward'] as const)('finds the real stale-hold deadlock (%s)', mode => {
  const sc = agvZoneScenario(mode, { disableStep4: true });
  try {
    // Wait a full default idle budget AFTER formation, not just since run start.
    sc.run(240);
    const report = sc.inspect(ctx => {
      expect(ctx.heldM2AtSwitch).toBe(true);
      expect(enumerateCycles(ctx.world.mb.zoneWaitEdges({ holders: 'nodes' })).cycles).toEqual([['A', 'M1', 'B', 'M2', 'A']]);
      return runBlockageChecker(ctx);
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ cls: 'deadlock', chain: ['A', 'M1', 'B', 'M2', 'A'], budgetSource: 'default' });
    expect(report.coverage.missing).toEqual([]);
    console.info('follow/zone coverage', mode, report.coverage);
  } finally { sc.dispose(); }
}, 180000);
// With the stale-hold release the zone deadlock does not form. The run is NOT clean beyond the
// original test's horizon, though: B parks idle at the end of R1, and A's route to R2 runs
// through it, so A stands behind B for good (R1 s = 8.3, phase 'driving'). A follower wait has
// an authority follow edge, so the checker names the parked leader B.
it.each(['continuous', 'fastforward'] as const)('stale-hold release: no deadlock, A stalls behind the parked B (%s)', mode => {
  const sc = agvZoneScenario(mode);
  try {
    sc.run(240);
    const { findings, coverage } = sc.inspect(runBlockageChecker);
    console.info('follow coverage', mode, coverage);
    expect(coverage.missing).toEqual([]);
    sc.inspect(ctx => expect(ctx.registry.collect(ctx.now)).toContainEqual(expect.objectContaining({
      waiterId: 'A', resourceId: 'leader:B', ownerIds: ['B'], kind: 'follow', analysed: true,
    })));
    expect(findings.filter(f => f.cls === 'deadlock')).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ cls: 'stall', chain: ['A', 'leader:B', 'B'] });
    expect(findings[0].checks.map(c => c.name)).toContain('wait-edge');
  } finally { sc.dispose(); }
}, 180000);
