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
import { resolveServedProjectUrl, resolveHostedBoot, resolveDeepLinkBoot, deepLinkStartAction } from '../src/core/project/rv-project-open';
import { readProjectStart } from '../src/core/project/rv-project-types';
import { ProjectStore, LS_KEY_LAST_PROJECT } from '../src/core/project/project-store';
import mainSource from '../src/main.ts?raw';
import bootModeSource from '../src/core/rv-boot-mode.ts?raw';

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
    const hosted = mainSource.lastIndexOf('resolveHostedBoot({');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(resolve);
    expect(gate).toBeLessThan(docOpen);
    expect(hosted).toBeGreaterThan(docOpen); // ?doc= routed first; the dashboard rule only applies to an unrouted boot
    // and the served project comes from the query OR settings.json
    expect(mainSource).toContain('resolveServedProjectUrl(');
    expect(mainSource).toContain('remoteRequired: true');
  });
});

// ─── plan-640: the opt-in hosted start document (`settings.start`) ────────

describe('readProjectStart (plan-640)', () => {
  const withSettings = (settings: unknown) => ({ ...MANIFEST, settings } as unknown as Parameters<typeof readProjectStart>[0]);

  it('reads document and an optional mode, trimmed', () => {
    expect(readProjectStart(withSettings({ start: { document: ' doc_a ', mode: ' hmi ' } })))
      .toEqual({ document: 'doc_a', mode: 'hmi' });
    expect(readProjectStart(withSettings({ start: { document: 'doc_a' } }))).toEqual({ document: 'doc_a' });
    expect(readProjectStart(withSettings({ start: { document: 'doc_a', mode: 7 } }))).toEqual({ document: 'doc_a' });
  });

  it('is null for anything that is not a start document', () => {
    expect(readProjectStart(null)).toBeNull();
    expect(readProjectStart(withSettings(undefined))).toBeNull();
    expect(readProjectStart(withSettings({ defaultModel: 'a.glb' }))).toBeNull();
    expect(readProjectStart(withSettings({ start: 'doc_a' }))).toBeNull();
    expect(readProjectStart(withSettings({ start: { document: '  ' } }))).toBeNull();
    expect(readProjectStart(withSettings({ start: [] }))).toBeNull();
  });
});

describe('resolveHostedBoot with settings.start (plan-640)', () => {
  const documents = [
    { id: 'doc_a', path: 'models/a.glb', name: 'Cell A' },
    { id: 'doc_b', path: 'models/b.glb', name: 'Cell B' },
  ];
  const base = { servedProjectUrl: REMOTE, modeLocked: false, hasDeployedManifest: true, documentCount: documents.length, documents };

  // §9.1
  it('opens the start document by id, in its mode', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: true, start: { document: 'doc_b', mode: 'hmi' } }))
      .toEqual({ kind: 'document', docId: 'doc_b', docName: 'Cell B', mode: 'hmi' });
  });

  it('opens the same document when it is named by path', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: true, start: { document: 'models/b.glb', mode: 'hmi' } }))
      .toEqual({ kind: 'document', docId: 'doc_b', docName: 'Cell B', mode: 'hmi' });
  });

  it('carries no mode when the start names none', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: true, start: { document: 'doc_a' } }))
      .toEqual({ kind: 'document', docId: 'doc_a', docName: 'Cell A', mode: null });
  });

  // §9.2
  it('without a start document the root stays the dashboard (D14)', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: true, start: null })).toEqual({ kind: 'dashboard' });
  });

  it('a kiosk lock keeps the kiosk path, start or not', () => {
    expect(resolveHostedBoot({ ...base, modeLocked: true, hostedDeploy: true, start: { document: 'doc_a', mode: 'hmi' } }))
      .toEqual({ kind: 'not-hosted' });
  });

  it('an unknown start document keeps the dashboard and says why', () => {
    const verdict = resolveHostedBoot({ ...base, hostedDeploy: true, start: { document: 'doc_missing', mode: 'hmi' } });
    expect(verdict.kind).toBe('dashboard');
    expect(verdict).toMatchObject({ warning: expect.stringContaining('doc_missing') });
  });

  // §9.3b
  it('without the hosted-deploy marker (a ?projectUrl= boot) the start is ignored silently', () => {
    expect(resolveHostedBoot({ ...base, start: { document: 'doc_a', mode: 'hmi' } })).toEqual({ kind: 'dashboard' });
    expect(resolveHostedBoot({ ...base, hostedDeploy: false, start: { document: 'doc_a' } })).toEqual({ kind: 'dashboard' });
  });

  it('the error card still wins over a start document', () => {
    expect(resolveHostedBoot({ ...base, hasDeployedManifest: false, documentCount: 0, hostedDeploy: true, start: { document: 'doc_a' } }))
      .toMatchObject({ kind: 'error', reason: 'no-manifest' });
  });
});

