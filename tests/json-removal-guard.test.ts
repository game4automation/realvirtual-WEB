// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-413 §9.5 — the JSON scene world is gone, and what a leftover meets.
 *
 * Two halves, and they answer different questions.
 *
 * **The source guard** answers "is it really gone?" A removal that leaves one
 * import behind is not a removal; it is a second code path with no tests and no
 * owner. The scan is over the inlined source text (`import.meta.glob('?raw')`,
 * the `ui-blur-token` pattern) rather than over module graphs, because a symbol
 * that has stopped being *imported* can still be sitting there being called.
 *
 * **The F10 half** answers "and what does a project that stayed behind get?"
 * The requirement is specific and worth restating: a hard, spoken error naming
 * the release that can still convert — never a silent failure, never a partial
 * load. Three surfaces can meet a leftover (the manifest, a backend scene read,
 * the localStorage catalogue row) and all three have to say the same sentence,
 * or the user gets three explanations of one situation and can act on none.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDir, asDirHandle } from './helpers/fake-fs-handles';
import {
  LAST_CONVERTING_VERSION,
  LegacyFormatError,
  isLegacyScenePath,
  legacyFormatMessage,
} from '../src/core/project/rv-legacy-format';
import { readManifest } from '../src/core/project/rv-project-storage';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BrowserBackend } from '../src/core/project/backends/browser-backend';
import { readScene, clearAllScenes } from '../src/core/hmi/scene/rv-scene-storage';

// ─── The source guard ───────────────────────────────────────────────────

