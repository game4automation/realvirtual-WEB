// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * publish-manifest.node.test.ts — plan-700 Phase 6 + 8.
 *
 * What the publish path takes from the manifest, and what it deliberately does
 * NOT. The folder stays the source of truth for assets (P0-3): `models.json`
 * comes from `readdirSync` and must keep doing so. The manifest contributes the
 * Examples catalogue (`documents[]`, plan-413 phase 6) and the project's own
 * settings; publishing
 * also records per-target provenance instead of one shared `lastPublished`.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generatePrivateSettings,
  projectSettingsBase,
  readProjectSettingsFile,
  publishedSceneIndex,
  projectModelNames,
  stagePrivateProject,
  loadProject,
  SETTINGS_RESERVED_KEYS,
} from '../scripts/_bunny-lib.mjs';
import {
  PUBLISH_TARGETS,
  withPublishProvenance,
  recordPublishProvenance,
} from '../scripts/_rv-provenance.mjs';
import { validateProject } from '../scripts/validate-project.mjs';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A project folder with `models/`, `scenes/` and a manifest. */
function makeProject(root: string, manifest: Record<string, unknown>, opts: {
  models?: string[];
  scenes?: string[];
  settings?: unknown;
} = {}): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'project.json'), JSON.stringify(manifest, null, 2));
  if (opts.models) {
    mkdirSync(join(root, 'models'), { recursive: true });
    for (const m of opts.models) writeFileSync(join(root, 'models', m), 'glb-bytes');
  }
  if (opts.scenes) {
    mkdirSync(join(root, 'scenes'), { recursive: true });
    for (const s of opts.scenes) writeFileSync(join(root, 'scenes', s), '{"id":"x","base":{}}');
  }
  if (opts.settings !== undefined) {
    mkdirSync(join(root, 'settings'), { recursive: true });
    writeFileSync(join(root, 'settings', 'project-settings.json'), JSON.stringify(opts.settings));
  }
  return root;
}

/** A dist/ just complete enough for stagePrivateProject. */
function makeDist(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'app.js'), '//');
  return root;
}

