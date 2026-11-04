// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.9 — library PROJECTS in the planner's Library window (and the
 * shared view rules the dashboard roots use).
 *
 *  - one section (tab) per DIRECT library project, in `libraries[]` order,
 *    between the open project and the external catalogs; each carries its state;
 *  - transitive libraries are not tabs (not placeable, Decision 4) — they are
 *    listed in a "Needed by <B>" group, never selectable;
 *  - state badges: ready / Loading… / Access needed → Grant / Not found →
 *    Locate folder… (only where a folder can be picked) / Failed to load;
 *  - provider-filter decisions (`isProjectBackedProvider`): a project-backed
 *    source is never deduplicated against the open project and never hidden as
 *    "all deduped"; only the open project is the dedup reference.
 *
 * The sources are the REAL library-projects provider over a real loader, so the
 * tabs are built from exactly what the registry publishes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildLibraryTabs, dedupedEntries, projectDedupKeys } from '../src/plugins/layout-planner/LayoutLibraryPanel';
import { LibrarySelector } from '../src/plugins/layout-planner/LibrarySelector';
import { LibraryProjectLoader, type LibraryProjectLoaderDeps } from '../src/core/library/library-project-loader';
import { installLibraryProjectsProvider, uninstallLibraryProjectsProvider } from '../src/core/library/library-projects-provider';
import { listLibrarySources, registerLibrarySourceProvider, type LibrarySource } from '../src/core/library/library-source-registry';
import {
  isProjectBackedProvider,
  LIBRARY_PROJECTS_PROVIDER_ID,
  OPEN_PROJECT_PROVIDER_ID,
} from '../src/core/library/library-origin';
import { PROJECT_LIBRARY_PROVIDER_ID } from '../src/core/library/project-library-provider';
import { buildNeededByGroups, libraryStateBadge } from '../src/core/library/library-project-ui';
import { resetLibraryAvailabilityForTests, setLibraryAvailabilityDepsForTests } from '../src/core/library/library-availability';
import type { RvProject } from '../src/core/project/rv-project-types';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { LibraryCatalogEntry } from '../src/core/library/library-types';
import { fakeLibraryProject } from './helpers/fake-document-project';

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanup();
  for (const c of cleanups.splice(0)) c();
  uninstallLibraryProjectsProvider();
  resetLibraryAvailabilityForTests();
});

/** A loader whose libraries are browser projects (B, C) — plus nothing for the rest (unknown). */
async function libraries(refs: unknown[], backends: Record<string, ProjectBackend>): Promise<LibraryProjectLoader> {
  const deps: LibraryProjectLoaderDeps = {
    factory: {
      folder: () => { throw new Error('no folders'); },
      browser: (id) => backends[id] ?? null,
      remote: () => ({ readManifest: async () => null }) as never,
    },
    builtinBaseUrl: () => null,
  };
  const loader = new LibraryProjectLoader(deps);
  installLibraryProjectsProvider(loader);
  loader.setProject({ id: 'prj_a', name: 'A', libraries: refs } as unknown as RvProject);
  await loader.whenSettled();
  cleanups.push(() => loader.dispose());
  return loader;
}

function openProjectSource(entries: LibraryCatalogEntry[]): void {
  const source: LibrarySource = {
    id: 'prj_a', label: 'A', kind: 'project', writable: true, loaded: true,
    listEntries: () => entries, getEntry: (id) => entries.find((e) => e.id === id) ?? null,
    resolveAsset: async () => ({ url: 'blob:a' }),
  };
  cleanups.push(registerLibrarySourceProvider({ id: PROJECT_LIBRARY_PROVIDER_ID, listSources: () => [source], subscribe: () => () => {} }));
}

function catalogSource(entries: LibraryCatalogEntry[]): void {
  const source: LibrarySource = {
    id: 'https://x/catalog.json', label: 'Catalog X', kind: 'url', writable: false, loaded: true,
    listEntries: () => entries, getEntry: (id) => entries.find((e) => e.id === id) ?? null,
    resolveAsset: async () => ({ url: 'blob:x' }),
  };
  cleanups.push(registerLibrarySourceProvider({ id: 'global', listSources: () => [source], subscribe: () => () => {} }));
}

