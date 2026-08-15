// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Signal level re-apply — integration surface (plan-427 §9.4 – §9.9).
 *
 * The registry itself is covered by `rv-signal-reapply-registry.node.test.ts`
 * and the helpers by `rv-signal-wiring.test.ts`. What is tested here is the
 * behaviour of the REAL wiring paths around them:
 *
 *  - the reconnect trigger (`interface-signals-synced`) and its stale window,
 *  - the one slot that must tell a replay from a change (`RVIKPath.SignalStart`),
 *  - the dispose fixes (`RVGrip`),
 *  - a bidirectional slot (`RVSceneButtonBase.stateSignal`),
 *  - the ComponentContext matrix: components built through the real runtime-add
 *    and subtree-placement paths must land in the registry too.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Scene } from 'three';

import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import { applySchema } from '../src/core/engine/rv-component-registry';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  SignalReapplyRegistry,
  setActiveSignalReapplyRegistry,
} from '../src/core/engine/rv-signal-reapply-registry';
import { createRuntimeNode, processExtras } from '../src/core/engine/rv-scene-loader';
import { RVGrip } from '../src/core/engine/rv-grip';
import { RVIKPath } from '../src/core/engine/rv-ik-path';
import { RVSceneButtonBase } from '../src/core/engine/rv-scene-button-base';
import {
  BaseIndustrialInterface,
  type SignalDescriptor,
} from '../src/interfaces/base-industrial-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import { EventEmitter } from '../src/core/rv-events';
import type { RVViewer } from '../src/core/rv-viewer';

// ─── Shared fixture ──────────────────────────────────────────────

function makeWorld() {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Root'; scene.add(root);
  const registry = new NodeRegistry();
  const signalStore = new SignalStore();
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const reapply = new SignalReapplyRegistry();

  function registerNodes(): void {
    scene.traverse((n) => {
      if (!n.parent) return;
      registry.registerNode(NodeRegistry.computeNodePath(n), n);
    });
  }

  function ctx(): ComponentContext {
    return {
      registry, signalStore, scene, transportManager, root, reapply,
    } as unknown as ComponentContext;
  }

  return { scene, root, registry, signalStore, transportManager, reapply, registerNodes, ctx };
}

/** Add a signal node under `root` and register it in the store. */
function addSignal(
  world: ReturnType<typeof makeWorld>,
  name: string,
  value: boolean | number,
  plcType = 'PLCOutputBool',
): string {
  const node = new Object3D(); node.name = name; world.root.add(node);
  const path = NodeRegistry.computeNodePath(node);
  world.registry.registerNode(path, node);
  world.signalStore.register(name, path, value, plcType);
  return path;
}

// ─── §9.4 Reconnect trigger ──────────────────────────────────────

/** Minimal adapter: discovery and incoming data are driven by the test. */
class FakeInterface extends BaseIndustrialInterface {
  readonly id = 'fake';
  readonly protocolName = 'Fake';

  discovered: SignalDescriptor[] = [];
  discoveryFails = false;
  sent: Record<string, boolean | number>[] = [];

  protected async doConnect(_settings: InterfaceSettings): Promise<void> { /* instant */ }
  protected doDisconnect(): void { /* nothing to close */ }
  protected sendSignals(signals: Record<string, boolean | number>): void { this.sent.push(signals); }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    if (this.discoveryFails) throw new Error('discovery refused');
    return this.discovered;
  }

  /** Test hook — a protocol callback delivering remote values. */
  receive(signals: Record<string, boolean | number>): void { this.bufferIncoming(signals); }
}

/** A viewer stub with the two things the base class touches: emit + signalStore. */
function makeInterfaceHost(store: SignalStore) {
  const emitter = new EventEmitter();
  const events: string[] = [];
  const viewer = {
    signalStore: store,
    emit: emitter.emit.bind(emitter),
    on: emitter.on.bind(emitter),
    setConnectionState: () => {},
  } as unknown as RVViewer;
  emitter.on('interface-signals-synced', () => events.push('synced'));
  return { viewer, events, emitter };
}

