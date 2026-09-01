// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-embed-project — the community download opens a PROJECT (plan-726 §9.6).
 *
 * ## What changed, and what must not
 *
 * `startConnectEmbedDemo()` used to call `viewer.loadModelWithProgress()` with a
 * URL built from a filename constant this plugin owned. It now opens the demo
 * PROJECT and then its start document, so the CONNECT bundle shows the same
 * thing the hosted demo does — project identity included — instead of a bare
 * GLB that happens to be the same file.
 *
 * The gate state machine around it is unchanged and is the fragile part, so it
 * is what most of these nets are about. One subtlety carried over from the old
 * comment and now MORE important: `openDocument()` goes through
 * `viewer.loadScene()`, not `loadModelWithProgress()`, so the completion that
 * `main.ts` raises for the latter never fires on this path. This file therefore
 * drives `begin` / `complete` / `fail` itself, on every exit.
 *
 * The opener is injected. The alternative — a real `ProjectStore`, a real
 * `SceneStore`, OPFS and a WebGL context — would test the stores rather than the
 * gate, and could not express the failure branches at all.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startConnectEmbedDemo,
  closeConnectEmbedDemo,
  isConnectEmbedDemoLoaded,
  connectEmbedDemoUrl,
  type ConnectEmbedDemoOpener,
} from '../src/plugins/connect-embed/connect-embed-actions';
import {
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
} from '../src/plugins/connect-embed/connect-embed-store';
import type { RVAppConfig } from '../src/core/rv-app-config';

const START_DOC = { id: 'doc_demorealvirtualweb_7l7hfw', name: 'realvirtual WEB Demo', path: 'DemoRealvirtualWeb.glb' };

/** A connect-embed deployment, which is what `enabled` keys off. */
function enableEmbed(): void {
  initializeConnectEmbedStore({
    ui: { initialContexts: ['connect-embed'] },
  } as unknown as RVAppConfig);
}

function opener(over: Partial<ConnectEmbedDemoOpener> = {}): ConnectEmbedDemoOpener {
  return {
    openDemoProject: vi.fn(async () => true),
    openDocument: vi.fn(async () => {}),
    startDocument: vi.fn(() => START_DOC),
    ...over,
  };
}

describe('startConnectEmbedDemo opens the demo project', () => {
  beforeEach(() => { enableEmbed(); });

  it('opens the project and then its start document, and ends in demo-running', async () => {
    const o = opener();
    await startConnectEmbedDemo({}, o);

    expect(o.openDemoProject).toHaveBeenCalledOnce();
    expect(o.openDocument).toHaveBeenCalledWith(START_DOC.id, START_DOC.name);
    expect(getConnectEmbedSnapshot().state).toBe('demo-running');
    expect(getConnectEmbedSnapshot().error).toBeNull();
  });

  it('asks for the start document AFTER the project is open', async () => {
    // `startDocument()` reads the ACTIVE project's manifest, so asking first
    // would answer about whatever the boot happened to leave open.
    const order: string[] = [];
    await startConnectEmbedDemo({}, opener({
      openDemoProject: vi.fn(async () => { order.push('project'); return true; }),
      startDocument: vi.fn(() => { order.push('startDocument'); return START_DOC; }),
    }));
    expect(order).toEqual(['project', 'startDocument']);
  });

  it('passes through loading on the way — the gate shell depends on it', async () => {
    const seen: string[] = [];
    await startConnectEmbedDemo({}, opener({
      openDocument: vi.fn(async () => { seen.push(getConnectEmbedSnapshot().state); }),
    }));
    // `completeConnectEmbedDemoLoad()` only accepts a transition OUT of
    // `loading`; without this the gate would stay draped over a loaded model.
    expect(seen).toEqual(['loading']);
    expect(getConnectEmbedSnapshot().state).toBe('demo-running');
  });

  it('is a no-op for a re-entrant click', async () => {
    const o = opener();
    await startConnectEmbedDemo({}, o);
    await startConnectEmbedDemo({}, o);
    expect(o.openDemoProject).toHaveBeenCalledOnce();
  });

  it('does nothing at all outside a connect-embed deployment', async () => {
    initializeConnectEmbedStore({ ui: {} } as unknown as RVAppConfig);
    const o = opener();
    await startConnectEmbedDemo({}, o);
    expect(o.openDemoProject).not.toHaveBeenCalled();
  });
});

