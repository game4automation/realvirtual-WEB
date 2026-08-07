// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-matrix-panel-render (plan-265 §9.6 + §9.8) — F1/F3/F5/F14/F16:
 *  - the matrix renders experiments as COLUMNS with parameter + KPI rows and a
 *    marked Baseline (first) column;
 *  - editing the "Seed runs N" cell and the active checkbox call
 *    patchExperimentMetaJson (replicationCount / enabled);
 *  - the ▶ Run-this button calls runExperimentBatch;
 *  - the openers toggle the shared des-matrix-window-store (§9.8).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { IndexedDBSnapshotStore, type ManifestMetaPatch } from '@rv-private/plugins/des/rv-des-experiment-store';
import type { RunResult } from '@rv-private/plugins/des/rv-des-experiment-model';
import { DESExperimentMatrixPanel } from '../../src/plugins/sim-controller/DESExperimentMatrixPanel';
import {
  desMatrixWindowStore, openDesMatrixWindow, closeDesMatrixWindow, toggleDesMatrixWindow,
} from '../../src/plugins/sim-controller/des-matrix-window-store';
import {
  closeProjectDb, runScopeStore,
} from '../../src/core/material-flow/rv-run-history-store';
import { ensureActiveScope } from '../../src/core/material-flow/rv-project-manager';
import { __resetDesRunSettingsForTest } from '../../src/core/hmi/des-run-settings-store';
import type { SimDesControl } from '../../src/core/material-flow/simulation-kernel';
import type { RVViewer } from '../../src/core/rv-viewer';

function makeRunResult(runId: string, throughput: number, util: number): RunResult {
  return {
    runId, status: 'completed', startedAt: 1000, endedAt: 2000, simTimeReached: 3600,
    reason: 'duration-reached',
    stats: { simTime: 3600, components: [], bottleneck: null, meanUtilization: util, throughputPerHour: throughput },
  };
}

interface BatchCall { model: string; exp: string; replications: number; crn: boolean; }
interface SnapOps { loaded: Array<{ exp: string; repl: number; t: number }>; subModes: string[]; saved: number; }

/** Fake viewer whose SimDesControl is backed by the REAL store; records calls. */
function makeViewer(store: IndexedDBSnapshotStore, batchCalls: BatchCall[], snapOps?: SnapOps): RVViewer {
  const ctl: Partial<SimDesControl> = {
    masterSeed: 42,
    listExperiments: async (model?: string) => {
      const all = await store.listIndex();
      return model === undefined ? all : all.filter((e) => e.model === model);
    },
    readManifestJson: async (model: string, exp: string) => {
      const meta = await store.readManifest(model, exp);
      return meta ? JSON.stringify(meta) : null;
    },
    patchExperimentMetaJson: async (model: string, exp: string, patchJson: string) => {
      // Forward EVERY field (incl. plan-265 matrix fields) to the real store.
      await store.patchManifestMeta(model, exp, JSON.parse(patchJson) as ManifestMetaPatch);
    },
    runExperimentBatch: async (scope, opts) => {
      batchCalls.push({ model: scope.model, exp: scope.exp, replications: opts.replications, crn: opts.crn });
    },
    runAllExperiments: async () => {},
    batchProgressJson: () => null,
    activeRunInfoJson: () => null,
    loadSnapshot: async (scope) => { snapOps?.loaded.push({ exp: scope.exp, repl: scope.repl, t: scope.t }); },
    setSubMode: (m) => { snapOps?.subModes.push(m); },
    saveSnapshot: async () => { if (snapOps) snapOps.saved++; },
    deleteSnapshot: async () => {},
    deleteReplication: async () => {},
  };
  return {
    currentModelUrl: '/models/TestPlant.glb',
    simulationKernel: { desControl: () => ctl as SimDesControl },
    on: () => () => {},
  } as unknown as RVViewer;
}

let _lastStore: IndexedDBSnapshotStore | null = null;
async function freshDbs(): Promise<IndexedDBSnapshotStore> {
  await _lastStore?.close();
  await closeProjectDb();
  for (const name of ['rv-des-experiments', 'rv-sim-projects']) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  }
  _lastStore = new IndexedDBSnapshotStore();
  return _lastStore;
}

describe('des-matrix-window-store (§9.8)', () => {
  beforeEach(() => closeDesMatrixWindow());

  it('open/close/toggle drive ONE shared open state', () => {
    expect(desMatrixWindowStore.getSnapshot()).toBe(false);
    openDesMatrixWindow();
    expect(desMatrixWindowStore.getSnapshot()).toBe(true);
    toggleDesMatrixWindow();
    expect(desMatrixWindowStore.getSnapshot()).toBe(false);
    toggleDesMatrixWindow();
    expect(desMatrixWindowStore.getSnapshot()).toBe(true);
    closeDesMatrixWindow();
    expect(desMatrixWindowStore.getSnapshot()).toBe(false);
  });
});

