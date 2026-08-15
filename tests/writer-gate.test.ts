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
  registerSlotWriteRole,
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

  it('a role-resolved FAN-OUT channel stays steady and allocation-free (plan-353)', () => {
    // plan-353 replaced the first-hit loop with a full pass over the channel's
    // slots and added a role lookup per bound slot. Both are on the write path,
    // so the two standing promises are re-measured with the new shape:
    //   * no NEW telemetry entries on repeated writes (the dedup still holds
    //     even though the deciding slot is now chosen, not stumbled upon), and
    //   * the pass stays a bounded loop of Map lookups — no allocation, which
    //     shows up as a stable entry count plus a sane wall time.
    const store = new SignalStore();
    store.register('Conv.Run', 'Conv/Run', false, 'PLCInputBool');

    // Eight slots on ONE channel: seven feedback, one control — the worst case
    // for the aggregation, because it can only answer after seeing them all.
    const FAN_OUT = 8;
    for (let i = 0; i < FAN_OUT; i++) {
      const slotId = makeSlotId('el1', '.', 'Conveyor', `Slot${i}`);
      registerSlotChannel(slotId, makeSignalChannelId('Conv.Run'));
      registerSlotWriteRole(slotId, i === FAN_OUT - 1 ? 'control' : 'feedback');
      claimBound(slotId);
    }
    const sim = store.createWriter('component:Conveyor:Conv', 'component');

    sim.set('Conv.Run', true);   // warm-up creates the single entries
    const inventoryBaseline = store.getWriterInventory().length;
    const conflictBaseline = store.getWriteConflicts().length;
    expect(conflictBaseline).toBe(1);

    const started = performance.now();
    for (let i = 0; i < 5000; i++) sim.set('Conv.Run', i % 2 === 0);
    const elapsed = performance.now() - started;

    expect(store.getWriterInventory().length).toBe(inventoryBaseline);
    expect(store.getWriteConflicts().length).toBe(conflictBaseline);
    expect(store.getWriteConflicts()[0].writeCount).toBeGreaterThan(5000);
    // Generous bound — this is a regression guard against an accidental
    // allocation or an O(n²) rescan, not a micro-benchmark.
    expect(elapsed).toBeLessThan(200);
  });

  it('an all-FEEDBACK fan-out logs nothing — the allowed case is not a conflict', () => {
    // The shadow log must not fill up with the case plan-353 F6 just declared
    // correct, or the telemetry that is supposed to prepare the enforce rollout
    // becomes unreadable.
    const store = new SignalStore();
    store.register('Conv.Run', 'Conv/Run', false, 'PLCInputBool');
    for (let i = 0; i < 4; i++) {
      const slotId = makeSlotId('el1', '.', 'Conveyor', `Fb${i}`);
      registerSlotChannel(slotId, makeSignalChannelId('Conv.Run'));
      registerSlotWriteRole(slotId, 'feedback');
      claimBound(slotId);
    }
    const sim = store.createWriter('component:Conveyor:Conv', 'component');
    for (let i = 0; i < 100; i++) sim.set('Conv.Run', i % 2 === 0);

    expect(store.getWriteConflicts()).toHaveLength(0);
    expect(store.get('Conv.Run')).toBe(false);
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

describe('enforce with unknown writer (9.13c, corrected by plan-353 §9.6)', () => {
  // Two DIFFERENT things used to be conflated here, and the old test proved
  // neither: it called the raw API twice and credited the result to an
  // "unknown-id writer classified as a sim kind", which never appeared. The
  // raw fallback `UNKNOWN_WRITER` is kind 'plugin', so it leaves the gate at the
  // very first line (`!isLocalSimKind`) — the id exception below it is never
  // even consulted on that path. Both cases are now separated and each is
  // asserted where it actually takes effect.

  it('raw legacy write: never reaches the gate at all (kind plugin)', () => {
    const { store } = fixture();
    store.signalWriteGate = 'enforce';

    store.set('Conv.Run', true);
    expect(store.get('Conv.Run')).toBe(true);      // lands
    // …and no conflict is logged, because the gate returned before recording:
    // this writer is not a local-simulation kind.
    expect(store.getWriteConflicts()).toHaveLength(0);

    store.setMany({ 'Conv.Run': false });
    expect(store.get('Conv.Run')).toBe(false);
    expect(store.getWriteConflicts()).toHaveLength(0);
  });

  it('classified writer carrying the legacy id: reaches the gate, is recorded, still lands', () => {
    const { store } = fixture();
    store.signalWriteGate = 'enforce';

    // THIS is the case the id exception exists for: a writer that IS a sim kind
    // (so the gate engages and records) but still carries the raw fallback id.
    // Policy fixed by plan-353 F8: it is never rejected, so a legacy path can
    // never disappear silently once enforce goes hot — but it IS visible in the
    // conflict log, which is how such a path gets found and fixed.
    const legacyId = store.createWriter('unknown', 'component');

    store.set('Conv.Run', true, Date.now(), legacyId);
    expect(store.get('Conv.Run')).toBe(true);      // lands despite enforce

    const conflicts = store.getWriteConflicts();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      writerId: 'unknown',
      writerKind: 'component',
      reason: 'authority-bound',
    });

    // A classified writer with a REAL id is rejected in the same situation —
    // the id is the only difference, which is what makes this an exception.
    const classified = store.createWriter('component:Conveyor:Other', 'component');
    classified.set('Conv.Run', false);
    expect(store.get('Conv.Run')).toBe(true);      // rejected
  });
});
