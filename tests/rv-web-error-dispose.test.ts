// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { Scene, Mesh, BoxGeometry } from 'three';
import { GizmoOverlayManager } from '../src/core/engine/rv-gizmo-manager';
import { RVWebError } from '../src/core/engine/rv-web-error';
import { ErrorStore } from '../src/core/engine/rv-error-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';

function setup() {
  const scene = new Scene();
  const mgr = new GizmoOverlayManager(scene);
  const store = new SignalStore();
  const errorStore = new ErrorStore();
  store.register('A/Err', 'A/Err', false);
  const node = new Mesh(new BoxGeometry());
  node.name = 'Part';
  scene.add(node);
  const comp = new RVWebError(node);
  (comp as any).SignalError = 'A/Err';
  (comp as any).ErrorText = 'x';
  const ctx = { scene, signalStore: store, gizmoManager: mgr, errorStore } as any;
  comp.init(ctx);
  comp.onSceneReady!(ctx);
  return { comp, signalStore: store, errorStore, mgr };
}

describe('RVWebError dispose', () => {
  it('stops reacting to signal after dispose and removes from store', () => {
    const { comp, signalStore, errorStore } = setup();
    signalStore.set('A/Err', true);
    expect(errorStore.getActive()).toHaveLength(1);

    comp.dispose();
    expect(errorStore.getActive()).toHaveLength(0);

    signalStore.set('A/Err', true); // must NOT re-add after dispose
    expect(errorStore.getActive()).toHaveLength(0);
  });

  it('disposes both gizmos (entries count drops to zero)', () => {
    const { comp, signalStore, mgr } = setup();
    signalStore.set('A/Err', true);
    const before = (mgr as any)._entries.size;
    // a7396494 removed the world-space error badge (the text lives in the error panel only):
    // without a highlighter the error keeps exactly one gizmo, the legacy glow hull.
    expect(before).toBeGreaterThanOrEqual(1);
    comp.dispose();
    expect((mgr as any)._entries.size).toBe(0);
  });
});
