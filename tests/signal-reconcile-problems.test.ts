// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-589 test 9.6 — the reconcile report as PROBLEMS, and what triggers a run.
 *
 * Two contracts live here. First the grouping: ONE entry per (interface, category) with the count
 * in the title and the names in the detail, because one entry per signal is the Problems flood the
 * plan explicitly forbids (§5.2). Second the trigger: a PLACEMENT adds signal-carrying content
 * without a model load, so `layout-content-added` has to drive a run — that was the easiest thing
 * in the design to forget.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  fetchInterfaces,
  getConnectSnapshot,
  reconcileInterfaces,
  setServerUrl,
  _resetConnectStore,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';
import {
  clearAllProblems,
  getProblems,
  reportSignalReconcileProblems,
  signalReconcileProblemId,
  SIGNAL_RECONCILE_CODE,
  SIGNALS_CREATE_FROM_INTERFACE_COMMAND,
} from '../src/core/hmi/problems-store';
import { creatablePlcOnly, reconcileSignals } from '../src/core/import/rv-signal-reconcile';
import type { ModelPlcSignal } from '../src/core/import/rv-plc-automap';
import { ConnectPlugin } from '../src/plugins/connect-plugin';

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
}));

const IFACE: ConnectInterface = {
  id: 's7-cell1', type: 'S7', enabled: true,
  signals: [
    { name: 'Cell.Start', type: 'PLCOutputBool', protocolAddress: 'DB10.DBX4.1', record: false },
    { name: 'Cell.Ghost', type: 'PLCInputBool', protocolAddress: 'DB10.DBX4.2', record: false },
    { name: 'Cell.Label', type: 'PLCOutputText', protocolAddress: 'DB10.STRING0', record: false },
  ],
} as unknown as ConnectInterface;

const MODEL: ModelPlcSignal[] = [
  { name: 'Cell.Start', localName: 'Cell.Start', type: 'PLCOutputBool', path: 'Root/Start' },
  { name: 'Cell.Orphan', localName: 'Cell.Orphan', type: 'PLCInputBool', path: 'Root/Orphan' },
];

/** A registry stub that answers `collectModelPlcSignals` with `MODEL`. */
function registryStub(model: readonly ModelPlcSignal[]) {
  const byPath = new Map(model.map((m) => [m.path as string, m]));
  return {
    getAll<T>(type: string): { path: string; instance: T }[] {
      return model
        .filter((m) => m.type === type)
        .map((m) => ({ path: m.path as string, instance: { signalName: m.name } as unknown as T }));
    },
    getNode(path: string) {
      const sig = byPath.get(path);
      if (!sig) return null;
      return {
        name: path.slice(path.lastIndexOf('/') + 1),
        userData: { realvirtual: { [sig.type]: { Name: sig.localName } } },
      };
    },
  };
}

