// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-asset-ops — rename / duplicate / delete / collections
 * (plan-372 Phase 9).
 *
 * Two rules carry the weight here. Delete is a MOVE into `library/.trash/`,
 * because a library asset can be the only copy of hours of authoring work. And
 * an unreadable sidecar is never overwritten — doing so would destroy the
 * collections of a user who opened the project in a newer build.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  LIBRARY_FOLDER,
  TRASH_FOLDER,
  deleteAsset,
  createEmptyAsset,
  duplicateAsset,
  renameAsset,
  setAssetCollections,
} from '../src/core/library/library-asset-ops';
import { SIDECAR_FILENAME, parseSidecar } from '../src/core/library/library-sidecar';
import type { ProjectBackend } from '../src/core/project/backends/project-backend';

/** In-memory backend double: only the blob surface the ops actually use. */
class FakeBackend {
  files = new Map<string, string>();

  async writeBlob(relPath: string, blob: Blob): Promise<void> {
    this.files.set(relPath, await blob.text());
  }
  async deleteBlob(relPath: string): Promise<void> {
    this.files.delete(relPath);
  }
  async readBlobUrl(relPath: string) {
    const body = this.files.get(relPath);
    if (body === undefined) return null;
    const url = URL.createObjectURL(new Blob([body]));
    return { url, release: () => URL.revokeObjectURL(url) };
  }

  // ── helpers ──
  lib(rel: string): string | undefined { return this.files.get(`${LIBRARY_FOLDER}/${rel}`); }
  putLib(rel: string, body: string): void { this.files.set(`${LIBRARY_FOLDER}/${rel}`, body); }
  sidecar() {
    const raw = this.files.get(`${LIBRARY_FOLDER}/${SIDECAR_FILENAME}`);
    return raw ? parseSidecar(raw) : null;
  }
}

const as = (b: FakeBackend) => b as unknown as ProjectBackend;

let backend: FakeBackend;
beforeEach(() => {
  backend = new FakeBackend();
  backend.putLib('conveyor/belt.glb', 'BELT');
});

describe('renameAsset', () => {
  it('moves the bytes and leaves nothing at the old path', async () => {
    expect((await renameAsset(as(backend), 'conveyor/belt.glb', 'belt2.glb')).kind).toBe('ok');
    expect(backend.lib('conveyor/belt2.glb')).toBe('BELT');
    expect(backend.lib('conveyor/belt.glb')).toBeUndefined();
  });

  it('carries the sidecar metadata across', async () => {
    await setAssetCollections(as(backend), 'conveyor/belt.glb', ['Conveyors']);
    await renameAsset(as(backend), 'conveyor/belt.glb', 'belt2.glb');
    const s = backend.sidecar();
    expect(s?.assets['conveyor/belt.glb']).toBeUndefined();
    expect(s?.assets['conveyor/belt2.glb'].collections).toEqual(['Conveyors']);
  });

  it('refuses to overwrite an existing name', async () => {
    backend.putLib('conveyor/other.glb', 'OTHER');
    const r = await renameAsset(as(backend), 'conveyor/belt.glb', 'other.glb');
    expect(r.kind).toBe('exists');
    expect(backend.lib('conveyor/other.glb')).toBe('OTHER');   // untouched
    expect(backend.lib('conveyor/belt.glb')).toBe('BELT');     // and not lost
  });

  it('renaming to the same name is a no-op, not a delete', async () => {
    expect((await renameAsset(as(backend), 'conveyor/belt.glb', 'belt.glb')).kind).toBe('ok');
    expect(backend.lib('conveyor/belt.glb')).toBe('BELT');
  });

  it('reports a missing source instead of creating an empty file', async () => {
    const r = await renameAsset(as(backend), 'conveyor/ghost.glb', 'x.glb');
    expect(r.kind).toBe('error');
    expect(backend.lib('conveyor/x.glb')).toBeUndefined();
  });
});

