// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import React, { lazy, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RVViewerProvider, useViewer } from '../src/hooks/use-viewer';
import { LeftPanelManager } from '../src/core/hmi/left-panel-manager';
import { LazyPanelBoundary } from '../src/core/hmi/LazyPanelBoundary';
import * as connect from '../src/core/hmi/connect-store';
import { markConnectPanelCommitted, resetConnectPanelReadinessForTests, whenConnectPanelCommitted } from '../src/core/hmi/connect-panel-readiness';
import { ConnectPanelHost as Host, setConnectPanelLoaderForTests } from '../src/core/hmi/ConnectPanelHost';
import type { RVViewer } from '../src/core/rv-viewer';

vi.mock('../src/core/hmi/connect-store', async (original) => {
  const actual = await original<typeof import('../src/core/hmi/connect-store')>();
  return {
    ...actual,
    ensureInterfaceTypes: vi.fn(async () => undefined),
    reloadConnectBridges: vi.fn(actual.reloadConnectBridges),
    requestConnectInterfaceEdit: vi.fn(actual.requestConnectInterfaceEdit),
  };
});
vi.mock('../src/core/hmi/ViewportFrame', () => ({ ViewportFrame: () => <div /> }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only the implementation chunk is substituted. The host, boundary, store and
// edit request API are real. The fixture consumes the request as the real panel does.
function TestPanel() {
  const viewer = useViewer();
  const panel = useSyncExternalStore(viewer.leftPanelManager.subscribe, viewer.leftPanelManager.getSnapshot);
  const snap = useSyncExternalStore(connect.subscribeConnectStore, connect.getConnectSnapshot);
  const [editing, setEditing] = useState<string | null>(null);
  useLayoutEffect(() => { markConnectPanelCommitted(); }, []);
  useEffect(() => {
    if (!snap.editInterfaceId) return;
    setEditing(snap.editInterfaceId);
    connect.requestConnectInterfaceEdit(null);
  }, [snap.editInterfaceId]);
  if (panel.activePanel !== 'connect') return null;
  return <div data-testid="test-connect-panel">{editing && <div role="dialog" aria-label={`Edit ${editing}`} />}</div>;
}

let gate: ReturnType<typeof deferred<{ ConnectPanel: typeof TestPanel }>>;
let imports: ReturnType<typeof vi.fn>;
let viewer: RVViewer;
let interfaces: connect.ConnectInterface[];

beforeEach(async () => {
  localStorage.clear();
  connect._resetConnectStore();
  resetConnectPanelReadinessForTests();
  vi.clearAllMocks();
  interfaces = [];
  gate = deferred();
  imports = vi.fn(() => gate.promise);
  setConnectPanelLoaderForTests(imports as never);
  viewer = {
    leftPanelManager: new LeftPanelManager(), signalStore: null, registry: null,
    loadTrust: { trusted: true }, lastLoadResult: null, getPlugin: () => undefined,
  } as unknown as RVViewer;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = url.endsWith('/health') ? { status: 'ok', version: '1.0.0', build: 1 }
      : url.endsWith('/config/interfaces') ? interfaces
      : /\/config\/(mirrors|mappings)$/.test(url) ? []
      : url.endsWith('/interface-types') ? { types: [{ type: 'MQTT', label: 'MQTT', description: '', defaults: {} }] }
      : url.includes('/status') ? { interfaces: [] } : null;
    return new Response(body === null ? '' : JSON.stringify(body), {
      status: body === null ? 404 : 200, headers: { 'Content-Type': 'application/json' },
    });
  }));
});
afterEach(() => {
  cleanup();
  connect._resetConnectStore();
  resetConnectPanelReadinessForTests();
  setConnectPanelLoaderForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});
function mount() { return render(<RVViewerProvider value={viewer}><Host /></RVViewerProvider>); }
async function open() { await act(async () => { viewer.leftPanelManager.open('connect', 360); }); }
async function close() { await act(async () => { viewer.leftPanelManager.close('connect'); }); }
async function loaded() { await act(async () => { gate.resolve({ ConnectPanel: TestPanel }); }); }
async function connected() {
  await act(async () => {
    connect.setServerUrl('http://127.0.0.1:59999');
    await connect.connectToServer();
  });
  expect(connect.getConnectSnapshot().state).toBe('connected');
}