describe('reconnect trigger — interface-signals-synced (plan-427 F2)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function connectFake(opts: { discoveryFails?: boolean } = {}) {
    const store = new SignalStore();
    store.register('Run', '/Root/Run', true, 'PLCOutputBool');
    const host = makeInterfaceHost(store);
    const iface = new FakeInterface();
    iface.discoveryFails = opts.discoveryFails ?? false;
    iface.discovered = [{ name: 'Run', type: 'bool', direction: 'output', initialValue: true }];
    iface.onModelLoaded({} as never, host.viewer);
    await iface.connect({ autoConnect: false } as unknown as InterfaceSettings);
    return { store, host, iface };
  }

  it('does NOT fire on connect alone — the pre-sync stale window stays closed', async () => {
    const { host } = await connectFake();
    // Connected + discovered, but nothing committed to the store yet.
    expect(host.events).toEqual([]);
  });

  it('fires exactly once, on the first incoming flush after connect', async () => {
    const { host, iface } = await connectFake();

    iface.receive({ Run: false });
    iface.onFixedUpdatePre(0.016);
    expect(host.events).toEqual(['synced']);

    // Later traffic must not re-trigger it.
    iface.receive({ Run: true });
    iface.onFixedUpdatePre(0.016);
    expect(host.events).toEqual(['synced']);
  });

  it('a remote value CHANGED during the disconnect is committed BEFORE the sync fires', async () => {
    const { store, host, iface } = await connectFake();
    // Pre-disconnect level still in the store.
    expect(store.get('Run')).toBe(true);

    let valueAtSync: boolean | number | undefined;
    host.emitter.on('interface-signals-synced', () => { valueAtSync = store.get('Run'); });

    // The remote flipped it while we were away.
    iface.receive({ Run: false });
    iface.onFixedUpdatePre(0.016);

    // The sync (and therefore any level re-apply hanging off it) must never see
    // the stale `true` — that is the whole point of anchoring on the commit.
    expect(valueAtSync).toBe(false);
    expect(host.events).toEqual(['synced']);
  });

  it('silent PLC: the timeout fires the sync once', async () => {
    const { host } = await connectFake();
    expect(host.events).toEqual([]);

    vi.advanceTimersByTime(2000);
    expect(host.events).toEqual(['synced']);

    vi.advanceTimersByTime(10_000);
    expect(host.events).toEqual(['synced']);
  });

  it('a flush before the timeout cancels it — never two syncs', async () => {
    const { host, iface } = await connectFake();
    iface.receive({ Run: false });
    iface.onFixedUpdatePre(0.016);
    vi.advanceTimersByTime(10_000);
    expect(host.events).toEqual(['synced']);
  });

  it('a failed discovery emits nothing — no stale replay', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, iface } = await connectFake({ discoveryFails: true });
    vi.advanceTimersByTime(10_000);
    expect(host.events).toEqual([]);

    iface.receive({ Run: false });
    iface.onFixedUpdatePre(0.016);
    expect(host.events).toEqual([]);
    warn.mockRestore();
  });

  it('disconnect closes an open sync window', async () => {
    const { host, iface } = await connectFake();
    iface.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(host.events).toEqual([]);
  });

  it('a reconnect opens a NEW sync window', async () => {
    const { host, iface } = await connectFake();
    iface.receive({ Run: false });
    iface.onFixedUpdatePre(0.016);
    expect(host.events).toEqual(['synced']);

    iface.disconnect();
    await iface.connect({ autoConnect: false } as unknown as InterfaceSettings);
    iface.receive({ Run: true });
    iface.onFixedUpdatePre(0.016);
    expect(host.events).toEqual(['synced', 'synced']);
  });
});

// ─── §9.7 IKPath edge protection ─────────────────────────────────

