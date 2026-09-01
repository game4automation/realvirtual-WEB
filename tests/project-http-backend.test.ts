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

  // plan-735 3b: `scenes/index.json` is no longer read, here or anywhere. It fed
  // `_publishedEntries()`, which fed the synthetic manifest, which is gone — so
  // the last reader of that format went with it. A foreign deploy's example
  // scenes are `documents[]` rows of its own `project.json`, exactly like ours.
  it('ignores a foreign scenes/index.json — scenes come from the manifest', async () => {
    const backend = remoteBackend({
      [`${REMOTE}project.json`]: {
        ...DEPLOYED_MANIFEST,
        schemaVersion: 2,
        documents: [{ id: 'doc_a', name: 'Line A', path: 'scenes/A.glb', section: 'scenes' }],
      },
      [`${REMOTE}scenes/index.json`]: [{ file: 'Ghost.glb', name: 'Ghost', mode: 'planner' }],
    });
    const scenes = sceneDocumentsOf(await backend.readManifest());
    expect(scenes).toHaveLength(1);
    expect(scenes[0]!.path).toBe('scenes/A.glb');
    expect(scenes[0]!.name).toBe('Line A');
    // The catalogue entry is not merged in beside it.
    expect(scenes.map(s => s.name)).not.toContain('Ghost');
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

  // ── plan-735 R1: the deliberate degradation of plan-700 F12 ─────────────
  //
  // This case is where the decision is written down. A foreign deploy root that
  // publishes `models.json` but NO `project.json` used to be answered with the
  // synthetic demo project — the viewer inventing a project for a host that had
  // never published one. It is now `null` plus a named log line.
  //
  // That is a real capability loss and it was chosen, not overlooked: a host
  // nobody has ever built against is a worse thing to guess about than to
  // refuse, and a foreign host that wants to be readable publishes a
  // `project.json` like every other channel does. What the decision buys is
  // audibility — the failure has a sentence now instead of a plausible-looking
  // demo project.
  it('has no project when the base URL serves none, and says so out loud', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const backend = remoteBackend({ [`${REMOTE}models.json`]: ['Press.glb'] });
      expect(await backend.readManifest()).toBeNull();
      expect(backend.hasDeployedManifest()).toBe(false);
      // `models.json` alone is NOT a project — that is the whole degradation.
      expect(await backend.listModels()).toEqual([]);
      expect(warnings.join('\n')).toMatch(/project\.json could not be read/);
    } finally {
      console.warn = warn;
    }
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

  // The SECOND synthetic case (plan-735 5b): the OWN deploy root, without
  // `discover`. It asserted that injected models alone produced a project, and
  // it is the same removal as the foreign one above seen from the other side —
  // rewriting only one of the two would have left the other red or senselessly
  // green. Injected sources are a CATALOGUE; the project comes from the
  // manifest, and no manifest means no project on either path.
  it('yields no project from injected sources alone', async () => {
    const backend = new BundledBackend({
      baseUrl: '/',
      models: [{ url: '/models/Demo.glb', label: 'Demo' }],
      fetchImpl: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    expect(await backend.readManifest()).toBeNull();
    expect(assetDocumentsOf(await backend.readManifest(), 'models')).toEqual([]);
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

// ─── The third vector: the OWN deploy root, at runtime (plan-735 5g, R6) ───
//
// plan-735's two named regression vectors are both about what a delivery ships.
// This is the one that is about neither: the deploy DID publish a manifest and
// the browser cannot get it — a CORS rejection, a transient network failure, a
// CDN answering with an HTML error page, a `file://` page whose `fetch` refuses
// outright. Before plan-735 `_syntheticManifest()` absorbed all of that in
// silence and the visitor got a plausible-looking demo project. Now it is
// `null`, so the two things worth pinning are that the boot SURVIVES it and
// that it is not silent.
//
// `diagnoseKioskBoot()` does not cover this: it is scoped to `?projectUrl=` by
// its own contract, and the failures here happen on a deploy's own root.
describe('the deploy root has a manifest but the fetch fails (plan-735 R6)', () => {
  /** Every way `_fetchJson()` can come back empty, including the throwing ones. */
  const failures: Array<[string, typeof fetch]> = [
    ['a CORS rejection (fetch throws)',
      (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch],
    ['a file:// reject (fetch throws)',
      (async () => { throw new TypeError('URL scheme "file" is not supported'); }) as typeof fetch],
    ['a CDN HTML error page served with 200',
      (async () => new Response('<html>502</html>', {
        status: 200, headers: { 'content-type': 'text/html' },
      })) as typeof fetch],
    ['a plain 404',
      (async () => new Response('', { status: 404 })) as typeof fetch],
  ];

  it.each(failures)('%s yields null and never throws', async (_label, fetchImpl) => {
    const backend = new BundledBackend({ baseUrl: '/', fetchImpl });
    // The boot awaits this on its critical path; a throw here is a white page.
    await expect(backend.readManifest()).resolves.toBeNull();
    expect(backend.hasDeployedManifest()).toBe(false);
    expect(await backend.listDocuments()).toEqual([]);
  });

  it('the boot resolution survives a THROWING manifest fetch (project-store 3d)', async () => {
    // `resolveActiveProject()` called `bundled.readManifest()` on its main path
    // with no try/catch — the `remoteBaseUrl` branch had one, this one never
    // did. It was survivable only because a synthetic manifest made throwing
    // effectively impossible; with `null` a normal outcome, the throw beside it
    // has to be one too.
    const store = new ProjectStore();
    const resolved = await store.resolveActiveProject({
      bundled: { fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch },
    });
    // Not a crashed boot: the visitor lands in their own workspace.
    expect(resolved.project).not.toBeNull();
    expect(resolved.backend.kind).toBe('browser');
    expect(resolved.project?.id).toBe(WORKSPACE_DEFAULT_PROJECT_ID);
  });

  it('says which failure it was, in one line per cause', async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      // Unreadable body: the server ANSWERED, so this is the "not valid JSON"
      // sentence, distinct from the "could not be read" one.
      const html = new BundledBackend({
        baseUrl: '/',
        fetchImpl: (async () => new Response('<html>502</html>', { status: 200 })) as typeof fetch,
      });
      expect(await html.readManifest()).toBeNull();
      expect(warnings.join('\n')).toMatch(/is not valid JSON/);
      expect(warnings.join('\n')).toMatch(/could not be read/);
    } finally {
      console.warn = warn;
    }
  });
});
