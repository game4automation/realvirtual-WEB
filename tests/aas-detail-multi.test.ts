// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-596 — the SOL findings #3/#4/#5/#6/#7/#8 as tests:
 *
 *  - detail per AAS id in a multi-shell file, V3 contentType PDFs, JSON = XML;
 *  - provenance: the archive is opened from the source that listed the id;
 *  - revisions: missing → available after a write, removal → unknown-id, a
 *    late result of an old revision is dropped, AAS PDF links are replaced;
 *  - on-demand loading: model start opens no archive, max 2 opens at once,
 *    LRU release after the third open package, release on project switch;
 *  - the bundled contract (no scan, delivered index);
 *  - scan serialisation (one follow-up run, only the last run writes);
 *  - project transport carries aasx/ and its index;
 *  - deploy upload selection (encrypted, staging-relative) — in the node test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { makeAasx, aasxFile } from './helpers/aasx-fixtures';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import {
  MAX_CONCURRENT_OPENS,
  MAX_OPEN_PACKAGES,
  MergedAasSource,
  ProjectAasSource,
  acquireAasPackage,
  getAasPackageStats,
  lookupAas,
  projectAasSourceFor,
  publishScannedIndex,
  releaseAasPackages,
  resetAasSources,
  setAasDeployContext,
  trackAasPackageUrl,
  urlAasSourceFor,
  type AasProjectBackend,
  type AasSource,
} from '../src/core/aas/rv-aas-source';
import type { AasxPackage } from '../src/core/aas/rv-aasx-package';
import {
  requestAasxScan,
  resetAasxProjectIndex,
  setAasxScanDeps,
} from '../src/core/aas/rv-aasx-project-index';
import { readAasxSummary } from '../src/core/aas/rv-aasx-package';
import { extractAasEntryBlob, loadAasDetail, resetCache, resetIndex } from '../src/plugins/aas-link-parser';
import {
  AAS_RESOLUTION_KEY,
  beginAasLoadGeneration,
  getAasResolution,
  resetAasResolution,
  resolveAasSubtree,
} from '../src/plugins/aas-resolution';
import { AasLinkPlugin, replaceAasPdfLinks } from '../src/plugins/aas-link-plugin';
import { exportProject, importProject } from '../src/core/project/rv-project-transport';
import { resetProblemsForTests } from '../src/core/hmi/problems-store';

const SHELL_A = {
  id: 'urn:multi:a', idShort: 'ShellA', productName: 'Product A',
  technical: { Stroke: '100 mm' },
  docs: [{ title: 'Manual A', path: '/aasx/docs/a.pdf' }],
};
const SHELL_B = {
  id: 'urn:multi:b', idShort: 'ShellB', productName: 'Product B',
  technical: { Torque: '5 Nm' },
  docs: [{ title: 'Manual B', path: '/aasx/docs/b.pdf' }],
};

async function putFile(dir: FakeDir, name: string, file: Blob): Promise<void> {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(file);
  await w.close();
}

async function folder(files: Record<string, Blob>, opts: { writable?: boolean; withManifest?: boolean } = {}): Promise<{ root: FakeDir; aasx: FakeDir; backend: FolderBackend }> {
  const root = new FakeDir('P');
  if (opts.withManifest) root.seedText('project.json', JSON.stringify({ id: 'proj-1', name: 'P', schemaVersion: 2, documents: [] }));
  const aasx = root.seedDir('aasx');
  for (const [n, b] of Object.entries(files)) await putFile(aasx, n, b);
  const backend = new FolderBackend(asDirHandle(root), { writable: opts.writable ?? true, id: `folder:${Math.random()}` });
  await backend.activate();
  return { root, aasx, backend };
}

function linkNode(aasId: string): Object3D {
  const n = new Object3D();
  n.userData._rvAasLink = { aasId, description: '' };
  return n;
}

