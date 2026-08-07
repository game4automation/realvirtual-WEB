// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Published-model handling (plan-365).
 *
 * The rule under test: a publish makes the model selectable, and reloads a view
 * only when it overwrites exactly the model that view has open. Everything else
 * — a different model, unsaved work, a foreign gateway, a repeat of a message
 * already handled — leaves the user where they are.
 *
 * Covered here:
 *   F1  a published model becomes selectable
 *   F2  the open model is reloaded when it is republished
 *   F3  a different model changes nothing
 *   F4  the download carries a version stamp, the stored URL never does
 *   F5  unsaved work produces a hint, not a load
 *   F6  the complete view survives the reload
 *   F8  existing catalogue entries are never replaced
 *   plus dedup, out-of-order suppression, and all three transport paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RVModelUpdateCoordinator,
  installModelUpdateCoordinator,
  emitModelChanged,
  type ModelChangedEvent,
  type ModelReloadHint,
  type ModelUpdateHost,
} from '../src/core/rv-model-update-coordinator';
import {
  canonicalModelUrl,
  clearModelRevisions,
  isSameModelUrl,
  mergeModelCatalog,
  modelFetchUrl,
  getModelCatalogVersion,
  subscribeModelCatalog,
  bumpModelCatalog,
  type ModelCatalogEntry,
} from '../src/core/rv-model-catalog';
import {
  captureViewState,
  restoreViewState,
  isCameraExternallyDriven,
  type RVViewState,
  type ViewStateHost,
} from '../src/core/rv-view-state';
import {
  WebSocketRealtimeInterface,
  isSameOriginWsTarget,
  parseWsTarget,
} from '../src/interfaces/websocket-realtime-interface';
import { CtrlXInterface } from '../src/interfaces/ctrlx-interface';
import type {
  TransportInboundMessage,
  TransportOutboundMessage,
} from '../src/interfaces/signal-transport-core';
import { INTERFACE_DEFAULTS, type InterfaceSettings } from '../src/interfaces/interface-settings-store';

// ── Host double ────────────────────────────────────────────────────────────

interface HostDouble extends ModelUpdateHost {
  catalog: ModelCatalogEntry[];
  currentUrl: string | null;
  dirty: boolean;
  reloads: number;
  hints: ModelReloadHint[];
  clock: number;
}

function makeHost(overrides?: Partial<HostDouble>): HostDouble {
  const host: HostDouble = {
    baseUrl: '/',
    catalog: [{ url: '/models/Embedded.glb', label: 'Embedded' }],
    currentUrl: null,
    dirty: false,
    reloads: 0,
    hints: [],
    clock: 1000,
    getCatalog: () => host.catalog,
    setCatalog: (entries) => { host.catalog = entries; },
    getCurrentModelUrl: () => host.currentUrl,
    hasUnsavedChanges: () => host.dirty,
    reloadCurrentModel: async () => { host.reloads++; },
    showReloadHint: (hint) => { host.hints.push(hint); },
    now: () => host.clock,
    ...overrides,
  };
  return host;
}

const PUBLISH: ModelChangedEvent = {
  name: 'Fuellstation.glb',
  url: 'models/Fuellstation.glb',
  revision: '7',
};

beforeEach(() => {
  clearModelRevisions();
  installModelUpdateCoordinator(null);
});

// ── Identity: canonical URL vs. fetch URL (F4) ─────────────────────────────

