// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-omniverse-backend.test.ts — plan-256 WEB tests.
 *
 * The Omniverse backend lives in the private repo (internal tier); it is
 * imported here via the @rv-private alias (resolved to the private folder in
 * dev/vitest). The real NVIDIA streaming library is NOT a dependency, so it is
 * injected as a mock through the backend's StreamingLibLoader seam.
 *
 * Verifies the real AppStreamer surface (connect / sendMessage / stop):
 *   (a) sendDriveValue() builds `{event_type:'setDriveValue',payload:{value}}`
 *       and calls sendMessage; dirty-guard suppresses an unchanged value.
 *   (b) onCustomEvent('driveValueApplied') sets status `streaming`.
 *   (c) dispose() calls AppStreamer.stop().
 *   + repeated three→omniverse→three cycles leave no open stream; missing
 *     library degrades to `waiting`; dispose during in-flight connect stops the
 *     late stream.
 */

import { describe, test, expect, vi } from 'vitest';
import {
  OmniverseBackend,
  type StreamingLib,
  type StreamConnectProps,
} from '@rv-private/render-backends/omniverse-backend';
import {
  RenderBackendController,
  type RenderBackendStatus,
} from '../src/core/render-backend/rv-render-backend';

/**
 * Build a mock streaming lib (connect/sendMessage/stop) + loader. Tracks the
 * open/stopped stream count and captures the last connect props (callbacks +
 * config) and the last sent message.
 */
function makeMockLib(opts: { autoStart?: boolean } = {}) {
  const autoStart = opts.autoStart ?? true;
  let open = 0;
  let lastProps: StreamConnectProps | null = null;
  const sendMessage = vi.fn<(m: string) => void>();
  const connect = vi.fn(async (props: StreamConnectProps) => {
    lastProps = props;
    open += 1;
    // Real NVIDIA API: lifecycle callbacks live inside streamConfig.
    if (autoStart) props.streamConfig.onStart?.();
    return {};
  });
  const stop = vi.fn(() => { if (open > 0) open -= 1; });
  const lib: StreamingLib = {
    AppStreamer: { connect, sendMessage, stop },
    StreamType: { DIRECT: 'direct' },
  };
  return {
    lib,
    loader: async () => lib,
    connect,
    sendMessage,
    stop,
    props: () => lastProps,
    openCount: () => open,
  };
}

