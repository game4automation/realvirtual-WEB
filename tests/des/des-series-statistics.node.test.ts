// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Analytic raster evaluation shares the component's exact warm-up formula. */
import { expect, it } from 'vitest';
import { computeDesStatistics } from '@rv/plugins/des/rv-des-component';
import { statisticsFixture } from './phase1-statistics-fixture';

it('evaluates counters, free states and both baselines before and after warm-up', () => {
  const { manager, component, schedule } = statisticsFixture(25);
  manager.duration = 50;
  component.freeStates = ['Empty', 'Charging'];
  schedule(50);
  manager.processUpTo(20, 10000);
  const before = component.statAccumulators();
  expect(computeDesStatistics(before, 20)).toEqual(component.getStatistics());
  expect(computeDesStatistics(before, 24).outputPerHour).toBe(2 / 24 * 3600);
  manager.processUpTo(30, 10000);
  const after = component.statAccumulators();
  expect(after.statBaselineTime).toBe(25);
  expect(after.processedBaseline).toBe(2);
  expect(computeDesStatistics(after, 35).outputPerHour).toBe(360);
  expect(computeDesStatistics(after, 35).emptyPercent).toBe(50);
  expect(computeDesStatistics(after, 35).utilization).toBe(50);
  manager.processUpTo(50, 10000);
  expect(computeDesStatistics(component.statAccumulators(), manager.currentTime)).toEqual(component.getStatistics());
});
