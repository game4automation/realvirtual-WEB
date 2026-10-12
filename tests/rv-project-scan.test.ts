// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * §9.4 — the recursive GLB scan and its job store (plan-743 F3).
 *
 * The properties worth a test are the ones a reviewer would otherwise have to
 * take on trust: that the recursion really is uncapped, that a nested project
 * is reported rather than absorbed, that Cancel leaves the folder byte-for-byte
 * as it was found, and that the yield strategy is fast enough to survive a real
 * CAD tree.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import { scanGlbTree, seedProjectFromScan } from '../src/core/project/rv-project-scan';
import {
  _resetAddJobForTests,
  getAddJobSnapshot,
  startAddScan,
  subscribeAddJob,
} from '../src/core/project/rv-project-add-job';

/** Resolve once the running job has gone back to idle. */
function settle(): Promise<void> {
  return new Promise<void>(resolve => {
    if (getAddJobSnapshot().status === 'idle') { resolve(); return; }
    const stop = subscribeAddJob(() => {
      if (getAddJobSnapshot().status === 'idle') { stop(); resolve(); }
    });
  });
}

const MANIFEST = 'project.json';

const noSignal = () => new AbortController().signal;
const opts = (signal = noSignal()) => ({ signal, onProgress: () => {} });

/** A 4-level tree with GLBs at every depth, plus decoys. */
function deepTree(): FakeDir {
  const root = new FakeDir('LineB');
  root.seedText('Top.glb', 'glb');
  root.seedText('readme.txt', 'not a model');
  const l1 = root.seedDir('Assemblies');
  l1.seedText('Frame.GLB', 'glb');          // uppercase extension
  const l2 = l1.seedDir('Sub');
  l2.seedText('Roll.glb', 'glb');
  const l3 = l2.seedDir('Deep');
  l3.seedText('Bearing.glb', 'glb');
  return root;
}

// ─── scanGlbTree ────────────────────────────────────────────────────────