beforeEach(() => {
  resetAasSources();
  resetCache();
  resetIndex();
  resetAasResolution();
  resetAasxProjectIndex();
  resetProblemsForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── SOL #3 — detail per id ─────────────────────────────────────────────

describe('detail of one shell in a multi-shell file', () => {
  for (const format of ['xml', 'json'] as const) {
    it(`${format}: the detail for B shows B, not A; V3 contentType PDFs reach extraction`, async () => {
      const { backend } = await folder({ 'multi.aasx': aasxFile(await makeAasx([SHELL_A, SHELL_B], { format }), 'multi.aasx') });
      const src = projectAasSourceFor(backend, 'p');
      const scan = await requestAasxScan(backend, 'p', { isCurrent: () => true, source: src });
      expect(Object.keys(scan!.file.entries).sort()).toEqual([SHELL_A.id, SHELL_B.id]);

      const lookup = (await lookupAas(src, SHELL_B.id))!;
      const b = await loadAasDetail(lookup, SHELL_B.id);
      expect(b.aasId).toBe(SHELL_B.id);
      expect(b.technicalData).toEqual([{ label: 'Torque', value: '5 Nm' }]);
      expect(b.documents).toEqual([{ title: 'Manual B', mimeType: 'application/pdf', zipPath: 'aasx/docs/b.pdf' }]);

      const a = await loadAasDetail((await lookupAas(src, SHELL_A.id))!, SHELL_A.id);
      expect(a.technicalData).toEqual([{ label: 'Stroke', value: '100 mm' }]);
      expect(a.documents.map(d => d.title)).toEqual(['Manual A']);

      const { blob } = await extractAasEntryBlob(SHELL_B.id, b.documents[0].zipPath, src);
      expect(blob.type).toBe('application/pdf');
      expect(await blob.text()).toBe('%PDF-1.4 Manual B');
    });
  }
});

// ─── SOL #4 — provenance ────────────────────────────────────────────────

describe('provenance: the archive comes from the source that listed the id', () => {
  it('same file name in project and deploy, different ids: each id opens its own archive', async () => {
    const P = { id: 'urn:proj:only', idShort: 'ProjOnly', productName: 'From project' };
    const D = { id: 'urn:deploy:only', idShort: 'DeployOnly', productName: 'From deploy' };
    const { backend } = await folder({ 'same.aasx': aasxFile(await makeAasx([P]), 'same.aasx') });
    const project = projectAasSourceFor(backend, 'p');
    await requestAasxScan(backend, 'p', { isCurrent: () => true, source: project });
    const deployBytes = await makeAasx([D]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/dep/aasx/index.json')) return new Response(JSON.stringify({ [D.id]: { file: 'same.aasx', idShort: 'DeployOnly' } }));
      if (url.endsWith('/dep/aasx/same.aasx')) return new Response(deployBytes.slice(0));
      return new Response(null, { status: 404 });
    });
    const merged = new MergedAasSource([project, urlAasSourceFor('/dep/aasx/')]);

    const dp = await loadAasDetail((await lookupAas(merged, D.id))!, D.id);
    expect(dp.idShort).toBe('DeployOnly');
    const pp = await loadAasDetail((await lookupAas(merged, P.id))!, P.id);
    expect(pp.idShort).toBe('ProjOnly');
  });
});

// ─── SOL #6 — revisions ─────────────────────────────────────────────────

describe('revisions reach the resolution pass', () => {
  it('missing → available after the first index write; removing the entry → unknown-id', async () => {
    const { aasx, backend } = await folder({});
    const src = projectAasSourceFor(backend, 'p');
    const root = new Object3D();
    const node = linkNode(SHELL_A.id);
    root.add(node);

    await resolveAasSubtree(root, src, beginAasLoadGeneration());
    expect(getAasResolution(node)).toBe('index-missing');

    await putFile(aasx, 'a.aasx', aasxFile(await makeAasx([SHELL_A]), 'a.aasx'));
    await requestAasxScan(backend, 'p', { isCurrent: () => true, source: src });
    await resolveAasSubtree(root, src, beginAasLoadGeneration());
    expect(getAasResolution(node)).toBe('resolved');

    await aasx.removeEntry('a.aasx');
    await requestAasxScan(backend, 'p', { isCurrent: () => true, source: src });
    await resolveAasSubtree(root, src, beginAasLoadGeneration());
    expect(getAasResolution(node)).toBe('unknown-id');
  });

  it('drops a late result computed against an older revision', async () => {
    const { backend } = await folder({});
    const src = projectAasSourceFor(backend, 'p');
    const root = new Object3D();
    const node = linkNode(SHELL_A.id);
    root.add(node);
    const pending = resolveAasSubtree(root, src, beginAasLoadGeneration());
    // The index changes while the first pass reads it.
    publishScannedIndex(src, { version: 1, generator: 'realvirtual-web', entries: {}, files: {} });
    await pending;
    expect(node.userData[AAS_RESOLUTION_KEY]).toBe('pending');
  });

  it('replaces AAS-generated PDF links and keeps foreign ones', () => {
    const node = linkNode(SHELL_A.id);
    node.userData._rvPdfLinks = [{ title: 'Foreign', source: { type: 'url', url: '/docs/x.pdf' } }];
    replaceAasPdfLinks(node, SHELL_A.id, [{ title: 'Old', mimeType: 'application/pdf', zipPath: 'aasx/old.pdf' }], 'project:p');
    replaceAasPdfLinks(node, SHELL_A.id, [{ title: 'New', mimeType: 'application/pdf', zipPath: 'aasx/new.pdf' }], 'project:p');
    const titles = (node.userData._rvPdfLinks as Array<{ title: string }>).map(l => l.title);
    expect(titles).toEqual(['Foreign', 'New']);
    replaceAasPdfLinks(node, SHELL_A.id, [], null);
    expect((node.userData._rvPdfLinks as Array<{ title: string }>).map(l => l.title)).toEqual(['Foreign']);
  });
});

// ─── SOL #8 — on demand, bounded, LRU ───────────────────────────────────

/** A fake source whose opens are slow and counted. */
function countingSource(key = 'fake:1'): AasSource & { opened: string[]; closed: string[] } {
  const opened: string[] = [];
  const closed: string[] = [];
  return {
    key,
    revision: 0,
    opened,
    closed,
    readIndex: async () => ({ kind: 'available', index: {} }),
    invalidate() { /* not needed */ },
    async openPackage(file: string): Promise<AasxPackage> {
      opened.push(file);
      await new Promise(r => setTimeout(r, 20));
      return {
        specParts: [], warnings: [],
        readEnvironment: async () => ({ shells: [], submodels: [] }),
        hasEntry: () => false,
        readEntry: async () => null,
        close: async () => { closed.push(file); },
      };
    },
  };
}

describe('on-demand packages', () => {
  it('model start opens no archive — searchText comes from the index metadata', async () => {
    const fetches: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      fetches.push(url);
      if (url.endsWith('/start/aasx/index.json')) {
        return new Response(JSON.stringify({
          'urn:1': { file: 'one.aasx', idShort: 'One', productName: 'Big One', manufacturer: 'ACME' },
          'urn:2': { file: 'two.aasx', idShort: 'Two' },
          'urn:3': { file: 'three.aasx', idShort: 'Three' },
        }));
      }
      return new Response(null, { status: 404 });
    });
    const scene = new Object3D();
    const nodes = ['urn:1', 'urn:2', 'urn:3'].map(id => { const n = linkNode(id); scene.add(n); return n; });
    // plan-682: the deploy context is set by installAasResolution (main.ts) on
    // 'model-loaded'; the plugin's model work runs after that event.
    const handlers = new Map<string, Set<(p: unknown) => void>>();
    const viewer = {
      scene, projectAssetsPath: '/start/', getPlugin: () => undefined,
      on: (ev: string, fn: (p: unknown) => void) => {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev)!.add(fn);
        return () => handlers.get(ev)!.delete(fn);
      },
    };
    setAasDeployContext({ explicitBase: null, deployBase: '/start/' });
    const plugin = new AasLinkPlugin();
    plugin.init(viewer as never);
    const result = { root: scene, modelConfig: undefined };
    plugin.onModelLoaded(result as never, viewer as never);
    for (const fn of [...(handlers.get('model-loaded') ?? [])]) fn({ result });
    await vi.waitFor(() => expect((nodes[0].userData._rvAasLink as { searchText?: string }).searchText).toBe('Big One ACME One'));
    expect(fetches.some(u => u.endsWith('.aasx'))).toBe(false);
    expect(getAasPackageStats().open).toBe(0);
    plugin.dispose();
  });

  it(`at most ${MAX_CONCURRENT_OPENS} opens run at once`, async () => {
    const src = countingSource();
    await Promise.all(['a', 'b', 'c'].map(f => acquireAasPackage(src, f)));
    expect(getAasPackageStats().peakOpening).toBeLessThanOrEqual(MAX_CONCURRENT_OPENS);
    expect(src.opened.sort()).toEqual(['a', 'b', 'c']);
  });

  it(`opening package ${MAX_OPEN_PACKAGES + 1} releases the oldest (reader + object URLs); reopening works`, async () => {
    const src = countingSource();
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    await acquireAasPackage(src, 'p1');
    trackAasPackageUrl(src, 'p1', 'blob:p1-pdf');
    await acquireAasPackage(src, 'p2');
    await acquireAasPackage(src, 'p3');
    await acquireAasPackage(src, 'p4');
    await vi.waitFor(() => expect(src.closed).toEqual(['p1']));
    expect(revoke).toHaveBeenCalledWith('blob:p1-pdf');
    expect(getAasPackageStats().open).toBe(MAX_OPEN_PACKAGES);
    await acquireAasPackage(src, 'p1');
    expect(src.opened.filter(f => f === 'p1')).toHaveLength(2);
  });

  it('a project switch releases the packages of the previous project', async () => {
    const src = countingSource('project:old');
    await acquireAasPackage(src, 'x');
    releaseAasPackages('project:old');
    await vi.waitFor(() => expect(src.closed).toEqual(['x']));
    expect(getAasPackageStats().open).toBe(0);
  });
});

