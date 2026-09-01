// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-725 §9.5 — the viewer half of `POST /project/active-document`.
 *
 * What the notify has to get right is not "does it send". It is *when* it sends
 * (once, after a burst, describing the LAST state), *when it must not* (no
 * gateway, a write that bears no configuration), and *what it must never do*:
 * make the write it trails slow, noisy or failed. So every test here is written
 * from the manifest write's point of view, not from the request's.
 *
 * Three of them are the failure modes that would otherwise be silence — a
 * gateway that held a switch back because a plant is connected (F13), one that
 * serves a different project (F6), and a `created` configuration whose binding
 * could not be saved (F4). A file nobody points at, with no message anywhere,
 * is the one outcome an operator cannot reconstruct afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `setDocumentClassification` writes GLB bytes through this module. The test
// that proves it does NOT notify has to reach the method's tail, and baking a
// real document to get there would test the baker, not the notify.
vi.mock('../src/core/project/rv-document-classify', () => ({
  writeDocumentClassification: vi.fn(
    async (_backend: unknown, _doc: unknown, classification: unknown) => ({ classification }),
  ),
}));

import {
  ACTIVE_DOCUMENT_DEBOUNCE_MS,
  clearActiveDocumentState,
  confirmPendingActivation,
  connectToServer,
  getActiveDocumentState,
  getConnectSnapshot,
  installConnectActiveDocumentNotifier,
  postActiveDocument,
  setServerUrl,
  uninstallConnectActiveDocumentNotifier,
  _resetConnectStore,
} from '../src/core/hmi/connect-store';
import {
  getProjectStore,
  resetProjectStore,
  type ProjectSnapshot,
  type ProjectStore,
} from '../src/core/project/project-store';
import { documentBase, setOpenDocumentBase } from '../src/core/editor/active-asset-store';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';
import hostSource from '../src/core/hmi/projects/ProjectsDashboardHost.tsx?raw';

const GATEWAY = 'http://localhost:5100';
const ROUTE = '/project/active-document';
const LS_KEY_URL = 'rv-connect-url';

/** Every request body the gateway was sent on the active-document route. */
let posted: Array<Record<string, unknown>>;
/** What the route answers next. Replaced per test. */
let answer: () => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The 200 shape §2.3 defines, with only the interesting fields overridden. */
function okBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    activeProfile: 'linie1',
    connectRef: 'models/linie1.connect.json',
    created: null,
    reloaded: true,
    pending: null,
    activationError: null,
    ...over,
  };
}

/**
 * One gateway on the wire: `/health` answers like CONNECT, the active-document
 * route answers whatever the test set, everything else answers an empty payload
 * so the post-connect loads add no noise.
 */
function mockGateway(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url ?? String(input);
    if (url.includes(ROUTE)) {
      posted.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return await answer();
    }
    if (url.includes('/health')) {
      return json({ status: 'ok', version: '6.3.0', build: 1, activeDocumentSupported: true });
    }
    return json([]);
  });
}

async function connect(): Promise<void> {
  setServerUrl(GATEWAY);
  await connectToServer({ explicit: true });
  expect(getConnectSnapshot().state).toBe('connected');
}

function doc(id: string, path: string): RvDocumentEntry {
  return { id, path, name: path.split('/').pop() ?? path, tier: 'user' } as unknown as RvDocumentEntry;
}

/**
 * Give the store a project to describe without opening one: the notify only
 * ever READS the snapshot, so a stubbed snapshot is the whole dependency.
 */
function stubProject(store: ProjectStore, documents: RvDocumentEntry[]): void {
  const project = { id: 'proj-1', name: 'Linie', documents } as unknown as RvProject;
  vi.spyOn(store, 'getSnapshot').mockReturnValue({
    documents,
    project,
    folderName: 'Linie',
    writable: true,
    diskError: null,
    diskPending: false,
    warnings: [],
    backendKind: 'folder',
    models: [],
    restoreFailure: null,
  } as unknown as ProjectSnapshot);
}

