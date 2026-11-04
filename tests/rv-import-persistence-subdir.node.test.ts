// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetImportedGlbUrlsForTests,
  persistImportedGlb,
} from '../src/core/import/rv-import-persistence';

const state = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  writable: true,
  releases: [] as ReturnType<typeof vi.fn>[],
  write: vi.fn(),
}));

vi.mock('../src/core/project/project-store', () => ({
  getProjectStore: () => ({
    getProject: () => ({ id: 'project' }),
    subscribe: () => () => {},
    getBackend: () => ({
      writable: state.writable,
      writeDocument: state.write,
      readDocumentUrl: async (path: string) => {
        const bytes = state.files.get(path);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
        const release = vi.fn(() => URL.revokeObjectURL(url));
        state.releases.push(release);
        return { url, release };
      },
    }),
  }),
}));

beforeEach(() => {
  state.files.clear();
  state.releases = [];
  state.writable = true;
  state.write.mockReset().mockImplementation(async (path: string, bytes: Uint8Array) => {
    state.files.set(path, bytes);
    return { revision: 'written' };
  });
});

afterEach(() => {
  _resetImportedGlbUrlsForTests();
});

describe('import persistence destination', () => {
  it.each([undefined, {}])('keeps library/imports as the default (%j)', async options => {
    const result = await persistImportedGlb('Part.glb', new ArrayBuffer(8), options);
    expect(result.persisted).toBe(true);
    expect(result.entry.localPath).toBe('imports/Part.glb');
    expect(result.entry.id).toBe('local-imports-part-glb');
    expect(result.entry.collections).toEqual(['imports']);
    expect(state.write).toHaveBeenCalledExactlyOnceWith(
      'library/imports/Part.glb', new Uint8Array(8), { expectedRevision: 'create' },
    );
  });

  it('writes once to the chosen folder and returns the stored bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = await persistImportedGlb('Part', bytes.buffer, { subdir: 'simready' });
    expect(result.persisted).toBe(true);
    expect(result.entry.localPath).toBe('simready/Part.glb');
    expect(result.entry.id).toBe('local-simready-part-glb');
    expect(result.entry.collections).toEqual(['simready']);
    expect(state.write).toHaveBeenCalledExactlyOnceWith(
      'library/simready/Part.glb', bytes, { expectedRevision: 'create' },
    );
    const loaded = await fetch(result.entry.glbUrl!);
    expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(bytes);
  });

  it('returns the final collision path without overwriting the existing file', async () => {
    const original = new Uint8Array([9]);
    state.files.set('library/simready/Part.glb', original);
    const result = await persistImportedGlb('Part', new ArrayBuffer(8), { subdir: 'simready' });
    expect(result.entry.localPath).toBe('simready/Part-2.glb');
    expect(result.entry.id).toBe('local-simready-part-2-glb');
    expect(result.entry.name).toBe('Part 2');
    expect(state.files.get('library/simready/Part.glb')).toBe(original);
    expect(state.write).toHaveBeenCalledTimes(1);
    expect(state.releases[0]).toHaveBeenCalledTimes(1);
    expect(state.releases[1]).not.toHaveBeenCalled();
    _resetImportedGlbUrlsForTests();
    expect(state.releases[1]).toHaveBeenCalledTimes(1);
  });

  it('supports a nested relative folder', async () => {
    const result = await persistImportedGlb('Part', new ArrayBuffer(8), { subdir: 'vendor/parts' });
    expect(result.entry.localPath).toBe('vendor/parts/Part.glb');
    expect(state.files.has('library/vendor/parts/Part.glb')).toBe(true);
  });

  it.each(['', '../outside', '/absolute', 'a/../b', '.', 'a//b', 'C:/temp', 'a\\b']) (
    'rejects invalid destination %j before writing', async subdir => {
      await expect(persistImportedGlb('Part', new ArrayBuffer(8), { subdir })).rejects.toThrow(/relative folder/);
      expect(state.write).not.toHaveBeenCalled();
    },
  );

  it.each(['read-only', 'write-error'])('retains the visible ephemeral fallback: %s', async reason => {
    if (reason === 'read-only') state.writable = false;
    else state.write.mockRejectedValueOnce(new Error('disk full'));
    const result = await persistImportedGlb('Part', new ArrayBuffer(8), { subdir: 'simready' });
    try {
      expect(result.persisted).toBe(false);
      expect(result.warning).toMatch(/will NOT survive a reload/);
      expect(result.entry.localPath).toBeUndefined();
      expect(result.entry.glbUrl).toMatch(/^blob:/);
    } finally {
      URL.revokeObjectURL(result.entry.glbUrl!);
    }
  });
});
