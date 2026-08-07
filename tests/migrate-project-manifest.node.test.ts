// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * migrate-project-manifest — the offline manifest migrator (plan-700 Phase 1).
 *
 * Fixtures are synthetic on purpose (plan-370 requirement R5): the six real
 * projects live in the private sibling repo, so a test that reached for them
 * would silently pass by matching nothing in a public-only checkout.
 *
 * The properties worth pinning are all about NOT losing things: legacy deploy
 * fields, unknown future sections, and the customer's own folders.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  migrateManifest,
  migrateProjectDir,
  migrateProjectsRoot,
  discoverScenes,
  canonicalNameOf,
} from '../scripts/migrate-project-manifest.mjs';
import { vendorGlobProblems, CUSTOMER_OWNED_FOLDERS } from '../scripts/_rv-guards.mjs';

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'rv-migrate-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Writes a project folder with the given manifest and returns its path. */
function project(name: string, manifest: unknown, files: Record<string, string> = {}): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(dir, rel);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, contents);
  }
  return dir;
}

/** The shape of every project.json in the wild before plan-370. */
const LEGACY = {
  name: 'Mauser 3D HMI',
  code: 'a9d6c728c2a7006e52e55c03a174efbf',
  created: '2026-04-03',
  lastPublished: '2026-07-21T10:22:17Z',
  settings: { defaultModel: 'MauserCageline30.glb' },
};

describe('migrateManifest', () => {
  it('adds the rv-project/1.0 core fields to a legacy manifest', () => {
    const { manifest, changes } = migrateManifest(LEGACY, {
      folderName: 'mauser3dhmi', now: '2026-08-06T00:00:00.000Z', mintId: () => 'prj_fixed',
    });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe('prj_fixed');
    expect(manifest.canonicalName).toBe('mauser3dhmi');
    expect(manifest.createdAt).toBe('2026-04-03');
    expect(manifest.modifiedAt).toBe('2026-04-03');
    expect(changes.length).toBeGreaterThan(0);
  });

  it('keeps every legacy deploy field (_bunny-lib still reads them)', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'mauser3dhmi' });
    expect(manifest.code).toBe(LEGACY.code);
    expect(manifest.created).toBe(LEGACY.created);
    expect(manifest.lastPublished).toBe(LEGACY.lastPublished);
    expect(manifest.settings).toEqual(LEGACY.settings);
    expect(manifest.name).toBe('Mauser 3D HMI');
  });

  it('carries unknown and future sections through untouched', () => {
    const { manifest } = migrateManifest(
      { ...LEGACY, somethingFromTheFuture: { deep: [1, 2, { x: true }] } },
      { folderName: 'p' },
    );
    expect(manifest.somethingFromTheFuture).toEqual({ deep: [1, 2, { x: true }] });
  });

  it('does NOT invent models[] or library[] — the folder is the source of truth (P0-3)', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'p' });
    expect(manifest.models).toBeUndefined();
    expect(manifest.library).toBeUndefined();
  });

  it('adds a conservative vendor block that cannot reach customer folders', () => {
    const { manifest } = migrateManifest(LEGACY, { folderName: 'p' });
    const vendor = manifest.vendor as { managed: string[]; handover: string[] };
    expect(vendorGlobProblems(vendor)).toEqual([]);
    for (const folder of CUSTOMER_OWNED_FOLDERS) {
      expect(vendor.managed.some(g => g.startsWith(folder + '/'))).toBe(false);
    }
  });

  it('never rewrites a field that is already there', () => {
    const already = {
      ...LEGACY, schemaVersion: 1, id: 'prj_mine', canonicalName: 'custom-slug',
      createdAt: 'A', modifiedAt: 'B', vendor: { managed: ['models/**'] },
    };
    const { manifest, changes } = migrateManifest(already, { folderName: 'other' });
    expect(changes).toEqual([]);
    expect(manifest).toEqual(already);
  });

  it('rejects a manifest that is not a JSON object', () => {
    expect(() => migrateManifest([] as unknown as Record<string, unknown>)).toThrow();
    expect(() => migrateManifest(null as unknown as Record<string, unknown>)).toThrow();
  });
});

