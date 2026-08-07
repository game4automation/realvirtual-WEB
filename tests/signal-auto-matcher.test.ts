// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.5 signal-auto-matcher — 3-stage matching (exact → token/synonym → fuzzy),
 * suggestions only (never a silent bind below the confidence threshold).
 */
import { describe, it, expect } from 'vitest';
import {
  suggestForSlot,
  suggestForElement,
  tokenize,
  normalizeName,
} from '../src/plugins/signal-bind/auto-matcher';
import type { SignalSlotDescriptor } from '../src/plugins/signal-bind/slot-descriptors';

const FLOW_RUN: SignalSlotDescriptor = { slot: 'Flow.Run', type: 'bool', direction: 'plcInput', aliases: ['run', 'start', 'motorrun', 'enable'] };
const IS_OCCUPIED: SignalSlotDescriptor = { slot: 'IsOccupied', type: 'bool', direction: 'plcOutput', aliases: ['occupied', 'presence', 'sensoroccupied', 'detected'] };

describe('auto-matcher — helpers', () => {
  it('normalizeName strips separators and lowercases', () => {
    expect(normalizeName('Flow.Run')).toBe('flowrun');
    expect(normalizeName('Conveyor1_Start')).toBe('conveyor1start');
  });

  it('tokenize splits CamelCase and separators', () => {
    expect(tokenize('Conveyor1.SensorOccupied')).toEqual(['conveyor1', 'sensor', 'occupied']);
    expect(tokenize('Flow.Run')).toEqual(['flow', 'run']);
  });
});

describe('auto-matcher — stage 1 exact', () => {
  it('exact normalised name match scores 1', () => {
    const r = suggestForSlot(FLOW_RUN, ['Flow.Run', 'Conveyor.Speed']);
    expect(r[0]).toMatchObject({ signal: 'Flow.Run', confidence: 1, stage: 'exact' });
  });

  it('an alias-equal signal also counts as exact', () => {
    // "Run" equals the alias 'run' after normalisation.
    const r = suggestForSlot(FLOW_RUN, ['Run']);
    expect(r[0]).toMatchObject({ signal: 'Run', stage: 'exact' });
  });
});

describe('auto-matcher — stage 2 token/synonym', () => {
  it('SensorOccupied matches IsOccupied via the occupied synonym group', () => {
    const r = suggestForSlot(IS_OCCUPIED, ['Conveyor1.SensorOccupied', 'Motor.Run']);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].signal).toBe('Conveyor1.SensorOccupied');
    expect(r[0].stage).toBe('token');
    expect(r[0].confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('Motor.Run matches Flow.Run via the run synonym group', () => {
    const r = suggestForSlot(FLOW_RUN, ['Motor.Run', 'Tank.Level']);
    expect(r[0].signal).toBe('Motor.Run');
    expect(['exact', 'token']).toContain(r[0].stage);
  });
});

describe('auto-matcher — negative (no silent bind)', () => {
  it('returns nothing for an unrelated signal', () => {
    // "Conveyor1_Start" shares nothing with the Sensor IsOccupied slot.
    const r = suggestForSlot(IS_OCCUPIED, ['Conveyor1_Start']);
    expect(r).toHaveLength(0);
  });

  it('returns nothing when the signal list is empty', () => {
    expect(suggestForSlot(FLOW_RUN, [])).toHaveLength(0);
  });
});

describe('auto-matcher — element greedy assignment', () => {
  it('does not assign one signal to two slots', () => {
    const slots = [FLOW_RUN, IS_OCCUPIED];
    // Both have a clear match; the run signal goes to Flow.Run, occupied to IsOccupied.
    const res = suggestForElement(slots, ['Motor.Run', 'Cell.SensorOccupied']);
    const flow = res.find((r) => r.slot === 'Flow.Run')!;
    const occ = res.find((r) => r.slot === 'IsOccupied')!;
    expect(flow.suggestion?.signal).toBe('Motor.Run');
    expect(occ.suggestion?.signal).toBe('Cell.SensorOccupied');
    // No collision.
    expect(flow.suggestion?.signal).not.toBe(occ.suggestion?.signal);
  });

  it('leaves a slot unsuggested when nothing matches', () => {
    const res = suggestForElement([IS_OCCUPIED], ['Totally.Unrelated.Tag']);
    expect(res[0].suggestion).toBeNull();
  });
});
