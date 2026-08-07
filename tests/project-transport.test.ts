// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-transport — `.rvproject` export / import (plan-372 Phase 16).
 *
 * This is the only feature that can hand someone a file that looks like their
 * project but is not, so the tests concentrate on the three conservative rules:
 * secrets and caches never travel, a copy gets a fresh id, and an import never
 * overwrites an existing project.
 */

import { describe, it, expect } from 'vitest';
import {
  RVPROJECT_EXTENSION,
  exportProject,
  importProject,
  isExcludedFromExport,
  isUnsafeEntryPath,
} from '../src/core/project/rv-project-transport';

// ─── In-memory File System Access doubles ────────────────────────────────

class FakeFile {
  readonly kind = 'file' as const;
  constructor(public name: string, private data: ArrayBuffer = new ArrayBuffer(0)) {}
  async getFile(): Promise<Blob> { return new Blob([this.data]); }
  async createWritable() {
    const self = this;
    return {
      async write(d: ArrayBuffer | string) {
        self.data = typeof d === 'string'
          ? (new TextEncoder().encode(d).buffer as ArrayBuffer)
          : d;
      },
      async close() { /* no-op */ },
    };
  }
  text(): string { return new TextDecoder().decode(this.data); }
}

class FakeDir {
  readonly kind = 'directory' as const;
  children = new Map<string, FakeDir | FakeFile>();
  constructor(public name: string) {}
  async *entries(): AsyncIterable<[string, FakeDir | FakeFile]> {
    for (const [k, v] of this.children) yield [k, v];
  }
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let c = this.children.get(name);
    if (!c) {
      if (!opts?.create) throw new Error('NotFoundError');
      c = new FakeDir(name);
      this.children.set(name, c);
    }
    return c as FakeDir;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFile> {
    let c = this.children.get(name);
    if (!c) {
      if (!opts?.create) throw new Error('NotFoundError');
      c = new FakeFile(name);
      this.children.set(name, c);
    }
    return c as FakeFile;
  }
  put(path: string, contents: string): void {
    const segs = path.split('/');
    const file = segs.pop()!;
    let dir: FakeDir = this;
    for (const s of segs) {
      let next = dir.children.get(s);
      if (!next) { next = new FakeDir(s); dir.children.set(s, next); }
      dir = next as FakeDir;
    }
    dir.children.set(file, new FakeFile(file, new TextEncoder().encode(contents).buffer as ArrayBuffer));
  }
}

function projectDir(): FakeDir {
  const d = new FakeDir('Demo');
  d.put('project.json', JSON.stringify({ id: 'orig-id', name: 'Demo', schemaVersion: 1 }));
  d.put('scenes/line.rvscene', '{"schemaVersion":2}');
  d.put('library/Custom/belt.glb', 'GLB');
  return d;
}

const as = <T>(v: unknown) => v as T;

// ─── Exclusion rules ─────────────────────────────────────────────────────

describe('isExcludedFromExport', () => {
  it('keeps ordinary project content', () => {
    for (const p of ['project.json', 'scenes/line.rvscene', 'library/Custom/belt.glb', 'docs/manual.pdf']) {
      expect(isExcludedFromExport(p)).toBe(false);
    }
  });

  it('drops caches and version-control noise', () => {
    for (const p of ['.cad-cache/abc.glb', '.trash/old.glb', '.git/config', 'node_modules/x/index.js']) {
      expect(isExcludedFromExport(p)).toBe(true);
    }
  });

  it('drops secrets, including the dotted .env variants people forget', () => {
    for (const p of ['.env', '.env.production', '.env.local', '.mcp_auth_token', 'credentials.json', 'keys/server.pem']) {
      expect(isExcludedFromExport(p)).toBe(true);
    }
  });

  it('normalises Windows separators before matching', () => {
    expect(isExcludedFromExport('.cad-cache\\abc.glb')).toBe(true);
  });
});

// ─── Export ──────────────────────────────────────────────────────────────

describe('exportProject', () => {
  it('produces a named .rvproject blob and reports what it skipped', async () => {
    const dir = projectDir();
    dir.put('.env', 'SECRET=1');
    dir.put('.cad-cache/x.glb', 'CACHE');

    const result = await exportProject(as<FileSystemDirectoryHandle>(dir), 'Demo Line');
    expect(result.kind).toBe('exported');
    if (result.kind !== 'exported') return;
    expect(result.fileName).toBe(`Demo Line${RVPROJECT_EXTENSION}`);
    expect(result.entryCount).toBe(3);              // manifest + scene + glb
    expect(result.skipped).toContain('.env');
    expect(result.skipped).toContain('.cad-cache');
  });

  it('refuses a folder with no manifest instead of shipping a fake project', async () => {
    const dir = new FakeDir('NotAProject');
    dir.put('readme.txt', 'hi');
    const result = await exportProject(as<FileSystemDirectoryHandle>(dir), 'X');
    expect(result.kind).toBe('error');
  });

  it('sanitises the file name', async () => {
    const result = await exportProject(as<FileSystemDirectoryHandle>(projectDir()), 'a/b:c');
    expect(result.kind === 'exported' && result.fileName).toBe(`a_b_c${RVPROJECT_EXTENSION}`);
  });
});

