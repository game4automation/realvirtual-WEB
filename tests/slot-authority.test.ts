// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Unit tests for the slot-authority service (plan-320 Phases 1+2):
 *  - 9.13a SlotId NUL encoding is collision-free for space-bearing node paths.
 *  - Bidirectional slot↔channel index (fan-out + incremental reverse index).
 *  - Pure deriveSlotAuthority ranking (none/component/bound/forced).
 *  - Claim/release registry with the LATENT forced-over-bound stack.
 *  - Live-control gate + instance-flag registrar + full reset.
 *  - 9.13b telemetry reset mid-run restarts the (signal, writer) counters
 *    consistently (9.5 steady-state counter stays valid after a reset).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  SLOT_ID_SEPARATOR,
  claimBound,
  claimForced,
  claimedSlotCount,
  channelForSlot,
  clearLiveControl,
  deriveSlotAuthority,
  getSlotAuthority,
  isAnyLiveControlled,
  isSignalLiveControlled,
  liveControlledCount,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  releaseBound,
  releaseForced,
  resetSlotAuthority,
  setInstanceLiveControlled,
  setSignalLiveControlled,
  slotsForChannel,
  unregisterSlotChannel,
} from '../src/core/engine/rv-slot-authority';
import { SignalStore } from '../src/core/engine/rv-signal-store';

const NUL = String.fromCharCode(0);

afterEach(() => resetSlotAuthority());

describe('SlotId encoding (9.13a)', () => {
  it('uses the NUL byte as the segment separator (bindingKey/ownerKey convention)', () => {
    expect(SLOT_ID_SEPARATOR).toBe(NUL);
    const id = makeSlotId('el-1', 'Axis/Sub', 'Drive_Simple', 'Forward');
    expect(String(id).split(NUL)).toEqual(['el-1', 'Axis/Sub', 'Drive_Simple', 'Forward']);
  });

  it('space-bearing Unity node paths cannot collide across segment boundaries', () => {
    // Under a SPACE separator both pairs would produce the identical string.
    const a = makeSlotId('Station 1', 'Axis Left', 'Drive_Simple', 'Forward');
    const b = makeSlotId('Station', '1 Axis Left', 'Drive_Simple', 'Forward');
    expect(a).not.toBe(b);

    const c = makeSlotId('el', 'Robot Arm/Grip Unit', 'Sensor', 'IsOccupied');
    const d = makeSlotId('el', 'Robot Arm', 'Grip Unit Sensor', 'IsOccupied');
    expect(c).not.toBe(d);
  });

  it('folds componentType into the key so two component types on one node stay distinct', () => {
    const simple = makeSlotId('el', '.', 'Drive_Simple', 'Forward');
    const motor = makeSlotId('el', '.', 'Drive_DestinationMotor', 'Forward');
    expect(simple).not.toBe(motor);
  });
});

describe('slot ↔ channel index', () => {
  it('maintains the reverse index incrementally, including fan-out', () => {
    const slotA = makeSlotId('elA', '.', 'Sensor', 'SensorOccupied');
    const slotB = makeSlotId('elB', '.', 'Sensor', 'SensorOccupied');
    const channel = makeSignalChannelId('PLC.Sensor');

    registerSlotChannel(slotA, channel);
    registerSlotChannel(slotB, channel);
    expect(channelForSlot(slotA)).toBe(channel);
    expect(channelForSlot(slotB)).toBe(channel);
    expect([...slotsForChannel(channel)]).toEqual([slotA, slotB]);

    unregisterSlotChannel(slotA);
    expect(channelForSlot(slotA)).toBeUndefined();
    expect([...slotsForChannel(channel)]).toEqual([slotB]);

    unregisterSlotChannel(slotB);
    expect(slotsForChannel(channel)).toHaveLength(0);
  });

  it('re-registering a slot onto another channel moves it in both directions', () => {
    const slot = makeSlotId('el', '.', 'Drive_Simple', 'Forward');
    const first = makeSignalChannelId('Drive.Forward');
    const second = makeSignalChannelId('Drive.Forward2');
    registerSlotChannel(slot, first);
    registerSlotChannel(slot, second);
    expect(channelForSlot(slot)).toBe(second);
    expect(slotsForChannel(first)).toHaveLength(0);
    expect([...slotsForChannel(second)]).toEqual([slot]);
  });
});

describe('deriveSlotAuthority (pure)', () => {
  it('ranks forced > bound > component and reserves none for missing components', () => {
    expect(deriveSlotAuthority({ hasComponent: false, bound: false, forced: false })).toBe('none');
    expect(deriveSlotAuthority({ hasComponent: false, bound: true, forced: true })).toBe('none');
    expect(deriveSlotAuthority({ hasComponent: true, bound: false, forced: false })).toBe('component');
    expect(deriveSlotAuthority({ hasComponent: true, bound: true, forced: false })).toBe('bound');
    expect(deriveSlotAuthority({ hasComponent: true, bound: false, forced: true })).toBe('forced');
    expect(deriveSlotAuthority({ hasComponent: true, bound: true, forced: true })).toBe('forced');
  });
});

