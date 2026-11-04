// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';

describe('plan-2006 9.29: queued live changes (#16)', () => {
  it.each(['revertPending', 'set-original'] as const)('%s invalidates the owner event before resume', (revert) => {
    const registry = createPlanningRegistry({ simTime: () => 12 });
    let modelRate = 40;
    const due: Array<() => void> = [];
    const validitySeen: boolean[] = [];
    const owner = registry.declare({
      owner: 'yard', title: 'Yard',
      params: [{ key: 'rate', label: 'Rate', type: 'number', default: 40, group: 'Load', apply: 'live' }],
      // Proposed validity seam: optional only so this regression compiles against
      // the existing two-argument API. Missing validity preserves today's behavior.
      // Like PalletYard.scheduleLive, model mutation precedes acknowledgement.
      onLive(change, applied, isValid: () => boolean = () => true) {
        due.push(() => {
          const valid = isValid();
          validitySeen.push(valid);
          if (!valid) return;
          modelRate = Number(change.to);
          applied(12);
        });
      },
    });
    // Paused clock: scheduling does not execute the event.
    expect(registry.set('yard.rate', 70, 'ui').applied).toBe('queued');
    expect(due).toHaveLength(1);
    expect(modelRate).toBe(40);
    if (revert === 'revertPending') expect(registry.revertPending('yard.rate')).toBe(true);
    else expect(registry.set('yard.rate', 40, 'ui').applied).toBe('reverted');
    expect(registry.getSnapshot().pendingCount).toBe(0);
    // Resume the owner's clock, including the event already scheduled while paused.
    due[0]();
    expect.soft(modelRate).toBe(40);
    expect.soft(validitySeen).toEqual([false]);
    expect(owner.values().rate).toBe(40);
    expect(registry.changeLog()).toEqual([]);
  });
});
