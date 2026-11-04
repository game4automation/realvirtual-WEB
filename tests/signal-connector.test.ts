// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 Phase 1 — SignalConnector runtime: on-change conversion, write only
 * on change, instance-bound writer identity (two placements of one file =
 * two writers, RR2), re-apply after reset (signals rule 7), live control +
 * resync through the kernel (rule 5), the word aggregator, dispose — and the
 * ConnectSignal parity fix (F2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { makeConnectorWorld } from './helpers/signal-connector-rig';
import { resetSlotAuthority, setSignalLiveControlled } from '../src/core/engine/rv-slot-authority';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';
import { signalConnectorNetworkFor } from '../src/core/engine/rv-signal-connector';

beforeEach(() => { resetSlotAuthority(); resetProblemsForTests(); });
afterEach(() => { resetSlotAuthority(); resetProblemsForTests(); });

function writesOf(store: ReturnType<typeof makeConnectorWorld>['store'], signal: string) {
  return store.getWriterInventory().filter((e) => e.signal === signal);
}

describe('SignalConnector — on-change conversion', () => {
  it('copies a BOOL robot output onto a PLC input, initial value included', () => {
    const w = makeConnectorWorld();
    const src = w.signal('RobotReady', 'PLCOutputBool', true);
    const dst = w.signal('Rob_Ready', 'PLCInputBool');
    w.connector('Conn', { Mode: 'Copy', SourceBool: src, TargetBool: dst });
    expect(w.store.get('Rob_Ready')).toBe(true);
    w.store.set('RobotReady', false);
    expect(w.store.get('Rob_Ready')).toBe(false);
    w.dispose();
  });

  it('writes only when the converted value changes', () => {
    const w = makeConnectorWorld();
    const src = w.signal('State', 'PLCOutputInt');
    const dst = w.signal('Busy', 'PLCInputBool');
    w.connector('Conn', { Mode: 'IntToBool', SourceInt: src, TargetBool: dst });
    w.store.set('State', 3);
    w.store.set('State', 4); // still true — no write
    w.store.set('State', 7); // still true — no write
    expect(w.store.get('Busy')).toBe(true);
    const inv = writesOf(w.store, 'Busy').filter((e) => e.writerId.startsWith('component:SignalConnector:'));
    expect(inv).toHaveLength(1);
    expect(inv[0].writeCount).toBe(1);
    w.dispose();
  });

  it('IntToBool NotZero is true for a negative INT', () => {
    const w = makeConnectorWorld();
    const src = w.signal('State', 'PLCOutputInt');
    const dst = w.signal('Busy', 'PLCInputBool');
    w.connector('Conn', { Mode: 'IntToBool', SourceInt: src, TargetBool: dst });
    w.store.set('State', -1);
    expect(w.store.get('Busy')).toBe(true);
    w.dispose();
  });

  it('BitFromWord reads bit 31 of a DWord', () => {
    const w = makeConnectorWorld();
    const src = w.signal('Status', 'PLCOutputInt');
    const dst = w.signal('Fault', 'PLCInputBool');
    w.connector('Conn', { Mode: 'BitFromWord', SourceInt: src, TargetBool: dst, Bit: 31, Width: 'DWord' });
    w.store.set('Status', -2147483648);
    expect(w.store.get('Fault')).toBe(true);
    w.store.set('Status', 2147483647);
    expect(w.store.get('Fault')).toBe(false);
    w.dispose();
  });

  it('Scale REAL to INT rounds half away from zero and clamps', () => {
    const w = makeConnectorWorld();
    const src = w.signal('Speed', 'PLCOutputFloat');
    const dst = w.signal('SpeedInt', 'PLCInputInt');
    w.connector('Conn', { Mode: 'Scale', SourceFloat: src, TargetInt: dst, Factor: 10, Width: 'Word', Signed: true });
    w.store.set('Speed', -0.25);
    expect(w.store.get('SpeedInt')).toBe(-3);
    w.store.set('Speed', 1e6);
    expect(w.store.get('SpeedInt')).toBe(32767);
    w.dispose();
  });

  it('a disabled connector writes nothing', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const dst = w.signal('B', 'PLCInputBool');
    w.connector('Conn', { Mode: 'Copy', Enabled: false, SourceBool: src, TargetBool: dst });
    expect(w.store.get('B')).toBe(false);
    w.dispose();
  });
});

