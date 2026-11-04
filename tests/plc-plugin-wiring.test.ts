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
 *    store and auto-starts it when `Active` (like LogicStep roots);
 *    `Active: false` only loads the code; a model clear cancels a pending start.
 *  - onModelCleared() stops scanning and empties the watch.
 *  - dispose() unregisters the PlcControl and releases the tick callback.
 *  - init() registers the PlcPersistence: `plc.deploy` writes the deployed
 *    code into PLCProgram.Code (node created when absent) without the editor;
 *    dispose() withdraws it. PLCProgram is authorable (editor.addComponent).
 *
 * Uses the shared createTestViewer() mock (simLoop + _tickOnce + events) with
 * a REAL SignalStore swapped in, and the real private runner/sandbox
 * (imports `@rv-private` — private build only, like the other plc tests).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { resetPlcEditorStore, getPlcEditorState, loadPlcProgram } from '@rv-private/plugins/plc/plc-editor-store';
import { getPlcControl, getPlcPersistence, registerPlcControl } from '../src/core/plc-control';
import { plcDeploy } from '../src/core/hmi/des-plc-commands';
import type { CommandContext } from '../src/core/hmi/rv-command-registry';
import { getTypesWithCapability } from '../src/core/engine/rv-component-registry';
import { registerPlcProgramComponent } from '@rv-private/plc/rv-plc-program';
import { findPlcProgramNodes, type PlcSceneStoreLike } from '@rv-private/plugins/plc/plc-program-node';
import type { RvScenePrimitiveOp } from '../src/core/ops/rv-unified-ops';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { createTestViewer, type TestViewer, type TestSignalStore } from './helpers/test-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