describe('ConnectPanelHost boot and preload', () => {
  it('loads the real panel for a closed-panel edit request and consumes the request', async () => {
    interfaces = [{
      id: 'plc-1', type: 'MQTT', enabled: true, signals: [],
      brokerUrl: 'mqtt://plc-1:1883',
    }];
    mount();
    await connected();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    expect(viewer.leftPanelManager.getSnapshot().activePanel).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(connect.getConnectSnapshot().interfaces).toMatchObject([{ id: 'plc-1' }]);
    await act(async () => { connect.requestConnectInterfaceEdit('plc-1'); });
    expect(connect.getConnectSnapshot().editInterfaceId).toBe('plc-1');
    const actual = await vi.importActual<typeof import('../src/core/hmi/ConnectPanel')>(
      '../src/core/hmi/ConnectPanel',
    );
    await act(async () => { gate.resolve({ ConnectPanel: actual.ConnectPanel }); });
    await waitFor(() => expect(connect.getConnectSnapshot().editInterfaceId).toBeNull());
    // The real panel consumes requests while closed, then renders its dialog on open.
    expect(viewer.leftPanelManager.getSnapshot().activePanel).toBeNull();
    await open();
    const dialog = await screen.findByRole('dialog', { name: 'Edit MQTT Interface' });
    expect((within(dialog).getByRole('textbox', { name: 'Broker URL' }) as HTMLInputElement).value)
      .toBe('mqtt://plc-1:1883');
    await waitFor(() => expect(connect.getConnectSnapshot().editInterfaceId).toBeNull());
    expect(vi.mocked(connect.requestConnectInterfaceEdit).mock.calls.filter(([id]) => id === null)).toHaveLength(1);
    expect(imports).toHaveBeenCalledTimes(1);
  });

  it('ensures interface types while unloaded, on state and availableTypes changes', async () => {
    mount();
    expect(connect.ensureInterfaceTypes).toHaveBeenCalledTimes(1);
    expect(imports).not.toHaveBeenCalled();
    await connected();
    const calls = vi.mocked(connect.ensureInterfaceTypes).mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    await act(async () => { await connect.fetchInterfaceTypes(); });
    expect(connect.ensureInterfaceTypes).toHaveBeenCalledTimes(calls + 1);
    expect(screen.queryByTestId('test-connect-panel')).toBeNull();
  });

  it('loads for a closed-panel edit request and consumes it exactly once', async () => {
    mount();
    expect(imports).not.toHaveBeenCalled();
    await act(async () => { connect.requestConnectInterfaceEdit('plc-1'); });
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    expect(connect.getConnectSnapshot().editInterfaceId).toBe('plc-1');
    await loaded();
    await waitFor(() => expect(connect.getConnectSnapshot().editInterfaceId).toBeNull());
    await open();
    expect(await screen.findByRole('dialog', { name: 'Edit plc-1' })).toBeTruthy();
    await close();
    await open();
    expect(screen.getByRole('dialog', { name: 'Edit plc-1' })).toBeTruthy();
    expect(vi.mocked(connect.requestConnectInterfaceEdit).mock.calls.filter(([id]) => id === null)).toHaveLength(1);
  });

  it('connected preloads once without UI and loads bridges once before any panel mount', async () => {
    mount();
    await connected();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    expect(connect.reloadConnectBridges).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('lazy-panel-loading')).toBeNull();
    expect(screen.queryByTestId('test-connect-panel')).toBeNull();
    await act(async () => { connect.setServerUrl(connect.getConnectSnapshot().serverUrl); });
    expect(imports).toHaveBeenCalledTimes(1);
    await loaded();
    expect(screen.queryByTestId('test-connect-panel')).toBeNull();
    await open();
    expect(await screen.findByTestId('test-connect-panel')).toBeTruthy();
    expect(connect.reloadConnectBridges).toHaveBeenCalledTimes(1);
  });

  it('mounting the real implementation after connected preload does not reload bridges', async () => {
    mount();
    await connected();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    expect(connect.reloadConnectBridges).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(connect.getConnectBridges()).toMatchObject({
      supported: true, mirrors: [], mappings: [],
    }));
    const bridgeRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) =>
      /\/config\/(mirrors|mappings)$/.test(String(input instanceof Request ? input.url : input)),
    );
    expect(bridgeRequests()).toHaveLength(2);
    const actual = await vi.importActual<typeof import('../src/core/hmi/ConnectPanel')>(
      '../src/core/hmi/ConnectPanel',
    );
    await act(async () => { gate.resolve({ ConnectPanel: actual.ConnectPanel }); });
    expect(screen.queryByText('realvirtual CONNECT')).toBeNull();
    await open();
    expect(await screen.findByText('realvirtual CONNECT')).toBeTruthy();
    expect(connect.reloadConnectBridges).toHaveBeenCalledTimes(1);
    expect(bridgeRequests()).toHaveLength(2);
  });

  it.each(['pointerEnter', 'focus'] as const)('the real toolbar button preloads once on %s', async (event) => {
    const { ConnectPlugin } = await import('../src/plugins/connect-plugin');
    const Button = new ConnectPlugin().slots.find((slot) => slot.slot === 'activity-bar')!.component;
    render(<RVViewerProvider value={viewer}><Host /><Button viewer={viewer} /></RVViewerProvider>);
    const button = screen.getByRole('button', { name: 'realvirtual CONNECT' });
    fireEvent[event](button);
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    fireEvent.pointerEnter(button);
    fireEvent.focus(button);
    await act(async () => { await Promise.resolve(); });
    expect(imports).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('lazy-panel-loading')).toBeNull();
    expect(screen.queryByTestId('test-connect-panel')).toBeNull();
    await loaded();
    expect(screen.queryByTestId('test-connect-panel')).toBeNull();
  });
});