describe('SignalConnector — writer identity (RR2)', () => {
  it('uses the full instance address: two placements of one file are two writers', () => {
    const w = makeConnectorWorld();
    const s1 = w.signal('Out1', 'PLCOutputBool');
    const t1 = w.signal('In1', 'PLCInputBool');
    const s2 = w.signal('Out2', 'PLCOutputBool');
    const t2 = w.signal('In2', 'PLCInputBool');
    // Same NodeId (same bytes), different occurrence chains.
    const p1 = new Object3D(); p1.name = 'Machine_1'; w.root.add(p1);
    const p2 = new Object3D(); p2.name = 'Machine_2'; w.root.add(p2);
    const a = w.connector('Conn', { SourceBool: s1, TargetBool: t1 }, { nodeId: 'c0nn', occurrence: 'ref1', parent: p1 });
    const b = w.connector('Conn', { SourceBool: s2, TargetBool: t2 }, { nodeId: 'c0nn', occurrence: 'ref2', parent: p2 });
    expect(a.instanceAddress).toBe('ref1#c0nn');
    expect(b.instanceAddress).toBe('ref2#c0nn');
    w.store.set('Out1', true);
    w.store.set('Out2', true);
    expect(writesOf(w.store, 'In1')[0].writerId).toBe('component:SignalConnector:ref1#c0nn');
    expect(writesOf(w.store, 'In2')[0].writerId).toBe('component:SignalConnector:ref2#c0nn');
    w.dispose();
  });

  it('falls back to the node path for a node without identity', () => {
    const w = makeConnectorWorld();
    const c = w.connector('Conn', {});
    expect(c.instanceAddress).toBe('path:Cell/Conn');
    w.dispose();
  });
});

describe('SignalConnector — re-apply and live control', () => {
  it('re-applies the converted level after a reset (signals rule 7)', () => {
    const w = makeConnectorWorld();
    const src = w.signal('State', 'PLCOutputInt', 5);
    const dst = w.signal('Busy', 'PLCInputBool');
    w.connector('Conn', { Mode: 'IntToBool', SourceInt: src, TargetBool: dst });
    expect(w.store.get('Busy')).toBe(true);
    w.store.set('Busy', false); // a reset puts the input back to its initial value
    w.reapply.reapplyAll();
    expect(w.store.get('Busy')).toBe(true);
    w.dispose();
  });

  it('writes nothing while the target is live-controlled and resyncs converted on release', () => {
    const w = makeConnectorWorld();
    const src = w.signal('State', 'PLCOutputInt');
    const dst = w.signal('Busy', 'PLCInputBool');
    w.connector('Conn', { Mode: 'IntToBool', SourceInt: src, TargetBool: dst, Condition: 'Equals', CompareValue: 4 });
    setSignalLiveControlled('Busy', true);
    w.store.set('Busy', true); // external owner
    w.store.set('State', 1); // swallowed
    expect(w.store.get('Busy')).toBe(true);
    w.store.set('State', 2);
    setSignalLiveControlled('Busy', false);
    expect(w.store.get('Busy')).toBe(false); // 2 == 4 is false, through the kernel
    w.dispose();
  });
});

