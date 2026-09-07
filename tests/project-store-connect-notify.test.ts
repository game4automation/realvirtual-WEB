// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-462 B2 — the CONNECT notify is a property of committing the manifest,
 * not a line each writer remembers to add.
 *
 * Every test here counts notifications rather than requests: the debounce and
 * the wire live in `connect-active-document.test.ts`, and what this file is
 * about is the layer below it — *whether the store said anything at all*. The
 * three rules being pinned are the ones that used to be answered once per call
 * site, and got three different answers:
 *
 *  1. once after the FINAL commit, never per CAS attempt;
 *  2. only when the manifest actually changed, compared by content hash;
 *  3. only for a verb that bears configuration — a migration stays silent.
 *
 * A real in-memory folder is used rather than a mocked `updateManifestCas`,
 * because rule 2 IS the revision, and a mock would be free to invent one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/project/rv-document-classify', () => ({
  writeDocumentClassification: vi.fn(
    async (_backend: unknown, _doc: unknown, classification: unknown) => ({ classification }),
  ),
}));

import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import {
  getProjectStore,
  resetProjectStore,
  type ProjectSnapshot,
  type ProjectStore,
} from '../src/core/project/project-store';
import { withConnectConfigNotifier } from '../src/core/project/backends/project-backend';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

const MANIFEST = 'project.json';

function doc(id: string, path: string): RvDocumentEntry {
  return { id, path, name: path.split('/').pop() ?? path, tier: 'user' } as unknown as RvDocumentEntry;
}

function manifestOf(documents: RvDocumentEntry[]): RvProject {
  return {
    schemaVersion: 2,
    id: 'proj-1',
    name: 'Linie',
    canonicalName: 'linie',
    documents,
  } as unknown as RvProject;
}

/** Read `project.json` back out of the fake folder. */
async function readManifestText(dir: FakeDir): Promise<string> {
  const handle = await dir.getFileHandle(MANIFEST);
  const file = await handle.getFile();
  return file.text();
}

/** The private commit hook, for the rules no public verb can express on its own. */
function commitHookOf(store: ProjectStore): (
  reason: string,
  apply: (current: RvProject | null) => RvProject | Promise<RvProject>,
  opts: { notify: boolean },
) => Promise<{ project: RvProject; changed: boolean } | null> {
  const internals = store as unknown as {
    _commitManifest: (
      reason: string,
      apply: (current: RvProject | null) => RvProject | Promise<RvProject>,
      opts: { notify: boolean },
    ) => Promise<{ project: RvProject; changed: boolean } | null>;
  };
  return internals._commitManifest.bind(store);
}

interface Harness {
  store: ProjectStore;
  dir: FakeDir;
  /** How often the store announced a change since the last `reset()`. */
  notifications: () => number;
  reset: () => void;
  /** Put a manifest on disk AND into the store's memory. */
  seed: (documents: RvDocumentEntry[]) => Promise<void>;
}

/**
 * A store with a writable folder, a manifest and a counting notifier.
 *
 * The private fields are set directly for the same reason
 * `connect-active-document.test.ts` does it: opening a project would drag in
 * the whole boot path, and every one of these fields is something an opened
 * project simply has.
 */
