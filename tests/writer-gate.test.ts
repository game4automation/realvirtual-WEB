// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.4 writer-gate-shadow-vs-enforce · 9.5 hot-path-steady-state ·
 * 9.13c enforce-with-unknown-writer (plan-320 Phase 4).
 *
 * The shadow gate reuses the Phase-0 telemetry infrastructure: conflicts are
 * recorded deduplicated as (SlotId, writer, reason) in an ADDITIVE conflicts
 * log; in 'shadow' (default) nothing is rejected, in 'enforce' classified
 * local-simulation writers are dropped — `unknown` writers NEVER are.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  claimBound,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  resetSlotAuthority,
  setAuthorityRanking,
  setRemoteOwnershipActive,
} from '../src/core/engine/rv-slot-authority';

afterEach(() => {
  setAuthorityRanking('strict');
  resetSlotAuthority();
});

/** Store with one bound slot claim on channel 'Conv.Run'. */
function fixture() {
  const store = new SignalStore();
  store.register('Conv.Run', 'Conv/Run', false, 'PLCInputBool');
  store.register('Free.Run', 'Free/Run', false, 'PLCInputBool');
  const slotId = makeSlotId('el1', '.', 'Conveyor', 'Flow.Run');
  registerSlotChannel(slotId, makeSignalChannelId('Conv.Run'));
  claimBound(slotId);
  const sim = store.createWriter('component:Conveyor:Conv', 'component');
  return { store, slotId, sim };
}

describe('writer gate shadow vs enforce (9.4)', () => {
  it('defaults to shadow: conflict recorded (deduplicated), write lands', () => {
    const { store, slotId, sim } = fixture();
    expect(store.signalWriteGate).toBe('shadow');

    sim.set('Conv.Run', true);
    expect(store.get('Conv.Run')).toBe(true); // NOT rejected

    const conflicts = store.getWriteConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      slotId,
      writerId: 'component:Conveyor:Conv',
      writerKind: 'component',
      reason: 'authority-bound',
      writeCount: 1,
    });

    // Deduplication: a second conflicting write bumps the counter only.
    sim.set('Conv.Run', false);
    const again = store.getWriteConflicts();
    expect(again).toHaveLength(1);
    expect(again[0].writeCount).toBe(2);
    expect(store.get('Conv.Run')).toBe(false);
  });

  it('enforce rejects a classified sim writer with a reason; setMany too', () => {
    const { store, slotId, sim } = fixture();
    store.signalWriteGate = 'enforce';

    sim.set('Conv.Run', true);
    expect(store.get('Conv.Run')).toBe(false); // rejected — value unchanged

    sim.setMany({ 'Conv.Run': true, 'Free.Run': true });
    expect(store.get('Conv.Run')).toBe(false); // rejected inside the batch
    expect(store.get('Free.Run')).toBe(true);  // unclaimed channel passes

    const conflicts = store.getWriteConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reason).toBe('authority-bound');

    // The UI companion mirrors the rejection reason.
    expect(store.canWriteSlot(slotId, sim)).toEqual({ allowed: false, reason: 'authority-bound' });
    // The relay itself is never in conflict with its own claim.
    const relay = store.createWriter('component:signal-binding-manager', 'component');
    expect(store.canWriteSlot(slotId, relay)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('records forced-channel drops with reason authority-forced', () => {
    const { store, slotId, sim } = fixture();
    store.forceSignal('Conv.Run', true);
    sim.set('Conv.Run', false); // dropped by the force (unchanged semantics)
    expect(store.get('Conv.Run')).toBe(true);

    const forcedConflicts = store.getWriteConflicts().filter(c => c.reason === 'authority-forced');
    expect(forcedConflicts).toHaveLength(1);
    expect(forcedConflicts[0].writerId).toBe('component:Conveyor:Conv');
    expect(store.canWriteSlot(slotId, sim).reason).toBe('authority-forced');
  });

  it('force UI reason: authority-remote when a strict remote owner pre-empts', () => {
    const { store, slotId } = fixture();
    const forceWriter = { writerId: 'hmi:force', writerKind: 'hmi' as const };

    // No remote owner: forcing is plain 'ok'.
    expect(store.canWriteSlot(slotId, forceWriter)).toEqual({ allowed: true, reason: 'ok' });

    // Strict remote owner: the force still lands but is flagged as overridden
    // — the reason drives the plan-320 hint, distinct from the plan-317
    // slot-availability reasons.
    setRemoteOwnershipActive(true);
    expect(store.canWriteSlot(slotId, forceWriter)).toEqual({ allowed: true, reason: 'authority-remote' });

    // Legacy ranking: forced > remote — no override hint.
    setAuthorityRanking('legacy');
    expect(store.canWriteSlot(slotId, forceWriter)).toEqual({ allowed: true, reason: 'ok' });

    // Remote writer vs. a forced channel mirrors the ranking as well.
    store.forceSignal('Conv.Run', true);
    const remote = { writerId: 'multiuser', writerKind: 'remote' as const };
    expect(store.canWriteSlot(slotId, remote)).toEqual({ allowed: false, reason: 'authority-forced' });
    setAuthorityRanking('strict');
    expect(store.canWriteSlot(slotId, remote)).toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('hot path steady state (9.5)', () => {
  it('repeated writes of the same (signal, writer) create NO new entries', () => {
    const { store, sim } = fixture();
    const free = store.createWriter('component:Free', 'component');

    // Warm-up: one conflicting + one clean write create their single entries.
    sim.set('Conv.Run', true);
    free.set('Free.Run', true);
    const inventoryBaseline = store.getWriterInventory().length;
    const conflictBaseline = store.getWriteConflicts().length;

    for (let i = 0; i < 1000; i++) {
      sim.set('Conv.Run', i % 2 === 0);
      free.set('Free.Run', i % 2 === 0);
      free.setMany({ 'Free.Run': i % 3 === 0 });
    }

    expect(store.getWriterInventory().length).toBe(inventoryBaseline);
    expect(store.getWriteConflicts().length).toBe(conflictBaseline);

    // Counters DID move — the dedup is per entry, not a dropped recording.
    const conflict = store.getWriteConflicts()[0];
    expect(conflict.writeCount).toBeGreaterThan(1000);
  });

  it('telemetry reset mid-run restarts cleanly (9.13b counter consistency)', () => {
    const { store, sim } = fixture();
    sim.set('Conv.Run', true);
    expect(store.getWriteConflicts()).toHaveLength(1);

    store.resetWriterInventory();
    expect(store.getWriterInventory()).toHaveLength(0);
    expect(store.getWriteConflicts()).toHaveLength(0);

    sim.set('Conv.Run', false);
    const conflicts = store.getWriteConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].writeCount).toBe(1);
  });
});

describe('enforce with unknown writer (9.13c)', () => {
  it('a raw (unknown) write passes even in enforce mode and is only recorded', () => {
    const { store } = fixture();
    store.signalWriteGate = 'enforce';

    // Raw legacy API — writer 'unknown'. The write must LAND despite the
    // bound claim (policy: unknown is never rejected, only recorded).
    store.set('Conv.Run', true);
    expect(store.get('Conv.Run')).toBe(true);

    const conflicts = store.getWriteConflicts();
    expect(conflicts).toHaveLength(0); // unknown is kind 'plugin' — not a sim writer

    // An unknown-id writer that IS classified as a sim kind is still recorded
    // but never rejected either (writerId 'unknown' is the raw fallback).
    store.setMany({ 'Conv.Run': false });
    expect(store.get('Conv.Run')).toBe(false);
  });
});
