// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.4 — legacy (unqualified) references keep resolving (F5).
 *
 * An unmigrated project lists no library project at all; its GLBs carry bare
 * catalog ids (`pallethandling-*`), GitHub-scan ids (`realvirtual-library-*-glb`)
 * or a pre-778 `global` + catalog-URL qualifier. All of them must resolve
 * through the built-in realvirtual library project (Decision C), canonical ids
 * first, aliases second — an alias in one library never beats a canonical id
 * in another.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';
import type { RvProject } from '../src/core/project/rv-project-types';
import { resetLibrarySourceRegistryForTests } from '../src/core/library/library-source-registry';
import { LibraryProjectLoader } from '../src/core/library/library-project-loader';
import {
  installLibraryProjectsProvider,
  uninstallLibraryProjectsProvider,
} from '../src/core/library/library-projects-provider';
import {
  REALVIRTUAL_LIBRARY_PROJECT_ID,
  findLegacyOrigin,
  isRealvirtualCatalogUrl,
} from '../src/core/library/library-origin';
import { createReferenceResolver } from '../src/core/engine/rv-glb-reference-resolver';
import type { AssetReference } from '../src/core/engine/rv-asset-reference';
import { fakeLibraryProject } from './helpers/fake-document-project';

const CHAIN = 'pallethandling-chainconveyor-1m';
const CHAIN_SCAN = 'realvirtual-library-pallethandling-chainconveyor-1m-glb';

/** The node name a `fakeGlb(marker)` carries — whose bytes did we get? */
function markerOf(bytes: ArrayBuffer): string {
  const view = new DataView(bytes);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLen)).trim());
  return json.nodes[0].name;
}

function project(libraries?: unknown[]): RvProject {
  return { schemaVersion: 2, id: 'prj_customer', name: 'Customer', canonicalName: 'customer', ...(libraries ? { libraries } : {}) } as unknown as RvProject;
}

async function boot(opts: { libraries?: unknown[]; extra?: Record<string, ProjectBackend> } = {}): Promise<LibraryProjectLoader> {
  const rv = fakeLibraryProject({
    id: REALVIRTUAL_LIBRARY_PROJECT_ID, name: 'realvirtual Library', kind: 'bundled',
    documents: [{ id: CHAIN, path: 'PalletHandling/ChainConveyor-1m.glb', aliases: [CHAIN_SCAN], marker: 'rv:chain' }],
  });
  const loader = new LibraryProjectLoader({
    factory: {
      folder: () => { throw new Error('no folders'); },
      browser: (id) => opts.extra?.[id] ?? null,
      remote: (base) => (base === 'https://app/library/' ? rv.backend : ({ readManifest: async () => null }) as unknown as ProjectBackend),
    },
    getLinkedHandle: async () => null,
    hasReadPermission: async () => false,
    builtinBaseUrl: () => 'https://app/library/',
  });
  installLibraryProjectsProvider(loader);
  loader.setProject(project(opts.libraries));
  await loader.whenSettled();
  return loader;
}

async function resolve(ref: AssetReference): Promise<string | null> {
  const out = await createReferenceResolver()(ref, { baseUrl: 'https://app/models/Plant.glb', occurrence: 'root/0', depth: 0, resolvedPath: '' });
  return out ? markerOf(out.bytes as ArrayBuffer) : null;
}

afterEach(() => {
  uninstallLibraryProjectsProvider();
  resetLibrarySourceRegistryForTests();
});

describe('plan-778 9.4 — unmigrated project, no libraries[]', () => {
  it('an unqualified catalog id resolves through the built-in realvirtual library', async () => {
    await boot();
    expect(await resolve({ assetId: CHAIN })).toBe('rv:chain');
  });

  it('a GitHub-scan id resolves through the alias', async () => {
    await boot();
    expect(await resolve({ assetId: CHAIN_SCAN })).toBe('rv:chain');
  });

  it('a pre-778 `global` + realvirtual catalog URL qualifier resolves (mapped to the library project)', async () => {
    await boot();
    for (const sourceId of [
      'library/catalog.json', '/library/catalog.json', 'https://web.realvirtual.io/demo/library/catalog.json',
      'https://github.com/game4automation/realvirtual-Library', 'https://github.com/game4automation/realvirtual-Library/',
      'https://github.com/game4automation/realvirtual-Library.git', 'https://github.com/game4automation/realvirtual-Library/tree/main',
    ]) {
      expect(isRealvirtualCatalogUrl(sourceId), sourceId).toBe(true);
      expect(await resolve({ assetId: CHAIN, providerId: 'global', sourceId }), sourceId).toBe('rv:chain');
    }
    expect(isRealvirtualCatalogUrl('https://interroll.example/catalog.json')).toBe(false);
  });

  it('a `global` qualifier naming a PARTNER host\'s …/library/catalog.json is not mapped to the realvirtual library', async () => {
    await boot();
    const partner = 'https://partner.example/library/catalog.json';
    expect(isRealvirtualCatalogUrl(partner)).toBe(false);
    expect(isRealvirtualCatalogUrl('http://localhost:5173/library/catalog.json')).toBe(true);
    expect(isRealvirtualCatalogUrl('http://[::1]:5173/library/catalog.json')).toBe(true);
    expect(isRealvirtualCatalogUrl(`${window.location.origin}/library/catalog.json`)).toBe(true);
    // The hint is not REQUIRED to match (pre-778 behaviour), so the id still resolves
    // through the ordinary legacy search — the partner URL just earns no preference.
    expect(await resolve({ assetId: CHAIN, providerId: 'global', sourceId: partner })).toBe('rv:chain');
  });
});

describe('plan-778 9.4 — canonical before alias, across sources', () => {
  it('an alias in B never beats a canonical id in C — even when B comes first', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', documents: [{ id: 'b-pump', path: 'pump.glb', aliases: ['models/pump'], marker: 'b:pump' }] });
    const c = fakeLibraryProject({ id: 'prj_c', documents: [{ id: 'models/pump', path: 'pump.glb', marker: 'c:pump' }] });
    await boot({ libraries: [{ projectId: 'prj_b' }, { projectId: 'prj_c' }], extra: { prj_b: b.backend, prj_c: c.backend } });
    expect(findLegacyOrigin('models/pump')?.source.id).toBe('prj_c');
    expect(await resolve({ assetId: 'models/pump' })).toBe('c:pump');
    // The alias still answers where nobody owns the id canonically.
    expect(findLegacyOrigin('b-pump')?.source.id).toBe('prj_b');
  });

  it('two libraries with the same canonical id: registry order (libraries[] order) decides for a LEGACY ref', async () => {
    const b = fakeLibraryProject({ id: 'prj_b', documents: [{ id: 'models/pump', path: 'pump.glb', marker: 'b:pump' }] });
    const c = fakeLibraryProject({ id: 'prj_c', documents: [{ id: 'models/pump', path: 'pump.glb', marker: 'c:pump' }] });
    await boot({ libraries: [{ projectId: 'prj_c' }, { projectId: 'prj_b' }], extra: { prj_b: b.backend, prj_c: c.backend } });
    expect(await resolve({ assetId: 'models/pump' })).toBe('c:pump');
  });
});
