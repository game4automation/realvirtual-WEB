// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-web-diagnostics-cleanup.test.ts — Cleanup contract (plan-253, F11 / §5.2):
 * - RVWebDiagnostics.dispose() unsubscribes + clears the debounce timer.
 * - WebDiagnosticsPlugin.onModelCleared() aborts ALL in-flight requests and
 *   empties the diagnosis store (clearModel() runs no dispose sweep).
 * - Falling edge removes the entry AND aborts the running request.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';
import { RVWebDiagnostics, __resetWebDiagnosticsWarnings } from '../src/core/engine/rv-web-diagnostics';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { setAppConfig } from '../src/core/rv-app-config';
import type { DiagnoseProvider, DiagnoseRequest, DiagnoseOptions } from '../src/plugins/diagnose/diagnose-provider';
import { WebDiagnosticsPlugin } from '@rv-private/plugins/diagnose/web-diagnostics-plugin';
import {
  getDiagnosisSnapshot,
  clearDiagnoses,
  __diagnosisAbortCount,
} from '@rv-private/plugins/diagnose/diagnosis-store';

type DiagnoseEvent = ViewerEvents['diagnose-request'];

// ─── Marker dispose ─────────────────────────────────────────────────────────

describe('RVWebDiagnostics.dispose()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetWebDiagnosticsWarnings();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('unsubscribes from the signal and clears the debounce timer', () => {
    const store = new SignalStore();
    const events = new EventEmitter<ViewerEvents>();
    const received: DiagnoseEvent[] = [];
    events.on('diagnose-request', (e) => received.push(e));
    store.register('Err', 'Err', false);
    const node = new Mesh(new BoxGeometry());
  new Scene().add(node);
    node.name = 'D1';
    const inst = new RVWebDiagnostics(node);
    inst.SignalBool = 'Err';
    inst.init({ signalStore: store, events } as never);

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    store.set('Err', true);              // opens the debounce window (pending timer)
    expect(received).toHaveLength(1);

    inst.dispose();
    expect(clearSpy).toHaveBeenCalled(); // debounce timer cleared

    store.set('Err', false);             // unsubscribed → no further events
    store.set('Err', true);
    expect(received).toHaveLength(1);
    clearSpy.mockRestore();
  });
});

// ─── Plugin cleanup ─────────────────────────────────────────────────────────

/** Fake provider: never resolves, records the abort signal it received. */
function makePendingProvider() {
  const signals: AbortSignal[] = [];
  const requests: DiagnoseRequest[] = [];
  const provider: DiagnoseProvider = {
    diagnose(req: DiagnoseRequest, options?: DiagnoseOptions) {
      requests.push(req);
      if (options?.signal) signals.push(options.signal);
      return new Promise(() => { /* pending forever */ });
    },
  };
  return { provider, signals, requests };
}

function makePlugin() {
  const events = new EventEmitter<ViewerEvents>();
  const viewer = {
    on: (ev: string, cb: (d: unknown) => void) => events.on(ev as never, cb as never),
  } as never;
  const plugin = new WebDiagnosticsPlugin();
  plugin.init(viewer);
  return { plugin, events };
}

describe('WebDiagnosticsPlugin cleanup', () => {
  beforeEach(() => {
    setAppConfig({});
    clearDiagnoses();
  });
  afterEach(() => {
    clearDiagnoses();
    setAppConfig({});
  });

  it('onModelCleared aborts in-flight requests and empties the store', () => {
    const { plugin, events } = makePlugin();
    const { provider, signals } = makePendingProvider();
    plugin.__setProviderForTesting(provider);

    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: true, errorId: 'E1' });
    expect(getDiagnosisSnapshot().entries).toHaveLength(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    expect(__diagnosisAbortCount()).toBe(1);

    plugin.onModelCleared();

    expect(signals[0].aborted).toBe(true);            // abort called (F11)
    expect(getDiagnosisSnapshot().entries).toHaveLength(0);
    expect(getDiagnosisSnapshot().openDialogPath).toBeNull();
    expect(__diagnosisAbortCount()).toBe(0);
    plugin.dispose();
  });

  it('falling edge removes the card/dialog and aborts the running request', () => {
    const { plugin, events } = makePlugin();
    const { provider, signals } = makePendingProvider();
    plugin.__setProviderForTesting(provider);

    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: true, errorId: 'E1' });
    expect(getDiagnosisSnapshot().entries).toHaveLength(1);
    expect(getDiagnosisSnapshot().openDialogPath).toBe('A/B'); // autoOpen default

    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: false, errorId: 'E1' });

    expect(getDiagnosisSnapshot().entries).toHaveLength(0);
    expect(getDiagnosisSnapshot().openDialogPath).toBeNull();
    expect(signals[0].aborted).toBe(true);
    plugin.dispose();
  });

  it('without diagnoseUrl and without injected provider the plugin stays passive (config gate)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { plugin, events } = makePlugin();

    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: true, errorId: 'E1' });
    events.emit('diagnose-request', { nodePath: 'A/C', errorActive: true, errorId: 'E2' });

    expect(getDiagnosisSnapshot().entries).toHaveLength(0);   // no call, no card
    expect(warnSpy).toHaveBeenCalledTimes(1);                  // warn-once
    warnSpy.mockRestore();
    plugin.dispose();
  });

  it('a newer rising edge aborts the previous request for the same node', () => {
    const { plugin, events } = makePlugin();
    const { provider, signals } = makePendingProvider();
    plugin.__setProviderForTesting(provider);

    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: true, errorId: 'E1', errorCode: 1 });
    events.emit('diagnose-request', { nodePath: 'A/B', errorActive: true, errorId: 'E1', errorCode: 2 });

    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);   // predecessor aborted
    expect(signals[1].aborted).toBe(false);
    expect(getDiagnosisSnapshot().entries).toHaveLength(1);
    plugin.dispose();
  });

  it('forwards event docHints and machineContext to the provider request', () => {
    const { plugin, events } = makePlugin();
    const { provider, requests } = makePendingProvider();
    plugin.__setProviderForTesting(provider);

    events.emit('diagnose-request', {
      nodePath: 'A/B',
      label: 'Motor overload',
      source: 'web-error',
      docHints: ['docs/motor.pdf'],
      machineContext: 'Node: A/B\nDrive: TargetSpeed=250',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      nodePath: 'A/B',
      label: 'Motor overload',
      docHints: ['docs/motor.pdf'],
      machineContext: 'Node: A/B\nDrive: TargetSpeed=250',
    });
    expect(requests[0]).not.toHaveProperty('source');
    plugin.dispose();
  });
});