const B = (): ProjectBackend => fakeLibraryProject({
  id: 'prj_b', name: 'SharedConveyors', kind: 'browser',
  documents: [{ id: 'models/pump', path: 'library/pump.glb' }],
  libraries: [{ projectId: 'prj_motors', label: 'Motors' }],
}).backend;

describe('plan-778 9.9 — a section per direct library project', () => {
  it('open project first, then direct library projects in libraries[] order, then catalogs; transitive ones are no tab', async () => {
    openProjectSource([]);
    catalogSource([{ id: 'c1', name: 'c1', category: 'custom' }]);
    await libraries(
      [{ projectId: 'prj_b' }, { projectId: 'prj_gone', label: 'Gone' }],
      { prj_b: B() },
    );
    const tabs = buildLibraryTabs(listLibrarySources(), []);
    expect(tabs.map((t) => [t.providerId, t.sourceId])).toEqual([
      [PROJECT_LIBRARY_PROVIDER_ID, 'prj_a'],
      [LIBRARY_PROJECTS_PROVIDER_ID, 'prj_b'],
      [LIBRARY_PROJECTS_PROVIDER_ID, 'prj_gone'],
      ['global', 'https://x/catalog.json'],
    ]);
    const b = tabs.find((t) => t.sourceId === 'prj_b')!;
    expect([b.libraryProjectId, b.state]).toEqual(['prj_b', 'ready']);
    expect(tabs.find((t) => t.sourceId === 'prj_gone')!.state).toBe('unknown');
    // prj_motors (needed by B) and the built-in realvirtual library are not tabs.
    expect(tabs.some((t) => t.sourceId === 'prj_motors')).toBe(false);
    expect(tabs.some((t) => t.sourceId === 'prj_realvirtual_library')).toBe(false);
  });

  it('transitive libraries are grouped under the library that needs them', async () => {
    await libraries([{ projectId: 'prj_b' }], { prj_b: B() });
    expect(buildNeededByGroups(listLibrarySources())).toEqual([
      { neededById: 'prj_b', neededByLabel: 'SharedConveyors', items: [{ projectId: 'prj_motors', label: 'Motors', state: 'unknown' }] },
    ]);
  });
});

describe('plan-778 9.9 — state badges', () => {
  it('maps each state to its word and repair; Locate only where a folder can be picked', () => {
    expect(libraryStateBadge('ready')).toMatchObject({ text: 'Ready', repairCommand: null, attention: false });
    expect(libraryStateBadge('pending')).toMatchObject({ text: 'Loading…', repairCommand: null });
    expect(libraryStateBadge('locked')).toMatchObject({ text: 'Access needed', repairLabel: 'Grant', repairCommand: 'library.grant', attention: true });
    setLibraryAvailabilityDepsForTests({ directoryPicker: () => () => Promise.reject(new Error('x')) });
    expect(libraryStateBadge('unknown')).toMatchObject({ text: 'Not found', repairLabel: 'Locate folder…', repairCommand: 'library.locate' });
    expect(libraryStateBadge('error')).toMatchObject({ text: 'Failed to load', repairCommand: 'library.locate' });
    setLibraryAvailabilityDepsForTests({ directoryPicker: () => null });
    expect(libraryStateBadge('unknown')).toMatchObject({ text: 'Not found', repairLabel: null, repairCommand: null, attention: true });
  });

  it('the selector shows the state word and a "Needed by" group that cannot be picked', async () => {
    const picked: string[] = [];
    render(
      <LibrarySelector
        items={[
          { id: 'library-projects:prj_b', label: 'SharedConveyors', kind: 'project', state: 'locked' },
          { id: 'global:x', label: 'Catalog X', kind: 'url' },
        ]}
        activeId={null}
        onSelect={(id) => picked.push(id)}
        onManage={() => {}}
        neededBy={[{ neededById: 'prj_b', neededByLabel: 'SharedConveyors', items: [{ projectId: 'prj_motors', label: 'Motors', state: 'unknown' }] }]}
        stateText={(s) => libraryStateBadge(s).text}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /select library/i }));
    const b = document.querySelector('[data-library-item="library-projects:prj_b"]')!;
    expect(b.getAttribute('data-library-state')).toBe('locked');
    expect(b.textContent).toContain('Access needed');
    expect(screen.getByText('Needed by SharedConveyors')).toBeTruthy();
    const motors = document.querySelector('[data-library-item="prj_motors"]')!;
    expect(motors.getAttribute('aria-disabled')).toBe('true');
    expect(motors.textContent).toContain('Not found');
    // The panel keeps ONE management route (plan-702 F8): no Remove here — it lives in the dashboard.
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    fireEvent.click(b);
    expect(picked).toEqual(['library-projects:prj_b']);
  });
});

