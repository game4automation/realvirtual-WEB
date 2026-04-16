// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import {
  RVWebSensor,
  resetWebSensorConfig,
  __resetWarnedSignals,
  initWebSensor,
  WebSensorConfig,
} from '../src/core/engine/rv-web-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function setup(bind: 'bool' | 'int' | 'none' | 'both', intMap = '', label = '') {
  const scene = new Scene();
  const mgr = new GizmoOverlayManager(scene);
  const store = new SignalStore();
  if (bind === 'bool' || bind === 'both') store.register('Sig', 'Sig', false);
  if (bind === 'int' || bind === 'both') store.register('SigI', 'SigI', 0);
  const node = new Mesh(new BoxGeometry());
  scene.add(node);
  const inst = new RVWebSensor(node);
  if (bind === 'bool' || bind === 'both') (inst as any).SignalBool = 'Sig';
  if (bind === 'int' || bind === 'both') (inst as any).SignalInt = 'SigI';
  (inst as any).IntStateMap = intMap;
  (inst as any).Label = label;
  inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);
  return { inst, store, mgr, scene };
}

describe('RVWebSensor', () => {
  beforeEach(() => {
    resetWebSensorConfig();
    __resetWarnedSignals();
  });

  it('unbound when neither signal is set', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    const node = new Mesh(new BoxGeometry());
    scene.add(node);
    const inst = new RVWebSensor(node);
    inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);
    expect(inst.getCurrentState()).toBe('unbound');
  });

  it('bool mode: false → low, true → high', () => {
    const { inst, store } = setup('bool');
    expect(inst.getCurrentState()).toBe('low');
    store.set('Sig', true);
    expect(inst.getCurrentState()).toBe('high');
  });

  it('int mode with default map', () => {
    const { inst, store } = setup('int');
    store.set('SigI', 2);
    expect(inst.getCurrentState()).toBe('warning');
    store.set('SigI', 3);
    expect(inst.getCurrentState()).toBe('error');
    store.set('SigI', 0);
    expect(inst.getCurrentState()).toBe('low');
  });

  it('int mode with custom map', () => {
    const { inst, store } = setup('int', '10:high,20:warning,99:error');
    store.set('SigI', 10);
    expect(inst.getCurrentState()).toBe('high');
    store.set('SigI', 7); // unknown → low
    expect(inst.getCurrentState()).toBe('low');
  });

  it('int beats bool when both bound', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { inst, store } = setup('both');
    store.set('Sig', true);
    store.set('SigI', 3);
    expect(inst.getCurrentState()).toBe('error');
    warnSpy.mockRestore();
  });

  it('tags node for sensor filter', () => {
    const { inst } = setup('bool');
    expect((inst as any).node.userData._rvType).toBe('WebSensor');
    expect((inst as any).node.userData._rvTag).toBe('sensor');
    expect((inst as any).node.userData._rvWebSensor).toBe(inst);
  });

  it('reads initial value on init (no race)', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    store.register('Sig', 'Sig', true); // already true BEFORE init
    const node = new Mesh(new BoxGeometry());
    scene.add(node);
    const inst = new RVWebSensor(node);
    (inst as any).SignalBool = 'Sig';
    inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);
    expect(inst.getCurrentState()).toBe('high');
  });

  it('handles missing gizmoManager gracefully', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const scene = new Scene();
    const store = new SignalStore();
    store.register('Sig', 'Sig', false);
    const node = new Mesh(new BoxGeometry());
    const inst = new RVWebSensor(node);
    (inst as any).SignalBool = 'Sig';
    expect(() => inst.init({ scene, signalStore: store } as any)).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('creates text-gizmo when Label is non-empty', () => {
    const { inst } = setup('bool', '', 'Position 1');
    expect((inst as any)._textGizmo).toBeDefined();
  });

  it('no text-gizmo when Label is empty', () => {
    const { inst } = setup('bool', '', '');
    expect((inst as any)._textGizmo).toBeUndefined();
  });

  it('text-gizmo color syncs with state', () => {
    const { inst, store } = setup('bool', '', 'Exit');
    const textHandle = (inst as any)._textGizmo;
    const updateSpy = vi.spyOn(textHandle, 'update');
    store.set('Sig', true); // → high
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ color: 0x3080ff }));
    updateSpy.mockRestore();
  });

  it('onHover increases size by 1.15x then restores', () => {
    const { inst } = setup('bool', '', 'Test');
    const gizmo = (inst as any)._gizmo;
    const updateSpy = vi.spyOn(gizmo, 'update');
    inst.onHover!(true);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ size: 1.0 * 1.15 }));
    inst.onHover!(false);
    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ size: 1.0 }));
    updateSpy.mockRestore();
  });

  it('onHover does not bump size when defaultSize is 0', () => {
    resetWebSensorConfig();
    initWebSensor({ defaultSize: 0 });
    expect(WebSensorConfig.defaultSize).toBe(0);
    const { inst } = setup('bool', '', 'Zero');
    const gizmo = (inst as any)._gizmo;
    const updateSpy = vi.spyOn(gizmo, 'update');
    inst.onHover!(true);
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
    resetWebSensorConfig();
  });

  it('onClick does not throw', () => {
    const { inst } = setup('bool', '', 'x');
    expect(() => inst.onClick!({ node: (inst as any).node, path: 'foo' })).not.toThrow();
  });

  it('onHover after dispose does not throw', () => {
    const { inst } = setup('bool', '', 'y');
    inst.dispose();
    expect(() => inst.onHover!(true)).not.toThrow();
    expect(() => inst.onHover!(false)).not.toThrow();
  });
});