describe('no JSON scene code survives under src/ (plan-413 F9)', () => {
  const sources = import.meta.glob('../src/**/*.{ts,tsx}', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  /**
   * Symbols that must not appear anywhere in the shipped sources.
   *
   * Each one is a doorway back into the old world: a reader for op-log bodies,
   * a validator for them, the migrator that produced them, the draft readers,
   * or the manifest mirror that made `documents[]` optional.
   */
  const FORBIDDEN = [
    'legacySceneRecord',
    'legacySceneOf',
    'isValidSceneV2',
    'rv-scene-glb-migration',
    'readSceneDraft',
    'withDocumentsMirror',
    'reconcileDocuments',
    'deriveDocumentsBaseline',
    'legacyEntryOfDocument',
    'mirrorFromDocuments',
    'sceneFormatOfPath',
    'readSceneFile',
    'writeSceneFile',
    'sceneRelPathFor',
    'importSceneJSON',
    'exportSceneJSON',
  ];

  it('scans a plausible number of source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });

  for (const symbol of FORBIDDEN) {
    it(`no source mentions ${symbol}`, () => {
      const hits = Object.entries(sources)
        .filter(([, text]) => text.includes(symbol))
        .map(([path]) => path);
      expect(hits).toEqual([]);
    });
  }

  it('nothing declares a scene body format any more', () => {
    // `format: 'json'` was the manifest field that said "this path is an op
    // log". A single survivor would make one code path believe in a body type
    // the readers no longer have.
    const hits = Object.entries(sources)
      .filter(([, text]) => /format:\s*['"]json['"]/.test(text))
      .map(([path]) => path);
    expect(hits).toEqual([]);
  });

  it('the only module naming the last converting release is the error module', () => {
    // One sentence, one place (see the module header). A second mention would
    // be a second version number to forget when this is repeated.
    const hits = Object.entries(sources)
      .filter(([, text]) => text.includes(LAST_CONVERTING_VERSION))
      .map(([path]) => path.split('/').pop());
    expect(hits).toEqual(['rv-legacy-format.ts']);
  });
});

describe('the shipped examples carry no .scene.json (plan-413 phase 3)', () => {
  it('public/scenes holds GLBs and the catalogue only', () => {
    const files = Object.keys(
      import.meta.glob('../public/scenes/*', { query: '?url', eager: true }),
    ).map(p => p.split('/').pop()!);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter(f => f.endsWith('.json') && f !== 'index.json')).toEqual([]);
  });
});

// ─── F10 — one error, one sentence ──────────────────────────────────────

describe('the F10 error itself', () => {
  it('names the release that can still convert, and what to do with it', () => {
    const message = new LegacyFormatError('project-scene-json', 'scenes/a.scene.json').message;
    expect(message).toContain(LAST_CONVERTING_VERSION);
    expect(message).toContain('scenes/a.scene.json');
    expect(message).toMatch(/no longer supported/i);
    expect(message).toMatch(/convert/i);
  });

  it('is one message with one shape, not three phrasings', () => {
    // The kinds differ only in the noun. Anything more would be three
    // explanations of one situation.
    const project = legacyFormatMessage('project-scene-json', 'x');
    const scene = legacyFormatMessage('localstorage-scene-v2', 'x');
    expect(project.replace('This project', '')).toBe(scene.replace('This scene', ''));
  });

  it('classifies paths by extension, not by hope', () => {
    expect(isLegacyScenePath('scenes/a.scene.json')).toBe(true);
    expect(isLegacyScenePath('scenes/a.scene.glb')).toBe(false);
    expect(isLegacyScenePath('')).toBe(false);
  });
});

describe('a manifest that stayed behind', () => {
  let root: FakeDir;
  beforeEach(() => { root = new FakeDir('legacy-project'); });

  const manifest = (extra: Record<string, unknown>) => JSON.stringify({
    schemaVersion: 1, id: 'prj_old', name: 'Old', ...extra,
  });

  it('is refused at the manifest read, before anything is handed out', async () => {
    root.seedText('project.json', manifest({
      scenes: [{ id: 'scn_a', name: 'A', path: 'scenes/a.scene.json' }],
    }));
    await expect(readManifest(asDirHandle(root))).rejects.toThrow(LegacyFormatError);
  });

  it('is refused by the folder backend even when asked for the body directly', async () => {
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    await expect(backend.readDocument('scenes/a.scene.json')).rejects.toThrow(LegacyFormatError);
  });

  it('is refused by the browser backend on the same rule', async () => {
    const backend = new BrowserBackend('prj_b', { requestPersistence: false });
    await expect(backend.readDocument('scenes/a.scene.json')).rejects.toThrow(LegacyFormatError);
  });

  it('a GLB path is not refused — the gate is the format, not the read', async () => {
    const backend = new FolderBackend(asDirHandle(root), { writable: true });
    // Nothing is there, so the honest answer is "no such scene", not an error.
    await expect(backend.readDocument('scenes/a.scene.glb')).resolves.toBeNull();
  });
});

describe('a stored scene that stayed behind (§9.7, F10 half)', () => {
  beforeEach(() => { localStorage.clear(); clearAllScenes(); });

  it('an op-log catalogue row throws instead of reading as absent', () => {
    // Reading as absent would be the silent failure the requirement forbids:
    // the scene would drop out of the index on the next rewrite, with nothing
    // said and nothing to act on.
    localStorage.setItem('rv-scenes/scn_old', JSON.stringify({
      id: 'scn_old', name: 'Old', schemaVersion: 2,
      base: { kind: 'empty' },
      edits: { ops: [{ kind: 'setField' }], settings: {} },
    }));
    expect(() => readScene('scn_old')).toThrow(LegacyFormatError);
    expect(() => readScene('scn_old')).toThrow(new RegExp(LAST_CONVERTING_VERSION));
  });

  it('a current row reads normally', () => {
    localStorage.setItem('rv-scenes/scn_new', JSON.stringify({
      id: 'scn_new', name: 'New', schemaVersion: 3,
      base: { kind: 'empty' },
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    }));
    expect(readScene('scn_new')?.name).toBe('New');
  });

  it('an unreadable row is still soft — corruption is not a format decision', () => {
    localStorage.setItem('rv-scenes/scn_junk', 'not json at all');
    expect(readScene('scn_junk')).toBeNull();
  });
});
