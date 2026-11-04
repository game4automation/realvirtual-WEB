// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2227 FA5 — every SignalConnector problem code, and the re-check after a
 * document change (slot, mode, enabled, undo = the previous values restored):
 * unresolved, slot-mismatch (warning, still writes), direction, fan-in (incl.
 * against ConnectSignal and the BitToWord exceptions), cycle, width, nonfinite.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { makeConnectorWorld } from './helpers/signal-connector-rig';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';
import { SIGNAL_CONNECTOR_PROBLEM_CODES as CODES } from '../src/core/engine/rv-signal-connector';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';

beforeEach(() => { resetSlotAuthority(); resetProblemsForTests(); });
afterEach(() => { resetSlotAuthority(); resetProblemsForTests(); });

function codes(): string[] {
  return getProblems().map((p) => p.code).filter((c) => c.startsWith('signal-connector-')).sort();
}

function problemsOf(code: string) {
  return getProblems().filter((p) => p.code === code);
}

describe('SignalConnector problems', () => {
  it('signal-connector-unresolved: an empty active slot and an unresolvable reference', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    w.connector('Empty', { Mode: 'Copy', SourceBool: src });
    w.connector('Gone', { Mode: 'IntToBool', unresolved: { SourceInt: 'Cell/Renamed' }, TargetBool: w.signal('T', 'PLCInputBool') });
    const list = problemsOf(CODES.unresolved);
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.detail).join('\n')).toContain('TargetBool is empty');
    expect(list.map((p) => p.detail).join('\n')).toContain('"Cell/Renamed" does not resolve');
    expect(list.every((p) => p.severity === 'error')).toBe(true);
    w.dispose();
  });

  it('signal-connector-slot-mismatch is a warning and the connector still writes', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const dst = w.signal('B', 'PLCInputBool');
    const stray = w.signal('C', 'PLCInputInt');
    const c = w.connector('Conn', { Mode: 'Copy', SourceBool: src, TargetBool: dst, TargetInt: stray });
    const [p] = problemsOf(CODES.slotMismatch);
    expect(p.severity).toBe('warning');
    expect(p.detail).toContain('TargetInt');
    expect(c.isActive).toBe(true);
    expect(w.store.get('B')).toBe(true);
    w.dispose();
  });

  it('signal-connector-direction: the target is a PLC output', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const wrong = w.signal('B', 'PLCOutputBool');
    const c = w.connector('Conn', { SourceBool: src, TargetBool: wrong });
    expect(codes()).toEqual([CODES.direction]);
    expect(c.isActive).toBe(false);
    expect(w.store.get('B')).toBe(false);
    w.dispose();
  });

  it('signal-connector-width: Bit outside the width', () => {
    const w = makeConnectorWorld();
    w.connector('Conn', {
      Mode: 'BitFromWord', SourceInt: w.signal('W', 'PLCOutputInt'), TargetBool: w.signal('B', 'PLCInputBool'),
      Bit: 16, Width: 'Word',
    });
    expect(codes()).toEqual([CODES.width]);
    w.dispose();
  });

  it('signal-connector-fan-in: two connectors on one target block each other; fixing one releases the other', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCOutputBool', true);
    const b = w.signal('B', 'PLCOutputBool', false);
    const t = w.signal('T', 'PLCInputBool');
    const c1 = w.connector('C1', { SourceBool: a, TargetBool: t });
    expect(w.store.get('T')).toBe(true);
    const c2 = w.connector('C2', { SourceBool: b, TargetBool: t });
    expect(problemsOf(CODES.fanIn)).toHaveLength(2);
    expect(c1.isActive).toBe(false);
    expect(c2.isActive).toBe(false);
    // Re-check after a document edit: disable C2 → C1 writes again.
    w.edit(c2, { Enabled: false });
    expect(problemsOf(CODES.fanIn)).toHaveLength(0);
    expect(c1.isActive).toBe(true);
    w.store.set('A', false);
    expect(w.store.get('T')).toBe(false);
    // Undo the edit: the conflict is back.
    w.edit(c2, { Enabled: true });
    expect(problemsOf(CODES.fanIn)).toHaveLength(2);
    w.dispose();
  });

  it('signal-connector-fan-in also against a ConnectSignal', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCOutputBool');
    const b = w.signal('B', 'PLCOutputBool');
    const t = w.signal('T', 'PLCInputBool');
    const c = w.connector('C1', { SourceBool: a, TargetBool: t });
    const relay = w.connectSignal(t, b);
    expect(problemsOf(CODES.fanIn)).toHaveLength(1);
    expect(problemsOf(CODES.fanIn)[0].detail).toContain('ConnectSignal');
    expect(c.isActive).toBe(false);
    relay.dispose();
    expect(problemsOf(CODES.fanIn)).toHaveLength(0);
    expect(c.isActive).toBe(true);
    w.dispose();
  });

  it('BitToWord: different bits and sources share a word; same bit, same source or a mixed writer is fan-in', () => {
    const w = makeConnectorWorld();
    const s0 = w.signal('S0', 'PLCOutputBool');
    const s1 = w.signal('S1', 'PLCOutputBool');
    const word = w.signal('Word', 'PLCInputInt');
    w.connector('B0', { Mode: 'BitToWord', SourceBool: s0, TargetInt: word, Bit: 0 });
    const b1 = w.connector('B1', { Mode: 'BitToWord', SourceBool: s1, TargetInt: word, Bit: 1 });
    expect(codes()).toEqual([]);

    w.edit(b1, { Bit: 0 }); // same bit twice
    expect(problemsOf(CODES.fanIn)).toHaveLength(2);
    w.edit(b1, { Bit: 1, SourceBool: s0 }); // same source onto two bits
    expect(problemsOf(CODES.fanIn)).toHaveLength(2);
    w.edit(b1, { SourceBool: s1 }); // back to valid
    expect(codes()).toEqual([]);

    w.connector('Copy', { Mode: 'BoolToInt', SourceBool: w.signal('S2', 'PLCOutputBool'), TargetInt: word });
    expect(problemsOf(CODES.fanIn)).toHaveLength(3);
    w.dispose();
  });

  it('signal-connector-cycle: A → B → A', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCInputBool');
    const b = w.signal('B', 'PLCInputBool');
    const ab = w.connector('AB', { SourceBool: a, TargetBool: b });
    expect(codes()).toEqual([]);
    const ba = w.connector('BA', { SourceBool: b, TargetBool: a });
    expect(problemsOf(CODES.cycle)).toHaveLength(2);
    expect(ab.isActive).toBe(false);
    expect(ba.isActive).toBe(false);
    ba.dispose();
    expect(problemsOf(CODES.cycle)).toHaveLength(0);
    expect(ab.isActive).toBe(true);
    w.dispose();
  });

  it('signal-connector-cycle through a BitFromWord / BitToWord pair', () => {
    const w = makeConnectorWorld();
    const word = w.signal('Word', 'PLCInputInt');
    const flag = w.signal('Flag', 'PLCInputBool');
    w.connector('Read', { Mode: 'BitFromWord', SourceInt: word, TargetBool: flag, Bit: 2 });
    w.connector('Write', { Mode: 'BitToWord', SourceBool: flag, TargetInt: word, Bit: 2 });
    expect(problemsOf(CODES.cycle)).toHaveLength(2);
    w.dispose();
  });

  it('signal-connector-nonfinite: a REAL overflow is not written and the problem clears on the next finite value', () => {
    const w = makeConnectorWorld();
    const src = w.signal('X', 'PLCOutputFloat', 1);
    const dst = w.signal('Y', 'PLCInputFloat');
    const c = w.connector('Conn', { Mode: 'Scale', SourceFloat: src, TargetFloat: dst, Factor: 2 });
    expect(w.store.get('Y')).toBe(2);
    w.store.set('X', 1e39);
    expect(w.store.get('Y')).toBe(2);
    const [p] = problemsOf(CODES.nonfinite);
    expect(p.severity).toBe('warning');
    expect(c.isActive).toBe(true);
    w.store.set('X', 3);
    expect(w.store.get('Y')).toBe(6);
    expect(problemsOf(CODES.nonfinite)).toHaveLength(0);
    w.dispose();
  });

  it('a mode change re-checks: unresolved appears and disappears with the slots', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const dst = w.signal('B', 'PLCInputBool');
    const word = w.signal('W', 'PLCInputInt');
    const c = w.connector('Conn', { Mode: 'Copy', SourceBool: src, TargetBool: dst });
    w.edit(c, { Mode: 'BoolToInt' });
    // TargetBool is now inactive (warning) and TargetInt empty (error).
    expect(codes()).toEqual([CODES.slotMismatch, CODES.unresolved].sort());
    w.edit(c, { TargetBool: null, TargetInt: word });
    expect(codes()).toEqual([]);
    expect(w.store.get('W')).toBe(1);
    // Undo both edits: back to the original state, no problems.
    w.edit(c, { Mode: 'Copy', TargetBool: dst, TargetInt: null });
    expect(codes()).toEqual([]);
    expect(c.isActive).toBe(true);
    w.dispose();
  });

  it('dispose clears the connector problems', () => {
    const w = makeConnectorWorld();
    const c = w.connector('Conn', { Mode: 'Copy' });
    expect(codes()).toEqual([CODES.unresolved]);
    c.dispose();
    expect(codes()).toEqual([]);
  });
});

