// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-diagnostics-debounce.test.ts — Leading-edge debounce (plan-253, F10).
 * Continuous signal flutter must produce exactly ONE rising-edge call (a
 * trailing debounce would produce zero). Template: use-throttled-signal.test.ts
 * (fake timers).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import {
  RVWebDiagnostics,
  DIAGNOSE_DEBOUNCE_MS,
  __resetWebDiagnosticsWarnings,
} from '../src/core/engine/rv-web-diagnostics';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { createLeadingEdgeDebounce } from '../src/plugins/diagnose/debounce';

type DiagnoseEvent = ViewerEvents['diagnose-request'];

function setup() {
  const store = new SignalStore();
  const events = new EventEmitter<ViewerEvents>();
  const received: DiagnoseEvent[] = [];
  events.on('diagnose-request', (e) => received.push(e));
  store.register('Err', 'Err', false);
  const node = new Mesh(new BoxGeometry());
  new Scene().add(node);
  node.name = 'FlutterNode';
  const inst = new RVWebDiagnostics(node);
  inst.SignalBool = 'Err';
  inst.init({ signalStore: store, events } as never);
  return { inst, store, received };
}

describe('RVWebDiagnostics leading-edge debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetWebDiagnosticsWarnings();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('continuous flutter inside the window → exactly one rising call (leading edge)', () => {
    const { store, received } = setup();
    // 0→1→0→1→0→1 rapid flutter (all inside the 1 s window)
    for (let i = 0; i < 3; i++) {
      store.set('Err', true);
      vi.advanceTimersByTime(50);
      store.set('Err', false);
      vi.advanceTimersByTime(50);
    }
    const rising = received.filter((e) => e.errorActive === true);
    const falling = received.filter((e) => e.errorActive === false);
    expect(rising).toHaveLength(1);       // leading edge fired immediately, rest suppressed
    expect(falling).toHaveLength(3);      // falling edges are never debounced (F11)
  });

  it('after the window elapses the next rising edge fires again', () => {
    const { store, received } = setup();
    store.set('Err', true);
    store.set('Err', false);
    vi.advanceTimersByTime(DIAGNOSE_DEBOUNCE_MS + 1);
    store.set('Err', true);
    const rising = received.filter((e) => e.errorActive === true);
    expect(rising).toHaveLength(2);
  });

  it('int flutter between error codes inside the window → one call', () => {
    const store = new SignalStore();
    const events = new EventEmitter<ViewerEvents>();
    const received: DiagnoseEvent[] = [];
    events.on('diagnose-request', (e) => received.push(e));
    store.register('ErrCode', 'ErrCode', 0);
    const node = new Mesh(new BoxGeometry());
  new Scene().add(node);
    node.name = 'IntFlutter';
    const inst = new RVWebDiagnostics(node);
    inst.SignalInt = 'ErrCode';
    inst.init({ signalStore: store, events } as never);

    store.set('ErrCode', 320);
    vi.advanceTimersByTime(10);
    store.set('ErrCode', 321);           // new code inside window → suppressed
    vi.advanceTimersByTime(10);
    store.set('ErrCode', 322);
    const rising = received.filter((e) => e.errorActive === true);
    expect(rising).toHaveLength(1);
    expect(rising[0].errorCode).toBe(320);
  });

  describe('createLeadingEdgeDebounce (unit)', () => {
    it('first call fires, calls inside the window are suppressed, window reopens', () => {
      const d = createLeadingEdgeDebounce(1000);
      expect(d.shouldFire()).toBe(true);
      expect(d.shouldFire()).toBe(false);
      vi.advanceTimersByTime(999);
      expect(d.shouldFire()).toBe(false);
      vi.advanceTimersByTime(2);
      expect(d.shouldFire()).toBe(true);
      d.dispose();
    });

    it('dispose clears the pending timer (clearTimeout) and resets suppression', () => {
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      const d = createLeadingEdgeDebounce(1000);
      expect(d.shouldFire()).toBe(true);   // opens window → pending timer
      d.dispose();
      expect(clearSpy).toHaveBeenCalled();
      expect(d.shouldFire()).toBe(true);   // suppression reset after dispose
      d.dispose();
      clearSpy.mockRestore();
    });
  });
});
