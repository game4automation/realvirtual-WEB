// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plc-plugin-wiring.test.ts — plan-242 Phase 3 (plugin lifecycle wiring).
 *
 * Contract of `PlcPlugin` against the public surfaces:
 *  - init() registers the runner as the active `PlcControl` (getPlcControl()).
 *  - init() registers ONE PRE-stage tick; the runner gates on its run state
 *    (no scan while 'stopped', scans while 'running').
 *  - 'simulation-reset' → COLD runner reset (program memory restarts).
 *  - onModelLoaded() picks up an existing PLCProgram node into the editor
 *    store WITHOUT auto-starting (v1 trust gate: never auto-run).
 *  - onModelCleared() stops scanning and empties the watch.
 *  - dispose() unregisters the PlcControl and releases the tick callback.
 *
 * Uses the shared createTestViewer() mock (simLoop + _tickOnce + events) with
 * a REAL SignalStore swapped in, and the real private runner/sandbox
 * (imports `@rv-private` — private build only, like the other plc tests).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { resetPlcEditorStore, getPlcEditorState } from '@rv-private/plugins/plc/plc-editor-store';
import { getPlcControl, registerPlcControl } from '../src/core/plc-control';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { createTestViewer, type TestViewer, type TestSignalStore } from './helpers/test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const DT = 1 / 60;

const COUNTER_PROGRAM = `PROGRAM Main
VAR_EXTERNAL CountOut : INT; END_VAR
VAR count : INT; END_VAR
  count := count + 1;
  CountOut := count;
END_PROGRAM`;

let viewer: TestViewer;
let store: SignalStore;
let plugin: PlcPlugin;

/** Wait until the runner's async reset/run promise chain settled. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  viewer = createTestViewer();
  store = new SignalStore();
  store.register('CountOut', 'PLC/CountOut', 0);
  viewer._setSignalStore(store as unknown as TestSignalStore);
  plugin = new PlcPlugin();
  plugin.init(viewer as unknown as RVViewer);
});

afterEach(() => {
  plugin.dispose();
  registerPlcControl(null);
  resetPlcEditorStore();
});

describe('PlcPlugin wiring', () => {
  it('init() registers the PlcControl', () => {
    expect(getPlcControl()).not.toBeNull();
  });

  it('tick gate: no scan while stopped, scans on the PRE tick while running', async () => {
    const control = getPlcControl()!;
    const diagnostics = await control.deploy(COUNTER_PROGRAM);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    // Stopped → the registered tick callback must not scan.
    viewer._tickOnce(DT);
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(0);

    await control.run();
    viewer._tickOnce(DT);
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(2);
  });

  it("'simulation-reset' performs a COLD runner reset (program memory restarts)", async () => {
    const control = getPlcControl()!;
    await control.deploy(COUNTER_PROGRAM);
    await control.run();
    viewer._tickOnce(DT);
    viewer._tickOnce(DT);
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(3);

    viewer.emit('simulation-reset', undefined);
    await settle(); // reset() is async (fire-and-forget in the plugin)

    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(1); // mem was rebuilt: 0 + 1
  });

  it('onModelLoaded() loads an existing PLCProgram into the editor store, but never auto-starts', () => {
    const root = new Object3D();
    root.name = 'Scene';
    const plcNode = new Object3D();
    plcNode.name = 'PLC';
    plcNode.userData.realvirtual = {
      PLCProgram: { Active: true, Language: 'st', Name: 'Main', Code: COUNTER_PROGRAM },
    };
    root.add(plcNode);
    (viewer as unknown as { scene: Object3D }).scene = root;

    plugin.onModelLoaded({} as LoadResult, viewer as unknown as RVViewer);

    const state = getPlcEditorState();
    expect(state.nodePath).toBe('PLC');
    expect(state.code).toBe(COUNTER_PROGRAM);
    // Trust gate v1: Active=true in the scene must NOT start the PLC.
    expect(getPlcControl()!.state).toBe('stopped');
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(0);
  });

  it('onModelCleared() stops scanning and empties the watch', async () => {
    const control = getPlcControl()!;
    await control.deploy(COUNTER_PROGRAM);
    await control.run();
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(1);
    expect(control.watch().size).toBeGreaterThan(0);

    plugin.onModelCleared(viewer as unknown as RVViewer);

    expect(control.state).toBe('stopped');
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(1); // no further scans
    expect(control.watch().size).toBe(0);
    expect(getPlcEditorState().open).toBe(false);
  });

  it('dispose() unregisters the PlcControl and releases the tick callback', async () => {
    const control = getPlcControl()!;
    await control.deploy(COUNTER_PROGRAM);
    await control.run();
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(1);

    plugin.dispose();
    expect(getPlcControl()).toBeNull();
    viewer._tickOnce(DT); // tick callback removed — no scan even if state were running
    expect(store.getInt('CountOut')).toBe(1);
  });
});