describe('RVIKPath.SignalStart — replay must not fake a rising edge (F10)', () => {
  function buildPath(startValue: boolean) {
    const world = makeWorld();
    const startPath = addSignal(world, 'PathStart', startValue);
    const pathNode = new Object3D(); pathNode.name = 'Rotobpath'; world.root.add(pathNode);
    world.registerNodes();

    const ik = new RVIKPath(pathNode);
    applySchema(ik as unknown as Record<string, unknown>, RVIKPath.schema, {});
    ik.SignalStart = startPath;
    ik.init(world.ctx());

    const startPathSpy = vi.spyOn(ik, 'startPath').mockImplementation(() => {});
    return { world, ik, startPathSpy, startPath };
  }

  it('a held-true SignalStart replayed after a reset does NOT start the path', () => {
    const { world, ik, startPathSpy } = buildPath(true);
    // Engine reset clears the edge baseline — this is what used to make the
    // replay look like a fresh false→true.
    ik.reset();
    startPathSpy.mockClear();

    world.reapply.reapplyAll();
    ik.fixedUpdate(1 / 60);

    expect(startPathSpy).not.toHaveBeenCalled();
  });

  it('and it re-synchronises the baseline instead', () => {
    const { world, ik, startPathSpy } = buildPath(true);
    ik.reset();
    world.reapply.reapplyAll();

    // Several ticks: the baseline is true, so nothing ever triggers.
    ik.fixedUpdate(1 / 60);
    ik.fixedUpdate(1 / 60);
    expect(startPathSpy).not.toHaveBeenCalled();
  });

  it('a genuine false→true edge AFTER a replay still starts the path', () => {
    const { world, ik, startPathSpy } = buildPath(true);
    ik.reset();
    world.reapply.reapplyAll();
    ik.fixedUpdate(1 / 60);
    startPathSpy.mockClear();

    world.signalStore.set('PathStart', false);
    ik.fixedUpdate(1 / 60);
    world.signalStore.set('PathStart', true);
    ik.fixedUpdate(1 / 60);

    expect(startPathSpy).toHaveBeenCalledTimes(1);
  });

  it('a replay of a LOW SignalStart leaves the baseline low, so the next rise starts', () => {
    const { world, ik, startPathSpy } = buildPath(false);
    ik.reset();
    world.reapply.reapplyAll();
    ik.fixedUpdate(1 / 60);
    startPathSpy.mockClear();

    world.signalStore.set('PathStart', true);
    ik.fixedUpdate(1 / 60);
    expect(startPathSpy).toHaveBeenCalledTimes(1);
  });

  it('dispose() drops the store subscription and the registry slot', () => {
    const { world, ik } = buildPath(true);
    expect(world.reapply.size).toBe(1);
    ik.dispose();
    expect(world.reapply.size).toBe(0);
  });
});

// ─── §9.5 Grip dispose ───────────────────────────────────────────

describe('RVGrip — dispose releases both signal wirings (F6)', () => {
  function buildGrip() {
    const world = makeWorld();
    const pickPath = addSignal(world, 'DoPick', false);
    const placePath = addSignal(world, 'DoPlace', false);
    const gripNode = new Object3D(); gripNode.name = 'Gripper'; world.root.add(gripNode);
    world.registerNodes();

    const grip = new RVGrip(gripNode);
    applySchema(grip as unknown as Record<string, unknown>, RVGrip.schema, {});
    grip.SignalPick = pickPath;
    grip.SignalPlace = placePath;
    grip.init(world.ctx());
    return { world, grip };
  }

  it('registers one re-apply slot per wired signal', () => {
    const { world, grip } = buildGrip();
    expect(world.reapply.size).toBe(2);
    expect(grip.signalPickAddr).not.toBeNull();
    expect(grip.signalPlaceAddr).not.toBeNull();
  });

  it('a held pick level is re-applied after a reset', () => {
    const { world, grip } = buildGrip();
    world.signalStore.set('DoPick', true);
    expect(grip.pickObjects).toBe(true);

    grip.reset();                 // engine reset clears the flags
    expect(grip.pickObjects).toBe(false);

    world.reapply.reapplyAll();
    expect(grip.pickObjects).toBe(true);
  });

  it('dispose() removes the registry slots AND the store subscriptions', () => {
    const { world, grip } = buildGrip();
    grip.dispose();
    expect(world.reapply.size).toBe(0);

    world.signalStore.set('DoPick', true);
    expect(grip.pickObjects).toBe(false);

    // And a later re-apply cannot revive the dead instance either.
    world.reapply.reapplyAll();
    expect(grip.pickObjects).toBe(false);
  });
});

// ─── §9.6 Bidirectional slot ─────────────────────────────────────

