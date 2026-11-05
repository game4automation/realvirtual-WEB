// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-637 — KitLinkClient (and the plugin on top of it) against a fake
 * WebSocket that replays real browser event sequences: no attempt before the
 * click, `hello` first, backpressure, reconnect → new mount + full state,
 * fatal close codes, dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { installFakeWebSocket, type FakeWebSocket, type FakeWebSocketInstall } from './helpers/fake-websocket';
import {
  KitLinkClient, KIT_CLOSE, foreignPortMessage, probeLiveSyncPort, probeUrlFor,
} from '../src/plugins/usd-live-link/kit-link-client';
import { decodeMessage, type DecodedMessage } from '../src/plugins/usd-live-link/livesync-protocol';
import { UsdLiveLinkPlugin, type LiveLinkModel } from '../src/plugins/usd-live-link/usd-live-link-plugin';
import * as sessionModule from '../src/plugins/usd-live-link/usd-live-link-session';
import {
  LIVE_LINK_NOT_REACHABLE_RETRYING, LIVESYNC_DEFAULT_PORT, LIVESYNC_LEGACY_DEFAULT_PORT, LiveLinkStore,
  loadLiveLinkSettings, migrateStoredPort,
} from '../src/plugins/usd-live-link/live-link-store';
import { USD_LIVE_LINK_SETTINGS_KEY } from '../src/core/hmi/rv-storage-keys';
import { describeLiveLink, describeTextureNotice, showsTroubleshooting } from '../src/plugins/usd-live-link/UsdToolMenu';
import type { RuntimeStageSnapshot } from '../src/core/usd/runtime-stage-export';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

let fake: FakeWebSocketInstall;
beforeEach(() => { fake = installFakeWebSocket(); });
afterEach(() => { fake.restore(); vi.useRealTimers(); });

/** Port probe stand-ins: what `fetch` does for each kind of port (never the real network). */
const nothingListens = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;

/** Capture what the page sends as decoded messages / parsed JSON (copies: frame buffers are reused). */
function capture(ws: FakeWebSocket): Array<DecodedMessage | Record<string, unknown>> {
  const out: Array<DecodedMessage | Record<string, unknown>> = [];
  ws.send.mockImplementation(((data: string | Uint8Array) => {
    out.push(typeof data === 'string' ? JSON.parse(data) : decodeMessage(data.slice()));
  }) as never);
  return out;
}

function client(overrides: Partial<ConstructorParameters<typeof KitLinkClient>[0]> = {}) {
  const events: string[] = [];
  const c = new KitLinkClient({
    url: 'ws://127.0.0.1:8765', token: 'tok', rateHz: 30,
    onReady: () => events.push('ready'),
    onAck: (a) => events.push(`ack:${a.type}`),
    onDisconnected: (r, retry, code) => events.push(`down:${retry}${code === undefined ? '' : `:${code}`}`),
    retryDelay: () => 0,
    fetch: nothingListens,
    ...overrides,
  });
  return { c, events };
}

