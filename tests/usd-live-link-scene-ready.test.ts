// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2239 Phase 3 / plugins rule 3 — the live link mounts only a COMPLETE
 * scene. On a real `RVViewer` with a nested placement whose inner asset's bake
 * is held (the shared plan-757 fixture):
 *
 * - `model-loaded` arrives first; the mount waits for `whenSceneReady()` —
 *   no export, no `mountBegin` while the nested placement materialises;
 * - after it, the snapshot holds the nested placement's nodes WITH their full
 *   occurrence-chain addresses (node-identity rules 1, 5);
 * - a model change while waiting never mounts the old model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeMessage, type DecodedMessage, type LiveSyncAck } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import { LiveLinkStore } from '../src/plugins/usd-live-link/live-link-store';
import { exportRuntimeStage, type RuntimeStageInput, type RuntimeStageSnapshot } from '../src/core/usd/runtime-stage-export';
import type { KitLinkClient, KitLinkClientOptions } from '../src/plugins/usd-live-link/kit-link-client';
import { MIN_EXTENSION_VERSION } from '../src/plugins/usd-live-link/livesync-extension';
import {
  CELL_REF_NODE_ID, INNER_URL, OUTER_URL, SLIDE_NODE_ID, bootNestedViewer, documentBytes, plainBytes, type Booted,
} from './helpers/nested-placement-fixture';

type Msg = DecodedMessage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeClient {
  sent: Msg[] = [];
  isReady = false;
  constructor(readonly opts: KitLinkClientOptions) {}
  start() { /* ready() below */ }
  stop() { this.isReady = false; }
  canSendFrame() { return this.isReady; }
  send(data: Uint8Array) { if (!this.isReady) return false; this.sent.push(decodeMessage(data.slice())); return true; }
  async sendWhenDrained(data: Uint8Array, wanted: () => boolean) { return wanted() && this.send(data); }
  ready(ack: LiveSyncAck = { type: 'ready', extVersion: MIN_EXTENSION_VERSION, protocol: 1 }) { this.isReady = true; this.opts.onReady(ack); }
  begins() { return this.sent.filter((m) => m.type === 'mountBegin'); }
}

function attach(b: Booted) {
  const store = new LiveLinkStore({ port: 8775, token: 'tok', rateHz: 30 });
  let client: FakeClient | null = null;
  const inputs: RuntimeStageInput[] = [];
  const snapshots: RuntimeStageSnapshot[] = [];
  const plugin = new UsdLiveLinkPlugin({
    store,
    sessionModule,
    exportStage: async (input) => { inputs.push(input); const s = await exportRuntimeStage(input); snapshots.push(s); return s; },
    compress: async (bytes) => ({ bytes, encoding: 'identity' }),
    createClient: (o) => { client = new FakeClient(o); return client as unknown as KitLinkClient; },
  });
  b.h.viewer.use(plugin);
  plugin.setSyncEnabled(true);
  client!.ready();
  return { store, plugin, client: () => client!, inputs, snapshots };
}

describe('usd-live-link mounts after whenSceneReady (plan-2239 Phase 3, plugins rule 3)', () => {
  let nested: Booted | null = null;
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; nested?.h.dispose(); nested = null; });

  it('a nested placement still materialising: no export until the scene is ready, then its nodes carry their addresses', async () => {
    nested = await bootNestedViewer({ gate: INNER_URL });
    const { h, open, order } = nested;
    const link = attach(nested);
    stop = () => link.plugin.setSyncEnabled(false);
    expect(link.store.state.message).toBe('Waiting for a model');

    await h.viewer.loadModel('doc.glb', { data: await documentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    expect(order[0]).toBe('model-loaded');
    await sleep(80);
    expect(h.viewer.placements.state).toBe('materializing');
    expect(link.inputs, 'no snapshot of an incomplete scene').toHaveLength(0);
    expect(link.client().begins()).toHaveLength(0);
    expect(link.store.state.message).toBe('Waiting for the scene to finish loading…');

    open();
    await vi.waitFor(() => expect(link.client().begins()).toHaveLength(1), { timeout: 10_000 });
    expect(link.inputs).toHaveLength(1);
    const snap = link.snapshots[0];
    const slide = snap.nodes.findIndex((n) => n.name === 'Slide');
    expect(slide, 'the nested placement content is in the snapshot').toBeGreaterThan(0);
    expect(snap.addresses[slide]).toBe(`plc-machine/${CELL_REF_NODE_ID}#${SLIDE_NODE_ID}`);
    expect(link.store.state.prims!.withAddress).toBeGreaterThan(0);
  });

  it('a model change while waiting never mounts the old model', async () => {
    nested = await bootNestedViewer({ gate: INNER_URL });
    const { h } = nested;
    const link = attach(nested);
    stop = () => link.plugin.setSyncEnabled(false);
    await h.viewer.loadModel('doc.glb', { data: await documentBytes([{ id: 'plc-machine', name: 'Machine_1', url: OUTER_URL }]) });
    await sleep(80);
    expect(link.inputs).toHaveLength(0);

    await h.viewer.loadModel('plain.glb', { data: await plainBytes() });
    await vi.waitFor(() => expect(link.client().begins()).toHaveLength(1), { timeout: 10_000 });
    await sleep(80);
    expect(link.inputs).toHaveLength(1);
    const names = link.snapshots[0].nodes.map((n) => n.name);
    expect(names).not.toContain('Machine_1'); // never the old layout …
    expect(names).not.toContain('Slide'); // … nor its nested content
    expect(link.client().begins()).toHaveLength(1);
  });
});
