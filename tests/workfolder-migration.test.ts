// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-709 §2.6 / §9.4 — the one-way door out of the old working folder.
 *
 * This is the only code path in the app whose failure mode is losing files a
 * human put somewhere by hand (`knowledge/` datasheets, photos, notes). Every
 * assertion here is about a way that could happen:
 *
 *  - the whole tree, not a file-type selection
 *  - resume after an abort, never restart
 *  - a target file that already exists is inspected, not assumed
 *  - the same name with DIFFERENT bytes is kept alongside, never overwritten
 *  - the source is never touched
 *  - `NotAllowedError` (a rehydrated handle that looks valid until read) leaves
 *    a retryable state, not a half-migrated project
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  migrateWorkfolderIntoProject,
  readMigrationManifest,
  clearMigrationManifest,
} from '../src/core/project/rv-workfolder-migration';
import { getProjectStore } from '../src/core/project/project-store';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

const PROJECT_ID = 'prj_migration_test';

// ─── Stub File System Access handles ──────────────────────────────────────

interface FileNode { [name: string]: string | FileNode }

function fileHandle(name: string, content: string, opts: { throwOnRead?: boolean } = {}) {
  return {
    kind: 'file' as const,
    name,
    getFile: async () => {
      if (opts.throwOnRead) throw new DOMException('denied', 'NotAllowedError');
      return {
        arrayBuffer: async () => new TextEncoder().encode(content).buffer as ArrayBuffer,
      };
    },
  };
}

/** A directory handle over a plain object tree, with an async `values()`. */
function dirHandle(name: string, tree: FileNode, denyRead = new Set<string>()) {
  return {
    kind: 'directory' as const,
    name,
    async *values() {
      for (const [key, value] of Object.entries(tree)) {
        yield typeof value === 'string'
          ? fileHandle(key, value, { throwOnRead: denyRead.has(key) })
          : dirHandle(key, value, denyRead);
      }
    },
  } as unknown as FileSystemDirectoryHandle;
}

// ─── Stub backend ─────────────────────────────────────────────────────────

function fakeBackend(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const backend = {
    kind: 'browser', id: 'test', writable: true, isActive: true,
    writeBlob: async (relPath: string, blob: Blob, opts?: { expectedRevision?: unknown }) => {
      // `expectedRevision: null` is create-only. The migration relies on this
      // refusal being real — without it a copy would replace live work.
      if (opts && 'expectedRevision' in opts && opts.expectedRevision === null && files.has(relPath)) {
        throw new Error(`conflict: ${relPath} exists`);
      }
      files.set(relPath, await blob.text());
    },
    readBlobBytes: async (relPath: string) => {
      const content = files.get(relPath);
      return content === undefined
        ? null
        : (new TextEncoder().encode(content).buffer as ArrayBuffer);
    },
  } as unknown as ProjectBackend;
  return { backend, files };
}

function install(backend: ProjectBackend | null): void {
  const store = getProjectStore() as unknown as {
    _backend: ProjectBackend | null;
    _project: { id: string } | null;
  };
  store._backend = backend;
  store._project = backend ? { id: PROJECT_ID } : null;
}

