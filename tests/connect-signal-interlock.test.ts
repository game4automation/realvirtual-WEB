// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.4 — RVConnectSignal must not fight an external binding.
 *
 * A `ConnectSignal` node relays one internal signal onto its own — and since
 * plan-418 that own signal can ALSO be bound to an external CONNECT tag. Two
 * permanent writers on one channel is the race this interlock closes.
 *
 * The load-bearing case is the RELEASE: the relay writes only when its source
 * CHANGES, so a source that moved during the suppression would otherwise leave
 * a stale value behind after the unbind, until the source happened to move
 * again. `subscribeLiveControl` exists for exactly that edge.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVConnectSignal } from '../src/core/engine/rv-connect-signal';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  resetSlotAuthority,
  setSignalLiveControlled,
  subscribeLiveControl,
} from '../src/core/engine/rv-slot-authority';

const SOURCE_PATH = 'Cell/Signals/Source';
const TARGET_PATH = 'Cell/Signals/Mirror';

function fixture() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);
  const signals = new Object3D();
  signals.name = 'Signals';
  root.add(signals);

  const sourceNode = new Object3D();
  sourceNode.name = 'Source';
  signals.add(sourceNode);
  const mirrorNode = new Object3D();
  mirrorNode.name = 'Mirror';
  signals.add(mirrorNode);

  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);
  registry.registerNode(SOURCE_PATH, sourceNode);
  registry.registerNode(TARGET_PATH, mirrorNode);
  store.register('Source', SOURCE_PATH, false, 'PLCOutputBool');
  store.register('Mirror', TARGET_PATH, false, 'PLCOutputBool');
  store.buildIndex();

  const relay = new RVConnectSignal(mirrorNode);
  relay.ConnectedSignal = SOURCE_PATH;
  relay.init({ registry, signalStore: store, scene, root } as ComponentContext);

  return { scene, root, registry, store, relay };
}

describe('RVConnectSignal live-control interlock', () => {
  beforeEach(resetSlotAuthority);
  afterEach(resetSlotAuthority);

  it('relays normally while nothing owns the target', () => {
    const f = fixture();
    f.store.set('Source', true);
    expect(f.store.get('Mirror')).toBe(true);
  });

  it('copies the initial value on init', () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Cell';
    scene.add(root);
    const node = new Object3D();
    node.name = 'Mirror';
    root.add(node);
    const registry = new NodeRegistry();
    const store = new SignalStore();
    registry.registerNode('Cell', root);
    registry.registerNode('Cell/Mirror', node);
    store.register('Source', 'Cell/Source', true, 'PLCOutputBool');
    store.register('Mirror', 'Cell/Mirror', false, 'PLCOutputBool');
    store.buildIndex();

    const relay = new RVConnectSignal(node);
    relay.ConnectedSignal = 'Cell/Source';
    relay.init({ registry, signalStore: store, scene, root } as ComponentContext);

    expect(store.get('Mirror')).toBe(true);
    relay.dispose();
  });

  it('writes nothing while the target is externally controlled', () => {
    const f = fixture();
    setSignalLiveControlled('Mirror', true);
    // The external owner puts its own value on the channel …
    f.store.set('Mirror', true);
    // … and the relay must not undo it.
    f.store.set('Source', false);

    expect(f.store.get('Mirror')).toBe(true);
  });

  it('KERNFALL: resyncs the CURRENT source value on release, with no source change', () => {
    const f = fixture();
    setSignalLiveControlled('Mirror', true);
    f.store.set('Mirror', false);

    // Source moves WHILE suppressed — the relay swallows it.
    f.store.set('Source', true);
    expect(f.store.get('Mirror')).toBe(false);

    // Unbind. No further source change happens.
    setSignalLiveControlled('Mirror', false);

    expect(f.store.get('Mirror')).toBe(true);
  });

  it('is idempotent over repeated bind/unbind cycles', () => {
    const f = fixture();
    for (const value of [true, false, true]) {
      setSignalLiveControlled('Mirror', true);
      f.store.set('Source', value);
      f.store.set('Mirror', !value); // external owner writes something else
      setSignalLiveControlled('Mirror', false);
      expect(f.store.get('Mirror')).toBe(value);
    }
  });

  it('does not re-fire on a repeated set to the same live-control state', () => {
    const f = fixture();
    let transitions = 0;
    const unsub = subscribeLiveControl('Mirror', () => { transitions++; });

    setSignalLiveControlled('Mirror', true);
    setSignalLiveControlled('Mirror', true);
    setSignalLiveControlled('Mirror', false);
    setSignalLiveControlled('Mirror', false);

    expect(transitions).toBe(2);
    unsub();
  });

  it('dispose() removes the subscription — no write after teardown', () => {
    const f = fixture();
    setSignalLiveControlled('Mirror', true);
    f.store.set('Source', true);
    f.store.set('Mirror', false);

    f.relay.dispose();
    setSignalLiveControlled('Mirror', false);

    expect(f.store.get('Mirror')).toBe(false);
  });

  it('a model reset clears subscriptions so the next model starts clean', () => {
    const f = fixture();
    setSignalLiveControlled('Mirror', true);
    f.store.set('Source', true);
    f.store.set('Mirror', false);

    resetSlotAuthority(); // rv-viewer.clearModel()
    setSignalLiveControlled('Mirror', false);

    expect(f.store.get('Mirror')).toBe(false);
    f.relay.dispose();
  });

  it('a relay whose own node has no registered signal keeps relaying (no gate)', () => {
    const scene = new Scene();
    const root = new Object3D();
    root.name = 'Cell';
    scene.add(root);
    const node = new Object3D();
    node.name = 'Loose';
    root.add(node);
    const registry = new NodeRegistry();
    const store = new SignalStore();
    registry.registerNode('Cell', root);
    registry.registerNode('Cell/Loose', node);
    store.register('Source', 'Cell/Source', false, 'PLCOutputBool');
    store.buildIndex();

    const relay = new RVConnectSignal(node);
    relay.ConnectedSignal = 'Cell/Source';
    relay.init({ registry, signalStore: store, scene, root } as ComponentContext);

    expect(() => store.set('Source', true)).not.toThrow();
    relay.dispose();
  });
});
