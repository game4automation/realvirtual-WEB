// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * signals-container-merge.test.ts — regression for the Signals-container dedup fix.
 *
 * `getOrCreateSignalsContainer` (in BOTH behaviors.ts and rv-signal-construction.ts)
 * must REUSE an existing `Signals` child of the root — whether it is GLB-native
 * (no `_rvSignals` marker, created by the exporter / processExtras) or was created
 * by an earlier behavior pass (`_rvSignals` marked) — instead of appending a SECOND
 * `Signals` group. Without the fix a GLB that already ships a `Signals` group would
 * get a duplicate container, so the same signals show up twice in the hierarchy
 * (once GLB-native without live values, once behavior-created with values).
 *
 * This pins both code paths: behavior-declared signals (BehaviorManager) and
 * code-attached drive-behavior signals (attachDriveBehaviorByCode).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { BehaviorManager, defineBehavior } from '../src/core/behaviors';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { RVDrive, DriveDirection } from '../src/core/engine/rv-drive';
import {
  attachDriveBehaviorByCode,
  type DriveBehaviorHostViewer,
} from '../src/core/engine/rv-signal-construction';
import type { BindContextHost } from '../src/core/behavior-runtime';

/** Host wired to the REAL SignalStore + NodeRegistry (full write surface). */
function makeHost(): { host: BindContextHost; store: SignalStore; registry: NodeRegistry } {
  const events = new EventEmitter<Record<string, unknown>>();
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const host: BindContextHost = {
    signalStore: store,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry,
    getPlugin: () => undefined,
  };
  return { host, store, registry };
}

/** A placed LayoutObject root (its name becomes the signal instance scope). */
function placedObject(name: string): Object3D {
  const o = new Object3D();
  o.name = name;
  o.userData._layoutId = `lid-${name}`;
  o.userData.realvirtual = { LayoutObject: { Label: name, CatalogId: 'cat', Locked: false } };
  return o;
}

/** Add a GLB-NATIVE `Signals` child (NO `_rvSignals` marker) to simulate a group
 *  that the Unity exporter already shipped inside the GLB. */
function addGlbNativeSignalsContainer(root: Object3D): Object3D {
  const c = new Object3D();
  c.name = 'Signals';
  // Intentionally NO `_rvSignals` marker — that is what distinguishes a GLB-native
  // container from a behavior-created one. The fix must reuse it regardless.
  root.add(c);
  return c;
}

function signalBehavior() {
  return defineBehavior({
    models: ['*Conv*'],
    bind: (rv) => {
      rv.signal('My.Run', { type: 'PLCOutputBool', initialValue: true });
      rv.signal('My.Count', { type: 'PLCOutputInt', initialValue: 0 });
    },
  });
}

describe('Signals container merge — behavior-declared path (behaviors.ts)', () => {
  let manager: BehaviorManager;
  beforeEach(() => { manager = new BehaviorManager(); });

  it('reuses a pre-existing (GLB-native) Signals child — no second container', () => {
    const { host, store, registry } = makeHost();
    const root = placedObject('Conv'); // scope = 'Conv'
    const native = addGlbNativeSignalsContainer(root);

    manager.register('sig', signalBehavior());
    manager.attach(host, () => null, () => '/models/Scene.glb');
    manager.dispatchPlaced(root);

    // Still EXACTLY ONE Signals container — the GLB-native one, now reused.
    const containers = root.children.filter((c) => c.name === 'Signals');
    expect(containers).toHaveLength(1);
    expect(containers[0]).toBe(native);
    // It got stamped on merge so it renders consistently as a signals group.
    expect((native.userData as Record<string, unknown>)._rvSignals).toBe(true);

    // The behavior signals landed INSIDE the existing container.
    expect(native.children.find((c) => c.name === 'My.Run')).toBeDefined();
    expect(native.children.find((c) => c.name === 'My.Count')).toBeDefined();

    // getByPath returns the live value from the merged node path.
    expect(store.getByPath('Conv/Signals/My.Run')).toBe(true);
    expect(registry.getNode('Conv/Signals/My.Run')).toBe(
      native.children.find((c) => c.name === 'My.Run'),
    );
  });
});

describe('Signals container merge — code-attached drive path (rv-signal-construction.ts)', () => {
  function buildRotaryWithNativeSignals() {
    const signalStore = new SignalStore();
    const registry = new NodeRegistry();
    const scene = new Scene();
    const ttRoot = new Object3D(); ttRoot.name = 'Turntable'; scene.add(ttRoot);

    const rotary = new Object3D(); rotary.name = 'Drive-Rot-Y'; ttRoot.add(rotary);
    // GLB-native Signals child already on the DRIVE node (e.g. exported with one
    // authored signal), NO `_rvSignals` marker.
    const native = new Object3D(); native.name = 'Signals'; rotary.add(native);

    const path = NodeRegistry.computeNodePath(rotary);
    registry.registerNode(path, rotary);
    const drive = new RVDrive(rotary);
    drive.Direction = DriveDirection.RotationY;
    drive.initDrive();
    registry.register('Drive', path, drive);

    const viewer: DriveBehaviorHostViewer & { transportManager: RVTransportManager } = {
      signalStore, registry, scene, transportManager: new RVTransportManager(),
    };
    return { viewer, signalStore, registry, rotary, native, path };
  }

  it('leaves an authored Signals container untouched when no wiring is supplied', () => {
    const { viewer, signalStore, rotary, native, path } = buildRotaryWithNativeSignals();

    attachDriveBehaviorByCode(viewer, rotary, 'Drive_DestinationMotor');

    // Exactly ONE Signals container (the GLB-native one), with no synthetic leaves.
    const containers = rotary.children.filter((c) => c.name === 'Signals');
    expect(containers).toHaveLength(1);
    expect(containers[0]).toBe(native);
    expect((native.userData as Record<string, unknown>)._rvSignals).toBeUndefined();
    expect(native.children).toHaveLength(0);
    expect(signalStore.getByPath(`${path}/Signals/Destination`)).toBeUndefined();
    expect(signalStore.getByPath(`${path}/Signals/IsDriving`)).toBeUndefined();
  });
});