describe('scene indexing', () => {
  it('indexes the scene files using the id inside the file', () => {
    const dir = project('p', LEGACY, {
      'scenes/cell-scn_a.scene.json': JSON.stringify({ id: 'scn_a', name: 'Cell' }),
      'scenes/line-scn_b.scene.json': JSON.stringify({ id: 'scn_b', name: 'Line' }),
      'scenes/notes.txt': 'not a scene',
    });
    expect(discoverScenes(dir)).toEqual([
      { id: 'scn_a', name: 'Cell', path: 'scenes/cell-scn_a.scene.json' },
      { id: 'scn_b', name: 'Line', path: 'scenes/line-scn_b.scene.json' },
    ]);
  });

  it('indexes an unparseable scene file rather than pretending it is not there', () => {
    const dir = project('p', LEGACY, { 'scenes/broken-scn_x.scene.json': '{ truncated' });
    expect(discoverScenes(dir)).toEqual([
      { id: 'broken-scn_x', name: 'broken-scn_x', path: 'scenes/broken-scn_x.scene.json' },
    ]);
  });

  it('adds missing scene files to an existing index without touching the entries there', () => {
    const existing = { id: 'scn_a', name: 'Renamed By User', path: 'scenes/a.scene.json', tags: ['keep'] };
    const { manifest } = migrateManifest({ ...LEGACY, scenes: [existing] }, {
      folderName: 'p',
      scenes: [
        { id: 'scn_a', name: 'Cell', path: 'scenes/a.scene.json' },
        { id: 'scn_b', name: 'Line', path: 'scenes/b.scene.json' },
      ],
    });
    const scenes = manifest.scenes as Array<Record<string, unknown>>;
    expect(scenes[0]).toEqual(existing);
    expect(scenes).toHaveLength(2);
    expect(scenes[1].path).toBe('scenes/b.scene.json');
  });
});

describe('migrateProjectDir', () => {
  it('writes nothing without --apply (dry run is the default)', () => {
    const dir = project('p', LEGACY);
    const before = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir).status).toBe('migrated');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(before);
  });

  it('is idempotent: a second apply produces a byte-identical file', () => {
    const dir = project('p', LEGACY);
    migrateProjectDir(dir, { apply: true });
    const first = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('unchanged');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(first);
  });

  it('migrates a half-migrated manifest (schemaVersion AND legacy fields) idempotently', () => {
    const dir = project('p', {
      ...LEGACY, schemaVersion: 1, id: 'prj_x', canonicalName: 'p', createdAt: 'A', modifiedAt: 'B',
    });
    const first = migrateProjectDir(dir, { apply: true });
    expect(first.changes).toEqual(['vendor: conservative default added (sharpen per project)']);
    const contents = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('unchanged');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(contents);
  });

  it('skips a folder without a manifest instead of failing', () => {
    const dir = join(root, 'scratch');
    mkdirSync(dir, { recursive: true });
    expect(migrateProjectDir(dir).status).toBe('skipped');
  });

  it('skips a manifest that is not valid JSON, and leaves it alone', () => {
    const dir = join(root, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.json'), '{ truncated');
    expect(migrateProjectDir(dir, { apply: true }).status).toBe('skipped');
    expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe('{ truncated');
  });
});

describe('migrateProjectsRoot', () => {
  it('reports one result per folder and does not stop at a bad one', () => {
    project('alpha', LEGACY);
    project('beta', { ...LEGACY, name: 'Beta' });
    mkdirSync(join(root, 'scratch'), { recursive: true });
    const results = migrateProjectsRoot(root, { apply: true });
    expect(results.map(r => r.project)).toEqual(['alpha', 'beta', 'scratch']);
    expect(results.filter(r => r.status === 'migrated')).toHaveLength(2);
    expect(results.find(r => r.project === 'scratch')?.status).toBe('skipped');
    expect(existsSync(join(root, 'alpha', 'project.json'))).toBe(true);
  });
});

describe('canonicalNameOf', () => {
  it('agrees with the browser slug rules', () => {
    expect(canonicalNameOf('Toray OEE Showcase')).toBe('toray-oee-showcase');
    expect(canonicalNameOf('mauser3dhmi')).toBe('mauser3dhmi');
    expect(canonicalNameOf('  ---  ')).toBe('project');
  });
});