// ─── SOL #7 — bundled contract ──────────────────────────────────────────

describe('bundled contract', () => {
  it('no scan; listAllFiles without AASX; the delivered index resolves the ids', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).endsWith('/p/aasx/index.json')
        ? new Response(JSON.stringify({ version: 1, generator: 'realvirtual-web', entries: { 'urn:x': { file: 'x.aasx', idShort: 'X' } }, files: {} }))
        : new Response(null, { status: 404 }));
    const listAllFiles = vi.fn(async () => ['models/plant.glb', 'notes.knowledge.md']);
    const backend = {
      kind: 'bundled', id: 'bundled:p', writable: false, isActive: true,
      listAllFiles,
      writeDocument: vi.fn(),
      readDocumentUrl: async (ref: string) => ({ url: `https://cdn.example/p/${ref}`, release: () => {} }),
    };
    const out = await requestAasxScan(backend as never, 'hosted', { isCurrent: () => true });
    expect(out).toBeNull();
    expect(listAllFiles).not.toHaveBeenCalled();
    const src = new ProjectAasSource(backend as unknown as AasProjectBackend, 'hosted');
    expect((await lookupAas(src, 'urn:x'))?.entry.file).toBe('x.aasx');
  });
});

// ─── SOL #5 — scan serialisation ────────────────────────────────────────