describe('RVSceneButtonBase.stateSignal — bidirectional slot stays idempotent', () => {
  function buildButton() {
    const world = makeWorld();
    const statePath = addSignal(world, 'ButtonState', false, 'PLCInputBool');
    const btnNode = new Object3D(); btnNode.name = 'Button'; world.root.add(btnNode);
    world.registerNodes();

    const button = new RVSceneButtonBase(btnNode);
    applySchema(button as unknown as Record<string, unknown>, RVSceneButtonBase.schema, {});
    button.init(world.ctx());
    button.isToggle = true;
    button.setStateSignal(statePath);
    return { world, button };
  }

  it('a replay of the button\'s own last write does not toggle it back', () => {
    const { world, button } = buildButton();
    button.click('operator');
    expect(button.active).toBe(true);

    world.reapply.reapplyAll();
    expect(button.active).toBe(true);

    world.reapply.reapplyAll();
    expect(button.active).toBe(true);
  });

  it('a replay resynchronises optics that drifted from the store', () => {
    const { world, button } = buildButton();
    button.click('operator');
    expect(world.signalStore.get('ButtonState')).toBe(true);

    // Simulate a state that no longer matches the store (e.g. after a reset
    // that restored the visuals but left the signal standing).
    (button as unknown as { _active: boolean })._active = false;

    world.reapply.reapplyAll();
    expect(button.active).toBe(true);
  });

  it('re-wiring the same address does not leak a second slot', () => {
    const { world, button } = buildButton();
    expect(world.reapply.size).toBe(1);
    button.setStateSignal(NodeRegistry.computeNodePath(world.root) + '/ButtonState');
    expect(world.reapply.size).toBe(1);
    button.setStateSignal(null);
    expect(world.reapply.size).toBe(0);
  });
});

// ─── §9.9 ComponentContext matrix ────────────────────────────────

describe('ComponentContext matrix — every construction path carries the registry (F12)', () => {
  afterEach(() => { setActiveSignalReapplyRegistry(null); });

  /** rv_extras for a WebDiagnostics marker bound to `signalPath`. WebDiagnostics
   *  needs no gizmoManager/errorStore, so it initialises on every path. */
  function diagnosticsExtras(signalPath: string): Record<string, Record<string, unknown>> {
    return {
      WebDiagnostics: {
        SignalBool: {
          type: 'ComponentReference',
          path: signalPath,
          componentType: 'realvirtual.PLCOutputBool',
        },
      },
    };
  }

  it('a component created via the runtime-add path registers its slots', () => {
    const world = makeWorld();
    const signalPath = addSignal(world, 'FaultA', false);
    world.registerNodes();

    const node = createRuntimeNode({
      registry: world.registry,
      signalStore: world.signalStore,
      scene: world.scene,
      transportManager: world.transportManager,
      reapply: world.reapply,
    }, {
      parentPath: NodeRegistry.computeNodePath(world.root),
      name: 'RuntimeMarker',
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: diagnosticsExtras(signalPath),
    });

    expect(node).not.toBeNull();
    expect(world.reapply.size).toBe(1);
  });

  it('the runtime-add path falls back to the module slot when no deps carry one', () => {
    const world = makeWorld();
    const signalPath = addSignal(world, 'FaultB', false);
    world.registerNodes();
    setActiveSignalReapplyRegistry(world.reapply);

    createRuntimeNode({
      registry: world.registry,
      signalStore: world.signalStore,
      scene: world.scene,
      transportManager: world.transportManager,
      // deliberately NO reapply — this is the "forgotten producer" case
    }, {
      parentPath: NodeRegistry.computeNodePath(world.root),
      name: 'RuntimeMarker2',
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
      components: diagnosticsExtras(signalPath),
    });

    expect(world.reapply.size).toBe(1);
  });

  it('a placed subtree (processExtras) registers its slots via the module slot', () => {
    const world = makeWorld();
    const signalPath = addSignal(world, 'FaultC', false);
    world.registerNodes();
    setActiveSignalReapplyRegistry(world.reapply);

    const placed = new Object3D();
    placed.name = 'PlacedAsset';
    placed.userData.realvirtual = diagnosticsExtras(signalPath);
    world.root.add(placed);

    const result = processExtras(
      placed, world.registry, world.signalStore, world.transportManager, world.scene,
    );

    expect(result.componentsCreated).toBeGreaterThan(0);
    expect(world.reapply.size).toBe(1);
  });

  it('without an installed registry nothing registers and nothing throws', () => {
    const world = makeWorld();
    const signalPath = addSignal(world, 'FaultD', false);
    world.registerNodes();

    const placed = new Object3D();
    placed.name = 'PlacedAsset2';
    placed.userData.realvirtual = diagnosticsExtras(signalPath);
    world.root.add(placed);

    expect(() => processExtras(
      placed, world.registry, world.signalStore, world.transportManager, world.scene,
    )).not.toThrow();
    expect(world.reapply.size).toBe(0);
  });
});