describe('scanGlbTree', () => {
  it('finds GLBs four levels down, including .GLB, with root-relative paths', async () => {
    const result = await scanGlbTree(asDirHandle(deepTree()), opts());

    expect(result.documents.map(d => d.relPath).sort()).toEqual([
      'Assemblies/Frame.GLB',
      'Assemblies/Sub/Deep/Bearing.glb',
      'Assemblies/Sub/Roll.glb',
      'Top.glb',
    ]);
    // The name is the file name without the extension — what the manifest row
    // shows, not the path.
    expect(result.documents.find(d => d.relPath === 'Top.glb')!.name).toBe('Top');
  });

  it('does not enter a subfolder with its own project.json and reports it instead', async () => {
    const root = new FakeDir('Parent');
    root.seedText('Own.glb', 'glb');
    const nested = root.seedDir('ChildProject');
    nested.seedText(MANIFEST, '{"schemaVersion":2,"id":"prj_c","name":"C","documents":[]}');
    nested.seedText('Hidden.glb', 'glb');
    nested.seedDir('More').seedText('AlsoHidden.glb', 'glb');

    const result = await scanGlbTree(asDirHandle(root), opts());

    // The nested project's models belong to the nested project. Absorbing them
    // would give one GLB two owners.
    expect(result.documents.map(d => d.relPath)).toEqual(['Own.glb']);
    expect(result.nestedProjectDirs.map(n => n.relPath)).toEqual(['ChildProject']);
  });

  it('answers an empty folder with an empty document list, not an error', async () => {
    const result = await scanGlbTree(asDirHandle(new FakeDir('Empty')), opts());
    expect(result).toEqual({ documents: [], nestedProjectDirs: [] });
  });

  it('reports progress monotonically', async () => {
    const seen: number[] = [];
    await scanGlbTree(asDirHandle(deepTree()), {
      signal: noSignal(),
      onProgress: (p) => { seen.push(p.visited); },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('throws AbortError on cancel and writes nothing', async () => {
    const root = deepTree();
    const controller = new AbortController();
    const writeSpy = vi.spyOn(root, 'getFileHandle');

    const promise = scanGlbTree(asDirHandle(root), {
      signal: controller.signal,
      onProgress: () => { controller.abort(); },
    });

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // Cancel is a promise about the user's disk, not just about the UI.
    expect(root.has(MANIFEST)).toBe(false);
    for (const call of writeSpy.mock.calls) {
      expect((call[1] as { create?: boolean } | undefined)?.create).not.toBe(true);
    }
  });

  it('walks a 10 000-entry tree inside the yield budget', async () => {
    // 100 folders × 100 files. The point is not the absolute number — CI
    // machines vary — but that the per-entry yield has not become a per-entry
    // macrotask, which would turn this into minutes.
    const root = new FakeDir('Huge');
    for (let f = 0; f < 100; f++) {
      const sub = root.seedDir(`f${f}`);
      for (let i = 0; i < 100; i++) sub.seedText(`m${i}.glb`, 'glb');
    }

    const started = performance.now();
    const result = await scanGlbTree(asDirHandle(root), opts());
    const elapsed = performance.now() - started;

    expect(result.documents).toHaveLength(10_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

// ─── seedProjectFromScan ────────────────────────────────────────────────

describe('seedProjectFromScan', () => {
  it('writes a manifest whose documents are the scanned relative paths', async () => {
    const root = deepTree();
    const result = await scanGlbTree(asDirHandle(root), opts());

    const project = await seedProjectFromScan(asDirHandle(root), 'Line B', result);

    expect(project.name).toBe('Line B');
    expect(root.has(MANIFEST)).toBe(true);
    const manifest = JSON.parse((await root.readText(MANIFEST))!);
    expect(manifest.documents.map((d: { path: string }) => d.path).sort())
      .toEqual(result.documents.map(d => d.relPath).sort());
    expect(manifest.documents.every((d: { id: string }) => d.id.startsWith('doc_'))).toBe(true);
  });

  it('makes an empty folder an empty project', async () => {
    const root = new FakeDir('Empty');
    const project = await seedProjectFromScan(
      asDirHandle(root), 'Empty', { documents: [], nestedProjectDirs: [] });
    expect(project.documents).toEqual([]);
    expect(root.has(MANIFEST)).toBe(true);
  });

  it('refuses when a manifest appeared while the scan was running', async () => {
    const root = new FakeDir('Raced');
    const result = await scanGlbTree(asDirHandle(root), opts());
    // Second tab, sync client, or the user's own second Add.
    root.seedText(MANIFEST, '{"schemaVersion":2,"id":"prj_x","name":"X","documents":[]}');

    await expect(seedProjectFromScan(asDirHandle(root), 'Raced', result))
      .rejects.toThrow(/scanned/i);
    // The existing project is intact.
    expect(JSON.parse((await root.readText(MANIFEST))!).id).toBe('prj_x');
  });
});

// ─── rv-project-add-job ─────────────────────────────────────────────────

describe('rv-project-add-job', () => {
  beforeEach(() => { _resetAddJobForTests(); });

  it('refuses a second scan while one is running and leaves the first alone', async () => {
    const root = new FakeDir('First');
    for (let i = 0; i < 400; i++) root.seedText(`m${i}.glb`, 'glb');

    expect(startAddScan(asDirHandle(root))).toBe(true);
    expect(getAddJobSnapshot().folderName).toBe('First');

    // The guard is the backstop behind a disabled button; the second folder
    // must not become the job the user is watching.
    expect(startAddScan(asDirHandle(new FakeDir('Second')))).toBe(false);
    expect(getAddJobSnapshot().folderName).toBe('First');

    await settle();
  });

  it('keeps snapshot identity stable between notifies', async () => {
    const a = getAddJobSnapshot();
    const b = getAddJobSnapshot();
    // useSyncExternalStore tears the tree down over a fresh identity per read.
    expect(a).toBe(b);
  });

  it('publishes a success outcome carrying the scan result', async () => {
    const root = new FakeDir('Done');
    root.seedText('One.glb', 'glb');

    const outcome = await new Promise<{ kind: string; result: unknown }>(resolve => {
      startAddScan(asDirHandle(root), resolve);
    });

    expect(outcome.kind).toBe('success');
    expect((outcome.result as { documents: unknown[] }).documents).toHaveLength(1);
  });
});