describe('OmniverseBackend', () => {
  test('mount() reports connecting → streaming and mounts a <video id="remote-video"> overlay', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const statuses: RenderBackendStatus[] = [];
    const m = makeMockLib();

    const backend = new OmniverseBackend(
      { container, reportStatus: (s) => statuses.push(s) },
      {},
      m.loader,
    );
    await backend.mount();

    expect(statuses).toContain('connecting');
    expect(statuses).toContain('streaming');
    expect(m.connect).toHaveBeenCalledTimes(1);
    // DirectConfig local defaults are set.
    const cfg = m.props()!.streamConfig;
    expect(cfg.videoElementId).toBe('remote-video');
    expect(cfg.audioElementId).toBe('remote-audio');
    expect(cfg.signalingServer).toBe('127.0.0.1');
    expect(cfg.width).toBe(1920);
    // The video + audio overlay is mounted into the container.
    expect(container.querySelector('[data-rv-render-backend="omniverse"]')).not.toBeNull();
    expect(container.querySelector('video#remote-video')).not.toBeNull();
    expect(container.querySelector('audio#remote-audio')).not.toBeNull();

    backend.dispose();
    document.body.removeChild(container);
  });

  test('mount waits for NVIDIA onStart before scene messaging can begin', async () => {
    const container = document.createElement('div');
    const m = makeMockLib({ autoStart: false });
    const backend = new OmniverseBackend(
      { container, reportStatus: () => {} },
      { streamReadyTimeoutSec: 2 },
      m.loader,
    );

    let mounted = false;
    const mounting = backend.mount().then(() => { mounted = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(m.connect).toHaveBeenCalledTimes(1);
    expect(mounted).toBe(false);

    m.props()!.streamConfig.onStart?.({ status: 'success' });
    await mounting;
    expect(mounted).toBe(true);

    const loading = backend.loadGlb('http://localhost:5173/models/test.glb');
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse(m.sendMessage.mock.calls[0][0])).toEqual({
      event_type: 'loadGlbRequest',
      payload: { url: 'http://localhost:5173/models/test.glb', addLights: true },
    });
    m.props()!.streamConfig.onCustomEvent?.({
      event_type: 'loadGlbResult',
      payload: { result: 'success' },
    });
    await loading;
    backend.dispose();
  });

  test('mount reports an explicit error instead of hanging when onStart never arrives', async () => {
    const container = document.createElement('div');
    const statuses: Array<{ status: RenderBackendStatus; detail?: string }> = [];
    const m = makeMockLib({ autoStart: false });
    const backend = new OmniverseBackend(
      { container, reportStatus: (status, detail) => statuses.push({ status, detail }) },
      { streamReadyTimeoutSec: 0.001 },
      m.loader,
    );

    await expect(backend.mount()).resolves.toBeUndefined();
    expect(statuses.at(-1)).toEqual({
      status: 'error',
      detail: 'Omniverse-Stream nicht bereit – keine Messaging-Verbindung',
    });
    backend.dispose();
  });

  test('openedStageResult settles a load when the one-shot loadGlbResult was lost', async () => {
    const container = document.createElement('div');
    const statuses: RenderBackendStatus[] = [];
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: (status) => statuses.push(status) },
      {},
      m.loader,
    );
    await backend.mount();

    const loading = backend.loadGlb('http://localhost:5173/models/test.glb');
    m.props()!.streamConfig.onCustomEvent?.({
      event_type: 'openedStageResult',
      payload: { result: 'success' },
    });

    await expect(loading).resolves.toBeUndefined();
    expect(statuses.at(-1)).toBe('streaming');
    backend.dispose();
  });

  test('clicking the stream sends native Kit viewport coordinates for picking', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: () => {} },
      {},
      m.loader,
    );
    await backend.mount();

    const video = container.querySelector('video#remote-video') as HTMLVideoElement;
    vi.spyOn(video, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 960, bottom: 540,
      width: 960, height: 540, toJSON: () => ({}),
    });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1920 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 1080 });
    video.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 480,
      clientY: 270,
    }));

    expect(JSON.parse(m.sendMessage.mock.calls.at(-1)![0])).toEqual({
      event_type: 'pickAtRequest',
      payload: { x: 960, y: 540 },
    });
    backend.dispose();
  });

  test('(a) sendDriveValue() sends the setDriveValue contract and dirty-guards', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend({ container, reportStatus: () => {} }, {}, m.loader);
    await backend.mount();

    const sent = backend.sendDriveValue(42);
    expect(sent).toBe(true);
    expect(m.sendMessage).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(m.sendMessage.mock.calls[0][0]);
    expect(msg).toEqual({ event_type: 'setDriveValue', payload: { value: 42 } });

    // Dirty-guard: same value → no send.
    expect(backend.sendDriveValue(42)).toBe(false);
    expect(m.sendMessage).toHaveBeenCalledTimes(1);

    // Changed value → send again.
    expect(backend.sendDriveValue(43)).toBe(true);
    expect(m.sendMessage).toHaveBeenCalledTimes(2);

    backend.dispose();
  });

  test('(a2) sendDriveValue() forwards primPath/mode/axis/scale opts', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend({ container, reportStatus: () => {} }, {}, m.loader);
    await backend.mount();

    backend.sendDriveValue(1.5, { primPath: '/World/Joint', mode: 'translate', axis: 2, scale: 0.001 });
    const msg = JSON.parse(m.sendMessage.mock.calls[0][0]);
    expect(msg).toEqual({
      event_type: 'setDriveValue',
      payload: { value: 1.5, primPath: '/World/Joint', mode: 'translate', axis: 2, scale: 0.001 },
    });

    backend.dispose();
  });

  test('sendDriveValue() before connect / after dispose is a no-op', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend({ container, reportStatus: () => {} }, {}, m.loader);
    // Before mount → no streamer.
    expect(backend.sendDriveValue(5)).toBe(false);

    await backend.mount();
    expect(backend.sendDriveValue(5)).toBe(true);

    backend.dispose();
    expect(backend.sendDriveValue(6)).toBe(false);
  });

  test('(b) onCustomEvent(driveValueApplied) sets status streaming', async () => {
    const container = document.createElement('div');
    const statuses: RenderBackendStatus[] = [];
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: (s) => statuses.push(s) },
      {},
      m.loader,
    );
    await backend.mount();
    statuses.length = 0;
    expect(statuses).not.toContain('streaming');

    // Kit → WEB confirmation (object form).
    m.props()!.streamConfig.onCustomEvent?.({ event_type: 'driveValueApplied', payload: { primPath: '/World/Axis' } });
    expect(statuses).toContain('streaming');

    backend.dispose();
  });

  test('(b2) onCustomEvent accepts the JSON-string form and ignores other events', async () => {
    const container = document.createElement('div');
    const statuses: RenderBackendStatus[] = [];
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: (s) => statuses.push(s) },
      {},
      m.loader,
    );
    await backend.mount();
    statuses.length = 0;

    m.props()!.streamConfig.onCustomEvent?.(JSON.stringify({ event_type: 'somethingElse' }));
    expect(statuses).not.toContain('streaming');

    m.props()!.streamConfig.onCustomEvent?.(JSON.stringify({ event_type: 'driveValueApplied', payload: {} }));
    expect(statuses).toContain('streaming');

    backend.dispose();
  });

  test('(b3) Kit selection events forward USD prim paths to WEB', async () => {
    const container = document.createElement('div');
    const onSelectionChanged = vi.fn();
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: () => {} },
      { onSelectionChanged },
      m.loader,
    );
    await backend.mount();

    m.props()!.streamConfig.onCustomEvent?.({
      event_type: 'stageSelectionChanged',
      payload: { prims: ['/World/Model/Factory/Robot/Axis_1/Mesh'] },
    });
    expect(onSelectionChanged).toHaveBeenCalledWith([
      '/World/Model/Factory/Robot/Axis_1/Mesh',
    ]);

    m.props()!.streamConfig.onCustomEvent?.({
      event_type: 'pickAtResult',
      payload: { prims: ['/World/Model/Factory/Robot/Axis_2/Mesh'] },
    });
    expect(onSelectionChanged).toHaveBeenLastCalledWith([
      '/World/Model/Factory/Robot/Axis_2/Mesh',
    ]);

    m.props()!.streamConfig.onCustomEvent?.(JSON.stringify({
      event_type: 'stageSelectionChanged',
      payload: { prims: [] },
    }));
    expect(onSelectionChanged).toHaveBeenLastCalledWith([]);

    backend.dispose();
  });

  test('(c) dispose() calls AppStreamer.stop() and removes the overlay; idempotent', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend({ container, reportStatus: () => {} }, {}, m.loader);
    await backend.mount();
    expect(m.stop).not.toHaveBeenCalled();

    backend.dispose();
    expect(m.stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-rv-render-backend="omniverse"]')).toBeNull();

    // dispose() is idempotent.
    backend.dispose();
    expect(m.stop).toHaveBeenCalledTimes(1);
  });

  test('repeated three→omniverse→three cycles leave no open stream', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const controller = new RenderBackendController();
    controller.registerFactory('omniverse', (ctx) => new OmniverseBackend(ctx, {}, m.loader));

    for (let i = 0; i < 4; i++) {
      await controller.setBackend('omniverse', container);
      expect(controller.backend).toBe('omniverse');
      expect(m.openCount()).toBe(1);

      await controller.setBackend('three');
      expect(controller.backend).toBe('three');
      // Switching back disposed the backend → AppStreamer.stop() closed it.
      expect(m.openCount()).toBe(0);
    }

    controller.dispose();
    expect(m.openCount()).toBe(0);
  });

  test('missing streaming library degrades to waiting, does not throw', async () => {
    const container = document.createElement('div');
    const statuses: RenderBackendStatus[] = [];
    const failingLoader = async (): Promise<StreamingLib> => {
      throw new Error('@nvidia/omniverse-webrtc-streaming-library not installed');
    };
    const backend = new OmniverseBackend(
      { container, reportStatus: (s) => statuses.push(s) },
      {},
      failingLoader,
    );

    await expect(backend.mount()).resolves.toBeUndefined();
    expect(statuses).toContain('waiting');
    expect(statuses).not.toContain('error');

    backend.dispose();
  });

  test('dispose during in-flight connect stops the late stream', async () => {
    const container = document.createElement('div');
    const stop = vi.fn();
    let connectCalled = false;
    let resolveConnect: (v: unknown) => void = () => {};
    const lib: StreamingLib = {
      AppStreamer: {
        connect: () => new Promise((res) => { connectCalled = true; resolveConnect = res; }),
        sendMessage: vi.fn(),
        stop,
      },
      StreamType: { DIRECT: 'direct' },
    };
    const backend = new OmniverseBackend(
      { container, reportStatus: () => {} },
      {},
      async () => lib, // resolves immediately; connect() stays pending
    );

    const mounting = backend.mount();
    const flush = () => new Promise((r) => setTimeout(r, 0));
    await flush();
    await flush();
    expect(connectCalled).toBe(true);

    // Dispose while connect() is still pending, then resolve it late — the
    // backend must stop the late stream.
    backend.dispose();
    resolveConnect({});
    await mounting;

    expect(stop).toHaveBeenCalled();
  });

  test('signalingPort config flows into the DirectConfig', async () => {
    const container = document.createElement('div');
    const m = makeMockLib();
    const backend = new OmniverseBackend(
      { container, reportStatus: () => {} },
      { signalingPort: 55123, mediaPort: 1024 },
      m.loader,
    );
    await backend.mount();
    const cfg = m.props()!.streamConfig;
    expect(cfg.signalingPort).toBe(55123);
    expect(cfg.mediaPort).toBe(1024);

    backend.dispose();
  });
});
