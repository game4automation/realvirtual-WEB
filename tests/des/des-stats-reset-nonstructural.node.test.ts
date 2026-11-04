// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { statisticsFixture } from './phase1-statistics-fixture';

describe('9.31 nonstructural statistics reset', () => {
  it('starts a fresh statistics window on both successive resets of the same component', () => {
    const { manager, component, schedule } = statisticsFixture();
    for (let run = 0; run < 3; run++) {
      if (run > 0) {
        manager.reset();
        // DESRunner.start clears registrations and reuses its existing adapters.
        manager.clearComponents();
        manager.registerComponent(component);
      }
      expect.soft(component.getStatistics().totalProcessed, `reset ${run}`).toBe(0);
      schedule(100);
      manager.processUpTo(100, 5000);
      const stats = component.getStatistics();
      const sum = Object.values(stats.states).reduce((total, state) => total + state.percent, 0);
      expect.soft(Math.abs(sum - 100), `run ${run}: ${sum}%`).toBeLessThanOrEqual(0.01);
      expect.soft(stats.totalProcessed, `run ${run}`).toBe(10);
    }
  });

  it('accounts for the full new window after rebind with no following setState', () => {
    const { manager, component, schedule } = statisticsFixture();
    schedule(100);
    manager.processUpTo(100, 5000);
    manager.reset();
    manager.clearComponents();
    manager.registerComponent(component);
    // No model events and no setState: only the running state accrues time.
    manager.processAnimated(100);
    const stats = component.getStatistics();
    const sum = Object.values(stats.states).reduce((total, state) => total + state.percent, 0);
    expect.soft(stats.totalProcessed).toBe(0);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.01);
  });
});