/** Let the debounce window elapse AND every promise it started settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(ACTIVE_DOCUMENT_DEBOUNCE_MS + 50);
  await vi.advanceTimersByTimeAsync(0);
}

let store: ProjectStore;

beforeEach(() => {
  posted = [];
  answer = () => json(okBody());
  localStorage.removeItem(LS_KEY_URL);
  _resetConnectStore();
  resetProjectStore();
  setOpenDocumentBase(null);
  mockGateway();
  store = getProjectStore();
  installConnectActiveDocumentNotifier();
});

afterEach(() => {
  vi.useRealTimers();
  uninstallConnectActiveDocumentNotifier();
  clearActiveDocumentState();
  resetProjectStore();
  _resetConnectStore();
  vi.restoreAllMocks();
  localStorage.removeItem(LS_KEY_URL);
});

describe('active-document notify', () => {
  it('coalesces a burst of writes into ONE call (trailing edge)', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));

    vi.useFakeTimers();
    for (let i = 0; i < 6; i++) store.notifyProjectChanged();
    // Half-way through the window is still inside it: a leading-edge helper
    // would already have fired here, which is exactly the bug this replaces.
    await vi.advanceTimersByTimeAsync(ACTIVE_DOCUMENT_DEBOUNCE_MS / 2);
    expect(posted).toHaveLength(0);
    await settle();

    expect(posted).toHaveLength(1);
  });

  it('sends the LAST document of a burst, not the first', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb'), doc('d2', 'models/linie2.glb')]);

    vi.useFakeTimers();
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    store.notifyProjectChanged();
    setOpenDocumentBase(documentBase('d2', 'Linie 2', 'models/linie2.glb'));
    store.notifyProjectChanged();
    await settle();

    expect(posted).toHaveLength(1);
    expect(posted[0].id).toBe('d2');
    expect(posted[0].projectId).toBe('proj-1');
  });

  it('never fires while the connect store is disconnected', async () => {
    // No connect() — the gate that keeps ~10 existing ProjectStore write-path
    // tests from firing real requests at a URL nothing answers (F12).
    expect(getConnectSnapshot().state).toBe('disconnected');
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();

    expect(posted).toHaveLength(0);
  });

  it('swallows a connection error without failing the manifest write', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    answer = () => Promise.reject(new TypeError('Failed to fetch'));

    vi.useFakeTimers();
    // The write itself must resolve, and must not wait for the gateway.
    await expect(store.replaceManifest(
      { id: 'proj-1', name: 'Linie', documents: [] } as unknown as RvProject,
    )).resolves.toBeUndefined();
    await settle();

    expect(posted).toHaveLength(1);           // it was attempted …
    expect(getActiveDocumentState().mismatch).toBeNull();   // … and left nothing behind
    expect(getActiveDocumentState().writeBackError).toBeNull();
  });

  it('treats 404, an SPA text/html 200, 401 and 503 as non-fatal', async () => {
    await connect();

    answer = () => new Response('not found', { status: 404 });
    expect((await postActiveDocument({ projectId: 'proj-1', id: 'd1' })).kind).toBe('unsupported');

    // Bare Vite on the gateway port answers the SPA shell with a 200.
    answer = () => new Response('<!DOCTYPE html><html><body>viewer</body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    });
    expect((await postActiveDocument({ projectId: 'proj-1', id: 'd1' })).kind).toBe('unsupported');

    answer = () => json({ error: 'UNAUTHORIZED' }, 401);
    expect((await postActiveDocument({ projectId: 'proj-1', id: 'd1' })).kind).toBe('error');

    answer = () => json({ error: 'CONFIG_BUSY' }, 503);
    expect((await postActiveDocument({ projectId: 'proj-1', id: 'd1' })).kind).toBe('error');
  });

  it('fires for a tree move / rename, not only for a ref write', async () => {
    // F7: `replaceManifest` is the door the tree move uses. Without a notify
    // here CONNECT keeps writing the live set back to the OLD path.
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));

    vi.useFakeTimers();
    await store.replaceManifest(
      { id: 'proj-1', name: 'Linie', documents: [] } as unknown as RvProject,
    );
    await settle();

    expect(posted).toHaveLength(1);
  });

  it('fires after handleNewConnectConfig, which bypasses updateManifestCas', async () => {
    // Behaviour: the door that path uses fires the notify …
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();
    expect(posted).toHaveLength(1);

    // … and the raw-`writeBlob` path actually walks through it. Pinned in
    // source because that path writes no manifest at all, so nothing in the
    // store can observe it — this assertion is the only thing standing between
    // a new configuration and a gateway that never hears about it.
    const handler = hostSource.slice(hostSource.indexOf('const handleNewConnectConfig'));
    expect(handler.slice(0, handler.indexOf('const handleNewFolder')))
      .toContain('notifyProjectChanged()');
  });

  it('does NOT fire for setDocumentClassification (no config bearing)', async () => {
    await connect();
    const entry = doc('d1', 'models/linie1.glb');
    stubProject(store, [entry]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));

    // The method needs a writable backend and a row it can find; both are read
    // from private state the store only fills by opening a project.
    const internals = store as unknown as {
      _backend: unknown;
      _snapshot: ProjectSnapshot;
      _userDocuments: unknown[];
    };
    internals._backend = { kind: 'folder', id: 'fake', writable: true };
    internals._snapshot = {
      ...store.getSnapshot(),
      documents: [entry] as unknown as ProjectSnapshot['documents'],
    };
    internals._userDocuments = [entry];

    vi.useFakeTimers();
    await store.setDocumentClassification('d1', 'part' as never);
    await settle();

    expect(posted).toHaveLength(0);
  });

  it('writes a returned `created` ref back via setDocumentConnectRef', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    const writeBack = vi.spyOn(store, 'setDocumentConnectRef').mockResolvedValue();
    answer = () => json(okBody({ created: 'models/linie1.connect.json' }));

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();

    // F4 — CONNECT may not write project.json, so the viewer answers `created`.
    expect(writeBack).toHaveBeenCalledWith('d1', 'models/linie1.connect.json');
    expect(getActiveDocumentState().writeBackError).toBeNull();
  });

  it('surfaces a failed write-back instead of leaving an orphan silently', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    vi.spyOn(store, 'setDocumentConnectRef')
      .mockRejectedValue(new Error('This project is read-only.'));
    answer = () => json(okBody({ created: 'models/linie1.connect.json' }));

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();

    const message = getActiveDocumentState().writeBackError ?? '';
    expect(message).toContain('models/linie1.connect.json');
    expect(message).toContain('read-only');
  });

  it('offers a confirmation when the gateway answers `pending`', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    answer = () => json(okBody({
      activeProfile: 'linie2',
      pending: {
        profile: 'linie1',
        connectRef: 'models/linie1.connect.json',
        connectedInterfaces: ['s7-plc1', 'mqtt-line'],
      },
    }));

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();

    const pending = getActiveDocumentState().pending;
    expect(pending?.profile).toBe('linie1');
    expect(pending?.connectedInterfaces).toHaveLength(2);

    // The confirmation repeats the SAME call with force — nothing else.
    answer = () => json(okBody({ activeProfile: 'linie1' }));
    await confirmPendingActivation();
    expect(posted).toHaveLength(2);
    expect(posted[1].force).toBe(true);
    expect(getActiveDocumentState().pending).toBeNull();
  });

  it('surfaces PROJECT_MISMATCH instead of silently doing nothing', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    answer = () => json({
      error: 'PROJECT_MISMATCH',
      code: 'PROJECT_MISMATCH',
      message: 'This gateway serves a different project than the one the request names.',
      servedProject: 'other-project',
    }, 409);

    vi.useFakeTimers();
    store.notifyProjectChanged();
    await settle();

    expect(getActiveDocumentState().mismatch).toContain('different project');
  });

  it('flushes a pending debounce on pagehide via sendBeacon', async () => {
    await connect();
    stubProject(store, [doc('d1', 'models/linie1.glb')]);
    setOpenDocumentBase(documentBase('d1', 'Linie 1', 'models/linie1.glb'));
    const beacon = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);

    vi.useFakeTimers();
    store.notifyProjectChanged();
    // Deliberately BEFORE the window elapses — that is the whole case (F10).
    window.dispatchEvent(new Event('pagehide'));

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(String(beacon.mock.calls[0][0])).toBe(`${GATEWAY}${ROUTE}`);

    // And the flushed payload does not fire a second time afterwards.
    await settle();
    expect(posted).toHaveLength(0);
  });
});