describe('model identity', () => {
  it('resolves a gateway URL into the catalogue URL space', () => {
    expect(canonicalModelUrl('models/A.glb', '/')).toBe('/models/A.glb');
    expect(canonicalModelUrl('models/A.glb', '/webviewer/')).toBe('/webviewer/models/A.glb');
    // Dev mode serves project models from a different prefix (plan-363 Phase 4) —
    // it must survive verbatim rather than being rebuilt from the file name.
    expect(canonicalModelUrl('private-models/Toray/A.glb', '/')).toBe('/private-models/Toray/A.glb');
    expect(canonicalModelUrl('https://cdn.example/A.glb', '/')).toBe('https://cdn.example/A.glb');
  });

  it('matches a model opened as a supplier variant', () => {
    expect(isSameModelUrl('/models/A.glb?option=sew', '/models/A.glb')).toBe(true);
    expect(isSameModelUrl('/models/A.glb', '/models/B.glb')).toBe(false);
    expect(isSameModelUrl(null, '/models/A.glb')).toBe(false);
  });

  it('appends the version stamp so the browser cannot serve a cached GLB', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(modelFetchUrl('/models/Fuellstation.glb')).toBe('/models/Fuellstation.glb?v=7');
    // …and the option variant of the same model is busted too.
    expect(modelFetchUrl('/models/Fuellstation.glb?option=sew'))
      .toBe('/models/Fuellstation.glb?option=sew&v=7');
  });

  it('leaves the canonical URL untouched — localStorage and scene drafts still match', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.catalog.map((m) => m.url)).toContain('/models/Fuellstation.glb');
    expect(host.catalog.every((m) => !m.url.includes('?v='))).toBe(true);
    expect(host.getCurrentModelUrl()).toBe('/models/Fuellstation.glb');
  });

  it('does not stamp a model no publish was announced for', () => {
    expect(modelFetchUrl('/models/Untouched.glb')).toBe('/models/Untouched.glb');
  });
});

// ── Catalogue merge (F1, F8) ───────────────────────────────────────────────

describe('catalogue merge', () => {
  it('adds the new model to the selection without replacing existing entries', () => {
    const merged = mergeModelCatalog(
      [{ url: '/models/Embedded.glb', label: 'Embedded' }],
      [{ url: '/models/Published.glb', label: 'Published' }],
    );
    expect(merged.map((m) => m.label)).toEqual(['Embedded', 'Published']);
  });

  it('publishing the same model twice produces one row, not two', () => {
    const once = mergeModelCatalog(
      [{ url: '/models/A.glb', label: 'A' }],
      [{ url: '/models/A.glb', label: 'A' }],
    );
    expect(once).toHaveLength(1);
  });

  it('never lets an incoming entry overwrite the authoritative one', () => {
    const merged = mergeModelCatalog(
      [{ url: '/models/A.glb', label: 'Authoritative' }],
      [{ url: '/other/A.glb', label: 'Gateway' }],
    );
    expect(merged).toEqual([{ url: '/models/A.glb', label: 'Authoritative' }]);
  });

  it('notifies subscribers so SceneStore and the login gate both see the change', () => {
    let seen = 0;
    const unsubscribe = subscribeModelCatalog(() => { seen++; });
    const before = getModelCatalogVersion();
    bumpModelCatalog();
    expect(seen).toBe(1);
    expect(getModelCatalogVersion()).toBeGreaterThan(before);
    unsubscribe();
  });
});

// ── The decision (F1, F2, F3, F5) ──────────────────────────────────────────

describe('RVModelUpdateCoordinator', () => {
  it('adds a new model to the selection and disturbs nobody', async () => {
    const host = makeHost({ currentUrl: '/models/Embedded.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.catalog.map((m) => m.label)).toEqual(['Embedded', 'Fuellstation']);
    expect(host.reloads).toBe(0);
    expect(host.hints).toHaveLength(0);
  });

  it('reloads the model when the published one is the one currently open', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.reloads).toBe(1);
  });

  it('leaves the view untouched when a different model is published', async () => {
    const host = makeHost({ currentUrl: '/models/SomethingElse.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.reloads).toBe(0);
    expect(host.getCurrentModelUrl()).toBe('/models/SomethingElse.glb');
  });

  it('reloads a model opened as a supplier variant of the published one', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb?option=sew' });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.reloads).toBe(1);
  });

  it('shows a hint instead of reloading when there are unsaved changes', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb', dirty: true });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.reloads).toBe(0);
    expect(host.hints).toHaveLength(1);
    expect(host.hints[0].label).toBe('Fuellstation');

    // The choice is the user's, and taking it still works.
    host.hints[0].onReload();
    await Promise.resolve();
    expect(host.reloads).toBe(1);
  });

  it('keeps the unsaved work when the user declines', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb', dirty: true });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    host.hints[0].onKeep();
    await Promise.resolve();
    expect(host.reloads).toBe(0);
  });

  it('only updates the catalogue when nothing is loaded — an empty scene is a decision', async () => {
    const host = makeHost({ currentUrl: null });
    new RVModelUpdateCoordinator(host).handleModelChanged(PUBLISH);
    await Promise.resolve();

    expect(host.catalog.map((m) => m.label)).toContain('Fuellstation');
    expect(host.reloads).toBe(0);
    expect(host.hints).toHaveLength(0);
  });

  it('ignores an announcement that names no model at all', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    new RVModelUpdateCoordinator(host).handleModelChanged({ revision: '9' });
    await Promise.resolve();

    expect(host.reloads).toBe(0);
    expect(host.catalog).toHaveLength(1);
  });

  it('carries a model_changed from a gateway that predates the URL and revision fields', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    // The worker recovers `url` from `message`; there is no revision at all.
    new RVModelUpdateCoordinator(host).handleModelChanged({ url: 'models/Fuellstation.glb' });
    await Promise.resolve();

    expect(host.reloads).toBe(1);
    // Without a server revision the fetch is still stamped, or the reload would
    // be answered out of the cache — which is the bug, not the fallback.
    expect(modelFetchUrl('/models/Fuellstation.glb')).toMatch(/\?v=t\d+$/);
  });
});