// The scene store the plugin's deploy persistence writes into (null = none, as at boot).
const sceneStore = vi.hoisted(() => ({ current: null as unknown }));
// Plain factory (no importOriginal): the real module pulls in the SceneStore, whose own import
// graph reaches this module again.
vi.mock('../src/core/hmi/scene/scene-store-singleton', () => ({
  initSceneStore: () => { throw new Error('initSceneStore is not available in this test'); },
  getSceneStore: () => sceneStore.current,
}));

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
  sceneStore.current = null;
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

  /** Puts a scene with one PLC node carrying a PLCProgram into the viewer. */
  function loadScene(active: boolean): void {
    const root = new Object3D();
    root.name = 'Scene';
    const plcNode = new Object3D();
    plcNode.name = 'PLC';
    plcNode.userData.realvirtual = {
      PLCProgram: { Active: active, Language: 'st', Name: 'Main', Code: COUNTER_PROGRAM },
    };
    root.add(plcNode);
    (viewer as unknown as { scene: Object3D }).scene = root;
    plugin.onModelLoaded({} as LoadResult, viewer as unknown as RVViewer);
  }

  it('onModelLoaded() loads an Active PLCProgram into the editor store and auto-starts it', async () => {
    loadScene(true);

    const state = getPlcEditorState();
    expect(state.nodePath).toBe('PLC');
    expect(state.code).toBe(COUNTER_PROGRAM);
    await vi.waitFor(() => expect(getPlcControl()!.state).toBe('running'));
    viewer._tickOnce(DT);
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(2);
  });

  it('onModelLoaded() with Active: false only loads the code — no start', async () => {
    loadScene(false);

    expect(getPlcEditorState().code).toBe(COUNTER_PROGRAM);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getPlcControl()!.state).toBe('stopped');
    viewer._tickOnce(DT);
    expect(store.getInt('CountOut')).toBe(0);
  });

  it('a model clear while the auto-start deploys cancels the start', async () => {
    loadScene(true);
    plugin.onModelCleared(viewer as unknown as RVViewer);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getPlcControl()!.state).not.toBe('running');
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

  it('PLCProgram is authorable (editor.addComponent accepts it)', () => {
    registerPlcProgramComponent();
    expect(getTypesWithCapability('authorable')).toContain('PLCProgram');
  });

  it('plc.deploy persists the code into PLCProgram.Code without opening the editor', async () => {
    // Scene with a registered 'Cell' and NO PLC node; the store executes addNode/setField.
    const root = new Object3D();
    root.name = 'Scene';
    const cell = new Object3D();
    cell.name = 'Cell';
    root.add(cell);
    const nodes = new Map<string, Object3D>([['Cell', cell]]);
    const ops: RvScenePrimitiveOp[] = [];
    const store: PlcSceneStoreLike = {
      applyOp: async (op) => {
        ops.push(op);
        if (op.kind === 'addNode') {
          const n = new Object3D();
          n.name = op.spec.name;
          n.userData.realvirtual = structuredClone(op.spec.components);
          nodes.get(op.spec.parentPath)!.add(n);
          nodes.set(op.nodePath, n);
        } else if (op.kind === 'setField') {
          (nodes.get(op.nodePath)!.userData.realvirtual as Record<string, Record<string, unknown>>)
            [op.componentType][op.fieldName] = op.value;
        }
      },
    };
    sceneStore.current = store;
    Object.assign(viewer, {
      scene: root,
      registry: {
        getPathForNode: (n: Object3D) => [...nodes].find(([, v]) => v === n)?.[0] ?? null,
        getNode: (path: string) => nodes.get(path) ?? null,
      },
    });

    const result = await plcDeploy.run({ viewer } as unknown as CommandContext, { code: COUNTER_PROGRAM }) as Record<string, unknown>;
    expect(result).toMatchObject({ errorCount: 0, persisted: true, persistedTo: 'Cell/PLC', created: true });
    expect(ops.map((o) => o.kind)).toEqual(['addNode', 'setField']);
    // What a reload rediscovers: the deployed program, read from node data alone.
    expect(findPlcProgramNodes(root).map((h) => h.code)).toEqual([COUNTER_PROGRAM]);
    expect(getPlcEditorState().open).toBe(false);
    // The deployed program moved onto the new node and the editor follows it.
    expect(getPlcEditorState()).toMatchObject({ nodePath: 'Cell/PLC', code: COUNTER_PROGRAM });

    // A redeploy writes the same node — one setField, no second node.
    const next = COUNTER_PROGRAM.replace('count + 1', 'count + 2');
    const again = await plcDeploy.run({ viewer } as unknown as CommandContext, { code: next }) as Record<string, unknown>;
    expect(again).toMatchObject({ persisted: true, persistedTo: 'Cell/PLC' });
    expect(again.created).toBeUndefined();
    expect(findPlcProgramNodes(root).map((h) => h.code)).toEqual([next]);
  });

  it('plc.deploy keeps UNSAVED editor edits and warns instead of replacing the buffer', async () => {
    const root = new Object3D();
    const plcNode = new Object3D();
    plcNode.name = 'PLC';
    plcNode.userData.realvirtual = { PLCProgram: { Active: false, Name: 'Main', Code: COUNTER_PROGRAM } };
    root.add(plcNode);
    const nodes = new Map<string, Object3D>([['PLC', plcNode]]);
    sceneStore.current = {
      applyOp: async (op: RvScenePrimitiveOp) => {
        if (op.kind === 'setField') {
          (nodes.get(op.nodePath)!.userData.realvirtual as Record<string, Record<string, unknown>>)
            [op.componentType][op.fieldName] = op.value;
        }
      },
    } satisfies PlcSceneStoreLike;
    Object.assign(viewer, {
      scene: root,
      registry: { getPathForNode: (n: Object3D) => (n === plcNode ? 'PLC' : null), getNode: (p: string) => nodes.get(p) ?? null },
    });
    plugin.onModelLoaded({} as LoadResult, viewer as unknown as RVViewer);
    const userEdit = COUNTER_PROGRAM.replace('count + 1', 'count + 5');
    loadPlcProgram('PLC', userEdit, 'Main'); // the user typed, not yet autosaved

    const deployed = COUNTER_PROGRAM.replace('count + 1', 'count + 2');
    const result = await plcDeploy.run({ viewer } as unknown as CommandContext, { code: deployed }) as Record<string, unknown>;
    expect(result).toMatchObject({ persisted: true, persistedTo: 'PLC' });
    expect(String(result.warning)).toContain('unsaved edits');
    expect(findPlcProgramNodes(root)[0].code).toBe(deployed);
    expect(getPlcEditorState().code).toBe(userEdit); // the user's buffer survived

    // Without unsaved edits the editor follows the deploy and nothing is warned.
    loadPlcProgram('PLC', deployed, 'Main');
    const next = COUNTER_PROGRAM.replace('count + 1', 'count + 3');
    const clean = await plcDeploy.run({ viewer } as unknown as CommandContext, { code: next }) as Record<string, unknown>;
    expect(clean.warning).toBeUndefined();
    expect(getPlcEditorState().code).toBe(next);
  });

  it('plc.deploy without a scene document fails visibly (deployed, not saved)', async () => {
    Object.assign(viewer, { scene: new Object3D(), registry: { getPathForNode: () => null, getNode: () => null } });
    const result = await plcDeploy.run({ viewer } as unknown as CommandContext, { code: COUNTER_PROGRAM }) as Record<string, unknown>;
    expect(result).toMatchObject({ errorCount: 0, persisted: false });
    expect(String(result.error)).toContain('NOT saved');
  });

  it('dispose() withdraws the PlcPersistence', () => {
    expect(getPlcPersistence()).not.toBeNull();
    plugin.dispose();
    expect(getPlcPersistence()).toBeNull();
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