// ─── plan-2018: the ?projectUrl= deep link opens the start document ──────

describe('resolveHostedBoot deep link (plan-2018)', () => {
  const documents = [
    { id: 'doc_a', path: 'models/Machine.glb', name: 'Machine' },
    { id: 'doc_b', path: 'models/b.glb', name: 'Cell B' },
  ];
  const base = {
    servedProjectUrl: REMOTE, servedFromQuery: true, modeLocked: false,
    hasDeployedManifest: true, documentCount: documents.length, documents,
  };

  it('9.1 opens defaultModel named by bare file name', () => {
    expect(resolveHostedBoot({ ...base, defaultModel: 'Machine.glb' }))
      .toEqual({ kind: 'document', docId: 'doc_a', docName: 'Machine', mode: null, deepLink: true });
  });
  it('9.2 opens defaultModel named by path', () => {
    expect(resolveHostedBoot({ ...base, defaultModel: 'models/Machine.glb' }))
      .toMatchObject({ kind: 'document', docId: 'doc_a' });
  });
  it('9.3 no defaultModel, no start: dashboard without warning', () => {
    expect(resolveHostedBoot({ ...base })).toEqual({ kind: 'dashboard', deepLink: true });
  });
  it('9.4 query boot with hostedDeploy marker keeps the dashboard (D14)', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: true, defaultModel: 'Machine.glb' }))
      .toEqual({ kind: 'dashboard' });
  });
  it('9.5 settings.json project (not from query) with marker and defaultModel keeps the dashboard', () => {
    expect(resolveHostedBoot({ ...base, servedFromQuery: false, hostedDeploy: true, defaultModel: 'Machine.glb' }))
      .toEqual({ kind: 'dashboard' });
  });
  it('9.5b an unmarked loader (no hostedDeploy, as generatedSettings() writes) opens the start document (Option A)', () => {
    expect(resolveHostedBoot({ ...base, hostedDeploy: false, defaultModel: 'Machine.glb' }))
      .toMatchObject({ kind: 'document', docId: 'doc_a' });
  });
  it('9.6 unresolvable defaultModel: dashboard with warning', () => {
    const v = resolveHostedBoot({ ...base, defaultModel: 'nope.glb' });
    expect(v).toMatchObject({ kind: 'dashboard', deepLink: true, warning: expect.stringContaining('nope.glb') });
  });
  it('9.7 start.document beats defaultModel, mode from start.mode', () => {
    expect(resolveHostedBoot({ ...base, defaultModel: 'Machine.glb', start: { document: 'doc_b', mode: 'hmi' } }))
      .toEqual({ kind: 'document', docId: 'doc_b', docName: 'Cell B', mode: 'hmi', deepLink: true });
  });
  it('9.8 mode.lock stays not-hosted', () => {
    expect(resolveHostedBoot({ ...base, modeLocked: true, defaultModel: 'Machine.glb' }))
      .toEqual({ kind: 'not-hosted' });
  });
});