describe('SignalConnector — word aggregator', () => {
  function bits() {
    const w = makeConnectorWorld();
    const b0 = w.signal('Gripper', 'PLCOutputBool');
    const b3 = w.signal('Home', 'PLCOutputBool');
    const word = w.signal('RobotStatus', 'PLCInputInt');
    const c0 = w.connector('Bit00', { Mode: 'BitToWord', SourceBool: b0, TargetInt: word, Bit: 0 });
    const c3 = w.connector('Bit03', { Mode: 'BitToWord', SourceBool: b3, TargetInt: word, Bit: 3 });
    return { w, c0, c3, word };
  }

  it('builds the word from two bits that change together', () => {
    const { w } = bits();
    w.store.setMany({ Gripper: true, Home: true });
    expect(w.store.get('RobotStatus')).toBe(9);
    w.store.set('Gripper', false);
    expect(w.store.get('RobotStatus')).toBe(8);
    w.dispose();
  });

  it('is the one writer of the word', () => {
    const { w } = bits();
    w.store.set('Gripper', true);
    w.store.set('Home', true);
    const writers = new Set(writesOf(w.store, 'RobotStatus').map((e) => e.writerId));
    expect([...writers]).toEqual(['component:SignalConnector.word:path:Cell/RobotStatus']);
    w.dispose();
  });

  it('a disabled bit connector clears its bit; the last removal writes 0', () => {
    const { w, c0, c3 } = bits();
    w.store.setMany({ Gripper: true, Home: true });
    w.edit(c3, { Enabled: false });
    expect(w.store.get('RobotStatus')).toBe(1);
    c0.dispose();
    expect(w.store.get('RobotStatus')).toBe(0);
    expect(signalConnectorNetworkFor(w.store).getAggregator('Cell/RobotStatus')).toBeUndefined();
    w.dispose();
  });

  it('never reads the target back (no read-modify-write)', () => {
    const { w } = bits();
    w.store.set('RobotStatus', 0xff); // a foreign write onto the word
    w.store.set('Home', true);
    expect(w.store.get('RobotStatus')).toBe(8);
    w.dispose();
  });

  it('re-applies the word after a reset', () => {
    const { w } = bits();
    w.store.set('Home', true);
    w.store.set('RobotStatus', 0);
    w.reapply.reapplyAll();
    expect(w.store.get('RobotStatus')).toBe(8);
    w.dispose();
  });

  it('writes DWord bit 31 as the signed int32 0x80000000', () => {
    const w = makeConnectorWorld();
    const b = w.signal('Flag', 'PLCOutputBool');
    const word = w.signal('Word', 'PLCInputInt');
    w.connector('Bit31', { Mode: 'BitToWord', SourceBool: b, TargetInt: word, Bit: 31, Width: 'DWord' });
    w.store.set('Flag', true);
    expect(w.store.get('Word')).toBe(-2147483648);
    w.dispose();
  });

  it('the last bit leaving a live-controlled word clears it on release', () => {
    const { w, c0, c3 } = bits();
    w.store.setMany({ Gripper: true, Home: true });
    expect(w.store.get('RobotStatus')).toBe(9);
    setSignalLiveControlled('RobotStatus', true);
    w.store.set('RobotStatus', 1); // the external owner
    w.edit(c3, { Enabled: false });
    c0.dispose();
    expect(w.store.get('RobotStatus')).toBe(1); // nothing written while controlled
    setSignalLiveControlled('RobotStatus', false);
    expect(w.store.get('RobotStatus')).toBe(0); // the owed clear, once
    w.store.set('RobotStatus', 5);
    setSignalLiveControlled('RobotStatus', true);
    setSignalLiveControlled('RobotStatus', false);
    expect(w.store.get('RobotStatus')).toBe(5); // retired: no second clear
    w.dispose();
  });

  it('a bit joining again cancels the owed clear', () => {
    const { w, c0, c3 } = bits();
    w.store.set('Home', true);
    setSignalLiveControlled('RobotStatus', true);
    w.edit(c3, { Enabled: false });
    c0.dispose();
    w.edit(c3, { Enabled: true }); // joins a fresh aggregator
    setSignalLiveControlled('RobotStatus', false);
    expect(w.store.get('RobotStatus')).toBe(8);
    w.dispose();
  });

  it('a reconfigure or a catalog refresh publishes only the final word (no 9 → 1 → 9)', async () => {
    const { w, c3 } = bits();
    w.store.setMany({ Gripper: true, Home: true });
    const seen: unknown[] = [];
    const unsub = w.store.subscribe('RobotStatus', (v) => { seen.push(v); });
    w.edit(c3, { Bit: 3 }); // same configuration, re-applied
    w.signal('Unrelated', 'PLCInputBool'); // catalog change → refresh of every connector
    await Promise.resolve();
    expect(seen).toEqual([]);
    expect(w.store.get('RobotStatus')).toBe(9);
    unsub();
    w.dispose();
  });

  it('the owed clear does not reach a signal that replaced the word at its path', () => {
    const { w, c0, c3 } = bits();
    w.store.set('Home', true);
    setSignalLiveControlled('RobotStatus', true);
    c3.dispose();
    c0.dispose();
    w.store.register('Replacement', 'Cell/RobotStatus', 77, 'PLCInputInt');
    w.store.buildIndex();
    setSignalLiveControlled('RobotStatus', false);
    expect(w.store.getByPath('Cell/RobotStatus')).toBe(77);
    w.dispose();
  });

  it('a write during dispose that re-enters the check never revives the disposed bit', () => {
    const { w, c0, c3 } = bits();
    w.store.set('Gripper', true);
    expect(w.store.get('RobotStatus')).toBe(1);
    let reentered = false;
    const unsub = w.store.subscribe('RobotStatus', () => {
      if (reentered) return;
      reentered = true;
      w.edit(c3, { Bit: 3 }); // re-enters the network check
    });
    c0.dispose();
    expect(reentered).toBe(true);
    const agg = signalConnectorNetworkFor(w.store).getAggregator('Cell/RobotStatus');
    expect(agg ? [...agg.members].includes(c0) : false).toBe(false);
    setSignalLiveControlled('RobotStatus', true);
    setSignalLiveControlled('RobotStatus', false);
    expect(w.store.get('RobotStatus')).toBe(0); // Home is false; bit 0 is gone for good
    unsub();
    w.dispose();
  });
});