describe('usd-live-link KitLinkClient', () => {
  it('never connects before start()', () => {
    client();
    expect(fake.instances).toHaveLength(0);
  });

  it('sends hello first and nothing else before ready', () => {
    const { c, events } = client();
    c.start();
    const ws = fake.last;
    const sent = capture(ws);
    expect(c.send(new Uint8Array([6, 0, 0, 0, 0]))).toBe(false);
    ws.open();
    expect(sent).toEqual([{ v: 1, token: 'tok', client: 'realvirtual-web', rateHz: 30 }]);
    expect(c.send(new Uint8Array([6, 0, 0, 0, 0]))).toBe(false); // authenticated, not ready yet
    ws.message({ type: 'ready' });
    expect(events).toEqual(['ready']);
    expect(c.send(new Uint8Array([6, 1, 0, 0, 0]))).toBe(true);
  });

  it('backpressure: no frames while the send buffer is full; large sends wait for it to drain', async () => {
    const { c } = client({ maxBufferedBytes: 100 });
    c.start();
    const ws = fake.last as FakeWebSocket & { bufferedAmount: number };
    ws.open();
    ws.message({ type: 'ready' });
    ws.bufferedAmount = 500;
    expect(c.canSendFrame()).toBe(false);
    let done = false;
    const p = c.sendWhenDrained(new Uint8Array(4), () => true).then((ok) => { done = ok; });
    await new Promise((r) => setTimeout(r, 30));
    expect(done).toBe(false);
    ws.bufferedAmount = 0;
    await p;
    expect(done).toBe(true);
    expect(c.canSendFrame()).toBe(true);
  });

  it('retries after a lost connection and reports ready again', async () => {
    const { c, events } = client();
    c.start();
    fake.last.open();
    fake.last.message({ type: 'ready' });
    fake.last.serverClose(1006);
    expect(events).toEqual(['ready', 'down:true:1006']);
    await new Promise((r) => setTimeout(r, 5));
    expect(fake.instances).toHaveLength(2);
    fake.last.open();
    fake.last.message({ type: 'ready' });
    expect(events).toEqual(['ready', 'down:true:1006', 'ready']);
  });

  it('stops retrying on a wrong token or a refused origin', async () => {
    for (const code of [KIT_CLOSE.AUTH, KIT_CLOSE.ORIGIN]) {
      const { c, events } = client();
      c.start();
      const before = fake.instances.length;
      fake.last.open();
      fake.last.serverClose(code);
      await new Promise((r) => setTimeout(r, 5));
      expect(events).toEqual([`down:false:${code}`]);
      expect(fake.instances.length).toBe(before);
      expect(c.phase).toBe('stopped');
    }
  });

  it('stop() closes the socket and silences everything after it', async () => {
    const { c, events } = client();
    c.start();
    const ws = fake.last;
    ws.open();
    ws.message({ type: 'ready' });
    c.stop();
    expect(ws.close).toHaveBeenCalled();
    ws.serverClose(1006);
    await new Promise((r) => setTimeout(r, 5));
    expect(events).toEqual(['ready']);
    expect(fake.instances).toHaveLength(1);
  });
});

// ── plugin on top of the client ──

function fakeModel(): LiveLinkModel {
  const scene = new Scene();
  const root = new Object3D(); root.name = 'Root';
  const axis = new Object3D(); axis.name = 'Axis';
  scene.add(root); root.add(axis);
  return {
    root,
    registry: new NodeRegistry(),
    drives: [{ node: axis }],
    transportManager: { sources: [], mus: [], preplacedMUs: [] },
  } as unknown as LiveLinkModel;
}

function snapshotOf(model: LiveLinkModel, texturesSkipped = 0): RuntimeStageSnapshot {
  const nodes = [model.root, model.root.children[0]];
  return {
    usdz: new Uint8Array([1, 2, 3]),
    nodes,
    primPaths: ['/Root/Scenes/Scene/Root', '/Root/Scenes/Scene/Root/Axis'],
    indexOf: new Map(nodes.map((n, i) => [n, i])),
    templates: [],
    identities: nodes.map(() => undefined),
    addresses: nodes.map(() => null),
    templateAddresses: [],
    preplaced: [],
    exporterWarnings: 0,
    texturesConverted: 0,
    texturesSkipped,
  };
}