describe('DESExperimentMatrixPanel (§9.6)', () => {
  beforeEach(() => {
    __resetDesRunSettingsForTest();
    runScopeStore.set(() => null);
  });
  afterEach(() => cleanup());

  it('renders columns + param/KPI rows; N-edit, active toggle, Run-this and F15 drill-down hit the facade', async () => {
    const store = await freshDbs();
    const batchCalls: BatchCall[] = [];
    const snapOps: SnapOps = { loaded: [], subModes: [], saved: 0 };
    const viewer = makeViewer(store, batchCalls, snapOps);

    // Baseline (active) with a run; Variant with a param override + a run.
    const scope = await ensureActiveScope(viewer);
    expect(scope).not.toBeNull();
    await store.patchManifestMeta(scope!.model, scope!.exp, { replicationCount: 2, endTime: 3600 });
    await store.recordRun(scope!.model, scope!.exp, 42, makeRunResult('b0', 100, 70));
    await store.recordRun(scope!.model, scope!.exp, 1042, makeRunResult('b1', 120, 80));
    // A checkpoint on baseline run #0 (F15 drill-down fixture).
    const snap = {
      version: 2, simTime: 100, masterSeed: 42, nextEventId: 0, rngStates: { __manager__: [1, 2, 3, 4] },
      components: {}, mus: [], drives: {}, signalValues: {}, eventQueue: [], statisticsCurrent: {}, scriptStates: {},
    };
    await store.writeSnapshot(scope!.model, scope!.exp, 0, 100, snap as never, { replicationSeed: 42 });

    await store.patchManifestMeta(scope!.model, 'Variant', {
      projectId: scope!.projectId!, baseSeed: 42, replicationCount: 2, endTime: 3600,
      paramOverrides: [{ path: 'Src', component: 'DESSource', field: 'InterArrivalTime', value: 3 }],
    });
    await store.recordRun(scope!.model, 'Variant', 42, makeRunResult('v0', 150, 85));

    render(createElement(DESExperimentMatrixPanel, { viewer, open: true, onClose: () => {} }));

    // Both experiments appear as columns.
    await screen.findByTestId(`des-matrix-col-${scope!.exp}`);
    await screen.findByTestId('des-matrix-col-Variant');

    // Parameter row for the overridden field is present (union across experiments).
    await screen.findByTestId('des-matrix-cell-DESSource.InterArrivalTime-Variant');
    // KPI rows are present with numeric content.
    const kpi = await screen.findByTestId(`des-matrix-kpi-throughput-${scope!.exp}`);
    expect(kpi.textContent).toMatch(/\d/);

    // ▶ Run-this on Variant → runExperimentBatch (done first, before the busy-
    // setting edits below, so the button is not transiently disabled).
    fireEvent.click(await screen.findByTestId('des-matrix-run-Variant'));
    await waitFor(() => expect(batchCalls.some((c) => c.exp === 'Variant')).toBe(true));
    expect(batchCalls[0].crn).toBe(true); // CRN default on

    // Edit "Seed runs N" on Variant → patchExperimentMetaJson(replicationCount).
    const nField = (await screen.findByTestId('des-matrix-N-Variant')).querySelector('input')!;
    fireEvent.change(nField, { target: { value: '5' } });
    await waitFor(async () => {
      const meta = await store.readManifest(scope!.model, 'Variant');
      expect(meta!.replicationCount).toBe(5);
    });

    // Toggle the active checkbox on Variant → patchExperimentMetaJson(enabled:false).
    const active = (await screen.findByTestId('des-matrix-active-Variant')).querySelector('input')!;
    fireEvent.click(active);
    await waitFor(async () => {
      const meta = await store.readManifest(scope!.model, 'Variant');
      expect(meta!.enabled).toBe(false);
    });

    // F15 drill-down: open the baseline's run list, load its checkpoint (step
    // mode), snapshot now — all through the facade.
    fireEvent.click(await screen.findByTestId(`des-matrix-drilldown-${scope!.exp}`));
    await screen.findByTestId('des-matrix-runs-panel');
    fireEvent.click(await screen.findByTestId('des-matrix-load-cp-0-100'));
    await waitFor(() => expect(snapOps.loaded).toContainEqual({ exp: scope!.exp, repl: 0, t: 100 }));
    expect(snapOps.subModes).toContain('step');
    fireEvent.click(await screen.findByTestId('des-matrix-snapshot-now'));
    await waitFor(() => expect(snapOps.saved).toBe(1));

    // F4 param-script authoring: open the editor for Variant, lint blocks a
    // scheduling primitive, a pure setter saves via patchExperimentMetaJson.
    fireEvent.click(await screen.findByTestId('des-matrix-script-Variant'));
    const textarea = await screen.findByTestId('des-matrix-script-text');
    fireEvent.change(textarea, { target: { value: "self.in(5, 'Arrival')" } });
    await screen.findByTestId('des-matrix-script-errors');
    expect((await screen.findByTestId('des-matrix-script-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(textarea, { target: { value: "self.setField('Src','DESSource','InterArrivalTime', 2)" } });
    fireEvent.click(await screen.findByTestId('des-matrix-script-save'));
    await waitFor(async () => {
      const meta = await store.readManifest(scope!.model, 'Variant');
      expect(meta!.paramScript).toContain('setField');
    });
  });
});