describe('deep-link boot decision, executable (plan-2018 9.11)', () => {
  const documents = [
    { id: 'doc_a', name: 'Machine', path: 'models/Machine.glb' },
    { id: 'doc_b', name: 'Cell B', path: 'models/cellb.glb' },
  ] as never;
  const base = {
    servedProjectUrl: REMOTE, servedFromQuery: true, modeLocked: false,
    hasDeployedManifest: true, documentCount: 2, documents,
  };
  it('suppresses implicit routes for document, dashboard and unresolved-start verdicts', () => {
    expect(resolveDeepLinkBoot({ ...base, defaultModel: 'Machine.glb' }))
      .toMatchObject({ isDeepLink: true, suppressImplicitRoutes: true, verdict: { kind: 'document' } });
    expect(resolveDeepLinkBoot({ ...base }))
      .toMatchObject({ suppressImplicitRoutes: true, verdict: { kind: 'dashboard' } });
    expect(resolveDeepLinkBoot({ ...base, defaultModel: 'nope.glb' }))
      .toMatchObject({ suppressImplicitRoutes: true, verdict: { kind: 'dashboard', warning: expect.any(String) } });
  });
  it('suppresses implicit routes for the error verdict (no manifest)', () => {
    const r = resolveDeepLinkBoot({ ...base, hasDeployedManifest: false, documentCount: 0, documents: [] });
    expect(r.verdict.kind).toBe('error');
    expect(r.suppressImplicitRoutes).toBe(true);
  });
  it('does not apply to marked deploys, kiosk locks or non-query boots', () => {
    expect(resolveDeepLinkBoot({ ...base, hostedDeploy: true }).suppressImplicitRoutes).toBe(false);
    expect(resolveDeepLinkBoot({ ...base, modeLocked: true }).suppressImplicitRoutes).toBe(false);
    expect(resolveDeepLinkBoot({ ...base, servedFromQuery: false }).isDeepLink).toBe(false);
    expect(resolveDeepLinkBoot({ ...base, servedProjectUrl: null }).suppressImplicitRoutes).toBe(false);
  });
  it('guard consent opens the document, refusal shows the dashboard', () => {
    const v = resolveDeepLinkBoot({ ...base, defaultModel: 'Machine.glb' }).verdict;
    expect(deepLinkStartAction(v, true)).toBe('open-document');
    expect(deepLinkStartAction(v, false)).toBe('dashboard');
  });
  it('dashboard case with an unresolved target carries the Problems warning action', () => {
    const v = resolveDeepLinkBoot({ ...base, defaultModel: 'nope.glb' }).verdict;
    expect(deepLinkStartAction(v, true)).toBe('dashboard-with-warning');
    expect(deepLinkStartAction(resolveDeepLinkBoot({ ...base }).verdict, true)).toBe('dashboard');
  });
});

describe('main.ts wiring of the deep-link start (plan-2018 9.9 / 9.10)', () => {
  it('9.9 deep link suppresses the implicit planner route and saved-scene restore; ?doc= routes first', () => {
    const doc = mainSource.indexOf('await sceneStore.openDocument(urlDoc);');
    const switchAt = mainSource.indexOf('const hostedStartApplies = hostedStart !== null || deepLinkApplies;');
    const hosted = mainSource.indexOf('resolveHostedBoot({', switchAt);
    expect(switchAt).toBeGreaterThan(0);
    expect(mainSource).toContain("servedFromQuery = (urlParams.get('projectUrl') ?? '').trim() !== '';");
    expect(hosted).toBeGreaterThan(doc);
    expect(mainSource.indexOf('if (!sceneRouted && !hostedStartApplies) {')).toBeGreaterThan(switchAt);
  });
  it('9.10 guardHeavyRestore only for the deep-link verdict, refusal shows the dashboard', () => {
    const at = mainSource.indexOf("hostedBoot.kind === 'document' && hostedBoot.deepLink");
    expect(at).toBeGreaterThan(0);
    const slice = mainSource.slice(at, at + 400);
    expect(slice).toContain('!await guardHeavyRestore(hostedBoot.docId, hostedBoot.docName)');
    // Boot-time openings go through autoOpenProjectsDashboard() (none in recording mode, plan-2240).
    expect(slice).toContain('autoOpenProjectsDashboard();');
    expect(mainSource).toContain("'projecturl-start-unresolved'");
  });
});