function fakeViewer() {
  const handlers = new Map<string, () => void>();
  return {
    on: (ev: string, cb: () => void) => { handlers.set(ev, cb); return () => handlers.delete(ev); },
    emit: (ev: string) => handlers.get(ev)?.(),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('usd-live-link plugin over the client', () => {
  it('reconnect → new mount + full state', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const model = fakeModel();
    const plugin = new UsdLiveLinkPlugin({
      store,
      sessionModule,
      exportStage: async (input) => {
        expect(input.registry).toBe(model.registry);
        return snapshotOf(model);
      },
      compress: async (b) => ({ bytes: b, encoding: 'identity' }),
      createClient: (o) => new KitLinkClient({ ...o, retryDelay: () => 0, fetch: nothingListens }),
    });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.onModelLoaded(model as unknown as LoadResult);
    plugin.setSyncEnabled(true);

    const ws1 = fake.last;
    const sent1 = capture(ws1);
    ws1.open();
    ws1.message({ type: 'ready' });
    await flush();
    const begin1 = sent1.find((m) => (m as DecodedMessage).type === 'mountBegin') as Extract<DecodedMessage, { type: 'mountBegin' }>;
    expect(begin1).toBeDefined();
    ws1.message({ type: 'mounted', session: begin1.session });
    expect(store.state.status).toBe('live');
    const full1 = sent1.filter((m) => (m as DecodedMessage).type === 'frame');
    expect(full1).toHaveLength(1);

    ws1.serverClose(1006);
    expect(store.state.status).toBe('connecting');
    await flush();
    const ws2 = fake.last;
    expect(ws2).not.toBe(ws1);
    const sent2 = capture(ws2);
    ws2.open();
    ws2.message({ type: 'ready' });
    await flush();
    const begin2 = sent2.find((m) => (m as DecodedMessage).type === 'mountBegin') as Extract<DecodedMessage, { type: 'mountBegin' }>;
    expect(begin2.session).toBeGreaterThan(begin1.session);
    ws2.message({ type: 'mounted', session: begin2.session });
    const frames = sent2.filter((m) => (m as DecodedMessage).type === 'frame') as Array<Extract<DecodedMessage, { type: 'frame' }>>;
    expect(frames).toHaveLength(1);
    expect(frames[0].session).toBe(begin2.session);
    expect(frames[0].nodes.map((n) => n.index)).toEqual([1]); // full state after the reconnect
  });

  it('skipped textures reach the store and the menu hint; switching off clears them', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const model = fakeModel();
    const plugin = new UsdLiveLinkPlugin({
      store,
      sessionModule,
      exportStage: async () => snapshotOf(model, 3),
      compress: async (b) => ({ bytes: b, encoding: 'identity' }),
      createClient: (o) => new KitLinkClient({ ...o, retryDelay: () => 0, fetch: nothingListens }),
    });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.onModelLoaded(model as unknown as LoadResult);
    plugin.setSyncEnabled(true);
    const ws = fake.last;
    const sent = capture(ws);
    ws.open();
    ws.message({ type: 'ready' });
    await flush();
    const begin = sent.find((m) => (m as DecodedMessage).type === 'mountBegin') as Extract<DecodedMessage, { type: 'mountBegin' }>;
    ws.message({ type: 'mounted', session: begin.session });
    expect(store.state.status).toBe('live');
    expect(store.state.texturesSkipped).toBe(3);
    expect(describeTextureNotice(store.state)).toBe('3 textures skipped (not exportable)');
    expect(describeTextureNotice({ ...store.state, texturesSkipped: 1 })).toBe('1 texture skipped (not exportable)');
    plugin.setSyncEnabled(false);
    expect(store.state.texturesSkipped).toBeUndefined();
    expect(describeTextureNotice(store.state)).toBeNull();
  });

  it('Isaac Sim not running: the first attempt says Connecting, every retry says why (amber) and links the README', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const plugin = new UsdLiveLinkPlugin({
      store,
      sessionModule,
      createClient: (o) => new KitLinkClient({ ...o, retryDelay: () => 0, fetch: nothingListens }),
    });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.setSyncEnabled(true);
    expect(store.state.attempt).toBe(1);
    expect(describeLiveLink(store.state, true).text).toBe('Connecting…');
    expect(showsTroubleshooting(store.state)).toBe(false);
    fake.last.serverClose(1006); // nothing listens on the port
    expect(store.state.status).toBe('connecting');
    expect(store.state.attempt).toBe(2);
    expect(describeLiveLink(store.state, true).text).toBe(LIVE_LINK_NOT_REACHABLE_RETRYING);
    expect(showsTroubleshooting(store.state)).toBe(true);
    await flush();
    fake.last.serverClose(KIT_CLOSE.BUSY);
    expect(store.state.attempt).toBe(3);
    expect(describeLiveLink(store.state, true).text).toBe('Another viewer is already connected to Isaac Sim — retrying…');
    await flush();
    // A `ready` ends the retry state.
    fake.last.open();
    fake.last.message({ type: 'ready' });
    expect(store.state.attempt).toBeUndefined();
    plugin.setSyncEnabled(false);
    expect(store.state.status).toBe('off');
    expect(store.state.message).toBeUndefined();
  });

  it('a refused token is an error; a changed token restarts the link, switching off clears it', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'wrong', rateHz: 30 });
    const plugin = new UsdLiveLinkPlugin({
      store,
      sessionModule,
      createClient: (o) => new KitLinkClient({ ...o, retryDelay: () => 0, fetch: nothingListens }),
    });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.setSyncEnabled(true);
    fake.last.open();
    fake.last.serverClose(KIT_CLOSE.AUTH);
    expect(store.state.status).toBe('error');
    const before = fake.instances.length;
    plugin.commitToken('wrong'); // unchanged: nothing happens
    expect(fake.instances.length).toBe(before);
    plugin.commitToken('right');
    expect(fake.instances.length).toBe(before + 1);
    expect(store.state.status).toBe('connecting');
    plugin.setSyncEnabled(false);
    expect(store.state.status).toBe('off');
  });

  it('dispose closes the socket', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    const plugin = new UsdLiveLinkPlugin({ store, sessionModule });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.setSyncEnabled(true);
    const ws = fake.last;
    ws.open();
    plugin.dispose();
    expect(ws.close).toHaveBeenCalled();
    expect(store.state.status).toBe('off');
  });
});