/** The viewer members the reconcile trigger path touches — nothing else is involved. */
function viewerStub(model: readonly ModelPlcSignal[]) {
  const listeners = new Map<string, ((data: unknown) => void)[]>();
  let catalogListeners: (() => void)[] = [];
  return {
    registry: registryStub(model),
    signalStore: {
      onCatalogChanged(cb: () => void) {
        catalogListeners.push(cb);
        return () => { catalogListeners = catalogListeners.filter((c) => c !== cb); };
      },
    },
    on(event: string, cb: (data: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
      return () => listeners.set(event, (listeners.get(event) ?? []).filter((c) => c !== cb));
    },
    emit(event: string, data?: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(data);
    },
    fireCatalogChanged() {
      for (const cb of catalogListeners) cb();
    },
  };
}

describe('reconcile → problems', () => {
  beforeEach(() => {
    _resetConnectStore();
    clearAllProblems();
    vi.restoreAllMocks();
    setServerUrl('http://gw.test:5100');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetConnectStore();
    clearAllProblems();
  });

  it('makes ONE entry per (interface, category) with the names in the detail', () => {
    const report = reconcileSignals(MODEL, IFACE, { addressRule: { signals: 'required' } } as never);
    reportSignalReconcileProblems(report, creatablePlcOnly(report).map((e) => e.name));

    const mine = getProblems().filter((p) => p.code === SIGNAL_RECONCILE_CODE);
    // plc-only (2: Ghost + the unsupported Label) and missing-in-plc (1) — `mapped` is no problem.
    expect(mine.map((p) => p.id).sort()).toEqual([
      signalReconcileProblemId('s7-cell1', 'missing-in-plc'),
      signalReconcileProblemId('s7-cell1', 'plc-only'),
    ].sort());
    const plcOnly = mine.find((p) => p.id.endsWith('plc-only'));
    expect(plcOnly?.title).toContain('2 signal(s)');
    expect(plcOnly?.detail).toContain('Cell.Ghost');
    expect(plcOnly?.detail).toContain('Cell.Label');
    const missing = mine.find((p) => p.id.endsWith('missing-in-plc'));
    expect(missing?.severity).toBe('warning');
    expect(missing?.detail).toContain('Cell.Orphan');
  });

  it('offers the creation command as the action, with only the creatable names', () => {
    const report = reconcileSignals(MODEL, IFACE, { addressRule: { signals: 'required' } } as never);
    reportSignalReconcileProblems(report, creatablePlcOnly(report).map((e) => e.name));

    const plcOnly = getProblems().find((p) => p.id.endsWith('plc-only'));
    expect(plcOnly?.action?.commandId).toBe(SIGNALS_CREATE_FROM_INTERFACE_COMMAND);
    // `Cell.Label` is a CONNECT Text signal — the model has no such component, so the action must
    // not promise to create it.
    expect(plcOnly?.action?.args).toEqual({ interfaceId: 's7-cell1', names: ['Cell.Ghost'] });
    // Nothing else offers an action: there is no repair for "the model has it, the PLC has not".
    expect(getProblems().find((p) => p.id.endsWith('missing-in-plc'))?.action).toBeUndefined();
  });

  it('clears a category that is no longer reported', () => {
    const report = reconcileSignals(MODEL, IFACE, { addressRule: { signals: 'required' } } as never);
    reportSignalReconcileProblems(report, creatablePlcOnly(report).map((e) => e.name));
    expect(getProblems().some((p) => p.id.endsWith('missing-in-plc'))).toBe(true);

    // The model signal got configured on the interface — the warning has to leave on its own.
    const fixed = {
      ...IFACE,
      signals: [...IFACE.signals,
        { name: 'Cell.Orphan', type: 'PLCInputBool', protocolAddress: 'DB10.DBX4.3', record: false }],
    } as unknown as ConnectInterface;
    const second = reconcileSignals(MODEL, fixed, { addressRule: { signals: 'required' } } as never);
    reportSignalReconcileProblems(second, creatablePlcOnly(second).map((e) => e.name));
    expect(getProblems().some((p) => p.id.endsWith('missing-in-plc'))).toBe(false);
  });

  it('reconcileInterfaces keeps one report per interface and prunes a deleted one', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/config/interfaces')) return json([IFACE]);
      return json({});
    });
    await fetchInterfaces();
    const reports = reconcileInterfaces(MODEL);
    expect(Object.keys(reports)).toEqual(['s7-cell1']);
    expect(getConnectSnapshot().reconcileReports?.['s7-cell1']?.counts.mapped).toBe(1);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/config/interfaces')) return json([]);
      return json({});
    });
    await fetchInterfaces();
    expect(Object.keys(reconcileInterfaces(MODEL))).toEqual([]);
  });
});

describe('reconcile triggers', () => {
  beforeEach(() => {
    _resetConnectStore();
    clearAllProblems();
    vi.restoreAllMocks();
    vi.useFakeTimers();
    setServerUrl('http://gw.test:5100');
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/config/interfaces')) return json([IFACE]);
      return json({});
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetConnectStore();
    clearAllProblems();
  });

  /**
   * The triggers are installed and driven directly, with the model-side members stubbed: booting
   * the whole plugin would also open its WebSocket value stream, which has nothing to do with the
   * report and would make this a connection test.
   */
  function armed(model: readonly ModelPlcSignal[]) {
    const viewer = viewerStub(model);
    const plugin = new ConnectPlugin();
    const internals = plugin as unknown as {
      viewer: unknown;
      installReconcileTriggers(v: unknown): void;
    };
    internals.viewer = viewer;
    internals.installReconcileTriggers(viewer);
    return { plugin, viewer };
  }

  it('runs after layout-content-added, once, and debounced', async () => {
    await fetchInterfaces();
    const { viewer } = armed(MODEL);

    viewer.emit('layout-content-added', {});
    viewer.emit('layout-content-added', {});
    // Still inside the quiet window: a placement burst must not produce two runs.
    vi.advanceTimersByTime(200);
    expect(getConnectSnapshot().reconcileReports?.['s7-cell1']).toBeUndefined();

    vi.advanceTimersByTime(60);
    const report = getConnectSnapshot().reconcileReports?.['s7-cell1'];
    expect(report?.counts.mapped).toBe(1);
    expect(report?.counts['plc-only']).toBe(2);
    expect(getProblems().filter((p) => p.code === SIGNAL_RECONCILE_CODE)).toHaveLength(2);
  });

  it('runs after a signal catalog change (an editor edit)', async () => {
    await fetchInterfaces();
    const { viewer } = armed(MODEL);

    viewer.fireCatalogChanged();
    vi.advanceTimersByTime(260);
    expect(getConnectSnapshot().reconcileReports?.['s7-cell1']?.counts.mapped).toBe(1);
  });
});
