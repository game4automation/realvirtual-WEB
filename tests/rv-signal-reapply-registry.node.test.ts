// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalReapplyRegistry — pure logic, no Three.js, no DOM (plan-427 §9.1/§9.9).
 * Node suite: seconds instead of a browser boot.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SignalReapplyRegistry,
  setActiveSignalReapplyRegistry,
  getActiveSignalReapplyRegistry,
} from '../src/core/engine/rv-signal-reapply-registry';

describe('SignalReapplyRegistry', () => {
  it('reapplyAll invokes every registered slot with the replay context', () => {
    const reg = new SignalReapplyRegistry();
    const a = vi.fn();
    const b = vi.fn();
    reg.register('S1', a);
    reg.register('S2', b);

    reg.reapplyAll();

    expect(a).toHaveBeenCalledWith({ replay: true });
    expect(b).toHaveBeenCalledWith({ replay: true });
  });

  it('invokes slots in registration order', () => {
    const reg = new SignalReapplyRegistry();
    const order: string[] = [];
    reg.register('S1', () => order.push('S1'));
    reg.register('S2', () => order.push('S2'));
    reg.register('S3', () => order.push('S3'));

    reg.reapplyAll();

    expect(order).toEqual(['S1', 'S2', 'S3']);
  });

  it('the unregister handle removes exactly one slot', () => {
    const reg = new SignalReapplyRegistry();
    const kept = vi.fn();
    const dropped = vi.fn();
    reg.register('Kept', kept);
    const off = reg.register('Dropped', dropped);

    expect(reg.size).toBe(2);
    off();
    expect(reg.size).toBe(1);

    reg.reapplyAll();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('the unregister handle is idempotent', () => {
    const reg = new SignalReapplyRegistry();
    const off = reg.register('S1', vi.fn());
    off();
    off();
    expect(reg.size).toBe(0);
  });

  it('two slots on the SAME address are independent', () => {
    const reg = new SignalReapplyRegistry();
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = reg.register('Shared', first);
    reg.register('Shared', second);

    offFirst();
    reg.reapplyAll();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clear() drops all slots', () => {
    const reg = new SignalReapplyRegistry();
    const apply = vi.fn();
    reg.register('S1', apply);
    reg.register('S2', apply);

    reg.clear();

    expect(reg.size).toBe(0);
    reg.reapplyAll();
    expect(apply).not.toHaveBeenCalled();
  });

  it('reapplyAll on an empty registry is a no-op', () => {
    const reg = new SignalReapplyRegistry();
    expect(() => reg.reapplyAll()).not.toThrow();
  });

  // ── Error isolation (F11) ───────────────────────────────────────────────

  it('a throwing setter does not stop reapplyAll for later slots', () => {
    const reg = new SignalReapplyRegistry();
    const later = vi.fn();
    reg.register('Boom', () => { throw new Error('component blew up'); });
    reg.register('Later', later);

    expect(() => reg.reapplyAll()).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('a throwing slot stays registered — the next pass tries it again', () => {
    const reg = new SignalReapplyRegistry();
    const boom = vi.fn(() => { throw new Error('nope'); });
    reg.register('Boom', boom);

    reg.reapplyAll();
    reg.reapplyAll();

    expect(boom).toHaveBeenCalledTimes(2);
    expect(reg.size).toBe(1);
  });

  // ── Snapshot iteration (F11) ────────────────────────────────────────────

  it('a slot registered DURING reapplyAll is not invoked in the same pass', () => {
    const reg = new SignalReapplyRegistry();
    const late = vi.fn();
    reg.register('S1', () => { reg.register('Late', late); });

    reg.reapplyAll();
    expect(late).not.toHaveBeenCalled();

    reg.reapplyAll();
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('unregistering DURING reapplyAll is safe (snapshot iteration)', () => {
    const reg = new SignalReapplyRegistry();
    const victim = vi.fn();
    let offVictim: (() => void) | null = null;
    reg.register('S1', () => { offVictim?.(); });
    offVictim = reg.register('Victim', victim);

    expect(() => reg.reapplyAll()).not.toThrow();
    // Snapshot semantics: the already-captured slot still runs this pass …
    expect(victim).toHaveBeenCalledTimes(1);
    // … but it is gone from the registry for the next one.
    expect(reg.size).toBe(1);
    reg.reapplyAll();
    expect(victim).toHaveBeenCalledTimes(1);
  });

  it('clear() DURING reapplyAll does not abort the running pass', () => {
    const reg = new SignalReapplyRegistry();
    const later = vi.fn();
    reg.register('S1', () => { reg.clear(); });
    reg.register('S2', later);

    reg.reapplyAll();

    expect(later).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(0);
  });

  // ── Module slot ─────────────────────────────────────────────────────────

  it('the module slot hands back exactly what was installed', () => {
    const reg = new SignalReapplyRegistry();
    setActiveSignalReapplyRegistry(reg);
    expect(getActiveSignalReapplyRegistry()).toBe(reg);
    setActiveSignalReapplyRegistry(null);
    expect(getActiveSignalReapplyRegistry()).toBeNull();
  });
});
