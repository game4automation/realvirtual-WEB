// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 §9.5 — the acceptance matrix for the user's own wording:
 * "CONNECT on/off must rebind automatically; the ORDER must not matter."
 *
 * Three orders, one end state. Each runs the whole chain the product runs:
 * ConnectPlugin registers the providers from a CONNECT snapshot
 * (`syncProviders`), the SignalBindingManager relays them onto the element's
 * slots. Only the ORDER of "model loaded" and "CONNECT connected" differs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => resetSlotAuthority());

const SOURCE = 'Src.Run';
const IFACE = 'mqtt-1';

/** The persisted link as the GLB carries it: a NAME, no provider identity. */
const PERSISTED_LINK: SignalMapping = {
  slot: 'Flow.Run', signal: SOURCE, direction: 'plcOutput', enabled: true,
};

function world() {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const manager = new SignalBindingManager(store, registry);
  manager.holdMs = 800;
  const target = scopeSignalName('Conv', 'Flow.Run');

  /** "The model finished loading" — element known, slots resolvable, links applied. */
  const loadModel = (): void => {
    const root = new Object3D();
    root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
    registry.registerNode('Conv', root);
    store.register(target, 'Conv/Flow.Run', false, 'PLCOutputBool');
    manager.applyMappings('Conv', root, [{ ...PERSISTED_LINK }]);
  };

  /** "CONNECT is connected" — the gateway's signals become providers. */
  const connect = (): void => {
    store.register(SOURCE, `__iface__/${SOURCE}`, true, 'PLCOutputBool');
    store.registerSignalProvider({ interfaceId: IFACE, signal: SOURCE }, true);
  };

  /** "CONNECT dropped" — providers stay known, but report disconnected. */
  const disconnect = (): void => {
    store.setSignalProviderConnected({ interfaceId: IFACE }, false);
  };

  const reconnect = (): void => {
    store.setSignalProviderConnected({ interfaceId: IFACE }, true);
  };

  return { store, manager, target, loadModel, connect, disconnect, reconnect };
}

/** The one end state all three orders have to reach. */
function expectLive(w: ReturnType<typeof world>): void {
  expect(w.manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
  expect(w.manager.isLive('Conv')).toBe(true);
  expect(w.store.getBool(w.target)).toBe(true);
}

describe('order-independent rebinding (plan-421 §9.5)', () => {
  it('(a) model first, then CONNECT', () => {
    const w = world();
    w.loadModel();
    w.manager.tick(0.02);
    expect(w.manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('pending');

    w.connect();
    w.manager.tick(0.02);
    expectLive(w);
  });

  it('(b) CONNECT first, then model', () => {
    const w = world();
    w.connect();
    w.manager.tick(0.02);

    w.loadModel();
    w.manager.tick(0.02);
    expectLive(w);
  });

  it('(c) model, CONNECT, disconnect, reconnect', () => {
    const w = world();
    w.loadModel();
    w.connect();
    w.manager.tick(0.02);
    expectLive(w);

    w.disconnect();
    w.manager.tick(0.5);
    expect(w.manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('hold');
    w.manager.tick(0.4);
    expect(w.manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('disconnected');

    w.reconnect();
    w.manager.tick(0.02);
    expectLive(w);
  });

  it('(d) reload in every order lands in the same place', () => {
    // The same persisted link, replayed under both orders — plan-421 keeps the
    // resolution in memory precisely because this repeats for free.
    const first = world();
    first.loadModel();
    first.connect();
    first.manager.tick(0.02);

    const second = world();
    second.connect();
    second.loadModel();
    second.manager.tick(0.02);

    expectLive(first);
    expectLive(second);
  });
});