// ── Dedup and ordering ─────────────────────────────────────────────────────

describe('RVModelUpdateCoordinator — duplicates and ordering', () => {
  it('acts once when all three transports report the same publish', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    const coordinator = new RVModelUpdateCoordinator(host);

    coordinator.handleModelChanged({ ...PUBLISH, source: 'websocket-realtime' });
    coordinator.handleModelChanged({ ...PUBLISH, source: 'connect-plugin' });
    coordinator.handleModelChanged({ ...PUBLISH, source: 'ctrlx' });
    await Promise.resolve();

    expect(host.reloads).toBe(1);
  });

  it('discards an out-of-order announcement carrying an older revision', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    const coordinator = new RVModelUpdateCoordinator(host);

    coordinator.handleModelChanged({ ...PUBLISH, revision: '8' });
    await Promise.resolve();
    coordinator.handleModelChanged({ ...PUBLISH, revision: '7' }); // arrived late
    await Promise.resolve();

    expect(host.reloads).toBe(1);
    expect(modelFetchUrl('/models/Fuellstation.glb')).toBe('/models/Fuellstation.glb?v=8');
  });

  it('acts again on a genuinely newer revision', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    const coordinator = new RVModelUpdateCoordinator(host);

    coordinator.handleModelChanged({ ...PUBLISH, revision: '7' });
    await Promise.resolve();
    coordinator.handleModelChanged({ ...PUBLISH, revision: '8' });
    await Promise.resolve();

    expect(host.reloads).toBe(2);
  });

  it('separates two revisionless publishes once the dedup window has passed', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    const coordinator = new RVModelUpdateCoordinator(host);
    const event = { url: 'models/Fuellstation.glb' };

    coordinator.handleModelChanged(event);
    await Promise.resolve();
    coordinator.handleModelChanged(event);         // same instant → the same event
    await Promise.resolve();
    expect(host.reloads).toBe(1);

    host.clock += 5000;
    coordinator.handleModelChanged(event);         // later → a second publish
    await Promise.resolve();
    expect(host.reloads).toBe(2);
  });
});

// ── View state (F6) ────────────────────────────────────────────────────────

class FakeVec {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this { this.x = x; this.y = y; this.z = z; return this; }
}

class FakeQuat {
  constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}
  set(x: number, y: number, z: number, w: number): this {
    this.x = x; this.y = y; this.z = z; this.w = w; return this;
  }
}

function makeViewHost(overrides?: Partial<ViewStateHost>): ViewStateHost & {
  camera: { position: FakeVec; quaternion: FakeQuat; zoom: number; updateProjectionMatrix: () => void };
  controls: { target: FakeVec; update: () => void };
} {
  const camera = {
    position: new FakeVec(1, 2, 3),
    quaternion: new FakeQuat(0.1, 0.2, 0.3, 0.9),
    zoom: 2.5,
    updateProjectionMatrix: vi.fn(),
  };
  const controls = { target: new FakeVec(4, 5, 6), update: vi.fn() };
  return {
    projection: 'orthographic',
    camera,
    controls,
    cameraFollowMode: 'off',
    getPlugin: () => undefined,
    markRenderDirty: vi.fn(),
    ...overrides,
  } as never;
}