describe('workfolder migration', () => {
  beforeEach(async () => {
    await clearMigrationManifest(PROJECT_ID);
  });

  afterEach(async () => {
    install(null);
    await clearMigrationManifest(PROJECT_ID);
  });

  it('copies the WHOLE tree, not just the GLBs', async () => {
    const { backend, files } = fakeBackend();
    install(backend);
    const source = dirHandle('rv-work', {
      library: {
        'Belt.glb': 'BELT',
        '.thumbnails': { 'Belt.png': 'PNG' },
        Custom: { 'Rig.glb': 'RIG' },
      },
      knowledge: { Belt: { 'knowledge.md': '# notes', 'datasheet.pdf': 'PDF' } },
      captures: { 'overview.png': 'SHOT' },
      'notes.txt': 'loose file',
    });

    const report = await migrateWorkfolderIntoProject({ source });

    expect(report.total).toBe(7);
    expect(report.copied).toBe(7);
    expect(report.failures).toEqual([]);
    expect([...files.keys()].sort()).toEqual([
      'captures/overview.png',
      'knowledge/Belt/datasheet.pdf',
      'knowledge/Belt/knowledge.md',
      'library/.thumbnails/Belt.png',
      'library/Custom/Rig.glb',
      'library/Belt.glb',
      'notes.txt',
    ].sort());
    // Curated content survives byte for byte — the whole point of the exercise.
    expect(files.get('knowledge/Belt/datasheet.pdf')).toBe('PDF');
  });

  it('resumes after an abort instead of starting over', async () => {
    const source = dirHandle('rv-work', { a: 'A', b: 'B', c: 'C' });

    const first = fakeBackend();
    install(first.backend);
    let seen = 0;
    const partial = await migrateWorkfolderIntoProject({
      source,
      isCancelled: () => ++seen > 2,   // let two through, then stop
    });
    expect(partial.incomplete).toBe(true);
    expect(partial.copied).toBe(2);
    expect(await readMigrationManifest(PROJECT_ID)).toEqual(new Set(['a', 'b']));

    // Second run against the SAME project state: only the remainder is new.
    install(first.backend);
    const rest = await migrateWorkfolderIntoProject({ source });
    expect(rest.copied).toBe(1);
    expect(rest.skipped).toBe(2);
    expect([...first.files.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('records an untracked but IDENTICAL target instead of skipping blindly', async () => {
    // The crash-between-write-and-manifest case: the file is there, the
    // manifest does not know it. Verified by bytes, then recorded.
    const { backend, files } = fakeBackend({ 'library/Belt.glb': 'BELT' });
    install(backend);
    const source = dirHandle('rv-work', { library: { 'Belt.glb': 'BELT' } });

    const report = await migrateWorkfolderIntoProject({ source });

    expect(report.copied).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.conflicts).toEqual([]);
    expect(files.get('library/Belt.glb')).toBe('BELT');
    expect(await readMigrationManifest(PROJECT_ID)).toEqual(new Set(['library/Belt.glb']));
  });

  it('keeps BOTH when the target holds different bytes under the same name', async () => {
    const { backend, files } = fakeBackend({ 'library/Belt.glb': 'PROJECT-VERSION' });
    install(backend);
    const source = dirHandle('rv-work', { library: { 'Belt.glb': 'OLD-VERSION' } });

    const report = await migrateWorkfolderIntoProject({ source });

    // The project's own file is untouched…
    expect(files.get('library/Belt.glb')).toBe('PROJECT-VERSION');
    // …and the old one arrived under a name the report names.
    expect(report.conflicts).toEqual([
      { relPath: 'library/Belt.glb', savedAs: 'library/Belt-migrated.glb' },
    ]);
    expect(files.get('library/Belt-migrated.glb')).toBe('OLD-VERSION');
  });

  it('offers a retry when the source handle turns out to be unpermitted', async () => {
    const { backend, files } = fakeBackend();
    install(backend);
    // A rehydrated handle looks valid and throws on first READ — the exact
    // shape that must not leave a half-migrated project behind.
    const source = dirHandle('rv-work', { 'a.glb': 'A', 'b.glb': 'B' }, new Set(['a.glb']));

    const report = await migrateWorkfolderIntoProject({ source });

    expect(report.permissionDenied).toBe(true);
    expect(report.incomplete).toBe(true);
    expect(files.size).toBe(0);
  });

  it('refuses without a writable project rather than dropping the files', async () => {
    install(null);
    await expect(migrateWorkfolderIntoProject({ source: dirHandle('rv-work', { a: 'A' }) }))
      .rejects.toThrow(/writable project/);
  });

  it('reports the source folder by name and never writes to it', async () => {
    const { backend } = fakeBackend();
    install(backend);
    const source = dirHandle('my-old-folder', { 'a.glb': 'A' });
    // The stub has no write surface at all: a migration that tried to modify
    // or delete anything in the source could not even compile against it.
    expect('removeEntry' in (source as object)).toBe(false);

    const report = await migrateWorkfolderIntoProject({ source });
    expect(report.sourceName).toBe('my-old-folder');
  });
});