describe('startConnectEmbedDemo failure branches', () => {
  beforeEach(() => { enableEmbed(); });

  it('reports load-error when the project will not open', async () => {
    await startConnectEmbedDemo({}, opener({ openDemoProject: vi.fn(async () => false) }));
    const snap = getConnectEmbedSnapshot();
    expect(snap.state).toBe('load-error');
    expect(snap.error).toMatch(/demo project could not be opened/i);
  });

  it('reports load-error when the manifest names no start document', async () => {
    // A packaging fault: the bundle shipped without its `project.json`, or with
    // one that names nothing. Said out loud rather than left as an empty
    // viewport behind a dismissed gate.
    await startConnectEmbedDemo({}, opener({ startDocument: vi.fn(() => null) }));
    const snap = getConnectEmbedSnapshot();
    expect(snap.state).toBe('load-error');
    expect(snap.error).toMatch(/names no start document/i);
  });

  it('turns a throwing open into load-error rather than an unhandled rejection', async () => {
    await startConnectEmbedDemo({}, opener({
      openDocument: vi.fn(async () => { throw new Error('GLB is corrupt'); }),
    }));
    const snap = getConnectEmbedSnapshot();
    expect(snap.state).toBe('load-error');
    expect(snap.error).toBe('GLB is corrupt');
  });

  it('a failed start can be retried — load-error is a re-entry point', async () => {
    await startConnectEmbedDemo({}, opener({ openDemoProject: vi.fn(async () => false) }));
    expect(getConnectEmbedSnapshot().state).toBe('load-error');

    await startConnectEmbedDemo({}, opener());
    expect(getConnectEmbedSnapshot().state).toBe('demo-running');
  });
});

describe('the demo document is addressed through the manifest, not a constant', () => {
  beforeEach(() => { enableEmbed(); });

  it('connectEmbedDemoUrl resolves the start document path', () => {
    expect(connectEmbedDemoUrl(opener())).toContain('DemoRealvirtualWeb.glb');
  });

  it('connectEmbedDemoUrl is null when the manifest names nothing', () => {
    expect(connectEmbedDemoUrl(opener({ startDocument: vi.fn(() => null) }))).toBeNull();
  });

  it('recognises the loaded model by the manifest path, its file name, or its asset url', () => {
    const o = opener();
    for (const url of [
      connectEmbedDemoUrl(o)!,
      'models/DemoRealvirtualWeb.glb',
      '/base/models/DemoRealvirtualWeb.glb',
      'DemoRealvirtualWeb.glb',
      '/base/models/DemoRealvirtualWeb.glb?option=sew',
    ]) {
      expect(isConnectEmbedDemoLoaded({ currentModelUrl: url }, o), url).toBe(true);
    }
  });

  it('does not mistake another model for the demo', () => {
    const o = opener();
    expect(isConnectEmbedDemoLoaded({ currentModelUrl: '/base/models/Other.glb' }, o)).toBe(false);
    expect(isConnectEmbedDemoLoaded({ currentModelUrl: null }, o)).toBe(false);
  });
});

describe('closing the demo returns to the gate', () => {
  beforeEach(() => { enableEmbed(); });

  it('clears the model and goes back to gated-empty', () => {
    beginConnectEmbedDemoLoad();
    completeConnectEmbedDemoLoad();
    const clearModel = vi.fn();
    closeConnectEmbedDemo({ clearModel });
    expect(clearModel).toHaveBeenCalledOnce();
    expect(getConnectEmbedSnapshot().state).toBe('gated-empty');
  });
});