describe('view state', () => {
  it('keeps the complete camera state across the reload', () => {
    const host = makeViewHost();
    const state = captureViewState(host) as RVViewState;
    expect(state).toEqual({
      projection: 'orthographic',
      position: [1, 2, 3],
      quaternion: [0.1, 0.2, 0.3, 0.9],
      target: [4, 5, 6],
      zoom: 2.5,
    });

    // A reload re-fits the camera and may switch back to perspective.
    host.projection = 'perspective';
    host.camera.position.set(99, 99, 99);
    host.camera.quaternion.set(0, 0, 0, 1);
    host.camera.zoom = 1;
    host.controls.target.set(0, 0, 0);

    restoreViewState(host, state);

    expect(host.projection).toBe('orthographic');
    expect([host.camera.position.x, host.camera.position.y, host.camera.position.z]).toEqual([1, 2, 3]);
    expect(host.camera.quaternion.w).toBe(0.9);
    expect(host.camera.zoom).toBe(2.5);
    expect([host.controls.target.x, host.controls.target.y, host.controls.target.z]).toEqual([4, 5, 6]);
    expect(host.controls.update).toHaveBeenCalled();
  });

  it('leaves the camera to FPV and Follow, which drive it every frame', () => {
    const follow = makeViewHost({ cameraFollowMode: 'follow' });
    expect(isCameraExternallyDriven(follow)).toBe(true);
    expect(captureViewState(follow)).toBeNull();

    const fpv = makeViewHost({ getPlugin: () => ({ isActive: true }) });
    expect(captureViewState(fpv)).toBeNull();

    // …and a state captured earlier is not written back over them either.
    restoreViewState(fpv, {
      projection: 'perspective', position: [7, 7, 7], quaternion: [0, 0, 0, 1], target: [0, 0, 0], zoom: 1,
    });
    expect(fpv.camera.position.x).toBe(1);
  });
});

// ── The three transport paths ──────────────────────────────────────────────

class MockPort {
  inbound: TransportInboundMessage[] = [];
  private handler: ((msg: TransportOutboundMessage) => void) | null = null;
  postMessage(msg: TransportInboundMessage): void { this.inbound.push(msg); }
  terminate(): void { /* nothing to tear down */ }
  onMessage(cb: (msg: TransportOutboundMessage) => void): void { this.handler = cb; }
  emit(msg: TransportOutboundMessage): void { this.handler?.(msg); }
}

class TestWsInterface extends WebSocketRealtimeInterface {
  readonly port = new MockPort();
  protected override createPort(): MockPort { return this.port; }
}

class TestCtrlXInterface extends CtrlXInterface {
  readonly port = new MockPort();
  protected override createPort(): MockPort { return this.port; }
}

function connectSettings(overrides?: Partial<InterfaceSettings>): InterfaceSettings {
  return {
    ...INTERFACE_DEFAULTS,
    activeType: 'websocket-realtime',
    wsAddress: window.location.hostname,
    wsPort: window.location.port !== ''
      ? Number(window.location.port)
      : window.location.protocol === 'https:' ? 443 : 80,
    wsUseSSL: window.location.protocol === 'https:',
    wsPath: '/ws',
    ...overrides,
  };
}

/** Drive doConnect far enough that the interface knows its target. */
async function connect(iface: TestWsInterface | TestCtrlXInterface): Promise<void> {
  const doConnect = (iface as unknown as Record<string, (s: InterfaceSettings) => Promise<void>>)
    .doConnect.bind(iface);
  const settings = iface instanceof CtrlXInterface
    ? connectSettings({ activeType: 'ctrlx', wsUseSSL: false })
    : connectSettings();
  const promise = doConnect(settings);
  iface.port.emit({ type: 'open' });
  await promise;
}

