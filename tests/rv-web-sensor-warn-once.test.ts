// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import {
  RVWebSensor,
  __resetWarnedSignals,
  initWebSensor,
  resetWebSensorConfig,
} from '../src/core/engine/rv-web-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';

describe('RVWebSensor warn-once', () => {
  beforeEach(() => {
    __resetWarnedSignals();
    resetWebSensorConfig();
  });

  it('warns once for missing signal across multiple sensors when randomDemoStates is off', () => {
    initWebSensor({ randomDemoStates: false });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();

    const n1 = new Mesh(new BoxGeometry());
    const n2 = new Mesh(new BoxGeometry());
    scene.add(n1, n2);
    const s1 = new RVWebSensor(n1);
    const s2 = new RVWebSensor(n2);
    s1.init({ scene, signalStore: store, gizmoManager: mgr } as any);
    s2.init({ scene, signalStore: store, gizmoManager: mgr } as any);

    const matches = warnSpy.mock.calls.filter(c => String(c[0]).includes('no signal bound'));
    expect(matches.length).toBe(1);
    warnSpy.mockRestore();
  });

  it('warns once per unknown int value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    store.register('SigI', 'SigI', 0);

    const node = new Mesh(new BoxGeometry());
    scene.add(node);
    const inst = new RVWebSensor(node);
    (inst as any).SignalInt = 'SigI';
    inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);

    store.set('SigI', 99);
    store.set('SigI', 99);
    store.set('SigI', 99);
    const warnings99 = warnSpy.mock.calls.filter(c => String(c[0]).includes('99')).length;
    expect(warnings99).toBe(1);
    warnSpy.mockRestore();
  });
});