describe('SignalConnector problems — review findings (Codex, plan-2227 Phase 1)', () => {
  it('a slot that names a signal of the wrong kind, or no signal at all, is unresolved', () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const intTarget = w.signal('N', 'PLCInputInt');
    const c1 = w.connector('WrongKind', { SourceBool: src, TargetBool: intTarget });
    const geometry = new Object3D();
    geometry.name = 'Housing';
    w.root.add(geometry);
    w.registry.registerNode('Cell/Housing', geometry);
    const c2 = w.connector('NoSignal', { SourceBool: src, TargetBool: 'Cell/Housing' });
    const details = problemsOf(CODES.unresolved).map((p) => p.detail).join('\n');
    expect(details).toContain('is a PLCInputInt, the slot takes a BOOL signal');
    expect(details).toContain('"Cell/Housing" is not a registered signal');
    expect(c1.isActive).toBe(false);
    expect(c2.isActive).toBe(false);
    expect(w.store.get('N')).toBe(0);
    w.dispose();
  });

  it('a slot the loader could not resolve is resolved again once its signal exists', async () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const c = w.connector('Conn', { SourceBool: src, TargetBool: 'Cell/Later' }, { unresolvedAtLoad: ['TargetBool'] });
    expect(c.TargetBool).toBeNull();
    expect(c.isActive).toBe(false);
    w.signal('Later', 'PLCInputBool');
    await Promise.resolve();
    expect(c.TargetBool).toBe('Cell/Later');
    expect(c.isActive).toBe(true);
    expect(w.store.get('Later')).toBe(true);
    w.dispose();
  });

  it('a newer check started while verdicts are applied wins (no stale verdict)', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCOutputBool', true);
    const t1 = w.signal('T1', 'PLCInputBool');
    const b = w.signal('B', 'PLCOutputBool', true);
    const t2 = w.signal('T2', 'PLCInputBool');
    const c1 = w.connector('C1', { Enabled: false, SourceBool: a, TargetBool: t1 });
    const c2 = w.connector('C2', { SourceBool: b, TargetBool: t2 });
    // When C1 starts writing T1, someone adds a second writer onto T2.
    let added = false;
    const unsub = w.store.subscribe('T1', () => {
      if (added) return;
      added = true;
      w.connector('C3', { SourceBool: w.signal('C', 'PLCOutputBool'), TargetBool: t2 });
    });
    w.edit(c1, { Enabled: true });
    expect(added).toBe(true);
    expect(c1.isActive).toBe(true);
    expect(problemsOf(CODES.fanIn)).toHaveLength(2);
    expect(c2.isActive).toBe(false);
    unsub();
    w.dispose();
  });

  it('re-checks after a signal-catalog change: a late target wires up, a re-typed target is refused', async () => {
    const w = makeConnectorWorld();
    const src = w.signal('A', 'PLCOutputBool', true);
    const c = w.connector('Conn', { SourceBool: src, TargetBool: 'Cell/Late' });
    expect(c.isActive).toBe(false);
    w.signal('Late', 'PLCInputBool');
    await Promise.resolve();
    expect(c.isActive).toBe(true);
    expect(w.store.get('Late')).toBe(true);

    // The target becomes a PLC output (the editor re-types it): refused after the change.
    w.store.register('Late', 'Cell/Late', false, 'PLCOutputBool');
    w.store.notifyCatalogChanged({ registered: ['Late'], released: [], removed: [] } as never);
    await Promise.resolve();
    expect(problemsOf(CODES.direction)).toHaveLength(1);
    expect(c.isActive).toBe(false);
    w.dispose();
  });

  it('a non-finite warning dropped by a graph error is reported again after recovery', () => {
    const w = makeConnectorWorld();
    const src = w.signal('X', 'PLCOutputFloat', 1);
    const dst = w.signal('Y', 'PLCInputFloat');
    w.connector('Conn', { Mode: 'Copy', SourceFloat: src, TargetFloat: dst });
    w.store.set('X', 1e39);
    expect(problemsOf(CODES.nonfinite)).toHaveLength(1);
    const other = w.connector('Other', { Mode: 'Copy', SourceFloat: w.signal('Z', 'PLCOutputFloat'), TargetFloat: dst });
    expect(problemsOf(CODES.nonfinite)).toHaveLength(0);
    other.dispose();
    w.store.set('X', 2);
    w.store.set('X', 1e39);
    expect(problemsOf(CODES.nonfinite)).toHaveLength(1);
    w.dispose();
  });

  it('disposing a ConnectSignal that closed a cycle releases the connector without feedback', () => {
    const w = makeConnectorWorld();
    const a = w.signal('A', 'PLCInputBool');
    const b = w.signal('B', 'PLCInputBool');
    const c = w.connector('AB', { Mode: 'Copy', Invert: true, SourceBool: a, TargetBool: b });
    const relay = w.connectSignal(a, b); // B → A closes the inverting loop
    expect(problemsOf(CODES.cycle)).toHaveLength(1);
    w.store.set('B', true);
    expect(() => relay.dispose()).not.toThrow();
    expect(c.isActive).toBe(true);
    expect(w.store.get('B')).toBe(!w.store.get('A'));
    // The relay is gone for good: a change of B no longer reaches A.
    const aBefore = w.store.get('A');
    w.store.set('A', !aBefore);
    expect(w.store.get('B')).toBe(aBefore);
    w.dispose();
  });
});
