// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVWebSensor } from '../src/core/engine/rv-web-sensor';
import { SignalStore } from '../src/core/engine/rv-signal-store';

describe('RVWebSensor dispose', () => {
  it('no callbacks fire after dispose', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    store.register('Sig', 'Sig', false);
    const node = new Mesh(new BoxGeometry());
    scene.add(node);
    const inst = new RVWebSensor(node);
    (inst as any).SignalBool = 'Sig';
    inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);

    inst.dispose();
    const stateBefore = inst.getCurrentState();
    store.set('Sig', true);
    // State must not change after dispose (unsubscribe worked)
    expect(inst.getCurrentState()).toBe(stateBefore);
  });

  it('gizmo handle is disposed (entries count drops)', () => {
    const scene = new Scene();
    const mgr = new GizmoOverlayManager(scene);
    const store = new SignalStore();
    store.register('Sig', 'Sig', false);
    const node = new Mesh(new BoxGeometry());
    scene.add(node);
    const inst = new RVWebSensor(node);
    (inst as any).SignalBool = 'Sig';
    (inst as any).Label = 'With label';
    inst.init({ scene, signalStore: store, gizmoManager: mgr } as any);

    const before = (mgr as any)._entries.size;
    expect(before).toBeGreaterThanOrEqual(1); // only state gizmo (text-gizmo removed; label is in tooltip)
    inst.dispose();
    const after = (mgr as any)._entries.size;
    expect(after).toBeLessThan(before);
    expect(after).toBe(0);
  });
});