describe('duplicateAsset', () => {
  it('creates "<name> copy" beside the original', async () => {
    const r = await duplicateAsset(as(backend), 'conveyor/belt.glb');
    expect(r.kind).toBe('ok');
    expect(r.newPath).toBe('conveyor/belt copy.glb');
    expect(backend.lib('conveyor/belt copy.glb')).toBe('BELT');
    expect(backend.lib('conveyor/belt.glb')).toBe('BELT');
  });

  it('numbers further copies rather than failing', async () => {
    await duplicateAsset(as(backend), 'conveyor/belt.glb');
    const second = await duplicateAsset(as(backend), 'conveyor/belt.glb');
    expect(second.newPath).toBe('conveyor/belt copy 2.glb');
  });

  it('the copy inherits collections — that is what makes it a starting point', async () => {
    await setAssetCollections(as(backend), 'conveyor/belt.glb', ['Conveyors']);
    const r = await duplicateAsset(as(backend), 'conveyor/belt.glb');
    expect(backend.sidecar()?.assets[r.newPath!].collections).toEqual(['Conveyors']);
  });
});

describe('deleteAsset', () => {
  it('moves into .trash rather than destroying the bytes', async () => {
    expect((await deleteAsset(as(backend), 'conveyor/belt.glb')).kind).toBe('ok');
    expect(backend.lib('conveyor/belt.glb')).toBeUndefined();
    expect(backend.lib(`${TRASH_FOLDER}/belt.glb`)).toBe('BELT');
  });

  it('never overwrites something already in the trash', async () => {
    await deleteAsset(as(backend), 'conveyor/belt.glb');
    backend.putLib('other/belt.glb', 'SECOND');
    await deleteAsset(as(backend), 'other/belt.glb');
    expect(backend.lib(`${TRASH_FOLDER}/belt.glb`)).toBe('BELT');
    expect(backend.lib(`${TRASH_FOLDER}/belt 2.glb`)).toBe('SECOND');
  });

  it('drops the metadata so it cannot reattach to a future asset', async () => {
    await setAssetCollections(as(backend), 'conveyor/belt.glb', ['Conveyors']);
    await deleteAsset(as(backend), 'conveyor/belt.glb');
    expect(backend.sidecar()?.assets['conveyor/belt.glb']).toBeUndefined();
  });
});

describe('setAssetCollections', () => {
  it('trims, drops blanks and de-duplicates user-typed names', async () => {
    await setAssetCollections(as(backend), 'conveyor/belt.glb', [' Conveyors ', 'Conveyors', '', '  ']);
    expect(backend.sidecar()?.assets['conveyor/belt.glb'].collections).toEqual(['Conveyors']);
  });

  it('an empty list clears the record rather than persisting an empty one', async () => {
    await setAssetCollections(as(backend), 'conveyor/belt.glb', ['A']);
    await setAssetCollections(as(backend), 'conveyor/belt.glb', []);
    expect(backend.sidecar()?.assets['conveyor/belt.glb']).toBeUndefined();
  });
});

describe('an unreadable sidecar is never overwritten', () => {
  it('refuses the write and says why', async () => {
    // A sidecar from a newer build: parseable JSON, unknown schemaVersion.
    backend.putLib(SIDECAR_FILENAME, JSON.stringify({ schemaVersion: 99, assets: {} }));
    const r = await setAssetCollections(as(backend), 'conveyor/belt.glb', ['A']);
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && r.message).toMatch(/newer version/i);
    // Their file is exactly as it was.
    expect(JSON.parse(backend.lib(SIDECAR_FILENAME)!).schemaVersion).toBe(99);
  });
});

// A card the user can rename and open later only exists if the bytes do — the
// old "New asset" jumped into the editor and left the project with nothing.
describe('createEmptyAsset', () => {
  it('writes a real GLB so the row survives a reload', async () => {
    const result = await createEmptyAsset(as(backend));
    expect(result.kind).toBe('ok');
    expect(result.newPath).toBe('New asset.glb');
    const body = backend.lib('New asset.glb');
    expect(body).toBeDefined();
    // 'glTF' magic — a loader must accept it, not just a placeholder file.
    expect(body!.startsWith('glTF')).toBe(true);
  });

  it('probes the name so clicking twice makes two assets', async () => {
    await createEmptyAsset(as(backend));
    const second = await createEmptyAsset(as(backend));
    expect(second.newPath).toBe('New asset 2.glb');
    expect(backend.lib('New asset.glb')).toBeDefined();
    expect(backend.lib('New asset 2.glb')).toBeDefined();
  });
});