describe('ConnectPanelHost import failures', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('hides a preload failure, shows an open failure and retries on reopen (F8)', async () => {
    mount();
    const { preloadConnectPanel } = await import('../src/core/hmi/ConnectPanelHost');
    const preload = preloadConnectPanel();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    await act(async () => { gate.reject(new Error('offline chunk')); await preload; });
    expect(screen.queryByTestId('lazy-panel-error')).toBeNull();
    await open();
    expect(await screen.findByTestId('lazy-panel-error')).toBeTruthy();
    await close();
    expect(screen.queryByTestId('lazy-panel-error')).toBeNull();
    gate = deferred();
    await open();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(3));
    await loaded();
    expect(await screen.findByTestId('test-connect-panel')).toBeTruthy();
    expect(screen.queryByTestId('lazy-panel-error')).toBeNull();
  });

  it('closing during loading hides both fallback and a subsequent rejection', async () => {
    mount();
    await open();
    expect(screen.getByTestId('lazy-panel-loading')).toBeTruthy();
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    await close();
    expect(screen.queryByTestId('lazy-panel-loading')).toBeNull();
    await act(async () => { gate.reject(new Error('late rejection')); });
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.queryByTestId('lazy-panel-error')).toBeNull();
    await expect(whenConnectPanelCommitted()).resolves.toBeUndefined();
  });

  it('LazyPanelBoundary still shows fallback and error when visible is omitted', async () => {
    const pending = deferred<{ default: typeof TestPanel }>();
    const Panel = lazy(() => pending.promise);
    render(<LazyPanelBoundary label="Other panel"><Panel /></LazyPanelBoundary>);
    expect(screen.getByTestId('lazy-panel-loading')).toBeTruthy();
    await act(async () => { pending.reject(new Error('other chunk')); });
    expect(await screen.findByTestId('lazy-panel-error')).toBeTruthy();
  });
});

it('the real RecordingHmiShell cannot acknowledge its first capture before the delayed panel commits', async () => {
  const { RecordingHmiShell } = await import('../src/core/hmi/App');
  const recording = await import('../src/core/engine/rv-recording-hmi');
  const { UIPluginRegistry } = await import('../src/core/rv-ui-registry');
  viewer = { ...viewer, uiRegistry: new UIPluginRegistry() } as RVViewer;
  viewer.leftPanelManager.open('connect', 360);
  recording._resetRecordingHmi();
  try {
    render(<RVViewerProvider value={viewer}><RecordingHmiShell /></RVViewerProvider>);
    await waitFor(() => expect(imports).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('lazy-panel-loading')).toBeTruthy();
    let settled = false;
    const result = recording.captureHmiSettle(0).then((value) => { settled = true; return value; });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(settled).toBe(false);
    await loaded();
    await act(async () => { await result; });
    expect(screen.getByTestId('test-connect-panel')).toBeTruthy();
    expect(settled).toBe(true);
    expect((await result).ackMs).toBeGreaterThanOrEqual(0);
  } finally {
    cleanup();
    recording._resetRecordingHmi();
  }
});