describe('transport paths', () => {
  it('reloads only the model, not the page (the InterfaceManager client)', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    installModelUpdateCoordinator(new RVModelUpdateCoordinator(host));
    try {
      const iface = new TestWsInterface();
      await connect(iface);
      iface.port.emit({
        type: 'model_changed',
        host: window.location.hostname,
        port: 0,
        model: 'Fuellstation.glb',
        url: 'models/Fuellstation.glb',
        revision: '3',
      });
      await Promise.resolve();

      // The page is still the one the test started in — a `location.reload()`
      // would have torn this context down. The source-level guarantee that the
      // call is gone lives in model-changed-no-reload.node.test.ts.
      expect(host.reloads).toBe(1);
    } finally {
      installModelUpdateCoordinator(null);
    }
  });

  it('routes the InterfaceManager and the per-model ConnectPlugin client into ONE decision', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    installModelUpdateCoordinator(new RVModelUpdateCoordinator(host));
    try {
      const managerIface = new TestWsInterface();
      const pluginIface = new TestWsInterface();
      await connect(managerIface);
      await connect(pluginIface);

      const message = {
        type: 'model_changed' as const,
        host: window.location.hostname,
        port: 0,
        model: 'Fuellstation.glb',
        url: 'models/Fuellstation.glb',
        revision: '4',
      };
      managerIface.port.emit(message);
      pluginIface.port.emit(message);
      await Promise.resolve();

      expect(host.reloads).toBe(1);
    } finally {
      installModelUpdateCoordinator(null);
    }
  });

  it('ignores model_changed from a different origin — including the ctrlX bridge', async () => {
    const host = makeHost({ currentUrl: '/models/Fuellstation.glb' });
    installModelUpdateCoordinator(new RVModelUpdateCoordinator(host));
    try {
      // ctrlX pins ws://<address>:8080 — never the page origin.
      const ctrlx = new TestCtrlXInterface();
      await connect(ctrlx);
      ctrlx.port.emit({
        type: 'model_changed',
        host: window.location.hostname,
        port: 8080,
        model: 'Fuellstation.glb',
        url: 'models/Fuellstation.glb',
        revision: '5',
      });

      // A plain foreign gateway, likewise.
      const foreign = new TestWsInterface();
      const doConnect = (foreign as unknown as Record<string, (s: InterfaceSettings) => Promise<void>>)
        .doConnect.bind(foreign);
      const promise = doConnect(connectSettings({ wsAddress: 'other-host.example', wsPort: 5100 }));
      foreign.port.emit({ type: 'open' });
      await promise;
      foreign.port.emit({
        type: 'model_changed',
        host: 'other-host.example',
        port: 5100,
        url: 'models/Fuellstation.glb',
        revision: '6',
      });
      await Promise.resolve();

      expect(host.reloads).toBe(0);
    } finally {
      installModelUpdateCoordinator(null);
    }
  });

  it('treats an implicit default port as the same origin, a scheme change as foreign', () => {
    // HTTPS without an explicit port: `location.port` is empty, which the old
    // inline comparison read as "not 443", so the check never matched on HTTPS.
    const httpsPage = { protocol: 'https:', hostname: 'plant.example', port: '' };
    expect(isSameOriginWsTarget('wss', 'plant.example', 443, httpsPage)).toBe(true);
    expect(isSameOriginWsTarget('ws', 'plant.example', 443, httpsPage)).toBe(false);   // scheme change
    expect(isSameOriginWsTarget('wss', 'plant.example', 8443, httpsPage)).toBe(false); // other port

    const httpPage = { protocol: 'http:', hostname: 'plant.example', port: '' };
    expect(isSameOriginWsTarget('ws', 'plant.example', 80, httpPage)).toBe(true);
  });

  it('reads the target back from the URL a subclass actually built', () => {
    // ctrlX rewrites scheme and port; judging the settings instead of the built
    // URL would compare the page against an address nothing ever dialled.
    expect(parseWsTarget('wss://plant.example/ctrlx-rv-bridge/ws', 'ws', 'plant.example', 5100))
      .toEqual({ scheme: 'wss', host: 'plant.example', port: 443 });
    expect(parseWsTarget('ws://plant.example:8080/', 'wss', 'plant.example', 443))
      .toEqual({ scheme: 'ws', host: 'plant.example', port: 8080 });
    // Unparseable input falls back to what was requested.
    expect(parseWsTarget('not a url', 'ws', 'fallback.example', 1234))
      .toEqual({ scheme: 'ws', host: 'fallback.example', port: 1234 });
  });

  it('emitModelChanged is inert when no coordinator is installed', () => {
    installModelUpdateCoordinator(null);
    expect(() => emitModelChanged(PUBLISH)).not.toThrow();
  });
});
