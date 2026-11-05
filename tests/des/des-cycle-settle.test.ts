// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it, vi } from 'vitest';
import { cycleBrowserWorld, END } from './cycle-browser-world';

it('settles the moving DES MU before every takt read in Animated, FF and Batch', async () => {
  let reference: unknown;
  for (const mode of ['animated', 'fastforward', 'batch'] as const) {
    const world = await cycleBrowserWorld({ controls: false });
    try {
      expect(world.runner.cycleMode).toBe(true);
      expect(world.manager.onTimeAdvance).not.toBeNull();
      await world.advance(mode);
      expect(world.samples).toHaveLength(301);
      for (const sample of world.samples) {
        expect(sample.pose[0], `${mode} at ${sample.t}`).toBeCloseTo(sample.t, 12);
        expect(sample.pose.slice(1)).toEqual([0, 0]);
      }
      expect(world.samples.at(-1)).toEqual({ t: END, pose: [END, 0, 0] });
      if (reference) expect(world.samples, mode).toEqual(reference);
      else reference = structuredClone(world.samples);
    } finally { world.dispose(); }
  }
}, 120_000);

it('keeps settle wiring and Core events absent in a pure material-flow world', async () => {
  const world = await cycleBrowserWorld({ controls: false, consumer: false });
  const settle = vi.spyOn(world.runner.getTweenRegistry(), 'settle');
  try {
    expect(world.runner.cycleMode).toBe(false);
    expect((world.runner as unknown as { _settleRequired: number })._settleRequired).toBe(0);
    expect(world.manager.onTimeAdvance).toBeNull();
    await world.advance('batch');
    expect(world.manager.currentTime).toBe(END);
    expect(world.manager.totalEventsProcessed).toBeGreaterThan(0);
    expect(world.manager.onTimeAdvance).toBeNull();
    expect(settle).not.toHaveBeenCalled();
    expect(world.manager.getEventQueueSnapshot().some(e => e.actionName.startsWith('Core.'))).toBe(false);
    expect(world.runner.fullSnapshot().parts.some(p => p.key === 'core.cycle' || p.key === 'core.settle')).toBe(false);
  } finally { settle.mockRestore(); world.dispose(); }
}, 60_000);