describe('models.json stays folder-derived (P0-3)', () => {
  it('lists every GLB in models/, whatever the manifest says', () => {
    const dir = tempDir('rv-models-');
    try {
      makeProject(join(dir, 'p'), {
        name: 'P', code: 'c1', canonicalName: 'p',
        // A manifest claiming a different, shorter list must not win.
        models: [{ path: 'only-this-one.glb' }],
      }, { models: ['a.glb', 'b.glb', 'notes.txt'] });
      expect(projectModelNames(join(dir, 'p')).sort()).toEqual(['a.glb', 'b.glb']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is empty, not an error, for a project without models/', () => {
    const dir = tempDir('rv-models-');
    try {
      makeProject(join(dir, 'p'), { name: 'P', code: 'c1' });
      expect(projectModelNames(join(dir, 'p'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('is exactly what staging writes into models.json', async () => {
    const dir = tempDir('rv-stage-');
    try {
      const projectDir = makeProject(join(dir, 'p'), { name: 'P', code: 'code1', canonicalName: 'p' },
        { models: ['a.glb', 'b.glb'] });
      const distDir = makeDist(join(dir, 'dist'));
      const staged = await stagePrivateProject({ distDir, projectDir });
      expect(JSON.parse(readFileSync(join(staged, 'models.json'), 'utf8')))
        .toEqual(projectModelNames(projectDir));
      rmSync(staged, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// plan-413 phase 6: the catalogue is derived from `documents[]`, not from the
// `scenes[]` mirror, and the file has to be a `.glb` — a `.scene.json` entry
// would publish a catalogue row pointing at a format phase 3 stopped shipping.
describe('publishedSceneIndex', () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    id: 'published:A', name: 'A', path: 'scenes/A.glb',
    section: 'scenes', baseKind: 'published', ...over,
  });
  const manifest = (over: Record<string, unknown> = {}) => ({ documents: [doc(over)] });

  it('derives the curated [{file,name,mode}] catalogue from documents[]', () => {
    expect(publishedSceneIndex(manifest({ mode: 'planner' })))
      .toEqual([{ file: 'A.glb', name: 'A', mode: 'planner' }]);
  });

  it('omits mode when the entry has none', () => {
    expect(publishedSceneIndex(manifest())).toEqual([{ file: 'A.glb', name: 'A' }]);
  });

  it('carries the classification level so a bundled deploy needs no scan', () => {
    // A bundled source is never scanned (§2.5), and reading the level out of
    // the GLBs would mean downloading every example just to draw a list.
    expect(publishedSceneIndex(manifest({ classification: { v: 1, level: 'scene' } })))
      .toEqual([{ file: 'A.glb', name: 'A', level: 'scene' }]);
  });

  it('sections a documents[] entry by its path when it carries no section', () => {
    expect(publishedSceneIndex({ documents: [{ ...doc(), section: undefined }] }))
      .toEqual([{ file: 'A.glb', name: 'A' }]);
  });

  it('refuses a legacy .scene.json entry rather than publishing an unreadable row', () => {
    expect(publishedSceneIndex(manifest({ path: 'scenes/A.scene.json' }))).toBeNull();
  });

  it('ignores scenes the customer owns — only published entries are Examples', () => {
    expect(publishedSceneIndex(manifest({ baseKind: 'user' }))).toBeNull();
  });

  it('ignores paths that leave scenes/ or are nested', () => {
    expect(publishedSceneIndex(manifest({ path: '../other/A.glb' }))).toBeNull();
    expect(publishedSceneIndex(manifest({ path: 'scenes/sub/A.glb' }))).toBeNull();
    expect(publishedSceneIndex(manifest({ path: 'scenes/A.json' }))).toBeNull();
  });

  it('ignores a document that is not a scene', () => {
    expect(publishedSceneIndex({ documents: [doc({ section: 'library', path: 'library/A.glb' })] }))
      .toBeNull();
  });

  it('has no scenes[] fallback of its own any more (plan-703 phase 9)', () => {
    // It used to keep three lines for the customer nobody had opened in a
    // current client. That case did not go away — it moved one level up, to
    // `loadProject()`, so it is answered once for every consumer instead of
    // once per consumer. This function now reads `documents[]` and nothing else.
    expect(publishedSceneIndex({ scenes: [{ ...doc(), section: undefined }] })).toBeNull();
  });

  it('still publishes an unmigrated customer\'s Examples, via loadProject()', () => {
    // The guarantee the deleted fallback existed for, pinned where it now
    // lives. The .glb rule still applies on the way through — a .scene.json row
    // would point at a format the viewer stopped opening in phase 3.
    const dir = tempDir('rv-unmigrated-');
    try {
      const projectDir = makeProject(join(dir, 'p'), {
        name: 'P', code: 'code1', canonicalName: 'p', schemaVersion: 1,
        scenes: [{ ...doc(), section: undefined }],
      }, { scenes: ['A.glb'] });
      const loaded = loadProject(projectDir);
      // Derived in memory only — the file on disk is untouched.
      expect(JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')).documents)
        .toBeUndefined();
      expect(publishedSceneIndex(loaded)).toEqual([{ file: 'A.glb', name: 'A' }]);

      const jsonDir = makeProject(join(dir, 'q'), {
        name: 'Q', code: 'code2', canonicalName: 'q', schemaVersion: 1,
        scenes: [{ ...doc(), path: 'scenes/A.scene.json' }],
      }, { scenes: ['A.scene.json'] });
      expect(publishedSceneIndex(loadProject(jsonDir))).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('prefers documents[] over the legacy array it was derived from', () => {
    expect(publishedSceneIndex({
      documents: [doc({ name: 'From documents' })],
      scenes: [{ ...doc(), name: 'From the mirror' }],
    })).toEqual([{ file: 'A.glb', name: 'From documents' }]);
  });

  it('returns null for a manifest that declares none, so the folder index stands', () => {
    expect(publishedSceneIndex({})).toBeNull();
    expect(publishedSceneIndex({ documents: [] })).toBeNull();
    expect(publishedSceneIndex(null)).toBeNull();
  });

  it('staging writes it, and leaves a folder index alone when the manifest is silent', async () => {
    const dir = tempDir('rv-scenes-');
    try {
      const withScenes = makeProject(join(dir, 'p1'), {
        name: 'P', code: 'code1', canonicalName: 'p1',
        documents: [doc({ name: 'Planner Demo', mode: 'planner' })],
      }, { models: [], scenes: ['A.glb'] });
      const distDir = makeDist(join(dir, 'dist'));
      const staged = await stagePrivateProject({ distDir, projectDir: withScenes });
      expect(JSON.parse(readFileSync(join(staged, 'scenes', 'index.json'), 'utf8')))
        .toEqual([{ file: 'A.glb', name: 'Planner Demo', mode: 'planner' }]);
      rmSync(staged, { recursive: true, force: true });

      const silent = makeProject(join(dir, 'p2'), { name: 'P2', code: 'code2', canonicalName: 'p2' },
        { models: [], scenes: ['A.glb'] });
      writeFileSync(join(silent, 'scenes', 'index.json'), '[{"file":"A.glb","name":"Hand written"}]');
      const staged2 = await stagePrivateProject({ distDir, projectDir: silent });
      expect(JSON.parse(readFileSync(join(staged2, 'scenes', 'index.json'), 'utf8')))
        .toEqual([{ file: 'A.glb', name: 'Hand written' }]);
      rmSync(staged2, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('generatePrivateSettings merges settings/project-settings.json (B14)', () => {
  it('carries the project keys through', () => {
    const s = JSON.parse(generatePrivateSettings({ name: 'P' }, 'folder', {
      projectSettings: { theme: 'dark', units: { length: 'mm' } },
    }));
    expect(s.theme).toBe('dark');
    expect(s.units).toEqual({ length: 'mm' });
  });

  it('never lets a project file re-enable analytics or move the assets path', () => {
    const s = JSON.parse(generatePrivateSettings({ name: 'P' }, 'folder', {
      projectSettings: {
        analytics: { googleAnalyticsId: 'UA-EVIL' },
        projectAssetsPath: 'https://elsewhere.example/',
        encryption: { enabled: true },
        generated: '1999-01-01T00:00:00Z',
      },
    }));
    expect(s.analytics).toEqual({ googleAnalyticsId: '' });
    expect(s.projectAssetsPath).toBe('private-assets/folder/');
    expect(s.encryption).toBeUndefined();
    expect(s.generated).not.toBe('1999-01-01T00:00:00Z');
  });

  it('lets the manifest defaultModel win over the project file', () => {
    const s = JSON.parse(generatePrivateSettings({ settings: { defaultModel: 'A.glb' } }, 'f', {
      projectSettings: { defaultModel: 'models/B.glb' },
    }));
    expect(s.defaultModel).toBe('models/A.glb');
  });

  it('is byte-identical to the pre-plan-700 output when there is no project file', () => {
    const project = { name: 'P', settings: { defaultModel: 'A.glb' } };
    const withNone = JSON.parse(generatePrivateSettings(project, 'f'));
    const withNull = JSON.parse(generatePrivateSettings(project, 'f', { projectSettings: null }));
    expect(withNull).toEqual(withNone);
    expect(Object.keys(withNone)).toEqual(['defaultModel', 'projectAssetsPath', 'analytics', 'generated']);
  });

  it('survives a malformed project-settings file rather than failing a deploy', () => {
    expect(projectSettingsBase(null)).toEqual({});
    expect(projectSettingsBase(['a'])).toEqual({});
    expect(projectSettingsBase('nope')).toEqual({});
    for (const key of SETTINGS_RESERVED_KEYS) {
      expect(projectSettingsBase({ [key]: 'x' })).toEqual({});
    }
    const dir = tempDir('rv-settings-');
    try {
      const p = makeProject(join(dir, 'p'), { name: 'P', code: 'c' });
      expect(readProjectSettingsFile(p)).toBeNull();
      mkdirSync(join(p, 'settings'), { recursive: true });
      writeFileSync(join(p, 'settings', 'project-settings.json'), '{ broken');
      expect(readProjectSettingsFile(p)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reaches the staged settings.json', async () => {
    const dir = tempDir('rv-settings-');
    try {
      const projectDir = makeProject(join(dir, 'p'), { name: 'P', code: 'c', canonicalName: 'p' },
        { models: [], settings: { theme: 'dark' } });
      const staged = await stagePrivateProject({ distDir: makeDist(join(dir, 'dist')), projectDir });
      const s = JSON.parse(readFileSync(join(staged, 'settings.json'), 'utf8'));
      expect(s.theme).toBe('dark');
      expect(s.analytics).toEqual({ googleAnalyticsId: '' });
      rmSync(staged, { recursive: true, force: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('publish provenance per target (§2.8 / B15)', () => {
  it('records one target without erasing another', () => {
    let m: Record<string, unknown> = { name: 'P' };
    m = withPublishProvenance(m, 'bunny-private', { version: '6.3.0', code: 'abc' },
      new Date('2026-08-01T10:00:00Z'));
    m = withPublishProvenance(m, 'connect-embed', { version: '6.3.0', connectBuild: '1.0.1+34' },
      new Date('2026-08-02T10:00:00Z'));
    const by = (m as any).provenance.lastPublishedBy;
    expect(by['bunny-private']).toEqual({ at: '2026-08-01T10:00:00Z', version: '6.3.0', code: 'abc' });
    expect(by['connect-embed']).toEqual({ at: '2026-08-02T10:00:00Z', version: '6.3.0', connectBuild: '1.0.1+34' });
    // The legacy single field mirrors the most recent publish.
    expect(m.lastPublished).toBe('2026-08-02T10:00:00Z');
  });

  it('keeps every unknown field and any other provenance key', () => {
    const m = withPublishProvenance(
      { name: 'P', somethingElse: 42, provenance: { importedFrom: 'unity' } },
      'delivery', { version: '6.3.0' },
    );
    expect(m.somethingElse).toBe(42);
    expect((m as any).provenance.importedFrom).toBe('unity');
  });

  it('drops empty info rather than writing nulls', () => {
    const m = withPublishProvenance({}, 'delivery', { version: '', coreCommit: undefined });
    expect(Object.keys((m as any).provenance.lastPublishedBy.delivery)).toEqual(['at']);
  });

  it('refuses a target outside the three §2.8 names', () => {
    expect(PUBLISH_TARGETS).toEqual(['bunny-private', 'connect-embed', 'delivery']);
    expect(() => withPublishProvenance({}, 'bunny' as never)).toThrow(/Unknown publish target/);
  });

  it('writes through to project.json, and is a no-op without one', () => {
    const dir = tempDir('rv-prov-');
    try {
      const p = makeProject(join(dir, 'p'), { name: 'P', code: 'c', canonicalName: 'p' });
      recordPublishProvenance(p, 'bunny-private', { version: '6.3.0' });
      const written = JSON.parse(readFileSync(join(p, 'project.json'), 'utf8'));
      expect(written.provenance.lastPublishedBy['bunny-private'].version).toBe('6.3.0');
      expect(written.name).toBe('P');
      expect(recordPublishProvenance(join(dir, 'gone'), 'delivery')).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('slug invariant: folder == canonicalName, case-insensitive (Phase 8)', () => {
  const manifest = (canonicalName?: string) => ({
    schemaVersion: 1, id: 'prj_1', name: 'P',
    ...(canonicalName === undefined ? {} : { canonicalName }),
  });

  it('accepts an exact match', () => {
    const dir = tempDir('rv-slug-');
    try {
      makeProject(join(dir, 'acme'), manifest('acme'));
      expect(validateProject(join(dir, 'acme')).errors).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts Toray/toray — the real case, warned about but never failed', () => {
    const dir = tempDir('rv-slug-');
    try {
      makeProject(join(dir, 'Toray'), manifest('toray'));
      const r = validateProject(join(dir, 'Toray'));
      expect(r.errors).toEqual([]);
      expect(r.warnings.some(w => /case only/.test(w))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails a genuinely different name', () => {
    const dir = tempDir('rv-slug-');
    try {
      makeProject(join(dir, 'acme'), manifest('toray-oee-showcase'));
      const r = validateProject(join(dir, 'acme'));
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => /canonicalName/.test(e))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('only warns for an unmigrated manifest that has no canonicalName at all', () => {
    const dir = tempDir('rv-slug-');
    try {
      makeProject(join(dir, 'acme'), manifest());
      const r = validateProject(join(dir, 'acme'));
      expect(r.ok).toBe(true);
      expect(r.warnings.some(w => /canonicalName/.test(w))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
