// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ContinuousSimClock } from '../../src/core/fleet/core/sim-clock';

describe('continuous named clock actions', () => {
  it('shares time and scheduling order with closures, including rearming', () => {
    const clock = new ContinuousSimClock(), seen: unknown[] = [];
    clock.registerAction('tick', data => {
      seen.push(data);
      if (data === 1) clock.scheduleAction(2, 'tick', 3);
    });
    clock.scheduleAction(2, 'tick', 1);
    clock.schedule(2, () => seen.push('closure'));
    clock.scheduleAction(1, 'tick', 0, { afterModelEvents: true });
    clock.scheduleAction(2, 'tick', 2);
    expect(clock.advanceTo(3)).toBe(5);
    expect(seen).toEqual([0, 1, 'closure', 2, 3]);
    expect(clock.pendingCount).toBe(0);
  });
  it('cancels actions and closures and ignores foreign generations', () => {
    const clock = new ContinuousSimClock(), seen: unknown[] = [];
    const handler = (data: unknown) => { seen.push(data); };
    clock.registerAction('tick', handler);
    clock.registerAction('tick', handler);
    const old = clock.scheduleAction(1, 'tick', 'old');
    clock.reset();
    const current = clock.scheduleAction(1, 'tick', 'current');
    expect(current.g).toBe(old.g + 1);
    clock.cancel(old);
    const cancelled = clock.scheduleAction(1, 'tick', 'cancelled');
    clock.cancel(cancelled); clock.cancel(cancelled);
    clock.cancel(clock.schedule(1, () => seen.push('closure')));
    clock.advanceTo(2);
    clock.cancel(current); clock.advanceTo(3);
    expect(seen).toEqual(['current']);
  });
});
