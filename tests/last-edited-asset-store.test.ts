// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * last-edited-asset-store (plan-410 F2) — the editor's memory of the asset it
 * opened last: persistence round-trip, schema versioning, and the two things it
 * must refuse to remember (an Untitled document, and anything corrupt).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveLastEditedAsset,
  loadLastEditedAsset,
  clearLastEditedAsset,
} from '@rv-private/plugins/asset-editor/last-edited-asset-store';
import { EDITOR_LAST_ASSET_KEY, ALL_RV_STORAGE_KEYS } from '../src/core/hmi/rv-storage-keys';
import { projectDocumentBase } from '../src/core/editor/active-asset-store';

beforeEach(() => {
  try { localStorage.removeItem(EDITOR_LAST_ASSET_KEY); } catch { /* ignore */ }
});

describe('last-edited-asset-store', () => {
  it('persists and restores a libraryGlb base', () => {
    saveLastEditedAsset(projectDocumentBase('library/Custom/a.glb', 'a'));
    expect(loadLastEditedAsset()).toMatchObject(projectDocumentBase('library/Custom/a.glb', 'a'));
  });

  it('persists and restores a providerAsset identity (never a URL)', () => {
    saveLastEditedAsset({
      kind: 'providerAsset',
      providerId: 'cloud',
      sourceId: 'team-lib',
      assetId: 'a-42',
      label: 'Gripper',
    });
    const restored = loadLastEditedAsset();
    expect(restored).toMatchObject({ kind: 'providerAsset', assetId: 'a-42', label: 'Gripper' });
    // The whole point of storing identity: no stale blob: URL can sneak in.
    expect(JSON.stringify(restored)).not.toContain('blob:');
  });

  it('never persists kind empty and survives corrupt JSON', () => {
    saveLastEditedAsset({ kind: 'empty' });
    expect(loadLastEditedAsset()).toBeNull();

    localStorage.setItem(EDITOR_LAST_ASSET_KEY, '{broken');
    expect(loadLastEditedAsset()).toBeNull();
  });

  it('an empty save does not overwrite a real memory', () => {
    saveLastEditedAsset(projectDocumentBase('library/Custom/a.glb', 'a'));
    saveLastEditedAsset({ kind: 'empty' });
    expect(loadLastEditedAsset()).toMatchObject({ path: 'library/Custom/a.glb' });
  });

  it('rejects a record from an unknown schema version', () => {
    localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({
      v: 99,
      base: projectDocumentBase('library/Custom/a.glb', 'a'),
      savedAt: Date.now(),
    }));
    expect(loadLastEditedAsset()).toBeNull();
  });

  it('rejects a structurally incomplete base', () => {
    localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({
      v: 1,
      base: { kind: 'libraryGlb', fileName: 'a.glb' },  // no relPath
      savedAt: Date.now(),
    }));
    expect(loadLastEditedAsset()).toBeNull();
  });

  it('READS a legacy record and hands back the document it names (plan-716 §2.6)', () => {
    // Read tolerance for one release generation. Without it, every user's
    // last-edited pointer is silently forgotten by the upgrade that collapses
    // the kinds — the one thing this store exists to remember.
    for (const legacy of [
      { kind: 'libraryGlb', fileName: 'a.glb', relPath: 'Custom/a.glb' },
      { kind: 'projectDocument', relPath: 'models/Cell.glb', name: 'Cell' },
    ]) {
      localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({
        v: 1, base: legacy, savedAt: Date.now(),
      }));
      const restored = loadLastEditedAsset();
      expect(restored?.kind, legacy.kind).toBe('document');
      expect((restored as { path: string }).path, legacy.kind).toBe(
        legacy.kind === 'libraryGlb' ? 'library/Custom/a.glb' : 'models/Cell.glb',
      );
    }
  });

  it('a legacy SCENE record is refused — it was never re-openable by path', () => {
    // The former `sceneDocument` was excluded from this store on purpose, and
    // the collapse must not smuggle it back in: it upgrades to a document with
    // an empty path, which `isRestorableBase` rejects.
    localStorage.setItem(EDITOR_LAST_ASSET_KEY, JSON.stringify({
      v: 1,
      base: { kind: 'sceneDocument', sceneId: 'doc_plant', sceneName: 'Plant' },
      savedAt: Date.now(),
    }));
    expect(loadLastEditedAsset()).toBeNull();
  });

  it('clear forgets the memory', () => {
    saveLastEditedAsset(projectDocumentBase('library/Custom/a.glb', 'a'));
    clearLastEditedAsset();
    expect(loadLastEditedAsset()).toBeNull();
  });

  it('the key is registered so "Reset all" clears it too', () => {
    expect(ALL_RV_STORAGE_KEYS as readonly string[]).toContain(EDITOR_LAST_ASSET_KEY);
  });
});