// ── port collision (another program on the port) ──

type ProbeInit = RequestInit & { mode?: RequestMode };

/** A `fetch` that records its calls and answers per request mode. */
function probeFetch(answer: (init: ProbeInit) => Promise<Response>) {
  const calls: Array<{ url: string; mode?: RequestMode }> = [];
  const f = ((url: string, init: ProbeInit = {}) => {
    calls.push({ url, mode: init.mode });
    return answer(init);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const livesyncAnswers = () => probeFetch(() => Promise.resolve(new Response(JSON.stringify({ service: 'realvirtual.livesync', version: '0.2.1', protocol: 1 }))));
/** DeskAgent-like: answers HTTP, no CORS header → the CORS request fails, the opaque one resolves. */
const foreignAnswers = () => probeFetch((init) => (init.mode === 'cors'
  ? Promise.reject(new TypeError('Failed to fetch'))
  : Promise.resolve(new Response(null, { status: 200 }))));
const nobodyAnswers = () => probeFetch(() => Promise.reject(new TypeError('Failed to fetch')));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('usd-live-link port probe', () => {
  it('derives the probe URL from the socket URL', () => {
    expect(probeUrlFor('ws://127.0.0.1:8775')).toBe('http://127.0.0.1:8775/realvirtual-livesync');
    expect(probeUrlFor('wss://host.example:9000/x?y=1')).toBe('https://host.example:9000/realvirtual-livesync');
    expect(probeUrlFor('http://127.0.0.1:8775')).toBeNull();
    expect(probeUrlFor('not a url')).toBeNull();
  });

  it('classifies livesync, a foreign server and an empty port', async () => {
    const url = 'http://127.0.0.1:8775/realvirtual-livesync';
    const live = livesyncAnswers();
    expect(await probeLiveSyncPort(url, live.f)).toBe('livesync');
    expect(live.calls.map((c) => c.mode)).toEqual(['cors']);

    const foreign = foreignAnswers();
    expect(await probeLiveSyncPort(url, foreign.f)).toBe('foreign');
    expect(foreign.calls.map((c) => c.mode)).toEqual(['cors', 'no-cors']);

    // Readable JSON of another service (CORS allowed) is foreign too.
    const otherJson = probeFetch(() => Promise.resolve(new Response(JSON.stringify({ service: 'deskagent' }))));
    expect(await probeLiveSyncPort(url, otherJson.f)).toBe('foreign');
    const html = probeFetch(() => Promise.resolve(new Response('<html></html>')));
    expect(await probeLiveSyncPort(url, html.f)).toBe('foreign');

    // Nothing listening — or LNA / mixed content blocked both requests — is never foreign.
    expect(await probeLiveSyncPort(url, nobodyAnswers().f)).toBe('none');
  });

  it('a hanging port times out as "none" (unsure → keep retrying)', async () => {
    const hang = probeFetch(() => new Promise<Response>(() => { /* never */ }));
    expect(await probeLiveSyncPort('http://127.0.0.1:8775/realvirtual-livesync', hang.f, 20)).toBe('none');
  });

  it('foreign server: stops after the first failure with the port in the message — no retry storm', async () => {
    const probe = foreignAnswers();
    const reasons: string[] = [];
    const c = new KitLinkClient({
      url: 'ws://127.0.0.1:8765', token: 'tok', rateHz: 30,
      onReady: () => {}, onAck: () => {},
      onDisconnected: (r, retry) => reasons.push(`${retry}:${r}`),
      retryDelay: () => 60,
      fetch: probe.f,
    });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    c.start();
    fake.last.refuse(); // DeskAgent answers the upgrade with 403 → the page sees 1006 before open
    await wait(20);
    expect(c.phase).toBe('stopped');
    expect(reasons).toHaveLength(2);
    expect(reasons[0]?.startsWith('true:')).toBe(true);
    expect(reasons[1]).toBe(`false:${foreignPortMessage('8765')}`);
    expect(reasons[1]).toContain('Port 8765 is used by another program');
    await wait(100); // the retry scheduled before the probe answered was cancelled
    expect(fake.instances).toHaveLength(1);
    const retryTimers = setSpy.mock.calls.filter(([, ms]) => ms === 60).length;
    setSpy.mockRestore();
    expect(retryTimers).toBe(1);
  });

  it('livesync answering the probe: retries continue, probed once per failure streak', async () => {
    const probe = livesyncAnswers();
    const { c } = client({ fetch: probe.f, retryDelay: () => 5 });
    c.start();
    fake.last.refuse();
    await wait(30);
    expect(fake.instances).toHaveLength(2);
    fake.last.refuse();
    await wait(30);
    expect(fake.instances).toHaveLength(3);
    expect(c.phase).not.toBe('stopped');
    expect(probe.calls).toHaveLength(1);
    c.stop();
  });

  it('nothing listening: retries continue; an open starts a new streak (probed again)', async () => {
    const probe = nobodyAnswers();
    const { c } = client({ fetch: probe.f, retryDelay: () => 5 });
    c.start();
    fake.last.refuse();
    await wait(30);
    fake.last.refuse();
    await wait(30);
    expect(fake.instances).toHaveLength(3);
    expect(probe.calls.map((x) => x.mode)).toEqual(['cors', 'no-cors']);
    fake.last.open();
    fake.last.serverClose(1006); // opened → not a probe case
    await wait(30);
    expect(probe.calls).toHaveLength(2);
    fake.last.refuse();
    await wait(30);
    expect(probe.calls).toHaveLength(4);
    expect(c.phase).not.toBe('stopped');
    c.stop();
  });

  it('a probe answer after stop() changes nothing', async () => {
    let release: (r: Response) => void = () => {};
    const slow = probeFetch((init) => (init.mode === 'cors'
      ? Promise.reject(new TypeError('x'))
      : new Promise<Response>((r) => { release = r; })));
    const { c, events } = client({ fetch: slow.f, retryDelay: () => 1000 });
    c.start();
    fake.last.refuse();
    await wait(5);
    c.stop();
    release(new Response(null));
    await wait(5);
    expect(events).toEqual(['down:true:1006']);
  });

  it('plugin: foreign port → error status with the message; changing the port restarts on the new port', async () => {
    const store = new LiveLinkStore({ port: 8765, token: 'tok', rateHz: 30 });
    let probe = foreignAnswers();
    const plugin = new UsdLiveLinkPlugin({
      store,
      sessionModule,
      createClient: (o) => new KitLinkClient({ ...o, retryDelay: () => 1000, fetch: probe.f }),
    });
    plugin.init(fakeViewer() as unknown as RVViewer);
    plugin.setSyncEnabled(true);
    fake.last.refuse();
    await wait(10);
    expect(store.state.status).toBe('error');
    expect(store.state.message).toBe(foreignPortMessage('8765'));
    expect(plugin.syncEnabled).toBe(false);
    const before = fake.instances.length;
    probe = nobodyAnswers();
    plugin.setPort(8775);
    expect(store.settings.port).toBe(8775);
    expect(fake.instances.length).toBe(before + 1);
    expect(fake.last.url).toBe('ws://127.0.0.1:8775');
    expect(store.state.status).toBe('connecting');
    plugin.setPort(8775); // unchanged: no restart
    expect(fake.instances.length).toBe(before + 1);
    plugin.setSyncEnabled(false);
    plugin.setPort(8776); // sync off: stored, no connection
    expect(fake.instances.length).toBe(before + 1);
    expect(store.state.status).toBe('off');
  });
});

// ── saved-port migration ──

describe('usd-live-link saved port', () => {
  const stored = (v: unknown) => localStorage.setItem(USD_LIVE_LINK_SETTINGS_KEY, JSON.stringify(v));
  afterEach(() => { try { localStorage.removeItem(USD_LIVE_LINK_SETTINGS_KEY); } catch { /* none */ } });

  it('default moved from 8765 to 8775', () => {
    expect(LIVESYNC_DEFAULT_PORT).toBe(8775);
    expect(LIVESYNC_LEGACY_DEFAULT_PORT).toBe(8765);
    localStorage.removeItem(USD_LIVE_LINK_SETTINGS_KEY);
    expect(loadLiveLinkSettings().port).toBe(8775);
  });

  it('migrateStoredPort: old default without the flag moves, chosen and other values stay', () => {
    expect(migrateStoredPort(8765, undefined)).toBe(8775);
    expect(migrateStoredPort(8765, false)).toBe(8775);
    expect(migrateStoredPort(8765, true)).toBe(8765);
    expect(migrateStoredPort(9001, undefined)).toBe(9001);
    expect(migrateStoredPort(8775, undefined)).toBe(8775);
    expect(migrateStoredPort(undefined, true)).toBe(8775);
    expect(migrateStoredPort(70000, true)).toBe(8775);
    expect(migrateStoredPort('8765', true)).toBe(8775);
  });

  it('a record from before the flag (token committed, port never touched) moves to 8775, token kept', () => {
    stored({ port: 8765, token: 'tok', rateHz: 30 });
    const s = loadLiveLinkSettings();
    expect(s.port).toBe(8775);
    expect(s.token).toBe('tok');
    expect(s.portChosen).toBeUndefined();
  });

  it('a port set in the menu is marked chosen and survives a reload, also 8765', () => {
    localStorage.removeItem(USD_LIVE_LINK_SETTINGS_KEY);
    const store = new LiveLinkStore();
    store.updateSettings({ token: 'tok' });
    expect(loadLiveLinkSettings().portChosen).toBeUndefined(); // a token commit does not choose the port
    store.updateSettings({ port: 8765 });
    const s = loadLiveLinkSettings();
    expect(s.port).toBe(8765);
    expect(s.portChosen).toBe(true);
    expect(new LiveLinkStore().settings.port).toBe(8765);
  });

  it('garbage in storage falls back to the defaults', () => {
    localStorage.setItem(USD_LIVE_LINK_SETTINGS_KEY, 'null');
    expect(loadLiveLinkSettings().port).toBe(8775);
    localStorage.setItem(USD_LIVE_LINK_SETTINGS_KEY, '{oops');
    expect(loadLiveLinkSettings().port).toBe(8775);
  });
});
