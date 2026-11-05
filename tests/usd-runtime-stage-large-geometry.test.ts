// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2246 — the live-link session shows a named, readable refusal when the
 * runtime stage cannot be written (`usd-geometry-too-large` with the prim
 * path), never V8's "Invalid string length", and mounts nothing. Real
 * `exportRuntimeStage` with a lowered part limit; fake Kit client.
 */

import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { decodeMessage, type DecodedMessage } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin, type LiveLinkModel } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { exportFailureText } from '../src/plugins/usd-live-link/usd-live-link-session';
import { LiveLinkStore } from '../src/plugins/usd-live-link/live-link-store';
import { UsdExportTooLargeError, setUsdExportLimitsForTests } from '../src/core/usd/usd-export-geometry-split';
import { setUsdPackageLimitForTests } from '../src/core/usd/usd-package-limit';
import type { KitLinkClient, KitLinkClientOptions } from '../src/plugins/usd-live-link/kit-link-client';
import { MIN_EXTENSION_VERSION } from '../src/plugins/usd-live-link/livesync-extension';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

class FakeClient {
  sent: DecodedMessage[] = [];
  isReady = false;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() {}
  stop() { this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) { return wanted() && this.send(data); }
  ready() { this.isReady = true; this.opts.onReady({ type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }); }
}

function model(): LiveLinkModel {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Cell'; scene.add(root);
  const axis = new Object3D(); axis.name = 'Axis'; root.add(axis);
  const body = new Mesh(new BoxGeometry(1, 1, 1, 4, 4, 4), new MeshStandardMaterial()); body.name = 'Body'; axis.add(body);
  const tpl = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial()); tpl.name = 'Box'; root.add(tpl);
  const srcNode = new Object3D(); srcNode.name = 'Source'; root.add(srcNode);
  const source = new RVSource(srcNode); source.spawnParent = root; source.setTemplate(tpl);
  return { root, drives: [{ node: axis }], transportManager: { sources: [source], mus: [], preplacedMUs: [] } } as unknown as LiveLinkModel;
}

describe('plan-2246 — live-link mount refusal', () => {
  it('a named size refusal reads as itself; anything else stays "Export failed: …"', () => {
    const refusal = new UsdExportTooLargeError('usd-geometry-too-large', '/Root/Scenes/Scene/Cell/Body', 900, 100);
    expect(exportFailureText(refusal)).toBe(refusal.message);
    expect(exportFailureText(refusal)).toContain('usd-geometry-too-large');
    expect(exportFailureText(refusal)).toContain('/Root/Scenes/Scene/Cell/Body');
    expect(exportFailureText(new RangeError('Invalid string length'))).toBe('Export failed: Invalid string length');
    const packageRefusal = new UsdExportTooLargeError('usd-package-too-large', 'model.usda', 2048, 1024);
    expect(exportFailureText(packageRefusal)).toBe(packageRefusal.message);
    expect(exportFailureText(packageRefusal)).toContain('2048 bytes');
    expect(exportFailureText(packageRefusal)).toContain('1024 bytes');
  });

  it('mount with an unsplittable geometry: status error with code and prim path, no mount begins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const restore = setUsdExportLimitsForTests({ maxPartChars: 60 });
    try {
      const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
      let client: FakeClient | null = null;
      const viewer = { on: () => () => {} };
      const plugin = new UsdLiveLinkPlugin({
        store, sessionModule,
        compress: async (b) => ({ bytes: b, encoding: 'identity' }),
        createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
      });
      plugin.init(viewer as unknown as RVViewer);
      plugin.onModelLoaded(model() as unknown as LoadResult);
      plugin.setSyncEnabled(true);
      client!.ready();
      await vi.waitFor(() => expect(store.state.status).toBe('error'), { timeout: 10_000 });
      expect(store.state.message).toContain('usd-geometry-too-large');
      expect(store.state.message).toContain('/Root/Scenes/Scene/Cell/Axis/Body');
      expect(store.state.message).not.toContain('Invalid string length');
      expect(client!.sent.map((m) => m.type)).not.toContain('mountBegin');
      plugin.dispose?.();
    } finally {
      restore();
      warn.mockRestore();
    }
  });

  it('package refusal is readable in the session, before compression or mount upload', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const compress = vi.fn(async (bytes: Uint8Array) => ({ bytes, encoding: 'identity' as const }));
    let client: FakeClient | null = null;
    const plugin = new UsdLiveLinkPlugin({
      store, sessionModule, compress,
      createClient: (options) => { client = new FakeClient(options); return client as unknown as KitLinkClient; },
    });
    const restore = setUsdPackageLimitForTests(1);
    try {
      plugin.init({ on: () => () => {} } as unknown as RVViewer);
      plugin.onModelLoaded(model() as unknown as LoadResult);
      plugin.setSyncEnabled(true);
      client!.ready();
      await vi.waitFor(() => expect(store.state.status).toBe('error'), { timeout: 10_000 });
      expect(store.state.message).toContain('usd-package-too-large');
      expect(store.state.message).toContain('1 bytes');
      expect(store.state.message).not.toContain("Failed to construct 'Blob'");
      expect(compress).not.toHaveBeenCalled();
      expect(client!.sent.map((message) => message.type)).not.toContain('mountBegin');
    } finally { plugin.dispose?.(); restore(); }
  });
});
