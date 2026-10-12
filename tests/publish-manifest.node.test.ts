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
 * plan-720 develops P0-3 rather than reversing it: the list became a UNION.
 * "The manifest must not win" still holds in the only direction it was ever
 * about — a manifest can never HIDE a GLB that sits in `models/`. What it may
 * now do is ADD one the glob structurally cannot see, namely a root-level
 * document (`wmyb/P1002_SAIER.glb`), which published an empty `models.json` for
 * as long as the glob was the whole answer.
 *
 * Runner: `npm run test:node` (vitest.node.config.ts, environment: node).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  generateHostedSettings,
  projectSettingsBase,
  readProjectSettingsFile,
  stageHostedProject,
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
  rootGlbs?: string[];
  settings?: unknown;
  noManifest?: boolean;
} = {}): string {
  mkdirSync(root, { recursive: true });
  if (!opts.noManifest) writeFileSync(join(root, 'project.json'), JSON.stringify(manifest, null, 2));
  for (const g of opts.rootGlbs ?? []) writeFileSync(join(root, g), 'glb-bytes');
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

/** A dist/ just complete enough for stageHostedProject. */
function makeDist(root: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>x</title>');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'app.js'), '//');
  return root;
}

// plan-759 D1: a hosted deploy publishes the project folder verbatim under p/.
// `models.json`, the plan-720 union and the published scene index are gone with
// the staging that produced them; the manifest is the only catalogue.

describe('generateHostedSettings merges settings/project-settings.json (B14 / plan-759)', () => {
  it('carries the project keys through', () => {
    const s = JSON.parse(generateHostedSettings({
      projectSettings: { theme: 'dark', units: { length: 'mm' } },
    }));
    expect(s.theme).toBe('dark');
    expect(s.units).toEqual({ length: 'mm' });
  });

  it('never lets a project file re-enable analytics, move the project or claim encryption', () => {
    const s = JSON.parse(generateHostedSettings({
      projectSettings: {
        analytics: { googleAnalyticsId: 'UA-EVIL' },
        projectUrl: 'https://elsewhere.example/',
        projectAssetsPath: 'https://elsewhere.example/',
        encryption: { enabled: true },
        generated: '1999-01-01T00:00:00Z',
      },
    }));
    expect(s.analytics).toEqual({ googleAnalyticsId: '' });
    expect(s.projectUrl).toBe('p/');
    expect(s.projectAssetsPath).toBe('p/');
    expect(s.encryption).toBeUndefined();
    expect(s.generated).not.toBe('1999-01-01T00:00:00Z');
  });

  it('carries no defaultModel — the root of a hosted deploy is the dashboard (D14)', () => {
    const s = JSON.parse(generateHostedSettings({ projectSettings: { defaultModel: 'models/B.glb' } }));
    expect(s.defaultModel).toBeUndefined();
  });

  it('has a fixed key set when there is no project file', () => {
    const withNone = JSON.parse(generateHostedSettings());
    const withNull = JSON.parse(generateHostedSettings({ projectSettings: null }));
    expect(withNull).toEqual(withNone);
    expect(Object.keys(withNone)).toEqual(['projectUrl', 'projectAssetsPath', 'analytics', 'generated']);
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
      const staged = await stageHostedProject({ distDir: makeDist(join(dir, 'dist')), projectDir });
      const s = JSON.parse(readFileSync(join(staged, 'settings.json'), 'utf8'));
      expect(s.theme).toBe('dark');
      expect(s.projectUrl).toBe('p/');
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