// ─── Round trip ──────────────────────────────────────────────────────────

describe('isUnsafeEntryPath', () => {
  it('accepts ordinary relative entry paths', () => {
    for (const p of ['project.json', 'scenes/line.rvscene', './a/b.glb']) {
      expect(isUnsafeEntryPath(p)).toBe(false);
    }
  });

  it('rejects anything that could write outside the chosen folder', () => {
    for (const p of ['../escape.txt', 'a/../../b', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b']) {
      expect(isUnsafeEntryPath(p)).toBe(true);
    }
  });
});

describe('importProject', () => {
  async function exported(): Promise<Blob> {
    const r = await exportProject(as<FileSystemDirectoryHandle>(projectDir()), 'Demo');
    if (r.kind !== 'exported') throw new Error('export failed');
    return r.blob;
  }

  it('round-trips content into an empty folder', async () => {
    const target = new FakeDir('Copy');
    const result = await importProject(await exported(), as<FileSystemDirectoryHandle>(target));
    expect(result.kind).toBe('imported');

    const scenes = await target.getDirectoryHandle('scenes');
    expect((await scenes.getFileHandle('line.rvscene')).text()).toBe('{"schemaVersion":2}');
  });

  it('gives the copy a FRESH id but keeps the name', async () => {
    const target = new FakeDir('Copy');
    const result = await importProject(await exported(), as<FileSystemDirectoryHandle>(target));
    if (result.kind !== 'imported') throw new Error(result.kind);
    // A shared id would make two projects fight over rv-project/last, the
    // scene-ownership markers and the thumbnail cache keys.
    expect(result.project.id).not.toBe('orig-id');
    expect(result.project.name).toBe('Demo');

    const written = JSON.parse((await target.getFileHandle('project.json')).text());
    expect(written.id).toBe(result.project.id);
  });

  it('refuses to unpack over an existing project, and writes nothing', async () => {
    const target = new FakeDir('Occupied');
    target.put('project.json', JSON.stringify({ id: 'theirs', name: 'Theirs' }));
    const result = await importProject(await exported(), as<FileSystemDirectoryHandle>(target));
    expect(result.kind).toBe('project-exists');
    // Their manifest is untouched.
    expect(JSON.parse((await target.getFileHandle('project.json')).text()).id).toBe('theirs');
    expect(target.children.has('scenes')).toBe(false);
  });

  it('rejects an archive without a manifest', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('random.txt', 'nope');
    const blob = await zip.generateAsync({ type: 'blob' });
    const result = await importProject(blob, as<FileSystemDirectoryHandle>(new FakeDir('T')));
    expect(result.kind).toBe('invalid');
  });

  it('rejects a manifest that is not valid JSON', async () => {
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('project.json', '{not json');
    const blob = await zip.generateAsync({ type: 'blob' });
    const result = await importProject(blob, as<FileSystemDirectoryHandle>(new FakeDir('T')));
    expect(result.kind).toBe('invalid');
  });

  it('normalises a JSZip-authored ../ path into the folder rather than escaping', async () => {
    // JSZip strips "../" when IT authors the archive, so this round trip can
    // never reach the guard — the entry simply lands inside the target. The
    // guard itself is covered directly below, because a hand-crafted archive
    // CAN carry such a path.
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('project.json', JSON.stringify({ id: 'x', name: 'X' }));
    zip.file('../escape.txt', 'pwned');
    const blob = await zip.generateAsync({ type: 'blob' });
    const target = new FakeDir('T');
    const result = await importProject(blob, as<FileSystemDirectoryHandle>(target));
    expect(result.kind).toBe('imported');
    expect(target.children.has('escape.txt')).toBe(true);
  });

  it('writes the git templates into the unpacked copy', async () => {
    const target = new FakeDir('Copy');
    await importProject(await exported(), as<FileSystemDirectoryHandle>(target));
    expect((await target.getFileHandle('.gitattributes')).text()).toContain('filter=lfs');
    expect((await target.getFileHandle('.rvprojectignore')).text()).toContain('.cad-cache/');
  });
});