describe('main.ts wiring of the hosted start document (plan-640 §9.3 / §9.3b)', () => {
  it('computes ONE switch after hydration, excluding the kiosk and requiring the deploy marker', () => {
    const hydrate = mainSource.indexOf('await projectStore.hydrateProjectScenes();');
    const startAt = mainSource.indexOf(
      'const hostedStart = servedProjectUrl && viewer.modes.lockedMode === null && appConfig.hostedDeploy === true');
    const switchAt = mainSource.indexOf('const hostedStartApplies = hostedStart !== null || deepLinkApplies;');
    expect(hydrate).toBeGreaterThan(0);
    expect(startAt).toBeGreaterThan(hydrate);
    expect(switchAt).toBeGreaterThan(startAt);
    expect(mainSource).toContain('readProjectStart(getProjectStore().getProject())');
  });

  it('suppresses only the IMPLICIT ?mode=planner empty route and the active-scene restore', () => {
    const switchAt = mainSource.indexOf('const hostedStartApplies = hostedStart !== null || deepLinkApplies;');
    const implicit = mainSource.indexOf("!urlGlb && !urlDoc && !hostedStartApplies)) ? 'empty' : null)");
    const restore = mainSource.indexOf('if (!sceneRouted && !hostedStartApplies) {');
    const activeId = mainSource.indexOf('const activeId = readActiveId();');
    expect(implicit).toBeGreaterThan(switchAt);
    expect(restore).toBeGreaterThan(switchAt);
    expect(activeId).toBeGreaterThan(restore);
    // `?scene=` stays the first operand: an explicit `?scene=empty` still wins.
    expect(mainSource).toMatch(/const urlScene = params\.get\('scene'\)\s*\?\?/);
  });

  it('opens the start document with the caller deciding the mode, and a failure stays routed', () => {
    const hosted = mainSource.lastIndexOf('resolveHostedBoot({');
    const open = mainSource.indexOf(
      'await sceneStore.openDocument(hostedBoot.docId, { name: hostedBoot.docName, modeDecidedByCaller: true });');
    expect(open).toBeGreaterThan(hosted);
    const branchEnd = mainSource.indexOf("} else if (hostedBoot.kind === 'dashboard') {", open);
    expect(branchEnd).toBeGreaterThan(open);
    const branch = mainSource.slice(open, branchEnd);
    expect(branch).toContain('showLoadingError(');
    expect(branch).toContain("code: 'hosted-start-failed'");
    expect(branch).toContain('sceneRouted = true;');
    const dashboard = mainSource.slice(branchEnd, mainSource.indexOf('autoOpenProjectsDashboard();', branchEnd));
    expect(dashboard).toContain("'hosted-start-unresolved'");
  });

  it('mode cascade: ?mode= before the hosted start mode before the row and resume modes', () => {
    // plan-652: the cascade lives in resolveBootMode (rv-boot-mode.ts); main.ts
    // hands it the four candidates in this order.
    const urlMode = mainSource.indexOf('url: urlMode,');
    const hostedMode = mainSource.indexOf('hostedStart: hostedStartMode,');
    const published = mainSource.indexOf('published: publishedBootMode,');
    const resume = mainSource.indexOf('resume: resumeBootMode,');
    const order = bootModeSource.indexOf("['url', candidates.url]");
    expect(order).toBeGreaterThan(0);
    expect(bootModeSource.indexOf("['hostedStart', candidates.hostedStart]")).toBeGreaterThan(order);
    expect(bootModeSource.indexOf("['published', candidates.published]")).toBeGreaterThan(bootModeSource.indexOf("['hostedStart', candidates.hostedStart]"));
    expect(bootModeSource.indexOf("['resume', candidates.resume]")).toBeGreaterThan(bootModeSource.indexOf("['published', candidates.published]"));
    expect(urlMode).toBeGreaterThan(0);
    expect(hostedMode).toBeGreaterThan(urlMode);
    expect(published).toBeGreaterThan(hostedMode);
    expect(resume).toBeGreaterThan(published);
  });
});