describe('claim/release registry (latent stack)', () => {
  const slot = makeSlotId('el', '.', 'Drive_Simple', 'Forward');

  it('defaults to component without any claim', () => {
    expect(getSlotAuthority(slot)).toBe('component');
    expect(claimedSlotCount()).toBe(0);
  });

  it('keeps the bound claim latent under a force and restores it on release', () => {
    claimBound(slot);
    expect(getSlotAuthority(slot)).toBe('bound');
    claimForced(slot);
    expect(getSlotAuthority(slot)).toBe('forced');
    releaseForced(slot);
    expect(getSlotAuthority(slot)).toBe('bound');   // NOT displaced
    releaseBound(slot);
    expect(getSlotAuthority(slot)).toBe('component');
    expect(claimedSlotCount()).toBe(0);             // record pruned
  });

  it('a forced claim survives losing the underlying bound claim', () => {
    claimBound(slot);
    claimForced(slot);
    releaseBound(slot);
    expect(getSlotAuthority(slot)).toBe('forced');
    releaseForced(slot);
    expect(getSlotAuthority(slot)).toBe('component');
    expect(claimedSlotCount()).toBe(0);
  });

  it('claims are idempotent and releases of unknown slots are no-ops', () => {
    claimBound(slot);
    claimBound(slot);
    expect(claimedSlotCount()).toBe(1);
    releaseForced(makeSlotId('other', '.', 'Sensor', 'SensorOccupied'));
    releaseBound(slot);
    expect(claimedSlotCount()).toBe(0);
  });
});

describe('live-control gate + instance flags + reset (9.9 groundwork)', () => {
  it('behaves identically to the former rv-live-control gate', () => {
    setSignalLiveControlled('Conv.Flow.Run', true);
    expect(isSignalLiveControlled('Conv.Flow.Run')).toBe(true);
    expect(isAnyLiveControlled('Conv.')).toBe(true);
    expect(isAnyLiveControlled('Conv_2.')).toBe(false);
    expect(isAnyLiveControlled('')).toBe(true);
    expect(liveControlledCount()).toBe(1);
    setSignalLiveControlled('Conv.Flow.Run', false);
    expect(liveControlledCount()).toBe(0);
    expect(isAnyLiveControlled('')).toBe(false);
  });

  it('resetSlotAuthority clears claims, indexes, gate and raised instance flags', () => {
    const slot = makeSlotId('el', '.', 'Drive_Simple', 'Forward');
    claimBound(slot);
    claimForced(slot);
    registerSlotChannel(slot, makeSignalChannelId('Drive.Forward'));
    setSignalLiveControlled('Drive.Forward', true);
    const instance: { liveControlled?: boolean } = {};
    setInstanceLiveControlled(instance, true);
    expect(instance.liveControlled).toBe(true);

    resetSlotAuthority();

    expect(claimedSlotCount()).toBe(0);
    expect(getSlotAuthority(slot)).toBe('component');
    expect(channelForSlot(slot)).toBeUndefined();
    expect(slotsForChannel(makeSignalChannelId('Drive.Forward'))).toHaveLength(0);
    expect(liveControlledCount()).toBe(0);
    expect(instance.liveControlled).toBe(false);    // stale flag actively lowered
  });

  it('clearLiveControl only clears the gate, not the claims', () => {
    const slot = makeSlotId('el', '.', 'Sensor', 'SensorOccupied');
    claimBound(slot);
    setSignalLiveControlled('S.Occupied', true);
    clearLiveControl();
    expect(liveControlledCount()).toBe(0);
    expect(getSlotAuthority(slot)).toBe('bound');
  });
});

describe('telemetry reset mid-run (9.13b)', () => {
  it('restarts the deduplicated counters consistently after resetWriterInventory', () => {
    const store = new SignalStore();
    const writer = store.createWriter('component:test', 'component');
    writer.set('A', 1, 10);
    writer.set('A', 2, 20);
    expect(store.getWriterInventory()).toMatchObject([{ signal: 'A', writeCount: 2 }]);

    store.resetWriterInventory();
    expect(store.getWriterInventory()).toEqual([]);

    // The next writes re-enter cleanly: exactly ONE new entry, counting from 1,
    // and steady-state repetition adds no further entries (9.5 invariant).
    writer.set('A', 3, 30);
    writer.set('A', 3, 40);
    writer.set('A', 3, 50);
    const inventory = store.getWriterInventory();
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      signal: 'A',
      writerId: 'component:test',
      firstSeenAt: 30,
      writeCount: 3,
    });
  });
});