describe('plan-778 9.9 — provider-filter sites (isProjectBackedProvider)', () => {
  it('both project providers are project-backed; catalogs are not', () => {
    expect(isProjectBackedProvider(OPEN_PROJECT_PROVIDER_ID)).toBe(true);
    expect(PROJECT_LIBRARY_PROVIDER_ID).toBe(OPEN_PROJECT_PROVIDER_ID);
    expect(isProjectBackedProvider(LIBRARY_PROJECTS_PROVIDER_ID)).toBe(true);
    expect(isProjectBackedProvider('global')).toBe(false);
    expect(isProjectBackedProvider(undefined)).toBe(false);
  });

  it('only the open project is the dedup reference; a library project is never deduplicated or hidden', async () => {
    // The open project and library B both hold a `library/pump.glb`; a catalog does too.
    openProjectSource([{ id: 'project:library/pump.glb', name: 'pump', category: 'custom', localPath: 'library/pump.glb' }]);
    catalogSource([{ id: 'cat-pump', name: 'pump', category: 'custom', glbUrl: 'https://x/library/pump.glb' }]);
    await libraries([{ projectId: 'prj_b' }], { prj_b: B() });
    const sources = listLibrarySources();
    const keys = projectDedupKeys(sources)!;
    expect([...keys]).toEqual(['pump.glb']);   // from the OPEN project only
    const lib = sources.find((s) => s.providerId === LIBRARY_PROJECTS_PROVIDER_ID && s.source.id === 'prj_b')!;
    expect(dedupedEntries(lib, keys).map((e) => e.id)).toEqual(['models/pump']);
    const tabs = buildLibraryTabs(sources, []);
    expect(tabs.some((t) => t.sourceId === 'prj_b')).toBe(true);
    // The catalog whose only entry the project already offers is hidden as before.
    expect(tabs.some((t) => t.sourceId === 'https://x/catalog.json')).toBe(false);
  });
});

describe('plan-778 9.9 — MCP parts list: the third origin', () => {
  it('library.catalogList lists direct library documents as source "library" with libraryProjectId; transitive ones not', async () => {
    const { McpSceneTools } = await import('../src/plugins/mcp-bridge/rv-mcp-scene-tools');
    const C = fakeLibraryProject({ id: 'prj_motors', name: 'Motors', kind: 'browser', documents: [{ id: 'models/motor', path: 'm.glb' }] }).backend;
    await libraries([{ projectId: 'prj_b' }], { prj_b: B(), prj_motors: C });
    const viewer = {
      getPlugin: (id: string) => (id === 'layout-planner' ? { store: { getSnapshot: () => ({ catalogs: new Map() }) } } : undefined),
    } as never;
    const tools = new McpSceneTools(() => viewer);
    const all = JSON.parse(await tools.queryCatalogList());
    expect(all).toEqual([expect.objectContaining({
      catalogId: 'models/pump', source: 'library', libraryProjectId: 'prj_b', documentId: 'models/pump',
    })]);
    // One library by name; the transitive Motors is resolvable but never offered.
    const one = JSON.parse(await tools.queryCatalogList('library-projects/prj_b'));
    expect(one.map((r: { catalogId: string }) => r.catalogId)).toEqual(['models/pump']);
    const viaQuery = JSON.parse(await tools.queryCatalogList(undefined, 'motor'));
    expect(viaQuery).toEqual([]);
  });
});
