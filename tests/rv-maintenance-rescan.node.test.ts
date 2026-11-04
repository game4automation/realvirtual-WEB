// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MaintenancePlugin.rescanProcedures — procedure nodes a project's model plugin
 * adds at runtime AFTER the load (its `onModelLoaded` runs after the core
 * plugin's) become visible, tiles and triggers follow, a running guide ends,
 * and removing the nodes again takes the procedures out (plan-2016 B).
 */

import { describe, expect, test, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { MaintenancePlugin } from '../src/plugins/demo/maintenance-plugin';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { EventEmitter } from '../src/core/rv-events';
import '../src/core/engine/rv-maintenance-components';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

function node(name: string, rv?: Record<string, unknown>): Object3D {
  const o = new Object3D();
  o.name = name;
  if (rv) o.userData = { realvirtual: rv };
  return o;
}

function procedureNode(): Object3D {
  const proc = node('Mould change', { LogicStep_MaintenanceProcedure: { ProcedureName: 'Mould change', Message: 'Always' } });
  proc.add(node('01 Stop', { LogicStep_MaintenanceStep: { Title: 'Stop', CompletionType: 'ConfirmWarning' } }));
  proc.add(node('02 Open', { LogicStep_MaintenanceStep: { Title: 'Open' } }));
  return proc;
}

function rig() {
  const scene = new Scene();
  const model = node('Model');
  scene.add(model);
  const emitter = new EventEmitter();
  const uiRegistry = { register: vi.fn(), unregister: vi.fn() };
  const viewer = {
    scene,
    signalStore: new SignalStore(),
    simTime: 0,
    registry: { getNode: () => null, getPathForNode: (n: Object3D) => n.name, readStoredRef: () => null, resolve: () => ({}) },
    uiRegistry,
    setSimulationPaused: vi.fn(),
    getPlugin: () => undefined,
    getPlugins: () => [],
    clearHighlight: vi.fn(),
    highlighter: { setAuxEmphasis: vi.fn(), flash: vi.fn(), clearFlash: vi.fn() },
    markRenderDirty: vi.fn(),
    animateCameraTo: vi.fn(),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as RVViewer;
  const plugin = new MaintenancePlugin();
  plugin.onModelLoaded({} as LoadResult, viewer);
  return { viewer, model, plugin, emitter, uiRegistry };
}

describe('MaintenancePlugin.rescanProcedures', () => {
  test('a procedure added after the load is found, its tile registered and listeners told', () => {
    const { model, plugin, emitter, uiRegistry } = rig();
    expect(plugin.getProcedures()).toHaveLength(0);
    const due = vi.fn();
    emitter.on('maintenance-due-changed', due);

    model.add(procedureNode());
    plugin.rescanProcedures();

    expect(plugin.getProcedures().map((p) => p.name)).toEqual(['Mould change']);
    expect(plugin.getProcedures()[0].steps).toHaveLength(2);
    expect(plugin.getMessageEntries().map((e) => e.procedure.name)).toEqual(['Mould change']);
    expect(uiRegistry.register).toHaveBeenCalledTimes(1);
    expect(due).toHaveBeenCalled();
  });

  test('a running guide ends first; removed nodes take the procedures out', () => {
    const { model, plugin, uiRegistry } = rig();
    const proc = procedureNode();
    model.add(proc);
    plugin.rescanProcedures();
    plugin.enterMaintenance('Mould change');
    expect(plugin.getState().mode).toBe('dialog');

    proc.removeFromParent();
    plugin.rescanProcedures();

    expect(plugin.getState().mode).toBe('idle');
    expect(plugin.getProcedures()).toHaveLength(0);
    expect(uiRegistry.unregister).toHaveBeenCalled();
  });

  test('without a model it does nothing', () => {
    const plugin = new MaintenancePlugin();
    expect(() => plugin.rescanProcedures()).not.toThrow();
    expect(plugin.getProcedures()).toHaveLength(0);
  });
});