describe('scan serialisation', () => {
  it('a request during a run causes exactly one follow-up; only the last run writes', async () => {
    const { aasx, backend } = await folder({ 'a.aasx': aasxFile(await makeAasx([SHELL_A]), 'a.aasx') });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let calls = 0;
    setAasxScanDeps({
      readSummary: async (blob) => {
        calls++;
        if (calls === 1) await gate;
        return readAasxSummary(blob);
      },
    });
    const writes = vi.spyOn(backend, 'writeDocument');

    const run1 = requestAasxScan(backend, 'p', { isCurrent: () => true });
    // Run 1 has listed the folder and is blocked inside its first parse.
    await vi.waitFor(() => expect(calls).toBe(1));
    // "Import": a new file lands while run 1 is blocked, and the import asks
    // for a rescan twice (folded into ONE follow-up).
    await putFile(aasx, 'b.aasx', aasxFile(await makeAasx([SHELL_B]), 'b.aasx'));
    const run2 = requestAasxScan(backend, 'p', { isCurrent: () => true });
    const run3 = requestAasxScan(backend, 'p', { isCurrent: () => true });
    expect(run2).toBe(run1);
    expect(run3).toBe(run1);
    release();
    const out = await run1;

    expect(Object.keys(out!.file.entries).sort()).toEqual([SHELL_A.id, SHELL_B.id]);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(out!.stale).toBe(false);
    expect(out!.wrote).toBe(true);
    // Run 1 listed the folder before the import (a only); the ONE follow-up
    // parses a and b again because run 1 published nothing — three parses,
    // i.e. exactly two runs, not three.
    expect(calls).toBe(3);
  });
});

// ─── Transport ──────────────────────────────────────────────────────────

describe('project transport', () => {
  it('.rvproject export carries aasx/*.aasx and aasx/index.json; the import resolves ids without a scan', async () => {
    const { root, backend } = await folder({ 'a.aasx': aasxFile(await makeAasx([SHELL_A]), 'a.aasx') }, { withManifest: true });
    await requestAasxScan(backend, 'p', { isCurrent: () => true });

    const exported = await exportProject(asDirHandle(root), 'P');
    expect(exported.kind).toBe('exported');
    if (exported.kind !== 'exported') return;
    const JSZip = (await import('jszip')).default;
    const names = Object.keys((await JSZip.loadAsync(exported.blob)).files);
    expect(names).toContain('aasx/a.aasx');
    expect(names).toContain('aasx/index.json');

    const target = new FakeDir('Copy');
    const imported = await importProject(exported.blob, asDirHandle(target));
    expect(imported.kind).toBe('imported');
    const copyBackend = new FolderBackend(asDirHandle(target), { writable: false, id: 'folder:copy' });
    const listSpy = vi.spyOn(copyBackend, 'listAllFiles');
    const src = projectAasSourceFor(copyBackend, 'copy');
    expect((await lookupAas(src, SHELL_A.id))?.entry.file).toBe('a.aasx');
    expect(listSpy).not.toHaveBeenCalled();
  });
});