async function harness(): Promise<Harness> {
  resetProjectStore();
  const store = getProjectStore();
  const dir = new FakeDir('linie');

  let count = 0;
  store.setProjectChangeNotifier(() => { count += 1; });

  const backend = {
    kind: 'folder',
    id: 'fake',
    writable: true,
    writeManifest: undefined,
  } as unknown as ProjectBackend;

  const internals = store as unknown as {
    _backend: unknown;
    _dir: unknown;
    _project: RvProject | null;
    _snapshot: ProjectSnapshot;
    _userDocuments: unknown[];
  };
  internals._backend = backend;
  internals._dir = asDirHandle(dir);

  const seed = async (documents: RvDocumentEntry[]): Promise<void> => {
    const project = manifestOf(documents);
    const handle = await dir.getFileHandle(MANIFEST, { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(project, null, 2));
    await writable.close();
    internals._project = project;
    internals._userDocuments = documents;
    internals._snapshot = {
      ...store.getSnapshot(),
      project,
      documents,
      writable: true,
      backendKind: 'folder',
    } as unknown as ProjectSnapshot;
  };

  await seed([doc('d1', 'models/linie1.glb')]);
  count = 0;

  return { store, dir, notifications: () => count, reset: () => { count = 0; }, seed };
}

describe('plan-462 B2 — the manifest commit hook decides the CONNECT notify', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  // ── rule 3: classification per caller ──

  it('announces a classification change, which used to be silent', async () => {
    const h = await harness();

    await h.store.setDocumentClassification('d1', 'part' as never);

    expect(h.notifications()).toBe(1);
  });

  it('announces a connectRef binding exactly once', async () => {
    const h = await harness();

    await h.store.setDocumentConnectRef('d1', 'models/linie1.connect.json');

    expect(h.notifications()).toBe(1);
    expect(await readManifestText(h.dir)).toContain('models/linie1.connect.json');
  });

  it('stays silent for a marker-driven migration', async () => {
    const h = await harness();
    // The migration's own gate needs a declared module to bind; without one it
    // returns before writing anything, which would make the test vacuous. So it
    // is driven through the commit hook directly with the classification
    // Tabelle 2 gives it — `notify: false` — which is the thing under test: a
    // write that really happened, and really said nothing.
    const result = await commitHookOf(h.store)(
      'migrate scriptRefs',
      current => ({ ...(current as RvProject), scriptRefMigratedAt: 'now' } as RvProject),
      { notify: false },
    );

    expect(result?.changed).toBe(true);
    expect(h.notifications()).toBe(0);
  });

  // ── rule 2: only a manifest that actually changed ──

  it('says nothing when a structurally identical manifest is written back', async () => {
    const h = await harness();
    const same = JSON.parse(await readManifestText(h.dir)) as RvProject;

    await h.store.replaceManifest(same);

    expect(h.notifications()).toBe(0);
  });

  it('says nothing when a mutator turns into a no-op against what is on disk', async () => {
    const h = await harness();

    // The shape of a mutator rebased by a CAS retry: it re-derives from the
    // CURRENT state and finds its change already there, so it writes the same
    // bytes back. No mutator flag could report that — only the revision can.
    await h.store.applyManifestDelta(current => current);

    expect(h.notifications()).toBe(0);
  });

  it('announces a real change made by the same verb', async () => {
    const h = await harness();

    await h.store.applyManifestDelta(current => ({ ...current, name: 'Linie 2' }));

    expect(h.notifications()).toBe(1);
  });

  // ── rule 1: once after the final commit, not per CAS attempt ──

  it('announces once even when the compare-and-swap had to retry', async () => {
    const h = await harness();
    const commit = commitHookOf(h.store);

    // A second writer lands between the read and the write of the first
    // attempt: the CAS precondition fails and `apply` runs again against the
    // newer state. One notify must come out of the whole thing, not two — and
    // not one per attempt, which is what a notify inside `apply` would give.
    let attempts = 0;
    const result = await commit('retrying write', async (current) => {
      attempts += 1;
      if (attempts === 1) {
        // Rewrite `project.json` behind this attempt's back, so the revision it
        // read is no longer the one on disk when it tries to write.
        const handle = await h.dir.getFileHandle(MANIFEST, { create: true });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(
          { ...(current as RvProject), name: 'Someone else' }, null, 2));
        await writable.close();
      }
      return { ...(current as RvProject), name: `Linie ${attempts}` } as RvProject;
    }, { notify: true });

    expect(attempts).toBeGreaterThan(1);
    expect(result?.changed).toBe(true);
    expect(h.notifications()).toBe(1);
  });

  it('says nothing when the commit throws', async () => {
    const h = await harness();

    await expect(h.store.applyManifestDelta(() => {
      throw new Error('mutator exploded');
    })).rejects.toThrow('mutator exploded');

    expect(h.notifications()).toBe(0);
  });

  // ── the config BODY, which no manifest can observe ──

  it('announces a written *.connect.json body, independent of the manifest', async () => {
    let announced = 0;
    const writes: string[] = [];
    const inner = {
      kind: 'folder',
      id: 'fake',
      writable: true,
      writeDocument: async (ref: string) => {
        writes.push(ref);
        return { revision: 'r1' };
      },
    } as unknown as ProjectBackend;

    const wrapped = withConnectConfigNotifier(inner, () => { announced += 1; });
    await wrapped.writeDocument('connect/line-a.connect.json', new Uint8Array(), {
      expectedRevision: 'create',
    });

    expect(announced).toBe(1);
    expect(writes).toEqual(['connect/line-a.connect.json']);
  });

  it('says nothing for a body that is not a configuration', async () => {
    let announced = 0;
    const inner = {
      writeDocument: async () => ({ revision: 'r1' }),
    } as unknown as ProjectBackend;

    const wrapped = withConnectConfigNotifier(inner, () => { announced += 1; });
    await wrapped.writeDocument('models/linie1.glb', new Uint8Array(), {
      expectedRevision: 'any',
    });

    expect(announced).toBe(0);
  });

  it('says nothing when the config body write fails', async () => {
    let announced = 0;
    const inner = {
      writeDocument: async () => { throw new Error('disk full'); },
    } as unknown as ProjectBackend;

    const wrapped = withConnectConfigNotifier(inner, () => { announced += 1; });
    await expect(wrapped.writeDocument('connect/a.connect.json', new Uint8Array(), {
      expectedRevision: 'create',
    })).rejects.toThrow('disk full');

    expect(announced).toBe(0);
  });

  it('leaves every other member of the wrapped backend alone', async () => {
    const inner = {
      kind: 'folder',
      id: 'fake',
      writable: true,
      writeDocument: async () => ({ revision: 'r1' }),
      deleteDocument: async () => undefined,
    } as unknown as ProjectBackend;

    const wrapped = withConnectConfigNotifier(inner, () => undefined);

    expect(wrapped.kind).toBe('folder');
    expect(wrapped.id).toBe('fake');
    expect(wrapped.writable).toBe(true);
    await expect(wrapped.deleteDocument('models/x.glb')).resolves.toBeUndefined();
  });
});
