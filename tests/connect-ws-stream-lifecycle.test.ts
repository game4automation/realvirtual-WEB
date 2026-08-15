// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-421 phase 4 / SOL-R1-10 — the whole chain, with NO ConnectPanel open.
 *
 * The unit tests cover the retry loop (§9.1) and the late resolution (§9.2)
 * separately. This one runs them together on the real connect-store, the real
 * SignalStore and the real SignalBindingManager: gateway up → live, gateway
 * gone → socket closed and bindings dropped, gateway back → the plugin's OWN
 * retry loop reconnects and the names-only binding resolves again.
 *
 * Nothing here mounts UI. The user-visible bug was reported with the CONNECT
 * panel closed, and every mechanism involved has to work without it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';

const sockets = vi.hoisted(() => [] as Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock('../src/interfaces/websocket-realtime-interface', () => ({
  WebSocketRealtimeInterface: class {
    setProviderProvenanceEnabled = vi.fn();
    onModelLoaded = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    onFixedUpdatePre = vi.fn();
    onFixedUpdatePost = vi.fn();
    dispose = vi.fn();
    constructor() { sockets.push(this); }
  },
}));

import { ConnectPlugin } from '../src/plugins/connect-plugin';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';
import {
  _resetConnectStore,
  connectToServer,
  getConnectSnapshot,
} from '../src/core/hmi/connect-store';
import type { RVViewer } from '../src/core/rv-viewer';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';

const GATEWAY_INTERFACES = [{
  id: 'mqtt-1',
  type: 'MQTT',
  enabled: true,
  signals: [{ name: 'Src.Run', type: 'PLCOutputBool' }],
}];

let gatewayUp = true;
const plugins: ConnectPlugin[] = [];

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  sockets.length = 0;
  gatewayUp = true;
  _resetConnectStore();
  localStorage.removeItem('rv-connect-autoconnect-optout');
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!gatewayUp) return Promise.reject(new Error('Connection refused'));
    const body = url.includes('/health')
      ? JSON.stringify({ status: 'ok' })
      : url.includes('/config/interfaces')
        ? JSON.stringify(GATEWAY_INTERFACES)
        : JSON.stringify([]);
    return Promise.resolve(new Response(body, {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
  });
});

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetSlotAuthority();
  _resetConnectStore();
  localStorage.removeItem('rv-connect-autoconnect-optout');
});

/** Model side: one conveyor with the persisted, names-only CONNECT link. */
function modelWith(store: SignalStore) {
  const registry = new NodeRegistry();
  const manager = new SignalBindingManager(store, registry);
  const root = new Object3D();
  root.name = 'Conv';
  root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
  registry.registerNode('Conv', root);
  store.register(scopeSignalName('Conv', 'Flow.Run'), 'Conv/Flow.Run', false, 'PLCOutputBool');
  manager.applyMappings('Conv', root, [
    { slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcOutput', enabled: true },
  ]);
  return manager;
}

describe('CONNECT stream + binding lifecycle without a panel (plan-421 phase 4)', () => {
  it('goes live, drops on gateway loss and comes back on its own', async () => {
    const signalStore = new SignalStore();
    const plugin = new ConnectPlugin();
    plugins.push(plugin);
    plugin.init();
    plugin.onModelLoaded({} as LoadResult, {
      signalStore, loadTrust: { trusted: true },
    } as unknown as RVViewer);
    const manager = modelWith(signalStore);

    // 1. The boot probe connects on its own — no Connect click, no panel.
    await advance(0);
    expect(getConnectSnapshot().state).toBe('connected');
    expect(sockets).toHaveLength(1);
    expect(sockets[0].connect).toHaveBeenCalledTimes(1);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');

    // 2. Gateway disappears. The store drops to `error` and empties its
    //    interface list, so the socket closes and the providers go with it.
    gatewayUp = false;
    await connectToServer();
    expect(getConnectSnapshot().state).toBe('error');
    expect(sockets[0].disconnect).toHaveBeenCalledTimes(1);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).not.toBe('live');

    // 3. Gateway comes back. Nobody clicks anything: the retry ladder finds it,
    //    the socket reopens and the names-only binding resolves a second time.
    gatewayUp = true;
    await advance(60_000);
    expect(getConnectSnapshot().state).toBe('connected');
    expect(sockets[0].connect).toHaveBeenCalledTimes(2);
    manager.tick(0.02);
    expect(manager.getBindingLiveness('Conv', 'Flow.Run')).toBe('live');
  });
});