describe('SignalConnector — dispose and reconfigure', () => {
  it('writes nothing after dispose', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool');
    const dst = w.signal('B', 'PLCInputBool');
    const c = w.connector('Conn', { SourceBool: src, TargetBool: dst });
    c.dispose();
    w.store.set('A', true);
    expect(w.store.get('B')).toBe(false);
  });

  it('rewires on a configuration change (setField → reapplyConfig)', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCOutputBool');
    const b = w.signal('B', 'PLCOutputBool', true);
    const dst = w.signal('T', 'PLCInputBool');
    const c = w.connector('Conn', { SourceBool: a, TargetBool: dst });
    expect(w.store.get('T')).toBe(false);
    w.edit(c, { SourceBool: b });
    expect(w.store.get('T')).toBe(true);
    w.store.set('A', true);
    w.store.set('B', false);
    expect(w.store.get('T')).toBe(false);
    w.dispose();
  });
});

describe('ConnectSignal — Unity parity (F2)', () => {
  it('INT source onto a BOOL target is > 0; a negative INT is false', () => {
    const w = makeConnectorWorld();
    const src = w.signal('Count', 'PLCOutputInt');
    const dst = w.signal('Flag', 'PLCInputBool');
    const relay = w.connectSignal(dst, src);
    w.store.set('Count', 5);
    expect(w.store.get('Flag')).toBe(true);
    w.store.set('Count', -3);
    expect(w.store.get('Flag')).toBe(false);
    relay.dispose();
  });

  it('BOOL source onto an INT target is 1/0', () => {
    const w = makeConnectorWorld();
    const src = w.signal('On', 'PLCOutputBool');
    const dst = w.signal('OnInt', 'PLCInputInt');
    const relay = w.connectSignal(dst, src);
    w.store.set('On', true);
    expect(w.store.get('OnInt')).toBe(1);
    w.store.set('On', false);
    expect(w.store.get('OnInt')).toBe(0);
    relay.dispose();
  });

  it('INT onto INT stays raw', () => {
    const w = makeConnectorWorld();
    const src = w.signal('Count', 'PLCOutputInt');
    const dst = w.signal('Copy', 'PLCInputInt');
    const relay = w.connectSignal(dst, src);
    w.store.set('Count', 42);
    expect(w.store.get('Copy')).toBe(42);
    relay.dispose();
  });

  it('the resync after a live-control release converts too', () => {
    const w = makeConnectorWorld();
    const src = w.signal('Count', 'PLCOutputInt');
    const dst = w.signal('Flag', 'PLCInputBool');
    const relay = w.connectSignal(dst, src);
    setSignalLiveControlled('Flag', true);
    w.store.set('Flag', false);
    w.store.set('Count', 9);
    setSignalLiveControlled('Flag', false);
    expect(w.store.get('Flag')).toBe(true);
    relay.dispose();
  });
});
