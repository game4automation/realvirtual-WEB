// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(() => vi.fn()),
  connect: vi.fn(),
  canProbe: vi.fn(async () => true),
  clearReports: vi.fn(),
  hasStoredUrl: vi.fn(() => false),
  isLoopback: vi.fn(() => false),
  sockets: [] as Array<{
    onModelLoaded: ReturnType<typeof vi.fn>;
    onFixedUpdatePre: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  snapshot: {
    state: 'disconnected',
    serverUrl: 'http://localhost:5100',
    interfaces: [],
    interfaceStatus: {},
    gatewayUnreachable: false,
  },
}));

vi.mock('../src/core/hmi/connect-store', () => ({
  subscribeConnectStore: mocks.subscribe,
  getConnectSnapshot: () => mocks.snapshot,
  connectToServer: mocks.connect,
  canSilentlyProbeGateway: mocks.canProbe,
  hasStoredServerUrl: mocks.hasStoredUrl,
  isLoopbackOrigin: mocks.isLoopback,
  isSourceConnectedLive: () => false,
  // `connect-plugin.tsx:173` gained an auto-connect opt-out check after this
  // mock was written, and a `vi.mock` factory is exhaustive — the missing export
  // made both tests throw before reaching a single assertion. `false` is the
  // faithful stand-in: it reproduces exactly the pre-opt-out gating this file
  // was written against, so neither test's statement changes. (plan-375 phase 0)
  hasAutoConnectOptOut: () => false,
  // Same story one plan later: `connect-plugin.tsx` now installs the active-document
  // notifier in `init()` and tears it down in `dispose()`. The real pair wires the
  // PROJECT store and window/document listeners — none of which this file's
  // model-independent lifecycle statements are about — so a no-op is the faithful
  // stand-in, and the exhaustive factory needs both halves or nothing runs at all.
  installConnectActiveDocumentNotifier: () => () => {},
  uninstallConnectActiveDocumentNotifier: () => {},
  // plan-562: the plugin became the ONE owner of the `/status` poll, so the
  // exhaustive factory owes it this export too. It is never called here — the
  // mocked snapshot stays `disconnected`, which is exactly the state in which
  // the poll must issue nothing.
  fetchStatus: vi.fn(async () => undefined),
  // plan-589: the plugin reconciles the model against the gateway's interfaces and
  // owns the report's lifetime — `detachModel()` clears it, so even this
  // model-independent file reaches these three through `dispose()`. The exhaustive
  // factory owes them; `clearReconcileReports` is a spy because the detach
  // statement below asserts on it.
  isModelManagedInterfaceType: () => false,
  reconcileInterfaces: () => ({}),
  clearReconcileReports: mocks.clearReports,
  setConnectLogOpen: vi.fn(),
  requestConnectInterfaceEdit: vi.fn(),
  setAllowWebToPlc: vi.fn(),
}));

vi.mock('../src/interfaces/websocket-realtime-interface', () => ({
  WebSocketRealtimeInterface: class {
    setProviderProvenanceEnabled = vi.fn();
    onModelLoaded = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    onFixedUpdatePre = vi.fn();
    onFixedUpdatePost = vi.fn();
    dispose = vi.fn();
    constructor() { mocks.sockets.push(this); }
  },
}));

import { ConnectPlugin } from '../src/plugins/connect-plugin';

describe('CONNECT plugin model-independent lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sockets.length = 0;
  });

  it('subscribes before a model and does not probe hosted deployments', () => {
    const plugin = new ConnectPlugin();
    plugin.init();
    // Two store observers since plan-562, both model-independent: the boot
    // auto-reconnect loop and the single `/status` poll. What this statement is
    // about is unchanged — the subscription happens BEFORE any model, and it
    // probes nothing on a hosted deployment.
    expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    expect(mocks.canProbe).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.sockets).toHaveLength(0);
    plugin.dispose();
  });

  it('attaches once per model and fully detaches stale model writes on clear', () => {
    const plugin = new ConnectPlugin();
    const signalStore = {
      setConnectionProvider: vi.fn(),
      unregisterSignalProvider: vi.fn(),
      setSignalMeta: vi.fn(),
      registerSignalProvider: vi.fn(),
      onCatalogChanged: vi.fn(() => vi.fn()),
    };
    // plan-386 F17: onModelLoaded refuses untrusted loads before touching the
    // stream — the mock must present a trusted load context to exercise the
    // attach/detach lifecycle at all.
    // plan-589: attaching a model also subscribes the reconcile triggers via
    // `viewer.on`, so the viewer stand-in owes an event bus that hands back an
    // unsubscribe — the detach has to be able to call it.
    const viewer = { signalStore, loadTrust: { trusted: true }, on: vi.fn(() => vi.fn()) };
    const result = {};
    plugin.init();
    plugin.onModelLoaded(result as never, viewer as never);
    expect(mocks.sockets).toHaveLength(1);
    expect(mocks.sockets[0].onModelLoaded).toHaveBeenCalledOnce();

    const offTrigger = viewer.on.mock.results[0].value as ReturnType<typeof vi.fn>;
    mocks.clearReports.mockClear();

    plugin.onModelCleared(viewer as never);
    expect(mocks.sockets[0].dispose).toHaveBeenCalledOnce();
    // plan-589: the report is a statement about THIS model, so detaching takes it
    // with it — along with the trigger subscription that would keep rebuilding it.
    expect(mocks.clearReports).toHaveBeenCalledOnce();
    expect(offTrigger).toHaveBeenCalledOnce();
    plugin.onFixedUpdatePre(1 / 60);
    expect(mocks.sockets[0].onFixedUpdatePre).not.toHaveBeenCalled();

    plugin.onModelLoaded(result as never, viewer as never);
    expect(mocks.sockets).toHaveLength(2);
    expect(mocks.snapshot.state).toBe('disconnected');
    plugin.dispose();
  });
});
