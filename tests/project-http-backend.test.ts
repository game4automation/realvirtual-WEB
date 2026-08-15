// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-http-backend.test — plan-700 Phase 7 (F12), §9.5.
 *
 * The second read-only backend: a project published on somebody else's deploy
 * root, opened over HTTP. It is deliberately the same class as the bundled one
 * — a foreign deploy publishes exactly what ours does — so the two things worth
 * pinning are that the foreign case reads what it needs from the network, and
 * that the case without `baseUrl`/`discover` is bit-for-bit the old behaviour.
 *
 * The write gates are inherited (`writable === false`, every writer throws).
 * They are asserted here anyway: this backend points at a host we do not own,
 * and "inherited, therefore fine" is exactly the assumption worth testing.
 */

import { describe, it, expect } from 'vitest';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { BackendNotWritableError } from '../src/core/project/backends/project-backend';
import { ProjectStore } from '../src/core/project/project-store';
import { assetDocumentsOf } from '../src/core/project/rv-project-documents';
import { WORKSPACE_DEFAULT_PROJECT_ID } from '../src/core/project/rv-workspace-default';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';

const REMOTE = 'https://cdn.example.test/customer/';

/** A fetch that answers only the files listed, 404 for everything else. */
function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = files[url];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const DEPLOYED_MANIFEST = {
  schemaVersion: 1,
  id: 'prj_remote',
  name: 'Remote Customer',
  canonicalName: 'remote-customer',
};

function remoteBackend(files: Record<string, unknown>): BundledBackend {
  return new BundledBackend({ baseUrl: REMOTE, discover: true, fetchImpl: fakeFetch(files) });
}

describe('BundledBackend against a foreign baseUrl', () => {
  it('reads project.json from that base and reports it as a real deploy', async () => {
    const backend = remoteBackend({ [`${REMOTE}project.json`]: DEPLOYED_MANIFEST });
    const project = await backend.readManifest();
    expect(project?.id).toBe('prj_remote');
    expect(project?.name).toBe('Remote Customer');
    expect(backend.hasDeployedManifest()).toBe(true);
    expect(backend.baseUrl).toBe(REMOTE);
  });

  it('discovers models from the deploy models.json, rooted on the foreign base', async () => {
    const backend = remoteBackend({
      [`${REMOTE}project.json`]: DEPLOYED_MANIFEST,
      [`${REMOTE}models.json`]: ['Press.glb', 'Cell.glb'],
    });
    const models = await backend.listModels();
    expect(models.map(m => m.path)).toEqual([`${REMOTE}models/Press.glb`, `${REMOTE}models/Cell.glb`]);
    expect(models[0]!.label).toBe('Press');
  });

  it('discovers the Examples catalogue from scenes/index.json', async () => {
    const backend = remoteBackend({
      [`${REMOTE}project.json`]: DEPLOYED_MANIFEST,
      // Examples are GLBs since plan-413 phase 3.
      [`${REMOTE}scenes/index.json`]: [{ file: 'A.glb', name: 'Line A', mode: 'planner' }],
    });
    const scenes = sceneDocumentsOf(await backend.readManifest());
    expect(scenes).toHaveLength(1);
    // Plain `scenes/<file>` — `_url()` roots it on the remote base, so a local
    // dev mount must never leak into the path.
    expect(scenes[0]!.path).toBe('scenes/A.glb');
    expect(scenes[0]!.name).toBe('Line A');
    expect(scenes[0]!.id).toBe('published:A');
  });

  it('lets a manifest that lists its own models keep them', async () => {
    const backend = remoteBackend({
      [`${REMOTE}project.json`]: { ...DEPLOYED_MANIFEST, models: [{ path: 'models/Only.glb', label: 'Only' }] },
      [`${REMOTE}models.json`]: ['Press.glb'],
    });
    expect((await backend.listModels()).map(m => m.path)).toEqual(['models/Only.glb']);
  });

  it('resolves blob URLs against the foreign base', async () => {
    const backend = remoteBackend({ [`${REMOTE}project.json`]: DEPLOYED_MANIFEST });
    expect((await backend.readBlobUrl('models/Press.glb'))?.url).toBe(`${REMOTE}models/Press.glb`);
  });

  it('says so when the base URL serves no project at all', async () => {
    const backend = remoteBackend({});
    // A manifest still comes back — the synthetic demo one — which is why
    // `hasDeployedManifest()` and not `!== null` is the question to ask.
    expect(await backend.readManifest()).not.toBeNull();
    expect(backend.hasDeployedManifest()).toBe(false);
  });

  it('refuses every write', async () => {
    const backend = remoteBackend({ [`${REMOTE}project.json`]: DEPLOYED_MANIFEST });
    expect(backend.writable).toBe(false);
    await expect(backend.writeScene()).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(backend.deleteScene()).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(backend.writeBlob()).rejects.toBeInstanceOf(BackendNotWritableError);
    await expect(backend.deleteBlob()).rejects.toBeInstanceOf(BackendNotWritableError);
  });
});

describe('without the option, nothing changes', () => {
  it('does not probe models.json or scenes/index.json', async () => {
    const asked: string[] = [];
    const backend = new BundledBackend({
      baseUrl: '/',
      fetchImpl: (async (input: RequestInfo | URL) => {
        asked.push(typeof input === 'string' ? input : input.toString());
        return new Response('', { status: 404 });
      }) as typeof fetch,
    });
    await backend.readManifest();
    expect(asked).toEqual(['/project.json']);
  });

  it('still yields the synthetic demo project from injected sources', async () => {
    const backend = new BundledBackend({
      baseUrl: '/',
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
      fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    const project = await backend.readManifest();
    expect(assetDocumentsOf(project, 'models').map(m => m.path)).toEqual(['/models/Demo.glb']);
  });
});

describe('ProjectStore registers it as a second read-only backend', () => {
  it('caches one backend per base URL, trailing slash or not', () => {
    const store = new ProjectStore();
    const a = store.getRemoteBackend(REMOTE);
    const b = store.getRemoteBackend(REMOTE.slice(0, -1));
    expect(b).toBe(a);
    expect(store.listRemoteBackends()).toHaveLength(1);
  });

  it('resolves the remote project ahead of the restored one, read-only', async () => {
    const store = new ProjectStore();
    store.getRemoteBackend(REMOTE, {
      fetchImpl: fakeFetch({ [`${REMOTE}project.json`]: DEPLOYED_MANIFEST }),
    });
    const resolved = await store.resolveActiveProject({ remoteBaseUrl: REMOTE });
    expect(resolved.project?.id).toBe('prj_remote');
    expect(resolved.backend.writable).toBe(false);
    expect(resolved.kind).toBe('bundled');
  });

  it('falls through to the normal resolution when the host has no project', async () => {
    const store = new ProjectStore();
    store.getRemoteBackend(REMOTE, { fetchImpl: fakeFetch({}) });
    const resolved = await store.resolveActiveProject({
      remoteBaseUrl: REMOTE,
      bundled: { fetchImpl: fakeFetch({}) },
    });
    // Not the unreachable remote one — that is the invariant, and it holds.
    expect(resolved.backend).not.toBe(store.getRemoteBackend(REMOTE));
    // plan-716 Phase 1 — RE-PINNED. "The normal resolution" was the bundled
    // backend; since §2.2 it is the writable "My Workspace" browser project. A
    // `?projectUrl=` typo therefore lands the visitor in their own workspace
    // instead of a read-only demo, which is the better of the two answers.
    expect(resolved.backend.kind).toBe('browser');
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
  });
});
