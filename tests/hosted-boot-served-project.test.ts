// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * hosted-boot-served-project.test.ts — plan-759 §9.5 / §9.6.
 *
 *  - Where the served project comes from: `?projectUrl=` first, else the
 *    `projectUrl` of settings.json resolved against the runtime, else none.
 *  - What a hosted boot shows: the dashboard, always (D14); the error card when
 *    the deploy serves no manifest; nothing of this on a kiosk (`mode.lock`).
 *  - The store resolves ONLY the served project on a hosted boot — never the
 *    project this origin last had open (F4b).
 *  - The gate runs before any project is resolved or any document opened, so a
 *    `?doc=` deep link cannot bypass it (§9.6, pinned on the boot source).
 */

import { describe, it, expect } from 'vitest';
import { resolveServedProjectUrl, resolveHostedBoot } from '../src/core/project/rv-project-open';
import { ProjectStore, LS_KEY_LAST_PROJECT } from '../src/core/project/project-store';
import mainSource from '../src/main.ts?raw';

const REMOTE = 'https://web.example.test/deadbeef/p/';

function fakeFetch(files: Record<string, unknown>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = files[url];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const MANIFEST = { schemaVersion: 2, id: 'prj_hosted', name: 'Hosted', canonicalName: 'hosted', kind: 'customer',
  documents: [{ id: 'doc_a', path: 'models/a.glb', name: 'a' }] };

describe('resolveServedProjectUrl', () => {
  const base = 'https://web.example.test/deadbeef/index.html';

  it('the query wins, verbatim', () => {
    expect(resolveServedProjectUrl('/p/other/', 'p/', base)).toBe('/p/other/');
    expect(resolveServedProjectUrl(' https://x/y/ ', 'p/', base)).toBe('https://x/y/');
  });

  it('settings.projectUrl resolves against the runtime URL and ends in a slash', () => {
    expect(resolveServedProjectUrl(null, 'p/', base)).toBe('https://web.example.test/deadbeef/p/');
    expect(resolveServedProjectUrl(undefined, 'p', base)).toBe('https://web.example.test/deadbeef/p/');
    expect(resolveServedProjectUrl('', 'https://cdn.example.test/customer', base)).toBe('https://cdn.example.test/customer/');
  });

  it('an ordinary deploy names nothing', () => {
    expect(resolveServedProjectUrl(null, undefined, base)).toBeNull();
    expect(resolveServedProjectUrl('', '  ', base)).toBeNull();
  });
});

describe('resolveHostedBoot (D14)', () => {
  it('is the dashboard for a served project, whatever the manifest says about a start document', () => {
    expect(resolveHostedBoot({ servedProjectUrl: REMOTE, modeLocked: false, hasDeployedManifest: true, documentCount: 3 }))
      .toEqual({ kind: 'dashboard' });
  });

  it('is the error card when the deploy serves no manifest or no documents', () => {
    const noManifest = resolveHostedBoot({ servedProjectUrl: REMOTE, modeLocked: false, hasDeployedManifest: false, documentCount: 0 });
    expect(noManifest.kind).toBe('error');
    expect(noManifest).toMatchObject({ reason: 'no-manifest' });
    const empty = resolveHostedBoot({ servedProjectUrl: REMOTE, modeLocked: false, hasDeployedManifest: true, documentCount: 0 });
    expect(empty).toMatchObject({ kind: 'error', reason: 'no-documents' });
  });

  it('stays out of the kiosk path and of ordinary deploys', () => {
    expect(resolveHostedBoot({ servedProjectUrl: REMOTE, modeLocked: true, hasDeployedManifest: true, documentCount: 1 }))
      .toEqual({ kind: 'not-hosted' });
    expect(resolveHostedBoot({ servedProjectUrl: null, modeLocked: false, hasDeployedManifest: true, documentCount: 1 }))
      .toEqual({ kind: 'not-hosted' });
  });
});

describe('ProjectStore on a hosted boot (F4b)', () => {
  it('resolves the served project', async () => {
    const store = new ProjectStore();
    store.getRemoteBackend(REMOTE, { fetchImpl: fakeFetch({ [`${REMOTE}project.json`]: MANIFEST }) });
    const resolved = await store.resolveActiveProject({ remoteBaseUrl: REMOTE, remoteRequired: true, bundled: { fetchImpl: fakeFetch({}) } });
    expect(resolved.project?.id).toBe('prj_hosted');
    expect(resolved.backend).toBe(store.getRemoteBackend(REMOTE));
  });

  it('never resolves the project this origin last had open when the served one fails', async () => {
    try { localStorage.setItem(LS_KEY_LAST_PROJECT, 'folder:someone-elses-project'); } catch { /* private mode */ }
    const store = new ProjectStore();
    store.getRemoteBackend(REMOTE, { fetchImpl: fakeFetch({}) }); // 404 on project.json
    const resolved = await store.resolveActiveProject({
      remoteBaseUrl: REMOTE, remoteRequired: true, projectId: 'someone-elses-project', bundled: { fetchImpl: fakeFetch({}) },
    });
    expect(resolved.backend).not.toBe(store.getRemoteBackend(REMOTE));
    expect(store.getRemoteBackend(REMOTE).hasDeployedManifest()).toBe(false);
    // Neither the remembered id nor `?project=` was looked up: no folder grant
    // was consulted, so no restore failure was recorded for it.
    expect(resolved.project?.id).not.toBe('someone-elses-project');
    try { localStorage.removeItem(LS_KEY_LAST_PROJECT); } catch { /* ignore */ }
  });
});

describe('main.ts boot order (§9.6): the gate runs before any project or document', () => {
  it('requireHostedPassword is awaited before the project is resolved and before ?doc= opens', () => {
    const gate = mainSource.indexOf('await requireHostedPassword(appConfig);');
    const resolve = mainSource.indexOf('resolveActiveProject({');
    const docOpen = mainSource.indexOf('await sceneStore.openDocument(urlDoc);');
    const hosted = mainSource.indexOf('resolveHostedBoot({');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolve);
    expect(gate).toBeLessThan(docOpen);
    expect(hosted).toBeGreaterThan(docOpen); // ?doc= routed first; the dashboard rule only applies to an unrouted boot
    // and the served project comes from the query OR settings.json
    expect(mainSource).toContain('resolveServedProjectUrl(');
    expect(mainSource).toContain('remoteRequired: true');
  });
});
