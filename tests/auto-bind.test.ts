// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * auto-bind — derives 1:1 signal links (exact store-name OR exact slot/alias),
 * skips manually-bound slots, and never binds on a non-exact (token/fuzzy) match.
 */
import { describe, it, expect } from 'vitest';
import { computeAutoBinds, mergeWithAutoBinds, type AutoBindSignal } from '../src/plugins/signal-bind/auto-bind';
import type { ResolvedSlot } from '../src/core/engine/rv-binding-slot-resolver';

const slot = (over: Partial<ResolvedSlot>): ResolvedSlot => ({
  slot: 'Flow.Run', targetName: 'Conv1@Flow.Run', type: 'bool', direction: 'plcInput', aliases: [], instance: null, ...over,
});

describe('computeAutoBinds', () => {
  it('binds on exact internal store-name match (truly the same signal)', () => {
    const slots = [slot({ slot: 'Flow.Run', targetName: 'Conv1@Flow.Run' })];
    const signals: AutoBindSignal[] = [{ name: 'Conv1@Flow.Run', direction: 'input' }];
    const res = computeAutoBinds(slots, new Set(), signals);
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ slot: 'Flow.Run', signal: 'Conv1@Flow.Run', direction: 'plcInput', enabled: true });
  });

  it('binds on exact friendly slot-name match when store-name differs', () => {
    const slots = [slot({ slot: 'Flow.Run', targetName: 'Conv1@Flow.Run' })];
    const signals: AutoBindSignal[] = [{ name: 'Flow.Run', direction: 'input' }];
    const res = computeAutoBinds(slots, new Set(), signals);
    expect(res).toHaveLength(1);
    expect(res[0].signal).toBe('Flow.Run');
  });

  it('binds on an alias exact match', () => {
    const slots = [slot({ slot: 'Flow.Run', targetName: 'x', aliases: ['start'] })];
    const signals: AutoBindSignal[] = [{ name: 'Start', direction: 'input' }];
    const res = computeAutoBinds(slots, new Set(), signals);
    expect(res[0]?.signal).toBe('Start');
  });

  it('skips slots already covered by a manual mapping (manual wins)', () => {
    const slots = [slot({ slot: 'Flow.Run', targetName: 'Flow.Run' })];
    const signals: AutoBindSignal[] = [{ name: 'Flow.Run', direction: 'input' }];
    const res = computeAutoBinds(slots, new Set(['Flow.Run']), signals);
    expect(res).toHaveLength(0);
  });

  it('does NOT bind on a non-exact (token/fuzzy) match', () => {
    const slots = [slot({ slot: 'Flow.Run', targetName: 'x' })];
    const signals: AutoBindSignal[] = [{ name: 'Conveyor1.MotorRunning', direction: 'input' }];
    const res = computeAutoBinds(slots, new Set(), signals);
    expect(res).toHaveLength(0);
  });

  it('returns nothing when no signals are available', () => {
    expect(computeAutoBinds([slot({})], new Set(), [])).toHaveLength(0);
  });
});

describe('mergeWithAutoBinds', () => {
  it('keeps manual mappings and appends derived binds for the other slots', () => {
    const slots = [
      slot({ slot: 'Flow.Run', targetName: 'Flow.Run' }),
      slot({ slot: 'Flow.Occupied', targetName: 'Flow.Occupied', direction: 'plcOutput' }),
    ];
    const manual: import('../src/plugins/layout-planner/rv-layout-store').SignalMapping[] = [
      { slot: 'Flow.Run', signal: 'CustomRun', direction: 'plcInput', enabled: true },
    ];
    const signals: AutoBindSignal[] = [
      { name: 'Flow.Run', direction: 'input' },        // would auto-match, but manual wins
      { name: 'Flow.Occupied', direction: 'output' },  // auto-binds
    ];
    const res = mergeWithAutoBinds(manual, slots, signals);
    expect(res).toHaveLength(2);
    expect(res.find(m => m.slot === 'Flow.Run')?.signal).toBe('CustomRun');
    expect(res.find(m => m.slot === 'Flow.Occupied')?.signal).toBe('Flow.Occupied');
  });
});
