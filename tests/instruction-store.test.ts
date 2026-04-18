// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tests for instruction-store — the pub/sub core of the Generic Instruction Overlay.
 *
 * Covers public API (showInstruction, hideInstruction, clearBySource,
 * getInstructions, subscribeInstructions, useInstructions) and the internal
 * validation + snapshot-cache invariants that make useSyncExternalStore
 * correct in React 18 Strict Mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  showInstruction,
  hideInstruction,
  clearBySource,
  getInstructions,
  subscribeInstructions,
  normalizeInstruction,
  _resetStoreForTests,
} from '../src/core/hmi/instruction-store';

describe('instruction-store', () => {
  beforeEach(() => { _resetStoreForTests(); });
  afterEach(() => { _resetStoreForTests(); });

  // ─── Core: showInstruction / hideInstruction / snapshots ─────────────

  it('showInstruction adds to store and notifies listeners', () => {
    const listener = vi.fn();
    const off = subscribeInstructions(listener);
    showInstruction({ id: 't1', text: 'hello', anchor: { kind: 'canvas-center' }, source: 'test' });
    expect(getInstructions()).toHaveLength(1);
    expect(listener).toHaveBeenCalled();
    off();
  });

  it('same id replaces prior instruction (Map.set semantics)', () => {
    showInstruction({ id: 'x', text: 'a', anchor: { kind: 'canvas-center' }, source: 'test' });
    showInstruction({ id: 'x', text: 'b', anchor: { kind: 'canvas-center' }, source: 'test' });
    expect(getInstructions()).toHaveLength(1);
    expect(getInstructions()[0].text).toBe('b');
  });

  it('hideInstruction removes by id', () => {
    showInstruction({ id: 'x', text: 'a', anchor: { kind: 'canvas-center' }, source: 'test' });
    hideInstruction('x');
    expect(getInstructions()).toHaveLength(0);
  });

  it('hideInstruction on missing id is a no-op (no notify)', () => {
    const listener = vi.fn();
    const off = subscribeInstructions(listener);
    hideInstruction('missing');
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('clearBySource removes all with matching source', () => {
    showInstruction({ id: 'a', text: 'a', anchor: { kind: 'canvas-center' }, source: 'kiosk' });
    showInstruction({ id: 'b', text: 'b', anchor: { kind: 'canvas-center' }, source: 'maintenance' });
    showInstruction({ id: 'c', text: 'c', anchor: { kind: 'canvas-center' }, source: 'kiosk' });
    clearBySource('kiosk');
    expect(getInstructions().map(i => i.id)).toEqual(['b']);
  });

  it('getInstructions returns reference-stable snapshot between calls', () => {
    showInstruction({ id: 'a', text: 'x', anchor: { kind: 'canvas-center' }, source: 'test' });
    const snap1 = getInstructions();
    const snap2 = getInstructions();
    expect(snap1).toBe(snap2);            // CRITICAL: same reference
    showInstruction({ id: 'b', text: 'y', anchor: { kind: 'canvas-center' }, source: 'test' });
    const snap3 = getInstructions();
    expect(snap3).not.toBe(snap1);        // different reference after state change
  });

  it('sorts by priority descending', () => {
    showInstruction({ id: 'low',  text: 'l', anchor: { kind: 'canvas-center' }, priority: 1,  source: 'test' });
    showInstruction({ id: 'high', text: 'h', anchor: { kind: 'canvas-center' }, priority: 10, source: 'test' });
    const ids = getInstructions().map(i => i.id);
    expect(ids).toEqual(['high', 'low']);
  });

  it('negative priority values are supported (sorted last)', () => {
    showInstruction({ id: 'neg', text: 'n', anchor: { kind: 'canvas-center' }, priority: -1, source: 'test' });
    showInstruction({ id: 'zero', text: 'z', anchor: { kind: 'canvas-center' }, priority: 0, source: 'test' });
    expect(getInstructions().map(i => i.id)).toEqual(['zero', 'neg']);
  });

  // ─── Auto-clear timer ─────────────────────────────────────────────────

  it('autoClearAfterMs dismisses after timeout', async () => {
    showInstruction({ id: 't', text: 'fading', anchor: { kind: 'canvas-center' }, source: 'test', autoClearAfterMs: 50 });
    expect(getInstructions()).toHaveLength(1);
    await new Promise(r => setTimeout(r, 80));
    expect(getInstructions()).toHaveLength(0);
  });

  it('timer cleaned up on hideInstruction before autoClear fires', async () => {
    showInstruction({ id: 't', text: 'x', anchor: { kind: 'canvas-center' }, source: 'test', autoClearAfterMs: 500 });
    hideInstruction('t');
    await new Promise(r => setTimeout(r, 20));
    expect(getInstructions()).toHaveLength(0);   // no orphaned timer fire
  });

  it('timer replaced when same id re-shown with new autoClearAfterMs', async () => {
    showInstruction({ id: 'x', text: 'a', anchor: { kind: 'canvas-center' }, source: 'test', autoClearAfterMs: 30 });
    await new Promise(r => setTimeout(r, 10));
    showInstruction({ id: 'x', text: 'b', anchor: { kind: 'canvas-center' }, source: 'test', autoClearAfterMs: 200 });
    await new Promise(r => setTimeout(r, 50));   // 60 ms total — old timer would have fired at 30
    expect(getInstructions()).toHaveLength(1);   // still alive thanks to replacement
    await new Promise(r => setTimeout(r, 200));  // 260 ms — new timer (200 from re-show) fires
    expect(getInstructions()).toHaveLength(0);
  });

  // ─── Hard cap eviction ────────────────────────────────────────────────

  it('hard cap of 20 active instructions — evicts lowest-priority', () => {
    for (let i = 0; i < 21; i++) {
      showInstruction({
        id: `x${i}`,
        text: 'x',
        anchor: { kind: 'canvas-center' },
        priority: i,
        source: 'test',
      });
    }
    expect(getInstructions()).toHaveLength(20);
    // Lowest priority (x0) was evicted
    expect(getInstructions().find(i => i.id === 'x0')).toBeUndefined();
  });

  // ─── Validation ───────────────────────────────────────────────────────

  it('rejects invalid payload (missing id)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    showInstruction({ text: 'no id', anchor: { kind: 'canvas-center' } } as never);
    expect(getInstructions()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('rejects invalid payload (empty id)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    showInstruction({ id: '', text: 'x', anchor: { kind: 'canvas-center' } } as never);
    expect(getInstructions()).toHaveLength(0);
    warn.mockRestore();
  });

  it('rejects invalid payload (missing text AND content)', () => {
    showInstruction({ id: 'x', anchor: { kind: 'canvas-center' } } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('rejects invalid anchor.kind (typo)', () => {
    showInstruction({ id: 'x', text: 't', anchor: { kind: 'nod' } } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('rejects invalid edge direction', () => {
    showInstruction({ id: 'x', text: 't', anchor: { kind: 'edge', edge: 'middle' } } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('rejects node anchor with empty path', () => {
    showInstruction({ id: 'x', text: 't', anchor: { kind: 'node', path: '' } } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('rejects screen anchor with NaN coords', () => {
    showInstruction({ id: 'x', text: 't', anchor: { kind: 'screen', x: NaN, y: 0 } } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('rejects invalid style value', () => {
    showInstruction({ id: 'x', text: 't', anchor: { kind: 'canvas-center' }, style: 'huge' } as never);
    expect(getInstructions()).toHaveLength(0);
  });

  it('invalid payloads logged only once per id (no spam)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = { id: 'bad', text: 't', anchor: { kind: 'nod' } } as never;
    for (let i = 0; i < 10; i++) showInstruction(bad);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('normalizeInstruction returns null for malformed anchor kind', () => {
    expect(normalizeInstruction({ id: 'x', text: 't', anchor: { kind: 'wrong' } } as never)).toBeNull();
  });

  it('normalizeInstruction fills default style=info', () => {
    const n = normalizeInstruction({ id: 'x', text: 't', anchor: { kind: 'canvas-center' } });
    expect(n?.style).toBe('info');
  });

  // ─── Subscribe / unsubscribe ──────────────────────────────────────────

  it('subscribe returns unsub function that actually detaches', () => {
    const listener = vi.fn();
    const off = subscribeInstructions(listener);
    showInstruction({ id: 'a', text: 'x', anchor: { kind: 'canvas-center' }, source: 'test' });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    showInstruction({ id: 'b', text: 'y', anchor: { kind: 'canvas-center' }, source: 'test' });
    expect(listener).toHaveBeenCalledTimes(1);   // no further invocations
  });

  it('multiple subscribers all fire; one throwing does not affect others', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const l1 = vi.fn();
    const l2 = vi.fn(() => { throw new Error('boom'); });
    const l3 = vi.fn();
    const o1 = subscribeInstructions(l1);
    const o2 = subscribeInstructions(l2);
    const o3 = subscribeInstructions(l3);
    showInstruction({ id: 'a', text: 'x', anchor: { kind: 'canvas-center' }, source: 'test' });
    expect(l1).toHaveBeenCalled();
    expect(l2).toHaveBeenCalled();
    expect(l3).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    o1(); o2(); o3();
    err.mockRestore();
  });

  // ─── ID collision across sources ──────────────────────────────────────

  it('id collision across sources: second show REPLACES (not stacks)', () => {
    showInstruction({ id: 'step', text: 'A', anchor: { kind: 'canvas-center' }, source: 'plugin-a' });
    showInstruction({ id: 'step', text: 'B', anchor: { kind: 'canvas-center' }, source: 'plugin-b' });
    expect(getInstructions()).toHaveLength(1);
    expect(getInstructions()[0].text).toBe('B');
    expect(getInstructions()[0].source).toBe('plugin-b');
    clearBySource('plugin-a');
    expect(getInstructions()).toHaveLength(1);       // plugin-a had nothing
    clearBySource('plugin-b');
    expect(getInstructions()).toHaveLength(0);
  });

  // ─── Production guard ────────────────────────────────────────────────

  it('_resetStoreForTests throws when import.meta.env.PROD is true', () => {
    vi.stubEnv('PROD', true);
    expect(() => _resetStoreForTests()).toThrow(/production/);
    vi.unstubAllEnvs();
  });

  it('_resetStoreForTests does NOT throw in test env', () => {
    vi.stubEnv('PROD', false);
    expect(() => _resetStoreForTests()).not.toThrow();
    vi.unstubAllEnvs();
  });
});
